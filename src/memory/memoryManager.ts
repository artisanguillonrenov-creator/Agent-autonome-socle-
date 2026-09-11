import { randomUUID } from "node:crypto";
import type { EmbeddingProvider } from "../llm/embeddings.js";
import { WorkingMemory } from "./workingMemory.js";
import { VectorMemory } from "./vectorMemory.js";
import { FactStore } from "./factStore.js";
import { UserModel } from "./userModel.js";
import type { ChatMessage, MemoryEntry } from "../types.js";
import { selectRecentMessages } from "./selectRecentMessages.js";
import { config } from "../config.js";
import type { IConversationRepository } from "../persistence/conversations/conversationRepository.js";
import type { AgentExecutionContext, StoredConversationMessage } from "../persistence/conversations/types.js";

export interface RetrievedContext {
  recentMessages: ChatMessage[];
  relevantMemories: Array<MemoryEntry & { score: number }>;
  facts: string[];
}

export interface ConversationActivityProbe {
  isQueuedOrActive(conversationId: string): boolean;
}

const LEGACY_CONVERSATION_ID = "__legacy__";

/**
 * Façade mémoire. Le transcript exact vit dans ConversationRepository ; WorkingMemory
 * n'est qu'un cache chaud isolé par conversation.
 */
export class MemoryManager {
  readonly vector: VectorMemory;
  readonly facts: FactStore;
  readonly userModel: UserModel;
  private readonly workingSessions = new Map<string, WorkingMemory>();
  private readonly sessionWorkspace = new Map<string, string | undefined>();
  private readonly lruOrder: string[] = [];
  private activityProbe?: ConversationActivityProbe;

  constructor(
    embeddings: EmbeddingProvider,
    private readonly conversationRepository?: IConversationRepository,
    private readonly workingMemorySize = 30,
    private readonly cacheLimit = 10,
  ) {
    this.vector = new VectorMemory(embeddings);
    this.facts = new FactStore();
    this.userModel = new UserModel();
  }

  /** Compatibilité des anciens diagnostics/tests hors ConversationExecutionService. */
  get working(): WorkingMemory {
    return this.getOrCreateSession(LEGACY_CONVERSATION_ID);
  }

  attachActivityProbe(probe: ConversationActivityProbe): void {
    this.activityProbe = probe;
  }

  private touch(conversationId: string): void {
    const index = this.lruOrder.indexOf(conversationId);
    if (index >= 0) this.lruOrder.splice(index, 1);
    this.lruOrder.push(conversationId);
  }

  getOrCreateSession(conversationId: string, workspaceId?: string): WorkingMemory {
    let memory = this.workingSessions.get(conversationId);
    if (!memory) {
      memory = new WorkingMemory(this.workingMemorySize);
      this.workingSessions.set(conversationId, memory);
    }
    if (workspaceId !== undefined) this.sessionWorkspace.set(conversationId, workspaceId);
    this.touch(conversationId);
    this.evictIfNecessary();
    return memory;
  }

  getWorkingSession(conversationId: string): WorkingMemory | undefined {
    const memory = this.workingSessions.get(conversationId);
    if (memory) this.touch(conversationId);
    return memory;
  }

  async getOrLoadSession(
    conversationId: string,
    repository: IConversationRepository = this.requireConversationRepository(),
    workspaceId?: string,
  ): Promise<WorkingMemory> {
    const existing = this.workingSessions.get(conversationId);
    if (existing) {
      this.touch(conversationId);
      return existing;
    }
    const memory = new WorkingMemory(this.workingMemorySize);
    const stored = await repository.getLastActiveMessages(conversationId, this.workingMemorySize);
    memory.restoreStoredMessages(stored, workspaceId);
    this.workingSessions.set(conversationId, memory);
    this.sessionWorkspace.set(conversationId, workspaceId);
    this.touch(conversationId);
    this.evictIfNecessary();
    return memory;
  }

