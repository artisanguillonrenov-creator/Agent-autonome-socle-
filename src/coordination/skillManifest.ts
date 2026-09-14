/**
 * Contrat SkillDescriptor (chantier transversal Skills & Capabilities, plan
 * V5 §35-38 étendu : "SERVICE → CAPABILITIES → SKILLS → TOOLS → PROBES →
 * TESTS → PROOF → STATUS"). Symétrique de CapabilityDescriptor (PR-E,
 * capabilityManifest.ts) : où une CapabilityDescriptor décrit ce qu'un
 * SERVICE expose, une SkillDescriptor décrit comment Jarvis SAIT accomplir
 * une ou plusieurs de ces capacités — un skill peut être spécifique à un
 * service, partagé par plusieurs, ou transversal (mutualisé, §PHASE 10).
 *
 * Ne duplique aucun champ déjà porté par CapabilityDescriptor : réutilise
 * RiskLevel (src/orchestration/contract.ts), PermissionType
 * (src/orchestration/riskPolicy.ts), CapabilityStatus/CAPABILITY_STATUSES
 * (src/coordination/capabilityManifest.ts, §PHASE 8 — "réutiliser les
 * statuts PR-E"), RemediationType (src/coordination/remediation.ts) et
 * JARVIS00_CONTRACTS_SCHEMA_VERSION (contracts.ts). Ceci N'EST PAS le
 * `SkillDefinition` runtime de src/types.ts (le tool LLM-facing exécuté par
 * src/skills/registry.ts) : c'est la couche de gouvernance JARVIS-00 qui
 * décrit, teste et prouve un skill — un `SkillDefinition` existant peut être
 * *décrit* par une SkillDescriptor sans que l'un ne remplace l'autre.
 *
 * Comme capabilityManifest.ts : fonctions pures de construction/validation
 * uniquement — aucun appel réseau, aucune dépendance GitHub, aucun
 * fournisseur IA particulier, et aucune capacité de ce dépôt ne peut être
 * marquée AVAILABLE sans preuve réelle en passant par ce constructeur.
 */

import { JARVIS00_CONTRACTS_SCHEMA_VERSION } from "./contracts.js";
import { CAPABILITY_STATUSES, type CapabilityStatus } from "./capabilityManifest.js";
import { REMEDIATION_TYPE_SET, type RemediationType } from "./remediation.js";
import { hasValidProof } from "./proof.js";
import type { RiskLevel } from "../orchestration/contract.js";
import type { PermissionType } from "../orchestration/riskPolicy.js";

/** Réutilise explicitement les statuts PR-E (plan V5 §PHASE 8) — aucun second enum de statut. */
export type SkillStatus = CapabilityStatus;
export const SKILL_STATUSES: ReadonlySet<SkillStatus> = CAPABILITY_STATUSES;

/**
 * Portée d'un skill (plan V5 §PHASE 3) : un skill spécifique à un service, partagé
 * par une liste explicite de services, ou transversal (utilisable par tout service
 * capable de fournir les capacités qu'il requiert — mutualisation, §PHASE 10).
 */
export type SkillServiceScope =
  | { readonly type: "SINGLE_SERVICE"; readonly serviceId: string }
  | { readonly type: "MULTI_SERVICE"; readonly serviceIds: readonly string[] }
  | { readonly type: "TRANSVERSAL" };

export interface SkillDescriptorInput {
  skillId: string;
  skillName: string;
  skillVersion: string;
  description: string;

  serviceScope: SkillServiceScope;

  /** Identifiants de CapabilityDescriptor.capabilityId que ce skill sait accomplir. */
  capabilitiesProvided: string[];
  /** Outils (tool runtime / MCP / handler local) requis pour exécuter ce skill. */
  toolsRequired: string[];
  /** Identifiants d'autres SkillDescriptor.skillId dont celui-ci dépend. */
  dependencies: string[];

  inputSchemaRef: string;
  outputSchemaRef: string;

  riskLevel: RiskLevel;
  permissionLevel: PermissionType;
  sideEffects: boolean;
  idempotent: boolean;
  asyncSupported: boolean;
  timeoutMs: number;

  probeId?: string;
  testRefs: string[];
  /** Références de preuve (format `SOURCE:ref`, voir proof.ts) — au moins une valide exigée si status="AVAILABLE". */
  proofRefs: string[];

  status: SkillStatus;

  fallbackSkillId?: string;
  remediationType?: RemediationType;
  lastVerifiedAt?: number;
}

export interface SkillDescriptor extends SkillDescriptorInput {
  schemaVersion: number;
}

export class SkillDescriptorInvalidError extends Error {
  readonly code = "SKILL_DESCRIPTOR_INVALID" as const;
  constructor(message: string) {
    super(`SKILL_DESCRIPTOR_INVALID : ${message}`);
    this.name = "SkillDescriptorInvalidError";
  }
}

