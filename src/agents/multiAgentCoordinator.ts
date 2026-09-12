import type { LLMProvider, ToolDefinition } from "../llm/provider.js";
import type { ChatMessage, SkillContext, SkillDefinition } from "../types.js";
import type { SkillRegistry } from "../skills/registry.js";
import { withGenerationDefaults } from "../llm/generationDefaults.js";
import { providerForRole } from "../llm/modelRouter.js";
import { completeWithLocalPriority } from "../llm/localModelPriority.js";
import { ActivityStore } from "../observability/activityStore.js";
import { AgentProfileRegistry } from "./agentProfileRegistry.js";
import { AgentTeamStore } from "./agentTeamStore.js";
import type { AgentProfileDefinition, AgentTeamMessage, AgentTeamRun } from "./types.js";

const MAX_STEPS_PER_AGENT_TURN = 4;

export interface MultiAgentRunOptions {
  /** Sous-ensemble ordonné de profils à activer ; défaut = tous les profils actifs, dans leur ordre déclaré. */
  profileIds?: string[];
  workspaceId?: string;
  conversationId?: string;
  /** Contexte d'exécution des compétences (rememberFact, orchestrateur de services, planificateur...). */
  skillContext?: SkillContext;
}

export interface MultiAgentRunResult {
  teamRunId: string;
  finalResponse: string;
  transcript: AgentTeamMessage[];
}

/**
 * Brique multi-agents : fait collaborer une équipe de profils spécialisés
 * (Chercheur, Rédacteur, Réviseur, ou tout profil déclaré/configuré) sur un
 * même objectif. Chaque profil dispose de son propre LLMProvider (résolu via
 * `providerForRole`), de son propre prompt système et d'un pool de compétences
 * restreint à `allowedSkills` — l'agent ne voit et n'appelle jamais une
 * compétence hors de son périmètre. Le contexte est transmis d'un agent au
 * suivant via un transcript partagé, durablement journalisé après chaque tour
 * (voir AgentTeamStore) afin qu'une session interrompue puisse reprendre
 * exactement là où elle s'était arrêtée plutôt que de repartir de zéro.
 */
export class MultiAgentCoordinator {
  private readonly activity = new ActivityStore();

  constructor(
    private baseLLM: LLMProvider,
    private readonly skills: SkillRegistry,
    readonly profiles: AgentProfileRegistry = new AgentProfileRegistry(),
    private readonly store: AgentTeamStore = new AgentTeamStore(),
  ) {}

  /** Propage le nouveau fournisseur LLM principal aux profils sans llmRole dédié. */
  setLLMProvider(llm: LLMProvider): void {
    this.baseLLM = llm;
  }

  private resolveProfiles(profileIds?: string[]): AgentProfileDefinition[] {
    if (!profileIds || profileIds.length === 0) return this.profiles.enabled();
    const resolved = profileIds.map((id) => this.profiles.get(id)).filter((p): p is AgentProfileDefinition => Boolean(p && p.enabled));
    if (resolved.length === 0) throw new Error("NO_VALID_AGENT_PROFILE");
    return resolved;
  }

  private scopedSkills(profile: AgentProfileDefinition): SkillDefinition[] {
    const allowed = new Set(profile.allowedSkills ?? []);
    if (allowed.size === 0) return [];
    return this.skills.list().filter((skill) => allowed.has(skill.name) && skill.availability === "AVAILABLE" && !!skill.handler);
  }

  private providerFor(profile: AgentProfileDefinition): LLMProvider {
    return profile.llmRole ? providerForRole(profile.llmRole, this.baseLLM) : this.baseLLM;
  }

  /** Démarre une nouvelle collaboration d'équipe et l'exécute jusqu'à son terme. */
  async run(objective: string, options: MultiAgentRunOptions = {}): Promise<MultiAgentRunResult> {
    const profiles = this.resolveProfiles(options.profileIds);
    const run = this.store.createRun({
      objective,
      profileIds: profiles.map((p) => p.id),
      maxRounds: 1,
      workspaceId: options.workspaceId,
      conversationId: options.conversationId,
    });
    this.activity.append({ dedupeKey: `agent-team-started:${run.id}`, eventType: "AGENT_TEAM_STARTED", message: `Agent team started for objective`, metadata: { teamRunId: run.id, profileIds: run.profileIds } });
    return this.continueRun(run, profiles, [{ role: "user", content: objective }], options.skillContext);
  }

  /** Reprend une session multi-agents interrompue (après crash, coupure réseau ou erreur LLM). */
  async resume(teamRunId: string, skillContext?: SkillContext): Promise<MultiAgentRunResult> {
    const run = this.store.get(teamRunId);
    if (!run) throw new Error("AGENT_TEAM_RUN_NOT_FOUND");
    if (run.status !== "RUNNING") {
      return { teamRunId: run.id, finalResponse: this.lastAssistantContent(this.store.messages(run.id)), transcript: this.store.messages(run.id) };
    }
    const profiles = run.profileIds.map((id) => this.profiles.get(id)).filter((p): p is AgentProfileDefinition => Boolean(p));
    if (profiles.length !== run.profileIds.length) throw new Error("AGENT_TEAM_PROFILE_MISSING");
    const history = this.store.messages(run.id);
    const transcript: ChatMessage[] = history.map((message) => ({ role: message.role, content: message.content }));
    return this.continueRun(run, profiles, transcript, skillContext, run.currentIndex);
  }

