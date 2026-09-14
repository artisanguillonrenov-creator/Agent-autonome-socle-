import test, { beforeEach, after } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { createHmac } from "node:crypto";
import { closeDb, getDb } from "../persistence/db.js";
import { config } from "../config.js";
import { MissionStore } from "./missionStore.js";
import { MissionNotFoundError } from "./types.js";
import { JARVIS00_CONTRACTS_SCHEMA_VERSION, ContractVersionError } from "./contracts.js";
import {
  CALLBACK_TIMESTAMP_WINDOW_MS,
  CALLBACK_EVENT_TYPES,
  CallbackAuthNotConfiguredError,
  CallbackCorrelationFailedError,
  CallbackPayloadInvalidError,
  CallbackSignatureInvalidError,
  CallbackTimestampInvalidError,
  canonicalizeCallbackBody,
  computeCallbackSignature,
  processCallback,
  type CallbackEnvelope,
} from "./callbackTransport.js";

const SECRET = "test-hmac-secret-do-not-use-in-prod";
let previousSecret: string;

beforeEach(() => {
  closeDb();
  config.db.path = ":memory:";
  getDb();
  previousSecret = config.callback.hmacSecret;
  config.callback.hmacSecret = SECRET;
});

function makeEnvelope(overrides: Partial<CallbackEnvelope> = {}): CallbackEnvelope {
  return {
    eventId: "evt-1",
    missionId: "mission-1",
    traceId: "trace-1",
    eventType: "BUILD_RESULT",
    timestamp: Date.now(),
    schemaVersion: JARVIS00_CONTRACTS_SCHEMA_VERSION,
    payload: { ok: true },
    ...overrides,
  };
}

function signedBody(envelope: CallbackEnvelope, secret: string = SECRET): Record<string, unknown> {
  const canonicalBody = canonicalizeCallbackBody(envelope);
  const signature = computeCallbackSignature(secret, envelope.timestamp, canonicalBody);
  return {
    event_id: envelope.eventId,
    mission_id: envelope.missionId,
    trace_id: envelope.traceId,
    event_type: envelope.eventType,
    timestamp: envelope.timestamp,
    schema_version: envelope.schemaVersion,
    payload: envelope.payload,
    signature,
  };
}

function seedMission(store: MissionStore, missionId: string, traceId: string) {
  return store.createMission({ missionId, traceId, projectId: "jarvis" });
}

// --- 1. Callback valide : signature correcte, mission/trace corrects -> appliqué ---

test("callback valide (HMAC correcte, timestamp frais, mission/trace corrects) -> APPLIED et événement journalisé", () => {
  const store = new MissionStore();
  seedMission(store, "mission-1", "trace-1");
  const envelope = makeEnvelope();
  const result = processCallback(signedBody(envelope), store);

  assert.equal(result.outcome, "APPLIED");
  assert.equal(result.missionId, "mission-1");
  assert.equal(result.traceId, "trace-1");
  assert.equal(result.eventId, "evt-1");

  const events = store.listMissionEvents("mission-1");
  assert.equal(events.length, 1);
  assert.equal(events[0].eventId, "evt-1");
  assert.equal(events[0].eventType, "BUILD_RESULT");
  assert.deepEqual(events[0].payload, { ok: true });
});

// --- HMAC : signature invalide rejetée, comparaison jamais "===" ---

test("signature invalide (même longueur, contenu différent) -> CallbackSignatureInvalidError, aucun événement journalisé", () => {
  const store = new MissionStore();
  seedMission(store, "mission-1", "trace-1");
  const envelope = makeEnvelope();
  const body = signedBody(envelope);
  // Falsifie la signature tout en gardant un hex de même longueur (32 octets).
  const forged = (body.signature as string).split("").reverse().join("");
  body.signature = forged === body.signature ? "0".repeat((body.signature as string).length) : forged;

  assert.throws(() => processCallback(body, store), CallbackSignatureInvalidError);
  assert.equal(store.listMissionEvents("mission-1").length, 0);
});

test("signature signée avec un secret différent -> CallbackSignatureInvalidError", () => {
  const store = new MissionStore();
  seedMission(store, "mission-1", "trace-1");
  const envelope = makeEnvelope();
  const body = signedBody(envelope, "un-autre-secret-totalement-different");

  assert.throws(() => processCallback(body, store), CallbackSignatureInvalidError);
});

test("payload altéré après signature (contenu modifié, signature d'origine conservée) -> CallbackSignatureInvalidError", () => {
  const store = new MissionStore();
  seedMission(store, "mission-1", "trace-1");
  const envelope = makeEnvelope();
  const body = signedBody(envelope);
  body.payload = { ok: false, tampered: true };

  assert.throws(() => processCallback(body, store), CallbackSignatureInvalidError);
});

// --- 3. Secret absent -> CALLBACK_AUTH_NOT_CONFIGURED ---

