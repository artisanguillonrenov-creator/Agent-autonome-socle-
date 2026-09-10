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
  private validateDataset(rows: Record<string, unknown>[]): void {
    if (rows.length > DATASET_LIMITS.maxRowsInMemory) {
      throw new Error(WORKBENCH_ERRORS.DATASET_LIMIT_EXCEEDED);
    }
    if (rows.length > 0) {
      const colCount = Object.keys(rows[0]).length;
      if (colCount > DATASET_LIMITS.maxColumns) {
        throw new Error(WORKBENCH_ERRORS.DATASET_LIMIT_EXCEEDED);
      }
      if (rows.length * colCount > DATASET_LIMITS.maxCells) {
        throw new Error(WORKBENCH_ERRORS.DATASET_LIMIT_EXCEEDED);
      }
    }
  }

  describe(rows: Record<string, unknown>[]): DescribeResult {
    this.validateDataset(rows);
    const numericColumns: Record<string, NumericDescribe> = {};
    const stringColumns: Record<string, StringDescribe> = {};
    const dateColumns: Record<string, DateDescribe> = {};

    if (rows.length === 0) {
      return { numericColumns, stringColumns, dateColumns, totalRows: 0 };
    }

    const columns = Object.keys(rows[0]);

    for (const col of columns) {
      const rawVals = rows.map((r) => r[col]);
      const nonNullVals = rawVals.filter((v) => v !== null && v !== undefined && v !== "");
      const missingCount = rawVals.length - nonNullVals.length;

      // Classify column type based on non-null values
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

  missingValues(rows: Record<string, unknown>[]): MissingValueResult[] {
    this.validateDataset(rows);
    if (rows.length === 0) return [];

    const columns = Object.keys(rows[0]);
    const results: MissingValueResult[] = [];

    for (const col of columns) {
      let missingCount = 0;
      for (const row of rows) {
        const val = row[col];
        // Strictly distinguish 0, false, "" from null / undefined
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
    this.validateDataset(rows);
    if (rows.length === 0 || !(column in (rows[0] ?? {}))) {
      throw new Error(WORKBENCH_ERRORS.DATA_COLUMN_NOT_FOUND);
    }

    const numericVals: number[] = [];
    for (const r of rows) {
      const val = r[column];
      if (val !== null && val !== undefined && val !== "") {
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
    this.validateDataset(rows);
    if (rows.length === 0 || !(columnA in (rows[0] ?? {})) || !(columnB in (rows[0] ?? {}))) {
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
        valB !== null &&
        valB !== undefined &&
        valB !== ""
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
    this.validateDataset(rows);
    if (rows.length === 0 || !(dateColumn in (rows[0] ?? {}))) {
      throw new Error(WORKBENCH_ERRORS.DATA_COLUMN_NOT_FOUND);
    }

    const groups = new Map<string, number[]>();

    for (const r of rows) {
      const rawDate = r[dateColumn];
      if (!rawDate) continue;

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
        // Simple ISO week key calculation
        const firstDayOfYear = new Date(Date.UTC(year, 0, 1));
        const pastDaysOfYear = (dateObj.getTime() - firstDayOfYear.getTime()) / 86400000;
        const weekNum = Math.ceil((pastDaysOfYear + firstDayOfYear.getUTCDay() + 1) / 7);
        key = `${year}-W${String(weekNum).padStart(2, "0")}`;
      }

      if (!groups.has(key)) groups.set(key, []);

      if (valueColumn) {
        const val = Number(r[valueColumn]);
        if (!isNaN(val)) {
          groups.get(key)!.push(val);
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
        const sum = vals.reduce((a, b) => a + b, 0);
        const mean = count > 0 ? sum / count : 0;
        const min = Math.min(...vals);
        const max = Math.max(...vals);

        points.push({ period, count, sum, mean, min, max });
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
