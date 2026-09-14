import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { SkillCapabilityRegistry } from "./skillRegistry.js";
import { loadSkillManifest, CODING_SKILL_CATEGORIES, type SkillManifestEntry, type VerifyProofRefFn } from "./skillManifestLoader.js";
import { REAL_SKILL_CATALOG } from "./skillCatalog.js";
import { defineSkill } from "./skillManifest.js";

function entry(overrides: Partial<SkillManifestEntry> = {}): SkillManifestEntry {
  return {
    skillId: "ext.architecture_review",
    skillName: "Architecture Review",
    skillVersion: "0.1.0",
    description: "Revue d'architecture externe (manifeste).",
    category: "architecture",
    serviceScope: { type: "TRANSVERSAL" },
    capabilitiesProvided: ["architecture_review"],
    toolsRequired: [],
    dependencies: [],
    inputSchemaRef: "in",
    outputSchemaRef: "out",
    riskLevel: "LOW",
    permissionLevel: "READ",
    sideEffects: false,
    idempotent: true,
    asyncSupported: false,
    timeoutMs: 5000,
    testRefs: [],
    proofRefs: [],
    status: "NOT_TESTED",
    ...overrides,
  };
}

test("loadSkillManifest enregistre une entrée valide sans recoder le cœur", () => {
  const registry = new SkillCapabilityRegistry();
  const result = loadSkillManifest([entry()], registry);
  assert.equal(result.registered.length, 1);
  assert.equal(result.errors.length, 0);
  assert.equal(registry.getSkill("ext.architecture_review")?.skillId, "ext.architecture_review");
  assert.equal(result.categories["ext.architecture_review"], "architecture");
});

// --- C. même skill (transversal) utilisable par plusieurs services via manifeste ---
test("C — un skill externe TRANSVERSAL chargé par manifeste est utilisable par n'importe quel service", () => {
  const registry = new SkillCapabilityRegistry();
  loadSkillManifest([entry()], registry);
  assert.ok(registry.findSkillsForService("any_service_id").some((s) => s.skillId === "ext.architecture_review"));
});

test("loadSkillManifest rejette une category inconnue sans faire planter le chargement des autres entrées", () => {
  const registry = new SkillCapabilityRegistry();
  const result = loadSkillManifest([entry({ skillId: "ext.a" }), entry({ skillId: "ext.b", category: "not_a_real_category" as never }), entry({ skillId: "ext.c" })], registry);
  assert.equal(result.registered.length, 2);
  assert.equal(result.errors.length, 1);
  assert.equal(result.errors[0]!.skillId, "ext.b");
  assert.equal(registry.listSkills().length, 2);
});

// --- Audit ChatGPT #90 point 1 : jamais d'auto-attestation AVAILABLE pour un manifeste externe. ---

// --- A. proofRef syntaxiquement valide mais NON vérifié par la source de confiance → pas AVAILABLE ---
test("A — un manifeste externe AVAILABLE avec un proofRef syntaxiquement valide mais non confirmé par verifyProofRef est dégradé en NOT_TESTED", () => {
  const registry = new SkillCapabilityRegistry();
  const alwaysRejects: VerifyProofRefFn = () => false;
  const result = loadSkillManifest([entry({ status: "AVAILABLE", proofRefs: ["TEST:pretend.test.ts#case"] })], registry, { verifyProofRef: alwaysRejects });
  assert.equal(result.registered.length, 1);
  assert.equal(result.registered[0]!.status, "NOT_TESTED");
  assert.equal(registry.getSkill("ext.architecture_review")?.status, "NOT_TESTED");
  assert.equal(result.downgrades.length, 1);
  assert.equal(result.downgrades[0]!.requestedStatus, "AVAILABLE");
  assert.equal(result.downgrades[0]!.appliedStatus, "NOT_TESTED");
});

// --- B. AVAILABLE sans verifier fourni du tout → refus/downgrade ---
test("B — un manifeste externe AVAILABLE sans aucun verifyProofRef fourni est dégradé en NOT_TESTED (jamais une auto-attestation acceptée par défaut)", () => {
  const registry = new SkillCapabilityRegistry();
  const result = loadSkillManifest([entry({ status: "AVAILABLE", proofRefs: ["TEST:nimportequoi"] })], registry);
  assert.equal(result.errors.length, 0);
  assert.equal(result.registered.length, 1);
  assert.equal(result.registered[0]!.status, "NOT_TESTED");
  assert.match(result.downgrades[0]!.reason, /aucun verifyProofRef fourni/);
});

// --- C. preuve validée par un verifier de confiance → AVAILABLE accepté ---
test("C — un manifeste externe AVAILABLE dont au moins une proofRef est confirmée par verifyProofRef reste AVAILABLE", () => {
  const registry = new SkillCapabilityRegistry();
  const trustedRefs = new Set(["TEST:really.verified.ts#case"]);
  const verifier: VerifyProofRefFn = (ref) => trustedRefs.has(ref);
  const result = loadSkillManifest([entry({ status: "AVAILABLE", proofRefs: ["TEST:not.verified.ts", "TEST:really.verified.ts#case"] })], registry, { verifyProofRef: verifier });
  assert.equal(result.registered.length, 1);
  assert.equal(result.registered[0]!.status, "AVAILABLE");
  assert.equal(result.downgrades.length, 0);
});

// --- D. NOT_TESTED externe reste chargeable normalement, avec ou sans verifier ---
test("D — un manifeste externe NOT_TESTED se charge normalement, avec ou sans verifyProofRef", () => {
  for (const options of [{}, { verifyProofRef: (() => false) as VerifyProofRefFn }]) {
    const registry = new SkillCapabilityRegistry();
    const result = loadSkillManifest([entry({ status: "NOT_TESTED" })], registry, options);
    assert.equal(result.registered.length, 1);
    assert.equal(result.registered[0]!.status, "NOT_TESTED");
    assert.equal(result.downgrades.length, 0);
  }
});

// --- E. aucune régression sur le catalogue interne audité (ne passe jamais par ce chargeur) ---
test("E — REAL_SKILL_CATALOG (catalogue interne audité) n'est pas affecté par la règle de vérification externe", () => {
  const availableEntries = REAL_SKILL_CATALOG.filter((s) => s.status === "AVAILABLE");
  assert.ok(availableEntries.length > 0);
  for (const skill of availableEntries) {
    // defineSkill() direct (comme skillCatalog.ts), jamais loadSkillManifest() : aucune dégradation possible ici.
    assert.doesNotThrow(() => defineSkill(skill));
  }
});

test("CODING_SKILL_CATEGORIES couvre toutes les catégories attendues (§PHASE 13)", () => {
  for (const expected of ["architecture", "planning", "debugging", "testing", "security_review", "code_review", "api_design", "database_design", "devops", "ai_ml", "prompt_engineering", "agent_engineering"]) {
    assert.ok(CODING_SKILL_CATEGORIES.includes(expected as never), expected);
  }
});

// --- O/P. Aucune méthode d'écriture/fusion GitHub dans ce module ---
test("O/P — aucune méthode d'écriture/fusion GitHub dans skillManifestLoader.ts", () => {
  const path = fileURLToPath(new URL("./skillManifestLoader.ts", import.meta.url));
  const source = readFileSync(path, "utf-8");
  assert.doesNotMatch(source, /octokit|\.merge\(|createOrUpdateFileContents|createRef\(/i);
});
