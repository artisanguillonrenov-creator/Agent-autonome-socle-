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

test("resolveCapability rejette un skill hors de portée du service demandé (SCOPE_MISMATCH)", () => {
  const registry = new SkillCapabilityRegistry();
  registry.registerSkill(skill({ serviceScope: { type: "SINGLE_SERVICE", serviceId: "svc_a" } }));
  const result = resolveCapability(registry, "cap_x", { serviceId: "svc_b" });
  assert.equal(result.resolved, false);
  assert.equal(result.attempts[0]!.rejectionCode, "SCOPE_MISMATCH");
});

// ==================================================
// Audit ChatGPT #90, point 2 — FAIL-CLOSED (mode EXECUTION par défaut)
// ==================================================

// --- F. sideEffects + aucun permission checker fourni → non résolu (jamais une autorisation implicite) ---
test("F — resolveCapability (mode EXECUTION implicite) rejette un skill à sideEffects=true si aucun isPermissionGranted n'est fourni du tout", () => {
  const registry = new SkillCapabilityRegistry();
  registry.registerSkill(skill({ sideEffects: true, permissionLevel: "WRITE", riskLevel: "MEDIUM" }));
  const result = resolveCapability(registry, "cap_x");
  assert.equal(result.resolved, false);
  assert.equal(result.attempts[0]!.rejectionCode, "PERMISSION_CHECK_MISSING");
});

// --- G. permission refusée → PERMISSION_DENIED ---
test("G — resolveCapability rejette un skill à sideEffects=true si la permission requise n'est pas accordée", () => {
  const registry = new SkillCapabilityRegistry();
  registry.registerSkill(skill({ sideEffects: true, permissionLevel: "WRITE", riskLevel: "MEDIUM" }));
  const result = resolveCapability(registry, "cap_x", { isPermissionGranted: (p) => p === "READ" });
  assert.equal(result.resolved, false);
  assert.equal(result.attempts[0]!.rejectionCode, "PERMISSION_DENIED");
});

// --- H. permission accordée → accepté ---
test("H — resolveCapability accepte un skill à sideEffects=true si la permission requise est accordée", () => {
  const registry = new SkillCapabilityRegistry();
  registry.registerSkill(skill({ sideEffects: true, permissionLevel: "WRITE", riskLevel: "MEDIUM" }));
  const result = resolveCapability(registry, "cap_x", { isPermissionGranted: (p) => p === "WRITE" });
  assert.equal(result.resolved, true);
});

// --- I. toolsRequired non vide + aucun checker en mode EXECUTION → non résolu ---
test("I — resolveCapability (mode EXECUTION implicite) rejette un skill avec toolsRequired si aucun areToolsAvailable n'est fourni du tout", () => {
  const registry = new SkillCapabilityRegistry();
  registry.registerSkill(skill({ toolsRequired: ["tool.x"] }));
  const result = resolveCapability(registry, "cap_x");
  assert.equal(result.resolved, false);
  assert.equal(result.attempts[0]!.rejectionCode, "TOOLS_CHECK_MISSING");
});

// --- J. outils indisponibles → TOOLS_UNAVAILABLE ---
test("J — resolveCapability rejette un skill si un outil requis est indisponible (checker fourni, répond false)", () => {
  const registry = new SkillCapabilityRegistry();
  registry.registerSkill(skill({ toolsRequired: ["tool.x"] }));
  const result = resolveCapability(registry, "cap_x", { areToolsAvailable: () => false });
  assert.equal(result.resolved, false);
  assert.equal(result.attempts[0]!.rejectionCode, "TOOLS_UNAVAILABLE");
});

// --- K. outils disponibles → accepté ---
test("K — resolveCapability accepte un skill si les outils requis sont disponibles (checker fourni, répond true)", () => {
  const registry = new SkillCapabilityRegistry();
  registry.registerSkill(skill({ toolsRequired: ["tool.x"] }));
  const result = resolveCapability(registry, "cap_x", { areToolsAvailable: () => true });
  assert.equal(result.resolved, true);
});

