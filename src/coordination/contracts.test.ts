import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import {
  JARVIS00_CONTRACTS_SCHEMA_VERSION,
  JARVIS00_KNOWN_ERROR_CODES,
  ContractVersionError,
  assertSupportedContractVersion,
  isSupportedContractVersion,
  toJarvisBuildResult,
  buildAuditPacket,
  AuditPacketIncompleteError,
  buildReviewerVerdict,
  ReviewerVerdictInconsistentError,
  buildHumanGateRequest,
  validateHumanGateDecision,
  HumanGateDecisionInvalidError,
  type AuditPacket,
  type AuditPacketInput,
  type HumanGateDecision,
} from "./contracts.js";
import { createInitialContextVersion, advanceContextVersion } from "./contextVersioning.js";
import { checkDiffFidelity, type DiffFidelityResult } from "../services/diffFidelity.js";
import type { SoftwareFactoryBuildOutcome } from "../services/softwareFactoryService.js";
import type { CiStatusResult, MainProtectionResult } from "../repository/githubReadOnlyClient.js";

// --- Fixtures réutilisant les fonctions/types réels de PR-A/PR-C/PR-D (requirement 11) ---

function ciSuccess(): CiStatusResult {
  return {
    sha: "deadbeef",
    overallState: "success",
    totalCount: 1,
    checks: [{ name: "build", source: "check_run", state: "success", url: null, startedAt: null, completedAt: null }],
  };
}

function ciFailure(): CiStatusResult {
  return {
    sha: "deadbeef",
    overallState: "failure",
    totalCount: 1,
    checks: [{ name: "build", source: "check_run", state: "failure", url: null, startedAt: null, completedAt: null }],
  };
}

function passingDiffFidelity(): DiffFidelityResult {
  return checkDiffFidelity({
    filePath: "docs/a.md",
    fileExistedBefore: true,
    originalContent: "line1\nline2\nline3\nline4\nline5\nline6",
    updatedContent: "line1\nline2\nline3-modifiee\nline4\nline5\nline6",
  });
}

function failingDiffFidelity(): DiffFidelityResult {
  return checkDiffFidelity({
    filePath: "docs/a.md",
    fileExistedBefore: true,
    originalContent: Array.from({ length: 20 }, (_, i) => `ligne ${i}`).join("\n"),
    updatedContent: "contenu totalement différent, sans rapport",
  });
}

function validAuditPacketInput(overrides: Partial<AuditPacketInput> = {}): AuditPacketInput {
  const contextVersion = createInitialContextVersion({ missionId: "m1", traceId: "t1", baseSha: "sha1", content: { objective: "x" } });
  return {
    missionId: "m1",
    traceId: "t1",
    objective: "Corriger le bug X",
    acceptanceCriteria: ["Les tests passent", "Aucune régression"],
    context: contextVersion,
    baseSha: "sha1",
    diffFidelity: passingDiffFidelity(),
    ci: ciSuccess(),
    risks: [],
    ...overrides,
  };
}

// --- Versionnement des contrats ---

test("isSupportedContractVersion / assertSupportedContractVersion acceptent la version courante", () => {
  assert.equal(isSupportedContractVersion(JARVIS00_CONTRACTS_SCHEMA_VERSION), true);
  assert.doesNotThrow(() => assertSupportedContractVersion(JARVIS00_CONTRACTS_SCHEMA_VERSION));
});

test("3 — rejet des versions de schéma incompatibles", () => {
  assert.equal(isSupportedContractVersion(999), false);
  assert.throws(() => assertSupportedContractVersion(999), ContractVersionError);
  assert.throws(() => assertSupportedContractVersion(0), ContractVersionError);
});

test("JARVIS00_KNOWN_ERROR_CODES est un catalogue sans doublon et non vide", () => {
  assert.ok(JARVIS00_KNOWN_ERROR_CODES.length > 10);
  assert.equal(new Set(JARVIS00_KNOWN_ERROR_CODES).size, JARVIS00_KNOWN_ERROR_CODES.length);
  for (const code of ["SECRET_DETECTED", "STALE_BASE", "DIFF_FIDELITY_FAILED", "MISSION_STATE_CONFLICT"]) {
    assert.ok((JARVIS00_KNOWN_ERROR_CODES as readonly string[]).includes(code), `${code} doit être catalogué`);
  }
});

// --- 4. Software Factory result → contrat JARVIS-00 ---

