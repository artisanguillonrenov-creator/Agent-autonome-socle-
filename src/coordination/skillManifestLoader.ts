/**
 * Chargeur de manifeste pour skills externes/IA de coding (chantier Skills &
 * Capabilities, plan V5 §PHASE 13). Permet d'ajouter un skill par manifeste
 * (objet ou JSON) sans recoder le cœur (`skillManifest.ts`/`skillRegistry.ts`
 * restent inchangés) : ce module ne fait que valider chaque entrée via
 * `defineSkill` (mêmes règles, y compris "jamais AVAILABLE sans preuve") et
 * l'enregistrer, en accumulant les erreurs sans jamais laisser un
 * enregistrement partiel invalide entrer dans le registre.
 *
 * `category` classe le skill dans l'une des catégories attendues par le plan
 * V5 (architecture, planning, ..., agent engineering) — c'est une métadonnée
 * du CHARGEUR, pas un champ du contrat SkillDescriptor lui-même (qui n'en
 * définit pas), pour ne pas alourdir le contrat central avec un champ que
 * seul ce cas d'usage utilise.
 */

import { defineSkill, type SkillDescriptor, type SkillDescriptorInput } from "./skillManifest.js";
import { SkillCapabilityRegistry } from "./skillRegistry.js";

/** Catégories de skills IA/coding à supporter (plan V5 §PHASE 13) — liste fermée, extensible uniquement ici. */
export const CODING_SKILL_CATEGORIES = [
  "architecture",
  "planning",
  "repository_exploration",
  "implementation",
  "debugging",
  "testing",
  "refactoring",
  "security_review",
  "performance_review",
  "code_review",
  "documentation",
  "dependency_analysis",
  "api_design",
  "database_design",
  "frontend",
  "backend",
  "mobile",
  "devops",
  "ai_ml",
  "prompt_engineering",
  "agent_engineering",
] as const;

export type CodingSkillCategory = (typeof CODING_SKILL_CATEGORIES)[number];
export const CODING_SKILL_CATEGORY_SET: ReadonlySet<CodingSkillCategory> = new Set(CODING_SKILL_CATEGORIES);

export interface SkillManifestEntry extends SkillDescriptorInput {
  category: CodingSkillCategory;
}

export interface SkillManifestLoadError {
  index: number;
  skillId?: string;
  message: string;
}

export interface SkillManifestLoadResult {
  registered: SkillDescriptor[];
  categories: Record<string, CodingSkillCategory>;
  errors: SkillManifestLoadError[];
}

/**
 * Valide et enregistre chaque entrée du manifeste dans le registre fourni.
 * Ne s'arrête jamais à la première erreur (un manifeste de 50 skills externes
 * avec une entrée invalide ne doit pas bloquer les 49 autres) — mais
 * n'enregistre JAMAIS une entrée qui a échoué sa validation.
 */
export function loadSkillManifest(entries: readonly SkillManifestEntry[], registry: SkillCapabilityRegistry): SkillManifestLoadResult {
  const registered: SkillDescriptor[] = [];
  const categories: Record<string, CodingSkillCategory> = {};
  const errors: SkillManifestLoadError[] = [];

  entries.forEach((entry, index) => {
    if (!CODING_SKILL_CATEGORY_SET.has(entry.category)) {
      errors.push({ index, skillId: entry.skillId, message: `category invalide : ${JSON.stringify(entry.category)}.` });
      return;
    }
    try {
      const { category: _category, ...input } = entry;
      const descriptor = defineSkill(input);
      registry.registerSkill(descriptor);
      registered.push(descriptor);
      categories[descriptor.skillId] = entry.category;
    } catch (err) {
      errors.push({ index, skillId: entry.skillId, message: err instanceof Error ? err.message : String(err) });
    }
  });

  return { registered, categories, errors };
}
