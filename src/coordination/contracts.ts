/**
 * Contrats définitifs JARVIS-00 ↔ services (plan V5, PR-E de la roadmap).
 *
 * Objectif : que n8n (ou tout futur consommateur) puisse se raccorder au
 * code Jarvis sans inventer de payload ni dépendre d'une interface
 * implicite. Ce module ne redéfinit AUCUN type déjà stabilisé par les PR
 * précédentes — il les compose :
 *
 * - Mission / MissionEvent / ContextVersion → src/coordination/types.ts (PR-A)
 * - TaskRequest / ServiceEvent / RiskLevel / dispatch → src/orchestration/contract.ts (déjà stable, réutilisé tel quel)
 * - MainProtectionResult / CiStatusResult → src/repository/githubReadOnlyClient.ts (PR-B/PR-C)
 * - DiffFidelityResult / FileDiffEntry → src/services/diffFidelity.ts (PR-D)
 * - SoftwareFactoryBuildOutcome (branche/commit/PR) → src/services/softwareFactoryService.ts (PR-B/PR-D)
 *
 * Ce module ajoute uniquement ce qui manquait : le paquet de preuves pour le
 * Reviewer (`AuditPacket`), le verdict qui en résulte (`ReviewerVerdict`),
 * la porte humaine (`HumanGateRequest`/`HumanGateDecision`), l'enveloppe de
 * résultat de build côté JARVIS-00 (`JarvisBuildResult`), et le
 * versionnement de ces contrats (`schema_version`).
 *
 * Aucune fonction de ce fichier n'écrit sur GitHub, ne déclenche de fusion,
 * ni ne dépend d'un fournisseur IA particulier — ce sont des contrats de
 * données et leur validation, rien d'exécutable côté effet de bord.
 * `neverAutoMerge`, `STALE_BASE`, `SECRET_DETECTED` et `DIFF_FIDELITY_FAILED`
 * (PR-B/PR-D) ne sont ni modifiés ni contournés ici : ce fichier les
 * catalogue (`JARVIS00_KNOWN_ERROR_CODES`) sans toucher au code qui les lève.
 */

import type { ContextVersion } from "./types.js";
import type { DiffFidelityResult } from "../services/diffFidelity.js";
import type { CiStatusResult, MainProtectionResult } from "../repository/githubReadOnlyClient.js";
import type { SoftwareFactoryBuildOutcome } from "../services/softwareFactoryService.js";

/** Version des contrats définis dans ce fichier — indépendante de CONTRACT_SCHEMA_VERSION (dispatch) et CONTEXT_SCHEMA_VERSION (PR-A). */
export const JARVIS00_CONTRACTS_SCHEMA_VERSION = 1;

export class ContractVersionError extends Error {
  readonly code = "CONTRACT_VERSION_UNSUPPORTED" as const;
  constructor(message: string) {
    super(`CONTRACT_VERSION_UNSUPPORTED : ${message}`);
    this.name = "ContractVersionError";
  }
}

export function isSupportedContractVersion(version: number): boolean {
  return version === JARVIS00_CONTRACTS_SCHEMA_VERSION;
}

/** Rejette une version de contrat incompatible plutôt que de tenter une lecture partielle/best-effort. */
export function assertSupportedContractVersion(version: number): void {
  if (!isSupportedContractVersion(version)) {
    throw new ContractVersionError(`version reçue ${JSON.stringify(version)}, attendue ${JARVIS00_CONTRACTS_SCHEMA_VERSION}.`);
  }
}

/**
 * Catalogue des codes d'erreur/statut structurés déjà introduits par PR-A à
 * PR-E. Ne redéfinit aucune logique de levée — référence stable pour un
 * consommateur externe (n8n, Reviewer) qui doit reconnaître ces codes sans
 * deviner leur orthographe ni dupliquer leur définition. Les valeurs
 * `MAIN_PROTECTION_*`/CI `overallState` ne sont pas des erreurs (ce sont des
 * statuts renvoyés, jamais levés) et n'apparaissent donc pas ici.
 */