test("4 — toJarvisBuildResult enveloppe un SoftwareFactoryBuildOutcome réel sans en altérer les champs", () => {
  const outcome: SoftwareFactoryBuildOutcome = {
    branch: "jarvis/task-42",
    commitSha: "commit123",
    prUrl: "https://github.com/org/repo/pull/42",
    prNumber: 42,
    summary: "Patch appliqué.",
    diffFidelity: passingDiffFidelity(),
  };
  const result = toJarvisBuildResult(outcome, { missionId: "m1", traceId: "t1", baseSha: "sha1" });
  assert.equal(result.branch, outcome.branch);
  assert.equal(result.commitSha, outcome.commitSha);
  assert.equal(result.prUrl, outcome.prUrl);
  assert.equal(result.prNumber, outcome.prNumber);
  assert.deepEqual(result.diffFidelity, outcome.diffFidelity);
  assert.equal(result.missionId, "m1");
  assert.equal(result.baseSha, "sha1");
  assert.equal(result.schemaVersion, JARVIS00_CONTRACTS_SCHEMA_VERSION);
});

// --- 1. Sérialisation / désérialisation ---

test("1 — AuditPacket survit à un aller-retour JSON", () => {
  const packet = buildAuditPacket(validAuditPacketInput());
  const roundTripped = JSON.parse(JSON.stringify(packet)) as AuditPacket;
  assert.deepEqual(roundTripped, packet);
});

test("1 — ReviewerVerdict et HumanGateDecision survivent à un aller-retour JSON", () => {
  const packet = buildAuditPacket(validAuditPacketInput());
  const verdict = buildReviewerVerdict(packet, "GO_FUSION", ["CI verte", "fidélité PASS"]);
  assert.deepEqual(JSON.parse(JSON.stringify(verdict)), verdict);

  const request = buildHumanGateRequest({ missionId: "m1", traceId: "t1", kind: "MERGE_APPROVAL", summary: "Fusion ?" });
  const decision: HumanGateDecision = { missionId: "m1", traceId: "t1", kind: "MERGE_APPROVAL", action: "APPROUVER_FUSION", decidedAt: Date.now(), schemaVersion: JARVIS00_CONTRACTS_SCHEMA_VERSION };
  assert.deepEqual(JSON.parse(JSON.stringify(request)), request);
  assert.deepEqual(JSON.parse(JSON.stringify(decision)), decision);
});

// --- 2. Validation des champs obligatoires / 8. paquet incomplet rejeté ---

test("2/8 — buildAuditPacket rejette un paquet incomplet (champ par champ)", () => {
  const base = validAuditPacketInput();
  const cases: Array<Partial<AuditPacketInput>> = [
    { missionId: "" },
    { traceId: "" },
    { objective: "" },
    { acceptanceCriteria: undefined as unknown as string[] },
    { context: undefined as unknown as AuditPacketInput["context"] },
    { baseSha: "" },
    { diffFidelity: undefined as unknown as AuditPacketInput["diffFidelity"] },
    { ci: undefined as unknown as AuditPacketInput["ci"] },
    { risks: undefined as unknown as string[] },
  ];
  for (const override of cases) {
    assert.throws(() => buildAuditPacket({ ...base, ...override }), AuditPacketIncompleteError, `cas ${JSON.stringify(override)}`);
  }
});

test("2 — buildAuditPacket accepte acceptanceCriteria/risks vides (tableaux présents mais vides)", () => {
  const packet = buildAuditPacket(validAuditPacketInput({ acceptanceCriteria: [], risks: [] }));
  assert.deepEqual(packet.acceptanceCriteria, []);
  assert.deepEqual(packet.risks, []);
});

// --- 5. CI result → AuditPacket / 6. fidelity result → AuditPacket ---

test("5 — le CiStatusResult réel (PR-C) est porté tel quel dans l'AuditPacket", () => {
  const ci = ciFailure();
  const packet = buildAuditPacket(validAuditPacketInput({ ci }));
  assert.deepEqual(packet.ci, ci);
  assert.equal(packet.ci.overallState, "failure");
});

test("6 — le DiffFidelityResult réel (PR-D) est porté tel quel dans l'AuditPacket", () => {
  const diffFidelity = failingDiffFidelity();
  const packet = buildAuditPacket(validAuditPacketInput({ diffFidelity }));
  assert.deepEqual(packet.diffFidelity, diffFidelity);
  assert.equal(packet.diffFidelity.fidelityStatus, "FAIL");
});

