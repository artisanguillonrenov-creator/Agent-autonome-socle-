import type { WorkspaceStore } from "../workspaces/workspaceStore.js";
import { loadTabularDataset, computeAggregate, type SheetSelector, type AggregateOperation } from "./spreadsheetEngine.js";
import { WORKBENCH_LIMITS, toFiniteNumberOrNull, assertFiniteResult, workbenchError } from "./limits.js";

export type AnalysisAction =
  | "DESCRIBE"
  | "COUNT"
  | "SUM"
  | "MEAN"
  | "MEDIAN"
  | "MIN"
  | "MAX"
  | "STDDEV"
  | "GROUP_BY"
  | "CORRELATION"
  | "TOP_N"
  | "BOTTOM_N"
  | "OUTLIERS"
  | "DISTRIBUTION"
  | "TIME_SERIES";

export type TimeGranularity = "DAY" | "WEEK" | "MONTH" | "YEAR";

export interface AnalysisRequest {
  workspaceId: string;
  path: string;
  sheet?: SheetSelector;
  action: AnalysisAction;
  column?: string;
  columnX?: string;
  columnY?: string;
  groupColumn?: string;
  aggregateColumn?: string;
  aggregateOperation?: AggregateOperation;
  n?: number;
  buckets?: number;
  granularity?: TimeGranularity;
  dateColumn?: string;
  valueColumn?: string;
}

function columnIndex(headers: string[], column: string | undefined): number {
  if (!column) throw workbenchError("ANALYSIS_COLUMN_REQUIRED");
  const idx = headers.indexOf(column);
  if (idx === -1) throw workbenchError("ANALYSIS_COLUMN_NOT_FOUND");
  return idx;
}

function numericValues(headers: string[], rows: unknown[][], column: string): number[] {
  const idx = columnIndex(headers, column);
  return rows.map((r) => toFiniteNumberOrNull(r[idx])).filter((v): v is number => v !== null);
}

function mean(values: number[]): number {
  let sum = 0;
  for (const v of values) {
    sum += v;
    assertFiniteResult(sum);
  }
  return assertFiniteResult(sum / values.length);
}

function stddev(values: number[]): number {
  if (values.length < 2) throw workbenchError("ANALYSIS_INSUFFICIENT_DATA");
  const m = mean(values);
  let sumSq = 0;
  for (const v of values) {
    const d = v - m;
    sumSq += d * d;
    assertFiniteResult(sumSq);
  }
  return assertFiniteResult(Math.sqrt(sumSq / (values.length - 1)));
}

function median(values: number[]): number {
  if (!values.length) throw workbenchError("ANALYSIS_INSUFFICIENT_DATA");
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[mid] : assertFiniteResult((sorted[mid - 1] + sorted[mid]) / 2);
}

function describeColumn(headers: string[], rows: unknown[][], column: string): Record<string, unknown> {
  const idx = columnIndex(headers, column);
  const raw = rows.map((r) => r[idx]);
  const nonBlank = raw.filter((v) => v !== null && v !== undefined && v !== "");
  const numeric = raw.map(toFiniteNumberOrNull).filter((v): v is number => v !== null);
  const stats: Record<string, unknown> = { column, count: nonBlank.length, numericCount: numeric.length };
  if (numeric.length) {
    let min = Infinity;
    let max = -Infinity;
    let sum = 0;
    for (const n of numeric) {
      if (n < min) min = n;
      if (n > max) max = n;
      sum += n;
      assertFiniteResult(sum);
    }
    stats.min = min;
    stats.max = max;
    stats.mean = assertFiniteResult(sum / numeric.length);
    if (numeric.length >= 2) stats.stddev = stddev(numeric);
  }
  return stats;
}

function pearsonCorrelation(xs: number[], ys: number[]): number {
  const n = xs.length;
  const mx = mean(xs);
  const my = mean(ys);
  let sxy = 0;
  let sxx = 0;
  let syy = 0;
  for (let i = 0; i < n; i++) {
    const dx = xs[i] - mx;
    const dy = ys[i] - my;
    sxy += dx * dy;
    sxx += dx * dx;
    syy += dy * dy;
    assertFiniteResult(sxy);
    assertFiniteResult(sxx);
    assertFiniteResult(syy);
  }
  if (sxx === 0 || syy === 0) throw workbenchError("ANALYSIS_INSUFFICIENT_DATA");
  return assertFiniteResult(sxy / Math.sqrt(sxx * syy));
}

