import test, { beforeEach, after } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { closeDb, getDb } from "../persistence/db.js";
import { config } from "../config.js";
import { MissionStore } from "./missionStore.js";
import {
  CallbackCorrelationFailedError,
  CallbackPayloadInvalidError,
  canonicalizeCallbackBody,
  computeCallbackSignature,
  processCallback,
  type CallbackEnvelope,
} from "./callbackTransport.js";
import { ContractVersionError, JARVIS00_CONTRACTS_SCHEMA_VERSION } from "./contracts.js";

const SECRET = "test-mission-sync-secret";
const ORIGINAL_DB_PATH = config.db.path;
const ORIGINAL_SECRET = config.callback.hmacSecret;

beforeEach(() => {
  closeDb();
  config.db.path = ":memory:";
  config.callback.hmacSecret = SECRET;
  getDb();
});

after(() => {
  closeDb();
  config.db.path = ORIGINAL_DB_PATH;
  config.callback.hmacSecret = ORIGINAL_SECRET;
});

function envelope(overrides: Partial<CallbackEnvelope> = {}): CallbackEnvelope {
  return {
    eventId: "sync-evt-1",
    missionId: "mission-sync-1",
    traceId: "trace-sync-1",
    eventType: "MISSION_SYNC",
    timestamp: Date.now(),
    schemaVersion: JARVIS00_CONTRACTS_SCHEMA_VERSION,
    payload: { project_id: "jarvis", status: "RECEIVED" },
    ...overrides,
  };
}

function signedBody(value: CallbackEnvelope): Record<string, unknown> {
  const canonical = canonicalizeCallbackBody(value);
  return {
    event_id: value.eventId,
    mission_id: value.missionId,
    trace_id: value.traceId,
    event_type: value.eventType,
    timestamp: value.timestamp,
    schema_version: value.schemaVersion,
    payload: value.payload,
    signature: computeCallbackSignature(SECRET, value.timestamp, canonical),
  };
}

test("MISSION_SYNC crée une mission persistante sans journaliser un événement métier", () => {
  const store = new MissionStore();
  const result = processCallback(signedBody(envelope()), store);

  assert.equal(result.outcome, "MISSION_CREATED");
  const mission = store.getMission("mission-sync-1");
  assert.ok(mission);
  assert.equal(mission.traceId, "trace-sync-1");
  assert.equal(mission.projectId, "jarvis");
  assert.equal(mission.status, "RECEIVED");
  assert.equal(store.listMissionEvents("mission-sync-1").length, 0);
});

test("MISSION_SYNC rejoué avec la même identité est idempotent", () => {
  const store = new MissionStore();
  const body = signedBody(envelope());

  assert.equal(processCallback(body, store).outcome, "MISSION_CREATED");
  assert.equal(processCallback(body, store).outcome, "MISSION_EXISTS");
  assert.equal(store.listMissionEvents("mission-sync-1").length, 0);
});

test("MISSION_SYNC refuse le même mission_id avec un autre trace_id", () => {
  const store = new MissionStore();
  processCallback(signedBody(envelope()), store);

  const conflict = envelope({ eventId: "sync-evt-2", traceId: "trace-usurpee" });
  assert.throws(() => processCallback(signedBody(conflict), store), CallbackCorrelationFailedError);
});

test("MISSION_SYNC refuse le même mission_id avec un autre project_id", () => {
  const store = new MissionStore();
  processCallback(signedBody(envelope()), store);

  const conflict = envelope({ eventId: "sync-evt-2", payload: { project_id: "autre-projet" } });
  assert.throws(() => processCallback(signedBody(conflict), store), CallbackCorrelationFailedError);
});

test("MISSION_SYNC exige project_id non vide et un status valide", () => {
  const store = new MissionStore();
  const missingProject = envelope({ payload: { project_id: "" } });
  assert.throws(() => processCallback(signedBody(missingProject), store), CallbackPayloadInvalidError);

  const invalidStatus = envelope({ eventId: "sync-evt-2", payload: { project_id: "jarvis", status: "UNKNOWN" } });
  assert.throws(() => processCallback(signedBody(invalidStatus), store), CallbackPayloadInvalidError);
});

test("MISSION_SYNC refuse une schema_version non supportée avant toute écriture", () => {
  const store = new MissionStore();
  const unsupported = envelope({ schemaVersion: JARVIS00_CONTRACTS_SCHEMA_VERSION + 1 });

  assert.throws(() => processCallback(signedBody(unsupported), store), ContractVersionError);
  assert.equal(store.getMission("mission-sync-1"), null);
});

test("une mission synchronisée survit à la fermeture et réouverture de SQLite", () => {
  closeDb();
  const dir = mkdtempSync(join(tmpdir(), "jarvis-mission-sync-"));
  config.db.path = join(dir, "jarvis.db");
  try {
    getDb();
    const store = new MissionStore();
    processCallback(signedBody(envelope()), store);
    closeDb();

    const reopened = new MissionStore();
    const mission = reopened.getMission("mission-sync-1");
    assert.ok(mission);
    assert.equal(mission.traceId, "trace-sync-1");
    assert.equal(mission.projectId, "jarvis");
  } finally {
    closeDb();
    rmSync(dir, { recursive: true, force: true });
    config.db.path = ":memory:";
    getDb();
  }
});

test("après MISSION_SYNC, PR-F produit APPLIED puis DUPLICATE pour le même event_id", () => {
  const store = new MissionStore();
  processCallback(signedBody(envelope()), store);

  const callback = envelope({
    eventId: "build-result-1",
    eventType: "BUILD_RESULT",
    payload: { ok: true },
  });
  const body = signedBody(callback);

  assert.equal(processCallback(body, store).outcome, "APPLIED");
  assert.equal(processCallback(body, store).outcome, "DUPLICATE");
  assert.equal(store.listMissionEvents("mission-sync-1").length, 1);
});

test("après MISSION_SYNC, un callback avec mauvais trace_id est rejeté", () => {
  const store = new MissionStore();
  processCallback(signedBody(envelope()), store);

  const callback = envelope({
    eventId: "build-result-wrong-trace",
    traceId: "trace-invalide",
    eventType: "BUILD_RESULT",
    payload: { ok: true },
  });

  assert.throws(() => processCallback(signedBody(callback), store), CallbackCorrelationFailedError);
  assert.equal(store.listMissionEvents("mission-sync-1").length, 0);
});

test("HUMAN_GATE_DECISION est uniquement journalisé et ne change pas l'état de la mission", () => {
  const store = new MissionStore();
  processCallback(signedBody(envelope()), store);

  const decision = envelope({
    eventId: "human-gate-1",
    eventType: "HUMAN_GATE_DECISION",
    payload: { action: "APPROUVER_FUSION" },
  });
  const result = processCallback(signedBody(decision), store);

  assert.equal(result.outcome, "APPLIED");
  assert.equal(store.getMission("mission-sync-1")?.status, "RECEIVED");
  const events = store.listMissionEvents("mission-sync-1");
  assert.equal(events.length, 1);
  assert.equal(events[0].eventType, "HUMAN_GATE_DECISION");
  assert.deepEqual(events[0].payload, { action: "APPROUVER_FUSION" });
});
