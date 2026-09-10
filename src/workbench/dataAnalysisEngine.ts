import {
  BoundedDatasetResult,
  CorrelationResult,
  DateDescribe,
  DescribeResult,
  DistributionResult,
  DuplicateResult,
  GroupByResult,
  MissingValueResult,
  NumericDescribe,
  OutlierResult,
  StringDescribe,
  TimeSeriesGranularity,
  TimeSeriesPoint,
  TimeSeriesResult,
  WORKBENCH_ERRORS
} from "./workbenchTypes.js";

export const DATASET_LIMITS = {
  maxRowsInMemory: 50_000,
  maxColumns: 200,
  maxCells: 5_000_000,
  maxResultRows: 1_000
};

/**
 * True ISO-8601 week + week-year (Thursday-anchored): shifts the date to
 * the Thursday of its own week, then the ISO year is that Thursday's
 * calendar year and the week number counts from that year's Jan 1st.
 * This is what makes 2021-01-01 (a Friday) fall in 2020-W53, not "2021-W01"
 * as a naive Jan-1-anchored calculation would produce.
 */
function isoWeekKey(date: Date): string {
  const d = new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate()));
  const dayNum = d.getUTCDay() || 7; // Sunday=0 -> 7, so Mon=1..Sun=7
  d.setUTCDate(d.getUTCDate() + 4 - dayNum);
  const isoYear = d.getUTCFullYear();
  const yearStart = Date.UTC(isoYear, 0, 1);
  const isoWeek = Math.ceil(((d.getTime() - yearStart) / 86400000 + 1) / 7);
  return `${isoYear}-W${String(isoWeek).padStart(2, "0")}`;
}

export class DataAnalysisEngine {
  private validateDataset(rows: Record<string, unknown>[]): string[] {
    if (rows.length > DATASET_LIMITS.maxRowsInMemory) {
      throw new Error(WORKBENCH_ERRORS.DATASET_LIMIT_EXCEEDED);
    }

    const columnSet = new Set<string>();
    for (const row of rows) {
      if (row && typeof row === "object") {
        for (const k of Object.keys(row)) {
          columnSet.add(k);
        }
      }
    }

    const columns = Array.from(columnSet);
    if (columns.length > DATASET_LIMITS.maxColumns) {
      throw new Error(WORKBENCH_ERRORS.DATASET_LIMIT_EXCEEDED);
    }

    if (rows.length * columns.length > DATASET_LIMITS.maxCells) {
      throw new Error(WORKBENCH_ERRORS.DATASET_LIMIT_EXCEEDED);
    }

    return columns;
  }

