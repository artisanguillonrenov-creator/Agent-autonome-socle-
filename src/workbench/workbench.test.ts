import test from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, writeFileSync, rmSync, existsSync, symlinkSync } from "node:fs";
import { resolve } from "node:path";
import { randomUUID } from "node:crypto";
import { createRequire } from "node:module";
import Database from "better-sqlite3";
import ExcelJS from "exceljs";
import { WorkspaceStore } from "../workspaces/workspaceStore.js";
import { ArtifactStore } from "../workspaces/artifactStore.js";
import { DocumentEngine } from "./documentEngine.js";
import { SpreadsheetEngine, SPREADSHEET_LIMITS } from "./spreadsheetEngine.js";
import { DataAnalysisEngine } from "./dataAnalysisEngine.js";
import { DatabaseQueryEngine } from "./databaseQueryEngine.js";
import { ReportEngine } from "./reportEngine.js";
import { WORKBENCH_ERRORS, resolveWorkspacePath } from "./workbenchTypes.js";

const TEST_WORKSPACES_ROOT = resolve("test_workbench_workspaces");

function setupTestEnvironment() {
  if (existsSync(TEST_WORKSPACES_ROOT)) {
    rmSync(TEST_WORKSPACES_ROOT, { recursive: true, force: true });
  }
  mkdirSync(TEST_WORKSPACES_ROOT, { recursive: true });

  const workspaceStore = new WorkspaceStore(TEST_WORKSPACES_ROOT);
  const artifactStore = new ArtifactStore(workspaceStore);
  const workspace = workspaceStore.create({
    name: "Workbench Test Workspace",
    ownerType: "ADHOC",
    ownerId: `test-owner-${randomUUID()}`
  });

  return { workspaceStore, artifactStore, workspace };
}

function cleanupTestEnvironment() {
  if (existsSync(TEST_WORKSPACES_ROOT)) {
    rmSync(TEST_WORKSPACES_ROOT, { recursive: true, force: true });
  }
}

function createMinimalTextPdfBuffer(): Buffer {
  const pdfStr = `%PDF-1.4
1 0 obj <</Type /Catalog /Pages 2 0 R>> endobj
2 0 obj <</Type /Pages /Kinds [] /Count 1 /Kids [3 0 R]>> endobj
3 0 obj <</Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Contents 4 0 R /Resources <</Font <</F1 5 0 R>>>>>> endobj
4 0 obj <</Length 44>> stream
BT
/F1 12 Tf
100 700 Td
(Hello PDF Workbench) Tj
ET
endstream endobj
5 0 obj <</Type /Font /Subtype /Type1 /BaseFont /Helvetica>> endobj
xref
0 6
0000000000 65535 f
0000000009 00000 n
0000000062 00000 n
0000000133 00000 n
0000000259 00000 n
0000000353 00000 n
trailer <</Size 6 /Root 1 0 R>>
startxref
422
%%EOF`;
  return Buffer.from(pdfStr, "utf-8");
}

test("DOCUMENT SEARCH BOUNDS: maxResults clamped to 100 & contextChars clamped to 2000", async () => {
  const { workspaceStore, workspace } = setupTestEnvironment();
  const docEngine = new DocumentEngine(workspaceStore);

  const lines: string[] = ["# Big Search Doc"];
  for (let i = 0; i < 150; i++) {
    lines.push(`Occurrence ${i}: clause de résiliation test`);
  }
  workspaceStore.writeFile(workspace.id, "big_search.md", lines.join("\n"));

  const doc = await docEngine.readDocument(workspace.id, "big_search.md");

  const matches = docEngine.searchDocument(doc, {
    query: "resiliation",
    maxResults: 1_000_000,
    contextChars: 50_000
  });

  assert.equal(matches.length, 100);
  assert.ok(matches[0].excerpt.length <= 4100);

  cleanupTestEnvironment();
});

