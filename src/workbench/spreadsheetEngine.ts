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
  maxCellsPerRead: 250_000,
  maxInspectSampleRows: 500
};

// exportXlsx builds an output workbook entirely from caller-provided rows, so
// it needs its own documented ceiling to stop a single call from allocating
// an unbounded number of cells in memory.
export const SPREADSHEET_EXPORT_LIMITS = {
  maxRows: 100_000,
  maxColumns: 200,
  maxCells: 2_000_000
};

const XLSX_STREAM_OPTIONS = {
  worksheets: "emit" as const,
  sharedStrings: "cache" as const,
  hyperlinks: "ignore" as const,
  styles: "cache" as const,
  entries: "ignore" as const
};

/**
 * Parses delimited (CSV/TSV) text into rows, one at a time, honoring RFC
 * 4180-style quoting: quoted fields may contain the delimiter, embedded
 * CRLF/LF newlines, and "" as an escaped literal quote. Splitting on
 * newlines before parsing quotes (the previous approach) breaks any field
 * that legitimately contains a newline.
 */
function* parseDelimitedRows(content: string, delimiter: string): Generator<string[]> {
  const len = content.length;
  let i = 0;
  let field = "";
  let row: string[] = [];
  let inQuotes = false;
  let rowHasContent = false;

  while (i < len) {
    const char = content[i];

    if (inQuotes) {
      if (char === '"') {
        if (content[i + 1] === '"') {
          field += '"';
          i += 2;
        } else {
          inQuotes = false;
          i++;
        }
      } else {
        field += char;
        i++;
      }
      continue;
    }

    if (char === '"' && field.length === 0) {
      inQuotes = true;
      rowHasContent = true;
      i++;
      continue;
    }

    if (char === delimiter) {
      row.push(field);
      field = "";
      rowHasContent = true;
      i++;
      continue;
    }

    if (char === "\r" || char === "\n") {
      if (char === "\r" && content[i + 1] === "\n") i++;
      i++;
      if (!rowHasContent && row.length === 0 && field.length === 0) {
        // A fully blank line is not a data row (mirrors previous behavior).
        continue;
      }
      row.push(field);
      yield row;
      row = [];
      field = "";
      rowHasContent = false;
      continue;
    }

    field += char;
    rowHasContent = true;
    i++;
  }

  if (rowHasContent || row.length > 0) {
    row.push(field);
    yield row;
  }
}

function buildHeaders(rawHeaders: string[]): string[] {
  return rawHeaders.map((h, i) => (h ? h : `col_${i + 1}`));
}

