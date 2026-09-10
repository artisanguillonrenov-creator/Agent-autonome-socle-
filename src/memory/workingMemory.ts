import type { ChatMessage } from "../types.js";

export interface WorkingMemoryEntry {
  message: ChatMessage;
  /** Workspace/projet auquel ce tour appartient — absent pour un tour "global" (pas de projet actif). */
  workspaceId?: string;
}

/**
 * Brique 2a : mémoire de travail — contexte immédiat, taille bornée (FIFO).
 * Chaque tour porte son workspaceId d'origine (projects.projectIsolation) : `all()`/
 * `recent()` restent globaux (comportement historique, utilisés par les diagnostics et
 * la réflexion) ; `allFor()` filtre par workspace pour la boucle agent quand l'isolation
 * est active.
 */
export class WorkingMemory {
  private entries: WorkingMemoryEntry[] = [];

  constructor(private readonly maxMessages = 30) {}

  add(message: ChatMessage, workspaceId?: string): void {
    this.entries.push({ message, workspaceId });
    if (this.entries.length > this.maxMessages) {
      this.entries.shift();
    }
  }

  all(): ChatMessage[] {
    return this.entries.map((e) => e.message);
  }

  /** Entrées complètes (message + scope) — utilisé quand le tag de workspace doit survivre à une réécriture (ex. régénération). */
  allEntries(): WorkingMemoryEntry[] {
    return this.entries.map((e) => ({ ...e }));
  }

  /**
   * `isolate` = false, ou `workspaceId` absent : comportement historique inchangé (tout
   * l'historique global, y compris les tours sans workspace). `isolate` = true avec un
   * `workspaceId` fourni : uniquement les tours de CE workspace — aucun tour d'un autre
   * projet, ni aucun tour global non scopé, ne fuite dans le contexte isolé.
   */
  allFor(workspaceId: string | undefined, isolate: boolean): ChatMessage[] {
    if (!isolate || !workspaceId) return this.all();
    return this.entries.filter((e) => e.workspaceId === workspaceId).map((e) => e.message);
  }

  recent(n: number): ChatMessage[] {
    return this.entries.slice(-n).map((e) => e.message);
  }

  clear(): void {
    this.entries = [];
  }

  restore(messages: ChatMessage[]): void {
    this.entries = messages.slice(-this.maxMessages).map((message) => ({ message }));
  }

  /** Restaure les entrées complètes (message + scope) — préserve le workspace d'origine de chaque tour, contrairement à `restore()`. */
  restoreEntries(entries: WorkingMemoryEntry[]): void {
    this.entries = entries.slice(-this.maxMessages).map((e) => ({ ...e }));
  }
}
