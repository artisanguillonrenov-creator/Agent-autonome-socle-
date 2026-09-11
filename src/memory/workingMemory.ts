import type { ChatMessage } from "../types.js";
import type { StoredConversationMessage } from "../persistence/conversations/types.js";

export interface WorkingMemoryEntry {
  message: ChatMessage;
  /** Workspace/projet auquel ce tour appartient — absent pour un tour global. */
  workspaceId?: string;
  /** Durable conversation identity; absent only for legacy/non-persisted entries. */
  messageId?: string;
  turnId?: string | null;
  sequence?: number;
  status?: "ACTIVE" | "SUPERSEDED";
  revisionOfId?: string | null;
}

/** Mémoire de travail conversationnelle — cache chaud borné, jamais source de vérité. */
export class WorkingMemory {
  private entries: WorkingMemoryEntry[] = [];
  private pinCount = 0;

  constructor(private readonly maxMessages = 30) {}

  pin(): void { this.pinCount += 1; }
  unpin(): void { this.pinCount = Math.max(0, this.pinCount - 1); }
  isPinned(): boolean { return this.pinCount > 0; }

  private trim(): void {
    if (this.entries.length > this.maxMessages) {
      this.entries = this.entries.slice(-this.maxMessages);
    }
  }

  add(message: ChatMessage, workspaceId?: string): void {
    this.entries.push({ message, workspaceId });
    this.trim();
  }

  addStoredMessage(stored: StoredConversationMessage, workspaceId?: string): void {
    this.entries.push({
      message: stored.message,
      workspaceId,
      messageId: stored.messageId,
      turnId: stored.turnId,
      sequence: stored.sequence,
      status: stored.status,
      revisionOfId: stored.revisionOfId,
    });
    this.trim();
  }

  replaceWithStoredRevision(oldMessageId: string, stored: StoredConversationMessage, workspaceId?: string): void {
    this.entries = this.entries.filter((entry) => entry.messageId !== oldMessageId);
    this.addStoredMessage(stored, workspaceId);
  }

  getEntryByMessageId(messageId: string): WorkingMemoryEntry | undefined {
    return this.entries.find((entry) => entry.messageId === messageId);
  }

  all(): ChatMessage[] {
    return this.entries.map((entry) => entry.message);
  }

  allEntries(): WorkingMemoryEntry[] {
    return this.entries.map((entry) => ({ ...entry, message: { ...entry.message } }));
  }

  allFor(workspaceId: string | undefined, isolate: boolean): ChatMessage[] {
    if (!isolate || !workspaceId) return this.all();
    return this.entries.filter((entry) => entry.workspaceId === workspaceId).map((entry) => entry.message);
  }

  recent(n: number): ChatMessage[] {
    return this.entries.slice(-n).map((entry) => entry.message);
  }

  recentFor(workspaceId: string | undefined, isolate: boolean, n: number): ChatMessage[] {
    return this.allFor(workspaceId, isolate).slice(-n);
  }

  clear(): void {
    this.entries = [];
  }

  restore(messages: ChatMessage[], workspaceId?: string): void {
    this.entries = messages.slice(-this.maxMessages).map((message) => ({ message, workspaceId }));
  }

  restoreEntries(entries: WorkingMemoryEntry[]): void {
    this.entries = entries.slice(-this.maxMessages).map((entry) => ({ ...entry, message: { ...entry.message } }));
  }

  restoreStoredMessages(messages: StoredConversationMessage[], workspaceId?: string): void {
    this.entries = messages.slice(-this.maxMessages).map((stored) => ({
      message: stored.message,
      workspaceId,
      messageId: stored.messageId,
      turnId: stored.turnId,
      sequence: stored.sequence,
      status: stored.status,
      revisionOfId: stored.revisionOfId,
    }));
  }
}
