import test from "node:test";
import assert from "node:assert/strict";
import { defineProof, ProofRecordInvalidError, toProofRef, parseProofRef, isValidProofRef, hasValidProof } from "./proof.js";

test("defineProof construit une preuve valide et rejette une source/ref invalide", () => {
  const proof = defineProof({ source: "TEST", ref: "some.test.ts#case" });
  assert.equal(proof.source, "TEST");
  assert.ok(proof.recordedAt > 0);
  assert.throws(() => defineProof({ source: "TEST", ref: "" }), ProofRecordInvalidError);
  assert.throws(() => defineProof({ source: "NOT_A_SOURCE" as never, ref: "x" }), ProofRecordInvalidError);
});

test("toProofRef/parseProofRef font un aller-retour fidèle (source + ref)", () => {
  const proof = defineProof({ source: "PROBE", ref: "probe.read_repository" });
  const ref = toProofRef(proof);
  assert.equal(ref, "PROBE:probe.read_repository");
  const parsed = parseProofRef(ref);
  assert.deepEqual(parsed, { source: "PROBE", ref: "probe.read_repository" });
});

test("parseProofRef renvoie null pour un format invalide (jamais une exception)", () => {
  assert.equal(parseProofRef(""), null);
  assert.equal(parseProofRef("NOT_A_SOURCE:x"), null);
  assert.equal(parseProofRef("TEST:"), null);
  assert.equal(parseProofRef("no-separator"), null);
});

test("isValidProofRef / hasValidProof — 'le fichier existe' seul n'est jamais une preuve recevable sans le format SOURCE:ref", () => {
  assert.equal(isValidProofRef(undefined), false);
  assert.equal(isValidProofRef("juste du texte"), false);
  assert.equal(isValidProofRef("TEST:x"), true);
  assert.equal(hasValidProof([]), false);
  assert.equal(hasValidProof(["juste du texte"]), false);
  assert.equal(hasValidProof(["juste du texte", "CI:run-123"]), true);
});
