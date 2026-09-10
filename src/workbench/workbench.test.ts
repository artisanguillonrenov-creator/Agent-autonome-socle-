import test from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, writeFileSync, rmSync, existsSync } from "node:fs";
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

test("WORKBENCH SANDBOX & SECURITY: Path resolution rejects traversal & out-of-workspace access", () => {
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

  cleanupTestEnvironment();
});

test("DOCUMENT ENGINE: TXT, Markdown, JSON, HTML & Accent-insensitive Search", async () => {
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

  // Accent-insensitive search
  const matches = engine.searchDocument(docRes, { query: "resiliation" });
  assert.equal(matches.length, 1);
  assert.match(matches[0].matchedText, /résiliation/i);

  // HTML security check (strip script / iframe)
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

  cleanupTestEnvironment();
});

test("SPREADSHEET ENGINE: CSV & XLSX inspection, filter, sort, aggregate, export", () => {
  const { workspaceStore, workspace } = setupTestEnvironment();
  const engine = new SpreadsheetEngine(workspaceStore);

  const csvContent = `id,name,department,salary\n1,Alice,Engineering,5000\n2,Bob,Marketing,4000\n3,Charlie,Engineering,6000\n4,David,Marketing,4500`;
  workspaceStore.writeFile(workspace.id, "data.csv", csvContent);

  // Inspect
  const inspectRes = engine.inspect(workspace.id, "data.csv");
  assert.equal(inspectRes.format, "csv");
  assert.equal(inspectRes.rowCount, 4);
  assert.equal(inspectRes.columnCount, 4);
  assert.equal(inspectRes.inferredTypes["salary"], "INTEGER");

  // Read range
  const rangeRes = engine.readRange(workspace.id, "data.csv");
  assert.equal(rangeRes.rows.length, 4);

  // Filter
  const filtered = engine.filter(rangeRes.rows, [
    { column: "department", operator: "equals", value: "Engineering" }
  ]);
  assert.equal(filtered.length, 2);

  // Sort
  const sorted = engine.sort(rangeRes.rows, [{ column: "salary", direction: "DESC" }]);
  assert.equal(sorted[0].name, "Charlie");

  // Aggregate with groupBy
  const agg = engine.aggregate(rangeRes.rows, {
    function: "SUM",
    valueColumn: "salary",
    groupBy: "department"
  });
  assert.equal(agg.length, 2);

  // Export XLSX
  const xlsxBuffer = engine.exportXlsx(rangeRes.rows);
  workspaceStore.writeFile(workspace.id, "exported.xlsx", xlsxBuffer);
  const reInspect = engine.inspect(workspace.id, "exported.xlsx");
  assert.equal(reInspect.format, "xlsx");
  assert.equal(reInspect.rowCount, 4);

  cleanupTestEnvironment();
});

test("DATA ANALYSIS ENGINE: Statistical describe, IQR outliers, Pearson correlation, time series", () => {
  const engine = new DataAnalysisEngine();

  const dataset: Record<string, unknown>[] = [
    { id: 1, date: "2026-01-01", val: 10, cat: "A" },
    { id: 2, date: "2026-01-02", val: 12, cat: "A" },
    { id: 3, date: "2026-01-03", val: 14, cat: "B" },
    { id: 4, date: "2026-01-04", val: 16, cat: "B" },
    { id: 5, date: "2026-01-05", val: 100, cat: "B" } // Outlier
  ];

  // Describe
  const desc = engine.describe(dataset);
  assert.ok(desc.numericColumns["val"]);
  assert.equal(desc.numericColumns["val"].count, 5);
  assert.equal(desc.numericColumns["val"].min, 10);
  assert.equal(desc.numericColumns["val"].max, 100);

  // Missing values distinction (0 and false are not missing)
  const missingDataset = [
    { a: 0, b: false, c: "", d: null, e: undefined }
  ];
  const missingRes = engine.missingValues(missingDataset);
  const mapRes = Object.fromEntries(missingRes.map((r) => [r.column, r.missingCount]));
  assert.equal(mapRes["a"], 0);
  assert.equal(mapRes["b"], 0);
  assert.equal(mapRes["c"], 0);
  assert.equal(mapRes["d"], 1);
  assert.equal(mapRes["e"], 1);

  // Outliers IQR
  const outlierRes = engine.outliers(dataset, "val");
  assert.equal(outlierRes.count, 1);
  assert.equal(outlierRes.sample[0], 100);

  // Pearson Correlation
  const corrData = [
    { x: 1, y: 2 },
    { x: 2, y: 4 },
    { x: 3, y: 6 },
    { x: 4, y: 8 }
  ];
  const corrRes = engine.correlation(corrData, "x", "y");
  assert.equal(corrRes.coefficient, 1);

  // Time series summary
  const tsRes = engine.timeSeriesSummary(dataset, "date", "DAY", "val");
  assert.equal(tsRes.points.length, 5);
});

