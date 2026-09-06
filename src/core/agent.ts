import type { LLMProvider, ToolDefinition } from "../llm/provider.js";
import type { EmbeddingProvider } from "../llm/embeddings.js";
import { MemoryManager } from "../memory/memoryManager.js";
import { SkillRegistry } from "../skills/registry.js";
import { Planner } from "../planning/planner.js";
import { ReflectionEngine } from "../reflection/reflectionEngine.js";
import { ContextBudgetManager } from "../context/contextBudgetManager.js";
import { saveCheckpoint, loadCheckpoint, listCheckpoints } from "../persistence/checkpoint.js";
import { parseSkillCall } from "./skillCall.js";
import { ServiceOrchestrator } from "../orchestration/serviceOrchestrator.js";
import { parseCoreDecision } from "../orchestration/contract.js";
import { config } from "../config.js";
import type { AgentStepResult, ChatMessage, SkillDefinition } from "../types.js";

export interface AgentOptions {
  llm: LLMProvider;
  embeddings: EmbeddingProvider;
  maxIterations?: number;
  reflectionEveryNSteps?: number;
  contextTokenBudget?: number;
  orchestrator?: ServiceOrchestrator;
}

/**
 * Brique 1 : la boucle agent centrale.
 */
export class Agent {
  readonly memory: MemoryManager;
  readonly skills: SkillRegistry;
  readonly planner: Planner;
  readonly reflection: ReflectionEngine;
  readonly serviceOrchestrator: ServiceOrchestrator;
  private llm: LLMProvider;
  private readonly contextBudget: ContextBudgetManager;
  private readonly maxIterations: number;
  private stepCount = 0;

  constructor(opts: AgentOptions) {
    this.llm = opts.llm;
    this.memory = new MemoryManager(opts.embeddings);
    this.skills = new SkillRegistry(opts.embeddings);
    this.planner = new Planner();
    this.reflection = new ReflectionEngine(
      opts.llm,
      this.memory,
      opts.reflectionEveryNSteps ?? config.reflection.everyNSteps,
    );
    this.contextBudget = new ContextBudgetManager(opts.contextTokenBudget ?? config.context.tokenBudget);
    this.maxIterations = opts.maxIterations ?? config.agent.maxIterations;
    this.serviceOrchestrator = opts.orchestrator ?? new ServiceOrchestrator();
  }