test("SPREADSHEET LIMIT TRUNCATION: >10,000 rows, maxColumnsPerRead, & maxCellsPerRead real tests", async () => {
  const { workspaceStore, workspace } = setupTestEnvironment();
  const engine = new SpreadsheetEngine(workspaceStore);

  // 1. >10,000 rows test
  const lines: string[] = ["id,val"];
  for (let i = 1; i <= 10005; i++) {
    lines.push(`${i},test_${i}`);
  }
  workspaceStore.writeFile(workspace.id, "big_sheet.csv", lines.join("\n"));

  const range = await engine.readRange(workspace.id, "big_sheet.csv");
  assert.equal(range.totalRows, 10005);
  assert.equal(range.rows.length, 10000);
  assert.equal(range.truncated, true);

  // 2. maxColumnsPerRead (>200 columns => capped at 200)
  const cols = Array.from({ length: 250 }, (_, i) => `col_${i + 1}`);
  const colLine = cols.join(",");
  const valLine = cols.map((_, i) => `val_${i + 1}`).join(",");
  workspaceStore.writeFile(workspace.id, "wide_sheet.csv", `${colLine}\n${valLine}`);

  const wideRange = await engine.readRange(workspace.id, "wide_sheet.csv");
  assert.equal(wideRange.columns.length, 200);
  assert.equal(wideRange.truncated, true);

  // 3. maxCellsPerRead test: 100 columns x 5000 rows = 500,000 cells requested => capped at 250,000 cells (2500 rows)
  const hundredCols = Array.from({ length: 100 }, (_, i) => `c_${i + 1}`);
  const hundredHeader = hundredCols.join(",");
  const cellLines = [hundredHeader];
  const sampleDataLine = hundredCols.map(() => "1").join(",");
  for (let i = 0; i < 5000; i++) {
    cellLines.push(sampleDataLine);
  }
  workspaceStore.writeFile(workspace.id, "cells_sheet.csv", cellLines.join("\n"));

  const cellsRange = await engine.readRange(workspace.id, "cells_sheet.csv");
  assert.equal(cellsRange.columns.length, 100);
  assert.equal(cellsRange.rows.length, 2500); // 100 * 2500 = 250,000 cells max
  assert.equal(cellsRange.truncated, true);

  // 4. XLSX export and roundtrip re-read test
  const wb = new ExcelJS.Workbook();
  const ws = wb.addWorksheet("Sheet1");
  ws.addRow(["id", "name"]);
  ws.addRow([1, "Alice"]);
  ws.addRow([2, "Bob"]);
  const xlsxBuf = Buffer.from(await wb.xlsx.writeBuffer());
  workspaceStore.writeFile(workspace.id, "roundtrip.xlsx", xlsxBuf);

  const reInspect = await engine.inspect(workspace.id, "roundtrip.xlsx");
  assert.equal(reInspect.format, "xlsx");
  assert.equal(reInspect.rowCount, 2);

  cleanupTestEnvironment();
});

test("DATA ANALYSIS BOUNDS & COUNT_NON_NULL VALIDATION: timeSeries, groupBy, distribution > 1000 items & missing column check", () => {
  const engine = new DataAnalysisEngine();

  assert.throws(
    () => engine.count([{ a: 1 }], "COUNT_NON_NULL"),
    (err: any) => err.message === WORKBENCH_ERRORS.DATA_COLUMN_NOT_FOUND
  );

  const bigDataset: Record<string, unknown>[] = [];
  const baseTs = new Date("2026-01-01T00:00:00.000Z").getTime();

  for (let i = 0; i < 1200; i++) {
    const dStr = new Date(baseTs + i * 86400000).toISOString().slice(0, 10);
    bigDataset.push({ date: dStr, group: `G_${i}`, val: i });
  }

  const groupRes = engine.groupBy(bigDataset, "group", "val", "COUNT");
  assert.equal(groupRes.totalResults, 1200);
  assert.equal(groupRes.returnedResults, 1000);
  assert.equal(groupRes.truncated, true);

  const distRes = engine.distribution(bigDataset, "group");
  assert.equal(distRes.totalResults, 1200);
  assert.equal(distRes.returnedResults, 1000);
  assert.equal(distRes.truncated, true);

  const tsRes = engine.timeSeriesSummary(bigDataset, "date", "DAY", "val");
  assert.equal(tsRes.totalResults, 1200);
  assert.equal(tsRes.returnedResults, 1000);
  assert.equal(tsRes.truncated, true);
});

