import { test } from "node:test";
import assert from "node:assert/strict";
import { closeDb, getDb } from "../persistence/db.js";
import { config } from "../config.js";
import { GraphMemory, formatTriple } from "./graphMemory.js";

function setupTestDb() {
  config.db.path = ":memory:";
  closeDb();
  getDb();
}

test("GraphMemory.addTriple() persiste puis findRelated() retrouve par sujet ou objet", () => {
  setupTestDb();
  const graph = new GraphMemory();
  graph.addTriple("Jarvis", "développé par", "artisanguillonrenov");
  graph.addTriple("Alice", "travaille avec", "Jarvis");

  const bySubject = graph.findRelated("Jarvis");
  assert.equal(bySubject.length, 2);
  assert.ok(bySubject.some((t) => t.subject === "Jarvis" && t.object === "artisanguillonrenov"));
  assert.ok(bySubject.some((t) => t.subject === "Alice" && t.object === "Jarvis"));
});

test("GraphMemory.addTriple() est un upsert : un même triplet revu ne se duplique jamais", () => {
  setupTestDb();
  const graph = new GraphMemory();
  graph.addTriple("Bob", "préfère", "TypeScript", { confidence: 0.5 });
  graph.addTriple("Bob", "préfère", "TypeScript", { confidence: 0.9 });

  assert.equal(graph.count(), 1);
  const [triple] = graph.all();
  assert.equal(triple.confidence, 0.9);
});

test("GraphMemory.searchByKeywords() extrait des mots-clés de la requête et combine les triplets reliés, dédupliqués", () => {
  setupTestDb();
  const graph = new GraphMemory();
  graph.addTriple("Marketing", "utilise", "HubSpot");
  graph.addTriple("Équipe commerciale", "collabore avec", "Marketing");
  graph.addTriple("Sans rapport", "concerne", "Autre chose");

  const results = graph.searchByKeywords("Comment fonctionne le marketing chez nous ?");
  assert.ok(results.some((t) => t.object === "HubSpot"));
  assert.ok(results.some((t) => t.subject === "Équipe commerciale"));
  assert.equal(results.some((t) => t.subject === "Sans rapport"), false);
});

test("GraphMemory respecte l'isolation par workspace quand demandée", () => {
  setupTestDb();
  const graph = new GraphMemory();
  graph.addTriple("ProjetA", "a pour client", "Acme", { workspaceId: "workspace-a" });
  graph.addTriple("ProjetB", "a pour client", "Globex", { workspaceId: "workspace-b" });

  const onlyA = graph.all("workspace-a");
  assert.equal(onlyA.length, 1);
  assert.equal(onlyA[0].subject, "ProjetA");
});

test("formatTriple() produit une ligne lisible pour injection dans le prompt", () => {
  const line = formatTriple({
    id: "1", subject: "Jarvis", predicate: "développé par", object: "artisanguillonrenov",
    confidence: 1, createdAt: 0, updatedAt: 0,
  });
  assert.equal(line, "Jarvis —développé par→ artisanguillonrenov");
});

test("GraphMemory.addTriple() rejette un triplet incomplet", () => {
  setupTestDb();
  const graph = new GraphMemory();
  assert.throws(() => graph.addTriple("", "predicate", "object"), /INVALID_TRIPLE/);
});
