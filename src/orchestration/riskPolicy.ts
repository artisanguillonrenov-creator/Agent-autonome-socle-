import { config } from "../config.js";
import type { RiskLevel } from "./contract.js";
import { riskForCapability, type ServiceDefinition } from "./serviceRegistry.js";

export type PermissionType = "READ" | "WRITE" | "DELETE" | "EXECUTE" | "SEND" | "PURCHASE" | "COMPUTER_CONTROL";

const RISK_ORDER: Record<RiskLevel, number> = { LOW: 0, MEDIUM: 1, HIGH: 2, CRITICAL: 3 };
const PERMISSION_ORDER: Record<PermissionType, number> = {
  READ: 0,
  WRITE: 1,
  DELETE: 2,
  EXECUTE: 3,
  SEND: 4,
  PURCHASE: 5,
  COMPUTER_CONTROL: 6,
};

/**
 * Chantier 8 (autonomy.globalRiskLevel) : une opération dont le risque dépasse le
 * plafond configuré exige l'approbation — CRITICAL exige TOUJOURS la confirmation
 * renforcée (APPROVE_CRITICAL), quel que soit le plafond, sans aucun chemin de
 * contournement possible en relevant simplement ce réglage.
 */
export function requiresApprovalForRisk(riskLevel: RiskLevel): boolean {
  if (riskLevel === "CRITICAL") return true;
  return RISK_ORDER[riskLevel] > RISK_ORDER[config.autonomy.globalRiskLevel];
}

/**
 * Permission requise par une capacité : utilise `permissionByCapability` si le service
 * la déclare explicitement (mécanisme d'extension propre, symétrique à `riskByCapability`)
 * — c'est le SEUL moyen d'exiger SEND/PURCHASE/COMPUTER_CONTROL, qu'aucune capacité du
 * socle n'utilise aujourd'hui. Sinon, dérive du niveau de risque existant (LOW->READ,
 * MEDIUM->WRITE, HIGH/CRITICAL->EXECUTE) : le risque (probabilité/impact, gère
 * l'approbation) et la permission (catégorie d'action) sont deux axes distincts —
 * un risque CRITICAL reste soumis au flux d'approbation renforcée existant, jamais
 * automatiquement bloqué par la matrice de permissions sans déclaration explicite.
 */
const RISK_TO_PERMISSION: Record<RiskLevel, PermissionType> = {
  LOW: "READ",
  MEDIUM: "WRITE",
  HIGH: "EXECUTE",
  CRITICAL: "EXECUTE",
};

export function permissionForCapability(service: ServiceDefinition, capability: string): PermissionType {
  const explicit = service.permissionByCapability?.[capability];
  if (explicit) return explicit as PermissionType;
  const risk = riskForCapability(service, capability) ?? "CRITICAL";
  return RISK_TO_PERMISSION[risk];
}

/**
 * Chantier 8 (autonomy.permissionMatrix) : une capacité requérant une permission au-delà
 * du plafond configuré est bloquée — vérifiée au point d'exécution effectif
 * (ServiceOrchestrator.dispatchCapability), pas seulement affichée dans l'interface.
 */
export function isPermissionGranted(permission: PermissionType): boolean {
  return PERMISSION_ORDER[permission] <= PERMISSION_ORDER[config.autonomy.permissionMatrix];
}
