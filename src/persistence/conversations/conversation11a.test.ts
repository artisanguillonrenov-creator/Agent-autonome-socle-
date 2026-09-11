import { randomUUID } from "node:crypto";
import { test } from "node:test";
import assert from "node:assert/strict";
import Database from "better-sqlite3";
import { SqliteConversationRepository } from "./sqliteConversationRepository.js";
import { ConversationCoordinator } from "./conversationCoordinator.js";
import { ConversationExecutionService } from "./conversationExecutionService.js";
import { computeRequestFingerprint } from "./fingerprint.js";
import { MemoryManager } from "../../memory/memoryManager.js";
import { LocalHashingEmbeddingProvider } from "../../llm/embeddings.js";
import type { Agent } from "../../core/agent.js";

function repository() {
  const db = new Database(":memory:");
  const repo = new SqliteConversationRepository(db);
  return { db, repo };
}

async function createRunningTurn(repo: SqliteConversationRepository, conversationId: string, key = randomUUID()) {
  const turnId = randomUUID();
  const accepted = await repo.acceptTurnIdempotently({
    turnId,
    conversationId,
    clientRequestId: key,
    voiceCommandId: null,
    requestKind: "MESSAGE",
    requestFingerprint: computeRequestFingerprint("MESSAGE", { message: "hello", workspaceId: null }),
  });
  assert.equal(accepted.kind, "NEW");
  await repo.markTurnRunning(turnId);
  return turnId;
}

test("11A SQLite: sessions globales, ordre strict, tool-call exact et résultat final durable", async () => {
  const { db, repo } = repository();
  await repo.initialize();
  const conversationId = randomUUID();
  await repo.initializeSession(conversationId, null);
  const turnId = await createRunningTurn(repo, conversationId);

  const user = await repo.appendMessage(conversationId, turnId, { role: "user", content: "cherche" }, randomUUID());
  const toolCall = await repo.appendMessage(conversationId, turnId, {
    role: "assistant",
    content: null,
    toolCalls: [{ id: "call-1", type: "function", function: { name: "web_search", arguments: "{\"q\":\"x\"}" } }],
  }, randomUUID());
  const tool = await repo.appendMessage(conversationId, turnId, {
    role: "tool",
    content: "result",
    name: "web_search",
    toolCallId: "call-1",
  }, randomUUID());
  const final = await repo.appendFinalMessageAndCompleteTurn(
    conversationId,
    turnId,
    { role: "assistant", content: "réponse" },
    randomUUID(),
    { response: "réponse", iterations: 2 },
  );

  assert.deepEqual([user.sequence, toolCall.sequence, tool.sequence, final.sequence], [0, 1, 2, 3]);
  const restored = await repo.getLastActiveMessages(conversationId, 30);
  assert.equal(restored.length, 4);
  assert.equal(restored[1].message.content, null);
  assert.deepEqual(restored[1].message.toolCalls, toolCall.message.toolCalls);
  assert.equal(restored[2].message.name, "web_search");
  assert.equal(restored[2].message.toolCallId, "call-1");
  assert.deepEqual(await repo.getCompletedTurnResult(turnId), { response: "réponse", iterations: 2 });
  db.close();
});

test("11A SQLite: idempotence même clé et mismatch payload", async () => {
  const { db, repo } = repository();
  await repo.initialize();
  const conversationId = randomUUID();
  await repo.initializeSession(conversationId, null);
  const key = randomUUID();
  const fingerprint = computeRequestFingerprint("MESSAGE", { message: "A", workspaceId: null });
  const first = await repo.acceptTurnIdempotently({
    turnId: randomUUID(), conversationId, clientRequestId: key, voiceCommandId: null,
    requestKind: "MESSAGE", requestFingerprint: fingerprint,
  });
  const retry = await repo.acceptTurnIdempotently({
    turnId: randomUUID(), conversationId, clientRequestId: key, voiceCommandId: null,
    requestKind: "MESSAGE", requestFingerprint: fingerprint,
  });
  const mismatch = await repo.acceptTurnIdempotently({
    turnId: randomUUID(), conversationId, clientRequestId: key, voiceCommandId: null,
    requestKind: "MESSAGE", requestFingerprint: computeRequestFingerprint("MESSAGE", { message: "B", workspaceId: null }),
  });
  assert.equal(first.kind, "NEW");
  assert.equal(retry.kind, "EXISTING");
  assert.equal(mismatch.kind, "MISMATCH");
  if (first.kind === "NEW" && retry.kind === "EXISTING") assert.equal(retry.turn.turnId, first.turn.turnId);
  db.close();
});

