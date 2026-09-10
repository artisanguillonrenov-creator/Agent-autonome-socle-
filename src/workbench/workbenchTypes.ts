import { isAbsolute, normalize, resolve, relative, sep } from "node:path";
import { lstatSync, statSync } from "node:fs";
import { WorkspaceStore } from "../workspaces/workspaceStore.js";

export const WORKBENCH_ERRORS = {
  WORKBENCH_PATH_OUTSIDE_WORKSPACE: "WORKBENCH_PATH_OUTSIDE_WORKSPACE",
  DOCUMENT_FORMAT_UNSUPPORTED: "DOCUMENT_FORMAT_UNSUPPORTED",
  DOCUMENT_TOO_LARGE: "DOCUMENT_TOO_LARGE",
  DOCUMENT_OCR_REQUIRED: "DOCUMENT_OCR_REQUIRED",
  DOCUMENT_PARSE_FAILED: "DOCUMENT_PARSE_FAILED",
  SPREADSHEET_FORMAT_UNSUPPORTED: "SPREADSHEET_FORMAT_UNSUPPORTED",
  SPREADSHEET_RANGE_INVALID: "SPREADSHEET_RANGE_INVALID",
  SPREADSHEET_LIMIT_EXCEEDED: "SPREADSHEET_LIMIT_EXCEEDED",
  DATASET_LIMIT_EXCEEDED: "DATASET_LIMIT_EXCEEDED",
  DATA_COLUMN_NOT_FOUND: "DATA_COLUMN_NOT_FOUND",
  DATA_TYPE_UNSUPPORTED: "DATA_TYPE_UNSUPPORTED",
  DATABASE_NOT_FOUND: "DATABASE_NOT_FOUND",
  DATABASE_QUERY_NOT_READ_ONLY: "DATABASE_QUERY_NOT_READ_ONLY",
  DATABASE_QUERY_INVALID: "DATABASE_QUERY_INVALID",
  REPORT_GENERATION_FAILED: "REPORT_GENERATION_FAILED",
} as const;

export type WorkbenchErrorCode = keyof typeof WORKBENCH_ERRORS;

export function resolveWorkspacePath(
  workspaceStore: WorkspaceStore,
  workspaceId: string,
  relativePath: string,
  options: { allowMissing?: boolean } = {}
): { relativePath: string; absolutePath: string } {
  if (!workspaceId || typeof workspaceId !== "string") {
    throw new Error(WORKBENCH_ERRORS.WORKBENCH_PATH_OUTSIDE_WORKSPACE);
  }

  if (!relativePath || typeof relativePath !== "string") {
    throw new Error(WORKBENCH_ERRORS.WORKBENCH_PATH_OUTSIDE_WORKSPACE);
  }

  const trimmed = relativePath.trim();

  if (
    trimmed.startsWith("file://") ||
    trimmed.startsWith("http://") ||
    trimmed.startsWith("https://") ||
    trimmed.includes("\0") ||
    isAbsolute(trimmed)
  ) {
    throw new Error(WORKBENCH_ERRORS.WORKBENCH_PATH_OUTSIDE_WORKSPACE);
  }

  const workspace = workspaceStore.get(workspaceId);
  if (!workspace) {
    throw new Error(WORKBENCH_ERRORS.WORKBENCH_PATH_OUTSIDE_WORKSPACE);
  }

  const workspaceRoot = resolve(workspaceStore.root, workspaceId);

  const normalizedRel = normalize(trimmed).replace(/\\/g, "/");
  if (
    normalizedRel.startsWith("../") ||
    normalizedRel === ".." ||
    normalizedRel.startsWith("/..") ||
    isAbsolute(normalizedRel)
  ) {
    throw new Error(WORKBENCH_ERRORS.WORKBENCH_PATH_OUTSIDE_WORKSPACE);
  }

  const absoluteTarget = resolve(workspaceRoot, normalizedRel);
  const relCheck = relative(workspaceRoot, absoluteTarget);

  if (
    !relCheck ||
    relCheck === ".." ||
    relCheck.startsWith(`..${sep}`) ||
    relCheck.startsWith("../") ||
    isAbsolute(relCheck)
  ) {
    throw new Error(WORKBENCH_ERRORS.WORKBENCH_PATH_OUTSIDE_WORKSPACE);
  }

  try {
    let cursor = workspaceRoot;
    const parts = relCheck.split(sep);
    for (let i = 0; i < parts.length; i++) {
      cursor = resolve(cursor, parts[i]);
      try {
        const lstat = lstatSync(cursor);
        if (lstat.isSymbolicLink()) {
          throw new Error(WORKBENCH_ERRORS.WORKBENCH_PATH_OUTSIDE_WORKSPACE);
        }
      } catch (e: any) {
        if (e?.message === WORKBENCH_ERRORS.WORKBENCH_PATH_OUTSIDE_WORKSPACE) {
          throw e;
        }
        if (e?.code === "ENOENT") {
          if (options.allowMissing) {
            break;
          } else {
            throw new Error(WORKBENCH_ERRORS.WORKBENCH_PATH_OUTSIDE_WORKSPACE);
          }
        }
        throw new Error(WORKBENCH_ERRORS.WORKBENCH_PATH_OUTSIDE_WORKSPACE);
      }
    }
  } catch (e: any) {
    if (Object.values(WORKBENCH_ERRORS).includes(e?.message)) {
      throw e;
    }
    throw new Error(WORKBENCH_ERRORS.WORKBENCH_PATH_OUTSIDE_WORKSPACE);
  }

  return {
    relativePath: normalizedRel,
    absolutePath: absoluteTarget
  };
}

