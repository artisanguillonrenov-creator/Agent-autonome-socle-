import assert from "node:assert/strict";
import { test } from "node:test";
import Database from "better-sqlite3";
import { PersonalityPolicyEngine } from "./personalityPolicyEngine.js";
import { PersonalityOutputValidator } from "./personalityOutputValidator.js";
import { PersonalityPromptComposer } from "./personalityPromptComposer.js";
import { SqlitePersonalityRepository } from "./sqlitePersonalityRepository.js";
import type { IPersonalityRepository } from "./domain/personalityRepository.js";
import type { JarvisPersonalityState, PersonalityTurnPolicy } from "./domain/types.js";
import type { StoredConversationMessage } from "../persistence/conversations/types.js";

class MemoryPersonalityRepository implements IPersonalityRepository {
  readonly states = new Map<string, JarvisPersonalityState>();
  async initialize(): Promise<void> {}
  async getState(conversationId: string): Promise<JarvisPersonalityState | null> {
    return this.states.get(conversationId) ?? null;
  }
  async saveState(state: JarvisPersonalityState): Promise<void> {
    this.states.set(state.conversationId, { ...state });
  }
}

const basePolicy = (overrides: Partial<PersonalityTurnPolicy> = {}): PersonalityTurnPolicy => ({
  mode: "CONVERSATIONNEL",
  gravity: "ROUTINE",
  certainty: "CONFIRMED",
  allowMonsieur: true,
  allowWilliam: false,
  allowHumor: true,
  eventProtocol: "NONE",
  ...overrides,
});

function storedAssistant(sequence: number, content: string, toolCalls = false): StoredConversationMessage {
  return {
    messageId: `m-${sequence}`,
    conversationId: "c",
    turnId: `t-${sequence}`,
    sequence,
    status: "ACTIVE",
    revisionOfId: null,
    createdAt: sequence,
    message: toolCalls
      ? { role: "assistant", content: null, toolCalls: [{ id: `call-${sequence}`, type: "function", function: { name: "probe", arguments: "{}" } }] }
      : { role: "assistant", content },
  };
}

test("Personality: conservative default is UNKNOWN and humor stays off", async () => {
  const repo = new MemoryPersonalityRepository();
  const engine = new PersonalityPolicyEngine(repo);
  const policy = await engine.generatePolicy("c1");
  assert.equal(policy.mode, "CONVERSATIONNEL");
  assert.equal(policy.gravity, "ROUTINE");
  assert.equal(policy.certainty, "UNKNOWN");
  assert.equal(policy.allowHumor, false);
  assert.equal(policy.allowWilliam, false);
});

test("Personality: monsieur cooldown is two accepted responses and isolated per conversation", async () => {
  const repo = new MemoryPersonalityRepository();
  const engine = new PersonalityPolicyEngine(repo);

  const first = await engine.generatePolicy("A", { explicitCertainty: "CONFIRMED" });
  assert.equal(first.allowMonsieur, true);
  await engine.commitAcceptedResponse("A", "Bien entendu, monsieur.", first);
  assert.equal((await engine.generatePolicy("A")).allowMonsieur, false);
  assert.equal((await engine.generatePolicy("B")).allowMonsieur, true);

  await engine.commitAcceptedResponse("A", "Première réponse sans formule.", await engine.generatePolicy("A"));
  assert.equal((await engine.generatePolicy("A")).allowMonsieur, false);
  await engine.commitAcceptedResponse("A", "Deuxième réponse sans formule.", await engine.generatePolicy("A"));
  assert.equal((await engine.generatePolicy("A")).allowMonsieur, true);
});

test("Personality: explicit exception may allow monsieur during cooldown", async () => {
  const repo = new MemoryPersonalityRepository();
  const engine = new PersonalityPolicyEngine(repo);
  const policy = await engine.generatePolicy("c");
  await engine.commitAcceptedResponse("c", "C'est fait, monsieur.", policy);
  const exception = await engine.generatePolicy("c", { importantOperationConclusion: true });
  assert.equal(exception.allowMonsieur, true);
});