// --- L. un skill de lecture sans effet de bord reste résoluble sans exiger de checkers ---
test("L — un skill sideEffects=false et toolsRequired=[] reste résoluble en mode EXECUTION sans aucun checker fourni", () => {
  const registry = new SkillCapabilityRegistry();
  registry.registerSkill(skill({ sideEffects: false, toolsRequired: [] }));
  const result = resolveCapability(registry, "cap_x");
  assert.equal(result.resolved, true);
});

test("L bis — un skill sans effet de bord respecte quand même un isPermissionGranted fourni volontairement", () => {
  const registry = new SkillCapabilityRegistry();
  registry.registerSkill(skill({ sideEffects: false, permissionLevel: "READ" }));
  const result = resolveCapability(registry, "cap_x", { isPermissionGranted: () => false });
  assert.equal(result.resolved, false);
  assert.equal(result.attempts[0]!.rejectionCode, "PERMISSION_DENIED");
});

// --- M. le fallback respecte exactement les mêmes règles fail-closed ---
test("M — resolveCapability applique le fail-closed identiquement au candidat de fallback", () => {
  const registry = new SkillCapabilityRegistry();
  registry.registerSkill(skill({ skillId: "skill.primary", status: "BROKEN", proofRefs: [], fallbackSkillId: "skill.fallback" }));
  registry.registerSkill(skill({ skillId: "skill.fallback", capabilitiesProvided: ["cap_other"], sideEffects: true, permissionLevel: "WRITE" }));
  const result = resolveCapability(registry, "cap_x"); // aucun isPermissionGranted fourni
  assert.equal(result.resolved, false);
  assert.equal(result.attempts.length, 2);
  assert.equal(result.attempts[1]!.rejectionCode, "PERMISSION_CHECK_MISSING");
});

// --- Mode ANALYSIS : bypass explicite, jamais implicite ---
test("mode ANALYSIS ignore les contrôles permission/outils (résolution théorique), mais statut/preuve/dépendances restent vérifiés", () => {
  const registry = new SkillCapabilityRegistry();
  registry.registerSkill(skill({ sideEffects: true, permissionLevel: "WRITE", toolsRequired: ["tool.x"] }));
  const result = resolveCapability(registry, "cap_x", { mode: "ANALYSIS" });
  assert.equal(result.resolved, true);
});

test("mode ANALYSIS n'exempte jamais le statut/la preuve/les dépendances", () => {
  const registry = new SkillCapabilityRegistry();
  registry.registerSkill(skill({ status: "BROKEN", proofRefs: [] }));
  const result = resolveCapability(registry, "cap_x", { mode: "ANALYSIS" });
  assert.equal(result.resolved, false);
  assert.equal(result.attempts[0]!.rejectionCode, "STATUS_NOT_AVAILABLE");
});

test("le mode EXECUTION est le défaut implicite (fail-closed) — jamais ANALYSIS sans le demander explicitement", () => {
  const registry = new SkillCapabilityRegistry();
  registry.registerSkill(skill({ sideEffects: true, permissionLevel: "WRITE" }));
  const withoutMode = resolveCapability(registry, "cap_x");
  const withExplicitExecution = resolveCapability(registry, "cap_x", { mode: "EXECUTION" });
  assert.equal(withoutMode.resolved, false);
  assert.deepEqual(withoutMode, withExplicitExecution);
});

// --- O/P. Aucune méthode d'écriture/fusion GitHub dans ce module ---
test("O/P — aucune méthode d'écriture/fusion GitHub dans skillResolver.ts", () => {
  const path = fileURLToPath(new URL("./skillResolver.ts", import.meta.url));
  const source = readFileSync(path, "utf-8");
  assert.doesNotMatch(source, /octokit|\.merge\(|createOrUpdateFileContents|createRef\(/i);
});
