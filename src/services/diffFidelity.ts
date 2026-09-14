/**
 * Diff/Fidelity control (JARVIS-00 gap analysis, PR-D) — pure fonctions, sans
 * aucun appel réseau ni GitHub. `checkDiffFidelity` est le garde-fou appelé
 * par `SoftwareFactoryService.executeWorkflow()` juste avant toute écriture
 * GitHub (cf. commentaire "4c." dans softwareFactoryService.ts), au même
 * titre et au même endroit que le secret guard (PR-B) et la protection de
 * base obsolète (PR-B).
 *
 * Ce dépôt remplace toujours le fichier entier plutôt que de patcher une
 * plage de lignes (constat de l'audit JARVIS-00) : il n'existe donc pas de
 * "diff demandé" à comparer à un "diff produit". Le garde-fou déterministe
 * possible dans cette architecture est de comparer le contenu original au
 * contenu final et de rejeter les transitions structurellement suspectes
 * (fichier inattendu, création qui écraserait un existant, vidage de
 * contenu, réécriture qui ne conserve presque aucune ligne d'origine) —
 * sans jamais avoir besoin d'un LLM ou d'un round-trip réseau pour trancher.
 */

export type FileChangeType = "created" | "modified" | "deleted";
export type FidelityStatus = "PASS" | "FAIL";

export interface FileDiffEntry {
  path: string;
  changeType: FileChangeType;
  additions: number;
  deletions: number;
}

/**
 * Contrat structuré exploitable par JARVIS-00/Reviewer Gate. `files` reste un
 * tableau (même si ce service ne traite qu'un fichier par tâche aujourd'hui)
 * pour ne pas devoir changer ce contrat le jour où plusieurs fichiers seront
 * traités dans une même opération.
 */
export interface DiffFidelityResult {
  files: FileDiffEntry[];
  additions: number;
  deletions: number;
  unexpectedFiles: string[];
  fidelityStatus: FidelityStatus;
  reason: string | null;
}

export interface DiffFidelityInput {
  filePath: string;
  /** Chemin autorisé par la mission. Absent (undefined) : aucune vérification (comportement historique). */
  expectedFilePath?: string;
  fileExistedBefore: boolean;
  /** Intention déclarée par la mission. Absent : aucune vérification création/modification. */
  expectedChangeType?: "create" | "update";
  originalContent: string;
  updatedContent: string;
  /** Échappatoire explicite pour une réécriture complète réellement voulue. */
  allowFullRewrite?: boolean;
}

/**
 * Sous une certaine taille conserve un diff ligne-à-ligne exact (LCS) ; au-delà,
 * bascule sur une estimation grossière (traite comme un remplacement total)
 * plutôt que de payer un coût O(N*M) sur un contenu pathologiquement volumineux.
 * Ce dépôt génère du contenu borné par un budget de tokens LLM ou par
 * `exactContent` (typiquement de l'ordre de quelques centaines à low-milliers
 * de lignes) : ce plafond n'est donc jamais atteint en usage normal.
 */
const MAX_DIFF_CELLS = 4_000_000;

/** Diff ligne-à-ligne dépendance-zéro (LCS dynamique) — additions/deletions exacts. */
export function diffLines(before: string, after: string): { additions: number; deletions: number } {
  if (before === after) return { additions: 0, deletions: 0 };
  const a = before.length ? before.split("\n") : [];
  const b = after.length ? after.split("\n") : [];
  const n = a.length;
  const m = b.length;

  if (n * m > MAX_DIFF_CELLS) {
    // Estimation grossière : traite comme un remplacement total plutôt que de
    // calculer une LCS coûteuse sur un contenu anormalement volumineux.
    return { additions: m, deletions: n };
  }

  const dp: number[][] = Array.from({ length: n + 1 }, () => new Array(m + 1).fill(0));
  for (let i = n - 1; i >= 0; i--) {
    for (let j = m - 1; j >= 0; j--) {
      dp[i][j] = a[i] === b[j] ? dp[i + 1][j + 1] + 1 : Math.max(dp[i + 1][j], dp[i][j + 1]);
    }
  }
  const lcsLength = dp[0][0];
  return { additions: m - lcsLength, deletions: n - lcsLength };
}