  private lastAssistantContent(messages: AgentTeamMessage[]): string {
    return [...messages].reverse().find((m) => m.role === "assistant")?.content ?? "";
  }

  private async continueRun(
    run: AgentTeamRun,
    profiles: AgentProfileDefinition[],
    transcript: ChatMessage[],
    skillContext?: SkillContext,
    startIndex = 0,
  ): Promise<MultiAgentRunResult> {
    try {
      let finalResponse = "";
      for (let index = startIndex; index < profiles.length; index += 1) {
        const profile = profiles[index];
        this.activity.append({ dedupeKey: `agent-activated:${run.id}:${index}`, eventType: "AGENT_ACTIVATED", message: `Agent ${profile.name} activated`, metadata: { teamRunId: run.id, agentId: profile.id, position: index } });
        const output = await this.runOneAgent(profile, run.objective, transcript, skillContext);
        finalResponse = output;
        transcript.push({ role: "assistant", content: `[${profile.name}] ${output}` });
        this.store.appendMessage(run.id, profile.id, "assistant", output);
        this.store.advance(run.id, index + 1, run.roundsCompleted);
        this.activity.append({ dedupeKey: `agent-message:${run.id}:${index}`, eventType: "AGENT_MESSAGE", message: `Agent ${profile.name} produced a contribution`, metadata: { teamRunId: run.id, agentId: profile.id } });
        if (index + 1 < profiles.length) {
          this.activity.append({ dedupeKey: `agent-handoff:${run.id}:${index}`, eventType: "AGENT_HANDOFF", message: `Handoff from ${profile.name} to ${profiles[index + 1].name}`, metadata: { teamRunId: run.id, from: profile.id, to: profiles[index + 1].id } });
        }
      }
      this.store.complete(run.id);
      this.activity.append({ dedupeKey: `agent-team-completed:${run.id}`, eventType: "AGENT_TEAM_COMPLETED", message: "Agent team completed", metadata: { teamRunId: run.id } });
      return { teamRunId: run.id, finalResponse, transcript: this.store.messages(run.id) };
    } catch (error) {
      const message = (error as Error).message;
      this.store.fail(run.id, message);
      this.activity.append({ dedupeKey: `agent-team-failed:${run.id}`, eventType: "AGENT_TEAM_FAILED", level: "error", message: `Agent team failed: ${message}`, metadata: { teamRunId: run.id } });
      throw error;
    }
  }

  /** Boucle ReAct bornée pour un unique agent : voit le transcript partagé, ne peut appeler que ses compétences autorisées. */
  private async runOneAgent(profile: AgentProfileDefinition, objective: string, transcript: ChatMessage[], skillContext?: SkillContext): Promise<string> {
    const provider = this.providerFor(profile);
    const availableSkills = this.scopedSkills(profile);
    const toolDefinitions: ToolDefinition[] = availableSkills.map((skill) => ({
      type: "function",
      function: { name: skill.name, description: skill.description, parameters: skill.parameters || { type: "object", properties: {}, additionalProperties: true } },
    }));
    const messages: ChatMessage[] = [
      { role: "system", content: `${profile.systemPrompt}\n\nObjectif global de l'équipe : ${objective}` },
      ...transcript,
    ];

    for (let step = 0; step < MAX_STEPS_PER_AGENT_TURN; step += 1) {
      const completion = await completeWithLocalPriority(provider, messages, withGenerationDefaults({ tools: toolDefinitions.length > 0 ? toolDefinitions : undefined }));
      const toolCalls = completion.toolCalls;
      if (toolCalls && toolCalls.length > 0 && skillContext) {
        messages.push({ role: "assistant", content: completion.content ?? null, toolCalls });
        for (const call of toolCalls) {
          const skillName = call.function?.name;
          const skill = availableSkills.find((s) => s.name === skillName);
          if (!skill) {
            messages.push({ role: "tool", name: skillName || "unavailable_tool", toolCallId: call.id || "call_unknown", content: "TOOL_NOT_AVAILABLE_FOR_THIS_AGENT" });
            continue;
          }
          let input: Record<string, unknown> = {};
          try {
            const parsed = JSON.parse(call.function?.arguments || "{}");
            if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) input = parsed;
          } catch {
            messages.push({ role: "tool", name: skillName, toolCallId: call.id || "call_unknown", content: "INVALID_TOOL_ARGUMENTS" });
            continue;
          }
          const result = await this.skills.execute(skillName!, input, skillContext);
          this.activity.append({
            eventType: skill.executionTarget === "MCP_TOOL" ? "MCP_TOOL_EXECUTED" : "AGENT_MESSAGE",
            message: `Agent tool ${skillName} executed`,
            metadata: { agentId: profile.id, skill: skillName },
          });
          messages.push({ role: "tool", name: skillName, toolCallId: call.id || "call_unknown", content: result });
        }
        continue;
      }
      return (completion.content ?? "").trim() || "(aucune contribution)";
    }
    return "(limite d'itérations atteinte pour cet agent)";
  }
}
