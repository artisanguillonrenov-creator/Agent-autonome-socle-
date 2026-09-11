import { randomUUID } from "node:crypto";
import { test } from "node:test";
import assert from "node:assert/strict";
import pg from "pg";
import { PostgresConversationRepository } from "./postgresConversationRepository.js";
import { computeRequestFingerprint } from "./fingerprint.js";

const url = process.env.TEST_DATABASE_URL;

test("11A PostgreSQL réel: migration, transactions, readback et recovery", { skip: !url }, async () => {
  const pool = new pg.Pool({ connectionString: url });
  try {
    await pool.query("DROP TABLE IF EXISTS conversation_messages CASCADE");
    await pool.query("DROP TABLE IF EXISTS conversation_turns CASCADE");
    await pool.query("DROP TABLE IF EXISTS conversation_sessions CASCADE");

    const repo = new PostgresConversationRepository(pool);
    await repo.initialize();
    const conversationId = randomUUID();
    await repo.initializeSession(conversationId, null);

    const turnId = randomUUID();
    const accepted = await repo.acceptTurnIdempotently({
      turnId,
      conversationId,
      clientRequestId: randomUUID(),
      voiceCommandId: null,
      requestKind: "MESSAGE",
      requestFingerprint: computeRequestFingerprint("MESSAGE", { message: "postgres", workspaceId: null }),
    });
    assert.equal(accepted.kind, "NEW");
    await repo.markTurnRunning(turnId);
    const user = await repo.appendMessage(conversationId, turnId, { role: "user", content: "postgres" }, randomUUID());
    const toolCall = await repo.appendMessage(conversationId, turnId, {
      role: "assistant",
      content: null,
      toolCalls: [{ id: "pg-call", type: "function", function: { name: "probe", arguments: "{}" } }],
    }, randomUUID());
    const tool = await repo.appendMessage(conversationId, turnId, { role: "tool", content: "ok", name: "probe", toolCallId: "pg-call" }, randomUUID());
    const final = await repo.appendFinalMessageAndCompleteTurn(
      conversationId,
      turnId,
      { role: "assistant", content: "done" },
      randomUUID(),
      { response: "done", iterations: 2 },
    );
    assert.deepEqual([user.sequence, toolCall.sequence, tool.sequence, final.sequence], [0, 1, 2, 3]);

    const reloadedRepo = new PostgresConversationRepository(pool);
    await reloadedRepo.initialize();
    const messages = await reloadedRepo.getLastActiveMessages(conversationId, 30);
    assert.equal(messages.length, 4);
    assert.equal(messages[1].message.content, null);
    assert.equal(messages[2].message.toolCallId, "pg-call");
    assert.deepEqual(await reloadedRepo.getCompletedTurnResult(turnId), { response: "done", iterations: 2 });

    const interruptedTurn = randomUUID();
    await reloadedRepo.acceptTurnIdempotently({
      turnId: interruptedTurn,
      conversationId,
      clientRequestId: randomUUID(),
      voiceCommandId: null,
      requestKind: "MESSAGE",
      requestFingerprint: "b".repeat(64),
    });
    assert.equal(await reloadedRepo.recoverInterruptedTurns(), 1);
    const interrupted = await pool.query("SELECT status,failure_reason FROM conversation_turns WHERE turn_id=$1", [interruptedTurn]);
    assert.equal(interrupted.rows[0].status, "FAILED");
    assert.equal(interrupted.rows[0].failure_reason, "PROCESS_RESTART");
  } finally {
    await pool.end();
  }
});
