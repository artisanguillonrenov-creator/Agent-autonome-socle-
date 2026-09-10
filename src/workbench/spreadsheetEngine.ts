import { readFileSync, statSync } from "node:fs";
import XLSX from "xlsx";
import { WorkspaceStore } from "../workspaces/workspaceStore.js";
import {
  AggregateFunction,
  AggregateOptions,
  ColumnType,
  FilterCondition,
  RangeResult,
  ReadRangeOptions,
  resolveWorkspacePath,
  SortCondition,
  SpreadsheetInspectResult,
  WORKBENCH_ERRORS
} from "./workbenchTypes.js";

export const SPREADSHEET_LIMITS = {
  maxInputBytes: 25 * 1024 * 1024, // 25 MB max input file size
  maxRowsPerRead: 10_000,
  maxColumnsPerRead: 200,
  maxCellsPerRead: 250_000
};

export class SpreadsheetEngine {
  constructor(private workspaceStore: WorkspaceStore = new WorkspaceStore()) {}

  private detectFormat(relativePath: string): "csv" | "tsv" | "xlsx" {
    const ext = relativePath.split(".").pop()?.toLowerCase();
    switch (ext) {
      case "csv":
        return "csv";
      case "tsv":
        return "tsv";
      case "xlsx":
      case "xls":
        return "xlsx";
      default:
        throw new Error(WORKBENCH_ERRORS.SPREADSHEET_FORMAT_UNSUPPORTED);
    }
  }

  private readWorkbook(workspaceId: string, relativePath: string): {
    workbook: XLSX.WorkBook;
    format: "csv" | "tsv" | "xlsx";
    cleanRel: string;
  } {
    const { relativePath: cleanRel, absolutePath } = resolveWorkspacePath(
      this.workspaceStore,
      workspaceId,
      relativePath
    );

    const stats = statSync(absolutePath);
    if (stats.size > SPREADSHEET_LIMITS.maxInputBytes) {
      throw new Error(WORKBENCH_ERRORS.SPREADSHEET_LIMIT_EXCEEDED);
    }

    const format = this.detectFormat(cleanRel);
    let workbook: XLSX.WorkBook;

    try {
      if (format === "csv") {
        const content = readFileSync(absolutePath, "utf-8");
        workbook = XLSX.read(content, { type: "string", raw: false });
      } else if (format === "tsv") {
        const content = readFileSync(absolutePath, "utf-8");
        workbook = XLSX.read(content, { type: "string", FS: "\t", raw: false });
      } else {
        const buffer = readFileSync(absolutePath);
        workbook = XLSX.read(buffer, { type: "buffer", cellFormula: false, cellHTML: false });
      }
    } catch (e: any) {
      if (e?.message === WORKBENCH_ERRORS.SPREADSHEET_LIMIT_EXCEEDED) throw e;
      throw new Error(WORKBENCH_ERRORS.SPREADSHEET_FORMAT_UNSUPPORTED);
    }

    return { workbook, format, cleanRel };
  }

  inspect(workspaceId: string, relativePath: string): SpreadsheetInspectResult {
    const { workbook, format, cleanRel } = this.readWorkbook(workspaceId, relativePath);
    const sheetNames = workbook.SheetNames;
    if (sheetNames.length === 0) {
      throw new Error(WORKBENCH_ERRORS.SPREADSHEET_FORMAT_UNSUPPORTED);
    }

    const firstSheet = workbook.Sheets[sheetNames[0]];
    const rawRows = XLSX.utils.sheet_to_json<Record<string, unknown>>(firstSheet, {
      defval: null,
      raw: true
    });

    const columns: string[] = [];
    if (rawRows.length > 0) {
      for (const key of Object.keys(rawRows[0])) {
        if (!columns.includes(key)) columns.push(key);
      }
    }

    let emptyCells = 0;
    const typeCounts: Record<string, Record<ColumnType, number>> = {};
    for (const col of columns) {
      typeCounts[col] = {
        STRING: 0,
        INTEGER: 0,
        FLOAT: 0,
        BOOLEAN: 0,
        DATE: 0,
        DATETIME: 0,
        MIXED: 0,
        EMPTY: 0
      };
    }

    for (const row of rawRows) {
      for (const col of columns) {
        const val = row[col];
        if (val === null || val === undefined || val === "") {
          emptyCells++;
          typeCounts[col].EMPTY++;
        } else if (typeof val === "boolean") {
          typeCounts[col].BOOLEAN++;
        } else if (typeof val === "number") {
          if (Number.isInteger(val)) {
            typeCounts[col].INTEGER++;
          } else {
            typeCounts[col].FLOAT++;
          }
        } else if (val instanceof Date) {
          typeCounts[col].DATE++;
        } else if (typeof val === "string") {
          const trimmed = val.trim();
          if (!isNaN(Number(trimmed)) && trimmed !== "") {
            if (Number.isInteger(Number(trimmed))) {
              typeCounts[col].INTEGER++;
            } else {
              typeCounts[col].FLOAT++;
            }
          } else if (!isNaN(Date.parse(trimmed)) && trimmed.length > 5 && (trimmed.includes("-") || trimmed.includes("/"))) {
            typeCounts[col].DATE++;
          } else if (["true", "false"].includes(trimmed.toLowerCase())) {
            typeCounts[col].BOOLEAN++;
          } else {
            typeCounts[col].STRING++;
          }
        } else {
          typeCounts[col].STRING++;
        }
      }
    }

    const inferredTypes: Record<string, ColumnType> = {};
    for (const col of columns) {
      const counts = typeCounts[col];
      const nonAttr = Object.entries(counts).filter(([k, v]) => k !== "EMPTY" && v > 0);

      if (nonAttr.length === 0) {
        inferredTypes[col] = "EMPTY";
      } else if (nonAttr.length === 1) {
        inferredTypes[col] = nonAttr[0][0] as ColumnType;
      } else if (
        nonAttr.length === 2 &&
        counts.INTEGER > 0 &&
        counts.FLOAT > 0
      ) {
        inferredTypes[col] = "FLOAT";
      } else {
        inferredTypes[col] = "MIXED";
      }
    }

    const sampleRows = rawRows.slice(0, 5);

    return {
      file: cleanRel,
      format,
      sheetNames,
      rowCount: rawRows.length,
      columnCount: columns.length,
      columns,
      inferredTypes,
      emptyCells,
      sampleRows,
      warnings: ["Type inferences are estimates based on cell inspection."]
    };
  }

