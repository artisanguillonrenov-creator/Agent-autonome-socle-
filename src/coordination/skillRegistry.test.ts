import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { defineSkill, type SkillDescriptorInput } from "./skillManifest.js";
import { SkillCapabilityRegistry, DuplicateSkillError, SkillNotFoundError } from "./skillRegistry.js";

function skill(overrides: Partial<SkillDescriptorInput> = {}) {
  return defineSkill({
    skillId: "skill.a",
    skillName: "Skill A",
    skillVersion: "1.0.0",
    description: "desc",
    serviceScope: { type: "TRANSVERSAL" },
    capabilitiesProvided: ["cap_x"],
    toolsRequired: [],
    dependencies: [],
    inputSchemaRef: "in",
    outputSchemaRef: "out",
    riskLevel: "LOW",
    permissionLevel: "READ",
    sideEffects: false,
    idempotent: true,
    asyncSupported: false,
    timeoutMs: 1000,
    testRefs: [],
    proofRefs: [],
    status: "NOT_TESTED",
    ...overrides,
  });
}

// --- A. skill valide enregistré ---
test("A — register_skill puis get_skill/list_skills retrouvent le skill enregistré", () => {
  const registry = new SkillCapabilityRegistry();
  registry.registerSkill(skill());
  assert.equal(registry.getSkill("skill.a")?.skillId, "skill.a");
  assert.equal(registry.listSkills().length, 1);
});

// --- B. doublon exact détecté ---
test("B — register_skill rejette un skillId déjà enregistré (doublon exact)", () => {
  const registry = new SkillCapabilityRegistry();
  registry.registerSkill(skill());
  assert.throws(() => registry.registerSkill(skill()), DuplicateSkillError);
});

test("B — detectSkillDuplicates détecte deux skills distincts couvrant exactement les mêmes capacités", () => {
  const registry = new SkillCapabilityRegistry();
  registry.registerSkill(skill({ skillId: "skill.a" }));
  registry.registerSkill(skill({ skillId: "skill.b" }));
  const groups = registry.detectSkillDuplicates();
  assert.equal(groups.length, 1);
  assert.deepEqual(groups[0]!.skillIds.sort(), ["skill.a", "skill.b"]);
  assert.equal(groups[0]!.verdict, "UNKNOWN", "jamais MERGE/REMOVE_LATER automatique sans preuve d'usage");
});

test("B — pas de doublon si les capacités fournies diffèrent", () => {
  const registry = new SkillCapabilityRegistry();
  registry.registerSkill(skill({ skillId: "skill.a", capabilitiesProvided: ["cap_x"] }));
  registry.registerSkill(skill({ skillId: "skill.b", capabilitiesProvided: ["cap_y"] }));
  assert.equal(registry.detectSkillDuplicates().length, 0);
});

// --- C. même skill utilisé par plusieurs services ---
test("C — findSkillsForService retrouve un skill TRANSVERSAL pour n'importe quel service, et un MULTI_SERVICE pour les services listés", () => {
  const registry = new SkillCapabilityRegistry();
  registry.registerSkill(skill({ skillId: "skill.transversal", serviceScope: { type: "TRANSVERSAL" } }));
  registry.registerSkill(skill({ skillId: "skill.multi", capabilitiesProvided: ["cap_y"], serviceScope: { type: "MULTI_SERVICE", serviceIds: ["svc_a", "svc_b"] } }));
  assert.ok(registry.findSkillsForService("svc_a").some((s) => s.skillId === "skill.transversal"));
  assert.ok(registry.findSkillsForService("svc_a").some((s) => s.skillId === "skill.multi"));
  assert.ok(registry.findSkillsForService("svc_c").some((s) => s.skillId === "skill.transversal"));
  assert.ok(!registry.findSkillsForService("svc_c").some((s) => s.skillId === "skill.multi"));
});

// --- D. capability -> skill correctement résolue (au niveau du registre) ---
test("D — findSkillsForCapability retrouve tous les skills fournissant une capacité", () => {
  const registry = new SkillCapabilityRegistry();
  registry.registerSkill(skill({ skillId: "skill.a", capabilitiesProvided: ["cap_x"] }));
  registry.registerSkill(skill({ skillId: "skill.b", capabilitiesProvided: ["cap_x", "cap_y"] }));
  assert.deepEqual(registry.findSkillsForCapability("cap_x").map((s) => s.skillId).sort(), ["skill.a", "skill.b"]);
  assert.deepEqual(registry.findSkillsForCapability("cap_y").map((s) => s.skillId), ["skill.b"]);
});

// --- F. dépendance manquante ---
test("F — getSkillDependencies rapporte les dépendances non enregistrées", () => {
  const registry = new SkillCapabilityRegistry();
  registry.registerSkill(skill({ skillId: "skill.a", dependencies: ["skill.ghost"] }));
  const deps = registry.getSkillDependencies("skill.a");
  assert.deepEqual(deps.missing, ["skill.ghost"]);
  assert.deepEqual(deps.resolved, []);
});

test("getSkillDependencies/getSkillStatus/getSkillProof lèvent SkillNotFoundError pour un skill inconnu", () => {
  const registry = new SkillCapabilityRegistry();
  assert.throws(() => registry.getSkillDependencies("nope"), SkillNotFoundError);
  assert.throws(() => registry.getSkillStatus("nope"), SkillNotFoundError);
  assert.throws(() => registry.getSkillProof("nope"), SkillNotFoundError);
});

// --- get_skill_proof ---
test("getSkillProof structure les proofRefs valides et conserve les chaînes brutes", () => {
  const registry = new SkillCapabilityRegistry();
  registry.registerSkill(skill({ skillId: "skill.a", status: "AVAILABLE", proofRefs: ["TEST:some.test.ts#case", "PROBE:probe.x"] }));
  const proof = registry.getSkillProof("skill.a");
  assert.equal(proof.records.length, 2);
  assert.equal(proof.records[0]!.source, "TEST");
  assert.deepEqual(proof.raw, ["TEST:some.test.ts#case", "PROBE:probe.x"]);
});

// --- J. service ne possède pas capacité -> MISSING ---
test("J — detectMissingCapabilities signale les capacités qu'aucun skill enregistré ne fournit", () => {
  const registry = new SkillCapabilityRegistry();
  registry.registerSkill(skill({ skillId: "skill.a", capabilitiesProvided: ["cap_x"] }));
  assert.deepEqual(registry.detectMissingCapabilities(["cap_x", "cap_never_registered"]), ["cap_never_registered"]);
});

// --- O/P. Aucune méthode d'écriture/fusion GitHub dans ce module ---
test("O/P — aucune méthode d'écriture/fusion GitHub dans skillRegistry.ts", () => {
  const path = fileURLToPath(new URL("./skillRegistry.ts", import.meta.url));
  const source = readFileSync(path, "utf-8");
  assert.doesNotMatch(source, /octokit|\.merge\(|createOrUpdateFileContents|createRef\(/i);
});
