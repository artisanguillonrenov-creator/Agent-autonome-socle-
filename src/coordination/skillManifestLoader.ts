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
 *
 * AUTO-ATTESTATION INTERDITE (audit ChatGPT #90, point 1) : un manifeste
 * externe n'est jamais une source de confiance pour `status="AVAILABLE"` —
 * `defineSkill` vérifie seulement la FORME d'un `proofRef` (`SOURCE:ref`),
 * jamais qu'il correspond à une preuve réellement vérifiée. Un manifeste
 * externe demandant AVAILABLE est donc systématiquement dégradé en
 * NOT_TESTED, SAUF si l'appelant injecte un `verifyProofRef` (source de
 * confiance : exécution effective d'un probe/test, jamais une simple
 * validation de format) qui confirme au moins une des `proofRefs`
 * revendiquées. `REAL_SKILL_CATALOG` (skillCatalog.ts) n'est PAS chargé par
 * ce module — c'est un catalogue interne que nous avons nous-mêmes audité
 * (defineSkill() direct), donc intrinsèquement de confiance ; cette règle ne
 * le concerne pas et ne le modifie pas.
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

export interface SkillManifestDowngrade {
  index: number;
  skillId: string;
  requestedStatus: "AVAILABLE";
  appliedStatus: "NOT_TESTED";
  reason: string;
}

export interface SkillManifestLoadResult {
  registered: SkillDescriptor[];
  categories: Record<string, CodingSkillCategory>;
  errors: SkillManifestLoadError[];
  /** Entrées demandant AVAILABLE que ce chargeur a dégradées en NOT_TESTED faute de preuve vérifiée — jamais silencieux. */
  downgrades: SkillManifestDowngrade[];
}

/**
 * Vérifie qu'un `proofRef` déclaré par un manifeste externe correspond à une
 * preuve RÉELLEMENT vérifiée (probe exécuté, test réellement lancé, CI réelle,
 * validation humaine/externe tracée) — jamais une simple relecture du format
 * `SOURCE:ref` (déjà fait par `proof.ts#isValidProofRef`, purement syntaxique).
 * Retourne `true` seulement si cette preuve précise a été confirmée de confiance.
 */
export type VerifyProofRefFn = (proofRef: string, entry: SkillManifestEntry) => boolean;

export interface LoadSkillManifestOptions {
  /**
   * Source de confiance pour valider les `proofRefs` d'un manifeste externe.
   * Omis => AUCUNE preuve externe n'est jamais considérée vérifiée : tout
   * AVAILABLE demandé par un manifeste est dégradé en NOT_TESTED (jamais
   * refusé/perdu — juste jamais faussement crédité d'une preuve non vérifiée).
   */
  verifyProofRef?: VerifyProofRefFn;
}

/**
 * Valide et enregistre chaque entrée du manifeste dans le registre fourni.
 * Ne s'arrête jamais à la première erreur (un manifeste de 50 skills externes
 * avec une entrée invalide ne doit pas bloquer les 49 autres) — mais
 * n'enregistre JAMAIS une entrée qui a échoué sa validation, et ne fait
 * JAMAIS confiance à un AVAILABLE auto-déclaré sans preuve vérifiée par
 * `verifyProofRef` (voir en-tête de fichier).
 */
export function loadSkillManifest(entries: readonly SkillManifestEntry[], registry: SkillCapabilityRegistry, options: LoadSkillManifestOptions = {}): SkillManifestLoadResult {
  const registered: SkillDescriptor[] = [];
  const categories: Record<string, CodingSkillCategory> = {};
  const errors: SkillManifestLoadError[] = [];
  const downgrades: SkillManifestDowngrade[] = [];

  entries.forEach((entry, index) => {
    if (!CODING_SKILL_CATEGORY_SET.has(entry.category)) {
      errors.push({ index, skillId: entry.skillId, message: `category invalide : ${JSON.stringify(entry.category)}.` });
      return;
    }
    try {
      const { category: _category, ...input } = entry;
      let effectiveInput = input;

      if (input.status === "AVAILABLE") {
        const verifier = options.verifyProofRef;
        const verifiedByTrust = !!verifier && input.proofRefs.some((ref) => verifier(ref, entry));
        if (!verifiedByTrust) {
          effectiveInput = { ...input, status: "NOT_TESTED" };
          downgrades.push({
            index,
            skillId: input.skillId,
            requestedStatus: "AVAILABLE",
            appliedStatus: "NOT_TESTED",
            reason: verifier ? "aucune proofRef confirmée par verifyProofRef — auto-attestation externe jamais acceptée." : "aucun verifyProofRef fourni — AVAILABLE externe jamais accepté sans source de confiance.",
          });
        }
      }

      const descriptor = defineSkill(effectiveInput);
      registry.registerSkill(descriptor);
      registered.push(descriptor);
      categories[descriptor.skillId] = entry.category;
    } catch (err) {
      errors.push({ index, skillId: entry.skillId, message: err instanceof Error ? err.message : String(err) });
    }
  });

  return { registered, categories, errors, downgrades };
}