  describe(rows: Record<string, unknown>[]): DescribeResult {
    const columns = this.validateDataset(rows);
    const numericColumns: Record<string, NumericDescribe> = {};
    const stringColumns: Record<string, StringDescribe> = {};
    const dateColumns: Record<string, DateDescribe> = {};

    if (rows.length === 0) {
      return { numericColumns, stringColumns, dateColumns, totalRows: 0 };
    }

    for (const col of columns) {
      const rawVals = rows.map((r) => r[col]);
      const nonNullVals = rawVals.filter((v) => v !== null && v !== undefined && v !== "");
      const missingCount = rawVals.length - nonNullVals.length;

      const numericVals: number[] = [];
      const dateVals: Date[] = [];
      const strVals: string[] = [];

      for (const v of nonNullVals) {
        if (typeof v === "number") {
          // A raw NaN/Infinity is never a usable numeric value for
          // aggregation; treat it as opaque text rather than contaminate
          // min/max/mean/stddev with a non-finite result.
          if (Number.isFinite(v)) {
            numericVals.push(v);
          } else {
            strVals.push(String(v));
          }
        } else if (typeof v === "boolean") {
          strVals.push(String(v));
        } else if (v instanceof Date) {
          dateVals.push(v);
        } else if (typeof v === "string") {
          const trimmed = v.trim();
          const asNum = Number(trimmed);
          if (trimmed !== "" && Number.isFinite(asNum)) {
            numericVals.push(asNum);
          } else {
            const parsedTs = Date.parse(trimmed);
            if (!isNaN(parsedTs) && trimmed.length >= 8 && (trimmed.includes("-") || trimmed.includes("/"))) {
              dateVals.push(new Date(parsedTs));
            } else {
              strVals.push(trimmed);
            }
          }
        }
      }

      if (numericVals.length > 0 && numericVals.length >= nonNullVals.length * 0.7) {
        numericVals.sort((a, b) => a - b);
        const count = numericVals.length;
        const min = numericVals[0];
        const max = numericVals[count - 1];
        const sum = numericVals.reduce((a, b) => a + b, 0);
        const mean = sum / count;

        let median = 0;
        if (count % 2 === 0) {
          median = (numericVals[count / 2 - 1] + numericVals[count / 2]) / 2;
        } else {
          median = numericVals[Math.floor(count / 2)];
        }

        const variance =
          count > 1
            ? numericVals.reduce((a, b) => a + Math.pow(b - mean, 2), 0) / (count - 1)
            : 0;
        const stddev = Math.sqrt(variance);

        numericColumns[col] = {
          count,
          missing: missingCount,
          min,
          max,
          mean,
          median,
          stddev
        };
      } else if (dateVals.length > 0 && dateVals.length >= nonNullVals.length * 0.7) {
        dateVals.sort((a, b) => a.getTime() - b.getTime());
        dateColumns[col] = {
          count: dateVals.length,
          missing: missingCount,
          minDate: dateVals[0].toISOString(),
          maxDate: dateVals[dateVals.length - 1].toISOString()
        };
      } else {
        const counts = new Map<string, number>();
        for (const v of nonNullVals) {
          const s = String(v);
          counts.set(s, (counts.get(s) ?? 0) + 1);
        }

        const topValues = Array.from(counts.entries())
          .map(([value, cnt]) => ({ value, count: cnt }))
          .sort((a, b) => b.count - a.count)
          .slice(0, 5);

        stringColumns[col] = {
          count: nonNullVals.length,
          missing: missingCount,
          unique: counts.size,
          topValues
        };
      }
    }

    return {
      numericColumns,
      stringColumns,
      dateColumns,
      totalRows: rows.length
    };
  }

  count(rows: Record<string, unknown>[], mode: "COUNT_ROWS" | "COUNT_NON_NULL" = "COUNT_ROWS", column?: string): number {
    const columns = this.validateDataset(rows);
    if (mode === "COUNT_ROWS") return rows.length;

    if (!column || !columns.includes(column)) {
      throw new Error(WORKBENCH_ERRORS.DATA_COLUMN_NOT_FOUND);
    }
    return rows.filter((r) => r[column] !== null && r[column] !== undefined && r[column] !== "").length;
  }

  private getNumericValues(rows: Record<string, unknown>[], column: string): number[] {
    const columns = this.validateDataset(rows);
    if (!columns.includes(column)) {
      throw new Error(WORKBENCH_ERRORS.DATA_COLUMN_NOT_FOUND);
    }

    const nums: number[] = [];
    for (const r of rows) {
      const v = r[column];
      if (v !== null && v !== undefined && v !== "" && typeof v !== "boolean") {
        const n = Number(v);
        // Number.isFinite rejects NaN, Infinity, -Infinity and their
        // string spellings ("NaN", "Infinity", "-Infinity") alike: a
        // value that claims to be numeric but isn't finite is unusable
        // for aggregation, not silently ignorable.
        if (Number.isFinite(n)) nums.push(n);
        else throw new Error(WORKBENCH_ERRORS.DATA_TYPE_UNSUPPORTED);
      }
    }
    return nums;
  }

  /**
   * Number.isFinite on inputs alone doesn't guarantee a finite output: two
   * finite values can still overflow to Infinity/NaN through addition,
   * squaring, or division (e.g. Number.MAX_VALUE + Number.MAX_VALUE).
   * Every public numeric result is checked here rather than trusting the
   * arithmetic to stay in range.
   */
  private assertFiniteResult(value: number): number {
    if (!Number.isFinite(value)) {
      throw new Error(WORKBENCH_ERRORS.DATA_TYPE_UNSUPPORTED);
    }
    return value;
  }