test("NON-FINITE NUMBER REJECTION: DataAnalysisEngine never treats NaN/Infinity as a usable numeric value", () => {
  const engine = new DataAnalysisEngine();
  const nonFiniteValues = [NaN, Infinity, -Infinity, "Infinity", "-Infinity", "NaN"];

  for (const bad of nonFiniteValues) {
    const rows = [{ n: 1 }, { n: 2 }, { n: bad }];
    for (const op of ["sum", "mean", "median", "min", "max", "stddev"] as const) {
      assert.throws(
        () => (engine as any)[op](rows, "n"),
        (err: any) => err.message === WORKBENCH_ERRORS.DATA_TYPE_UNSUPPORTED,
        `${op} should reject non-finite value ${String(bad)}`
      );
    }

    assert.throws(
      () => engine.correlation(rows, "n", "n"),
      (err: any) => err.message === WORKBENCH_ERRORS.DATA_TYPE_UNSUPPORTED,
      `correlation should reject non-finite value ${String(bad)}`
    );
  }

  // groupBy numeric aggregation inherits the same rejection via sum/mean/min/max.
  const groupRows = [
    { g: "a", n: 1 },
    { g: "a", n: Infinity }
  ];
  assert.throws(
    () => engine.groupBy(groupRows, "g", "n", "SUM"),
    (err: any) => err.message === WORKBENCH_ERRORS.DATA_TYPE_UNSUPPORTED
  );

  // describe() is a lenient summarizer: non-finite values must never leak
  // into numeric statistics, but describe() itself should not throw.
  const describeRows = [{ n: "1" }, { n: "2" }, { n: "3" }, { n: "Infinity" }];
  const described = engine.describe(describeRows);
  if (described.numericColumns.n) {
    assert.ok(Number.isFinite(described.numericColumns.n.max));
    assert.notEqual(described.numericColumns.n.max, Infinity);
  }

  // outliers() silently excludes junk rather than throwing; must never
  // report a non-finite bound.
  const outlierRows = [{ n: 1 }, { n: 2 }, { n: 3 }, { n: 4 }, { n: "Infinity" }];
  const outlierRes = engine.outliers(outlierRows, "n");
  assert.ok(Number.isFinite(outlierRes.q1));
  assert.ok(Number.isFinite(outlierRes.q3));
  assert.ok(Number.isFinite(outlierRes.lowerBound));
  assert.ok(Number.isFinite(outlierRes.upperBound));

  // Ordinary numeric ranking must be unaffected by the finite check.
  const allNumericRows = [{ n: "5" }, { n: "30" }, { n: "2" }];
  const topAllNumeric = engine.topN(allNumericRows, "n", 3);
  assert.deepEqual(
    topAllNumeric.rows.map((r) => r.n),
    ["30", "5", "2"]
  );
  const bottomAllNumeric = engine.bottomN(allNumericRows, "n", 3);
  assert.deepEqual(
    bottomAllNumeric.rows.map((r) => r.n),
    ["2", "5", "30"]
  );

  // Before the fix, "Infinity" parsed as a numeric value and the pairwise
  // comparison `numA - numB` would treat it as always greater than any
  // real number (e.g. Infinity > 30). It must not crash or numerically
  // outrank real values now that it falls back to string comparison.
  const mixedRows = [...allNumericRows, { n: "Infinity" }];
  assert.doesNotThrow(() => engine.topN(mixedRows, "n", 4));
  assert.doesNotThrow(() => engine.bottomN(mixedRows, "n", 4));
});

test("NON-FINITE NUMBER REJECTION: SpreadsheetEngine aggregate and type inference never produce NaN/Infinity", async () => {
  const { workspaceStore, workspace } = setupTestEnvironment();
  const engine = new SpreadsheetEngine(workspaceStore);

  for (const bad of ["Infinity", "-Infinity", "NaN"]) {
    assert.throws(
      () => engine.aggregate([{ n: 1 }, { n: 2 }, { n: bad }], { function: "SUM", valueColumn: "n" }),
      (err: any) => err.message === WORKBENCH_ERRORS.DATA_TYPE_UNSUPPORTED,
      `SUM should reject ${bad}`
    );
    assert.throws(
      () => engine.aggregate([{ n: 1 }, { n: 2 }, { n: bad }], { function: "MEAN", valueColumn: "n" }),
      (err: any) => err.message === WORKBENCH_ERRORS.DATA_TYPE_UNSUPPORTED,
      `MEAN should reject ${bad}`
    );
    assert.throws(
      () => engine.aggregate([{ n: 1 }, { n: 2 }, { n: bad }], { function: "MIN", valueColumn: "n" }),
      (err: any) => err.message === WORKBENCH_ERRORS.DATA_TYPE_UNSUPPORTED,
      `MIN should reject ${bad}`
    );
    assert.throws(
      () => engine.aggregate([{ n: 1 }, { n: 2 }, { n: bad }], { function: "MAX", valueColumn: "n" }),
      (err: any) => err.message === WORKBENCH_ERRORS.DATA_TYPE_UNSUPPORTED,
      `MAX should reject ${bad}`
    );
  }

  workspaceStore.writeFile(workspace.id, "nonfinite.csv", "id,val\n1,1\n2,Infinity\n3,3");
  const inspected = await engine.inspect(workspace.id, "nonfinite.csv");
  assert.notEqual(inspected.inferredTypes.val, "INTEGER");
  assert.notEqual(inspected.inferredTypes.val, "FLOAT");

  cleanupTestEnvironment();
});

