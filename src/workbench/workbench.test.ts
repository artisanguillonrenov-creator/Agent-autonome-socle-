import test from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, writeFileSync, rmSync, existsSync, symlinkSync } from "node:fs";
import { resolve } from "node:path";
import { randomUUID } from "node:crypto";
import Database from "better-sqlite3";
import ExcelJS from "exceljs";
import { WorkspaceStore } from "../workspaces/workspaceStore.js";
import { ArtifactStore } from "../workspaces/artifactStore.js";
import { DocumentEngine } from "./documentEngine.js";
import { SpreadsheetEngine } from "./spreadsheetEngine.js";
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