  dropSession(conversationId: string): void {
    this.workingSessions.delete(conversationId);
    this.sessionWorkspace.delete(conversationId);
    const index = this.lruOrder.indexOf(conversationId);
    if (index >= 0) this.lruOrder.splice(index, 1);
  }

  clearHotSessionsForTest(): void {
    this.workingSessions.clear();
    this.sessionWorkspace.clear();
    this.lruOrder.splice(0, this.lruOrder.length);
  }

  private evictIfNecessary(): void {
    if (this.workingSessions.size <= this.cacheLimit) return;
    for (let i = 0; i < this.lruOrder.length && this.workingSessions.size > this.cacheLimit;) {
      const candidateId = this.lruOrder[i];
      if (candidateId === LEGACY_CONVERSATION_ID) { i += 1; continue; }
      const candidate = this.workingSessions.get(candidateId);
      const busy = Boolean(candidate?.isPinned()) || Boolean(this.activityProbe?.isQueuedOrActive(candidateId));
      if (!candidate || busy) { i += 1; continue; }
      this.workingSessions.delete(candidateId);
      this.sessionWorkspace.delete(candidateId);
      this.lruOrder.splice(i, 1);
    }
  }

  triggerPostTurnCleanup(): void {
    this.evictIfNecessary();
  }

  private requireConversationRepository(): IConversationRepository {
    if (!this.conversationRepository) throw new Error("CONVERSATION_REPOSITORY_NOT_CONFIGURED");
    return this.conversationRepository;
  }

  async addStoredMessage(stored: StoredConversationMessage, workspaceId?: string): Promise<void> {
    const memory = this.getOrCreateSession(stored.conversationId, workspaceId);
    memory.addStoredMessage(stored, workspaceId);
    this.indexBestEffort(stored.message, workspaceId);
  }

  async replaceWithStoredRevision(oldMessageId: string, stored: StoredConversationMessage, workspaceId?: string): Promise<void> {
    const memory = this.getOrCreateSession(stored.conversationId, workspaceId);
    memory.replaceWithStoredRevision(oldMessageId, stored, workspaceId);
    this.indexBestEffort(stored.message, workspaceId);
  }

  async recordIntermediateTurn(message: ChatMessage, context: AgentExecutionContext): Promise<StoredConversationMessage | null> {
    if (!this.conversationRepository) {
      this.getOrCreateSession(context.conversationId, context.workspaceId).add(message, context.workspaceId);
      this.indexBestEffort(message, context.workspaceId);
      return null;
    }
    const stored = await this.conversationRepository.appendMessage(
      context.conversationId,
      context.turnId,
      message,
      randomUUID(),
    );
    await this.addStoredMessage(stored, context.workspaceId);
    return stored;
  }

  /** Compatibilité legacy : ne persiste pas dans ConversationStore faute de conversationId/turnId. */
  async recordTurn(message: ChatMessage, workspaceId?: string): Promise<void> {
    this.working.add(message, workspaceId);
    this.indexBestEffort(message, workspaceId);
  }

  private indexBestEffort(message: ChatMessage, workspaceId?: string): void {
    if (typeof message.content !== "string" || message.content.trim().length === 0) return;
    void this.vector.add(`${message.role}: ${message.content}`, "episodic", { workspaceId }).catch((error) => {
      console.warn("[Memory] Episodic indexing failed; durable transcript remains authoritative:", (error as Error).message);
    });
  }

  async retrieve(query: string, topK = 5, workspaceId?: string, conversationId = LEGACY_CONVERSATION_ID): Promise<RetrievedContext> {
    const isolate = config.projects.projectIsolation && Boolean(workspaceId);
    const relevantMemories = await this.vector.search(query, topK, { workspaceId });
    const facts = isolate ? [] : this.facts.all().map((fact) => `${fact.entity}.${fact.attribute} = ${fact.value}`);
    const working = this.getOrCreateSession(conversationId, workspaceId);
    return {
      recentMessages: selectRecentMessages(working.allFor(workspaceId, isolate), 10),
      relevantMemories,
      facts,
    };
  }
}