test("DATABASE SECURITY KEYWORDS & ITERATOR BOUNDS: Explicit SQL mutation keyword rejections & exactly 1000 rows", () => {
  const { workspaceStore, workspace } = setupTestEnvironment();
  const dbEngine = new DatabaseQueryEngine(workspaceStore);

  const { absolutePath } = resolveWorkspacePath(workspaceStore, workspace.id, "sec.sqlite", { allowMissing: true });
  const setupDb = new Database(absolutePath);
  setupDb.exec("CREATE TABLE items (id INTEGER PRIMARY KEY, val INTEGER)");

  const stmt = setupDb.prepare("INSERT INTO items VALUES (?, ?)");
  for (let i = 1; i <= 1200; i++) {
    stmt.run(i, i * 10);
  }
  setupDb.close();

  const sel = dbEngine.select(workspace.id, "sec.sqlite", "SELECT * FROM items ORDER BY id");
  assert.equal(sel.rowCount, 1000);
  assert.equal(sel.truncated, true);

  const forbiddenQueries = [
    "INSERT INTO items VALUES (1201, 0)",
    "UPDATE items SET val = 0",
    "DELETE FROM items",
    "DROP TABLE items",
    "CREATE TABLE new_tbl (id INT)",
    "ALTER TABLE items ADD COLUMN x TEXT",
    "ATTACH DATABASE 'other.sqlite' AS other",
    "DETACH DATABASE other",
    "VACUUM",
    "SELECT * FROM items; DROP TABLE items;"
  ];

  for (const q of forbiddenQueries) {
    assert.throws(
      () => dbEngine.select(workspace.id, "sec.sqlite", q),
      (err: any) => err.message === WORKBENCH_ERRORS.DATABASE_QUERY_NOT_READ_ONLY,
      `Query should have been rejected: ${q}`
    );
  }

  const check = dbEngine.select(workspace.id, "sec.sqlite", "SELECT COUNT(*) as cnt FROM items");
  assert.equal(check.rows[0].cnt, 1200);

  cleanupTestEnvironment();
});

test("REPORT ROLLBACK PRESERVATION: Pre-existing targetPath remains strictly intact on ArtifactStore failure", () => {
  const { workspaceStore, workspace } = setupTestEnvironment();

  workspaceStore.writeFile(workspace.id, "pre_existing.md", "ORIGINAL UNTOUCHED CONTENT");

  const failingArtifactStore = {
    createBatch: () => {
      throw new Error("Simulated Artifact DB Failure");
    }
  } as any;

  const reportEngine = new ReportEngine(workspaceStore, failingArtifactStore);

  assert.throws(
    () =>
      reportEngine.generateReport(
        workspace.id,
        { title: "Failing Report", summary: "Summary", sections: [], tables: [], findings: [], sources: [] },
        "markdown",
        { targetPath: "pre_existing.md" }
      ),
    (err: any) => err.message === WORKBENCH_ERRORS.REPORT_GENERATION_FAILED
  );

  const content = workspaceStore.readFile(workspace.id, "pre_existing.md").toString("utf-8");
  assert.equal(content, "ORIGINAL UNTOUCHED CONTENT");

  cleanupTestEnvironment();
});

test("XLSX MAXCELLS BOUND: 100 columns x 3000 rows real XLSX capped at 250,000 cells", async () => {
  const { workspaceStore, workspace } = setupTestEnvironment();
  const engine = new SpreadsheetEngine(workspaceStore);

  const wb = new ExcelJS.Workbook();
  const ws = wb.addWorksheet("Sheet1");
  const headers = Array.from({ length: 100 }, (_, i) => `c_${i + 1}`);
  ws.addRow(headers);
  for (let i = 0; i < 3000; i++) {
    ws.addRow(headers.map(() => 1));
  }
  const buf = Buffer.from(await wb.xlsx.writeBuffer());
  workspaceStore.writeFile(workspace.id, "big_xlsx_cells.xlsx", buf);

  const range = await engine.readRange(workspace.id, "big_xlsx_cells.xlsx");
  assert.equal(range.columns.length, 100);
  assert.equal(range.rows.length, 2500); // 100 * 2500 = 250,000 cells max
  assert.equal(range.truncated, true);
  // The sheet has 3000 rows but the cell cap stops the stream at row 2500;
  // the real total beyond that point was never counted.
  assert.equal(range.totalRowsKnown, false);

  cleanupTestEnvironment();
});

