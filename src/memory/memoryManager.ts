import type { EmbeddingProvider } from "../llm/embeddings.js";
import { WorkingMemory } from "./workingMemory.js";
import { VectorMemory } from "./vectorMemory.js";
import { FactStore } from "./factStore.js";
import { UserModel } from "./userModel.js";
import type { ChatMessage, MemoryEntry } from "../types.js";
import { selectRecentMessages } from "./selectRecentMessages.js";
import { config } from "../config.js";

export interface RetrievedContext {
  recentMessages: ChatMessage[];
  relevantMemories: Array<MemoryEntry & { score: number }>;
  facts: string[];
}

/**
 * Façade qui assemble les 4 couches de mémoire (brique 2) derrière une API unique,
 * consommée par la boucle agent et le gestionnaire de budget de contexte.
 */
export class MemoryManager {
  readonly working: WorkingMemory;
  readonly vector: VectorMemory;
  readonly facts: FactStore;
  readonly userModel: UserModel;

  constructor(embeddings: EmbeddingProvider, workingMemorySize = 30) {
    this.working = new WorkingMemory(workingMemorySize);
    this.vector = new VectorMemory(embeddings);
    this.facts = new FactStore();
    this.userModel = new UserModel();
  }

  /** `workspaceId` : projet actif (projects.projectIsolation) — voir WorkingMemory.add/allFor et VectorMemory.add/search. */
  async recordTurn(message: ChatMessage, workspaceId?: string): Promise<void> {
    this.working.add(message, workspaceId);
    if (typeof message.content === "string" && message.content.trim().length > 0) {
      await this.vector.add(`${message.role}: ${message.content}`, "episodic", { workspaceId });
    }
  }

  async retrieve(query: string, topK = 5, workspaceId?: string): Promise<RetrievedContext> {
    const isolate = config.projects.projectIsolation && Boolean(workspaceId);
    const relevantMemories = await this.vector.search(query, topK, { workspaceId });
    // FactStore n'a aujourd'hui aucun mécanisme de scope par workspace fiable (base de
    // faits globale par conception). Plutôt que de simuler une isolation qui laisserait
    // encore fuiter des faits d'un autre projet, on exclut entièrement les facts globaux
    // du contexte quand l'isolation stricte est active pour ce workspace.
    const facts = isolate ? [] : this.facts.all().map((f) => `${f.entity}.${f.attribute} = ${f.value}`);
    return {
      recentMessages: selectRecentMessages(this.working.allFor(workspaceId, isolate), 10),
      relevantMemories,
      facts,
    };
  }
}
