/**
 * Source de vérité unique des limites V1 du Document & Data Workbench.
 * Toute troncature doit être signalée via `truncated`/`totalRowsKnown`/`warnings`
 * plutôt que silencieusement masquée.
 */
export const WORKBENCH_LIMITS = Object.freeze({
  INPUT_FILE_MAX_BYTES: 25 * 1024 * 1024,
  DOCUMENT_MAX_TEXT_CHARS: 2_000_000,
  DOCUMENT_MAX_SEARCH_RESULTS: 100,

  SPREADSHEET_MAX_ROWS_PER_READ: 10_000,
  SPREADSHEET_MAX_COLUMNS: 200,
  SPREADSHEET_MAX_CELLS_PER_READ: 250_000,
  SPREADSHEET_INSPECT_SAMPLE_ROWS: 500,

  /** Préflight anti zip-bomb sur le conteneur XLSX, avant toute décompression par ExcelJS. */
  SPREADSHEET_XLSX_MAX_TOTAL_UNCOMPRESSED_BYTES: 500 * 1024 * 1024,
  SPREADSHEET_XLSX_MAX_ENTRY_UNCOMPRESSED_BYTES: 250 * 1024 * 1024,
  SPREADSHEET_XLSX_MAX_COMPRESSION_RATIO: 100,

  ANALYSIS_MAX_ROWS: 50_000,
  ANALYSIS_MAX_COLUMNS: 200,
  ANALYSIS_MAX_CELLS: 5_000_000,
  ANALYSIS_MAX_RESULTS: 1_000,

  DATABASE_MAX_RESULT_ROWS: 1_000,
});

/** Erreur stable : le message porte le code, jamais de texte libre imprévisible. */
export function workbenchError(code: string): Error {
  return new Error(code);
}

const NON_FINITE_STRINGS = /^[+-]?(Infinity|NaN)$/i;

/**
 * Coercition numérique stricte : rejette explicitement les booléens, les
 * chaînes vides, et les représentations textuelles de NaN/Infinity — même
 * si `Number("Infinity")` vaudrait `Infinity` en JS natif.
 */
export function toFiniteNumberOrNull(value: unknown): number | null {
  if (typeof value === "number") return Number.isFinite(value) ? value : null;
  if (typeof value === "boolean") return null;
  if (typeof value === "string") {
    const trimmed = value.trim();
    if (!trimmed || NON_FINITE_STRINGS.test(trimmed)) return null;
    const n = Number(trimmed);
    return Number.isFinite(n) ? n : null;
  }
  return null;
}

/** Garantit qu'un résultat numérique public est fini ; sinon erreur stable DATA_NUMERIC_OVERFLOW. */
export function assertFiniteResult(value: number): number {
  if (!Number.isFinite(value)) throw workbenchError("DATA_NUMERIC_OVERFLOW");
  return value;
}
