import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { defineSkill, type SkillDescriptorInput } from "./skillManifest.js";
import { SkillCapabilityRegistry } from "./skillRegistry.js";
import { buildServiceCapabilityMatrix, buildGapAnalysisReport, createPopulatedRegistry, SOFTWARE_FACTORY_CAPABILITY_AUDIT, suggestRemediation, type ServiceCapabilitySource } from "./gapAnalysis.js";
import { defineCapability } from "./capabilityManifest.js";
import { REAL_SKILL_CATALOG } from "./skillCatalog.js";

function skill(overrides: Partial<SkillDescriptorInput> = {}) {
  return defineSkill({
    skillId: "skill.a",
    skillName: "Skill A",
    skillVersion: "1.0.0",
    description: "desc",
    serviceScope: { type: "SINGLE_SERVICE", serviceId: "svc_a" },
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

// --- J. service ne possède pas la capacité -> MISSING dans la matrice ---
test("J — buildServiceCapabilityMatrix marque MISSING une capacité déclarée par un service sans skill qui la couvre", () => {
  const registry = new SkillCapabilityRegistry();
  const services: ServiceCapabilitySource[] = [{ id: "svc_a", capabilities: ["cap_x", "cap_never_covered"] }];
  registry.registerSkill(skill());
  const matrix = buildServiceCapabilityMatrix(registry, services);
  const covered = matrix.find((r) => r.capability === "cap_x");
  const missing = matrix.find((r) => r.capability === "cap_never_covered");
  assert.equal(covered?.status, "AVAILABLE");
  assert.equal(covered?.gap, "EXISTING_SKILL");
  assert.equal(missing?.status, "MISSING");
  assert.equal(missing?.gap, "MISSING");
  assert.equal(missing?.recommendedAction, "CREATE_SKILL");
});

test("buildServiceCapabilityMatrix ignore un skill dont la portée ne couvre pas le service demandé", () => {
  const registry = new SkillCapabilityRegistry();
  registry.registerSkill(skill({ serviceScope: { type: "SINGLE_SERVICE", serviceId: "svc_other" } }));
  const services: ServiceCapabilitySource[] = [{ id: "svc_a", capabilities: ["cap_x"] }];
  const matrix = buildServiceCapabilityMatrix(registry, services);
  assert.equal(matrix[0]!.status, "MISSING");
});

test("suggestRemediation mappe chaque statut non-AVAILABLE vers une action, jamais AVAILABLE lui-même", () => {
  assert.equal(suggestRemediation("AVAILABLE", true), undefined);
  assert.equal(suggestRemediation("MISSING", false), "CREATE_SKILL");
  assert.equal(suggestRemediation("NOT_TESTED", false), "ADD_PROBE");
  assert.equal(suggestRemediation("NOT_TESTED", true), "ADD_TEST");
  assert.equal(suggestRemediation("BROKEN", false), "FIX_SKILL");
  assert.equal(suggestRemediation("AUTH_REQUIRED", false), "ADD_CREDENTIAL");
  assert.equal(suggestRemediation("DEPENDENCY_MISSING", false), "CONNECT_SERVICE");
  assert.equal(suggestRemediation("DEPRECATED", false), "DEPRECATE_DUPLICATE");
});

// --- N. l'ancien service (capabilityManifest.ts, PR-E) continue de fonctionner sans modification ---
test("N — capabilityManifest.ts (PR-E) continue de fonctionner sans modification, aux côtés du nouveau skillManifest.ts", () => {
  const capability = defineCapability({
    serviceId: "svc_a",
    serviceVersion: "1.0",
    capabilityId: "cap_x",
    capabilityName: "Capacité X",
    status: "AVAILABLE",
    inputSchemaRef: "in",
    outputSchemaRef: "out",
    riskLevel: "LOW",
    permissionLevel: "read",
    sideEffects: false,
    idempotent: true,
    asyncSupported: false,
    timeoutMs: 1000,
    dependencies: [],
    proofRef: "test:legacy",
  });
  const s = skill();
  assert.equal(capability.capabilityId, s.capabilitiesProvided[0]);
  assert.equal(capability.status, s.status);
});

// --- Le catalogue réel (skillCatalog.ts) est valide et s'enregistre sans erreur ---
test("createPopulatedRegistry enregistre tout REAL_SKILL_CATALOG sans erreur (le catalogue réel est valide)", () => {
  const registry = createPopulatedRegistry();
  assert.equal(registry.listSkills().length, REAL_SKILL_CATALOG.length);
});

test("le rapport de gap analysis assemble matrice, doublons, chevauchements connus et capacités manquantes", () => {
  const registry = createPopulatedRegistry();
  const services: ServiceCapabilitySource[] = [
    { id: "software_factory", capabilities: ["software_development", "code_generation"], riskByCapability: { software_development: "MEDIUM", code_generation: "LOW" } },
    { id: "workspace_service", capabilities: ["file_management"] },
  ];
  const report = buildGapAnalysisReport(registry, services, ["file_management", "capacite_totalement_absente"]);
  assert.ok(report.matrix.length >= SOFTWARE_FACTORY_CAPABILITY_AUDIT.length);
  assert.ok(report.architecturalOverlaps.length >= 3);
  assert.deepEqual(report.missingCapabilities, ["capacite_totalement_absente"]);
});

test("SOFTWARE_FACTORY_CAPABILITY_AUDIT documente les gaps réels (delete_file/branch_from_exact_sha absents)", () => {
  const capIds = SOFTWARE_FACTORY_CAPABILITY_AUDIT.map((r) => r.capability);
  for (const expectedGap of ["delete_file", "branch_from_exact_sha"]) {
    const row = SOFTWARE_FACTORY_CAPABILITY_AUDIT.find((r) => r.capability === expectedGap);
    assert.ok(row, `${expectedGap} doit être audité`);
    assert.equal(row!.status, "MISSING");
    assert.equal(row!.gap, "MISSING");
  }
});

// run_build/run_tests/run_lint/run_typecheck (tâche 5 sous-priorité 3, câblés) : ne sont plus
// des gaps — sortis de la liste "encore manquant" ci-dessus, vérifiés ici comme AVAILABLE avec
// leur propre preuve.
test("SOFTWARE_FACTORY_CAPABILITY_AUDIT reflète run_build/run_tests/run_lint/run_typecheck comme câblés (AVAILABLE, plus MISSING)", () => {
  for (const capability of ["run_build", "run_tests", "run_lint", "run_typecheck"]) {
    const row = SOFTWARE_FACTORY_CAPABILITY_AUDIT.find((r) => r.capability === capability);
    assert.ok(row, `${capability} doit être audité`);
    assert.equal(row!.status, "AVAILABLE", capability);
    assert.equal(row!.gap, "SERVICE_INTERNAL", capability);
    assert.ok(row!.proof, `${capability} AVAILABLE doit citer une preuve réelle`);
  }
});

// surgical_edit/rollback/generate_revert_pr (tâche 5, câblés PR-N/PR-P) : ne sont plus des
// gaps — sortis de la liste "encore manquant" ci-dessus, vérifiés ici comme AVAILABLE avec
// leur propre preuve.
test("SOFTWARE_FACTORY_CAPABILITY_AUDIT reflète surgical_edit/rollback/generate_revert_pr comme câblés (AVAILABLE, plus MISSING)", () => {
  for (const capability of ["surgical_edit", "rollback", "generate_revert_pr"]) {
    const row = SOFTWARE_FACTORY_CAPABILITY_AUDIT.find((r) => r.capability === capability);
    assert.ok(row, `${capability} doit être audité`);
    assert.equal(row!.status, "AVAILABLE", capability);
    assert.equal(row!.gap, "SERVICE_INTERNAL", capability);
    assert.ok(row!.proof, `${capability} AVAILABLE doit citer une preuve réelle`);
  }
});

// --- O/P. Aucune méthode d'écriture/fusion GitHub INVOQUÉE dans ce module. ---
// gapAnalysis.ts/skillCatalog.ts CITENT "octokit.rest.pulls.create" etc. comme documentation
// (toolsRequired, audit) sans jamais les appeler — donc on vérifie l'absence d'un appel réel
// (identifiant suivi d'une parenthèse), pas l'absence de la chaîne "octokit" elle-même.
test("O/P — aucun appel réel d'écriture/fusion GitHub dans gapAnalysis.ts / skillCatalog.ts (citations documentaires seulement)", () => {
  for (const file of ["gapAnalysis.ts", "skillCatalog.ts"]) {
    const path = fileURLToPath(new URL(`./${file}`, import.meta.url));
    const source = readFileSync(path, "utf-8");
    assert.doesNotMatch(source, /\.merge\(|createOrUpdateFileContents\(|createRef\(|pulls\.create\(|git\.push\(/i);
  }
});
