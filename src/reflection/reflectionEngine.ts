import type { LLMProvider } from "../llm/provider.js";
import type { MemoryManager } from "../memory/memoryManager.js";
import { withGenerationDefaults } from "../llm/generationDefaults.js";
import { providerForRole } from "../llm/modelRouter.js";
import { config } from "../config.js";
import { tracer } from "../observability/tracer.js";

const LEGACY_CONVERSATION_ID = "__legacy__";

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
              "Sois concis, factuel, à la troisième personne.",
          },
          { role: "user", content: transcript },
        ],
        withGenerationDefaults({}),
      );
      span.setOutputs(typeof res === "string" ? res : res.content);
      return res;
    });
    const insight = typeof rawInsight === "string" ? rawInsight : rawInsight.content ?? "";
    if (insight.trim().length > 0) {
      await this.memory.vector.add(insight.trim(), "reflection", { workspaceId });
    }
    return insight;
  }
}