test("11A SQLite: FK composite interdit turn d'une autre conversation", async () => {
  const { db, repo } = repository();
  await repo.initialize();
  const a = randomUUID();
  const b = randomUUID();
  await repo.initializeSession(a, null);
  await repo.initializeSession(b, null);
  const turnA = await createRunningTurn(repo, a);
  await assert.rejects(
    repo.appendMessage(b, turnA, { role: "user", content: "cross" }, randomUUID()),
  );
  assert.equal((await repo.getSession(b))?.lastMessageSequence, -1, "rollback ne doit pas consommer de sequence");
  db.close();
});

test("11A SQLite: échec insert rollback aussi last_message_sequence", async () => {
  const { db, repo } = repository();
  await repo.initialize();
  const conversationId = randomUUID();
  await repo.initializeSession(conversationId, null);
  const turnId = await createRunningTurn(repo, conversationId);
  const duplicateMessageId = randomUUID();
  await repo.appendMessage(conversationId, turnId, { role: "user", content: "first" }, duplicateMessageId);
  assert.equal((await repo.getSession(conversationId))?.lastMessageSequence, 0);
  await assert.rejects(repo.appendMessage(conversationId, turnId, { role: "assistant", content: "duplicate" }, duplicateMessageId));
  assert.equal((await repo.getSession(conversationId))?.lastMessageSequence, 0);
  db.close();
});

test("11A SQLite: regeneration atomique conserve ancienne et active nouvelle", async () => {
  const { db, repo } = repository();
  await repo.initialize();
  const conversationId = randomUUID();
  await repo.initializeSession(conversationId, null);
  const originalTurn = await createRunningTurn(repo, conversationId);
  await repo.appendMessage(conversationId, originalTurn, { role: "user", content: "question" }, randomUUID());
  const original = await repo.appendFinalMessageAndCompleteTurn(
    conversationId, originalTurn, { role: "assistant", content: "old" }, randomUUID(), { response: "old", iterations: 1 },
  );

  const revisionTurnId = randomUUID();
  const accepted = await repo.acceptTurnIdempotently({
    turnId: revisionTurnId,
    conversationId,
    clientRequestId: randomUUID(),
    voiceCommandId: null,
    requestKind: "REGENERATE",
    requestFingerprint: computeRequestFingerprint("REGENERATE", { targetMessageId: original.messageId }),
  });
  assert.equal(accepted.kind, "NEW");
  await repo.markTurnRunning(revisionTurnId);
  const revised = await repo.appendRevisionAndCompleteTurn(
    conversationId, revisionTurnId, original.messageId,
    { role: "assistant", content: "new" }, randomUUID(), { response: "new", iterations: 1 },
  );
  assert.equal(revised.revisionOfId, original.messageId);
  const oldReloaded = await repo.getMessage(original.messageId);
  assert.equal(oldReloaded?.status, "SUPERSEDED");
  const active = await repo.getLastActiveMessages(conversationId, 30);
  assert.equal(active.some((message) => message.messageId === original.messageId), false);
  assert.equal(active.some((message) => message.messageId === revised.messageId), true);
  db.close();
});

test("11A Service: régénère une cible durable sortie de la fenêtre mémoire chaude", async () => {
  const { db, repo } = repository();
  await repo.initialize();
  const conversationId = randomUUID();
  await repo.initializeSession(conversationId, null);

  const originalTurn = await createRunningTurn(repo, conversationId);
  await repo.appendMessage(conversationId, originalTurn, { role: "user", content: "ancienne question" }, randomUUID());
  const original = await repo.appendFinalMessageAndCompleteTurn(
    conversationId,
    originalTurn,
    { role: "assistant", content: "ancienne réponse" },
    randomUUID(),
    { response: "ancienne réponse", iterations: 1 },
  );
  await repo.importHistoricalMessages(conversationId, [
    { role: "user", content: "plus récent 1" },
    { role: "assistant", content: "plus récent 2" },
    { role: "user", content: "plus récent 3" },
    { role: "assistant", content: "plus récent 4" },
    { role: "user", content: "plus récent 5" },
  ]);

  const memory = new MemoryManager(new LocalHashingEmbeddingProvider(), repo, 3, 10);
  let targetWasVisibleToAgent = false;
  const fakeAgent = {
    memory,
    async step() { return { response: "unused", iterations: 1 }; },
    async regenerateLastResponse(context: { conversationId: string }, targetMessageId: string) {
      targetWasVisibleToAgent = Boolean(memory.getWorkingSession(context.conversationId)?.getEntryByMessageId(targetMessageId));
      return { response: "réponse régénérée" };
    },
    async reflectAfterDurableTurn() { return null; },
    applyCheckpointRuntimeState() { return true; },
  } as unknown as Agent;
  const service = new ConversationExecutionService(repo, new ConversationCoordinator(), fakeAgent);

  const result = await service.handleTurn({
    requestKind: "REGENERATE",
    conversationId,
    clientRequestId: randomUUID(),
    payload: { targetMessageId: original.messageId },
  });

  assert.equal(targetWasVisibleToAgent, true, "la cible durable doit être rechargée avant l'appel Agent");
  assert.equal(result.result, "NEW");
  if (result.result === "NEW") assert.equal(result.response, "réponse régénérée");
  assert.equal((await repo.getMessage(original.messageId))?.status, "SUPERSEDED");
  db.close();
});

