import type { ChatMessage } from "../types.js";

/** Brique 2a : mémoire de travail — contexte immédiat, taille bornée (FIFO). */
export class WorkingMemory {
  private messages: ChatMessage[] = [];

  constructor(private readonly maxMessages = 30) {}

  add(message: ChatMessage): void {
    this.messages.push(message);
    if (this.messages.length > this.maxMessages) {
      this.messages.shift();
    }
  }

  all(): ChatMessage[] {
    return [...this.messages];
  }

  recent(n: number): ChatMessage[] {
    return this.messages.slice(-n);
  }

  clear(): void {
    this.messages = [];
  }

  restore(messages: ChatMessage[]): void {
    this.messages = [...messages].slice(-this.maxMessages);
  }
}
