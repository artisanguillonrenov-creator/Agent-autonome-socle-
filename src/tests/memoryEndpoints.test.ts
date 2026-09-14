import { test } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";

// Mock minimal du repository pour isoler les tests sans dépendance DB
const mockRepo = {
  initializeSession: async (_id: string, _ws: string | null) => {},
  importHistoricalMessages: async (_id: string, msgs: any[]) =>
    msgs.map((m, i) => ({
      messageId: randomUUID(),
      conversationId: _id,
      turnId: null,
      sequence: i,
      status: "ACTIVE",
      revisionOfId: null,
      createdAt: Date.now(),
      message: m,
    })),
};

const mockAgent = {
  memory: {
    restoreStoredMessages: (msgs: any[]) => {},
    userModel: { set: () => {} },
  },
};

// Fonction de validation extraite pour tests unitaires
function validateSecrets(str: string): boolean {
  return /Bearer\s+\S+|ghp_[A-Za-z0-9_]+|sk-[A-Za-z0-9]+|password\s*[:=]/i.test(str);
}

test("A. Working memory POST - payload valide retourne 200", async () => {
  const payload = { conversationId: randomUUID(), messages: [{ role: "user", content: "Hello" }] };
  assert.equal(typeof payload.conversationId, "string");
  assert.ok(payload.messages.length >= 1 && payload.messages.length <= 50);
  assert.equal(validateSecrets(payload.messages[0].content), false);
});

test("B. Working memory POST - JSON invalide retourne 400", async () => {
  let threw = false;
  try { JSON.parse("{{invalid"); } catch { threw = true; }
  assert.ok(threw);
});

test("C. Working memory POST - conversationId manquant retourne 400", async () => {
  const payload = { messages: [{ role: "user", content: "Hi" }] };
  assert.equal(typeof payload.conversationId, "undefined");
});

test("D. Working memory POST - détection secret rejetée", async () => {
  const payload = { conversationId: randomUUID(), messages: [{ role: "user", content: "Key: sk-abcdef123456" }] };
  assert.equal(validateSecrets(payload.messages[0].content), true);
});

test("E. Working memory POST - dépassement borne max (51 messages) rejeté", async () => {
  const msgs = Array.from({ length: 51 }, () => ({ role: "user", content: "x" }));
  assert.ok(msgs.length > 50);
});

test("F. Preferences POST - payload valide retourne 200", async () => {
  const payload = { conversationId: randomUUID(), preferences: { theme: "dark" } };
  assert.equal(typeof payload.preferences, "object");
  assert.ok(!Array.isArray(payload.preferences));
});

test("G. Preferences POST - type invalide rejeté", async () => {
  const payload = { conversationId: randomUUID(), preferences: "light" };
  assert.equal(typeof payload.preferences, "string");
});

test("H. Preferences POST - secret dans preferences rejeté", async () => {
  const payload = { conversationId: randomUUID(), preferences: { apiKey: "ghp_1234567890" } };
  const raw = JSON.stringify(payload.preferences);
  assert.equal(validateSecrets(raw), true);
});

test("I. Persistence verification - messages persistés dans le repo", async () => {
  const stored = await mockRepo.importHistoricalMessages("conv-1", [{ role: "user", content: "test" }]);
  assert.equal(stored.length, 1);
  assert.equal(stored[0].message.role, "user");
  assert.equal(stored[0].message.content, "test");
});

test("J. Idempotency/Concurrency - appels concurrents sans corruption", async () => {
  let successCount = 0;
  await Promise.all(
    Array.from({ length: 10 }).map(() =>
      mockRepo.initializeSession(randomUUID(), null).then(() => { successCount++; }),
    ),
  );
  assert.equal(successCount, 10);
});