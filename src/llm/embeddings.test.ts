import { test } from "node:test";
import assert from "node:assert/strict";
import { LocalHashingEmbeddingProvider, cosineSimilarity } from "./embeddings.js";

test("l'embedding local (hashing) est déterministe", async () => {
  const provider = new LocalHashingEmbeddingProvider();
  const a = await provider.embed("bonjour le monde");
  const b = await provider.embed("bonjour le monde");
  assert.deepEqual(a, b);
});

test("cosineSimilarity distingue des textes proches d'un texte hors-sujet", async () => {
  const provider = new LocalHashingEmbeddingProvider();
  const a = await provider.embed("le chat dort sur le canapé");
  const b = await provider.embed("le chat dort sur le tapis");
  const c = await provider.embed("la bourse chute fortement aujourd'hui");

  const simAB = cosineSimilarity(a, b);
  const simAC = cosineSimilarity(a, c);
  assert.ok(simAB > simAC, `attendu simAB (${simAB}) > simAC (${simAC})`);
});
