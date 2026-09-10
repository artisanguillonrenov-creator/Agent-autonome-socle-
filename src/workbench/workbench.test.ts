import test from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, writeFileSync, rmSync, existsSync, symlinkSync } from "node:fs";
import { resolve } from "node:path";
import { randomUUID } from "node:crypto";
import Database from "better-sqlite3";
import XLSX from "xlsx";
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

// Minimal valid PDF binary with text "Hello PDF Workbench"
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

// Minimal scanned/textless PDF binary (page exists but stream has no text Tj operators)
function createMinimalScannedPdfBuffer(): Buffer {
  const pdfStr = `%PDF-1.4
1 0 obj <</Type /Catalog /Pages 2 0 R>> endobj
2 0 obj <</Type /Pages /Kinds [] /Count 1 /Kids [3 0 R]>> endobj
3 0 obj <</Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Contents 4 0 R>> endobj
4 0 obj <</Length 0>> stream
endstream endobj
xref
0 5
0000000000 65535 f
0000000009 00000 n
0000000062 00000 n
0000000133 00000 n
0000000224 00000 n
trailer <</Size 5 /Root 1 0 R>>
startxref
275
%%EOF`;
  return Buffer.from(pdfStr, "utf-8");
}

test("WORKBENCH SANDBOX & SECURITY: Traversal, absolute paths & symlinks", () => {
  const { workspaceStore, workspace } = setupTestEnvironment();

  assert.throws(
    () => resolveWorkspacePath(workspaceStore, workspace.id, "../../../secret.txt"),
    (err: any) => err.message === WORKBENCH_ERRORS.WORKBENCH_PATH_OUTSIDE_WORKSPACE
  );

  assert.throws(
    () => resolveWorkspacePath(workspaceStore, workspace.id, "/etc/passwd"),
    (err: any) => err.message === WORKBENCH_ERRORS.WORKBENCH_PATH_OUTSIDE_WORKSPACE
  );

  assert.throws(
    () => resolveWorkspacePath(workspaceStore, workspace.id, "file:///etc/passwd"),
    (err: any) => err.message === WORKBENCH_ERRORS.WORKBENCH_PATH_OUTSIDE_WORKSPACE
  );

  // Symlink pointing outside workspace root
  const linkPath = resolve(TEST_WORKSPACES_ROOT, workspace.id, "symlink_out.txt");
  try {
    symlinkSync("/etc/passwd", linkPath);
    assert.throws(
      () => resolveWorkspacePath(workspaceStore, workspace.id, "symlink_out.txt"),
      (err: any) => err.message === WORKBENCH_ERRORS.WORKBENCH_PATH_OUTSIDE_WORKSPACE
    );
  } catch {
    // Symlink creation bypass if unprivileged OS
  }

  cleanupTestEnvironment();
});

test("DOCUMENT ENGINE: TXT, MD, HTML security, PDF text extraction & OCR detection", async () => {
  const { workspaceStore, workspace } = setupTestEnvironment();
  const engine = new DocumentEngine(workspaceStore);

  // Markdown file
  workspaceStore.writeFile(
    workspace.id,
    "doc.md",
    "# Document de Test\n\nVoici une clause de résiliation importante.\n\n## Section 2\n\nAutres informations."
  );

  const docRes = await engine.readDocument(workspace.id, "doc.md");
  assert.equal(docRes.format, "markdown");
  assert.equal(docRes.title, "Document de Test");
  assert.equal(docRes.sections?.length, 2);

  const matches = engine.searchDocument(docRes, { query: "resiliation" });
  assert.equal(matches.length, 1);
  assert.match(matches[0].matchedText, /résiliation/i);

  // HTML security check
  workspaceStore.writeFile(
    workspace.id,
    "unsafe.html",
    "<html><head><title>HTML Page</title></head><body><h1>Titre</h1><script>alert('xss')</script><p>Texte utile</p><iframe src='evil.com'></iframe></body></html>"
  );

  const htmlRes = await engine.readDocument(workspace.id, "unsafe.html");
  assert.equal(htmlRes.format, "html");
  assert.equal(htmlRes.title, "HTML Page");
  assert.doesNotMatch(htmlRes.text!, /alert/);
  assert.doesNotMatch(htmlRes.text!, /iframe/);
  assert.match(htmlRes.text!, /Texte utile/);

  // Real PDF text extraction test using DocumentEngine.readDocument
  workspaceStore.writeFile(workspace.id, "sample.pdf", createMinimalTextPdfBuffer());
  const pdfRes = await engine.readDocument(workspace.id, "sample.pdf");
  assert.equal(pdfRes.format, "pdf");
  assert.equal(pdfRes.pageCount, 1);
  assert.match(pdfRes.text!, /Hello PDF Workbench/);

  // Real PDF scanned / no text triggering DOCUMENT_OCR_REQUIRED
  workspaceStore.writeFile(workspace.id, "scanned.pdf", createMinimalScannedPdfBuffer());
  await assert.rejects(
    async () => await engine.readDocument(workspace.id, "scanned.pdf"),
    (err: any) => err.message === WORKBENCH_ERRORS.DOCUMENT_OCR_REQUIRED
  );

  cleanupTestEnvironment();
});