/** Part minimale des lignes originales devant être conservées pour qu'une modification ne soit pas considérée comme une réécriture massive injustifiée. */
export const MIN_RETAINED_LINE_RATIO_FOR_MODIFICATION = 0.2;
/** En-dessous de ce nombre de lignes, la proportion conservée n'est pas un signal fiable (trop de variance sur un fichier minuscule). */
const MIN_LINES_FOR_REWRITE_GUARD = 5;

function failure(filePath: string, entries: FileDiffEntry[], reason: string, unexpectedFiles: string[] = []): DiffFidelityResult {
  const additions = entries.reduce((sum, e) => sum + e.additions, 0);
  const deletions = entries.reduce((sum, e) => sum + e.deletions, 0);
  return { files: entries, additions, deletions, unexpectedFiles, fidelityStatus: "FAIL", reason };
}

export function checkDiffFidelity(input: DiffFidelityInput): DiffFidelityResult {
  // 1. Fichier inattendu — la mission n'autorise pas ce chemin.
  if (input.expectedFilePath !== undefined && input.expectedFilePath !== input.filePath) {
    return failure(
      input.filePath,
      [],
      `fichier inattendu : la mission autorise '${input.expectedFilePath}', l'exécution cible '${input.filePath}'.`,
      [input.filePath],
    );
  }

  // 2. Une création ne doit jamais remplacer silencieusement un fichier existant,
  //    et une modification déclarée doit réellement porter sur un fichier existant.
  if (input.expectedChangeType === "create" && input.fileExistedBefore) {
    return failure(
      input.filePath,
      [],
      `création demandée pour '${input.filePath}' mais le fichier existe déjà : une création ne remplace jamais silencieusement un fichier existant.`,
    );
  }
  if (input.expectedChangeType === "update" && !input.fileExistedBefore) {
    return failure(input.filePath, [], `modification demandée pour '${input.filePath}' mais le fichier n'existe pas.`);
  }

  const { additions, deletions } = diffLines(input.originalContent, input.updatedContent);
  const changeType: FileChangeType = input.fileExistedBefore ? "modified" : "created";
  const entry: FileDiffEntry = { path: input.filePath, changeType, additions, deletions };

  // 3. Vidage de contenu jamais silencieux : règle absolue, indépendante de tout seuil.
  if (input.fileExistedBefore && input.updatedContent.trim() === "" && input.originalContent.trim() !== "") {
    return failure(input.filePath, [entry], `le contenu de '${input.filePath}' serait entièrement vidé — suppression non demandée explicitement.`);
  }

  // 4. Réécriture massive injustifiée (couvre aussi "contenu hors périmètre modifié" :
  //    un changement qui ne conserve presque aucune ligne d'origine touche par
  //    construction des portions du fichier qu'une modification ciblée n'aurait
  //    pas dû affecter).
  if (input.fileExistedBefore && !input.allowFullRewrite) {
    const originalLineCount = input.originalContent.length ? input.originalContent.split("\n").length : 0;
    if (originalLineCount > MIN_LINES_FOR_REWRITE_GUARD) {
      const retainedLines = originalLineCount - deletions;
      const retainedRatio = retainedLines / originalLineCount;
      if (retainedRatio < MIN_RETAINED_LINE_RATIO_FOR_MODIFICATION) {
        return failure(
          input.filePath,
          [entry],
          `réécriture massive injustifiée : ${(retainedRatio * 100).toFixed(0)}% des lignes originales de '${input.filePath}' conservées (seuil ${MIN_RETAINED_LINE_RATIO_FOR_MODIFICATION * 100}%). Utiliser allowFullRewrite si une réécriture complète est réellement voulue.`,
        );
      }
    }
  }

  return { files: [entry], additions, deletions, unexpectedFiles: [], fidelityStatus: "PASS", reason: null };
}
