import type { EmbeddingProvider } from "../llm/embeddings.js";
import { WorkingMemory } from "./workingMemory.js";
import { VectorMemory } from "./vectorMemory.js";
import { FactStore } from "./factStore.js";
import { UserModel } from "./userModel.js";
import type { ChatMessage, MemoryEntry } from "../types.js";

export interface RetrievedContext {
  recentMessages: ChatMessage[];
  relevantMemories: Array<MemoryEntry & { score: number }>;
  facts: string[];
}

function hasToolCalls(message: ChatMessage): boolean {
  const value = message as ChatMessage & {
    tool_calls?: unknown;
    toolCalls?: unknown;
  };

  return Array.isArray(value.tool_calls) || Array.isArray(value.toolCalls);
}

function selectRecentMessages(messages: ChatMessage[], limit: number): ChatMessage[] {
  if (limit <= 0 || messages.length === 0) {
    return [];
  }

  let start = Math.max(0, messages.length - limit);

  if (messages[start]?.role === "tool") {
    while (start > 0 && messages[start - 1]?.role === "tool") {
      start -= 1;
    }

    if (start > 0 && messages[start - 1]?.role === "assistant" && hasToolCalls(messages[start - 1])) {
      start -= 1;
    }
  }

  return messages.slice(start);
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

  async recordTurn(message: ChatMessage): Promise<void> {
    this.working.add(message);
    if (typeof message.content === "string" && message.content.trim().length > 0) {
      await this.vector.add(`${message.role}: ${message.content}`, "episodic");
    }
  }

  async retrieve(query: string, topK = 5): Promise<RetrievedContext> {
    const relevantMemories = await this.vector.search(query, topK);
    const facts = this.facts.all().map((f) => `${f.entity}.${f.attribute} = ${f.value}`);

    return {
      recentMessages: selectRecentMessages(this.working.all(), 10),
      relevantMemories,
      facts,
    };
  }
}