test("11A SQLite: pagination beforeSequence est stable", async () => {
  const { db, repo } = repository();
  await repo.initialize();
  const conversationId = randomUUID();
  await repo.initializeSession(conversationId, null);
  const turnId = await createRunningTurn(repo, conversationId);
  for (let i = 0; i < 7; i += 1) {
    await repo.appendMessage(conversationId, turnId, { role: "user", content: `m${i}` }, randomUUID());
  }
  const page1 = await repo.getMessagesPage(conversationId, 3);
  assert.deepEqual(page1.items.map((item) => item.sequence), [4, 5, 6]);
  assert.equal(page1.nextBeforeSequence, 4);
  const page2 = await repo.getMessagesPage(conversationId, 3, page1.nextBeforeSequence ?? undefined);
  assert.deepEqual(page2.items.map((item) => item.sequence), [1, 2, 3]);
  const page3 = await repo.getMessagesPage(conversationId, 3, page2.nextBeforeSequence ?? undefined);
  assert.deepEqual(page3.items.map((item) => item.sequence), [0]);
  assert.equal(page3.nextBeforeSequence, null);
  db.close();
});

test("11A SQLite: recovery transforme ACCEPTED/RUNNING en FAILED PROCESS_RESTART", async () => {
  const { db, repo } = repository();
  await repo.initialize();
  const conversationId = randomUUID();
  await repo.initializeSession(conversationId, null);
  const acceptedId = randomUUID();
  await repo.acceptTurnIdempotently({
    turnId: acceptedId, conversationId, clientRequestId: randomUUID(), voiceCommandId: null,
    requestKind: "MESSAGE", requestFingerprint: "a".repeat(64),
  });
  const runningId = await createRunningTurn(repo, conversationId);
  assert.equal(await repo.recoverInterruptedTurns(), 2);
  const rows = db.prepare("SELECT turn_id,status,failure_reason FROM conversation_turns ORDER BY turn_id").all() as Array<{turn_id:string;status:string;failure_reason:string}>;
  assert.equal(rows.every((row) => row.status === "FAILED" && row.failure_reason === "PROCESS_RESTART"), true);
  db.close();
});

test("11A Coordinator: même conversation FIFO, conversations distinctes parallèles", async () => {
  const coordinator = new ConversationCoordinator();
  const order: string[] = [];
  let releaseA1!: () => void;
  const a1Gate = new Promise<void>((resolve) => { releaseA1 = resolve; });
  const a1 = coordinator.execute("A", async () => { order.push("A1-start"); await a1Gate; order.push("A1-end"); return 1; });
  const a2 = coordinator.execute("A", async () => { order.push("A2"); return 2; });
  const b1 = coordinator.execute("B", async () => { order.push("B1"); return 3; });
  await new Promise((resolve) => setTimeout(resolve, 10));
  assert.ok(order.includes("A1-start"));
  assert.ok(order.includes("B1"), "B doit pouvoir progresser pendant A1");
  assert.equal(order.includes("A2"), false, "A2 doit attendre A1");
  releaseA1();
  assert.deepEqual(await Promise.all([a1, a2, b1]), [1, 2, 3]);
  assert.ok(order.indexOf("A2") > order.indexOf("A1-end"));
});

test("11A Coordinator: verrou exclusif attend les turns puis bloque les suivants", async () => {
  const coordinator = new ConversationCoordinator();
  const order: string[] = [];
  let releaseFirst!: () => void;
  const gate = new Promise<void>((resolve) => { releaseFirst = resolve; });
  const first = coordinator.execute("A", async () => { order.push("turn-start"); await gate; order.push("turn-end"); });
  const exclusive = coordinator.executeExclusive(async () => { order.push("exclusive"); });
  const after = coordinator.execute("B", async () => { order.push("after"); });
  await new Promise((resolve) => setTimeout(resolve, 10));
  assert.deepEqual(order, ["turn-start"]);
  releaseFirst();
  await Promise.all([first, exclusive, after]);
  assert.deepEqual(order, ["turn-start", "turn-end", "exclusive", "after"]);
});