test("XLSX MAXROWS BOUND: >10,000 rows early-stopped at the row cap with an honest totalRowsKnown=false", async () => {
  const { workspaceStore, workspace } = setupTestEnvironment();
  const engine = new SpreadsheetEngine(workspaceStore);

  const wb = new ExcelJS.Workbook();
  const ws = wb.addWorksheet("Sheet1");
  ws.addRow(["id"]);
  for (let i = 1; i <= 10005; i++) {
    ws.addRow([i]);
  }
  const buf = Buffer.from(await wb.xlsx.writeBuffer());
  workspaceStore.writeFile(workspace.id, "big_xlsx_rows.xlsx", buf);

  const range = await engine.readRange(workspace.id, "big_xlsx_rows.xlsx");
  assert.equal(range.rows.length, 10000);
  assert.equal(range.truncated, true);
  assert.equal(range.totalRowsKnown, false);

  cleanupTestEnvironment();
});

test("XLSX EARLY STOP: a small requested range never iterates a large sheet to its last row", async () => {
  const { workspaceStore, workspace } = setupTestEnvironment();
  const engine = new SpreadsheetEngine(workspaceStore);

  const TOTAL_ROWS = 5000;
  const wb = new ExcelJS.Workbook();
  const ws = wb.addWorksheet("Sheet1");
  ws.addRow(["id"]);
  for (let i = 1; i <= TOTAL_ROWS; i++) {
    ws.addRow([i]);
  }
  const buf = Buffer.from(await wb.xlsx.writeBuffer());
  workspaceStore.writeFile(workspace.id, "early_stop.xlsx", buf);

  // Instrument the real ExcelJS streaming reader to count how many row
  // events actually flow through the async-iterator protocol our engine
  // consumes, proving the stream is abandoned instead of drained.
  // ExcelJS.stream.xlsx does not publicly export WorksheetReader (only
  // WorkbookReader/WorkbookWriter), so reach into the concrete module that
  // WorkbookReader itself constructs instances from.
  const require = createRequire(import.meta.url);
  const WorksheetReaderClass = require("exceljs/lib/stream/xlsx/worksheet-reader.js");
  const proto = WorksheetReaderClass.prototype;
  const originalAsyncIterator = proto[Symbol.asyncIterator];
  let rowsProducedByStream = 0;
  proto[Symbol.asyncIterator] = function (this: any) {
    const gen = originalAsyncIterator.call(this);
    return {
      async next(...args: any[]) {
        const res = await gen.next(...args);
        if (!res.done) rowsProducedByStream++;
        return res;
      },
      async return(value?: any) {
        return typeof gen.return === "function" ? gen.return(value) : { done: true, value };
      },
      [Symbol.asyncIterator]() {
        return this;
      }
    };
  };

  let startRowRange: Awaited<ReturnType<typeof engine.readRange>>;
  let endRowRange: Awaited<ReturnType<typeof engine.readRange>>;
  try {
    startRowRange = await engine.readRange(workspace.id, "early_stop.xlsx", { startRow: 0, endRow: 10 });
    assert.ok(
      rowsProducedByStream < 50,
      `expected far fewer than ${TOTAL_ROWS} rows to be pulled from the stream, got ${rowsProducedByStream}`
    );

    // A non-zero startRow still requires scanning past the skipped rows
    // (XLSX row-major XML has no random access), but the engine must still
    // stop shortly after endRow rather than draining the rest of the sheet.
    rowsProducedByStream = 0;
    endRowRange = await engine.readRange(workspace.id, "early_stop.xlsx", { startRow: 20, endRow: 30 });
    assert.ok(
      rowsProducedByStream < 50,
      `expected the stream to stop shortly after endRow, not drain toward row ${TOTAL_ROWS}, got ${rowsProducedByStream}`
    );
  } finally {
    proto[Symbol.asyncIterator] = originalAsyncIterator;
  }

  assert.equal(startRowRange.rows.length, 10);
  assert.equal(startRowRange.rows[0].id, 1);
  // An explicit small endRow is the user's own choice, not a safety-limit
  // truncation, but we still don't know the real total since we stopped.
  assert.equal(startRowRange.truncated, false);
  assert.equal(startRowRange.totalRowsKnown, false);

  assert.equal(endRowRange.rows.length, 10);
  assert.equal(endRowRange.rows[0].id, 21);

  cleanupTestEnvironment();
});