  async step(userInput: string): Promise<AgentStepResult> {
    await this.memory.recordTurn({ role: "user", content: userInput });

    let iterations = 0;
    let finalResponse = "";

    let lastActionOrStep = "Initialisation du cycle";

    while (iterations < this.maxIterations) {
      iterations++;

      const retrieved = await this.memory.retrieve(userInput);
      const relevantSkills = await this.skills.findRelevant(userInput);

      const reflections = retrieved.relevantMemories.filter((m) => m.kind === "reflection");
      const episodic = retrieved.relevantMemories.filter((m) => m.kind === "episodic");

      const systemPrompt = this.contextBudget.assemble([
        { label: "Instructions", content: this.buildInstructions(relevantSkills), priority: 100 },
        { label: "Faits connus", content: retrieved.facts.join("\n"), priority: 80 },
        { label: "Réflexions passées", content: reflections.map((m) => m.text).join("\n"), priority: 70 },
        { label: "Souvenirs pertinents", content: episodic.map((m) => m.text).join("\n"), priority: 50 },
      ]);

      const messages: ChatMessage[] = [{ role: "system", content: systemPrompt }, ...retrieved.recentMessages];

      const isNativeToolSupported = Boolean(this.llm.supportsNativeTools?.());

      const toolDefinitions: ToolDefinition[] = relevantSkills.map((s) => ({
        type: "function",
        function: {
          name: s.name,
          description: s.description,
          parameters: s.parameters || {
            type: "object",
            properties: {},
            additionalProperties: true,
          },
        },
      }));

      const completionResult = await this.llm.complete(messages, {
        tools: isNativeToolSupported && toolDefinitions.length > 0 ? toolDefinitions : undefined,
      });

      const rawText = typeof completionResult === "string" ? completionResult : completionResult.content ?? "";
      const nativeToolCalls = typeof completionResult === "string" ? undefined : completionResult.toolCalls;

      // --- NATIVE TOOL CALLING PATH (PRIORITY 1) ---
      if (nativeToolCalls && nativeToolCalls.length > 0) {
        console.log(`[Agent] ${nativeToolCalls.length} appel(s) de tool natif(s) intercepté(s) au tour ${iterations}.`);
        await this.memory.recordTurn({
          role: "assistant",
          content: rawText || null,
          toolCalls: nativeToolCalls,
        });

        for (const toolCall of nativeToolCalls) {
          const skillName = toolCall.function?.name;
          let parsedInput: Record<string, unknown> = {};

          try {
            const rawArgs = toolCall.function?.arguments || "{}";
            const parsed = JSON.parse(rawArgs);
            if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
              parsedInput = parsed as Record<string, unknown>;
            }
          } catch (err) {
            const errorResult = `Erreur : Arguments JSON invalides pour l'outil "${skillName}": ${(err as Error).message}`;
            console.error(`[Agent] ${errorResult}`);
            await this.memory.recordTurn({
              role: "tool",
              name: skillName,
              toolCallId: toolCall.id || "call_unknown",
              content: errorResult,
            });
            continue;
          }

          lastActionOrStep = `Appel outil natif: ${skillName}`;
          console.log(`[Agent] Exécution de l'outil natif '${skillName}' (id: ${toolCall.id}) avec input:`, parsedInput);

          const result = await this.skills.execute(skillName, parsedInput, {
            rememberFact: (entity, attribute, value) => this.memory.facts.set(entity, attribute, value),
          });

          await this.memory.recordTurn({
            role: "tool",
            name: skillName,
            toolCallId: toolCall.id || "call_unknown",
            content: result,
          });
        }

        continue;
      }

      // --- HISTORICAL FALLBACK PATH (PRIORITY 2) ---
      const decision = parseCoreDecision(rawText);

      if (decision) {
        if (decision.action === "RESPOND") {
          console.log(`[Agent] Décision RESPOND reçue au tour ${iterations}.`);
          finalResponse = decision.response;
          await this.memory.recordTurn({ role: "assistant", content: finalResponse });
          break;
        }

        if (decision.action === "CALL_SKILL") {
          lastActionOrStep = `Appel compétence: ${decision.skill}`;
          console.log(`[Agent] Décision CALL_SKILL interceptée -> Skill: '${decision.skill}', Input:`, decision.input);

          const result = await this.skills.execute(decision.skill, decision.input, {
            rememberFact: (entity, attribute, value) => this.memory.facts.set(entity, attribute, value),
          });

          console.log(`[Agent] Skill '${decision.skill}' exécuté. Résultat (${result.length} chars). Réinjection dans la mémoire.`);
          await this.memory.recordTurn({ role: "tool", name: decision.skill, content: result });
          continue;
        }

        if (decision.action === "DISPATCH_CAPABILITY") {
          lastActionOrStep = `Délégation de capacité externe: ${decision.capability} (${decision.objective})`;
          console.log(`[Agent] Décision DISPATCH_CAPABILITY -> Capacité: '${decision.capability}'`);

          const orchResult = await this.serviceOrchestrator.dispatchCapability(decision);

          let outcomeMsg = "";
          if (orchResult.status === "COMPLETED") {
            outcomeMsg = `[Service ${orchResult.selectedService}] Résultat de la capacité '${decision.capability}': ${orchResult.result ?? "Tâche terminée avec succès."}`;
          } else if (orchResult.status === "FAILED") {
            outcomeMsg = `[Service ${orchResult.selectedService}] Échec de la capacité '${decision.capability}': ${orchResult.error ?? "Erreur inconnue"}`;
          } else if (orchResult.status === "REJECTED") {
            outcomeMsg = `[Service ${orchResult.selectedService}] Capacité '${decision.capability}' rejetée: ${orchResult.error ?? "Rejeté par le service."}`;
          } else {
            outcomeMsg = `[Service ${orchResult.selectedService}] Capacité '${decision.capability}' status=${orchResult.status}: ${orchResult.result || orchResult.error || "En cours"}`;
          }

          await this.memory.recordTurn({ role: "tool", name: `dispatch_${decision.capability}`, content: outcomeMsg });
          continue;
        }
      }

      // Fallback : parseSkillCall (ex: <<SKILL ...>>)
      const skillCall = parseSkillCall(rawText);
      if (skillCall) {
        lastActionOrStep = `Appel compétence balisée: ${skillCall.name}`;
        console.log(`[Agent] Décision balisée <<SKILL>> interceptée -> Skill: '${skillCall.name}'`);

        const result = await this.skills.execute(skillCall.name, skillCall.input, {
          rememberFact: (entity, attribute, value) => this.memory.facts.set(entity, attribute, value),
        });
        await this.memory.recordTurn({ role: "tool", name: skillCall.name, content: result });
        continue;
      }

      // Sinon réponse texte normale
      finalResponse = this.cleanRawTextResponse(rawText);
      await this.memory.recordTurn({ role: "assistant", content: finalResponse });
      break;
    }

    this.stepCount += 1;
    await this.reflection.maybeReflect();

    if (!finalResponse) {
      finalResponse = `Erreur : Limite maximale d'itérations (${this.maxIterations}) atteinte. Dernière étape exécutée : ${lastActionOrStep}. Veuillez reformuler ou découper votre demande.`;
    }