test("DATABASE QUERY ENGINE: SQLite strictly read-only, write attempt rejections & immutability", () => {
  const { workspaceStore, workspace } = setupTestEnvironment();
  const dbEngine = new DatabaseQueryEngine(workspaceStore);

  // Create SQLite file in workspace
  const { absolutePath } = resolveWorkspacePath(workspaceStore, workspace.id, "test.sqlite", {
    allowMissing: true
  });
  const setupDb = new Database(absolutePath);
  setupDb.exec("CREATE TABLE users (id INTEGER PRIMARY KEY, name TEXT, role TEXT)");
  setupDb.exec("INSERT INTO users VALUES (1, 'Alice', 'admin'), (2, 'Bob', 'user')");
  setupDb.close();

  // List tables & describe table
  const tables = dbEngine.listTables(workspace.id, "test.sqlite");
  assert.deepEqual(tables, ["users"]);

  const desc = dbEngine.describeTable(workspace.id, "test.sqlite", "users");
  assert.equal(desc.rowCount, 2);
  assert.equal(desc.columns.length, 3);

  // Select query
  const sel = dbEngine.select(workspace.id, "test.sqlite", "SELECT * FROM users WHERE role = 'admin'");
  assert.equal(sel.rowCount, 1);
  assert.equal(sel.rows[0].name, "Alice");

  // Rejections of write attempts
  assert.throws(
    () => dbEngine.select(workspace.id, "test.sqlite", "INSERT INTO users VALUES (3, 'Eve', 'hacker')"),
    (err: any) => err.message === WORKBENCH_ERRORS.DATABASE_QUERY_NOT_READ_ONLY
  );

  assert.throws(
    () => dbEngine.select(workspace.id, "test.sqlite", "DROP TABLE users"),
    (err: any) => err.message === WORKBENCH_ERRORS.DATABASE_QUERY_NOT_READ_ONLY
  );

  assert.throws(
    () => dbEngine.select(workspace.id, "test.sqlite", "SELECT * FROM users; DROP TABLE users;"),
    (err: any) => err.message === WORKBENCH_ERRORS.DATABASE_QUERY_NOT_READ_ONLY
  );

  // Verify DB immutability
  const postCheck = dbEngine.select(workspace.id, "test.sqlite", "SELECT COUNT(*) as total FROM users");
  assert.equal(postCheck.rows[0].total, 2);

  cleanupTestEnvironment();
});

test("REPORT ENGINE: Markdown, JSON, CSV generation, provenance & artifact store persistence", () => {
  const { workspaceStore, artifactStore, workspace } = setupTestEnvironment();
  const reportEngine = new ReportEngine(workspaceStore, artifactStore);

  const reportRes = reportEngine.generateReport(
    workspace.id,
    {
      title: "Rapport d'Analyse Financière",
      summary: "Synthèse des ventes du premier trimestre.",
      findings: [
        {
          severity: "HIGH",
          title: "Ecart de chiffre d'affaires",
          evidence: "Anomalie sur la ligne 42",
          recommendation: "Auditer la source des données"
        }
      ],
      sections: [
        {
          title: "Ventes par Région",
          content: "Les ventes en région Ouest ont progressé de 15%.",
          provenance: [{ workspaceId: workspace.id, path: "sales.xlsx", sheet: "2026", rows: [10, 50] }]
        }
      ],
      tables: [
        {
          title: "Top Performers",
          columns: ["Nom", "Ventes"],
          rows: [
            ["Alice", 50000],
            ["Bob", 42000]
          ]
        }
      ],
      sources: [
        { workspaceId: workspace.id, path: "sales.xlsx", sheet: "2026" }
      ]
    },
    "markdown",
    { persistArtifact: true }
  );

  assert.ok(reportRes.artifactId);
  assert.match(reportRes.content, /# Rapport d'Analyse Financière/);
  assert.match(reportRes.content, /Ecart de chiffre d'affaires/);
  assert.match(reportRes.content, /sales\.xlsx/);

  // Verify artifact creation in ArtifactStore
  const artifact = artifactStore.get(reportRes.artifactId!);
  assert.ok(artifact);
  assert.equal(artifact?.kind, "REPORT");

  cleanupTestEnvironment();
});