export const JARVIS00_KNOWN_ERROR_CODES = [
  // PR-A — src/coordination/types.ts
  "MISSION_NOT_FOUND",
  "MISSION_STATE_CONFLICT",
  "EVENT_SEQUENCE_INVALID",
  "EVENT_PAYLOAD_INVALID",
  "CONTEXT_VERSION_INVALID",
  // PR-B — src/services/softwareFactoryService.ts
  "SECRET_DETECTED",
  "STALE_BASE",
  "EXPECTED_BASE_SHA_INVALID",
  "EXPECTED_FILE_PATH_INVALID",
  "EXPECTED_CHANGE_TYPE_INVALID",
  "ALLOW_FULL_REWRITE_INVALID",
  // PR-D — src/services/softwareFactoryService.ts
  "DIFF_FIDELITY_FAILED",
  // PR-E — ce fichier / capabilityManifest.ts
  "CONTRACT_VERSION_UNSUPPORTED",
  "AUDIT_PACKET_INCOMPLETE",
  "REVIEWER_VERDICT_INCONSISTENT",
  "HUMAN_GATE_DECISION_INVALID",
  "CAPABILITY_NOT_PROVEN",
  "CAPABILITY_DESCRIPTOR_INVALID",
] as const;

export type JarvisKnownErrorCode = (typeof JARVIS00_KNOWN_ERROR_CODES)[number];

// ---------------------------------------------------------------------------
// Résultat de build JARVIS-00 (branche / commit / PR / diffFidelity)
// ---------------------------------------------------------------------------

/**
 * Enveloppe JARVIS-00 autour de `SoftwareFactoryBuildOutcome` (déjà stable
 * depuis PR-B/PR-D) : ajoute la corrélation mission et le versionnement de
 * contrat, sans redéfinir la forme du résultat de build lui-même.
 */
export interface JarvisBuildResult extends SoftwareFactoryBuildOutcome {
  missionId: string;
  traceId: string;
  baseSha: string;
  schemaVersion: number;
}

/** "Software Factory result → contrat JARVIS-00" : aucune transformation de champ, uniquement l'ajout de la corrélation mission et du schema_version. */
export function toJarvisBuildResult(
  outcome: SoftwareFactoryBuildOutcome,
  context: { missionId: string; traceId: string; baseSha: string },
): JarvisBuildResult {
  return { ...outcome, ...context, schemaVersion: JARVIS00_CONTRACTS_SCHEMA_VERSION };
}

// ---------------------------------------------------------------------------
// AuditPacket — preuves réelles destinées au Reviewer
// ---------------------------------------------------------------------------

/** Résumé optionnel d'une exécution de tests distincte de la CI (ex. tests ciblés en local). */
export interface TestResultsSummary {
  ran: boolean;
  passed?: number;
  failed?: number;
  summary?: string;
}

/**
 * Tout ce dont le Reviewer a besoin pour produire un verdict fondé sur des
 * preuves — jamais sur le rapport déclaratif du builder (plan V5 §14.K).
 * `diffFidelity` porte à la fois le diff réel, les fichiers réellement
 * modifiés et le statut de fidélité (PR-D) : ce n'est pas trois champs
 * séparés, c'est un seul contrat déjà conçu pour ça — le dupliquer ici
 * créerait une source de vérité concurrente.
 */
export interface AuditPacketInput {
  missionId: string;
  traceId: string;
  objective: string;
  acceptanceCriteria: string[];
  /** Contexte canonique versionné (PR-A) — pas le contenu brut, la version chaînée par hash. */
  context: ContextVersion;
  baseSha: string;
  /** Diff réel + fichiers réellement modifiés + statut de fidélité (PR-D). */
  diffFidelity: DiffFidelityResult;
  /** Statut CI réel lu directement sur GitHub (PR-C) — jamais le rapport du builder. */
  ci: CiStatusResult;
  testResults?: TestResultsSummary;
  risks: string[];
  /** Protection de branche `main` observée (PR-B), si vérifiée pour cette mission. */
  mainProtection?: MainProtectionResult;
}

export interface AuditPacket extends AuditPacketInput {
  schemaVersion: number;
  producedAt: number;
}

export class AuditPacketIncompleteError extends Error {
  readonly code = "AUDIT_PACKET_INCOMPLETE" as const;
  constructor(message: string) {
    super(`AUDIT_PACKET_INCOMPLETE : ${message}`);
    this.name = "AuditPacketIncompleteError";
  }
}

