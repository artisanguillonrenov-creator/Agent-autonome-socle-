import { readFileSync } from "node:fs";
import ExcelJS from "exceljs";
import type { WorkspaceStore } from "../workspaces/workspaceStore.js";
import type { ArtifactStore } from "../workspaces/artifactStore.js";
import { WORKBENCH_LIMITS, toFiniteNumberOrNull, assertFiniteResult, workbenchError } from "./limits.js";
import { parseDelimited, serializeDelimited } from "./csv.js";

export type SpreadsheetFormat = "csv" | "tsv" | "xlsx";
export type SheetSelector = string | number;

export interface RawRowsResult {
  sheetName: string;
  rows: unknown[][];
  truncated: boolean;
  totalRowsKnown: boolean;
  totalRows?: number;
  warnings: string[];
}

interface RawRowsRequest {
  sheet?: SheetSelector;
  startRow: number;
  endRow?: number;
  maxRows: number;
  maxColumns: number;
  maxCells: number;
}

/** ExcelJS peuple `.name` sur `WorksheetReader` à l'exécution (depuis workbook.xml) sans le déclarer dans ses types. */
function worksheetName(reader: ExcelJS.stream.xlsx.WorksheetReader): string {
  return (reader as unknown as { name: string }).name;
}

function extensionOf(path: string): string {
  const idx = path.lastIndexOf(".");
  return idx === -1 ? "" : path.slice(idx).toLowerCase();
}

function detectSpreadsheetFormat(path: string): SpreadsheetFormat {
  const ext = extensionOf(path);
  if (ext === ".csv") return "csv";
  if (ext === ".tsv") return "tsv";
  if (ext === ".xlsx") return "xlsx";
  if (ext === ".xls") throw workbenchError("SPREADSHEET_FORMAT_XLS_UNSUPPORTED");
  throw workbenchError("SPREADSHEET_FORMAT_UNSUPPORTED");
}

function loadCsvRawRows(text: string, delimiter: string, req: RawRowsRequest): RawRowsResult {
  const parsed = parseDelimited(text, delimiter);
  const totalRows = parsed.length;
  const warnings: string[] = [];
  const rows: unknown[][] = [];
  const wantEnd = req.endRow !== undefined ? Math.min(req.endRow, totalRows - 1) : totalRows - 1;
  let cells = 0;
  let truncated = false;
  let columnsWarned = false;
  for (let r = req.startRow; r <= wantEnd; r++) {
    if (rows.length >= req.maxRows) {
      truncated = true;
      break;
    }
    let cols: unknown[] = parsed[r] ?? [];
    if (cols.length > req.maxColumns) {
      cols = cols.slice(0, req.maxColumns);
      if (!columnsWarned) {
        warnings.push("SPREADSHEET_COLUMNS_TRUNCATED");
        columnsWarned = true;
      }
    }
    if (cells + cols.length > req.maxCells) {
      truncated = true;
      break;
    }
    cells += cols.length;
    rows.push(cols);
  }
  return { sheetName: "Sheet1", rows, truncated, totalRowsKnown: true, totalRows, warnings };
}

interface NormalizedCell {
  value: unknown;
  formulaWarning: boolean;
}

function normalizeCellValue(raw: unknown): NormalizedCell {
  if (raw === null || raw === undefined) return { value: null, formulaWarning: false };
  if (raw instanceof Date) return { value: raw.toISOString(), formulaWarning: false };
  if (typeof raw === "object") {
    const obj = raw as Record<string, unknown>;
    if ("formula" in obj || "sharedFormula" in obj) {
      if (obj.result !== undefined && !(obj.result && typeof obj.result === "object" && "error" in (obj.result as Record<string, unknown>))) {
        return normalizeCellValue(obj.result);
      }
      return { value: null, formulaWarning: true };
    }
    if (Array.isArray(obj.richText)) {
      return { value: (obj.richText as Array<{ text: string }>).map((r) => r.text).join(""), formulaWarning: false };
    }
    if ("text" in obj && "hyperlink" in obj) return { value: obj.text, formulaWarning: false };
    if ("error" in obj) return { value: null, formulaWarning: false };
  }
  return { value: raw, formulaWarning: false };
}