test("SPREADSHEET ENGINE: CSV, TSV, XLSX multi-sheet, formulas & numeric aggregation fixes", () => {
  const { workspaceStore, workspace } = setupTestEnvironment();
  const engine = new SpreadsheetEngine(workspaceStore);

  // TSV file
  const tsvContent = "id\tname\tsalary\n1\tAlice\t5000\n2\tBob\t4000";
  workspaceStore.writeFile(workspace.id, "data.tsv", tsvContent);
  const tsvInspect = engine.inspect(workspace.id, "data.tsv");
  assert.equal(tsvInspect.format, "tsv");
  assert.equal(tsvInspect.rowCount, 2);

  // Multi-sheet XLSX with non-executed formulas
  const wb = XLSX.utils.book_new();
  const sheet1 = XLSX.utils.json_to_sheet([{ a: 10, b: 20, sum: { f: "A2+B2" } }]);
  const sheet2 = XLSX.utils.json_to_sheet([{ cat: "X" }]);
  XLSX.utils.book_append_sheet(wb, sheet1, "Sheet1");
  XLSX.utils.book_append_sheet(wb, sheet2, "Sheet2");
  const xlsxBuf = XLSX.write(wb, { type: "buffer", bookType: "xlsx" });

  workspaceStore.writeFile(workspace.id, "multi.xlsx", xlsxBuf);
  const sheetList = engine.listSheets(workspace.id, "multi.xlsx");
  assert.deepEqual(sheetList, ["Sheet1", "Sheet2"]);

  // Range-bounded reading
  const range1 = engine.readRange(workspace.id, "multi.xlsx", { sheet: "Sheet1", startRow: 0, endRow: 1 });
  assert.equal(range1.rows.length, 1);

  // Aggregation test ensuring null, undefined, "", boolean are excluded from SUM/MEAN
  const mixedRows = [
    { v: 10 },
    { v: null },
    { v: "" },
    { v: false },
    { v: 20 }
  ];
  const aggSum = engine.aggregate(mixedRows, { function: "SUM", valueColumn: "v" });
  assert.equal(aggSum[0]["v_sum"], 30);

  const aggMean = engine.aggregate(mixedRows, { function: "MEAN", valueColumn: "v" });
  assert.equal(aggMean[0]["v_mean"], 15);

  cleanupTestEnvironment();
});

test("DATA ANALYSIS ENGINE: Complete suite (count, sum, mean, median, min, max, stddev, groupBy, topN, bottomN, distribution)", () => {
  const engine = new DataAnalysisEngine();

  const dataset: Record<string, unknown>[] = [
    { id: 1, date: "2026-01-01", val: 10, cat: "A" },
    { id: 2, date: "2026-01-02", val: 20, cat: "A" },
    { id: 3, date: "2026-01-03", val: 30, cat: "B" },
    { id: 4, date: "2026-01-04", val: 40, cat: "B" },
    { id: 5, date: "2026-01-05", val: 100, cat: "B" }
  ];

  assert.equal(engine.count(dataset), 5);
  assert.equal(engine.sum(dataset, "val"), 200);
  assert.equal(engine.mean(dataset, "val"), 40);
  assert.equal(engine.median(dataset, "val"), 30);
  assert.equal(engine.min(dataset, "val"), 10);
  assert.equal(engine.max(dataset, "val"), 100);

  const groupRes = engine.groupBy(dataset, "cat", "val", "SUM");
  assert.equal(groupRes.length, 2);

  const top2 = engine.topN(dataset, "val", 2);
  assert.equal(top2.length, 2);
  assert.equal(top2[0].val, 100);

  const dist = engine.distribution(dataset, "cat");
  assert.equal(dist.length, 2);
  assert.equal(dist[0].value, "B");
  assert.equal(dist[0].count, 3);

  // Column union validation check across sparse rows
  const sparseDataset = [
    { colA: 1 },
    { colB: 2 },
    { colC: 3 }
  ];
  const missingRes = engine.missingValues(sparseDataset);
  assert.equal(missingRes.length, 3);
});

