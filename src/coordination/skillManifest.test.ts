import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { defineSkill, SkillDescriptorInvalidError, SkillNotProvenError, SKILL_STATUSES, type SkillDescriptorInput } from "./skillManifest.js";
import { assertSupportedContractVersion, JARVIS00_CONTRACTS_SCHEMA_VERSION, ContractVersionError } from "./contracts.js";
import { CAPABILITY_STATUSES } from "./capabilityManifest.js";

function validInput(overrides: Partial<SkillDescriptorInput> = {}): SkillDescriptorInput {
  return {
    skillId: "test.skill",
    skillName: "Test Skill",
    skillVersion: "1.0.0",
    description: "Un skill de test.",
    serviceScope: { type: "TRANSVERSAL" },
    capabilitiesProvided: ["test_capability"],
    toolsRequired: [],
    dependencies: [],
    inputSchemaRef: "schemas/test.input.json",
    outputSchemaRef: "schemas/test.output.json",
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

// --- A. skill valide enregistré (construction) ---
test("A — defineSkill construit un descripteur valide", () => {
  const skill = defineSkill(validInput());
  assert.equal(skill.skillId, "test.skill");
  assert.equal(skill.status, "NOT_TESTED");
  assert.equal(skill.schemaVersion, JARVIS00_CONTRACTS_SCHEMA_VERSION);
});

// --- E. skill AVAILABLE sans proof rejeté ---
test("E — defineSkill refuse AVAILABLE sans proofRefs valide", () => {
  assert.throws(() => defineSkill(validInput({ status: "AVAILABLE" })), SkillNotProvenError);
  assert.throws(() => defineSkill(validInput({ status: "AVAILABLE", proofRefs: ["ceci n'est pas un format valide"] })), SkillNotProvenError);
});

test("E — defineSkill accepte AVAILABLE avec au moins une preuve valide dans proofRefs", () => {
  const skill = defineSkill(validInput({ status: "AVAILABLE", proofRefs: ["TEST:some.test.ts#case"] }));
  assert.equal(skill.status, "AVAILABLE");
  assert.equal(skill.proofRefs.length, 1);
});

// --- G/H. AUTH_REQUIRED / BROKEN ne requièrent jamais de preuve ---
test("G/H — les statuts non-AVAILABLE (AUTH_REQUIRED, BROKEN, ...) ne requièrent jamais de preuve", () => {
  for (const status of SKILL_STATUSES) {
    if (status === "AVAILABLE") continue;
    assert.doesNotThrow(() => defineSkill(validInput({ status })), `status=${status} ne doit pas exiger de preuve`);
  }
});

// --- Réutilise les statuts PR-E (§PHASE 8) — aucun second enum ---
test("SKILL_STATUSES réutilise exactement CAPABILITY_STATUSES (aucun second enum de statut)", () => {
  assert.deepEqual([...SKILL_STATUSES].sort(), [...CAPABILITY_STATUSES].sort());
});

// --- C. service_scope : SINGLE_SERVICE / MULTI_SERVICE / TRANSVERSAL ---
test("C — serviceScope MULTI_SERVICE valide (même skill utilisé par plusieurs services)", () => {
  const skill = defineSkill(validInput({ serviceScope: { type: "MULTI_SERVICE", serviceIds: ["service_a", "service_b"] } }));
  assert.equal(skill.serviceScope.type, "MULTI_SERVICE");
});

test("serviceScope invalide rejeté", () => {
  assert.throws(() => defineSkill(validInput({ serviceScope: { type: "SINGLE_SERVICE", serviceId: "" } })), SkillDescriptorInvalidError);
  assert.throws(() => defineSkill(validInput({ serviceScope: { type: "MULTI_SERVICE", serviceIds: ["only_one"] } })), SkillDescriptorInvalidError);
  assert.throws(() => defineSkill(validInput({ serviceScope: undefined as never })), SkillDescriptorInvalidError);
});

// --- Champs obligatoires ---
test("defineSkill rejette les champs obligatoires manquants ou invalides", () => {
  const base = validInput();
  assert.throws(() => defineSkill({ ...base, skillId: "" }), SkillDescriptorInvalidError);
  assert.throws(() => defineSkill({ ...base, skillName: "" }), SkillDescriptorInvalidError);
  assert.throws(() => defineSkill({ ...base, skillVersion: "" }), SkillDescriptorInvalidError);
  assert.throws(() => defineSkill({ ...base, description: "" }), SkillDescriptorInvalidError);
  assert.throws(() => defineSkill({ ...base, inputSchemaRef: "" }), SkillDescriptorInvalidError);
  assert.throws(() => defineSkill({ ...base, outputSchemaRef: "" }), SkillDescriptorInvalidError);
  assert.throws(() => defineSkill({ ...base, timeoutMs: 0 }), SkillDescriptorInvalidError);
  assert.throws(() => defineSkill({ ...base, status: "UNKNOWN" as never }), SkillDescriptorInvalidError);
  assert.throws(() => defineSkill({ ...base, capabilitiesProvided: undefined as unknown as string[] }), SkillDescriptorInvalidError);
  assert.throws(() => defineSkill({ ...base, dependencies: [base.skillId] }), SkillDescriptorInvalidError, "un skill ne peut pas dépendre de lui-même");
  assert.throws(() => defineSkill({ ...base, fallbackSkillId: base.skillId }), SkillDescriptorInvalidError, "fallback ne peut pas référencer le skill lui-même");
  assert.throws(() => defineSkill({ ...base, remediationType: "NOT_A_REAL_TYPE" as never }), SkillDescriptorInvalidError);
});

// --- L. Sérialisation / désérialisation ---
test("L — SkillDescriptor survit à un aller-retour JSON", () => {
  const skill = defineSkill(validInput({ status: "AVAILABLE", proofRefs: ["TEST:x"] }));
  assert.deepEqual(JSON.parse(JSON.stringify(skill)), skill);
});

// --- M. Version de schéma incompatible rejetée (réutilise contracts.ts, aucune seconde logique) ---
test("M — un schemaVersion incompatible est rejeté par assertSupportedContractVersion (réutilisé, pas réinventé)", () => {
  const skill = defineSkill(validInput());
  assert.doesNotThrow(() => assertSupportedContractVersion(skill.schemaVersion));
  assert.throws(() => assertSupportedContractVersion(skill.schemaVersion + 999), ContractVersionError);
});

// --- O/P. Aucune méthode d'écriture/fusion GitHub dans ce module (vérification statique) ---
test("O/P — aucune méthode d'écriture/fusion GitHub dans skillManifest.ts", () => {
  const path = fileURLToPath(new URL("./skillManifest.ts", import.meta.url));
  const source = readFileSync(path, "utf-8");
  assert.doesNotMatch(source, /octokit|\.merge\(|createOrUpdateFileContents|createRef\(/i);
});