test("XLSX MAXCOLUMNS BOUND: >200 columns capped at 200 with truncated=true", async () => {
  const { workspaceStore, workspace } = setupTestEnvironment();
  const engine = new SpreadsheetEngine(workspaceStore);

  const wb = new ExcelJS.Workbook();
  const ws = wb.addWorksheet("Sheet1");
  const headers = Array.from({ length: 250 }, (_, i) => `col_${i + 1}`);
  ws.addRow(headers);
  ws.addRow(headers.map((_, i) => `val_${i + 1}`));
  const buf = Buffer.from(await wb.xlsx.writeBuffer());
  workspaceStore.writeFile(workspace.id, "wide_xlsx.xlsx", buf);

  const range = await engine.readRange(workspace.id, "wide_xlsx.xlsx");
  assert.equal(range.columns.length, 200);
  assert.equal(range.truncated, true);

  cleanupTestEnvironment();
});

test("INSPECT COLUMNS BOUNDED (CSV): >200 columns capped, sample-row cap still uses the capped column count", async () => {
  const { workspaceStore, workspace } = setupTestEnvironment();
  const engine = new SpreadsheetEngine(workspaceStore);

  const COLS = 600;
  const ROWS = 700;
  const headers = Array.from({ length: COLS }, (_, i) => `c_${i + 1}`);
  const dataLine = headers.map(() => "1").join(",");
  const lines = [headers.join(",")];
  for (let i = 0; i < ROWS; i++) lines.push(dataLine);
  workspaceStore.writeFile(workspace.id, "wide_inspect.csv", lines.join("\n"));

  const result = await engine.inspect(workspace.id, "wide_inspect.csv");

  assert.equal(result.columnCount, COLS); // real detected total
  assert.equal(result.columns.length, SPREADSHEET_LIMITS.maxColumnsPerRead); // bounded to 200
  assert.equal(result.rowCount, ROWS);
  assert.ok(Object.keys(result.inferredTypes).length <= SPREADSHEET_LIMITS.maxColumnsPerRead);
  assert.ok(result.sampleRows.every((r) => Object.keys(r).length <= SPREADSHEET_LIMITS.maxColumnsPerRead));
  assert.ok(result.warnings.some((w) => w.includes("columns")));
  assert.ok(result.warnings.some((w) => w.toLowerCase().includes("sample") || w.includes("500")));

  cleanupTestEnvironment();
});

test("INSPECT COLUMNS BOUNDED (XLSX): >200 columns capped for inspection sampling", async () => {
  const { workspaceStore, workspace } = setupTestEnvironment();
  const engine = new SpreadsheetEngine(workspaceStore);

  const COLS = 300;
  const ROWS = 600;
  const wb = new ExcelJS.Workbook();
  const ws = wb.addWorksheet("Sheet1");
  const headers = Array.from({ length: COLS }, (_, i) => `c_${i + 1}`);
  ws.addRow(headers);
  for (let i = 0; i < ROWS; i++) {
    ws.addRow(headers.map(() => 1));
  }
  const buf = Buffer.from(await wb.xlsx.writeBuffer());
  workspaceStore.writeFile(workspace.id, "wide_inspect.xlsx", buf);

  const result = await engine.inspect(workspace.id, "wide_inspect.xlsx");

  assert.equal(result.columnCount, COLS);
  assert.equal(result.columns.length, SPREADSHEET_LIMITS.maxColumnsPerRead);
  assert.equal(result.rowCount, ROWS);
  assert.ok(Object.keys(result.inferredTypes).length <= SPREADSHEET_LIMITS.maxColumnsPerRead);
  assert.ok(result.warnings.some((w) => w.includes("columns")));

  cleanupTestEnvironment();
});