function extractRowValues(row: ExcelJS.Row, maxColumns: number): { values: unknown[]; formulaWarning: boolean; columnsTruncated: boolean } {
  const raw = Array.isArray(row.values) ? (row.values as unknown[]).slice(1) : [];
  const columnsTruncated = raw.length > maxColumns;
  const bounded = columnsTruncated ? raw.slice(0, maxColumns) : raw;
  let formulaWarning = false;
  const values = bounded.map((cell) => {
    const normalized = normalizeCellValue(cell);
    if (normalized.formulaWarning) formulaWarning = true;
    return normalized.value;
  });
  return { values, formulaWarning, columnsTruncated };
}

async function loadXlsxRawRows(absolutePath: string, req: RawRowsRequest): Promise<RawRowsResult> {
  const reader = new ExcelJS.stream.xlsx.WorkbookReader(absolutePath, {
    worksheets: "emit",
    sharedStrings: "cache",
    styles: "ignore",
    hyperlinks: "ignore",
    entries: "ignore",
  });
  const warnings: string[] = [];
  const rows: unknown[][] = [];
  let sheetIndex = 0;
  let sheetFound = false;
  let sheetName = "";
  let cellsUsed = 0;
  let truncated = false;
  let totalRowsKnown = false;
  let totalRows: number | undefined;
  let formulaWarned = false;
  let columnsWarned = false;

  for await (const worksheetReader of reader) {
    const isMatch =
      req.sheet === undefined
        ? sheetIndex === 0
        : typeof req.sheet === "number"
          ? sheetIndex === req.sheet
          : worksheetName(worksheetReader) === req.sheet;
    if (!isMatch) {
      sheetIndex++;
      // eslint-disable-next-line @typescript-eslint/no-unused-vars
      for await (const _drain of worksheetReader) {
        /* drain uninteresting sheet to advance the underlying stream */
      }
      continue;
    }
    sheetFound = true;
    sheetName = worksheetName(worksheetReader);
    let lastSeenRowNumber = 0;
    let stoppedForCap = false;
    let stoppedForRange = false;
    for await (const row of worksheetReader) {
      const idx = row.number - 1;
      lastSeenRowNumber = row.number;
      if (idx < req.startRow) continue;
      if (rows.length >= req.maxRows) {
        stoppedForCap = true;
        break;
      }
      const { values, formulaWarning, columnsTruncated } = extractRowValues(row, req.maxColumns);
      if (formulaWarning && !formulaWarned) {
        warnings.push("SPREADSHEET_FORMULA_NO_CACHED_RESULT");
        formulaWarned = true;
      }
      if (columnsTruncated && !columnsWarned) {
        warnings.push("SPREADSHEET_COLUMNS_TRUNCATED");
        columnsWarned = true;
      }
      if (cellsUsed + values.length > req.maxCells) {
        stoppedForCap = true;
        break;
      }
      cellsUsed += values.length;
      rows.push(values);
      if (req.endRow !== undefined && idx >= req.endRow) {
        stoppedForRange = true;
        break;
      }
    }
    if (!stoppedForCap && !stoppedForRange) {
      totalRowsKnown = true;
      totalRows = lastSeenRowNumber;
    }
    truncated = stoppedForCap;
    break;
  }
  if (!sheetFound) throw workbenchError("SPREADSHEET_SHEET_NOT_FOUND");
  return { sheetName, rows, truncated, totalRowsKnown, totalRows, warnings };
}

async function loadRawRowsForPath(workspaces: WorkspaceStore, workspaceId: string, path: string, req: RawRowsRequest): Promise<RawRowsResult> {
  const format = detectSpreadsheetFormat(path);
  const { absolutePath, size } = workspaces.resolveExistingFile(workspaceId, path);
  if (size > WORKBENCH_LIMITS.INPUT_FILE_MAX_BYTES) throw workbenchError("SPREADSHEET_FILE_TOO_LARGE");
  if (format === "xlsx") return loadXlsxRawRows(absolutePath, req);
  const text = readFileSync(absolutePath, "utf8");
  return loadCsvRawRows(text, format === "tsv" ? "\t" : ",", req);
}