  sum(rows: Record<string, unknown>[], column: string): number {
    const nums = this.getNumericValues(rows, column);
    return this.assertFiniteResult(nums.reduce((a, b) => a + b, 0));
  }

  mean(rows: Record<string, unknown>[], column: string): number {
    const nums = this.getNumericValues(rows, column);
    if (nums.length === 0) return 0;
    return this.assertFiniteResult(nums.reduce((a, b) => a + b, 0) / nums.length);
  }

  median(rows: Record<string, unknown>[], column: string): number {
    const nums = this.getNumericValues(rows, column).sort((a, b) => a - b);
    if (nums.length === 0) return 0;
    const mid = Math.floor(nums.length / 2);
    return this.assertFiniteResult(nums.length % 2 !== 0 ? nums[mid] : (nums[mid - 1] + nums[mid]) / 2);
  }

  min(rows: Record<string, unknown>[], column: string): number {
    const nums = this.getNumericValues(rows, column);
    if (nums.length === 0) return 0;
    return Math.min(...nums);
  }

  max(rows: Record<string, unknown>[], column: string): number {
    const nums = this.getNumericValues(rows, column);
    if (nums.length === 0) return 0;
    return Math.max(...nums);
  }

  stddev(rows: Record<string, unknown>[], column: string): number {
    const nums = this.getNumericValues(rows, column);
    if (nums.length <= 1) return 0;
    const avg = this.assertFiniteResult(nums.reduce((a, b) => a + b, 0) / nums.length);
    const variance = this.assertFiniteResult(
      nums.reduce((a, b) => a + Math.pow(b - avg, 2), 0) / (nums.length - 1)
    );
    return this.assertFiniteResult(Math.sqrt(variance));
  }

  groupBy(
    rows: Record<string, unknown>[],
    groupColumn: string,
    valueColumn?: string,
    fn: "COUNT" | "SUM" | "MEAN" | "MIN" | "MAX" = "COUNT"
  ): GroupByResult {
    const columns = this.validateDataset(rows);
    if (!columns.includes(groupColumn)) {
      throw new Error(WORKBENCH_ERRORS.DATA_COLUMN_NOT_FOUND);
    }

    if (["SUM", "MEAN", "MIN", "MAX"].includes(fn)) {
      if (!valueColumn || !columns.includes(valueColumn)) {
        throw new Error(WORKBENCH_ERRORS.DATA_COLUMN_NOT_FOUND);
      }
    }

    const groups = new Map<string, Record<string, unknown>[]>();
    for (const r of rows) {
      const key = String(r[groupColumn] ?? "null");
      if (!groups.has(key)) groups.set(key, []);
      groups.get(key)!.push(r);
    }

    const totalResults = groups.size;
    const allResults: Record<string, unknown>[] = [];

    for (const [key, groupRows] of groups.entries()) {
      let val: number = 0;
      if (fn === "COUNT") {
        val = groupRows.length;
      } else if (valueColumn) {
        if (fn === "SUM") val = this.sum(groupRows, valueColumn);
        else if (fn === "MEAN") val = this.mean(groupRows, valueColumn);
        else if (fn === "MIN") val = this.min(groupRows, valueColumn);
        else if (fn === "MAX") val = this.max(groupRows, valueColumn);
      }

      allResults.push({
        [groupColumn]: key,
        [valueColumn ? `${valueColumn}_${fn.toLowerCase()}` : fn.toLowerCase()]: val
      });
    }

    const truncated = totalResults > DATASET_LIMITS.maxResultRows;
    const returnedRows = allResults.slice(0, DATASET_LIMITS.maxResultRows);

    return {
      rows: returnedRows,
      truncated,
      totalResults,
      returnedResults: returnedRows.length
    };
  }