// --- 7. Paquet Reviewer complet ---

test("7 — paquet Reviewer complet : AuditPacket → ReviewerVerdict GO_FUSION quand toutes les preuves sont favorables", () => {
  const context1 = createInitialContextVersion({ missionId: "m1", traceId: "t1", baseSha: "sha1", content: { objective: "x" } });
  const context2 = advanceContextVersion(context1, { objective: "x", finding: "critic review done" });
  const mainProtection: MainProtectionResult = {
    status: "MAIN_PROTECTION_VERIFIED",
    branch: "main",
    pullRequestRequired: true,
    requiredChecksConfigured: true,
    forcePushBlocked: true,
    adminsEnforced: true,
    reason: "vérifié",
  };
  const packet = buildAuditPacket({
    missionId: "m1",
    traceId: "t1",
    objective: "Ajouter le lecteur de statut CI",
    acceptanceCriteria: ["CI verte", "aucune régression"],
    context: context2,
    baseSha: "sha1",
    diffFidelity: passingDiffFidelity(),
    ci: ciSuccess(),
    testResults: { ran: true, passed: 20, failed: 0 },
    risks: ["Aucun risque identifié"],
    mainProtection,
  });
  const verdict = buildReviewerVerdict(packet, "GO_FUSION", ["CI verte", "fidélité PASS", "main protégée"]);
  assert.equal(verdict.status, "GO_FUSION");
  assert.equal(verdict.missionId, "m1");
  assert.equal(verdict.schemaVersion, JARVIS00_CONTRACTS_SCHEMA_VERSION);
});

test("REFUS_FUSION ne requiert aucune preuve favorable particulière", () => {
  const packet = buildAuditPacket(validAuditPacketInput({ ci: ciFailure(), diffFidelity: failingDiffFidelity() }));
  const verdict = buildReviewerVerdict(packet, "REFUS_FUSION", ["CI rouge", "fidélité FAIL"]);
  assert.equal(verdict.status, "REFUS_FUSION");
});

test("buildReviewerVerdict refuse GO_FUSION si la CI réelle n'est pas success (jamais la parole du builder)", () => {
  const packet = buildAuditPacket(validAuditPacketInput({ ci: ciFailure() }));
  assert.throws(() => buildReviewerVerdict(packet, "GO_FUSION", ["tout va bien selon le builder"]), ReviewerVerdictInconsistentError);
});

test("buildReviewerVerdict refuse GO_FUSION si le contrôle de fidélité (PR-D) n'est pas PASS", () => {
  const packet = buildAuditPacket(validAuditPacketInput({ diffFidelity: failingDiffFidelity() }));
  assert.throws(() => buildReviewerVerdict(packet, "GO_FUSION", ["diff ok selon le builder"]), ReviewerVerdictInconsistentError);
});

test("buildReviewerVerdict refuse GO_FUSION si la protection de main est confirmée insuffisante", () => {
  const mainProtection: MainProtectionResult = {
    status: "MAIN_PROTECTION_FAILED",
    branch: "main",
    pullRequestRequired: false,
    requiredChecksConfigured: false,
    forcePushBlocked: false,
    adminsEnforced: false,
    reason: "force-push autorisé",
  };
  const packet = buildAuditPacket(validAuditPacketInput({ mainProtection }));
  assert.throws(() => buildReviewerVerdict(packet, "GO_FUSION", ["ci ok"]), ReviewerVerdictInconsistentError);
});

test("buildReviewerVerdict exige au moins une raison", () => {
  const packet = buildAuditPacket(validAuditPacketInput());
  assert.throws(() => buildReviewerVerdict(packet, "REFUS_FUSION", []), ReviewerVerdictInconsistentError);
});

// --- Human Gate ---

test("buildHumanGateRequest/validateHumanGateDecision : décision valide acceptée pour chaque type de porte", () => {
  const planRequest = buildHumanGateRequest({ missionId: "m1", traceId: "t1", kind: "PLAN_APPROVAL", summary: "Approuver le plan ?" });
  assert.doesNotThrow(() =>
    validateHumanGateDecision(planRequest, { missionId: "m1", traceId: "t1", kind: "PLAN_APPROVAL", action: "APPROVE_PLAN", decidedAt: Date.now(), schemaVersion: JARVIS00_CONTRACTS_SCHEMA_VERSION }),
  );

  const mergeRequest = buildHumanGateRequest({ missionId: "m1", traceId: "t1", kind: "MERGE_APPROVAL", summary: "Fusionner ?" });
  assert.doesNotThrow(() =>
    validateHumanGateDecision(mergeRequest, { missionId: "m1", traceId: "t1", kind: "MERGE_APPROVAL", action: "APPROUVER_FUSION", decidedAt: Date.now(), schemaVersion: JARVIS00_CONTRACTS_SCHEMA_VERSION }),
  );
});

