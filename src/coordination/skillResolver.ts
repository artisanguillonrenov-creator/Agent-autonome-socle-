/**
 * Resolver déterministe SERVICE → CAPABILITY → SKILL (chantier Skills &
 * Capabilities, plan V5 §PHASE 5) :
 *
 *   mission demande X → capacité nécessaire → services capables →
 *   skills compatibles → outils disponibles → permissions → statut/proof →
 *   sélection (avec fallback explicite si le premier candidat échoue).
 *
 * Une capacité n'est JAMAIS considérée utilisable si status != AVAILABLE, ou
 * si la preuve est absente, ou si une dépendance obligatoire est
 * indisponible (§PHASE 5) — ces trois vérifications sont refaites ici même
 * si `defineSkill` (skillManifest.ts) les a déjà appliquées à l'enregistrement :
 * défense en profondeur, jamais de confiance aveugle dans un champ `status`
 * qui pourrait avoir été muté après coup.
 *
 * Les vérifications d'outils/permissions sont injectées (comme
 * `createRuntimeSkills` injecte ses engines ailleurs dans ce dépôt) plutôt
 * que lues depuis `config` globalement : ce module reste une fonction pure
 * testable sans dépendre de l'état runtime, et la production peut y brancher
 * `riskPolicy.isPermissionGranted` tel quel.
 */

import type { SkillDescriptor } from "./skillManifest.js";
import { hasValidProof } from "./proof.js";
import { SkillCapabilityRegistry } from "./skillRegistry.js";
import type { PermissionType } from "../orchestration/riskPolicy.js";

export type ResolutionRejectionCode =
  | "SCOPE_MISMATCH"
  | "STATUS_NOT_AVAILABLE"
  | "PROOF_MISSING"
  | "DEPENDENCY_MISSING"
  | "DEPENDENCY_CYCLE"
  | "TOOLS_UNAVAILABLE"
  | "PERMISSION_DENIED";

export interface ResolutionAttempt {
  skillId: string;
  accepted: boolean;
  rejectionCode?: ResolutionRejectionCode;
  reason?: string;
}

export interface ResolutionResult {
  capabilityId: string;
  resolved: boolean;
  selectedSkillId?: string;
  attempts: ResolutionAttempt[];
}

export interface ResolveOptions {
  /** Ne considérer que les skills dont la portée couvre ce service (§PHASE 5 "services capables"). */
  serviceId?: string;
  /** Injection testable de riskPolicy.isPermissionGranted — par défaut, tout est autorisé. */
  isPermissionGranted?: (permission: PermissionType) => boolean;
  /** Injection testable de la disponibilité effective des outils requis — par défaut, tout est disponible. */
  areToolsAvailable?: (toolsRequired: readonly string[]) => boolean;
}

function scopeMatchesService(skill: SkillDescriptor, serviceId?: string): boolean {
  if (!serviceId) return true;
  const scope = skill.serviceScope;
  if (scope.type === "TRANSVERSAL") return true;
  if (scope.type === "SINGLE_SERVICE") return scope.serviceId === serviceId;
  return scope.serviceIds.includes(serviceId);
}

/** Une dépendance est utilisable si elle existe, est elle-même AVAILABLE+prouvée, récursivement (cycle détecté explicitement). */
function isSkillUsable(registry: SkillCapabilityRegistry, skillId: string, visiting: Set<string>): boolean {
  if (visiting.has(skillId)) return false;
  const skill = registry.getSkill(skillId);
  if (!skill) return false;
  if (skill.status !== "AVAILABLE" || !hasValidProof(skill.proofRefs)) return false;
  if (skill.dependencies.length === 0) return true;
  const nextVisiting = new Set(visiting).add(skillId);
  return skill.dependencies.every((depId) => isSkillUsable(registry, depId, nextVisiting));
}

function evaluate(registry: SkillCapabilityRegistry, skill: SkillDescriptor, opts: ResolveOptions): ResolutionAttempt {
  if (!scopeMatchesService(skill, opts.serviceId)) {
    return { skillId: skill.skillId, accepted: false, rejectionCode: "SCOPE_MISMATCH", reason: `portée du skill incompatible avec le service '${opts.serviceId}'.` };
  }
  if (skill.status !== "AVAILABLE") {
    return { skillId: skill.skillId, accepted: false, rejectionCode: "STATUS_NOT_AVAILABLE", reason: `status=${skill.status}.` };
  }
  if (!hasValidProof(skill.proofRefs)) {
    return { skillId: skill.skillId, accepted: false, rejectionCode: "PROOF_MISSING", reason: "aucune preuve valide dans proofRefs." };
  }
  const deps = registry.getSkillDependencies(skill.skillId);
  if (deps.missing.length > 0) {
    return { skillId: skill.skillId, accepted: false, rejectionCode: "DEPENDENCY_MISSING", reason: `dépendance(s) non enregistrée(s) : ${deps.missing.join(", ")}.` };
  }
  if (!skill.dependencies.every((depId) => isSkillUsable(registry, depId, new Set([skill.skillId])))) {
    return { skillId: skill.skillId, accepted: false, rejectionCode: "DEPENDENCY_MISSING", reason: "dépendance déclarée mais non AVAILABLE/prouvée (ou cycle)." };
  }
  if (opts.areToolsAvailable && !opts.areToolsAvailable(skill.toolsRequired)) {
    return { skillId: skill.skillId, accepted: false, rejectionCode: "TOOLS_UNAVAILABLE", reason: `outil(s) requis indisponible(s) : ${skill.toolsRequired.join(", ")}.` };
  }
  if (opts.isPermissionGranted && !opts.isPermissionGranted(skill.permissionLevel)) {
    return { skillId: skill.skillId, accepted: false, rejectionCode: "PERMISSION_DENIED", reason: `permission requise non accordée : ${skill.permissionLevel}.` };
  }
  return { skillId: skill.skillId, accepted: true };
}

/**
 * Résout une capacité vers un skill sélectionné, en essayant chaque candidat
 * dans l'ordre d'enregistrement puis, si aucun ne convient, en suivant la
 * chaîne `fallbackSkillId` explicite de chaque candidat tenté (§PHASE 5/6).
 */
export function resolveCapability(registry: SkillCapabilityRegistry, capabilityId: string, opts: ResolveOptions = {}): ResolutionResult {
  const attempts: ResolutionAttempt[] = [];
  const attemptedIds = new Set<string>();
  const queue: string[] = registry.findSkillsForCapability(capabilityId).map((s) => s.skillId);

  while (queue.length > 0) {
    const skillId = queue.shift()!;
    if (attemptedIds.has(skillId)) continue;
    attemptedIds.add(skillId);
    const skill = registry.getSkill(skillId);
    if (!skill) continue;

    const attempt = evaluate(registry, skill, opts);
    attempts.push(attempt);
    if (attempt.accepted) {
      return { capabilityId, resolved: true, selectedSkillId: skill.skillId, attempts };
    }
    if (skill.fallbackSkillId) queue.push(skill.fallbackSkillId);
  }

  return { capabilityId, resolved: false, attempts };
}