  topN(rows: Record<string, unknown>[], column: string, n = 10): BoundedDatasetResult {
    const columns = this.validateDataset(rows);
    if (!columns.includes(column)) {
      throw new Error(WORKBENCH_ERRORS.DATA_COLUMN_NOT_FOUND);
    }

    if (typeof n !== "number" || isNaN(n) || n <= 0 || !Number.isInteger(n)) {
      throw new Error(WORKBENCH_ERRORS.DATA_TYPE_UNSUPPORTED);
    }

    const requestedCap = Math.min(n, DATASET_LIMITS.maxResultRows);
    const totalResults = rows.length;

    const sorted = [...rows].sort((a, b) => {
      const rawA = a[column];
      const rawB = b[column];

      const isAValid = rawA !== null && rawA !== undefined && rawA !== "" && typeof rawA !== "boolean";
      const isBValid = rawB !== null && rawB !== undefined && rawB !== "" && typeof rawB !== "boolean";

      if (!isAValid && !isBValid) return 0;
      if (!isAValid) return 1;
      if (!isBValid) return -1;

      const valA = Number(rawA);
      const valB = Number(rawB);
      // A value that merely looks numeric ("Infinity", "NaN") but isn't
      // finite must not be treated as comparable-as-a-number: fall back
      // to the string comparison branch instead of ranking it as an
      // extreme value.
      if (Number.isFinite(valA) && Number.isFinite(valB)) return valB - valA;
      return String(rawB).localeCompare(String(rawA));
    });

    const returnedRows = sorted.slice(0, requestedCap);
    const truncated = n > DATASET_LIMITS.maxResultRows || totalResults > requestedCap;

    return {
      rows: returnedRows,
      truncated,
      totalResults,
      returnedResults: returnedRows.length
    };
  }

  bottomN(rows: Record<string, unknown>[], column: string, n = 10): BoundedDatasetResult {
    const columns = this.validateDataset(rows);
    if (!columns.includes(column)) {
      throw new Error(WORKBENCH_ERRORS.DATA_COLUMN_NOT_FOUND);
    }

    if (typeof n !== "number" || isNaN(n) || n <= 0 || !Number.isInteger(n)) {
      throw new Error(WORKBENCH_ERRORS.DATA_TYPE_UNSUPPORTED);
    }

    const requestedCap = Math.min(n, DATASET_LIMITS.maxResultRows);
    const totalResults = rows.length;

    const sorted = [...rows].sort((a, b) => {
      const rawA = a[column];
      const rawB = b[column];

      const isAValid = rawA !== null && rawA !== undefined && rawA !== "" && typeof rawA !== "boolean";
      const isBValid = rawB !== null && rawB !== undefined && rawB !== "" && typeof rawB !== "boolean";

      if (!isAValid && !isBValid) return 0;
      if (!isAValid) return 1;
      if (!isBValid) return -1;

      const valA = Number(rawA);
      const valB = Number(rawB);
      // See topN: non-finite numeric-looking values fall back to string
      // comparison instead of being ranked as extreme numbers.
      if (Number.isFinite(valA) && Number.isFinite(valB)) return valA - valB;
      return String(rawA).localeCompare(String(rawB));
    });

    const returnedRows = sorted.slice(0, requestedCap);
    const truncated = n > DATASET_LIMITS.maxResultRows || totalResults > requestedCap;

    return {
      rows: returnedRows,
      truncated,
      totalResults,
      returnedResults: returnedRows.length
    };
  }

  distribution(rows: Record<string, unknown>[], column: string): DistributionResult {
    const columns = this.validateDataset(rows);
    if (!columns.includes(column)) {
      throw new Error(WORKBENCH_ERRORS.DATA_COLUMN_NOT_FOUND);
    }

    const counts = new Map<string, number>();
    for (const r of rows) {
      const k = String(r[column] ?? "null");
      counts.set(k, (counts.get(k) ?? 0) + 1);
    }

    const total = rows.length;
    const totalResults = counts.size;

    const sorted = Array.from(counts.entries())
      .map(([value, cnt]) => ({
        value,
        count: cnt,
        percentage: total > 0 ? Number(((cnt / total) * 100).toFixed(2)) : 0
      }))
      .sort((a, b) => b.count - a.count);

    const truncated = totalResults > DATASET_LIMITS.maxResultRows;
    const returnedList = sorted.slice(0, DATASET_LIMITS.maxResultRows);

    return {
      column,
      distribution: returnedList,
      truncated,
      totalResults,
      returnedResults: returnedList.length
    };
  }