  listSheets(workspaceId: string, relativePath: string): string[] {
    const { workbook } = this.readWorkbook(workspaceId, relativePath);
    return workbook.SheetNames;
  }

  readRange(
    workspaceId: string,
    relativePath: string,
    options: ReadRangeOptions = {}
  ): RangeResult {
    const { workbook } = this.readWorkbook(workspaceId, relativePath);
    const targetSheetName = options.sheet || workbook.SheetNames[0];
    if (!workbook.SheetNames.includes(targetSheetName)) {
      throw new Error(WORKBENCH_ERRORS.SPREADSHEET_RANGE_INVALID);
    }

    const sheet = workbook.Sheets[targetSheetName];

    // Decode range to determine total rows
    const range = sheet["!ref"] ? XLSX.utils.decode_range(sheet["!ref"]) : { s: { r: 0, c: 0 }, e: { r: 0, c: 0 } };
    const totalRows = range.e.r >= range.s.r ? range.e.r - range.s.r + 1 : 0;

    let startRow = options.startRow ?? 0;
    let endRow = options.endRow ?? totalRows;

    if (startRow < 0 || endRow < startRow) {
      throw new Error(WORKBENCH_ERRORS.SPREADSHEET_RANGE_INVALID);
    }

    // Materialize ONLY the bounded row slice using XLSX range
    const maxBoundedEnd = Math.min(endRow, startRow + SPREADSHEET_LIMITS.maxRowsPerRead);
    const optionsSlice: XLSX.Sheet2JSONOpts = {
      defval: null,
      raw: true,
      range: {
        s: { r: range.s.r + (startRow > 0 ? startRow + 1 : 0), c: range.s.c },
        e: { r: Math.min(range.e.r, range.s.r + maxBoundedEnd), c: range.e.c }
      }
    };

    let rawRows = XLSX.utils.sheet_to_json<Record<string, unknown>>(sheet, optionsSlice);
    let sliced = rawRows.slice(0, endRow - startRow);

    const warnings: string[] = [];
    let truncated = false;

    if (sliced.length > SPREADSHEET_LIMITS.maxRowsPerRead) {
      sliced = sliced.slice(0, SPREADSHEET_LIMITS.maxRowsPerRead);
      truncated = true;
      warnings.push(`Rows capped at ${SPREADSHEET_LIMITS.maxRowsPerRead}.`);
    }

    let columns = options.columns;
    if (!columns || columns.length === 0) {
      columns = sliced.length > 0 ? Object.keys(sliced[0]) : [];
    }

    if (columns.length > SPREADSHEET_LIMITS.maxColumnsPerRead) {
      columns = columns.slice(0, SPREADSHEET_LIMITS.maxColumnsPerRead);
      truncated = true;
      warnings.push(`Columns capped at ${SPREADSHEET_LIMITS.maxColumnsPerRead}.`);
    }

    if (sliced.length * columns.length > SPREADSHEET_LIMITS.maxCellsPerRead) {
      const maxRows = Math.floor(SPREADSHEET_LIMITS.maxCellsPerRead / columns.length);
      sliced = sliced.slice(0, maxRows);
      truncated = true;
      warnings.push(`Cells capped at ${SPREADSHEET_LIMITS.maxCellsPerRead}.`);
    }

    const rows = sliced.map((row) => {
      const filteredRow: Record<string, unknown> = {};
      for (const col of columns!) {
        filteredRow[col] = row[col] ?? null;
      }
      return filteredRow;
    });

    return {
      sheet: targetSheetName,
      columns,
      rows,
      totalRows,
      truncated,
      warnings
    };
  }

