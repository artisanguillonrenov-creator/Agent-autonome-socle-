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
 *
 * FAIL-CLOSED (audit ChatGPT #90, point 2) : en mode "EXECUTION" (le défaut —
 * jamais l'inverse implicitement), un skill à `sideEffects=true` sans
 * `isPermissionGranted` injecté, ou un skill avec `toolsRequired` non vide
 * sans `areToolsAvailable` injecté, n'est JAMAIS sélectionné — l'absence de
 * contrôleur n'est jamais interprétée comme une autorisation. Seul le mode
 * "ANALYSIS", choisi explicitement par l'appelant, résout une capacité de
 * façon purement théorique (planification) sans exiger ces contrôleurs — il
 * ne dispense jamais des vérifications de statut/preuve/dépendances, qui
 * restent absolues dans les deux modes.
 */

import type { SkillDescriptor } from "./skillManifest.js";
import { hasValidProof } from "./proof.js";
import { SkillCapabilityRegistry } from "./skillRegistry.js";
import type { PermissionType } from "../orchestration/riskPolicy.js";

export type ResolutionMode = "EXECUTION" | "ANALYSIS";

export type ResolutionRejectionCode =
  | "SCOPE_MISMATCH"
  | "STATUS_NOT_AVAILABLE"
  | "PROOF_MISSING"
  | "DEPENDENCY_MISSING"
  | "DEPENDENCY_CYCLE"
  | "TOOLS_UNAVAILABLE"
  | "TOOLS_CHECK_MISSING"
  | "PERMISSION_DENIED"
  | "PERMISSION_CHECK_MISSING";

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
  /**
   * "EXECUTION" (défaut, fail-closed) : un skill à `sideEffects=true` exige
   * ce contrôleur — son absence rejette le skill (PERMISSION_CHECK_MISSING),
   * jamais une autorisation implicite. "ANALYSIS" : résolution théorique,
   * ce contrôleur est ignoré même fourni.
   */
  isPermissionGranted?: (permission: PermissionType) => boolean;
  /**
   * "EXECUTION" (défaut, fail-closed) : un skill avec `toolsRequired` non vide
   * exige ce contrôleur — son absence rejette le skill (TOOLS_CHECK_MISSING),
   * jamais une disponibilité supposée. "ANALYSIS" : résolution théorique, ce
   * contrôleur est ignoré même fourni.
   */
  areToolsAvailable?: (toolsRequired: readonly string[]) => boolean;
  /**
   * "EXECUTION" (défaut) applique isPermissionGranted/areToolsAvailable en
   * fail-closed. "ANALYSIS" doit être choisi EXPLICITEMENT par l'appelant
   * pour une résolution théorique/planification qui ignore ces deux
   * contrôles (statut/preuve/dépendances restent toujours vérifiés).
   */
  mode?: ResolutionMode;
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
  const mode: ResolutionMode = opts.mode ?? "EXECUTION";

  // ANALYSIS : résolution purement théorique — ces deux contrôles sont ignorés,
  // même si des contrôleurs ont été fournis (choix explicite de l'appelant,
  // jamais un défaut implicite : voir ResolveOptions.mode). Statut/preuve/
  // dépendances, eux, restent vérifiés inconditionnellement au-dessus.
  if (mode === "EXECUTION") {
    if (skill.toolsRequired.length > 0) {
      if (!opts.areToolsAvailable) {
        return { skillId: skill.skillId, accepted: false, rejectionCode: "TOOLS_CHECK_MISSING", reason: `toolsRequired non vide (${skill.toolsRequired.join(", ")}) mais aucun areToolsAvailable fourni — jamais supposé disponible en mode EXECUTION.` };
      }
      if (!opts.areToolsAvailable(skill.toolsRequired)) {
        return { skillId: skill.skillId, accepted: false, rejectionCode: "TOOLS_UNAVAILABLE", reason: `outil(s) requis indisponible(s) : ${skill.toolsRequired.join(", ")}.` };
      }
    }

    if (skill.sideEffects) {
      if (!opts.isPermissionGranted) {
        return { skillId: skill.skillId, accepted: false, rejectionCode: "PERMISSION_CHECK_MISSING", reason: `sideEffects=true (permission ${skill.permissionLevel}) mais aucun isPermissionGranted fourni — jamais autorisé implicitement en mode EXECUTION.` };
      }
      if (!opts.isPermissionGranted(skill.permissionLevel)) {
        return { skillId: skill.skillId, accepted: false, rejectionCode: "PERMISSION_DENIED", reason: `permission requise non accordée : ${skill.permissionLevel}.` };
      }
    } else if (opts.isPermissionGranted && !opts.isPermissionGranted(skill.permissionLevel)) {
      // Un skill sans effet de bord n'EXIGE pas de contrôleur, mais s'il en fournit un, on le respecte quand même.
      return { skillId: skill.skillId, accepted: false, rejectionCode: "PERMISSION_DENIED", reason: `permission requise non accordée : ${skill.permissionLevel}.` };
    }
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
