/**
 * Types de remédiation transversaux (chantier Skills & Capabilities, plan V5
 * "PHASE 14"). Un seul vocabulaire de remédiation pour tout gap détecté sur
 * une CapabilityDescriptor (PR-E) ou une SkillDescriptor (ce chantier) — ni
 * capabilityManifest.ts ni skillManifest.ts ne redéfinissent leur propre
 * liste, ils réutilisent celle-ci (`remediationType?: RemediationType`).
 *
 * Fonctions pures uniquement : aucune remédiation à risque élevé n'est
 * appliquée automatiquement ici (§PHASE 14) — ce module ne fait que
 * qualifier un gap, jamais agir dessus.
 */

export const REMEDIATION_TYPES = [
  "REGISTER_EXISTING",
  "ADD_PROBE",
  "ADD_TEST",
  "CREATE_SKILL",
  "CREATE_TOOL",
  "FIX_SKILL",
  "CONNECT_SERVICE",
  "ADD_PERMISSION",
  "ADD_CREDENTIAL",
  "DEPRECATE_DUPLICATE",
  "HUMAN_ACTION_REQUIRED",
] as const;

export type RemediationType = (typeof REMEDIATION_TYPES)[number];

export const REMEDIATION_TYPE_SET: ReadonlySet<RemediationType> = new Set(REMEDIATION_TYPES);

/** Remédiations qui ne doivent jamais être déclenchées automatiquement (plan V5 §PHASE 14/15). */
export const HIGH_RISK_REMEDIATIONS: ReadonlySet<RemediationType> = new Set([
  "CREATE_SKILL",
  "CREATE_TOOL",
  "CONNECT_SERVICE",
  "ADD_PERMISSION",
  "ADD_CREDENTIAL",
  "DEPRECATE_DUPLICATE",
  "HUMAN_ACTION_REQUIRED",
]);

export function isHighRiskRemediation(type: RemediationType): boolean {
  return HIGH_RISK_REMEDIATIONS.has(type);
}

/** Verdicts de déduplication (plan V5 §PHASE 17). */
export const DEDUPLICATION_VERDICTS = ["KEEP", "MERGE", "DEPRECATE", "REMOVE_LATER", "UNKNOWN"] as const;
export type DeduplicationVerdict = (typeof DEDUPLICATION_VERDICTS)[number];

/** Classification d'un élément découvert dans le dépôt (plan V5 §PHASE 2). */
export const DISCOVERY_CLASSIFICATIONS = [
  "EXISTING_SKILL",
  "EXISTING_CAPABILITY",
  "TOOL_ONLY",
  "SERVICE_INTERNAL",
  "DUPLICATE",
  "LEGACY",
  "MISSING",
] as const;
export type DiscoveryClassification = (typeof DISCOVERY_CLASSIFICATIONS)[number];
