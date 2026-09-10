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

test("WORKBENCH SANDBOX & SECURITY: Traversal, absolute paths & symlinks non-swallowed assertion", () => {
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

  let symlinkCreated = false;
  const linkPath = resolve(TEST_WORKSPACES_ROOT, workspace.id, "symlink_out.txt");
  try {
    symlinkSync("/etc/passwd", linkPath);
    symlinkCreated = true;
  } catch {
    // OS permission bypass
  }

  if (symlinkCreated) {
    assert.throws(
      () => resolveWorkspacePath(workspaceStore, workspace.id, "symlink_out.txt"),
      (err: any) => err.message === WORKBENCH_ERRORS.WORKBENCH_PATH_OUTSIDE_WORKSPACE
    );
  }

  cleanupTestEnvironment();
});

test("SPREADSHEET readRange: startRow > 0 header preservation & data-only totalRows", () => {
  const { workspaceStore, workspace } = setupTestEnvironment();
  const engine = new SpreadsheetEngine(workspaceStore);

  const csvContent = `id,name\n1,A\n2,B\n3,C\n4,D`;
  workspaceStore.writeFile(workspace.id, "data.csv", csvContent);

  // readRange startRow=0 endRow=1 => [{id:1, name:"A"}]
  const r0 = engine.readRange(workspace.id, "data.csv", { startRow: 0, endRow: 1 });
  assert.equal(r0.totalRows, 4);
  assert.deepEqual(r0.rows, [{ id: 1, name: "A" }]);

  // readRange startRow=1 endRow=3 => [{id:2, name:"B"}, {id:3, name:"C"}]
  const r1 = engine.readRange(workspace.id, "data.csv", { startRow: 1, endRow: 3 });
  assert.equal(r1.totalRows, 4);
  assert.deepEqual(r1.rows, [
    { id: 2, name: "B" },
    { id: 3, name: "C" }
  ]);

  cleanupTestEnvironment();
});

test("DATA ANALYSIS ENGINE VALIDATIONS: timeSeriesSummary, groupBy & topN checks", () => {
  const engine = new DataAnalysisEngine();

  const dataset: Record<string, unknown>[] = [
    { date: "2026-01-01", val: 10, cat: "A", textCol: "abc" },
    { date: "2026-01-02", val: 20, cat: "A", textCol: "def" }
  ];

  // Missing valueColumn in timeSeriesSummary throws DATA_COLUMN_NOT_FOUND
  assert.throws(
    () => engine.timeSeriesSummary(dataset, "date", "DAY", "nonexistent"),
    (err: any) => err.message === WORKBENCH_ERRORS.DATA_COLUMN_NOT_FOUND
  );

  // Text valueColumn in timeSeriesSummary throws DATA_TYPE_UNSUPPORTED
  assert.throws(
    () => engine.timeSeriesSummary(dataset, "date", "DAY", "textCol"),
    (err: any) => err.message === WORKBENCH_ERRORS.DATA_TYPE_UNSUPPORTED
  );

  // groupBy SUM without valueColumn throws DATA_COLUMN_NOT_FOUND
  assert.throws(
    () => engine.groupBy(dataset, "cat", undefined, "SUM"),
    (err: any) => err.message === WORKBENCH_ERRORS.DATA_COLUMN_NOT_FOUND
  );

  // topN with invalid n parameter throws DATA_TYPE_UNSUPPORTED
  assert.throws(
    () => engine.topN(dataset, "val", -5),
    (err: any) => err.message === WORKBENCH_ERRORS.DATA_TYPE_UNSUPPORTED
  );

  cleanupTestEnvironment();
});

test("DOCUMENT ENGINE & REPORT ATOMIC ARTIFACT CREATION", async () => {
  const { workspaceStore, artifactStore, workspace } = setupTestEnvironment();
  const docEngine = new DocumentEngine(workspaceStore);
  const reportEngine = new ReportEngine(workspaceStore, artifactStore);

  // PDF Text
  workspaceStore.writeFile(workspace.id, "sample.pdf", createMinimalTextPdfBuffer());
  const pdfRes = await docEngine.readDocument(workspace.id, "sample.pdf");
  assert.equal(pdfRes.format, "pdf");

  // Atomic report generation with targetPath
  const reportRes = reportEngine.generateReport(
    workspace.id,
    { title: "Atomic Report", summary: "Summary", sections: [], tables: [], findings: [], sources: [] },
    "markdown",
    { targetPath: "atomic/report.md" }
  );

  assert.equal(reportRes.relativePath, "atomic/report.md");
  assert.ok(workspaceStore.exists(workspace.id, "atomic/report.md"));

  cleanupTestEnvironment();
});
