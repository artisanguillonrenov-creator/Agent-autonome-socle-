import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { defineSkill, type SkillDescriptorInput } from "./skillManifest.js";
import { SkillCapabilityRegistry } from "./skillRegistry.js";
import { resolveCapability } from "./skillResolver.js";

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
    proofRefs: ["TEST:x"],
    status: "AVAILABLE",
    ...overrides,
  });
}

// --- D. capability -> skill correctement résolue ---
test("D — resolveCapability sélectionne l'unique skill AVAILABLE+prouvé fournissant la capacité", () => {
  const registry = new SkillCapabilityRegistry();
  registry.registerSkill(skill());
  const result = resolveCapability(registry, "cap_x");
  assert.equal(result.resolved, true);
  assert.equal(result.selectedSkillId, "skill.a");
});

test("resolveCapability renvoie non résolu si aucun skill ne fournit la capacité", () => {
  const registry = new SkillCapabilityRegistry();
  const result = resolveCapability(registry, "cap_never_registered");
  assert.equal(result.resolved, false);
  assert.deepEqual(result.attempts, []);
});

// --- E. skill AVAILABLE sans preuve rejeté (défense en profondeur au moment de la résolution) ---
test("E — resolveCapability rejette un skill AVAILABLE dont la preuve a été altérée après coup (jamais de confiance aveugle dans `status`)", () => {
  const registry = new SkillCapabilityRegistry();
  const tampered = { ...skill(), proofRefs: [] };
  registry.registerSkill(tampered);
  const result = resolveCapability(registry, "cap_x");
  assert.equal(result.resolved, false);
  assert.equal(result.attempts[0]!.rejectionCode, "PROOF_MISSING");
});

// --- F. dépendance manquante -> DEPENDENCY_MISSING ---
test("F — resolveCapability rejette un skill dont une dépendance n'est pas enregistrée", () => {
  const registry = new SkillCapabilityRegistry();
  registry.registerSkill(skill({ dependencies: ["skill.ghost"] }));
  const result = resolveCapability(registry, "cap_x");
  assert.equal(result.resolved, false);
  assert.equal(result.attempts[0]!.rejectionCode, "DEPENDENCY_MISSING");
});

test("F — resolveCapability rejette un skill dont la dépendance existe mais n'est pas AVAILABLE", () => {
  const registry = new SkillCapabilityRegistry();
  registry.registerSkill(skill({ skillId: "skill.dep", capabilitiesProvided: ["cap_dep"], status: "NOT_TESTED", proofRefs: [] }));
  registry.registerSkill(skill({ skillId: "skill.a", dependencies: ["skill.dep"] }));
  const result = resolveCapability(registry, "cap_x");
  assert.equal(result.resolved, false);
  assert.equal(result.attempts[0]!.rejectionCode, "DEPENDENCY_MISSING");
});

test("F — resolveCapability accepte un skill dont la dépendance est AVAILABLE+prouvée", () => {
  const registry = new SkillCapabilityRegistry();
  registry.registerSkill(skill({ skillId: "skill.dep", capabilitiesProvided: ["cap_dep"] }));
  registry.registerSkill(skill({ skillId: "skill.a", dependencies: ["skill.dep"] }));
  const result = resolveCapability(registry, "cap_x");
  assert.equal(result.resolved, true);
  assert.equal(result.selectedSkillId, "skill.a");
});

// --- G/H. AUTH_REQUIRED / BROKEN jamais sélectionnés ---
test("G — resolveCapability rejette un skill AUTH_REQUIRED (jamais sélectionné faute d'authentification réelle)", () => {
  const registry = new SkillCapabilityRegistry();
  registry.registerSkill(skill({ status: "AUTH_REQUIRED", proofRefs: [] }));
  const result = resolveCapability(registry, "cap_x");
  assert.equal(result.resolved, false);
  assert.equal(result.attempts[0]!.rejectionCode, "STATUS_NOT_AVAILABLE");
});

test("H — resolveCapability rejette un skill BROKEN", () => {
  const registry = new SkillCapabilityRegistry();
  registry.registerSkill(skill({ status: "BROKEN", proofRefs: [] }));
  const result = resolveCapability(registry, "cap_x");
  assert.equal(result.resolved, false);
  assert.equal(result.attempts[0]!.rejectionCode, "STATUS_NOT_AVAILABLE");
});

// --- I. fallback sélectionné correctement ---
test("I — resolveCapability suit fallbackSkillId quand le candidat principal échoue", () => {
  const registry = new SkillCapabilityRegistry();
  registry.registerSkill(skill({ skillId: "skill.primary", status: "BROKEN", proofRefs: [], fallbackSkillId: "skill.fallback" }));
  registry.registerSkill(skill({ skillId: "skill.fallback", capabilitiesProvided: ["cap_other"] }));
  const result = resolveCapability(registry, "cap_x");
  assert.equal(result.resolved, true);
  assert.equal(result.selectedSkillId, "skill.fallback");
  assert.equal(result.attempts.length, 2);
});

// --- K. side_effects exige permission appropriée ---
test("K — resolveCapability rejette un skill à side_effects si la permission requise n'est pas accordée", () => {
  const registry = new SkillCapabilityRegistry();
  registry.registerSkill(skill({ sideEffects: true, permissionLevel: "WRITE", riskLevel: "MEDIUM" }));
  const result = resolveCapability(registry, "cap_x", { isPermissionGranted: (p) => p === "READ" });
  assert.equal(result.resolved, false);
  assert.equal(result.attempts[0]!.rejectionCode, "PERMISSION_DENIED");
});

test("K — resolveCapability accepte un skill à side_effects si la permission requise est accordée", () => {
  const registry = new SkillCapabilityRegistry();
  registry.registerSkill(skill({ sideEffects: true, permissionLevel: "WRITE", riskLevel: "MEDIUM" }));
  const result = resolveCapability(registry, "cap_x", { isPermissionGranted: (p) => p === "WRITE" });
  assert.equal(result.resolved, true);
});

test("resolveCapability rejette un skill hors de portée du service demandé (SCOPE_MISMATCH)", () => {
  const registry = new SkillCapabilityRegistry();
  registry.registerSkill(skill({ serviceScope: { type: "SINGLE_SERVICE", serviceId: "svc_a" } }));
  const result = resolveCapability(registry, "cap_x", { serviceId: "svc_b" });
  assert.equal(result.resolved, false);
  assert.equal(result.attempts[0]!.rejectionCode, "SCOPE_MISMATCH");
});

test("resolveCapability rejette un skill si un outil requis est indisponible (TOOLS_UNAVAILABLE)", () => {
  const registry = new SkillCapabilityRegistry();
  registry.registerSkill(skill({ toolsRequired: ["tool.x"] }));
  const result = resolveCapability(registry, "cap_x", { areToolsAvailable: () => false });
  assert.equal(result.resolved, false);
  assert.equal(result.attempts[0]!.rejectionCode, "TOOLS_UNAVAILABLE");
});

// --- O/P. Aucune méthode d'écriture/fusion GitHub dans ce module ---
test("O/P — aucune méthode d'écriture/fusion GitHub dans skillResolver.ts", () => {
  const path = fileURLToPath(new URL("./skillResolver.ts", import.meta.url));
  const source = readFileSync(path, "utf-8");
  assert.doesNotMatch(source, /octokit|\.merge\(|createOrUpdateFileContents|createRef\(/i);
});
