import type { LLMProvider } from "../llm/provider.js";
import type { MemoryManager } from "../memory/memoryManager.js";

/**
 * Brique 3 : à intervalles réguliers, relit les événements récents et en extrait
 * des enseignements de plus haut niveau — stockés comme mémoire à part entière
 * (kind: "reflection") plutôt que de tout rejouer en brut à chaque cycle.
 */
import { config } from "../config.js";

export class ReflectionEngine {
  private stepsSinceLastReflection = 0;
  private customEveryNSteps?: number;

  constructor(
    private llm: LLMProvider,
    private readonly memory: MemoryManager,
    everyNSteps?: number,
  ) {
    this.customEveryNSteps = everyNSteps;
  }

  /** Permet à Agent.setLLMProvider() de propager le nouveau fournisseur jusqu'ici. */
  setLLMProvider(llm: LLMProvider): void {
    this.llm = llm;
  }

  get everyNSteps(): number {
    return this.customEveryNSteps ?? config.reflection.everyNSteps;
  }

  /** À appeler après chaque tour de la boucle agent. Réfléchit si l'intervalle est atteint. */
  async maybeReflect(): Promise<string | null> {
    this.stepsSinceLastReflection += 1;
    if (this.stepsSinceLastReflection < this.everyNSteps) {
      return null;
    }
    this.stepsSinceLastReflection = 0;
    return this.reflect();
  }

  async reflect(): Promise<string> {
    const recent = this.memory.working.recent(this.everyNSteps * 2);
    if (recent.length === 0) {
      return "";
    }

    const transcript = recent.map((m) => `${m.role}: ${m.content}`).join("\n");
    const rawInsight = await this.llm.complete([
      {
        role: "system",
        content:
          "Tu es le module de réflexion d'un agent autonome. Relis cet extrait d'échanges récents " +
          "et résume en 1 à 3 phrases les enseignements de haut niveau à retenir durablement " +
          "(préférences révélées, décisions prises, erreurs à ne pas répéter). " +
          "Sois concis, factuel, à la troisième personne.",
      },
      { role: "user", content: transcript },
    ]);

    const insight = typeof rawInsight === "string" ? rawInsight : rawInsight.content ?? "";

    if (insight.trim().length > 0) {
      await this.memory.vector.add(insight.trim(), "reflection");
    }
    return insight;
  }
}
