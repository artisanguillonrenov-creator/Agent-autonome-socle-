/**
 * Registre logique commun des SkillDescriptor (chantier Skills &
 * Capabilities, plan V5 §PHASE 4). Indépendant de tout modèle IA — aucun
 * appel LLM, aucune dépendance réseau : une simple table en mémoire que
 * n'importe quel service peut peupler au démarrage (comme ServiceRegistry
 * lit config/services.json) et interroger de façon déterministe.
 *
 * Ne remplace PAS src/skills/registry.ts (`SkillRegistry`, le registre
 * runtime des tools exposés au LLM) : celui-ci gouverne quels
 * SkillDescriptor existent, quel statut/preuve ils portent et comment ils se
 * dédupliquent — la couche JARVIS-00, pas la couche d'exécution.
 */

import type { SkillDescriptor, SkillServiceScope } from "./skillManifest.js";
import { parseProofRef, type ProofRecord } from "./proof.js";
import { type DeduplicationVerdict } from "./remediation.js";

export class DuplicateSkillError extends Error {
  readonly code = "DUPLICATE_SKILL" as const;
  constructor(readonly skillId: string) {
    super(`DUPLICATE_SKILL : un skill '${skillId}' est déjà enregistré.`);
    this.name = "DuplicateSkillError";
  }
}

export class SkillNotFoundError extends Error {
  readonly code = "SKILL_NOT_FOUND" as const;
  constructor(readonly skillId: string) {
    super(`SKILL_NOT_FOUND : ${skillId}.`);
    this.name = "SkillNotFoundError";
  }
}

export interface SkillDuplicateGroup {
  skillIds: string[];
  sharedCapabilities: string[];
  verdict: DeduplicationVerdict;
  reason: string;
}

export interface SkillDependencyReport {
  skillId: string;
  dependencies: string[];
  resolved: string[];
  missing: string[];
}

function scopeOverlaps(a: SkillServiceScope, b: SkillServiceScope): boolean {
  if (a.type === "TRANSVERSAL" || b.type === "TRANSVERSAL") return true;
  const idsOf = (s: SkillServiceScope): string[] => (s.type === "SINGLE_SERVICE" ? [s.serviceId] : s.type === "MULTI_SERVICE" ? [...s.serviceIds] : []);
  const setA = new Set(idsOf(a));
  return idsOf(b).some((id) => setA.has(id));
}

function sameSet(a: readonly string[], b: readonly string[]): boolean {
  if (a.length !== b.length) return false;
  const setA = new Set(a);
  return b.every((x) => setA.has(x));
}

/**
 * Table en mémoire des SkillDescriptor déjà validés par `defineSkill`
 * (skillManifest.ts) — ce registre ne revalide pas les champs, il indexe et
 * interroge (register_skill/get_skill/.../detect_missing_capabilities,
 * plan V5 §PHASE 4).
 */
export class SkillCapabilityRegistry {
  private readonly skills = new Map<string, SkillDescriptor>();

  registerSkill(skill: SkillDescriptor): void {
    if (this.skills.has(skill.skillId)) throw new DuplicateSkillError(skill.skillId);
    this.skills.set(skill.skillId, skill);
  }

  getSkill(skillId: string): SkillDescriptor | undefined {
    return this.skills.get(skillId);
  }

  listSkills(): SkillDescriptor[] {
    return [...this.skills.values()];
  }

  findSkillsForCapability(capabilityId: string): SkillDescriptor[] {
    return this.listSkills().filter((s) => s.capabilitiesProvided.includes(capabilityId));
  }

  findSkillsForService(serviceId: string): SkillDescriptor[] {
    return this.listSkills().filter((s) => {
      const scope = s.serviceScope;
      if (scope.type === "TRANSVERSAL") return true;
      if (scope.type === "SINGLE_SERVICE") return scope.serviceId === serviceId;
      return scope.serviceIds.includes(serviceId);
    });
  }

