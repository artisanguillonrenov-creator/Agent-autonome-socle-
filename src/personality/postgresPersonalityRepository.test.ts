import { randomUUID } from "node:crypto";
import assert from "node:assert/strict";
import { test } from "node:test";
import pg from "pg";
import { PostgresConversationRepository } from "../persistence/conversations/postgresConversationRepository.js";
import { PostgresPersonalityRepository } from "./postgresPersonalityRepository.js";

const url = process.env.TEST_DATABASE_URL;

test("Personality PostgreSQL réel: migration, isolation et cascade", { skip: !url }, async () => {
  const pool = new pg.Pool({ connectionString: url });
  try {
    const conversations = new PostgresConversationRepository(pool);
    await conversations.initialize();
    await pool.query("DROP TABLE IF EXISTS jarvis_personality_state");

    const personality = new PostgresPersonalityRepository(pool);
    await personality.initialize();

    const a = randomUUID();
    const b = randomUUID();
    await conversations.initializeSession(a, null);
    await conversations.initializeSession(b, null);

    await personality.saveState({ conversationId: a, monsieurCooldownRemaining: 2, updatedAt: 100 });
    await personality.saveState({ conversationId: b, monsieurCooldownRemaining: 0, updatedAt: 101 });
    assert.equal((await personality.getState(a))?.monsieurCooldownRemaining, 2);
    assert.equal((await personality.getState(b))?.monsieurCooldownRemaining, 0);

    await pool.query("DELETE FROM conversation_sessions WHERE conversation_id=$1", [a]);
    assert.equal(await personality.getState(a), null);
    assert.equal((await personality.getState(b))?.monsieurCooldownRemaining, 0);
  } finally {
    await pool.end();
  }
});
