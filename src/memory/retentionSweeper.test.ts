import { test } from "node:test";
import assert from "node:assert/strict";
import { closeDb, getDb } from "../persistence/db.js";
import { config } from "../config.js";
import { GraphMemory } from "./graphMemory.js";
import { runRetentionSweep, sweepStaleGraphTriples } from "./retentionSweeper.js";

const DAY_MS = 24 * 60 * 60 * 1000;

function setupTestDb() {
  config.db.path = ":memory:";
  closeDb();
  getDb();
}

test("sweepStaleGraphTriples() ne supprime rien quand désactivé (maxAgeDays <= 0)", () => {
  setupTestDb();
  const graph = new GraphMemory();
  graph.addTriple("Jarvis", "développé par", "artisanguillonrenov", { confidence: 0.1 });
  assert.equal(sweepStaleGraphTriples(0, 0.4), 0);
  assert.equal(graph.count(), 1);
});

test("sweepStaleGraphTriples() préserve un triplet à haute confiance même très ancien", () => {
  setupTestDb();
  const graph = new GraphMemory();
  const triple = graph.addTriple("Jarvis", "développé par", "artisanguillonrenov", { confidence: 0.95 });
  const now = Date.now();
  getDb().prepare(`UPDATE knowledge_graph_triples SET updated_at = ? WHERE id = ?`).run(now - 365 * DAY_MS, triple.id);

  const deleted = sweepStaleGraphTriples(90, 0.4, now);
  assert.equal(deleted, 0, "un triplet établi ne s'use jamais par la seule ancienneté");
  assert.equal(graph.count(), 1);
});

test("sweepStaleGraphTriples() balaie un triplet à la fois ancien et peu fiable", () => {
  setupTestDb();
  const graph = new GraphMemory();
  const stale = graph.addTriple("Rumeur", "concerne", "X", { confidence: 0.2 });
  const fresh = graph.addTriple("Fait vérifié", "concerne", "Y", { confidence: 0.2 });
  const now = Date.now();
  getDb().prepare(`UPDATE knowledge_graph_triples SET updated_at = ? WHERE id = ?`).run(now - 200 * DAY_MS, stale.id);
  getDb().prepare(`UPDATE knowledge_graph_triples SET updated_at = ? WHERE id = ?`).run(now - 1 * DAY_MS, fresh.id);

  const deleted = sweepStaleGraphTriples(90, 0.4, now);
  assert.equal(deleted, 1);
  const remaining = graph.all();
  assert.equal(remaining.length, 1);
  assert.equal(remaining[0].subject, "Fait vérifié");
});

test("runRetentionSweep() combine mémoire épisodique et graphe en un seul appel", () => {
  setupTestDb();
  const graph = new GraphMemory();
  const stale = graph.addTriple("Rumeur", "concerne", "X", { confidence: 0.1 });
  const now = Date.now();
  getDb().prepare(`UPDATE knowledge_graph_triples SET updated_at = ? WHERE id = ?`).run(now - 200 * DAY_MS, stale.id);

  const result = runRetentionSweep(
    { episodicRetentionDays: 30, graphRetentionDays: 90, graphRetentionMaxConfidence: 0.4 },
    now,
  );
  assert.equal(result.episodicDeleted, 0);
  assert.equal(result.graphTriplesDeleted, 1);
  assert.equal(graph.count(), 0);
});