function requireNonEmptyString(value: unknown, field: string): void {
  if (typeof value !== "string" || value.trim() === "") {
    throw new AuditPacketIncompleteError(`${field} est obligatoire et doit être une chaîne non vide.`);
  }
}

function requireArray(value: unknown, field: string): void {
  if (!Array.isArray(value)) {
    throw new AuditPacketIncompleteError(`${field} est obligatoire et doit être un tableau (peut être vide, jamais absent).`);
  }
}

function requireObject(value: unknown, field: string): void {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new AuditPacketIncompleteError(`${field} est obligatoire.`);
  }
}

/** Construit un AuditPacket ; rejette tout paquet incomplet avant qu'il n'atteigne le Reviewer. */
export function buildAuditPacket(input: AuditPacketInput): AuditPacket {
  requireNonEmptyString(input.missionId, "missionId");
  requireNonEmptyString(input.traceId, "traceId");
  requireNonEmptyString(input.objective, "objective");
  requireArray(input.acceptanceCriteria, "acceptanceCriteria");
  requireObject(input.context, "context");
  requireNonEmptyString(input.baseSha, "baseSha");
  requireObject(input.diffFidelity, "diffFidelity");
  requireObject(input.ci, "ci");
  requireArray(input.risks, "risks");

  return {
    ...input,
    schemaVersion: JARVIS00_CONTRACTS_SCHEMA_VERSION,
    producedAt: Date.now(),
  };
}

// ---------------------------------------------------------------------------
// ReviewerVerdict
// ---------------------------------------------------------------------------

export type ReviewerVerdictStatus = "GO_FUSION" | "REFUS_FUSION";

export interface ReviewerVerdict {
  missionId: string;
  traceId: string;
  status: ReviewerVerdictStatus;
  reasons: string[];
  producedAt: number;
  schemaVersion: number;
}

export class ReviewerVerdictInconsistentError extends Error {
  readonly code = "REVIEWER_VERDICT_INCONSISTENT" as const;
  constructor(message: string) {
    super(`REVIEWER_VERDICT_INCONSISTENT : ${message}`);
    this.name = "ReviewerVerdictInconsistentError";
  }
}

/**
 * Construit un verdict Reviewer à partir d'un AuditPacket. `GO_FUSION` ne
 * peut jamais être construit contre des preuves défavorables ou manquantes
 * (CI non `success`, fidélité non `PASS`, ou protection de main non
 * `MAIN_PROTECTION_VERIFIED`) — le verdict lui-même refuse d'exister s'il
 * contredit les preuves, plutôt que de faire confiance à l'appelant. Ceci
 * reste un contrat de données : `GO_FUSION` n'exécute aucune fusion, c'est
 * une recommandation destinée au Human Gate (§14.L du plan V5) — jamais un
 * chemin de fusion automatique.
 *
 * Vérification positive de la protection de main (plan V5 §53) : l'absence
 * de vérification (`mainProtection` non fourni) et `MAIN_PROTECTION_UNVERIFIED`
 * sont traités exactement comme `MAIN_PROTECTION_FAILED` pour `GO_FUSION` —
 * l'absence de preuve n'est jamais interprétée comme une preuve de
 * protection.
 */
export function buildReviewerVerdict(auditPacket: AuditPacket, status: ReviewerVerdictStatus, reasons: string[]): ReviewerVerdict {
  if (!Array.isArray(reasons) || reasons.length === 0) {
    throw new ReviewerVerdictInconsistentError("au moins une raison doit être fournie pour tout verdict.");
  }
  if (status === "GO_FUSION") {
    if (auditPacket.ci.overallState !== "success") {
      throw new ReviewerVerdictInconsistentError(
        `GO_FUSION impossible : statut CI réel = '${auditPacket.ci.overallState}' (attendu 'success').`,
      );
    }
    if (auditPacket.diffFidelity.fidelityStatus !== "PASS") {
      throw new ReviewerVerdictInconsistentError(
        `GO_FUSION impossible : contrôle de fidélité = '${auditPacket.diffFidelity.fidelityStatus}'.`,
      );
    }
    if (!auditPacket.mainProtection || auditPacket.mainProtection.status !== "MAIN_PROTECTION_VERIFIED") {
      throw new ReviewerVerdictInconsistentError(
        `GO_FUSION impossible : protection de main non vérifiée positivement (statut = '${auditPacket.mainProtection?.status ?? "absent"}', attendu 'MAIN_PROTECTION_VERIFIED').`,
      );
    }
  }
  return {
    missionId: auditPacket.missionId,
    traceId: auditPacket.traceId,
    status,
    reasons,
    producedAt: Date.now(),
    schemaVersion: JARVIS00_CONTRACTS_SCHEMA_VERSION,
  };
}