test("INSPECT CELLS BOUNDED: sample-row count never lets sampled columns x rows exceed maxCellsPerRead", async () => {
  const { workspaceStore, workspace } = setupTestEnvironment();
  const engine = new SpreadsheetEngine(workspaceStore);

  // 200 columns (at the column cap) x 501 rows: naive floor(250000/200)=1250
  // would wrongly allow all rows; the 500-row inspection cap must still win.
  const COLS = 200;
  const ROWS = 501;
  const headers = Array.from({ length: COLS }, (_, i) => `c_${i + 1}`);
  const dataLine = headers.map(() => "1").join(",");
  const lines = [headers.join(",")];
  for (let i = 0; i < ROWS; i++) lines.push(dataLine);
  workspaceStore.writeFile(workspace.id, "cells_inspect.csv", lines.join("\n"));

  const result = await engine.inspect(workspace.id, "cells_inspect.csv");

  assert.equal(result.columns.length, COLS);
  assert.equal(result.rowCount, ROWS);
  assert.ok(result.sampleRows.length <= 5);
  assert.ok(result.warnings.some((w) => w.toLowerCase().includes("sample") || w.includes("500")));

  cleanupTestEnvironment();
});

test("XLSX FORMULA CELLS: cached result exposed, never executed/evaluated by Jarvis", async () => {
  const { workspaceStore, workspace } = setupTestEnvironment();
  const engine = new SpreadsheetEngine(workspaceStore);

  const wb = new ExcelJS.Workbook();
  const ws = wb.addWorksheet("Sheet1");
  ws.addRow(["a", "b", "sum"]);
  ws.getRow(2).getCell(1).value = 2;
  ws.getRow(2).getCell(2).value = 3;
  ws.getRow(2).getCell(3).value = { formula: "A2+B2", result: 5 } as any;
  const buf = Buffer.from(await wb.xlsx.writeBuffer());
  workspaceStore.writeFile(workspace.id, "formula.xlsx", buf);

  const range = await engine.readRange(workspace.id, "formula.xlsx");
  assert.equal(range.rows.length, 1);
  assert.equal(range.rows[0].sum, 5);

  cleanupTestEnvironment();
});

test("CSV MULTILINE QUOTED FIELDS: embedded newlines, commas, and escaped quotes parsed correctly", async () => {
  const { workspaceStore, workspace } = setupTestEnvironment();
  const engine = new SpreadsheetEngine(workspaceStore);

  const fixture = [
    "id,description",
    '1,"bonjour',
    'le monde"',
    '2,"a,b"',
    '3,"quote ""test"""'
  ].join("\n");
  workspaceStore.writeFile(workspace.id, "multiline.csv", fixture);

  const range = await engine.readRange(workspace.id, "multiline.csv");
  assert.equal(range.rows.length, 3);
  assert.equal(range.rows[0].description, "bonjour\nle monde");
  assert.equal(range.rows[1].description, "a,b");
  assert.equal(range.rows[2].description, 'quote "test"');

  cleanupTestEnvironment();
});

test("XLS FORMAT REJECTED: legacy binary .xls is never claimed as supported", async () => {
  const { workspaceStore, workspace } = setupTestEnvironment();
  const engine = new SpreadsheetEngine(workspaceStore);

  workspaceStore.writeFile(workspace.id, "legacy.xls", Buffer.from("not a real xls file"));

  await assert.rejects(
    () => engine.inspect(workspace.id, "legacy.xls"),
    (err: any) => err.message === WORKBENCH_ERRORS.SPREADSHEET_FORMAT_UNSUPPORTED
  );

  cleanupTestEnvironment();
});

