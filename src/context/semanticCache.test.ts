import test from "node:test";
import assert from "node:assert/strict";
import { closeDb } from "../persistence/db.js";
import { config } from "../config.js";
import { LocalHashingEmbeddingProvider } from "../llm/embeddings.js";
import { SemanticCache, sweepExpiredSemanticCache } from "./semanticCache.js";

function setup() {
  closeDb();
  config.db.path = ":memory:";
  return new SemanticCache(new LocalHashingEmbeddingProvider(), 0.95, 24 * 60 * 60 * 1000);
}

// Vague 6D : cache sémantique local.
test("une requête identique renvoie la réponse en cache sans nouvel appel", async () => {
  const cache = setup();
  assert.equal(await cache.lookup("reasoning", "model-a", "Quelle est la capitale de la France ?"), null);
  await cache.store("reasoning", "model-a", "Quelle est la capitale de la France ?", { content: "Paris", toolCalls: undefined });
  const hit = await cache.lookup("reasoning", "model-a", "Quelle est la capitale de la France ?");
  assert.ok(hit);
  assert.equal(hit?.response.content, "Paris");
  assert.ok(hit!.similarity >= 0.95);
});

test("le cache est partitionné par rôle et par modèle", async () => {
  const cache = setup();
  await cache.store("reasoning", "model-a", "bonjour", { content: "salut", toolCalls: undefined });
  assert.equal(await cache.lookup("fast", "model-a", "bonjour"), null, "un rôle différent ne doit jamais partager le cache");
  assert.equal(await cache.lookup("reasoning", "model-b", "bonjour"), null, "un modèle différent ne doit jamais partager le cache");
});

test("une requête sans rapport n'obtient jamais de hit", async () => {
  const cache = setup();
  await cache.store("reasoning", "model-a", "Quelle est la capitale de la France ?", { content: "Paris", toolCalls: undefined });
  assert.equal(await cache.lookup("reasoning", "model-a", "Recette de gâteau au chocolat"), null);
});

test("sweepExpiredSemanticCache purge uniquement les entrées expirées", async () => {
  const cache = setup();
  await cache.store("reasoning", "model-a", "requête ancienne", { content: "réponse", toolCalls: undefined });
  assert.equal(sweepExpiredSemanticCache(24 * 60 * 60 * 1000), 0, "rien d'expiré immédiatement après l'écriture");
  assert.equal(sweepExpiredSemanticCache(-1), 1, "un TTL négatif considère tout comme expiré");
  assert.equal(await cache.lookup("reasoning", "model-a", "requête ancienne"), null);
});
