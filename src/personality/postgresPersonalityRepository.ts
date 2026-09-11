import type pg from "pg";
import type { IPersonalityRepository } from "./domain/personalityRepository.js";
import type { JarvisPersonalityState } from "./domain/types.js";

const SCHEMA = `
CREATE TABLE IF NOT EXISTS jarvis_personality_state (
  conversation_id TEXT PRIMARY KEY,
  monsieur_cooldown_remaining INTEGER NOT NULL DEFAULT 0,
  updated_at BIGINT NOT NULL,
  CONSTRAINT fk_personality_conversation FOREIGN KEY(conversation_id)
    REFERENCES conversation_sessions(conversation_id) ON DELETE CASCADE
);
`;

export class PostgresPersonalityRepository implements IPersonalityRepository {
  constructor(private readonly pool: pg.Pool) {}

  async initialize(): Promise<void> {
    const client = await this.pool.connect();
    try {
      await client.query("BEGIN");
      await client.query(SCHEMA);
      await client.query("COMMIT");
    } catch (error) {
      await client.query("ROLLBACK");
      throw error;
    } finally {
      client.release();
    }
  }

  async getState(conversationId: string): Promise<JarvisPersonalityState | null> {
    const result = await this.pool.query(
      "SELECT conversation_id, monsieur_cooldown_remaining, updated_at FROM jarvis_personality_state WHERE conversation_id=$1",
      [conversationId],
    );
    const row = result.rows[0] as Record<string, unknown> | undefined;
    if (!row) return null;
    return {
      conversationId: String(row.conversation_id),
      monsieurCooldownRemaining: Number(row.monsieur_cooldown_remaining),
      updatedAt: Number(row.updated_at),
    };
  }

  async saveState(state: JarvisPersonalityState): Promise<void> {
    await this.pool.query(`INSERT INTO jarvis_personality_state
      (conversation_id, monsieur_cooldown_remaining, updated_at)
      VALUES ($1, $2, $3)
      ON CONFLICT(conversation_id) DO UPDATE SET
        monsieur_cooldown_remaining=EXCLUDED.monsieur_cooldown_remaining,
        updated_at=EXCLUDED.updated_at`, [
      state.conversationId,
      state.monsieurCooldownRemaining,
      state.updatedAt,
    ]);
  }
}