    return {
      response: finalResponse,
      iterations,
    };
  }

  private cleanRawTextResponse(raw: string): string {
    let clean = raw.trim();
    // Strip raw tool call tags, JSON action blobs, or function call markup if model leaked them
    clean = clean.replace(/<tool_call>[\s\S]*?<\/tool_call>/gi, "").trim();
    clean = clean.replace(/<function_call>[\s\S]*?<\/function_call>/gi, "").trim();
    clean = clean.replace(/<<SKILL[\s\S]*?<\/SKILL>>/gi, "").trim();
    clean = clean.replace(/CALL_SKILL\s*:\s*[a-z_]+[\s\S]*/gi, "").trim();

    if (clean.startsWith("```json") && clean.endsWith("```")) {
      try {
        const parsed = JSON.parse(clean.replace(/^```json\n?/, "").replace(/\n?```$/, "").trim());
        if (parsed?.response) return parsed.response;
      } catch {}
    }

    return clean || "Je suis à votre disposition.";
  }

  private buildInstructions(relevantSkills: SkillDefinition[]): string {
    const now = new Date();
    const dateStr = now.toLocaleDateString("fr-FR", {
      weekday: "long",
      year: "numeric",
      month: "long",
      day: "numeric",
    });
    const isoDate = now.toISOString().split("T")[0];

    const isNativeToolSupported = Boolean(this.llm.supportsNativeTools?.());

    if (isNativeToolSupported) {
      return [
        `Tu es Jarvis Command Center V1. Tu réponds à l'utilisateur de manière naturelle, fluide et précise en français.`,
        `Date et heure actuelles : ${dateStr} (${isoDate}).`,
        "ACCÈS INTERNET : Tu possèdes un accès Internet fonctionnel grâce à la compétence/outil 'web_search'.",
        "RÈGLE IMPÉRATIVE : Lorsque la demande nécessite des informations récentes, actuelles ou externes (ex: météo, actualités, événements, films au cinéma 'ce mois-ci' ou 'cette année'), tu DOIS obligatoirement utiliser l'outil 'web_search'. Ne dis JAMAIS que tu n'as pas accès à Internet.",
        "RÈGLE NATIVE : Utilise les outils natifs mis à ta disposition. Ne rédige AUCUNE structure technique JSON ou balise XML dans le texte utilisateur.",
      ].join("\n");
    }

    const skillsText = relevantSkills.length
      ? relevantSkills.map((s) => `- ${s.name}: ${s.description} (args: ${s.argsHint})`).join("\n")
      : "(aucune compétence jugée pertinente pour cette requête)";

    return [
      `Date et heure actuelles : ${dateStr} (${isoDate}).`,
      "ACCÈS INTERNET : Jarvis possède un accès Internet fonctionnel grâce à la compétence 'web_search'.",
      "RÈGLE IMPÉRATIVE : Lorsque la demande de l'utilisateur nécessite des informations récentes, actuelles ou externes (ex: météo, actualités, films au cinéma 'ce mois-ci' ou 'cette année'), tu DOIS obligatoirement appeler 'web_search'. Ne dis JAMAIS que tu n'as pas accès à Internet.",
      "",
      "Tu es Jarvis Command Center V1. Tu peux décider entre 3 types d'actions :",
      "",
      '1. RESPOND : Répondre directement à l\'utilisateur en JSON :',
      '{"action": "RESPOND", "response": "ton texte de réponse rédigé en français"}',
      "",
      '2. CALL_SKILL : Exécuter une compétence interne (ex: web_search) :',
      '{"action": "CALL_SKILL", "skill": "nom_skill", "input": {...}}',
      "",
      '3. DISPATCH_CAPABILITY : Demander une capacité exécutée par un service externe (ex: développement de logiciel) :',
      '{"action": "DISPATCH_CAPABILITY", "capability": "software_development", "objective": "description de ce qu\'il faut réaliser", "context": {}, "constraints": []}',
      "",
      "RÈGLE : Si l'utilisateur demande la création ou le développement d'une application/logiciel, utilise DISPATCH_CAPABILITY avec la capacité 'software_development'.",
      "",
      "Pour compatibilité, tu peux aussi répondre en texte libre ou utiliser la balise :",
      '<<SKILL name="nom_skill">{"arg": "valeur"}</SKILL>>',
      "",
      "Compétences internes disponibles :",
      skillsText,
    ].join("\n");
  }

  saveCheckpoint(label: string): string {
    return saveCheckpoint(label, {
      workingMemory: this.memory.working.all(),
      planNodes: this.planner.all(),
      stepCount: this.stepCount,
    });
  }

  restoreCheckpoint(checkpointId: string): boolean {
    const state = loadCheckpoint(checkpointId);
    if (!state) return false;
    this.memory.working.restore(state.workingMemory);
    this.planner.restore(state.planNodes);
    this.stepCount = state.stepCount;
    return true;
  }

  listCheckpoints() {
    return listCheckpoints();
  }

  setLLMProvider(llm: LLMProvider): void {
    this.llm = llm;
  }

  getLLMProvider(): LLMProvider {
    return this.llm;
  }
}
