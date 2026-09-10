import {
  CorrelationResult,
  DateDescribe,
  DescribeResult,
  DuplicateResult,
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
          numericVals.push(v);
        } else if (typeof v === "boolean") {
          strVals.push(String(v));
        } else if (v instanceof Date) {
          dateVals.push(v);
        } else if (typeof v === "string") {
          const trimmed = v.trim();
          if (!isNaN(Number(trimmed)) && trimmed !== "") {
            numericVals.push(Number(trimmed));
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
    this.validateDataset(rows);
    if (mode === "COUNT_ROWS") return rows.length;
    if (!column) return rows.length;
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
        if (!isNaN(n)) nums.push(n);
        else throw new Error(WORKBENCH_ERRORS.DATA_TYPE_UNSUPPORTED);
      }
    }
    return nums;
  }

  sum(rows: Record<string, unknown>[], column: string): number {
    const nums = this.getNumericValues(rows, column);
    return nums.reduce((a, b) => a + b, 0);
  }

  mean(rows: Record<string, unknown>[], column: string): number {
    const nums = this.getNumericValues(rows, column);
    if (nums.length === 0) return 0;
    return nums.reduce((a, b) => a + b, 0) / nums.length;
  }

  median(rows: Record<string, unknown>[], column: string): number {
    const nums = this.getNumericValues(rows, column).sort((a, b) => a - b);
    if (nums.length === 0) return 0;
    const mid = Math.floor(nums.length / 2);
    return nums.length % 2 !== 0 ? nums[mid] : (nums[mid - 1] + nums[mid]) / 2;
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
    const avg = nums.reduce((a, b) => a + b, 0) / nums.length;
    const variance = nums.reduce((a, b) => a + Math.pow(b - avg, 2), 0) / (nums.length - 1);
    return Math.sqrt(variance);
  }

  groupBy(
    rows: Record<string, unknown>[],
    groupColumn: string,
    valueColumn?: string,
    fn: "COUNT" | "SUM" | "MEAN" | "MIN" | "MAX" = "COUNT"
  ): Record<string, unknown>[] {
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

    const results: Record<string, unknown>[] = [];
    for (const [key, groupRows] of groups.entries()) {
      if (results.length >= DATASET_LIMITS.maxResultRows) break;

      let val: number = 0;
      if (fn === "COUNT") {
        val = groupRows.length;
      } else if (valueColumn) {
        if (fn === "SUM") val = this.sum(groupRows, valueColumn);
        else if (fn === "MEAN") val = this.mean(groupRows, valueColumn);
        else if (fn === "MIN") val = this.min(groupRows, valueColumn);
        else if (fn === "MAX") val = this.max(groupRows, valueColumn);
      }

      results.push({
        [groupColumn]: key,
        [valueColumn ? `${valueColumn}_${fn.toLowerCase()}` : fn.toLowerCase()]: val
      });
    }

    return results;
  }

  topN(rows: Record<string, unknown>[], column: string, n = 10): Record<string, unknown>[] {
    const columns = this.validateDataset(rows);
    if (!columns.includes(column)) {
      throw new Error(WORKBENCH_ERRORS.DATA_COLUMN_NOT_FOUND);
    }

    if (typeof n !== "number" || isNaN(n) || n <= 0 || !Number.isInteger(n)) {
      throw new Error(WORKBENCH_ERRORS.DATA_TYPE_UNSUPPORTED);
    }

    const cap = Math.min(n, DATASET_LIMITS.maxResultRows);
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
      if (!isNaN(valA) && !isNaN(valB)) return valB - valA;
      return String(rawB).localeCompare(String(rawA));
    });

    return sorted.slice(0, cap);
  }

  bottomN(rows: Record<string, unknown>[], column: string, n = 10): Record<string, unknown>[] {
    const columns = this.validateDataset(rows);
    if (!columns.includes(column)) {
      throw new Error(WORKBENCH_ERRORS.DATA_COLUMN_NOT_FOUND);
    }

    if (typeof n !== "number" || isNaN(n) || n <= 0 || !Number.isInteger(n)) {
      throw new Error(WORKBENCH_ERRORS.DATA_TYPE_UNSUPPORTED);
    }

    const cap = Math.min(n, DATASET_LIMITS.maxResultRows);
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
      if (!isNaN(valA) && !isNaN(valB)) return valA - valB;
      return String(rawA).localeCompare(String(rawB));
    });

    return sorted.slice(0, cap);
  }

  distribution(rows: Record<string, unknown>[], column: string): { value: string; count: number; percentage: number }[] {
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
    const sorted = Array.from(counts.entries())
      .map(([value, cnt]) => ({
        value,
        count: cnt,
        percentage: total > 0 ? Number(((cnt / total) * 100).toFixed(2)) : 0
      }))
      .sort((a, b) => b.count - a.count);

    return sorted.slice(0, DATASET_LIMITS.maxResultRows);
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
        if (!isNaN(num)) {
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

    const q1 = calcQuartile(0.25);
    const q3 = calcQuartile(0.75);
    const iqr = q3 - q1;
    const lowerBound = q1 - 1.5 * iqr;
    const upperBound = q3 + 1.5 * iqr;

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
        if (!isNaN(numA) && !isNaN(numB)) {
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

    const coefficient = den === 0 ? 0 : Number((num / den).toFixed(4));

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
        const firstDayOfYear = new Date(Date.UTC(year, 0, 1));
        const pastDaysOfYear = (dateObj.getTime() - firstDayOfYear.getTime()) / 86400000;
        const weekNum = Math.ceil((pastDaysOfYear + firstDayOfYear.getUTCDay() + 1) / 7);
        key = `${year}-W${String(weekNum).padStart(2, "0")}`;
      }

      if (!groups.has(key)) groups.set(key, []);

      if (valueColumn) {
        const rawVal = r[valueColumn];
        if (rawVal !== null && rawVal !== undefined && rawVal !== "" && typeof rawVal !== "boolean") {
          const val = Number(rawVal);
          if (!isNaN(val) && isFinite(val)) {
            groups.get(key)!.push(val);
          } else {
            throw new Error(WORKBENCH_ERRORS.DATA_TYPE_UNSUPPORTED);
          }
        }
      } else {
        groups.get(key)!.push(1);
      }
    }

    const points: TimeSeriesPoint[] = [];
    const sortedKeys = Array.from(groups.keys()).sort();

    for (const period of sortedKeys) {
      const vals = groups.get(period)!;
      const count = vals.length;

      if (valueColumn) {
        if (count > 0) {
          const sum = vals.reduce((a, b) => a + b, 0);
          const mean = sum / count;
          const min = Math.min(...vals);
          const max = Math.max(...vals);

          points.push({ period, count, sum, mean, min, max });
        } else {
          points.push({ period, count: 0 });
        }
      } else {
        points.push({ period, count });
      }
    }

    return {
      dateColumn,
      valueColumn,
      granularity,
      points
    };
  }
}