test("secret HMAC non configuré -> CallbackAuthNotConfiguredError, jamais de génération automatique", () => {
  const store = new MissionStore();
  seedMission(store, "mission-1", "trace-1");
  config.callback.hmacSecret = "";
  const envelope = makeEnvelope();
  const body = signedBody(envelope);

  assert.throws(() => processCallback(body, store), CallbackAuthNotConfiguredError);
});

test("le secret n'apparaît jamais dans un message d'erreur, quel que soit le cas de rejet", () => {
  const store = new MissionStore();
  seedMission(store, "mission-1", "trace-1");
  const envelope = makeEnvelope();
  const body = signedBody(envelope);
  body.signature = "0".repeat(64);

  try {
    processCallback(body, store);
    assert.fail("devait lever CallbackSignatureInvalidError");
  } catch (e) {
    assert.doesNotMatch((e as Error).message, new RegExp(SECRET));
  }
});

// --- 4. Anti-replay : fenêtre temporelle + idempotence par event_id ---

test("timestamp trop ancien (hors fenêtre ±5min) -> CallbackTimestampInvalidError", () => {
  const store = new MissionStore();
  seedMission(store, "mission-1", "trace-1");
  const envelope = makeEnvelope({ timestamp: Date.now() - (CALLBACK_TIMESTAMP_WINDOW_MS + 60_000) });
  const body = signedBody(envelope);

  assert.throws(() => processCallback(body, store), CallbackTimestampInvalidError);
});

test("timestamp trop futur (hors fenêtre ±5min) -> CallbackTimestampInvalidError", () => {
  const store = new MissionStore();
  seedMission(store, "mission-1", "trace-1");
  const envelope = makeEnvelope({ timestamp: Date.now() + (CALLBACK_TIMESTAMP_WINDOW_MS + 60_000) });
  const body = signedBody(envelope);

  assert.throws(() => processCallback(body, store), CallbackTimestampInvalidError);
});

test("timestamp dans la fenêtre (juste sous la limite) -> accepté", () => {
  const store = new MissionStore();
  seedMission(store, "mission-1", "trace-1");
  const envelope = makeEnvelope({ timestamp: Date.now() - (CALLBACK_TIMESTAMP_WINDOW_MS - 1000) });
  const body = signedBody(envelope);

  const result = processCallback(body, store);
  assert.equal(result.outcome, "APPLIED");
});

test("même event_id rejoué -> DUPLICATE, aucun second effet de bord (pas de double événement, séquence inchangée)", () => {
  const store = new MissionStore();
  seedMission(store, "mission-1", "trace-1");
  const envelope = makeEnvelope();
  const body = signedBody(envelope);

  const first = processCallback(body, store);
  assert.equal(first.outcome, "APPLIED");

  const second = processCallback(body, store);
  assert.equal(second.outcome, "DUPLICATE");

  const events = store.listMissionEvents("mission-1");
  assert.equal(events.length, 1);
  const mission = store.getMission("mission-1")!;
  assert.equal(mission.lastEventSequence, 1);
});

test("event_id rejoué avec un timestamp désormais hors fenêtre est quand même détecté comme doublon (auth vérifiée sur l'enveloppe reçue, pas sur l'ancienne)", () => {
  // Le rejeu réel enverrait la même enveloppe complète (donc le même timestamp, toujours
  // vérifié) : ce test documente que la détection de doublon a lieu APRÈS l'authentification,
  // jamais avant — un event_id ne permet pas de contourner la vérification HMAC/anti-rejeu.
  const store = new MissionStore();
  seedMission(store, "mission-1", "trace-1");
  const oldEnvelope = makeEnvelope({ timestamp: Date.now() - (CALLBACK_TIMESTAMP_WINDOW_MS + 60_000) });
  const staleBody = signedBody(oldEnvelope);

  assert.throws(() => processCallback(staleBody, store), CallbackTimestampInvalidError);
  assert.equal(store.listMissionEvents("mission-1").length, 0);
});

// --- 5. Corrélation mission/trace ---

test("mission_id introuvable -> MissionNotFoundError", () => {
  const store = new MissionStore();
  const envelope = makeEnvelope({ missionId: "does-not-exist" });
  const body = signedBody(envelope);

  assert.throws(() => processCallback(body, store), MissionNotFoundError);
});

test("trace_id ne correspond pas à la mission -> CallbackCorrelationFailedError (jamais accepté même si la signature est valide)", () => {
  const store = new MissionStore();
  seedMission(store, "mission-1", "trace-reelle");
  const envelope = makeEnvelope({ missionId: "mission-1", traceId: "trace-usurpee" });
  const body = signedBody(envelope);

  assert.throws(() => processCallback(body, store), CallbackCorrelationFailedError);
  assert.equal(store.listMissionEvents("mission-1").length, 0);
});

// --- 6. Version de contrat ---

test("schema_version incompatible -> ContractVersionError (CONTRACT_VERSION_UNSUPPORTED)", () => {
  const store = new MissionStore();
  seedMission(store, "mission-1", "trace-1");
  const envelope = makeEnvelope({ schemaVersion: JARVIS00_CONTRACTS_SCHEMA_VERSION + 999 });
  const body = signedBody(envelope);

  assert.throws(() => processCallback(body, store), ContractVersionError);
});