// ---------------------------------------------------------------------------
// Human Gate (plan V5 §14.G/§14.L) — contrats de données uniquement
// ---------------------------------------------------------------------------

export type HumanGateKind = "PLAN_APPROVAL" | "MERGE_APPROVAL";

export type HumanGateAction =
  | "APPROVE_PLAN"
  | "REQUEST_CHANGES"
  | "CANCEL"
  | "APPROUVER_FUSION"
  | "REFUSER"
  | "CORRIGER"
  | "ABANDONNER";

/** Actions valides par type de porte — jamais "APPROUVER_FUSION" pour une porte PLAN_APPROVAL et inversement. */
export const HUMAN_GATE_ACTIONS_BY_KIND: Readonly<Record<HumanGateKind, readonly HumanGateAction[]>> = {
  PLAN_APPROVAL: ["APPROVE_PLAN", "REQUEST_CHANGES", "CANCEL"],
  MERGE_APPROVAL: ["APPROUVER_FUSION", "REFUSER", "CORRIGER", "ABANDONNER"],
};

export interface HumanGateRequest {
  missionId: string;
  traceId: string;
  kind: HumanGateKind;
  summary: string;
  createdAt: number;
  schemaVersion: number;
}

export interface HumanGateDecision {
  missionId: string;
  traceId: string;
  kind: HumanGateKind;
  action: HumanGateAction;
  decidedAt: number;
  decidedBy?: string;
  schemaVersion: number;
}

export class HumanGateDecisionInvalidError extends Error {
  readonly code = "HUMAN_GATE_DECISION_INVALID" as const;
  constructor(message: string) {
    super(`HUMAN_GATE_DECISION_INVALID : ${message}`);
    this.name = "HumanGateDecisionInvalidError";
  }
}

export function buildHumanGateRequest(input: { missionId: string; traceId: string; kind: HumanGateKind; summary: string; createdAt?: number }): HumanGateRequest {
  if (!input.missionId?.trim()) throw new HumanGateDecisionInvalidError("missionId est obligatoire.");
  if (!input.summary?.trim()) throw new HumanGateDecisionInvalidError("summary est obligatoire pour présenter la porte humaine.");
  return {
    missionId: input.missionId,
    traceId: input.traceId,
    kind: input.kind,
    summary: input.summary,
    createdAt: input.createdAt ?? Date.now(),
    schemaVersion: JARVIS00_CONTRACTS_SCHEMA_VERSION,
  };
}

/**
 * Valide une décision reçue (potentiellement d'un canal externe / n8n)
 * contre la requête qui l'a provoquée. Fonction pure de validation de
 * données : ne déclenche, n'exécute et n'autorise elle-même AUCUNE fusion —
 * y compris pour l'action "APPROUVER_FUSION", qui reste une donnée
 * enregistrée, jamais un appel d'écriture GitHub. Le callback asynchrone
 * authentifié qui transportera réellement cette décision reste hors
 * périmètre (PR-F).
 */
export function validateHumanGateDecision(request: HumanGateRequest, decision: HumanGateDecision): void {
  assertSupportedContractVersion(decision.schemaVersion);
  if (decision.missionId !== request.missionId || decision.traceId !== request.traceId) {
    throw new HumanGateDecisionInvalidError("la décision ne correspond pas à la porte humaine attendue (mission_id/trace_id).");
  }
  if (decision.kind !== request.kind) {
    throw new HumanGateDecisionInvalidError(`type de porte incohérent : requête=${request.kind}, décision=${decision.kind}.`);
  }
  const allowed = HUMAN_GATE_ACTIONS_BY_KIND[decision.kind];
  if (!allowed.includes(decision.action)) {
    throw new HumanGateDecisionInvalidError(`action '${decision.action}' invalide pour une porte de type ${decision.kind} (autorisées : ${allowed.join(", ")}).`);
  }
}
