/**
 * Source de vérité unique des limites de Repository Intelligence.
 * Toute troncature doit être signalée via `truncated`/`warnings` plutôt que
 * silencieusement masquée — même contrat que le Document & Data Workbench.
 */
export const REPOSITORY_INTELLIGENCE_LIMITS = Object.freeze({
  TREE_MAX_ENTRIES: 2_000,

  FILE_MAX_TEXT_CHARS: 60_000,

  MULTI_FILE_MAX_FILES: 10,
  MULTI_FILE_MAX_TOTAL_CHARS: 150_000,

  PATH_SEARCH_MAX_RESULTS: 100,

  CODE_SEARCH_MAX_RESULTS: 50,
  CODE_SEARCH_MAX_FILES_SCANNED: 60,
  CODE_SEARCH_MAX_BYTES_SCANNED: 2_000_000,
  CODE_SEARCH_PER_FILE_MAX_BYTES: 300_000,
  CODE_SEARCH_CONTEXT_CHARS: 160,

  PR_MAX_FILES: 100,
  PR_BODY_MAX_CHARS: 20_000,

  DIFF_MAX_CHARS: 100_000,
  PATCH_MAX_CHARS_PER_FILE: 20_000,

  COMMIT_MAX_FILES: 100,

  CONTEXT_MAX_SNIPPETS: 8,
  CONTEXT_SNIPPET_MAX_CHARS: 4_000,
  CONTEXT_TOTAL_MAX_CHARS: 24_000,

  AUDIT_MAX_FILES: 40,
  AUDIT_MAX_FINDINGS: 100,
});

/** Erreur stable : le message porte le code, jamais de texte libre imprévisible. */
export function repositoryIntelligenceError(code: string): Error {
  return new Error(code);
}
