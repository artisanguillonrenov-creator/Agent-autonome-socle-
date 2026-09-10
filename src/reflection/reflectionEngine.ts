import type { LLMProvider } from "../llm/provider.js";
import type { MemoryManager } from "../memory/memoryManager.js";
import { withGenerationDefaults } from "../llm/generationDefaults.js";
import { providerForRole } from "../llm/modelRouter.js";

/**
 * Brique 3 : à intervalles réguliers, relit les événements récents et en extrait
 * des enseignements de plus haut niveau — stockés comme mémoire à part entière
 * (kind: "reflection") plutôt que de tout rejouer en brut à chaque cycle.
 */
import { config } from "../config.js";

export class ReflectionEngine {
  /** Compteur global — utilisé quand projects.projectIsolation est désactivé, ou qu'aucun workspaceId n'est fourni (comportement historique inchangé). */
  private stepsSinceLastReflection = 0;
  /** Compteurs par workspace — utilisés quand l'isolation est active, pour que les tours d'un projet ne fassent jamais avancer artificiellement le seuil d'un autre. */
  private stepsSinceLastReflectionByWorkspace = new Map<string, number>();
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

  private isIsolated(workspaceId: string | undefined): boolean {
    return config.projects.projectIsolation && Boolean(workspaceId);
  }

  /**
   * À appeler après chaque tour de la boucle agent. Réfléchit si l'intervalle est
   * atteint. `workspaceId` : projet actif pour ce tour (projects.projectIsolation) —
   * quand l'isolation est active, chaque workspace a son propre compteur de seuil,
   * pour que les tours d'un projet ne déclenchent jamais la réflexion d'un autre.
   */
  async maybeReflect(workspaceId?: string): Promise<string | null> {
    if (this.isIsolated(workspaceId)) {
      const count = (this.stepsSinceLastReflectionByWorkspace.get(workspaceId!) ?? 0) + 1;
      if (count < this.everyNSteps) {
        this.stepsSinceLastReflectionByWorkspace.set(workspaceId!, count);
        return null;
      }
      this.stepsSinceLastReflectionByWorkspace.set(workspaceId!, 0);
      return this.reflect(workspaceId);
    }

    this.stepsSinceLastReflection += 1;
    if (this.stepsSinceLastReflection < this.everyNSteps) {
      return null;
    }
    this.stepsSinceLastReflection = 0;
    return this.reflect(workspaceId);
  }

  async reflect(workspaceId?: string): Promise<string> {
    const isolate = this.isIsolated(workspaceId);
    // Réutilise le filtrage déjà présent dans WorkingMemory (allFor/recentFor) plutôt
    // que de reconstruire une seconde logique : aucun tour d'un autre workspace n'entre
    // dans le transcript analysé quand l'isolation est active.
    const recent = this.memory.working.recentFor(workspaceId, isolate, this.everyNSteps * 2);
    if (recent.length === 0) {
      return "";
    }

    const transcript = recent.map((m) => `${m.role}: ${m.content}`).join("\n");
    // intelligence.utilityModel : modèle rapide dédié au résumé, si configuré.
    const rawInsight = await providerForRole("utility", this.llm).complete(
      [
        {
          role: "system",
          content:
            "Tu es le module de réflexion d'un agent autonome. Relis cet extrait d'échanges récents " +
            "et résume en 1 à 3 phrases les enseignements de haut niveau à retenir durablement " +
            "(préférences révélées, décisions prises, erreurs à ne pas répéter). " +
            "Sois concis, factuel, à la troisième personne.",
        },
        { role: "user", content: transcript },
      ],
      withGenerationDefaults({}),
    );

    const insight = typeof rawInsight === "string" ? rawInsight : rawInsight.content ?? "";

    if (insight.trim().length > 0) {
      // La réflexion porte le même scope que le workspace qui l'a produite — cohérent
      // avec MemoryManager.recordTurn(), qui tague déjà systématiquement les tours
      // episodic de leur workspaceId. Sans isolation active, ceci reste sans effet
      // observable : VectorMemory.search() ne filtre par workspace que lorsque
      // projects.projectIsolation est activé.
      await this.memory.vector.add(insight.trim(), "reflection", { workspaceId });
    }
    return insight;
  }
}
