import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { SkillCapabilityRegistry } from "./skillRegistry.js";
import { loadSkillManifest, CODING_SKILL_CATEGORIES, type SkillManifestEntry } from "./skillManifestLoader.js";

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

test("loadSkillManifest applique toujours les règles de skillManifest.ts (ex. jamais AVAILABLE sans preuve)", () => {
  const registry = new SkillCapabilityRegistry();
  const result = loadSkillManifest([entry({ status: "AVAILABLE" })], registry);
  assert.equal(result.registered.length, 0);
  assert.equal(result.errors.length, 1);
  assert.match(result.errors[0]!.message, /SKILL_NOT_PROVEN/);
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
