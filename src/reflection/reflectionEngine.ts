import type { LLMProvider } from "../llm/provider.js";
import type { MemoryManager } from "../memory/memoryManager.js";
import { withGenerationDefaults } from "../llm/generationDefaults.js";
import { providerForRole } from "../llm/modelRouter.js";
import { config } from "../config.js";
import { tracer } from "../observability/tracer.js";

const LEGACY_CONVERSATION_ID = "__legacy__";
/** Sépare le résumé en prose (retourné/stocké tel quel) du bloc JSON de triplets, dans la même réponse LLM. */
const GRAPH_TRIPLES_MARKER = "###TRIPLES###";

/** Brique 3 : réflexion périodique, désormais isolée par conversation chaude. */
export class ReflectionEngine {
  private readonly stepsSinceLastReflectionByConversation = new Map<string, number>();
  private legacyGlobalSteps = 0;
  private readonly legacyWorkspaceSteps = new Map<string, number>();
  private customEveryNSteps?: number;

  constructor(
    private llm: LLMProvider,
    private readonly memory: MemoryManager,
    everyNSteps?: number,
  ) {
    this.customEveryNSteps = everyNSteps;
  }

  setLLMProvider(llm: LLMProvider): void {
    this.llm = llm;
  }

  get everyNSteps(): number {
    return this.customEveryNSteps ?? config.reflection.everyNSteps;
  }

  private isIsolated(workspaceId: string | undefined): boolean {
    return config.projects.projectIsolation && Boolean(workspaceId);
  }

  /** Nouveau chemin 11A : le compteur et le transcript sont strictement conversation-scoped. */
  async maybeReflectForConversation(conversationId: string, workspaceId?: string): Promise<string | null> {
    const count = (this.stepsSinceLastReflectionByConversation.get(conversationId) ?? 0) + 1;
    if (count < this.everyNSteps) {
      this.stepsSinceLastReflectionByConversation.set(conversationId, count);
      return null;
    }
    this.stepsSinceLastReflectionByConversation.set(conversationId, 0);
    return this.reflectForConversation(conversationId, workspaceId);
  }

  async reflectForConversation(conversationId: string, workspaceId?: string): Promise<string> {
    const working = this.memory.getWorkingSession(conversationId);
    const recent = working?.recent(this.everyNSteps * 2) ?? [];
    return this.createInsight(recent, workspaceId);
  }

  /** Compatibilité legacy pour les tests/appels hors ConversationExecutionService. */
  async maybeReflect(workspaceId?: string): Promise<string | null> {
    if (this.isIsolated(workspaceId)) {
      const count = (this.legacyWorkspaceSteps.get(workspaceId!) ?? 0) + 1;
      if (count < this.everyNSteps) {
        this.legacyWorkspaceSteps.set(workspaceId!, count);
        return null;
      }
      this.legacyWorkspaceSteps.set(workspaceId!, 0);
      return this.reflect(workspaceId);
    }
    this.legacyGlobalSteps += 1;
    if (this.legacyGlobalSteps < this.everyNSteps) return null;
    this.legacyGlobalSteps = 0;
    return this.reflect(workspaceId);
  }

  async reflect(workspaceId?: string): Promise<string> {
    const isolate = this.isIsolated(workspaceId);
    const recent = this.memory.working.recentFor(workspaceId, isolate, this.everyNSteps * 2);
    return this.createInsight(recent, workspaceId);
  }

  private async createInsight(recent: Array<{ role: string; content: string | null }>, workspaceId?: string): Promise<string> {
    if (recent.length === 0) return "";
    const transcript = recent.map((message) => `${message.role}: ${message.content}`).join("\n");
    // Boucle d'auto-réflexion/critique : routée vers le modèle de Raisonnement Lourd
    // (intelligence.reasoningModel), pas le modèle rapide — dégrade proprement vers le
    // modèle principal si aucun modèle de raisonnement n'est configuré.
    const rawInsight = await tracer.withSpan("reflection.insight", { kind: "planning", inputs: { transcriptLength: transcript.length } }, async (span) => {
      const res = await providerForRole("reasoning", this.llm).complete(
        [
          {
            role: "system",
            content:
              "Tu es le module de réflexion d'un agent autonome. Relis cet extrait d'échanges récents " +
              "et résume en 1 à 3 phrases les enseignements de haut niveau à retenir durablement " +
              "(préférences révélées, décisions prises, erreurs à ne pas répéter). " +
              "Sois concis, factuel, à la troisième personne. " +
              `Ensuite, sur une ligne séparée, écris exactement ${GRAPH_TRIPLES_MARKER} suivi d'un tableau JSON strict ` +
              'de triplets factuels (Sujet, Prédicat, Objet) extraits de cet échange : [{"subject":"...","predicate":"...","object":"..."}] ' +
              "(maximum 8, [] si aucun fait exploitable, uniquement des faits explicites et fiables). " +
              "N'écris rien après ce tableau JSON.",
          },
          { role: "user", content: transcript },
        ],
        withGenerationDefaults({}),
      );
      span.setOutputs(typeof res === "string" ? res : res.content);
      return res;
    });
    const rawContent = typeof rawInsight === "string" ? rawInsight : rawInsight.content ?? "";
    const markerIndex = rawContent.indexOf(GRAPH_TRIPLES_MARKER);
    const insight = markerIndex === -1 ? rawContent : rawContent.slice(0, markerIndex).trim();
    if (markerIndex !== -1) {
      this.extractGraphTriples(rawContent.slice(markerIndex + GRAPH_TRIPLES_MARKER.length), workspaceId);
    }
    if (insight.trim().length > 0) {
      await this.memory.vector.add(insight.trim(), "reflection", { workspaceId });
    }
    return insight;
  }

  /**
   * Brique mémoire relationnelle (5ème couche) : parse le bloc JSON de triplets
   * (Sujet, Prédicat, Objet) que le LLM de réflexion joint à son insight (même appel,
   * voir GRAPH_TRIPLES_MARKER ci-dessus) et les persiste dans GraphMemory (voir
   * src/memory/graphMemory.ts). Best-effort strict, purement synchrone (aucun appel
   * LLM supplémentaire) : tout JSON malformé est ignoré silencieusement, jamais propagé.
   */
  private extractGraphTriples(rawBlock: string, workspaceId?: string): void {
    try {
      const jsonMatch = rawBlock.trim().match(/\[[\s\S]*\]/);
      if (!jsonMatch) return;
      const parsed: unknown = JSON.parse(jsonMatch[0]);
      if (!Array.isArray(parsed)) return;

      for (const item of parsed.slice(0, 8)) {
        if (!item || typeof item !== "object") continue;
        const entry = item as Record<string, unknown>;
        const subject = typeof entry.subject === "string" ? entry.subject.trim() : "";
        const predicate = typeof entry.predicate === "string" ? entry.predicate.trim() : "";
        const object = typeof entry.object === "string" ? entry.object.trim() : "";
        if (!subject || !predicate || !object) continue;
        this.memory.graph.addTriple(subject, predicate, object, { source: "reflection", workspaceId });
      }
    } catch (error) {
      console.warn("[Reflection] Extraction du graphe de connaissances échouée (best-effort):", (error as Error).message);
    }
  }
}