  getSkillStatus(skillId: string): SkillDescriptor["status"] {
    const skill = this.skills.get(skillId);
    if (!skill) throw new SkillNotFoundError(skillId);
    return skill.status;
  }

  /** Dépendances déclarées + lesquelles sont réellement enregistrées (`missing` alimente DEPENDENCY_MISSING côté resolver). */
  getSkillDependencies(skillId: string): SkillDependencyReport {
    const skill = this.skills.get(skillId);
    if (!skill) throw new SkillNotFoundError(skillId);
    const resolved = skill.dependencies.filter((id) => this.skills.has(id));
    const missing = skill.dependencies.filter((id) => !this.skills.has(id));
    return { skillId, dependencies: [...skill.dependencies], resolved, missing };
  }

  /** Preuves du skill, structurées (`SOURCE:ref` déjà validé par defineSkill) plus les chaînes brutes non reconnues (le cas échéant). */
  getSkillProof(skillId: string): { records: ProofRecord[]; raw: string[] } {
    const skill = this.skills.get(skillId);
    if (!skill) throw new SkillNotFoundError(skillId);
    const records: ProofRecord[] = [];
    for (const ref of skill.proofRefs) {
      const parsed = parseProofRef(ref);
      if (parsed) records.push({ ...parsed, recordedAt: skill.lastVerifiedAt ?? skill.schemaVersion });
    }
    return { records, raw: [...skill.proofRefs] };
  }

  /**
   * Deux skills sont candidats à la déduplication (§PHASE 17) s'ils portent
   * exactement le même ensemble de capabilitiesProvided sur des portées de
   * service qui se recoupent. Ne décide JAMAIS MERGE/REMOVE_LATER seul :
   * sans preuve d'usage réel des deux côtés, le verdict reste UNKNOWN — un
   * humain (ou le rapport de gap analysis, §PHASE 9) tranche.
   */
  detectSkillDuplicates(): SkillDuplicateGroup[] {
    const all = this.listSkills();
    const groups: SkillDuplicateGroup[] = [];
    const seen = new Set<string>();
    for (let i = 0; i < all.length; i++) {
      for (let j = i + 1; j < all.length; j++) {
        const a = all[i]!;
        const b = all[j]!;
        const pairKey = [a.skillId, b.skillId].sort().join("|");
        if (seen.has(pairKey)) continue;
        if (!sameSet(a.capabilitiesProvided, b.capabilitiesProvided)) continue;
        if (a.capabilitiesProvided.length === 0) continue;
        if (!scopeOverlaps(a.serviceScope, b.serviceScope)) continue;
        seen.add(pairKey);
        const bothLegacyOrDeprecated = (s: SkillDescriptor) => s.status === "DEPRECATED";
        const verdict: DeduplicationVerdict =
          a.status === "DEPRECATED" || b.status === "DEPRECATED" ? "DEPRECATE" : bothLegacyOrDeprecated(a) && bothLegacyOrDeprecated(b) ? "REMOVE_LATER" : "UNKNOWN";
        groups.push({
          skillIds: [a.skillId, b.skillId],
          sharedCapabilities: [...a.capabilitiesProvided],
          verdict,
          reason:
            verdict === "DEPRECATE"
              ? `'${a.skillId}'/'${b.skillId}' couvrent exactement les mêmes capacités et au moins un est DEPRECATED.`
              : `'${a.skillId}'/'${b.skillId}' couvrent exactement les mêmes capacités sur des portées qui se recoupent — vérifier l'usage réel avant fusion.`,
        });
      }
    }
    return groups;
  }

  /** Capacités demandées qu'aucun skill enregistré (quel que soit son statut) ne dit fournir — alimente le gap MISSING (§PHASE 9). */
  detectMissingCapabilities(requiredCapabilityIds: readonly string[]): string[] {
    const covered = new Set(this.listSkills().flatMap((s) => s.capabilitiesProvided));
    return requiredCapabilityIds.filter((id) => !covered.has(id));
  }
}