export interface SpreadsheetSheetInfo {
  name: string;
  index: number;
}

export async function listSheets(workspaces: WorkspaceStore, workspaceId: string, path: string): Promise<{ path: string; format: SpreadsheetFormat; sheets: SpreadsheetSheetInfo[] }> {
  const format = detectSpreadsheetFormat(path);
  const { absolutePath, size } = workspaces.resolveExistingFile(workspaceId, path);
  if (size > WORKBENCH_LIMITS.INPUT_FILE_MAX_BYTES) throw workbenchError("SPREADSHEET_FILE_TOO_LARGE");
  if (format !== "xlsx") return { path, format, sheets: [{ name: "Sheet1", index: 0 }] };

  const reader = new ExcelJS.stream.xlsx.WorkbookReader(absolutePath, {
    worksheets: "emit",
    sharedStrings: "cache",
    styles: "ignore",
    hyperlinks: "ignore",
    entries: "ignore",
  });
  const sheets: SpreadsheetSheetInfo[] = [];
  let index = 0;
  for await (const worksheetReader of reader) {
    // eslint-disable-next-line @typescript-eslint/no-unused-vars
    for await (const _row of worksheetReader) {
      /* drain: LIST_SHEETS only needs names, never row content */
    }
    sheets.push({ name: worksheetName(worksheetReader), index });
    index++;
  }
  return { path, format, sheets };
}

export interface ReadRangeOptions {
  sheet?: SheetSelector;
  startRow: number;
  endRow?: number;
  columns?: number[];
}

export interface ReadRangeResult {
  path: string;
  sheet: string;
  startRow: number;
  endRow?: number;
  columns?: number[];
  rows: unknown[][];
  rowCountReturned: number;
  truncated: boolean;
  totalRowsKnown: boolean;
  totalRows?: number;
  warnings: string[];
}

export async function readRange(workspaces: WorkspaceStore, workspaceId: string, path: string, opts: ReadRangeOptions): Promise<ReadRangeResult> {
  if (!Number.isInteger(opts.startRow) || opts.startRow < 0) throw workbenchError("SPREADSHEET_RANGE_INVALID");
  if (opts.endRow !== undefined && (!Number.isInteger(opts.endRow) || opts.endRow < opts.startRow)) throw workbenchError("SPREADSHEET_RANGE_INVALID");

  const raw = await loadRawRowsForPath(workspaces, workspaceId, path, {
    sheet: opts.sheet,
    startRow: opts.startRow,
    endRow: opts.endRow,
    maxRows: WORKBENCH_LIMITS.SPREADSHEET_MAX_ROWS_PER_READ,
    maxColumns: WORKBENCH_LIMITS.SPREADSHEET_MAX_COLUMNS,
    maxCells: WORKBENCH_LIMITS.SPREADSHEET_MAX_CELLS_PER_READ,
  });

  let rows = raw.rows;
  if (opts.columns && opts.columns.length) {
    const maxColsSeen = rows.reduce((m, r) => Math.max(m, r.length), 0);
    for (const c of opts.columns) if (!Number.isInteger(c) || c < 0 || c >= maxColsSeen) throw workbenchError("SPREADSHEET_RANGE_INVALID");
    rows = rows.map((r) => opts.columns!.map((c) => r[c] ?? null));
  }

  return {
    path,
    sheet: raw.sheetName,
    startRow: opts.startRow,
    endRow: opts.endRow,
    columns: opts.columns,
    rows,
    rowCountReturned: rows.length,
    truncated: raw.truncated,
    totalRowsKnown: raw.totalRowsKnown,
    totalRows: raw.totalRows,
    warnings: raw.warnings,
  };
}

export interface TabularDataset {
  path: string;
  sheetName: string;
  headers: string[];
  rows: unknown[][];
  truncated: boolean;
  totalRowsKnown: boolean;
  totalRows?: number;
  warnings: string[];
}

