import type Database from "better-sqlite3";
import type { IPersonalityRepository } from "./domain/personalityRepository.js";
import type { JarvisPersonalityState } from "./domain/types.js";

const SCHEMA = `
CREATE TABLE IF NOT EXISTS jarvis_personality_state (
  conversation_id TEXT PRIMARY KEY,
  monsieur_cooldown_remaining INTEGER NOT NULL DEFAULT 0,
  updated_at INTEGER NOT NULL,
  FOREIGN KEY(conversation_id) REFERENCES conversation_sessions(conversation_id) ON DELETE CASCADE
);
`;

export class SqlitePersonalityRepository implements IPersonalityRepository {
  constructor(private readonly db: Database.Database) {}

  async initialize(): Promise<void> {
    this.db.pragma("foreign_keys = ON");
    this.db.exec(SCHEMA);
  }

  async getState(conversationId: string): Promise<JarvisPersonalityState | null> {
    const row = this.db.prepare(
      "SELECT conversation_id, monsieur_cooldown_remaining, updated_at FROM jarvis_personality_state WHERE conversation_id=?",
    ).get(conversationId) as Record<string, unknown> | undefined;
    if (!row) return null;
    return {
      conversationId: String(row.conversation_id),
      monsieurCooldownRemaining: Number(row.monsieur_cooldown_remaining),
      updatedAt: Number(row.updated_at),
    };
  }

  async saveState(state: JarvisPersonalityState): Promise<void> {
    this.db.prepare(`INSERT INTO jarvis_personality_state
      (conversation_id, monsieur_cooldown_remaining, updated_at)
      VALUES (?, ?, ?)
      ON CONFLICT(conversation_id) DO UPDATE SET
        monsieur_cooldown_remaining=excluded.monsieur_cooldown_remaining,
        updated_at=excluded.updated_at`)
      .run(state.conversationId, state.monsieurCooldownRemaining, state.updatedAt);
  }
}