function validateRequestedColumns(requestedColumns: string[], headers: string[]): void {
  for (const col of requestedColumns) {
    if (!headers.includes(col)) {
      const err = new Error(WORKBENCH_ERRORS.SPREADSHEET_RANGE_INVALID);
      (err as Error & { invalidColumn?: string }).invalidColumn = col;
      throw err;
    }
  }
}

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
        return "xlsx";
      default:
        // Legacy binary .xls is intentionally NOT accepted: ExcelJS cannot
        // parse it, so claiming support here would fail later at parse time.
        throw new Error(WORKBENCH_ERRORS.SPREADSHEET_FORMAT_UNSUPPORTED);
    }
  }

  private async withXlsxWorkbookReader<T>(
    absolutePath: string,
    fn: (reader: ExcelJS.stream.xlsx.WorkbookReader) => Promise<T>
  ): Promise<T> {
    const reader = new ExcelJS.stream.xlsx.WorkbookReader(absolutePath, XLSX_STREAM_OPTIONS);
    try {
      return await fn(reader);
    } catch (e: any) {
      if (e instanceof Error && (Object.values(WORKBENCH_ERRORS) as string[]).includes(e.message)) {
        throw e;
      }
      throw new Error(WORKBENCH_ERRORS.SPREADSHEET_FORMAT_UNSUPPORTED);
    } finally {
      // Stopping mid-parse (early-stop on a bounded readRange) leaves the
      // underlying file stream open unless explicitly closed here.
      const stream = (reader as any).stream;
      if (stream && typeof stream.destroy === "function") {
        stream.on?.("error", () => {
          // Destroying a stream mid-pipe can surface a benign close error;
          // it must not become an unhandled 'error' event.
        });
        stream.destroy();
      }
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
    const warnings: string[] = ["Type inferences are estimates based on cell inspection."];

    if (format === "csv" || format === "tsv") {
      const delimiter = format === "csv" ? "," : "\t";
      const content = readFileSync(absolutePath, "utf-8");
      const iter = parseDelimitedRows(content, delimiter);
      const headerRes = iter.next();
      const columns = buildHeaders(headerRes.done ? [] : headerRes.value);

      const sampled: string[][] = [];
      let rowCount = 0;
      for (const row of iter) {
        if (sampled.length < SPREADSHEET_LIMITS.maxInspectSampleRows) {
          sampled.push(row);
        }
        rowCount++;
      }

      if (rowCount > SPREADSHEET_LIMITS.maxInspectSampleRows) {
        warnings.push(
          `Type inference and statistics estimated from first ${SPREADSHEET_LIMITS.maxInspectSampleRows} rows.`
        );
        warnings.push(
          `sampledEmptyCells reflects only the first ${SPREADSHEET_LIMITS.maxInspectSampleRows} rows, not the full sheet.`
        );
      }

      const sampledObjs = sampled.map((r) => {
        const rowObj: Record<string, unknown> = {};
        columns.forEach((col, idx) => {
          rowObj[col] = r[idx] ?? null;
        });
        return rowObj;
      });

      const inferredTypes = this.inferTypesFromRows(sampledObjs, columns);

      return {
        file: cleanRel,
        format,
        sheetNames: ["Sheet1"],
        rowCount,
        columnCount: columns.length,
        columns,
        inferredTypes: inferredTypes.types,
        sampledEmptyCells: inferredTypes.emptyCells,
        sampleRows: sampledObjs.slice(0, 5),
        warnings
      };
    }

    return this.withXlsxWorkbookReader(absolutePath, async (reader) => {
      const sheetNames: string[] = [];
      let columns: string[] = [];
      let rowCount = 0;
      const inspectedRows: Record<string, unknown>[] = [];
      let processedFirst = false;

      for await (const worksheetReader of reader) {
        sheetNames.push((worksheetReader as any).name);

        if (!processedFirst) {
          processedFirst = true;
          const it = worksheetReader[Symbol.asyncIterator]();
          const headerRes = await it.next();
          const headerRow = headerRes.done ? undefined : headerRes.value;
          const headerValues =
            headerRow && Array.isArray(headerRow.values) ? headerRow.values.slice(1) : [];
          columns = headerValues.map((h: unknown, i: number) =>
            h !== null && h !== undefined && String(h).trim() !== "" ? String(h) : `col_${i + 1}`
          );

          let lastDataIndex = -1;
          for await (const row of it) {
            const dataIndex = row.number - 2;
            if (dataIndex < 0) continue;
            lastDataIndex = Math.max(lastDataIndex, dataIndex);
            if (dataIndex < SPREADSHEET_LIMITS.maxInspectSampleRows) {
              const rowObj: Record<string, unknown> = {};
              columns.forEach((col, cIdx) => {
                rowObj[col] = this.extractCellValue(row.getCell(cIdx + 1).value);
              });
              inspectedRows.push(rowObj);
            }
          }
          rowCount = lastDataIndex + 1;
        } else {
          // Drain remaining sheets (required to advance the underlying zip
          // stream) but discard their content — only sheet[0] is inspected.
          for await (const _row of worksheetReader) {
            // no-op
          }
        }
      }

      if (sheetNames.length === 0) {
        throw new Error(WORKBENCH_ERRORS.SPREADSHEET_FORMAT_UNSUPPORTED);
      }

      if (rowCount > SPREADSHEET_LIMITS.maxInspectSampleRows) {
        warnings.push(
          `Type inference and statistics estimated from first ${SPREADSHEET_LIMITS.maxInspectSampleRows} rows.`
        );
        warnings.push(
          `sampledEmptyCells reflects only the first ${SPREADSHEET_LIMITS.maxInspectSampleRows} rows, not the full sheet.`
        );
      }

      const inferredTypes = this.inferTypesFromRows(inspectedRows, columns);

      return {
        file: cleanRel,
        format,
        sheetNames,
        rowCount,
        columnCount: columns.length,
        columns,
        inferredTypes: inferredTypes.types,
        sampledEmptyCells: inferredTypes.emptyCells,
        sampleRows: inspectedRows.slice(0, 5),
        warnings
      };
    });
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

    const stats = statSync(absolutePath);
    if (stats.size > SPREADSHEET_LIMITS.maxInputBytes) {
      throw new Error(WORKBENCH_ERRORS.SPREADSHEET_LIMIT_EXCEEDED);
    }

    return this.withXlsxWorkbookReader(absolutePath, async (reader) => {
      const names: string[] = [];
      for await (const worksheetReader of reader) {
        names.push((worksheetReader as any).name);
        for await (const _row of worksheetReader) {
          // drain to advance to the next sheet without retaining data
        }
      }
      return names;
    });
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

    const startRow = options.startRow ?? 0;
    const desiredEndRow = options.endRow ?? Infinity;
    if (startRow < 0 || desiredEndRow < startRow) {
      throw new Error(WORKBENCH_ERRORS.SPREADSHEET_RANGE_INVALID);
    }

    if (format === "csv" || format === "tsv") {
      const delimiter = format === "csv" ? "," : "\t";
      const content = readFileSync(absolutePath, "utf-8");
      const iter = parseDelimitedRows(content, delimiter);
      const headerRes = iter.next();
      const headers = buildHeaders(headerRes.done ? [] : headerRes.value);

      const requestedColumns = options.columns && options.columns.length > 0 ? options.columns : headers;
      validateRequestedColumns(requestedColumns, headers);

      const warnings: string[] = [];
      let truncated = false;

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
      const hardEndRow = startRow + maxAllowedRows;
      const collectEndRow = Math.min(desiredEndRow, hardEndRow);

      // Single streaming pass: only the requested slice is ever materialized
      // into row objects, while the total is still counted exactly (the
      // whole file is already bounded to 25 MB and held as one string).
      const colIndex = columns.map((col) => headers.indexOf(col));
      const rowObjects: Record<string, unknown>[] = [];
      let totalRows = 0;
      for (const row of iter) {
        if (totalRows >= startRow && totalRows < collectEndRow) {
          const rowObj: Record<string, unknown> = {};
          columns.forEach((col, idx) => {
            const ci = colIndex[idx];
            rowObj[col] = ci >= 0 ? row[ci] ?? null : null;
          });
          rowObjects.push(rowObj);
        }
        totalRows++;
      }

      if (hardEndRow < desiredEndRow && totalRows > hardEndRow) {
        truncated = true;
        warnings.push(`Rows capped at ${maxAllowedRows} due to cell/row limits.`);
      }

      return {
        sheet: "Sheet1",
        columns,
        rows: rowObjects,
        totalRows,
        totalRowsKnown: true,
        truncated,
        warnings
      };
    }

    return this.withXlsxWorkbookReader(absolutePath, async (reader) => {
      let result: RangeResult | undefined;

      for await (const worksheetReader of reader) {
        const name = (worksheetReader as any).name as string;
        const isTarget = options.sheet ? name === options.sheet : result === undefined;

        if (isTarget && result === undefined) {
          result = await this.readXlsxSheetBounded(worksheetReader, name, options, startRow, desiredEndRow);
          // Found what we need; no reason to read further sheets.
          break;
        } else {
          for await (const _row of worksheetReader) {
            // drain to advance past unwanted sheets
          }
        }
      }

      if (!result) {
        throw new Error(WORKBENCH_ERRORS.SPREADSHEET_RANGE_INVALID);
      }
      return result;
    });
  }

  private async readXlsxSheetBounded(
    worksheetReader: ExcelJS.stream.xlsx.WorksheetReader,
    sheetName: string,
    options: ReadRangeOptions,
    startRow: number,
    desiredEndRow: number
  ): Promise<RangeResult> {
    const it = worksheetReader[Symbol.asyncIterator]();
    const headerRes = await it.next();
    const headerRow = headerRes.done ? undefined : headerRes.value;
    const headerValues = headerRow && Array.isArray(headerRow.values) ? headerRow.values.slice(1) : [];
    const headers = headerValues.map((h: unknown, i: number) =>
      h !== null && h !== undefined && String(h).trim() !== "" ? String(h) : `col_${i + 1}`
    );

    const requestedColumns = options.columns && options.columns.length > 0 ? options.columns : headers;
    validateRequestedColumns(requestedColumns, headers);

    const warnings: string[] = [];
    let truncated = false;

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
    const hardEndRow = startRow + maxAllowedRows;
    const collectEndRow = Math.min(desiredEndRow, hardEndRow);

    const colIndex = columns.map((col) => headers.indexOf(col));
    const rowObjects: Record<string, unknown>[] = [];
    let lastDataIndex = -1;
    let hasMore = false;

    // `break` on an async for-await loop calls the iterator's return(),
    // which propagates through parseSax/iterateStream and stops pulling
    // further XML out of the underlying zip entry — so once the requested
    // range (plus one lookahead row to confirm more data exists) has been
    // seen, we genuinely stop parsing rather than draining the rest of a
    // multi-million-row sheet just to count it.
    for await (const row of it) {
      const dataIndex = row.number - 2;
      if (dataIndex < 0) continue;
      if (dataIndex >= collectEndRow) {
        hasMore = true;
        break;
      }
      lastDataIndex = dataIndex;
      if (dataIndex >= startRow) {
        const rowObj: Record<string, unknown> = {};
        columns.forEach((col, idx) => {
          const ci = colIndex[idx];
          rowObj[col] = ci >= 0 ? this.extractCellValue(row.getCell(ci + 1).value) : null;
        });
        rowObjects.push(rowObj);
      }
    }

    const totalRowsKnown = !hasMore;
    // When stopped early, this is a confirmed lower bound (rows 0..lastDataIndex
    // are known to exist), never an invented exact total.
    const totalRows = lastDataIndex + 1;
    if (hardEndRow < desiredEndRow && hasMore) {
      truncated = true;
      warnings.push(`Rows capped at ${maxAllowedRows} due to cell/row limits.`);
    }

    return {
      sheet: sheetName,
      columns,
      rows: rowObjects,
      totalRows,
      totalRowsKnown,
      truncated,
      warnings
    };
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
    if (rows.length > SPREADSHEET_EXPORT_LIMITS.maxRows) {
      throw new Error(WORKBENCH_ERRORS.SPREADSHEET_LIMIT_EXCEEDED);
    }

    const headers = rows.length > 0 ? Object.keys(rows[0]) : [];
    if (headers.length > SPREADSHEET_EXPORT_LIMITS.maxColumns) {
      throw new Error(WORKBENCH_ERRORS.SPREADSHEET_LIMIT_EXCEEDED);
    }
    if (rows.length * headers.length > SPREADSHEET_EXPORT_LIMITS.maxCells) {
      throw new Error(WORKBENCH_ERRORS.SPREADSHEET_LIMIT_EXCEEDED);
    }

    const workbook = new ExcelJS.Workbook();
    const sheet = workbook.addWorksheet(sheetName);

    if (rows.length > 0) {
      sheet.addRow(headers);
      for (const row of rows) {
        sheet.addRow(headers.map((h) => row[h] ?? null));
      }
    }

    const buffer = await workbook.xlsx.writeBuffer();
    return Buffer.from(buffer);
  }
}