test("LISTSHEETS INPUT LIMIT: oversized files rejected before any parsing, for every format", async () => {
  // The default WorkspaceStore file-size cap (10 MB) is smaller than the
  // spreadsheet input limit (25 MB), so this test needs its own store with
  // a higher cap to actually exercise SPREADSHEET_LIMIT_EXCEEDED rather
  // than the workspace's own WORKSPACE_FILE_TOO_LARGE check.
  if (existsSync(TEST_WORKSPACES_ROOT)) {
    rmSync(TEST_WORKSPACES_ROOT, { recursive: true, force: true });
  }
  mkdirSync(TEST_WORKSPACES_ROOT, { recursive: true });
  const workspaceStore = new WorkspaceStore(
    TEST_WORKSPACES_ROOT,
    SPREADSHEET_LIMITS.maxInputBytes + 1024,
    SPREADSHEET_LIMITS.maxInputBytes + 1024
  );
  const workspace = workspaceStore.create({
    name: "Oversized Workspace",
    ownerType: "ADHOC",
    ownerId: `test-owner-${randomUUID()}`
  });
  const engine = new SpreadsheetEngine(workspaceStore);

  // A valid XLSX/CSV/TSV body is not required: the size check must happen
  // before any parsing (or the CSV/TSV short-circuit) is attempted, so an
  // oversized garbage buffer is sufficient for every format. Files are
  // written and removed one at a time: the workspace's own total-bytes
  // budget only has room for one oversized file at once.
  const oversized = Buffer.alloc(SPREADSHEET_LIMITS.maxInputBytes + 1, 1);

  for (const ext of ["xlsx", "csv", "tsv"]) {
    const relPath = `oversized.${ext}`;
    workspaceStore.writeFile(workspace.id, relPath, oversized);
    await assert.rejects(
      () => engine.listSheets(workspace.id, relPath),
      (err: any) => err.message === WORKBENCH_ERRORS.SPREADSHEET_LIMIT_EXCEEDED,
      `listSheets should reject an oversized .${ext} file`
    );
    rmSync(resolve(TEST_WORKSPACES_ROOT, workspace.id, relPath), { force: true });
  }

  cleanupTestEnvironment();
});

test("SPREADSHEET COLUMN VALIDATION: unknown requested column raises a stable error", async () => {
  const { workspaceStore, workspace } = setupTestEnvironment();
  const engine = new SpreadsheetEngine(workspaceStore);

  workspaceStore.writeFile(workspace.id, "cols.csv", "id,name\n1,Alice\n2,Bob");

  await assert.rejects(
    () => engine.readRange(workspace.id, "cols.csv", { columns: ["id", "does_not_exist"] }),
    (err: any) => err.message === WORKBENCH_ERRORS.SPREADSHEET_RANGE_INVALID
  );

  cleanupTestEnvironment();
});

test("SPREADSHEET RANGE VALIDATION: startRow/endRow reject NaN, Infinity, non-integers, and negatives", async () => {
  const { workspaceStore, workspace } = setupTestEnvironment();
  const engine = new SpreadsheetEngine(workspaceStore);

  workspaceStore.writeFile(workspace.id, "range.csv", "id,name\n1,Alice\n2,Bob\n3,Carol");

  const invalidStartRows = [NaN, Infinity, -Infinity, 1.5, -1];
  for (const bad of invalidStartRows) {
    await assert.rejects(
      () => engine.readRange(workspace.id, "range.csv", { startRow: bad }),
      (err: any) => err.message === WORKBENCH_ERRORS.SPREADSHEET_RANGE_INVALID,
      `startRow=${bad} should be rejected`
    );
  }

  const invalidEndRows = [NaN, Infinity, -Infinity, 1.5, -1];
  for (const bad of invalidEndRows) {
    await assert.rejects(
      () => engine.readRange(workspace.id, "range.csv", { startRow: 0, endRow: bad }),
      (err: any) => err.message === WORKBENCH_ERRORS.SPREADSHEET_RANGE_INVALID,
      `endRow=${bad} should be rejected`
    );
  }

  // endRow < startRow remains invalid.
  await assert.rejects(
    () => engine.readRange(workspace.id, "range.csv", { startRow: 2, endRow: 1 }),
    (err: any) => err.message === WORKBENCH_ERRORS.SPREADSHEET_RANGE_INVALID
  );

  // Valid bounds still work normally.
  const valid = await engine.readRange(workspace.id, "range.csv", { startRow: 1, endRow: 3 });
  assert.equal(valid.rows.length, 2);
  assert.equal(valid.rows[0].id, "2");

  cleanupTestEnvironment();
});

test("SYMLINK TEST: Non-swallowed symlink exception assertion", () => {
  const { workspaceStore, workspace } = setupTestEnvironment();

  let symlinkCreated = false;
  const linkPath = resolve(TEST_WORKSPACES_ROOT, workspace.id, "symlink_out.txt");
  try {
    symlinkSync("/etc/passwd", linkPath);
    symlinkCreated = true;
  } catch {
    // OS bypass
  }

  if (symlinkCreated) {
    assert.throws(
      () => resolveWorkspacePath(workspaceStore, workspace.id, "symlink_out.txt"),
      (err: any) => err.message === WORKBENCH_ERRORS.WORKBENCH_PATH_OUTSIDE_WORKSPACE
    );
  }

  cleanupTestEnvironment();
});
