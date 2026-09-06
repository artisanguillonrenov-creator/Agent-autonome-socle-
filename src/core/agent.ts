import type { LLMProvider } from "../llm/provider.js";
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
 * Brique 1 : la boucle agent centrale. Un cycle perception → mémoire →
 * décision → action qui se répète jusqu'à une réponse finale (ou jusqu'à
 * épuisement des itérations autorisées, garde-fou contre les boucles infinies).
 * Toutes les autres briques viennent se greffer ici sans que la boucle
 * elle-même ne connaisse leur détail d'implémentation.
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

      const raw = await this.llm.complete(messages);

      // 1. Essayer de parser une décision structurée
      const decision = parseCoreDecision(raw);

      if (decision) {
        if (decision.action === "RESPOND") {
          finalResponse = decision.response;
          await this.memory.recordTurn({ role: "assistant", content: finalResponse });
          break;
        }

        if (decision.action === "CALL_SKILL") {
          lastActionOrStep = `Appel compétence: ${decision.skill}`;
          const result = await this.skills.execute(decision.skill, decision.input, {
            rememberFact: (entity, attribute, value) => this.memory.facts.set(entity, attribute, value),
          });
          await this.memory.recordTurn({ role: "tool", name: decision.skill, content: result });
          continue;
        }

        if (decision.action === "DISPATCH_CAPABILITY") {
          lastActionOrStep = `Délégation de capacité externe: ${decision.capability} (${decision.objective})`;
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

      // 2. Fallback de rétrocompatibilité : parseSkillCall (ex: <<SKILL ...>>)
      const skillCall = parseSkillCall(raw);
      if (skillCall) {
        lastActionOrStep = `Appel compétence balisée: ${skillCall.name}`;
        const result = await this.skills.execute(skillCall.name, skillCall.input, {
          rememberFact: (entity, attribute, value) => this.memory.facts.set(entity, attribute, value),
        });
        await this.memory.recordTurn({ role: "tool", name: skillCall.name, content: result });
        continue;
      }

      // 3. Sinon réponse texte normale
      finalResponse = raw;
      await this.memory.recordTurn({ role: "assistant", content: raw });
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

  private buildInstructions(relevantSkills: SkillDefinition[]): string {
    const skillsText = relevantSkills.length
      ? relevantSkills.map((s) => `- ${s.name}: ${s.description} (args: ${s.argsHint})`).join("\n")
      : "(aucune compétence jugée pertinente pour cette requête)";

    return [
      "Tu es Jarvis Command Center V1. Tu peux décider entre 3 types d'actions :",
      "",
      '1. RESPOND : Répondre directement à l\'utilisateur en JSON :',
      '{"action": "RESPOND", "response": "ton texte de réponse"}',
      "",
      '2. CALL_SKILL : Exécuter une compétence interne :',
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
