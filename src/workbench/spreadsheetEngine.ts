import { readFileSync, statSync } from "node:fs";
import ExcelJS from "exceljs";
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

  private parseCsvTsvContent(
    content: string,
    delimiter: string
  ): { headers: string[]; rows: string[][] } {
    const lines = content.split(/\r?\n/).filter((line) => line.length > 0);
    if (lines.length === 0) {
      return { headers: [], rows: [] };
    }

    const parseLine = (line: string): string[] => {
      const result: string[] = [];
      let current = "";
      let inQuotes = false;
      for (let i = 0; i < line.length; i++) {
        const char = line[i];
        if (char === '"') {
          if (inQuotes && line[i + 1] === '"') {
            current += '"';
            i++;
          } else {
            inQuotes = !inQuotes;
          }
        } else if (char === delimiter && !inQuotes) {
          result.push(current.trim());
          current = "";
        } else {
          current += char;
        }
      }
      result.push(current.trim());
      return result;
    };

    const rawHeaders = parseLine(lines[0]);
    const headers = rawHeaders.map((h, i) => (h ? h : `col_${i + 1}`));
    const rows = lines.slice(1).map((line) => parseLine(line));

    return { headers, rows };
  }

  private async loadXlsxWorkbook(absolutePath: string): Promise<ExcelJS.Workbook> {
    const workbook = new ExcelJS.Workbook();
    try {
      await workbook.xlsx.readFile(absolutePath);
      return workbook;
    } catch {
      throw new Error(WORKBENCH_ERRORS.SPREADSHEET_FORMAT_UNSUPPORTED);
    }
  }

  async inspect(workspaceId: string, relativePath: string): Promise<SpreadsheetInspectResult> {
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
    let sheetNames: string[] = [];
    let rowCount = 0;
    let columnCount = 0;
    let columns: string[] = [];
    let sampleRows: Record<string, unknown>[] = [];
    const warnings: string[] = ["Type inferences are estimates based on cell inspection."];

    if (format === "csv" || format === "tsv") {
      sheetNames = ["Sheet1"];
      const delimiter = format === "csv" ? "," : "\t";
      const content = readFileSync(absolutePath, "utf-8");
      const { headers, rows } = this.parseCsvTsvContent(content, delimiter);

      columns = headers;
      rowCount = rows.length;
      columnCount = headers.length;

      // Bound inspection to first 500 rows
      const boundedRows = rows.slice(0, 500);
      if (rows.length > 500) {
        warnings.push("Type inference and statistics estimated from first 500 rows.");
      }

      sampleRows = boundedRows.slice(0, 5).map((r) => {
        const rowObj: Record<string, unknown> = {};
        columns.forEach((col, idx) => {
          rowObj[col] = r[idx] ?? null;
        });
        return rowObj;
      });

      const inferredTypes = this.inferTypesFromRows(
        boundedRows.map((r) => {
          const obj: Record<string, unknown> = {};
          columns.forEach((col, idx) => {
            obj[col] = r[idx] ?? null;
          });
          return obj;
        }),
        columns
      );

      return {
        file: cleanRel,
        format,
        sheetNames,
        rowCount,
        columnCount,
        columns,
        inferredTypes: inferredTypes.types,
        emptyCells: inferredTypes.emptyCells,
        sampleRows,
        warnings
      };
    } else {
      const workbook = await this.loadXlsxWorkbook(absolutePath);
      sheetNames = workbook.worksheets.map((s) => s.name);
      if (sheetNames.length === 0) {
        throw new Error(WORKBENCH_ERRORS.SPREADSHEET_FORMAT_UNSUPPORTED);
      }

      const sheet = workbook.worksheets[0];
      rowCount = Math.max(0, sheet.rowCount - 1); // Exclude header row

      const headerRow = sheet.getRow(1);
      const headerValues = Array.isArray(headerRow.values) ? headerRow.values.slice(1) : [];
      columns = headerValues.map((h, i) => (h !== null && h !== undefined && String(h).trim() !== "" ? String(h) : `col_${i + 1}`));
      columnCount = columns.length;

      // Inspect at most 500 rows
      const inspectRowCount = Math.min(rowCount, 500);
      if (rowCount > 500) {
        warnings.push("Type inference and statistics estimated from first 500 rows.");
      }

      const inspectedRows: Record<string, unknown>[] = [];
      for (let r = 2; r <= inspectRowCount + 1; r++) {
        const row = sheet.getRow(r);
        const rowObj: Record<string, unknown> = {};
        columns.forEach((col, cIdx) => {
          const cellVal = row.getCell(cIdx + 1).value;
          rowObj[col] = this.extractCellValue(cellVal);
        });
        inspectedRows.push(rowObj);
      }

      sampleRows = inspectedRows.slice(0, 5);
      const inferredTypes = this.inferTypesFromRows(inspectedRows, columns);

      return {
        file: cleanRel,
        format,
        sheetNames,
        rowCount,
        columnCount,
        columns,
        inferredTypes: inferredTypes.types,
        emptyCells: inferredTypes.emptyCells,
        sampleRows,
        warnings
      };
    }
  }

  async listSheets(workspaceId: string, relativePath: string): Promise<string[]> {
    const { relativePath: cleanRel, absolutePath } = resolveWorkspacePath(
      this.workspaceStore,
      workspaceId,
      relativePath
    );

    const format = this.detectFormat(cleanRel);
    if (format === "csv" || format === "tsv") {
      return ["Sheet1"];
    }

    const workbook = await this.loadXlsxWorkbook(absolutePath);
    return workbook.worksheets.map((s) => s.name);
  }

  async readRange(
    workspaceId: string,
    relativePath: string,
    options: ReadRangeOptions = {}
  ): Promise<RangeResult> {
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
    const warnings: string[] = [];
    let truncated = false;

    if (format === "csv" || format === "tsv") {
      const delimiter = format === "csv" ? "," : "\t";
      const content = readFileSync(absolutePath, "utf-8");
      const { headers, rows: allDataRows } = this.parseCsvTsvContent(content, delimiter);

      const totalRows = allDataRows.length;
      let startRow = options.startRow ?? 0;
      let endRow = options.endRow ?? totalRows;

      if (startRow < 0 || endRow < startRow) {
        throw new Error(WORKBENCH_ERRORS.SPREADSHEET_RANGE_INVALID);
      }

      let requestedColumns = options.columns;
      if (!requestedColumns || requestedColumns.length === 0) {
        requestedColumns = headers;
      }

      // PRE-CALCULATE BOUNDS BEFORE ROW OBJECT MATERIALIZATION
      let effectiveColumnCount = requestedColumns.length;
      if (effectiveColumnCount > SPREADSHEET_LIMITS.maxColumnsPerRead) {
        effectiveColumnCount = SPREADSHEET_LIMITS.maxColumnsPerRead;
        truncated = true;
        warnings.push(`Columns capped at ${SPREADSHEET_LIMITS.maxColumnsPerRead}.`);
      }
      const columns = requestedColumns.slice(0, effectiveColumnCount);

      const maxAllowedRows = Math.min(
        SPREADSHEET_LIMITS.maxRowsPerRead,
        Math.floor(SPREADSHEET_LIMITS.maxCellsPerRead / Math.max(1, effectiveColumnCount))
      );

      const requestedRowCount = endRow - startRow;
      if (requestedRowCount > maxAllowedRows) {
        truncated = true;
        warnings.push(`Rows capped at ${maxAllowedRows} due to cell/row limits.`);
      }

      const effectiveEndRow = Math.min(endRow, startRow + maxAllowedRows);

      // Materialize ONLY the bounded row slice
      const slicedRows = allDataRows.slice(startRow, effectiveEndRow);
      const rowObjects = slicedRows.map((r) => {
        const rowObj: Record<string, unknown> = {};
        columns.forEach((col) => {
          const colIdx = headers.indexOf(col);
          rowObj[col] = colIdx >= 0 ? r[colIdx] ?? null : null;
        });
        return rowObj;
      });

      return {
        sheet: "Sheet1",
        columns,
        rows: rowObjects,
        totalRows,
        truncated,
        warnings
      };
    } else {
      const workbook = await this.loadXlsxWorkbook(absolutePath);
      const targetSheetName = options.sheet || workbook.worksheets[0]?.name;
      const sheet = targetSheetName ? workbook.getWorksheet(targetSheetName) : undefined;
      if (!sheet) {
        throw new Error(WORKBENCH_ERRORS.SPREADSHEET_RANGE_INVALID);
      }

      const totalRows = Math.max(0, sheet.rowCount - 1);
      let startRow = options.startRow ?? 0;
      let endRow = options.endRow ?? totalRows;

      if (startRow < 0 || endRow < startRow) {
        throw new Error(WORKBENCH_ERRORS.SPREADSHEET_RANGE_INVALID);
      }

      const headerRow = sheet.getRow(1);
      const headerValues = Array.isArray(headerRow.values) ? headerRow.values.slice(1) : [];
      const headers = headerValues.map((h, i) => (h !== null && h !== undefined && String(h).trim() !== "" ? String(h) : `col_${i + 1}`));

      let requestedColumns = options.columns;
      if (!requestedColumns || requestedColumns.length === 0) {
        requestedColumns = headers;
      }

      // PRE-CALCULATE BOUNDS BEFORE ROW MATERIALIZATION
      let effectiveColumnCount = requestedColumns.length;
      if (effectiveColumnCount > SPREADSHEET_LIMITS.maxColumnsPerRead) {
        effectiveColumnCount = SPREADSHEET_LIMITS.maxColumnsPerRead;
        truncated = true;
        warnings.push(`Columns capped at ${SPREADSHEET_LIMITS.maxColumnsPerRead}.`);
      }
      const columns = requestedColumns.slice(0, effectiveColumnCount);

      const maxAllowedRows = Math.min(
        SPREADSHEET_LIMITS.maxRowsPerRead,
        Math.floor(SPREADSHEET_LIMITS.maxCellsPerRead / Math.max(1, effectiveColumnCount))
      );

      const requestedRowCount = endRow - startRow;
      if (requestedRowCount > maxAllowedRows) {
        truncated = true;
        warnings.push(`Rows capped at ${maxAllowedRows} due to cell/row limits.`);
      }

      const effectiveEndRow = Math.min(endRow, startRow + maxAllowedRows);

      // Materialize ONLY rows from (startRow + 2) to (effectiveEndRow + 1)
      const rowObjects: Record<string, unknown>[] = [];
      const startExcelRow = startRow + 2; // Row 1 is header
      const endExcelRow = effectiveEndRow + 1;

      for (let r = startExcelRow; r <= endExcelRow && r <= sheet.rowCount; r++) {
        const row = sheet.getRow(r);
        const rowObj: Record<string, unknown> = {};
        columns.forEach((col) => {
          const colIdx = headers.indexOf(col);
          if (colIdx >= 0) {
            rowObj[col] = this.extractCellValue(row.getCell(colIdx + 1).value);
          } else {
            rowObj[col] = null;
          }
        });
        rowObjects.push(rowObj);
      }

      return {
        sheet: targetSheetName,
        columns,
        rows: rowObjects,
        totalRows,
        truncated,
        warnings
      };
    }
  }

  private extractCellValue(val: ExcelJS.CellValue): unknown {
    if (val === null || val === undefined) return null;
    if (typeof val === "object") {
      if (val instanceof Date) return val.toISOString();
      if ("result" in val && val.result !== undefined) {
        return this.extractCellValue(val.result as any);
      }
      if ("text" in val && typeof val.text === "string") {
        return val.text;
      }
    }
    return val;
  }

  private inferTypesFromRows(
    rows: Record<string, unknown>[],
    columns: string[]
  ): { types: Record<string, ColumnType>; emptyCells: number } {
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

    for (const row of rows) {
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

    const types: Record<string, ColumnType> = {};
    for (const col of columns) {
      const counts = typeCounts[col];
      const nonAttr = Object.entries(counts).filter(([k, v]) => k !== "EMPTY" && v > 0);

      if (nonAttr.length === 0) {
        types[col] = "EMPTY";
      } else if (nonAttr.length === 1) {
        types[col] = nonAttr[0][0] as ColumnType;
      } else if (nonAttr.length === 2 && counts.INTEGER > 0 && counts.FLOAT > 0) {
        types[col] = "FLOAT";
      } else {
        types[col] = "MIXED";
      }
    }

    return { types, emptyCells };
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
    const headers = Object.keys(rows[0]);
    const escape = (val: unknown) => {
      const str = String(val ?? "");
      if (str.includes(",") || str.includes('"') || str.includes("\n")) {
        return `"${str.replace(/"/g, '""')}"`;
      }
      return str;
    };

    const lines = [headers.join(",")];
    for (const row of rows) {
      lines.push(headers.map((h) => escape(row[h])).join(","));
    }
    return lines.join("\n");
  }

  async exportXlsx(rows: Record<string, unknown>[], sheetName = "Sheet1"): Promise<Buffer> {
    const workbook = new ExcelJS.Workbook();
    const sheet = workbook.addWorksheet(sheetName);

    if (rows.length > 0) {
      const headers = Object.keys(rows[0]);
      sheet.addRow(headers);
      for (const row of rows) {
        sheet.addRow(headers.map((h) => row[h] ?? null));
      }
    }

    const buffer = await workbook.xlsx.writeBuffer();
    return Buffer.from(buffer);
  }
}