function pad2(n: number): string {
  return String(n).padStart(2, "0");
}

/** Semaine ISO-8601 : 2021-01-01 (vendredi) appartient à 2020-W53. */
function isoWeekLabel(d: Date): string {
  const date = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate()));
  const dayNum = (date.getUTCDay() + 6) % 7; // lundi=0..dimanche=6
  date.setUTCDate(date.getUTCDate() - dayNum + 3); // jeudi le plus proche
  const isoYear = date.getUTCFullYear();
  const jan4 = new Date(Date.UTC(isoYear, 0, 4));
  const jan4Day = (jan4.getUTCDay() + 6) % 7;
  const week1Monday = new Date(jan4);
  week1Monday.setUTCDate(jan4.getUTCDate() - jan4Day);
  const week = Math.round((date.getTime() - week1Monday.getTime()) / (7 * 86400000)) + 1;
  return `${isoYear}-W${pad2(week)}`;
}

function bucketLabel(d: Date, granularity: TimeGranularity): string {
  switch (granularity) {
    case "DAY":
      return `${d.getUTCFullYear()}-${pad2(d.getUTCMonth() + 1)}-${pad2(d.getUTCDate())}`;
    case "WEEK":
      return isoWeekLabel(d);
    case "MONTH":
      return `${d.getUTCFullYear()}-${pad2(d.getUTCMonth() + 1)}`;
    case "YEAR":
      return `${d.getUTCFullYear()}`;
  }
}

function parseDateValue(value: unknown): Date | null {
  if (value instanceof Date) return Number.isNaN(value.getTime()) ? null : value;
  if (typeof value === "number" && Number.isFinite(value)) {
    const d = new Date(value);
    return Number.isNaN(d.getTime()) ? null : d;
  }
  if (typeof value === "string" && value.trim()) {
    const d = new Date(value.trim());
    return Number.isNaN(d.getTime()) ? null : d;
  }
  return null;
}

async function loadAnalysisDataset(workspaces: WorkspaceStore, workspaceId: string, path: string, sheet?: SheetSelector) {
  return loadTabularDataset(workspaces, workspaceId, path, {
    sheet,
    maxRows: WORKBENCH_LIMITS.ANALYSIS_MAX_ROWS,
    maxColumns: WORKBENCH_LIMITS.ANALYSIS_MAX_COLUMNS,
    maxCells: WORKBENCH_LIMITS.ANALYSIS_MAX_CELLS,
  });
}

