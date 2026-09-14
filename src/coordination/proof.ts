/**
 * Standardisation de la preuve (chantier Skills & Capabilities, plan V5
 * "PHASE 7"). PR-E a déjà posé la règle non contournable — `proofRef`
 * obligatoire pour `status="AVAILABLE"` (capabilityManifest.ts) — ce module
 * ne la réécrit pas : il définit uniquement la *forme* d'une preuve
 * (source + référence + horodatage) que `proofRef`/`proofRefs` doivent
 * respecter, et un unique point de vérité pour juger si une preuve est
 * recevable.
 *
 * "Le fichier existe" n'est jamais une preuve de fonctionnement (§PHASE 7) :
 * ce module n'inspecte jamais le système de fichiers lui-même — il ne fait
 * que valider la *structure* d'un enregistrement de preuve déjà produit par
 * un test réel, un probe réel, une exécution CI réelle ou une validation
 * humaine/externe réelle.
 */

/** Sources de preuve reconnues (plan V5 §PHASE 7). */
export const PROOF_SOURCES = ["TEST", "PROBE", "CI", "HUMAN_VALIDATION", "EXTERNAL_VERIFICATION"] as const;
export type ProofSource = (typeof PROOF_SOURCES)[number];
export const PROOF_SOURCE_SET: ReadonlySet<ProofSource> = new Set(PROOF_SOURCES);

/**
 * Un enregistrement de preuve compatible avec `proofRef` (capabilityManifest.ts,
 * chaîne unique) et `proofRefs` (skillManifest.ts, plusieurs preuves possibles) :
 * `toProofRef()` produit la chaîne stockée dans ces champs, `parseProofRef()`
 * fait le chemin inverse pour un consommateur qui a besoin de la structure.
 */
export interface ProofRecord {
  source: ProofSource;
  /** Référence humainement vérifiable : chemin de test, id de probe, run CI, ticket humain, source externe. */
  ref: string;
  recordedAt: number;
}

export class ProofRecordInvalidError extends Error {
  readonly code = "PROOF_RECORD_INVALID" as const;
  constructor(message: string) {
    super(`PROOF_RECORD_INVALID : ${message}`);
    this.name = "ProofRecordInvalidError";
  }
}

export function defineProof(input: { source: ProofSource; ref: string; recordedAt?: number }): ProofRecord {
  if (!PROOF_SOURCE_SET.has(input.source)) {
    throw new ProofRecordInvalidError(`source invalide : ${JSON.stringify(input.source)}.`);
  }
  if (!input.ref?.trim()) {
    throw new ProofRecordInvalidError("ref est obligatoire (une preuve sans référence vérifiable n'est pas une preuve).");
  }
  return { source: input.source, ref: input.ref.trim(), recordedAt: input.recordedAt ?? Date.now() };
}

const PROOF_REF_SEPARATOR = ":";

/** Sérialise vers le format `SOURCE:ref` stocké par `proofRef`/`proofRefs`. */
export function toProofRef(proof: ProofRecord): string {
  return `${proof.source}${PROOF_REF_SEPARATOR}${proof.ref}`;
}

/** Reconstruit un `ProofRecord` (sans `recordedAt`, non porté par la chaîne) depuis un `proofRef`. */
export function parseProofRef(proofRef: string): Pick<ProofRecord, "source" | "ref"> | null {
  const idx = proofRef.indexOf(PROOF_REF_SEPARATOR);
  if (idx <= 0) return null;
  const source = proofRef.slice(0, idx);
  const ref = proofRef.slice(idx + 1);
  if (!PROOF_SOURCE_SET.has(source as ProofSource) || !ref.trim()) return null;
  return { source: source as ProofSource, ref: ref.trim() };
}

/** Un `proofRef` est recevable s'il est non vide et respecte le format `SOURCE:ref` d'une source reconnue. */
export function isValidProofRef(proofRef: string | undefined): boolean {
  if (!proofRef?.trim()) return false;
  return parseProofRef(proofRef) !== null;
}

/** Au moins une preuve recevable dans la liste — utilisé pour `proofRefs` (skills, plusieurs preuves possibles). */
export function hasValidProof(proofRefs: readonly string[] | undefined): boolean {
  return !!proofRefs && proofRefs.some((ref) => isValidProofRef(ref));
}
