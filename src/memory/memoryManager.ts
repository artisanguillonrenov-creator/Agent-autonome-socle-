import type { EmbeddingProvider } from "../llm/embeddings.js";
import { WorkingMemory } from "./workingMemory.js";
import { VectorMemory } from "./vectorMemory.js";
import { FactStore } from "./factStore.js";
import { UserModel } from "./userModel.js";
import type { ChatMessage, MemoryEntry } from "../types.js";

export type ToolCallingProtocol = "openai" | "anthropic" | "google" | "none";

export interface MemoryManagerOptions {
  toolCallingProtocol?: ToolCallingProtocol;
}

export interface RetrieveOptions {
  topK?: number;
  toolCallingProtocol?: ToolCallingProtocol;
}

export interface RetrievedContext {
  recentMessages: ChatMessage[];
  relevantMemories: Array<MemoryEntry & { score: number }>;
  facts: string[];
  toolCallingProtocol: ToolCallingProtocol;
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
  readonly toolCallingProtocol: ToolCallingProtocol;

  constructor(
    embeddings: EmbeddingProvider,
    workingMemorySize = 30,
    options: MemoryManagerOptions = {},
  ) {
    this.working = new WorkingMemory(workingMemorySize);
    this.vector = new VectorMemory(embeddings);
    this.facts = new FactStore();
    this.userModel = new UserModel();
    this.toolCallingProtocol = options.toolCallingProtocol ?? "none";
  }

  async recordTurn(message: ChatMessage): Promise<void> {
    this.working.add(message);
    if (typeof message.content === "string" && message.content.trim().length > 0) {
      await this.vector.add(`${message.role}: ${message.content}`, "episodic");
    }
  }

  async retrieve(query: string, topK?: number): Promise<RetrievedContext>;
  async retrieve(query: string, options?: RetrieveOptions): Promise<RetrievedContext>;
  async retrieve(
    query: string,
    topKOrOptions: number | RetrieveOptions = 5,
  ): Promise<RetrievedContext> {
    const options =
      typeof topKOrOptions === "number"
        ? { topK: topKOrOptions }
        : topKOrOptions;

    const relevantMemories = await this.vector.search(query, options.topK ?? 5);
    const facts = this.facts
      .all()
      .map((fact) => `${fact.entity}.${fact.attribute} = ${fact.value}`);

    return {
      recentMessages: this.working.recent(10),
      relevantMemories,
      facts,
      toolCallingProtocol:
        options.toolCallingProtocol ?? this.toolCallingProtocol,
    };
  }
}