test("Personality: William requires semantic trigger, never mere business occurrence", async () => {
  const repo = new MemoryPersonalityRepository();
  const engine = new PersonalityPolicyEngine(repo);
  assert.equal((await engine.generatePolicy("c")).allowWilliam, false);
  assert.equal((await engine.generatePolicy("c", { userOpenedPersonalRegister: true })).allowWilliam, true);

  const validator = new PersonalityOutputValidator();
  const business = validator.validate("Le fichier William.json existe.", basePolicy({ allowWilliam: false }));
  assert.equal(business.isValid, true);
  const vocative = validator.validate("William, il faut interrompre l'opération.", basePolicy({ allowWilliam: false }));
  assert.equal(vocative.isValid, false);
  assert.ok(vocative.violations.includes("WILLIAM_FORBIDDEN"));
});

test("Personality: monsieur must be first or last sentence and at most once", () => {
  const validator = new PersonalityOutputValidator();
  assert.equal(validator.validate("Monsieur, voici le résultat. Tout est stable.", basePolicy()).isValid, true);
  assert.equal(validator.validate("Tout est stable. C'est terminé, monsieur.", basePolicy()).isValid, true);
  const middle = validator.validate("J'ai vérifié. Monsieur, tout est stable. Je continue.", basePolicy());
  assert.equal(middle.isValid, false);
  assert.ok(middle.violations.includes("MONSIEUR_POSITION_INVALID"));
});

test("Personality: emoji and exclamation are rejected outside code", () => {
  const validator = new PersonalityOutputValidator();
  assert.equal(validator.validate("C'est fait 😊", basePolicy()).isValid, false);
  assert.equal(validator.validate("C'est fait!", basePolicy()).isValid, false);
  assert.equal(validator.validate("Code: `if (a != b) return;`", basePolicy()).isValid, true);
});

test("Personality: critical response requires all four sections", () => {
  const validator = new PersonalityOutputValidator();
  const critical = basePolicy({ gravity: "CRITIQUE", allowHumor: false });
  assert.equal(validator.validate("FAIT: panne. CONSÉQUENCE: arrêt. RECOMMANDATION: isoler. ACTION: confirmer.", critical).isValid, true);
  const missing = validator.validate("FAIT: panne. RECOMMANDATION: isoler. ACTION: confirmer.", critical);
  assert.equal(missing.isValid, false);
});

test("Personality: transcript reconciliation ignores tool-call assistant messages", async () => {
  const repo = new MemoryPersonalityRepository();
  const engine = new PersonalityPolicyEngine(repo);
  await engine.reconcileFromTranscript("c", [
    storedAssistant(1, "Terminé, monsieur."),
    storedAssistant(2, "", true),
    storedAssistant(3, "Réponse suivante."),
  ]);
  assert.equal((await repo.getState("c"))?.monsieurCooldownRemaining, 1);
});

test("Personality: prompt composer keeps critical personality constraints explicit", () => {
  const text = new PersonalityPromptComposer().compose(basePolicy({
    gravity: "CRITIQUE",
    allowHumor: false,
    allowMonsieur: false,
    certainty: "VERIFICATION_REQUIRED",
  }));
  assert.match(text, /GRAVITY=CRITIQUE/);
  assert.match(text, /MONSIEUR=FORBIDDEN/);
  assert.match(text, /FAIT:\s*\/ CONSÉQUENCE:/);
  assert.match(text, /VERIFICATION_REQUIRED/);
});

test("Personality SQLite: state persists per conversation and cascades with session", async () => {
  const db = new Database(":memory:");
  try {
    db.pragma("foreign_keys = ON");
    db.exec("CREATE TABLE conversation_sessions (conversation_id TEXT PRIMARY KEY)");
    db.prepare("INSERT INTO conversation_sessions(conversation_id) VALUES (?)").run("A");
    db.prepare("INSERT INTO conversation_sessions(conversation_id) VALUES (?)").run("B");
    const repo = new SqlitePersonalityRepository(db);
    await repo.initialize();
    await repo.saveState({ conversationId: "A", monsieurCooldownRemaining: 2, updatedAt: 10 });
    await repo.saveState({ conversationId: "B", monsieurCooldownRemaining: 0, updatedAt: 11 });
    assert.equal((await repo.getState("A"))?.monsieurCooldownRemaining, 2);
    assert.equal((await repo.getState("B"))?.monsieurCooldownRemaining, 0);
    db.prepare("DELETE FROM conversation_sessions WHERE conversation_id=?").run("A");
    assert.equal(await repo.getState("A"), null);
  } finally {
    db.close();
  }
});