function dedupeHeaders(headerRow: unknown[]): string[] {
  const seen = new Map<string, number>();
  return headerRow.map((h, i) => {
    const base = h === null || h === undefined || String(h).trim() === "" ? `column_${i + 1}` : String(h).trim();
    const count = seen.get(base) ?? 0;
    seen.set(base, count + 1);
    return count === 0 ? base : `${base}_${count + 1}`;
  });
}

export interface LoadDatasetOptions {
  sheet?: SheetSelector;
  maxRows: number;
  maxColumns: number;
  maxCells: number;
}

/** Charge un dataset borné (en-tête = première ligne). Réutilisé par DataAnalysisEngine avec ses propres limites. */
export async function loadTabularDataset(workspaces: WorkspaceStore, workspaceId: string, path: string, opts: LoadDatasetOptions): Promise<TabularDataset> {
  const raw = await loadRawRowsForPath(workspaces, workspaceId, path, {
    sheet: opts.sheet,
    startRow: 0,
    endRow: undefined,
    maxRows: opts.maxRows + 1,
    maxColumns: opts.maxColumns,
    maxCells: opts.maxCells,
  });
  const [headerRow, ...dataRows] = raw.rows;
  const headers = dedupeHeaders(headerRow ?? []);
  const totalRows = raw.totalRowsKnown ? Math.max(0, (raw.totalRows ?? 0) - 1) : undefined;
  return {
    path,
    sheetName: raw.sheetName,
    headers,
    rows: dataRows,
    truncated: raw.truncated,
    totalRowsKnown: raw.totalRowsKnown,
    totalRows,
    warnings: raw.warnings,
  };
}

export interface InspectResult {
  path: string;
  sheet: string;
  headers: string[];
  columnCount: number;
  sampleRows: unknown[][];
  sampleRowCount: number;
  truncated: boolean;
  totalRowsKnown: boolean;
  totalRows?: number;
  warnings: string[];
}

export async function inspectSpreadsheet(workspaces: WorkspaceStore, workspaceId: string, path: string, sheet?: SheetSelector): Promise<InspectResult> {
  const dataset = await loadTabularDataset(workspaces, workspaceId, path, {
    sheet,
    maxRows: WORKBENCH_LIMITS.SPREADSHEET_INSPECT_SAMPLE_ROWS,
    maxColumns: WORKBENCH_LIMITS.SPREADSHEET_MAX_COLUMNS,
    maxCells: WORKBENCH_LIMITS.SPREADSHEET_MAX_CELLS_PER_READ,
  });
  const warnings = [...dataset.warnings];
  if (dataset.truncated) warnings.push("SPREADSHEET_INSPECT_TRUNCATED");
  return {
    path,
    sheet: dataset.sheetName,
    headers: dataset.headers,
    columnCount: dataset.headers.length,
    sampleRows: dataset.rows,
    sampleRowCount: dataset.rows.length,
    truncated: dataset.truncated,
    totalRowsKnown: dataset.totalRowsKnown,
    totalRows: dataset.totalRows,
    warnings,
  };
}

export type TextFilterOperator = "equals" | "notEquals" | "contains" | "startsWith" | "endsWith" | "isEmpty" | "isNotEmpty";
export type NumericFilterOperator = "greaterThan" | "greaterOrEqual" | "lessThan" | "lessOrEqual";
export interface FilterCondition {
  column: string;
  operator: TextFilterOperator | NumericFilterOperator;
  value?: unknown;
}

const NUMERIC_OPERATORS = new Set<string>(["greaterThan", "greaterOrEqual", "lessThan", "lessOrEqual"]);

