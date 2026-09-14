/**
 * Format exportable vers n8n (chantier Skills & Capabilities, plan V5
 * §PHASE 16), compatible avec `JARVIS_Service_Capabilities` déjà prévu côté
 * n8n. Fonction pure — aucun appel réseau, ne publie ni ne modifie rien côté
 * n8n (§PHASE 16 : "PR actuelle côté code ne doit PAS publier ni modifier
 * directement n8n") — se contente de produire le tableau de lignes attendu
 * à partir de la Service Capability Matrix déjà construite (gapAnalysis.ts).
 *
 * `service_version` : `ServiceDefinition` (orchestration/serviceRegistry.ts)
 * ne porte aujourd'hui AUCUN champ de version — un gap réel constaté à
 * l'audit, pas une omission de ce module. Sans `serviceVersions` fourni par
 * l'appelant, la valeur exportée est honnêtement `"unknown"`, jamais
 * inventée.
 */

import { JARVIS00_CONTRACTS_SCHEMA_VERSION } from "./contracts.js";
import type { RiskLevel } from "../orchestration/contract.js";
import type { PermissionType } from "../orchestration/riskPolicy.js";
import type { SkillStatus } from "./skillManifest.js";
import type { CapabilityMatrixRow } from "./gapAnalysis.js";
import type { SkillCapabilityRegistry } from "./skillRegistry.js";

export interface N8nCapabilityRow {
  service_id: string;
  service_version: string;
  capability_id: string;
  capability_name: string;
  skill_id: string | null;
  skill_version: string | null;
  status: SkillStatus;
  proof_ref: string | null;
  risk_level: RiskLevel | null;
  permission_level: PermissionType | null;
  dependencies: string[];
  remediation_type: string | null;
  last_verified_at: number | null;
  schema_version: number;
}

export function exportForN8n(matrix: readonly CapabilityMatrixRow[], registry: SkillCapabilityRegistry, serviceVersions: Readonly<Record<string, string>> = {}): N8nCapabilityRow[] {
  return matrix.map((row) => {
    const skill = row.skill ? registry.getSkill(row.skill) : undefined;
    return {
      service_id: row.service,
      service_version: serviceVersions[row.service] ?? "unknown",
      capability_id: row.capability,
      capability_name: row.capability,
      skill_id: skill?.skillId ?? null,
      skill_version: skill?.skillVersion ?? null,
      status: row.status,
      proof_ref: skill?.proofRefs[0] ?? row.proof ?? null,
      risk_level: skill?.riskLevel ?? row.risk ?? null,
      permission_level: skill?.permissionLevel ?? null,
      dependencies: skill ? [...skill.dependencies] : [],
      remediation_type: skill?.remediationType ?? row.recommendedAction ?? null,
      last_verified_at: skill?.lastVerifiedAt ?? null,
      schema_version: skill?.schemaVersion ?? JARVIS00_CONTRACTS_SCHEMA_VERSION,
    };
  });
}