/** Symétrique de CapabilityNotProvenError (capabilityManifest.ts) — même règle, pour les skills. */
export class SkillNotProvenError extends Error {
  readonly code = "SKILL_NOT_PROVEN" as const;
  constructor(message: string) {
    super(`SKILL_NOT_PROVEN : ${message}`);
    this.name = "SkillNotProvenError";
  }
}

function isNonEmptyStringArray(value: unknown): value is string[] {
  return Array.isArray(value) && value.every((x) => typeof x === "string");
}

function validateServiceScope(scope: SkillServiceScope): void {
  if (!scope || typeof scope !== "object") {
    throw new SkillDescriptorInvalidError("serviceScope est obligatoire.");
  }
  if (scope.type === "SINGLE_SERVICE") {
    if (!scope.serviceId?.trim()) throw new SkillDescriptorInvalidError("serviceScope.serviceId est obligatoire pour SINGLE_SERVICE.");
    return;
  }
  if (scope.type === "MULTI_SERVICE") {
    if (!Array.isArray(scope.serviceIds) || scope.serviceIds.length < 2 || !scope.serviceIds.every((s) => typeof s === "string" && !!s.trim())) {
      throw new SkillDescriptorInvalidError("serviceScope.serviceIds doit contenir au moins 2 serviceId non vides pour MULTI_SERVICE.");
    }
    return;
  }
  if (scope.type === "TRANSVERSAL") return;
  throw new SkillDescriptorInvalidError(`serviceScope.type invalide : ${JSON.stringify((scope as { type?: unknown }).type)}.`);
}

export function defineSkill(input: SkillDescriptorInput): SkillDescriptor {
  if (!input.skillId?.trim()) throw new SkillDescriptorInvalidError("skillId est obligatoire.");
  if (!input.skillName?.trim()) throw new SkillDescriptorInvalidError("skillName est obligatoire.");
  if (!input.skillVersion?.trim()) throw new SkillDescriptorInvalidError("skillVersion est obligatoire.");
  if (!input.description?.trim()) throw new SkillDescriptorInvalidError("description est obligatoire.");

  validateServiceScope(input.serviceScope);

  if (!isNonEmptyStringArray(input.capabilitiesProvided)) {
    throw new SkillDescriptorInvalidError("capabilitiesProvided doit être un tableau de chaînes (peut être vide, jamais absent).");
  }
  if (!isNonEmptyStringArray(input.toolsRequired)) {
    throw new SkillDescriptorInvalidError("toolsRequired doit être un tableau de chaînes (peut être vide, jamais absent).");
  }
  if (!isNonEmptyStringArray(input.dependencies)) {
    throw new SkillDescriptorInvalidError("dependencies doit être un tableau de chaînes (peut être vide, jamais absent).");
  }
  if (input.dependencies.includes(input.skillId)) {
    throw new SkillDescriptorInvalidError(`dependencies ne peut pas contenir le skill lui-même : ${input.skillId}.`);
  }

  if (!input.inputSchemaRef?.trim()) throw new SkillDescriptorInvalidError("inputSchemaRef est obligatoire.");
  if (!input.outputSchemaRef?.trim()) throw new SkillDescriptorInvalidError("outputSchemaRef est obligatoire.");

  if (!Number.isFinite(input.timeoutMs) || input.timeoutMs <= 0) {
    throw new SkillDescriptorInvalidError("timeoutMs doit être un nombre positif.");
  }

  if (!SKILL_STATUSES.has(input.status)) {
    throw new SkillDescriptorInvalidError(`status invalide : ${JSON.stringify(input.status)}.`);
  }

  if (!isNonEmptyStringArray(input.testRefs)) {
    throw new SkillDescriptorInvalidError("testRefs doit être un tableau de chaînes (peut être vide, jamais absent).");
  }
  if (!isNonEmptyStringArray(input.proofRefs)) {
    throw new SkillDescriptorInvalidError("proofRefs doit être un tableau de chaînes (peut être vide, jamais absent).");
  }

  if (input.remediationType !== undefined && !REMEDIATION_TYPE_SET.has(input.remediationType)) {
    throw new SkillDescriptorInvalidError(`remediationType invalide : ${JSON.stringify(input.remediationType)}.`);
  }

  if (input.fallbackSkillId !== undefined && input.fallbackSkillId === input.skillId) {
    throw new SkillDescriptorInvalidError(`fallbackSkillId ne peut pas référencer le skill lui-même : ${input.skillId}.`);
  }

  // Règle ultime (plan V5 §50, appliquée aux skills §PHASE 8) : jamais AVAILABLE sans preuve réelle.
  if (input.status === "AVAILABLE" && !hasValidProof(input.proofRefs)) {
    throw new SkillNotProvenError(
      `le skill '${input.skillId}' ne peut pas être marqué AVAILABLE sans au moins une preuve réelle valide dans proofRefs (format "SOURCE:ref").`,
    );
  }

  return { ...input, schemaVersion: JARVIS00_CONTRACTS_SCHEMA_VERSION };
}