  missingValues(rows: Record<string, unknown>[]): MissingValueResult[] {
    const columns = this.validateDataset(rows);
    if (rows.length === 0) return [];

    const results: MissingValueResult[] = [];

    for (const col of columns) {
      let missingCount = 0;
      for (const row of rows) {
        const val = row[col];
        if (val === null || val === undefined) {
          missingCount++;
        }
      }

      results.push({
        column: col,
        missingCount,
        missingPercentage: Number(((missingCount / rows.length) * 100).toFixed(2))
      });
    }

    return results;
  }

  duplicates(rows: Record<string, unknown>[], keyColumns?: string[]): DuplicateResult {
    this.validateDataset(rows);
    if (rows.length === 0) {
      return { duplicateCount: 0, sampleRows: [], truncated: false };
    }

    const seen = new Set<string>();
    const sampleRows: Record<string, unknown>[] = [];
    let duplicateCount = 0;

    for (const row of rows) {
      let key = "";
      if (keyColumns && keyColumns.length > 0) {
        key = keyColumns.map((col) => String(row[col] ?? "null")).join("||");
      } else {
        key = JSON.stringify(row);
      }

      if (seen.has(key)) {
        duplicateCount++;
        if (sampleRows.length < 10) {
          sampleRows.push(row);
        }
      } else {
        seen.add(key);
      }
    }

    return {
      duplicateCount,
      sampleRows,
      truncated: sampleRows.length < duplicateCount
    };
  }

  outliers(rows: Record<string, unknown>[], column: string): OutlierResult {
    const columns = this.validateDataset(rows);
    if (!columns.includes(column)) {
      throw new Error(WORKBENCH_ERRORS.DATA_COLUMN_NOT_FOUND);
    }

    const numericVals: number[] = [];
    for (const r of rows) {
      const val = r[column];
      if (val !== null && val !== undefined && val !== "" && typeof val !== "boolean") {
        const num = Number(val);
        // Excluding non-finite values here (rather than just NaN) keeps
        // "Infinity"/"-Infinity" from silently becoming the reported
        // min/max/quartile bounds.
        if (Number.isFinite(num)) {
          numericVals.push(num);
        }
      }
    }

    if (numericVals.length === 0) {
      throw new Error(WORKBENCH_ERRORS.DATA_TYPE_UNSUPPORTED);
    }

    numericVals.sort((a, b) => a - b);
    const n = numericVals.length;

    const calcQuartile = (q: number) => {
      const pos = (n - 1) * q;
      const base = Math.floor(pos);
      const rest = pos - base;
      if (base + 1 < n) {
        return numericVals[base] + rest * (numericVals[base + 1] - numericVals[base]);
      } else {
        return numericVals[base];
      }
    };

    const q1 = this.assertFiniteResult(calcQuartile(0.25));
    const q3 = this.assertFiniteResult(calcQuartile(0.75));
    const iqr = this.assertFiniteResult(q3 - q1);
    const lowerBound = this.assertFiniteResult(q1 - 1.5 * iqr);
    const upperBound = this.assertFiniteResult(q3 + 1.5 * iqr);

    const outliersList = numericVals.filter((v) => v < lowerBound || v > upperBound);

    return {
      column,
      q1,
      q3,
      iqr,
      lowerBound,
      upperBound,
      count: outliersList.length,
      sample: outliersList.slice(0, 10)
    };
  }

