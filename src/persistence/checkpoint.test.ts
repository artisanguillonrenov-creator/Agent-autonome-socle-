import { test } from "node:test";
import assert from "node:assert/strict";
import { closeDb, getDb } from "./db.js";
import { config } from "../config.js";
import { saveCheckpoint, loadCheckpoint, listCheckpoints, type CheckpointState } from "./checkpoint.js";

function setupTestDb() {
  config.db.path = ":memory:";
  closeDb();
  getDb();
}

const STATE_A: CheckpointState = { workingMemory: [{ role: "user", content: "Message confidentiel du projet A" }], planNodes: [], stepCount: 1 };
const STATE_B: CheckpointState = { workingMemory: [{ role: "user", content: "Message du projet B" }], planNodes: [], stepCount: 1 };

// ---------------------------------------------------------------------------
// GAP D'ISOLATION (audit préventif, brief JARVIS-00 tâche 7) : le correctif PR
// #59 (workingMemory/vectorMemory/facts/graphMemory) laissait explicitement les
// checkpoints hors scope ("checkpoints predate this feature"). saveCheckpoint()
// capture pourtant workingMemory — le même contenu que PR #59 isolait ailleurs.
// ---------------------------------------------------------------------------

test("loadCheckpoint sans isolation (comportement historique) : un checkpoint reste chargeable quel que soit son workspace d'origine", () => {
  setupTestDb();
  const id = saveCheckpoint("checkpoint-a", STATE_A, "workspace-a");
  const loaded = loadCheckpoint(id);
  assert.ok(loaded);
  assert.equal(loaded!.workingMemory[0]!.content, "Message confidentiel du projet A");
});

test("loadCheckpoint avec isolation active refuse un checkpoint d'un autre workspace", () => {
  setupTestDb();
  const id = saveCheckpoint("checkpoint-a", STATE_A, "workspace-a");
  const loadedFromB = loadCheckpoint(id, "workspace-b", true);
  assert.equal(loadedFromB, null, "un checkpoint du workspace A ne doit jamais se charger depuis le workspace B sous isolation");

  const loadedFromA = loadCheckpoint(id, "workspace-a", true);
  assert.ok(loadedFromA, "le workspace propriétaire garde l'accès à son propre checkpoint");
  assert.equal(loadedFromA!.workingMemory[0]!.content, "Message confidentiel du projet A");
});

test("loadCheckpoint avec isolation active refuse aussi un checkpoint sans workspace (global/non taggé)", () => {
  setupTestDb();
  const id = saveCheckpoint("checkpoint-global", STATE_A);
  const loadedFromB = loadCheckpoint(id, "workspace-b", true);
  assert.equal(loadedFromB, null, "un checkpoint non scopé ne doit pas fuiter dans un contexte isolé, même contrat strict que WorkingMemory.allFor()");
});

test("listCheckpoints sans isolation (comportement historique) : tous les checkpoints apparaissent, tous workspaces confondus", () => {
  setupTestDb();
  saveCheckpoint("checkpoint-a", STATE_A, "workspace-a");
  saveCheckpoint("checkpoint-b", STATE_B, "workspace-b");
  const all = listCheckpoints();
  assert.equal(all.length, 2);
});

test("listCheckpoints avec isolation active ne montre que les checkpoints du workspace demandé (fuite corrigée : PR #59 gap)", () => {
  setupTestDb();
  saveCheckpoint("checkpoint-a", STATE_A, "workspace-a");
  saveCheckpoint("checkpoint-b", STATE_B, "workspace-b");

  const forA = listCheckpoints("workspace-a", true);
  assert.equal(forA.length, 1);
  assert.equal(forA[0]!.label, "checkpoint-a");

  const forB = listCheckpoints("workspace-b", true);
  assert.equal(forB.length, 1);
  assert.equal(forB[0]!.label, "checkpoint-b");
});

test("listCheckpoints avec isolation active mais sans workspaceId retombe sur le comportement global (jamais de crash ni de filtre ambigu)", () => {
  setupTestDb();
  saveCheckpoint("checkpoint-a", STATE_A, "workspace-a");
  saveCheckpoint("checkpoint-b", STATE_B, "workspace-b");
  const all = listCheckpoints(undefined, true);
  assert.equal(all.length, 2);
});