function matchesFilter(cellValue: unknown, filter: FilterCondition): boolean {
  if (NUMERIC_OPERATORS.has(filter.operator)) {
    const target = toFiniteNumberOrNull(filter.value);
    if (target === null) throw workbenchError("SPREADSHEET_FILTER_INVALID_VALUE");
    const cellNum = toFiniteNumberOrNull(cellValue);
    if (cellNum === null) return false;
    switch (filter.operator as NumericFilterOperator) {
      case "greaterThan":
        return cellNum > target;
      case "greaterOrEqual":
        return cellNum >= target;
      case "lessThan":
        return cellNum < target;
      case "lessOrEqual":
        return cellNum <= target;
    }
  }
  const str = cellValue === null || cellValue === undefined ? "" : String(cellValue);
  const strLower = str.toLowerCase();
  const targetLower = String(filter.value ?? "").toLowerCase();
  switch (filter.operator as TextFilterOperator) {
    case "isEmpty":
      return str.trim().length === 0;
    case "isNotEmpty":
      return str.trim().length > 0;
    case "equals":
      return strLower === targetLower;
    case "notEquals":
      return strLower !== targetLower;
    case "contains":
      return strLower.includes(targetLower);
    case "startsWith":
      return strLower.startsWith(targetLower);
    case "endsWith":
      return strLower.endsWith(targetLower);
    default:
      throw workbenchError("SPREADSHEET_FILTER_OPERATOR_INVALID");
  }
}

export function applyFilters(headers: string[], rows: unknown[][], filters: FilterCondition[]): unknown[][] {
  const columnIndexes = filters.map((f) => {
    const idx = headers.indexOf(f.column);
    if (idx === -1) throw workbenchError("SPREADSHEET_RANGE_INVALID");
    return idx;
  });
  return rows.filter((row) => filters.every((filter, i) => matchesFilter(row[columnIndexes[i]], filter)));
}

export interface SortSpec {
  column: string;
  direction?: "asc" | "desc";
}

function compareValues(a: unknown, b: unknown): number {
  const aBlank = a === null || a === undefined || a === "";
  const bBlank = b === null || b === undefined || b === "";
  if (aBlank && bBlank) return 0;
  if (aBlank) return 1;
  if (bBlank) return -1;
  const an = toFiniteNumberOrNull(a);
  const bn = toFiniteNumberOrNull(b);
  if (an !== null && bn !== null) return an - bn;
  const as = String(a);
  const bs = String(b);
  return as < bs ? -1 : as > bs ? 1 : 0;
}

export function applySort(headers: string[], rows: unknown[][], sortBy: SortSpec[]): unknown[][] {
  if (!sortBy.length) return rows;
  const specs = sortBy.map((s) => {
    const idx = headers.indexOf(s.column);
    if (idx === -1) throw workbenchError("SPREADSHEET_RANGE_INVALID");
    return { idx, dir: s.direction === "desc" ? -1 : 1 };
  });
  return [...rows].sort((ra, rb) => {
    for (const { idx, dir } of specs) {
      const c = compareValues(ra[idx], rb[idx]);
      if (c !== 0) return c * dir;
    }
    return 0;
  });
}

export type AggregateOperation = "COUNT" | "SUM" | "MEAN" | "MIN" | "MAX";

export function computeAggregate(headers: string[], rows: unknown[][], column: string, operation: AggregateOperation): number {
  const idx = headers.indexOf(column);
  if (idx === -1) throw workbenchError("SPREADSHEET_RANGE_INVALID");
  const raw = rows.map((r) => r[idx]);
  if (operation === "COUNT") return raw.filter((v) => v !== null && v !== undefined && v !== "").length;

  const numeric = raw.map(toFiniteNumberOrNull).filter((v): v is number => v !== null);
  if (operation === "SUM" || operation === "MEAN") {
    let sum = 0;
    for (const n of numeric) {
      sum += n;
      assertFiniteResult(sum);
    }
    if (operation === "SUM") return sum;
    return numeric.length ? assertFiniteResult(sum / numeric.length) : 0;
  }
  if (!numeric.length) throw workbenchError("SPREADSHEET_AGGREGATE_NO_DATA");
  let min = Infinity;
  let max = -Infinity;
  for (const n of numeric) {
    if (n < min) min = n;
    if (n > max) max = n;
  }
  return operation === "MIN" ? min : max;
}