  correlation(
    rows: Record<string, unknown>[],
    columnA: string,
    columnB: string
  ): CorrelationResult {
    const columns = this.validateDataset(rows);
    if (!columns.includes(columnA) || !columns.includes(columnB)) {
      throw new Error(WORKBENCH_ERRORS.DATA_COLUMN_NOT_FOUND);
    }

    const pairs: [number, number][] = [];
    for (const r of rows) {
      const valA = r[columnA];
      const valB = r[columnB];

      if (
        valA !== null &&
        valA !== undefined &&
        valA !== "" &&
        typeof valA !== "boolean" &&
        valB !== null &&
        valB !== undefined &&
        valB !== "" &&
        typeof valB !== "boolean"
      ) {
        const numA = Number(valA);
        const numB = Number(valB);
        if (Number.isFinite(numA) && Number.isFinite(numB)) {
          pairs.push([numA, numB]);
        } else {
          throw new Error(WORKBENCH_ERRORS.DATA_TYPE_UNSUPPORTED);
        }
      }
    }

    if (pairs.length < 2) {
      return { columnA, columnB, coefficient: 0, sampleSize: pairs.length };
    }

    const n = pairs.length;
    let sumA = 0,
      sumB = 0,
      sumA2 = 0,
      sumB2 = 0,
      sumAB = 0;

    for (const [a, b] of pairs) {
      sumA += a;
      sumB += b;
      sumA2 += a * a;
      sumB2 += b * b;
      sumAB += a * b;
    }

    const num = n * sumAB - sumA * sumB;
    const den = Math.sqrt((n * sumA2 - sumA * sumA) * (n * sumB2 - sumB * sumB));

    const coefficient = den === 0 ? 0 : this.assertFiniteResult(Number((num / den).toFixed(4)));

    return {
      columnA,
      columnB,
      coefficient,
      sampleSize: n
    };
  }

  timeSeriesSummary(
    rows: Record<string, unknown>[],
    dateColumn: string,
    granularity: TimeSeriesGranularity,
    valueColumn?: string
  ): TimeSeriesResult {
    const columns = this.validateDataset(rows);
    if (!columns.includes(dateColumn)) {
      throw new Error(WORKBENCH_ERRORS.DATA_COLUMN_NOT_FOUND);
    }

    if (valueColumn && !columns.includes(valueColumn)) {
      throw new Error(WORKBENCH_ERRORS.DATA_COLUMN_NOT_FOUND);
    }

    const groups = new Map<string, number[]>();

    for (const r of rows) {
      const rawDate = r[dateColumn];
      if (rawDate === null || rawDate === undefined || rawDate === "") continue;

      const dateObj = rawDate instanceof Date ? rawDate : new Date(String(rawDate));
      if (isNaN(dateObj.getTime())) continue;

      let key = "";
      const year = dateObj.getUTCFullYear();
      const month = String(dateObj.getUTCMonth() + 1).padStart(2, "0");
      const day = String(dateObj.getUTCDate()).padStart(2, "0");

      if (granularity === "DAY") {
        key = `${year}-${month}-${day}`;
      } else if (granularity === "MONTH") {
        key = `${year}-${month}`;
      } else if (granularity === "YEAR") {
        key = `${year}`;
      } else if (granularity === "WEEK") {
        key = isoWeekKey(dateObj);
      }

      if (!groups.has(key)) groups.set(key, []);

      if (valueColumn) {
        const rawVal = r[valueColumn];
        if (rawVal !== null && rawVal !== undefined && rawVal !== "" && typeof rawVal !== "boolean") {
          const val = Number(rawVal);
          if (Number.isFinite(val)) {
            groups.get(key)!.push(val);
          } else {
            throw new Error(WORKBENCH_ERRORS.DATA_TYPE_UNSUPPORTED);
          }
        }
      } else {
        groups.get(key)!.push(1);
      }
    }

    const sortedKeys = Array.from(groups.keys()).sort();
    const totalResults = sortedKeys.length;

    const allPoints: TimeSeriesPoint[] = [];

    for (const period of sortedKeys) {
      const vals = groups.get(period)!;
      const count = vals.length;

      if (valueColumn) {
        if (count > 0) {
          const sum = this.assertFiniteResult(vals.reduce((a, b) => a + b, 0));
          const mean = this.assertFiniteResult(sum / count);
          const min = Math.min(...vals);
          const max = Math.max(...vals);

          allPoints.push({ period, count, sum, mean, min, max });
        } else {
          allPoints.push({ period, count: 0 });
        }
      } else {
        allPoints.push({ period, count });
      }
    }

    const truncated = totalResults > DATASET_LIMITS.maxResultRows;
    const returnedPoints = allPoints.slice(0, DATASET_LIMITS.maxResultRows);

    return {
      dateColumn,
      valueColumn,
      granularity,
      points: returnedPoints,
      truncated,
      totalResults,
      returnedResults: returnedPoints.length
    };
  }
}