  filter(
    rows: Record<string, unknown>[],
    conditions: FilterCondition[]
  ): Record<string, unknown>[] {
    return rows.filter((row) => {
      for (const cond of conditions) {
        const val = row[cond.column];
        const targetVal = cond.value;

        switch (cond.operator) {
          case "equals":
            if (String(val ?? "").toLowerCase() !== String(targetVal ?? "").toLowerCase()) return false;
            break;
          case "notEquals":
            if (String(val ?? "").toLowerCase() === String(targetVal ?? "").toLowerCase()) return false;
            break;
          case "contains":
            if (!String(val ?? "").toLowerCase().includes(String(targetVal ?? "").toLowerCase())) return false;
            break;
          case "startsWith":
            if (!String(val ?? "").toLowerCase().startsWith(String(targetVal ?? "").toLowerCase())) return false;
            break;
          case "endsWith":
            if (!String(val ?? "").toLowerCase().endsWith(String(targetVal ?? "").toLowerCase())) return false;
            break;
          case "greaterThan":
            if (Number(val) <= Number(targetVal)) return false;
            break;
          case "greaterOrEqual":
            if (Number(val) < Number(targetVal)) return false;
            break;
          case "lessThan":
            if (Number(val) >= Number(targetVal)) return false;
            break;
          case "lessOrEqual":
            if (Number(val) > Number(targetVal)) return false;
            break;
          case "isEmpty":
            if (val !== null && val !== undefined && val !== "") return false;
            break;
          case "isNotEmpty":
            if (val === null || val === undefined || val === "") return false;
            break;
        }
      }
      return true;
    });
  }

  sort(
    rows: Record<string, unknown>[],
    conditions: SortCondition[]
  ): Record<string, unknown>[] {
    const copy = [...rows];
    copy.sort((a, b) => {
      for (const cond of conditions) {
        const valA = a[cond.column];
        const valB = b[cond.column];

        if (valA === valB) continue;
        if (valA === null || valA === undefined) return 1;
        if (valB === null || valB === undefined) return -1;

        let cmp = 0;
        if (typeof valA === "number" && typeof valB === "number") {
          cmp = valA - valB;
        } else {
          cmp = String(valA).localeCompare(String(valB));
        }

        if (cmp !== 0) {
          return cond.direction === "ASC" ? cmp : -cmp;
        }
      }
      return 0;
    });
    return copy;
  }

  aggregate(
    rows: Record<string, unknown>[],
    options: AggregateOptions
  ): Record<string, unknown>[] {
    const fn = options.function;
    const valueCol = options.valueColumn;
    const groupCol = options.groupBy;

    if (groupCol) {
      const groups = new Map<string, unknown[]>();
      for (const row of rows) {
        const key = String(row[groupCol] ?? "null");
        if (!groups.has(key)) groups.set(key, []);
        if (valueCol) {
          groups.get(key)!.push(row[valueCol]);
        } else {
          groups.get(key)!.push(row);
        }
      }

      const results: Record<string, unknown>[] = [];
      for (const [key, vals] of groups.entries()) {
        const aggVal = this.calcAggregate(vals, fn);
        results.push({
          [groupCol]: key,
          [valueCol ? `${valueCol}_${fn.toLowerCase()}` : fn.toLowerCase()]: aggVal
        });
      }
      return results;
    } else {
      const vals = valueCol ? rows.map((r) => r[valueCol]) : rows;
      const aggVal = this.calcAggregate(vals, fn);
      return [
        {
          [valueCol ? `${valueCol}_${fn.toLowerCase()}` : fn.toLowerCase()]: aggVal
        }
      ];
    }
  }

  private calcAggregate(vals: unknown[], fn: AggregateFunction): number {
    if (fn === "COUNT") return vals.length;

    const validNums = vals
      .filter(
        (v) =>
          v !== null &&
          v !== undefined &&
          v !== "" &&
          typeof v !== "boolean" &&
          !isNaN(Number(v))
      )
      .map((v) => Number(v));

    if (validNums.length === 0) return 0;

    switch (fn) {
      case "SUM":
        return validNums.reduce((a, b) => a + b, 0);
      case "MEAN":
        return validNums.reduce((a, b) => a + b, 0) / validNums.length;
      case "MIN":
        return Math.min(...validNums);
      case "MAX":
        return Math.max(...validNums);
      default:
        return 0;
    }
  }

  exportCsv(rows: Record<string, unknown>[]): string {
    if (rows.length === 0) return "";
    const sheet = XLSX.utils.json_to_sheet(rows);
    return XLSX.utils.sheet_to_csv(sheet);
  }

  exportXlsx(rows: Record<string, unknown>[], sheetName = "Sheet1"): Buffer {
    const sheet = XLSX.utils.json_to_sheet(rows);
    const wb = XLSX.utils.book_new();
    XLSX.utils.book_append_sheet(wb, sheet, sheetName);
    return XLSX.write(wb, { type: "buffer", bookType: "xlsx" });
  }
}