// Document Engine Types
export type DocumentFormat = "txt" | "markdown" | "json" | "csv" | "html" | "pdf";

export interface DocumentSection {
  index: number;
  title?: string;
  page?: number;
  startOffset?: number;
  endOffset?: number;
  text: string;
}

export interface DocumentResult {
  documentId: string;
  workspaceId: string;
  path: string;
  format: DocumentFormat;
  sizeBytes: number;
  pageCount?: number;
  title?: string;
  metadata: Record<string, unknown>;
  text?: string;
  sections?: DocumentSection[];
  truncated: boolean;
  warnings: string[];
}

export interface DocumentSearchMatch {
  page?: number;
  section?: number;
  offset?: number;
  matchedText: string;
  excerpt: string;
}

export interface DocumentSearchOptions {
  query: string;
  caseSensitive?: boolean;
  maxResults?: number;
  contextChars?: number;
}

// Spreadsheet Engine Types
export type ColumnType =
  | "STRING"
  | "INTEGER"
  | "FLOAT"
  | "BOOLEAN"
  | "DATE"
  | "DATETIME"
  | "MIXED"
  | "EMPTY";

export interface SpreadsheetInspectResult {
  file: string;
  format: "csv" | "tsv" | "xlsx";
  sheetNames: string[];
  rowCount: number;
  columnCount: number;
  columns: string[];
  inferredTypes: Record<string, ColumnType>;
  /**
   * Empty-cell count observed within the bounded inspection sample only
   * (see warnings when rowCount exceeds the sample size) — never the
   * exact total for the whole sheet.
   */
  sampledEmptyCells: number;
  sampleRows: Record<string, unknown>[];
  warnings: string[];
}

export interface ReadRangeOptions {
  sheet?: string;
  startRow?: number;
  endRow?: number;
  columns?: string[];
}

export interface RangeResult {
  sheet: string;
  columns: string[];
  rows: Record<string, unknown>[];
  totalRows: number;
  /** False when totalRows is a known lower bound rather than the exact total. */
  totalRowsKnown: boolean;
  truncated: boolean;
  warnings: string[];
}

export type FilterOperator =
  | "equals"
  | "notEquals"
  | "contains"
  | "startsWith"
  | "endsWith"
  | "greaterThan"
  | "greaterOrEqual"
  | "lessThan"
  | "lessOrEqual"
  | "isEmpty"
  | "isNotEmpty";