export async function runDataAnalysis(workspaces: WorkspaceStore, request: AnalysisRequest): Promise<Record<string, unknown>> {
  const dataset = await loadAnalysisDataset(workspaces, request.workspaceId, request.path, request.sheet);
  const { headers, rows } = dataset;
  const envelope = {
    datasetTruncated: dataset.truncated,
    totalRowsKnown: dataset.totalRowsKnown,
    totalRows: dataset.totalRows,
    warnings: [...dataset.warnings],
  };

  switch (request.action) {
    case "DESCRIBE": {
      if (request.column) return { ...envelope, describe: describeColumn(headers, rows, request.column) };
      const bounded = headers.slice(0, WORKBENCH_LIMITS.ANALYSIS_MAX_RESULTS);
      return {
        ...envelope,
        describe: bounded.map((h) => describeColumn(headers, rows, h)),
        truncated: headers.length > bounded.length,
      };
    }
    case "COUNT": {
      if (!request.column) return { ...envelope, count: rows.length };
      const idx = columnIndex(headers, request.column);
      const count = rows.filter((r) => r[idx] !== null && r[idx] !== undefined && r[idx] !== "").length;
      return { ...envelope, count };
    }
    case "SUM": {
      const values = numericValues(headers, rows, request.column!);
      let sum = 0;
      for (const v of values) {
        sum += v;
        assertFiniteResult(sum);
      }
      return { ...envelope, sum };
    }
    case "MEAN": {
      const values = numericValues(headers, rows, request.column!);
      if (!values.length) throw workbenchError("ANALYSIS_INSUFFICIENT_DATA");
      return { ...envelope, mean: mean(values) };
    }
    case "MEDIAN":
      return { ...envelope, median: median(numericValues(headers, rows, request.column!)) };
    case "MIN": {
      const values = numericValues(headers, rows, request.column!);
      if (!values.length) throw workbenchError("ANALYSIS_INSUFFICIENT_DATA");
      return { ...envelope, min: Math.min(...values) };
    }
    case "MAX": {
      const values = numericValues(headers, rows, request.column!);
      if (!values.length) throw workbenchError("ANALYSIS_INSUFFICIENT_DATA");
      return { ...envelope, max: Math.max(...values) };
    }
    case "STDDEV":
      return { ...envelope, stddev: stddev(numericValues(headers, rows, request.column!)) };
    case "GROUP_BY": {
      const groupIdx = columnIndex(headers, request.groupColumn);
      const groups = new Map<string, unknown[][]>();
      for (const row of rows) {
        const key = row[groupIdx] === null || row[groupIdx] === undefined ? "" : String(row[groupIdx]);
        const bucket = groups.get(key);
        if (bucket) bucket.push(row);
        else groups.set(key, [row]);
      }
      let entries = [...groups.entries()].map(([key, groupRows]) => {
        const entry: Record<string, unknown> = { key, count: groupRows.length };
        if (request.aggregateColumn && request.aggregateOperation) {
          entry.aggregate = computeAggregate(headers, groupRows, request.aggregateColumn, request.aggregateOperation);
        }
        return entry;
      });
      entries = entries.sort((a, b) => (b.count as number) - (a.count as number) || String(a.key).localeCompare(String(b.key)));
      const bounded = entries.slice(0, WORKBENCH_LIMITS.ANALYSIS_MAX_RESULTS);
      return { ...envelope, groups: bounded, truncated: envelope.datasetTruncated || entries.length > bounded.length };
    }
    case "CORRELATION": {
      const xIdx = columnIndex(headers, request.columnX);
      const yIdx = columnIndex(headers, request.columnY);
      const xs: number[] = [];
      const ys: number[] = [];
      for (const row of rows) {
        const x = toFiniteNumberOrNull(row[xIdx]);
        const y = toFiniteNumberOrNull(row[yIdx]);
        if (x !== null && y !== null) {
          xs.push(x);
          ys.push(y);
        }
      }
      if (xs.length < 2) throw workbenchError("ANALYSIS_INSUFFICIENT_DATA");
      return { ...envelope, correlation: pearsonCorrelation(xs, ys), pairedCount: xs.length };
    }
    case "TOP_N":
    case "BOTTOM_N": {
      const idx = columnIndex(headers, request.column);
      const requestedN = Number.isInteger(request.n) && (request.n as number) > 0 ? (request.n as number) : 10;
      const effectiveN = Math.min(requestedN, WORKBENCH_LIMITS.ANALYSIS_MAX_RESULTS);
      const eligible = rows
        .map((row, rowIndex) => ({ rowIndex, value: toFiniteNumberOrNull(row[idx]), row }))
        .filter((e): e is { rowIndex: number; value: number; row: unknown[] } => e.value !== null);
      eligible.sort((a, b) => (request.action === "TOP_N" ? b.value - a.value : a.value - b.value));
      const results = eligible.slice(0, effectiveN);
      return {
        ...envelope,
        results: results.map((r) => ({ rowIndex: r.rowIndex, value: r.value, row: r.row })),
        truncated: envelope.datasetTruncated || requestedN > WORKBENCH_LIMITS.ANALYSIS_MAX_RESULTS,
      };
    }
    case "OUTLIERS": {
      const idx = columnIndex(headers, request.column);
      const values = rows
        .map((row, rowIndex) => ({ rowIndex, value: toFiniteNumberOrNull(row[idx]) }))
        .filter((e): e is { rowIndex: number; value: number } => e.value !== null);
      if (values.length < 4) throw workbenchError("ANALYSIS_INSUFFICIENT_DATA");
      const sorted = [...values].sort((a, b) => a.value - b.value);
      const q1 = sorted[Math.floor(0.25 * (sorted.length - 1))].value;
      const q3 = sorted[Math.floor(0.75 * (sorted.length - 1))].value;
      const iqr = q3 - q1;
      const lower = q1 - 1.5 * iqr;
      const upper = q3 + 1.5 * iqr;
      const outliers = values.filter((v) => v.value < lower || v.value > upper);
      const bounded = outliers.slice(0, WORKBENCH_LIMITS.ANALYSIS_MAX_RESULTS);
      return {
        ...envelope,
        outliers: bounded,
        bounds: { lower: assertFiniteResult(lower), upper: assertFiniteResult(upper), q1, q3 },
        truncated: envelope.datasetTruncated || outliers.length > bounded.length,
      };
    }
    case "DISTRIBUTION": {
      const idx = columnIndex(headers, request.column);
      const values = numericValues(headers, rows, request.column!);
      if (values.length) {
        const bucketCount = Number.isInteger(request.buckets) && (request.buckets as number) > 0 ? Math.min(request.buckets as number, WORKBENCH_LIMITS.ANALYSIS_MAX_RESULTS) : 10;
        const min = Math.min(...values);
        const max = Math.max(...values);
        const width = max > min ? (max - min) / bucketCount : 0;
        const counts = new Array(bucketCount).fill(0);
        for (const v of values) {
          const bucket = width > 0 ? Math.min(bucketCount - 1, Math.floor((v - min) / width)) : 0;
          counts[bucket]++;
        }
        const histogram = counts.map((count, i) => ({
          rangeStart: assertFiniteResult(min + i * width),
          rangeEnd: assertFiniteResult(i === bucketCount - 1 ? max : min + (i + 1) * width),
          count,
        }));
        return { ...envelope, kind: "numeric", histogram };
      }
      const frequencies = new Map<string, number>();
      for (const row of rows) {
        const key = row[idx] === null || row[idx] === undefined ? "" : String(row[idx]);
        frequencies.set(key, (frequencies.get(key) ?? 0) + 1);
      }
      const entries = [...frequencies.entries()]
        .map(([value, count]) => ({ value, count }))
        .sort((a, b) => b.count - a.count || a.value.localeCompare(b.value));
      const bounded = entries.slice(0, WORKBENCH_LIMITS.ANALYSIS_MAX_RESULTS);
      return { ...envelope, kind: "categorical", frequencies: bounded, truncated: envelope.datasetTruncated || entries.length > bounded.length };
    }
    case "TIME_SERIES": {
      const dateIdx = columnIndex(headers, request.dateColumn);
      const valueIdx = request.valueColumn ? columnIndex(headers, request.valueColumn) : undefined;
      const granularity = request.granularity ?? "DAY";
      const operation: AggregateOperation = request.aggregateOperation ?? "COUNT";
      const buckets = new Map<string, unknown[][]>();
      let skipped = 0;
      for (const row of rows) {
        const date = parseDateValue(row[dateIdx]);
        if (!date) {
          skipped++;
          continue;
        }
        const label = bucketLabel(date, granularity);
        const bucket = buckets.get(label);
        if (bucket) bucket.push(row);
        else buckets.set(label, [row]);
      }
      const bucketHeaders = headers;
      let series = [...buckets.entries()]
        .map(([bucket, bucketRows]) => {
          const entry: Record<string, unknown> = { bucket, count: bucketRows.length };
          if (valueIdx !== undefined) entry.value = computeAggregate(bucketHeaders, bucketRows, request.valueColumn!, operation);
          return entry;
        })
        .sort((a, b) => String(a.bucket).localeCompare(String(b.bucket)));
      const bounded = series.slice(0, WORKBENCH_LIMITS.ANALYSIS_MAX_RESULTS);
      const warnings = [...envelope.warnings];
      if (skipped > 0) warnings.push("ANALYSIS_TIME_SERIES_UNPARSEABLE_DATES_SKIPPED");
      return { ...envelope, warnings, series: bounded, truncated: envelope.datasetTruncated || series.length > bounded.length };
    }
    default:
      throw workbenchError("ANALYSIS_ACTION_INVALID");
  }
}
