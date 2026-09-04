import type { LLMProvider } from "../llm/provider.js";
import type { EmbeddingProvider } from "../llm/embeddings.js";
import { MemoryManager } from "../memory/memoryManager.js";
import { SkillRegistry } from "../skills/registry.js";
import { Planner } from "../planning/planner.js";
import { ReflectionEngine } from "../reflection/reflectionEngine.js";
import { ContextBudgetManager } from "../context/contextBudgetManager.js";
import { saveCheckpoint, loadCheckpoint, listCheckpoints } from "../persistence/checkpoint.js";
import { parseSkillCall } from "./skillCall.js";
import { config } from "../config.js";
import type { AgentStepResult, ChatMessage, SkillDefinition } from "../types.js";

export interface AgentOptions {
  llm: LLMProvider;
  embeddings: EmbeddingProvider;
  maxIterations?: number;
  reflectionEveryNSteps?: number;
  contextTokenBudget?: number;
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
  private readonly llm: LLMProvider;
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
  }

  async step(userInput: string): Promise<AgentStepResult> {
    await this.memory.recordTurn({ role: "user", content: userInput });

    let iterations = 0;
    let finalResponse = "";

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
      const skillCall = parseSkillCall(raw);

      if (skillCall) {
        const result = await this.skills.execute(skillCall.name, skillCall.input, {
          rememberFact: (entity, attribute, value) => this.memory.facts.set(entity, attribute, value),
        });
        await this.memory.recordTurn({ role: "tool", name: skillCall.name, content: result });
        continue;
      }

      finalResponse = raw;
      await this.memory.recordTurn({ role: "assistant", content: raw });
      break;
    }

    this.stepCount += 1;
    await this.reflection.maybeReflect();

    return {
      response: finalResponse || "(aucune réponse — nombre maximal d'itérations atteint)",
      iterations,
    };
  }

  private buildInstructions(relevantSkills: SkillDefinition[]): string {
    const skillsText = relevantSkills.length
      ? relevantSkills.map((s) => `- ${s.name}: ${s.description} (args: ${s.argsHint})`).join("\n")
      : "(aucune compétence jugée pertinente pour cette requête)";

    return [
      "Tu es un agent autonome. Réponds normalement en langage naturel à l'utilisateur.",
      "Si l'exécution d'une compétence est nécessaire, réponds EXACTEMENT avec ce format et rien d'autre :",
      '<<SKILL name="nom_de_la_competence">{"argument": "valeur"}</SKILL>>',
      "Le résultat te sera fourni au tour suivant pour que tu formules la réponse finale.",
      "",
      "Compétences disponibles pour cette requête :",
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
}