export interface FilterCondition {
  column: string;
  operator: FilterOperator;
  value?: unknown;
}

export interface SortCondition {
  column: string;
  direction: "ASC" | "DESC";
}

export type AggregateFunction = "COUNT" | "SUM" | "MEAN" | "MIN" | "MAX";

export interface AggregateOptions {
  function: AggregateFunction;
  valueColumn?: string;
  groupBy?: string;
}

// Data Analysis Engine Types
export interface NumericDescribe {
  count: number;
  missing: number;
  min: number;
  max: number;
  mean: number;
  median: number;
  stddev: number;
}

export interface StringDescribe {
  count: number;
  missing: number;
  unique: number;
  topValues: { value: string; count: number }[];
}

export interface DateDescribe {
  minDate: string;
  maxDate: string;
  count: number;
  missing: number;
}

export interface DescribeResult {
  numericColumns: Record<string, NumericDescribe>;
  stringColumns: Record<string, StringDescribe>;
  dateColumns: Record<string, DateDescribe>;
  totalRows: number;
}

export interface MissingValueResult {
  column: string;
  missingCount: number;
  missingPercentage: number;
}

export interface DuplicateResult {
  duplicateCount: number;
  sampleRows: Record<string, unknown>[];
  truncated: boolean;
}

export interface OutlierResult {
  column: string;
  q1: number;
  q3: number;
  iqr: number;
  lowerBound: number;
  upperBound: number;
  count: number;
  sample: unknown[];
}

export interface CorrelationResult {
  columnA: string;
  columnB: string;
  coefficient: number;
  sampleSize: number;
}

export type TimeSeriesGranularity = "DAY" | "WEEK" | "MONTH" | "YEAR";

export interface TimeSeriesPoint {
  period: string;
  count: number;
  sum?: number;
  mean?: number;
  min?: number;
  max?: number;
}

export interface TimeSeriesResult {
  dateColumn: string;
  valueColumn?: string;
  granularity: TimeSeriesGranularity;
  points: TimeSeriesPoint[];
  truncated: boolean;
  totalResults: number;
  returnedResults: number;
}

export interface GroupByResult {
  rows: Record<string, unknown>[];
  truncated: boolean;
  totalResults: number;
  returnedResults: number;
}

export interface DistributionResult {
  column: string;
  distribution: { value: string; count: number; percentage: number }[];
  truncated: boolean;
  totalResults: number;
  returnedResults: number;
}

export interface BoundedDatasetResult {
  rows: Record<string, unknown>[];
  truncated: boolean;
  totalResults: number;
  returnedResults: number;
}

// Database Query Engine Types
export interface TableColumnDescription {
  name: string;
  type: string;
  notNull: boolean;
  defaultValue: unknown;
  primaryKey: boolean;
}

export interface TableDescription {
  tableName: string;
  columns: TableColumnDescription[];
  rowCount?: number;
}

export interface DatabaseQueryResult {
  columns: string[];
  rows: Record<string, unknown>[];
  rowCount: number;
  truncated: boolean;
  executionMs: number;
  source: string;
}

// Report Engine Types
export interface Finding {
  severity?: "LOW" | "MEDIUM" | "HIGH" | "CRITICAL" | "INFO";
  title: string;
  evidence?: string;
  recommendation?: string;
}

export interface Provenance {
  workspaceId: string;
  path: string;
  page?: number;
  sheet?: string;
  rows?: string | number[];
  columns?: string[];
  query?: string;
}

export interface ReportSection {
  title: string;
  content: string;
  provenance?: Provenance[];
}

export interface ReportStructure {
  title: string;
  summary: string;
  sections: ReportSection[];
  tables: { title: string; columns: string[]; rows: (string | number | boolean | null)[][] }[];
  findings: Finding[];
  sources: Provenance[];
  generatedAt: number;
}

export interface GeneratedReportResult {
  reportId: string;
  workspaceId: string;
  title: string;
  format: "markdown" | "json" | "csv";
  content: string;
  artifactId?: string;
  relativePath?: string;
  sizeBytes: number;
  sources: Provenance[];
}