function safeBaseName(path: string): string {
  const withoutExt = path.replace(/\.[^./\\]+$/, "");
  const segment = withoutExt.split(/[/\\]/).pop() || "export";
  return segment.replace(/[^a-zA-Z0-9._-]/g, "_") || "export";
}

export interface ExportOptions {
  path: string;
  sheet?: SheetSelector;
  filters?: FilterCondition[];
  sortBy?: SortSpec[];
  targetPath?: string;
}

export interface ExportResult {
  artifactId: string;
  relativePath?: string;
  workingPath?: string;
  mimeType?: string;
  sizeBytes?: number;
  sha256?: string;
  rowCount: number;
  truncated: boolean;
  warnings: string[];
}

async function loadExportDataset(workspaces: WorkspaceStore, workspaceId: string, opts: ExportOptions): Promise<{ headers: string[]; rows: unknown[][]; truncated: boolean; warnings: string[] }> {
  const dataset = await loadTabularDataset(workspaces, workspaceId, opts.path, {
    sheet: opts.sheet,
    maxRows: WORKBENCH_LIMITS.SPREADSHEET_MAX_ROWS_PER_READ,
    maxColumns: WORKBENCH_LIMITS.SPREADSHEET_MAX_COLUMNS,
    maxCells: WORKBENCH_LIMITS.SPREADSHEET_MAX_CELLS_PER_READ,
  });
  let rows = dataset.rows;
  if (opts.filters?.length) rows = applyFilters(dataset.headers, rows, opts.filters);
  if (opts.sortBy?.length) rows = applySort(dataset.headers, rows, opts.sortBy);
  return { headers: dataset.headers, rows, truncated: dataset.truncated, warnings: dataset.warnings };
}

export async function exportCsv(workspaces: WorkspaceStore, artifacts: ArtifactStore, workspaceId: string, opts: ExportOptions): Promise<ExportResult> {
  const { headers, rows, truncated, warnings } = await loadExportDataset(workspaces, workspaceId, opts);
  const csvText = serializeDelimited([headers, ...rows], ",");
  const content = Buffer.from(csvText, "utf8");
  const [artifact] = artifacts.createBatch([
    {
      workspaceId,
      kind: "DATA",
      name: `${safeBaseName(opts.path)}.csv`,
      mimeType: "text/csv; charset=utf-8",
      content,
      metadata: { sourcePath: opts.path, rowCount: rows.length },
      ...(opts.targetPath ? { workingPath: opts.targetPath } : {}),
    },
  ]);
  return {
    artifactId: artifact.id,
    relativePath: artifact.relativePath,
    workingPath: opts.targetPath,
    mimeType: artifact.mimeType,
    sizeBytes: artifact.sizeBytes,
    sha256: artifact.sha256,
    rowCount: rows.length,
    truncated,
    warnings,
  };
}

export async function exportXlsx(workspaces: WorkspaceStore, artifacts: ArtifactStore, workspaceId: string, opts: ExportOptions): Promise<ExportResult> {
  const { headers, rows, truncated, warnings } = await loadExportDataset(workspaces, workspaceId, opts);
  const workbook = new ExcelJS.Workbook();
  const sheet = workbook.addWorksheet("Sheet1");
  sheet.addRow(headers);
  for (const row of rows) sheet.addRow(row as ExcelJS.CellValue[]);
  const buffer = Buffer.from(await workbook.xlsx.writeBuffer());
  const [artifact] = artifacts.createBatch([
    {
      workspaceId,
      kind: "DATA",
      name: `${safeBaseName(opts.path)}.xlsx`,
      mimeType: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
      content: buffer,
      metadata: { sourcePath: opts.path, rowCount: rows.length },
      ...(opts.targetPath ? { workingPath: opts.targetPath } : {}),
    },
  ]);
  return {
    artifactId: artifact.id,
    relativePath: artifact.relativePath,
    workingPath: opts.targetPath,
    mimeType: artifact.mimeType,
    sizeBytes: artifact.sizeBytes,
    sha256: artifact.sha256,
    rowCount: rows.length,
    truncated,
    warnings,
  };
}

export { detectSpreadsheetFormat };