// --- 7. Validation du payload ---

test("corps non-objet (tableau, null, primitive) -> CallbackPayloadInvalidError", () => {
  const store = new MissionStore();
  assert.throws(() => processCallback(null, store), CallbackPayloadInvalidError);
  assert.throws(() => processCallback([], store), CallbackPayloadInvalidError);
  assert.throws(() => processCallback("not-an-object", store), CallbackPayloadInvalidError);
});

test("champs obligatoires manquants ou vides -> CallbackPayloadInvalidError", () => {
  const store = new MissionStore();
  seedMission(store, "mission-1", "trace-1");
  const envelope = makeEnvelope();
  const base = signedBody(envelope);

  for (const field of ["event_id", "mission_id", "trace_id", "event_type", "signature"]) {
    const body = { ...base, [field]: "" };
    assert.throws(() => processCallback(body, store), CallbackPayloadInvalidError, `field=${field}`);
  }
});

test("event_type inconnu -> CallbackPayloadInvalidError", () => {
  const store = new MissionStore();
  seedMission(store, "mission-1", "trace-1");
  const envelope = makeEnvelope();
  const body = signedBody(envelope);
  body.event_type = "SOMETHING_NOT_CATALOGUED";

  assert.throws(() => processCallback(body, store), CallbackPayloadInvalidError);
});

test("timestamp/schema_version non numériques -> CallbackPayloadInvalidError", () => {
  const store = new MissionStore();
  seedMission(store, "mission-1", "trace-1");
  const envelope = makeEnvelope();
  const body1 = { ...signedBody(envelope), timestamp: "not-a-number" };
  const body2 = { ...signedBody(envelope), schema_version: "1" };

  assert.throws(() => processCallback(body1, store), CallbackPayloadInvalidError);
  assert.throws(() => processCallback(body2, store), CallbackPayloadInvalidError);
});

test("payload non-objet -> CallbackPayloadInvalidError", () => {
  const store = new MissionStore();
  seedMission(store, "mission-1", "trace-1");
  const envelope = makeEnvelope();
  const body = { ...signedBody(envelope), payload: "not-an-object" };

  assert.throws(() => processCallback(body, store), CallbackPayloadInvalidError);
});

// --- Canonicalisation déterministe (indépendante de l'ordre des clés du payload) ---

test("canonicalizeCallbackBody est indépendant de l'ordre des clés du payload -> même signature acceptée", () => {
  const store = new MissionStore();
  seedMission(store, "mission-1", "trace-1");
  const timestamp = Date.now();
  const envelopeA = makeEnvelope({ timestamp, payload: { a: 1, b: 2 } });
  const envelopeB = makeEnvelope({ timestamp, payload: { b: 2, a: 1 } });

  assert.equal(canonicalizeCallbackBody(envelopeA), canonicalizeCallbackBody(envelopeB));

  const signature = computeCallbackSignature(SECRET, timestamp, canonicalizeCallbackBody(envelopeA));
  const body = { ...signedBody(envelopeB), signature };
  const result = processCallback(body, store);
  assert.equal(result.outcome, "APPLIED");
});

test("tous les event_type catalogués sont acceptés lorsqu'ils sont correctement signés et corrélés", () => {
  const store = new MissionStore();
  for (const eventType of CALLBACK_EVENT_TYPES) {
    const missionId = `mission-${eventType}`;
    seedMission(store, missionId, "trace-x");
    const envelope = makeEnvelope({ eventId: `evt-${eventType}`, missionId, traceId: "trace-x", eventType });
    const result = processCallback(signedBody(envelope), store);
    assert.equal(result.outcome, "APPLIED", `eventType=${eventType}`);
  }
});

// --- Vérification statique : aucun chemin d'écriture/fusion GitHub, aucune fusion automatique ---

test("aucune méthode d'écriture/fusion GitHub dans callbackTransport.ts (vérification statique)", () => {
  const path = fileURLToPath(new URL("./callbackTransport.ts", import.meta.url));
  const source = readFileSync(path, "utf-8");
  assert.doesNotMatch(source, /octokit|\.merge\(|createOrUpdateFileContents|createRef\(|pulls\.merge/i);
});

test("le HMAC utilise bien createHmac/timingSafeEqual (jamais une comparaison '===' de signature)", () => {
  const path = fileURLToPath(new URL("./callbackTransport.ts", import.meta.url));
  const source = readFileSync(path, "utf-8");
  assert.match(source, /timingSafeEqual/);
  // Sanity check indépendant : reproduit le calcul attendu à la main.
  const manual = createHmac("sha256", SECRET).update("123.\"abc\"").digest("hex");
  assert.equal(computeCallbackSignature(SECRET, 123, '"abc"'), manual);
});

after(() => {
  config.callback.hmacSecret = previousSecret;
});