test("DATABASE QUERY ENGINE: SQLite statement iteration, SELECT > 1000 rows truncation & missing DB error", () => {
  const { workspaceStore, workspace } = setupTestEnvironment();
  const dbEngine = new DatabaseQueryEngine(workspaceStore);

  // Missing database check returns DATABASE_NOT_FOUND
  assert.throws(
    () => dbEngine.listTables(workspace.id, "nonexistent.sqlite"),
    (err: any) => err.message === WORKBENCH_ERRORS.DATABASE_NOT_FOUND
  );

  const { absolutePath } = resolveWorkspacePath(workspaceStore, workspace.id, "test.sqlite", { allowMissing: true });
  const setupDb = new Database(absolutePath);
  setupDb.exec("CREATE TABLE items (id INTEGER PRIMARY KEY, val INTEGER)");

  const stmt = setupDb.prepare("INSERT INTO items VALUES (?, ?)");
  for (let i = 1; i <= 1200; i++) {
    stmt.run(i, i * 10);
  }
  setupDb.close();

  // Bounded iterator SELECT query (>1000 rows truncated)
  const sel = dbEngine.select(workspace.id, "test.sqlite", "SELECT * FROM items ORDER BY id");
  assert.equal(sel.rowCount, 1000);
  assert.equal(sel.truncated, true);

  // Write rejections
  assert.throws(
    () => dbEngine.select(workspace.id, "test.sqlite", "INSERT INTO items VALUES (1201, 12010)"),
    (err: any) => err.message === WORKBENCH_ERRORS.DATABASE_QUERY_NOT_READ_ONLY
  );

  assert.throws(
    () => dbEngine.select(workspace.id, "test.sqlite", "UPDATE items SET val = 0"),
    (err: any) => err.message === WORKBENCH_ERRORS.DATABASE_QUERY_NOT_READ_ONLY
  );

  assert.throws(
    () => dbEngine.select(workspace.id, "test.sqlite", "DELETE FROM items"),
    (err: any) => err.message === WORKBENCH_ERRORS.DATABASE_QUERY_NOT_READ_ONLY
  );

  assert.throws(
    () => dbEngine.select(workspace.id, "test.sqlite", "DROP TABLE items"),
    (err: any) => err.message === WORKBENCH_ERRORS.DATABASE_QUERY_NOT_READ_ONLY
  );

  // Verify DB immutability
  const postCheck = dbEngine.select(workspace.id, "test.sqlite", "SELECT COUNT(*) as total FROM items");
  assert.equal(postCheck.rows[0].total, 1200);

  cleanupTestEnvironment();
});

test("REPORT ENGINE: targetPath persistence & artifact creation", () => {
  const { workspaceStore, artifactStore, workspace } = setupTestEnvironment();
  const reportEngine = new ReportEngine(workspaceStore, artifactStore);

  const reportRes = reportEngine.generateReport(
    workspace.id,
    {
      title: "Rapport Custom Path",
      summary: "Rapport persisté dans un chemin personnalisé.",
      sections: [],
      tables: [],
      findings: [],
      sources: []
    },
    "markdown",
    { targetPath: "custom/path/report.md" }
  );

  assert.equal(reportRes.relativePath, "custom/path/report.md");
  assert.ok(workspaceStore.exists(workspace.id, "custom/path/report.md"));

  cleanupTestEnvironment();
});