test("validateHumanGateDecision rejette une action appartenant à l'autre type de porte", () => {
  const planRequest = buildHumanGateRequest({ missionId: "m1", traceId: "t1", kind: "PLAN_APPROVAL", summary: "Approuver le plan ?" });
  assert.throws(
    () =>
      validateHumanGateDecision(planRequest, { missionId: "m1", traceId: "t1", kind: "PLAN_APPROVAL", action: "APPROUVER_FUSION", decidedAt: Date.now(), schemaVersion: JARVIS00_CONTRACTS_SCHEMA_VERSION }),
    HumanGateDecisionInvalidError,
  );
});

test("validateHumanGateDecision rejette une décision dont mission_id/trace_id ne correspond pas à la requête", () => {
  const request = buildHumanGateRequest({ missionId: "m1", traceId: "t1", kind: "MERGE_APPROVAL", summary: "Fusionner ?" });
  assert.throws(
    () =>
      validateHumanGateDecision(request, { missionId: "m2", traceId: "t1", kind: "MERGE_APPROVAL", action: "APPROUVER_FUSION", decidedAt: Date.now(), schemaVersion: JARVIS00_CONTRACTS_SCHEMA_VERSION }),
    HumanGateDecisionInvalidError,
  );
});

test("3 — validateHumanGateDecision rejette une décision dont le schema_version est incompatible", () => {
  const request = buildHumanGateRequest({ missionId: "m1", traceId: "t1", kind: "MERGE_APPROVAL", summary: "Fusionner ?" });
  assert.throws(
    () => validateHumanGateDecision(request, { missionId: "m1", traceId: "t1", kind: "MERGE_APPROVAL", action: "APPROUVER_FUSION", decidedAt: Date.now(), schemaVersion: 999 }),
    ContractVersionError,
  );
});

// --- 12. Aucun chemin permettant merge automatique ---

test("12 — aucune méthode d'écriture/fusion GitHub dans contracts.ts (vérification statique)", () => {
  const path = fileURLToPath(new URL("./contracts.ts", import.meta.url));
  const source = readFileSync(path, "utf-8");
  assert.doesNotMatch(source, /octokit|\.merge\(|pulls\.merge|createOrUpdateFileContents|createRef\(/i);
});

test("12 — APPROUVER_FUSION est une donnée validée, pas une action : validateHumanGateDecision ne renvoie rien et ne mute aucun état externe", () => {
  const request = buildHumanGateRequest({ missionId: "m1", traceId: "t1", kind: "MERGE_APPROVAL", summary: "Fusionner ?" });
  const decision: HumanGateDecision = { missionId: "m1", traceId: "t1", kind: "MERGE_APPROVAL", action: "APPROUVER_FUSION", decidedAt: Date.now(), schemaVersion: JARVIS00_CONTRACTS_SCHEMA_VERSION };
  const returned = validateHumanGateDecision(request, decision);
  assert.equal(returned, undefined, "une validation ne doit renvoyer qu'un signal pass/throw, jamais déclencher une action");
});

// --- 11. Compatibilité avec les structures PR-A/B/C/D (démontrée par les fixtures ci-dessus, plus une vérification explicite) ---

test("11 — les contrats PR-E acceptent directement les types réels de PR-A (ContextVersion) et PR-D (DiffFidelityResult) sans adaptation", () => {
  const contextVersion = createInitialContextVersion({ missionId: "m9", traceId: "t9", baseSha: "sha9", content: { a: 1 } });
  const diffFidelity = checkDiffFidelity({ filePath: "x.md", fileExistedBefore: false, originalContent: "", updatedContent: "nouveau contenu" });
  const packet = buildAuditPacket({
    missionId: "m9",
    traceId: "t9",
    objective: "x",
    acceptanceCriteria: [],
    context: contextVersion,
    baseSha: "sha9",
    diffFidelity,
    ci: ciSuccess(),
    risks: [],
  });
  assert.equal(packet.context.contextVersion, 1);
  assert.equal(packet.diffFidelity.files[0].changeType, "created");
});
