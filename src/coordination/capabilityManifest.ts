/**
 * Contrat de manifeste de capacité (plan V5 §35-38 : "SERVICE → CAPABILITIES
 * → PROBES → TESTS → STATUS"). PR-E ne construit PAS le Capability Registry
 * lui-même (aucune persistance, aucun store — explicitement hors périmètre,
 * cf. exclusions PR-B/PR-D) : uniquement le contrat/type qu'un futur
 * registre (n8n Data Table ou table SQLite dédiée) devra respecter, et la
 * règle non contournable qui l'accompagne — une capacité ne peut jamais être
 * marquée AVAILABLE sans preuve réelle.
 *
 * Aucun appel réseau, aucune dépendance GitHub, aucun fournisseur IA
 * particulier : fonctions pures de construction/validation uniquement.
 */

import { JARVIS00_CONTRACTS_SCHEMA_VERSION } from "./contracts.js";
import type { RiskLevel } from "../orchestration/contract.js";

/** Statuts officiels du plan V5 §36. */
export type CapabilityStatus =
  | "AVAILABLE"
  | "DEGRADED"
  | "DISABLED"
  | "MISSING"
  | "NOT_TESTED"
  | "AUTH_REQUIRED"
  | "PERMISSION_REQUIRED"
  | "DEPENDENCY_MISSING"
  | "BROKEN"
  | "DEPRECATED";

export const CAPABILITY_STATUSES: ReadonlySet<CapabilityStatus> = new Set([
  "AVAILABLE",
  "DEGRADED",
  "DISABLED",
  "MISSING",
  "NOT_TESTED",
  "AUTH_REQUIRED",
  "PERMISSION_REQUIRED",
  "DEPENDENCY_MISSING",
  "BROKEN",
  "DEPRECATED",
]);

/** Champs minimaux exigés par le plan V5 §36 pour décrire une capacité de service. */
export interface CapabilityDescriptorInput {
  serviceId: string;
  serviceVersion: string;
  capabilityId: string;
  capabilityName: string;
  status: CapabilityStatus;
  inputSchemaRef: string;
  outputSchemaRef: string;
  /** Réutilise le RiskLevel déjà stabilisé par l'orchestration (src/orchestration/contract.ts) — pas de second niveau de risque inventé. */
  riskLevel: RiskLevel;
  permissionLevel: string;
  sideEffects: boolean;
  idempotent: boolean;
  asyncSupported: boolean;
  timeoutMs: number;
  /** Identifiants de capacités dont celle-ci dépend (ex. "read_main_head" pour "create_branch"). */
  dependencies: string[];
  fallbackServiceId?: string;
  /** Référence de preuve (test, probe réel) — obligatoire si status="AVAILABLE". */
  proofRef?: string;
  remediationType?: string;
  lastVerifiedAt?: number;
}

export interface CapabilityDescriptor extends CapabilityDescriptorInput {
  schemaVersion: number;
}

export class CapabilityDescriptorInvalidError extends Error {
  readonly code = "CAPABILITY_DESCRIPTOR_INVALID" as const;
  constructor(message: string) {
    super(`CAPABILITY_DESCRIPTOR_INVALID : ${message}`);
    this.name = "CapabilityDescriptorInvalidError";
  }
}

/**
 * Règle ultime du plan V5 (§50) : ne jamais confondre "service existe" et
 * "service sait faire la mission". Une capacité ne peut donc jamais être
 * marquée AVAILABLE sans `proofRef` — aucune capacité de ce dépôt ne peut
 * contourner cette règle en passant par ce constructeur.
 */
export class CapabilityNotProvenError extends Error {
  readonly code = "CAPABILITY_NOT_PROVEN" as const;
  constructor(message: string) {
    super(`CAPABILITY_NOT_PROVEN : ${message}`);
    this.name = "CapabilityNotProvenError";
  }
}

export function defineCapability(input: CapabilityDescriptorInput): CapabilityDescriptor {
  if (!input.serviceId?.trim()) throw new CapabilityDescriptorInvalidError("serviceId est obligatoire.");
  if (!input.serviceVersion?.trim()) throw new CapabilityDescriptorInvalidError("serviceVersion est obligatoire.");
  if (!input.capabilityId?.trim()) throw new CapabilityDescriptorInvalidError("capabilityId est obligatoire.");
  if (!input.capabilityName?.trim()) throw new CapabilityDescriptorInvalidError("capabilityName est obligatoire.");
  if (!CAPABILITY_STATUSES.has(input.status)) {
    throw new CapabilityDescriptorInvalidError(`status invalide : ${JSON.stringify(input.status)}.`);
  }
  if (!Number.isFinite(input.timeoutMs) || input.timeoutMs <= 0) {
    throw new CapabilityDescriptorInvalidError("timeoutMs doit être un nombre positif.");
  }
  if (!Array.isArray(input.dependencies)) {
    throw new CapabilityDescriptorInvalidError("dependencies doit être un tableau (peut être vide, jamais absent).");
  }

  if (input.status === "AVAILABLE" && !input.proofRef?.trim()) {
    throw new CapabilityNotProvenError(
      `la capacité '${input.capabilityId}' du service '${input.serviceId}' ne peut pas être marquée AVAILABLE sans proofRef (preuve/test réel).`,
    );
  }

  return { ...input, schemaVersion: JARVIS00_CONTRACTS_SCHEMA_VERSION };
}
