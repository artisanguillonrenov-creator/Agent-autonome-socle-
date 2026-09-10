import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, symlinkSync, readFileSync as fsReadFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import ExcelJS from "exceljs";
import Database from "better-sqlite3";
import { closeDb, getDb } from "../persistence/db.js";
import { config } from "../config.js";
import { WorkspaceStore } from "../workspaces/workspaceStore.js";
import { ArtifactStore } from "../workspaces/artifactStore.js";
import { readDocument, searchDocument } from "./documentEngine.js";
import {
  listSheets,
  inspectSpreadsheet,
  readRange,
  loadTabularDataset,
  applyFilters,
  applySort,
  computeAggregate,
  exportCsv,
  exportXlsx,
} from "./spreadsheetEngine.js";
import { runDataAnalysis } from "./dataAnalysisEngine.js";
import { runDatabaseQuery } from "./databaseEngine.js";
import { generateReport } from "./reportEngine.js";
import { WORKBENCH_LIMITS } from "./limits.js";
import { canonicalSkillCatalog, CANONICAL_SKILL_IDS } from "../skills/catalog.js";
import { ServiceRegistry } from "../orchestration/serviceRegistry.js";
import { ServiceOrchestrator } from "../orchestration/serviceOrchestrator.js";
import { ServiceAdapter } from "../orchestration/serviceAdapter.js";
import { Planner } from "../planning/planner.js";
import { PlanRunner } from "../planning/planRunner.js";
import { WorkflowRegistry } from "../workflows/workflowRegistry.js";
import { createRuntimeSkills } from "../skills/runtime.js";

function setup() {
  config.db.path = ":memory:";
  closeDb();
  getDb();
  const workspaces = new WorkspaceStore(mkdtempSync(join(tmpdir(), "workbench-")), 40 * 1024 * 1024, 500 * 1024 * 1024);
  const artifacts = new ArtifactStore(workspaces);
  const workspaceId = workspaces.create({ name: "wb", ownerType: "ADHOC", ownerId: randomUUID() }).id;
  return { workspaces, artifacts, workspaceId };
}

async function xlsxBuffer(build: (wb: ExcelJS.Workbook) => void): Promise<Buffer> {
  const wb = new ExcelJS.Workbook();
  build(wb);
  return Buffer.from(await wb.xlsx.writeBuffer());
}

const ZIP_EOCD_SIGNATURE = 0x06054b50;
const ZIP_CENTRAL_DIRECTORY_SIGNATURE = 0x02014b50;

function findZipEocd(buf: Buffer): number {
  for (let i = buf.length - 22; i >= 0; i--) {
    if (buf.readUInt32LE(i) === ZIP_EOCD_SIGNATURE) return i;
  }
  throw new Error("EOCD introuvable dans le fixture de test");
}

function countZipEntries(buf: Buffer): number {
  return buf.readUInt16LE(findZipEocd(buf) + 10);
}

/**
 * Falsifie, dans le répertoire central du ZIP, les tailles compressée/décompressée déclarées de
 * chaque entrée — sans toucher aux données réellement compressées — pour simuler un conteneur XLSX
 * qui reste petit sur disque mais ment sur ce qu'il prétend décompresser.
 */
function tamperXlsxDeclaredSizes(
  buf: Buffer,
  mutate: (out: Buffer, entryIndex: number, uncompressedSizeOffset: number, compressedSizeOffset: number) => void,
): Buffer {
  const out = Buffer.from(buf);
  const eocd = findZipEocd(out);
  const totalEntries = out.readUInt16LE(eocd + 10);
  const cdOffset = out.readUInt32LE(eocd + 16);
  let pos = cdOffset;
  for (let i = 0; i < totalEntries; i++) {
    if (out.readUInt32LE(pos) !== ZIP_CENTRAL_DIRECTORY_SIGNATURE) throw new Error("entrée de répertoire central inattendue dans le fixture");
    mutate(out, i, pos + 24, pos + 20);
    const nameLength = out.readUInt16LE(pos + 28);
    const extraLength = out.readUInt16LE(pos + 30);
    const commentLength = out.readUInt16LE(pos + 32);
    pos += 46 + nameLength + extraLength + commentLength;
  }
  return out;
}

function buildMinimalPdf(includeText: boolean): Buffer {
  const contentStr = includeText ? "BT /F1 24 Tf 72 700 Td (Hello Workbench) Tj ET" : "";
  const content = `<< /Length ${contentStr.length} >>\nstream\n${contentStr}\nendstream`;
  const objs = [
    `<< /Type /Catalog /Pages 2 0 R >>`,
    `<< /Type /Pages /Kids [3 0 R] /Count 1 >>`,
    `<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Resources << /Font << /F1 5 0 R >> >> /Contents 4 0 R >>`,
    content,
    `<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>`,
  ];
  let pdf = "%PDF-1.4\n";
  const offsets: number[] = [];
  objs.forEach((body, i) => {
    offsets.push(Buffer.byteLength(pdf, "latin1"));
    pdf += `${i + 1} 0 obj\n${body}\nendobj\n`;
  });
  const xrefStart = Buffer.byteLength(pdf, "latin1");
  pdf += `xref\n0 ${objs.length + 1}\n0000000000 65535 f \n`;
  for (const off of offsets) pdf += `${String(off).padStart(10, "0")} 00000 n \n`;
  pdf += `trailer\n<< /Size ${objs.length + 1} /Root 1 0 R >>\nstartxref\n${xrefStart}\n%%EOF`;
  return Buffer.from(pdf, "latin1");
}

// ---------------------------------------------------------------------------
// DOCUMENT
// ---------------------------------------------------------------------------

test("document: lit un .txt simple", async () => {
  const { workspaces, workspaceId } = setup();
  workspaces.writeFile(workspaceId, "a.txt", "hello world");
  const result = await readDocument(workspaces, workspaceId, "a.txt");
  assert.equal(result.format, "txt");
  assert.equal(result.text, "hello world");
  assert.equal(result.truncated, false);
  assert.deepEqual(result.sections, []);
});

test("document: extrait les sections markdown", async () => {
  const { workspaces, workspaceId } = setup();
  workspaces.writeFile(workspaceId, "doc.md", "# Titre\ntexte\n## Sous-titre\nsuite");
  const result = await readDocument(workspaces, workspaceId, "doc.md");
  assert.equal(result.sections.length, 2);
  assert.equal(result.sections[0].level, 1);
  assert.equal(result.sections[0].title, "Titre");
  assert.equal(result.sections[1].level, 2);
  assert.equal(result.sections[1].title, "Sous-titre");
});

test("document: JSON invalide ne crash pas et porte un warning", async () => {
  const { workspaces, workspaceId } = setup();
  workspaces.writeFile(workspaceId, "bad.json", "{not valid json");
  const result = await readDocument(workspaces, workspaceId, "bad.json");
  assert.equal(result.text, "{not valid json");
  assert.ok(result.warnings.includes("DOCUMENT_JSON_INVALID"));
});

test("document: JSON valide est reformaté proprement", async () => {
  const { workspaces, workspaceId } = setup();
  workspaces.writeFile(workspaceId, "ok.json", '{"a":1}');
  const result = await readDocument(workspaces, workspaceId, "ok.json");
  assert.deepEqual(JSON.parse(result.text), { a: 1 });
  assert.deepEqual(result.warnings, []);
});

test("document: HTML n'exécute jamais script/style/iframe", async () => {
  const { workspaces, workspaceId } = setup();
  workspaces.writeFile(
    workspaceId,
    "page.html",
    "<html><head><style>.x{color:red}</style><script>alert(1)</script></head><body><h1>Titre</h1><iframe src='evil'></iframe><p>Texte visible</p></body></html>",
  );
  const result = await readDocument(workspaces, workspaceId, "page.html");
  assert.ok(!result.text.includes("alert"));
  assert.ok(!result.text.includes("color:red"));
  assert.ok(!result.text.includes("evil"));
  assert.ok(result.text.includes("Titre"));
  assert.ok(result.text.includes("Texte visible"));
});

test("document: PDF textuel réel est extrait sans OCR", async () => {
  const { workspaces, workspaceId } = setup();
  workspaces.writeFile(workspaceId, "real.pdf", buildMinimalPdf(true));
  const result = await readDocument(workspaces, workspaceId, "real.pdf");
  assert.equal(result.format, "pdf");
  assert.equal(result.pageCount, 1);
  assert.ok(result.text.includes("Hello Workbench"));
});

test("document: PDF quasi sans texte exige DOCUMENT_OCR_REQUIRED, jamais un faux OCR", async () => {
  const { workspaces, workspaceId } = setup();
  workspaces.writeFile(workspaceId, "scan.pdf", buildMinimalPdf(false));
  await assert.rejects(() => readDocument(workspaces, workspaceId, "scan.pdf"), /DOCUMENT_OCR_REQUIRED/);
});

test("document: fichier >25 MiB rejeté", async () => {
  const { workspaces, workspaceId } = setup();
  workspaces.writeFile(workspaceId, "huge.txt", Buffer.alloc(WORKBENCH_LIMITS.INPUT_FILE_MAX_BYTES + 1, "a"));
  await assert.rejects(() => readDocument(workspaces, workspaceId, "huge.txt"), /DOCUMENT_FILE_TOO_LARGE/);
});

test("document: recherche bornée à 100 résultats", async () => {
  const { workspaces, workspaceId } = setup();
  workspaces.writeFile(workspaceId, "many.txt", "needle ".repeat(150));
  const result = await searchDocument(workspaces, workspaceId, "many.txt", "needle");
  assert.equal(result.matches.length, WORKBENCH_LIMITS.DOCUMENT_MAX_SEARCH_RESULTS);
  assert.equal(result.totalMatches, 150);
  assert.equal(result.truncated, true);
});

test("document: contextChars est plafonné, pas de contexte arbitrairement grand", async () => {
  const { workspaces, workspaceId } = setup();
  workspaces.writeFile(workspaceId, "ctx.txt", `${"a".repeat(1000)} needle ${"b".repeat(1000)}`);
  const result = await searchDocument(workspaces, workspaceId, "ctx.txt", "needle", { contextChars: 10_000_000 });
  assert.ok(result.matches[0].context.length < 2000);
});

test("document: recherche sur un texte tronqué à DOCUMENT_MAX_TEXT_CHARS est signalée truncated=true", async () => {
  const { workspaces, workspaceId } = setup();
  // "needle" placé bien après la coupe à DOCUMENT_MAX_TEXT_CHARS : le document lu est tronqué
  // avant même la recherche, donc la recherche elle-même doit hériter truncated=true, même si
  // elle ne trouve aucune occurrence dans la portion inspectée.
  const content = "a".repeat(WORKBENCH_LIMITS.DOCUMENT_MAX_TEXT_CHARS + 1000) + "needle";
  workspaces.writeFile(workspaceId, "cut.txt", content);
  const result = await searchDocument(workspaces, workspaceId, "cut.txt", "needle");
  assert.equal(result.totalMatches, 0);
  assert.equal(result.matches.length, 0);
  assert.equal(result.truncated, true);
  assert.ok(result.warnings.includes("DOCUMENT_TEXT_TRUNCATED_BEFORE_SEARCH"));
});

// ---------------------------------------------------------------------------
// SPREADSHEET
// ---------------------------------------------------------------------------

test("spreadsheet: CSV simple — listSheets et readRange", async () => {
  const { workspaces, workspaceId } = setup();
  workspaces.writeFile(workspaceId, "simple.csv", "name,age\nAlice,30\nBob,25\n");
  const sheets = await listSheets(workspaces, workspaceId, "simple.csv");
  assert.deepEqual(sheets.sheets, [{ name: "Sheet1", index: 0 }]);
  const range = await readRange(workspaces, workspaceId, "simple.csv", { startRow: 0, endRow: 1 });
  assert.deepEqual(range.rows, [
    ["name", "age"],
    ["Alice", "30"],
  ]);
  assert.equal(range.totalRowsKnown, true);
  assert.equal(range.totalRows, 3);
  assert.equal(range.truncated, false);
});

test("spreadsheet: CSV avec champs multilignes et guillemets échappés", async () => {
  const { workspaces, workspaceId } = setup();
  workspaces.writeFile(workspaceId, "quoted.csv", 'name,note\r\n"Doe, John","Hello ""World""\nnext line"\r\n"Alice","simple"\r\n');
  const dataset = await loadTabularDataset(workspaces, workspaceId, "quoted.csv", {
    maxRows: 100,
    maxColumns: 50,
    maxCells: 10_000,
  });
  assert.deepEqual(dataset.headers, ["name", "note"]);
  assert.deepEqual(dataset.rows[0], ["Doe, John", 'Hello "World"\nnext line']);
  assert.deepEqual(dataset.rows[1], ["Alice", "simple"]);
});

test("spreadsheet: TSV est parsé avec le bon séparateur", async () => {
  const { workspaces, workspaceId } = setup();
  workspaces.writeFile(workspaceId, "data.tsv", "a\tb\n1\t2\n3\t4\n");
  const dataset = await loadTabularDataset(workspaces, workspaceId, "data.tsv", { maxRows: 10, maxColumns: 10, maxCells: 1000 });
  assert.deepEqual(dataset.headers, ["a", "b"]);
  assert.deepEqual(dataset.rows, [
    ["1", "2"],
    ["3", "4"],
  ]);
});

test("spreadsheet: vrai XLSX multi-feuilles est listé et lu", async () => {
  const { workspaces, workspaceId } = setup();
  const buf = await xlsxBuffer((wb) => {
    const s1 = wb.addWorksheet("Ventes");
    s1.addRow(["produit", "prix"]);
    s1.addRow(["stylo", 2]);
    const s2 = wb.addWorksheet("Clients");
    s2.addRow(["nom"]);
    s2.addRow(["Alice"]);
  });
  workspaces.writeFile(workspaceId, "book.xlsx", buf);
  const sheets = await listSheets(workspaces, workspaceId, "book.xlsx");
  assert.deepEqual(
    sheets.sheets.map((s) => s.name),
    ["Ventes", "Clients"],
  );
  const range = await readRange(workspaces, workspaceId, "book.xlsx", { sheet: "Clients", startRow: 0 });
  assert.deepEqual(range.rows, [["nom"], ["Alice"]]);
  assert.equal(range.totalRowsKnown, true);
  assert.equal(range.totalRows, 2);
});

test("spreadsheet: fichier >25 MiB rejeté avant même listSheets", async () => {
  const { workspaces, workspaceId } = setup();
  workspaces.writeFile(workspaceId, "huge.csv", Buffer.alloc(WORKBENCH_LIMITS.INPUT_FILE_MAX_BYTES + 1, "a"));
  await assert.rejects(() => listSheets(workspaces, workspaceId, "huge.csv"), /SPREADSHEET_FILE_TOO_LARGE/);
});

test("spreadsheet: XLSX zip-bomb (entrée individuelle) rejeté avant toute décompression, via LIST_SHEETS", async () => {
  const { workspaces, workspaceId } = setup();
  const base = await xlsxBuffer((wb) => {
    const sheet = wb.addWorksheet("S");
    sheet.addRow(["a", "b"]);
    sheet.addRow([1, 2]);
  });
  const bomb = tamperXlsxDeclaredSizes(base, (out, entryIndex, uncompressedOffset) => {
    if (entryIndex === 0) out.writeUInt32LE(WORKBENCH_LIMITS.SPREADSHEET_XLSX_MAX_ENTRY_UNCOMPRESSED_BYTES + 1, uncompressedOffset);
  });
  assert.ok(bomb.length < WORKBENCH_LIMITS.INPUT_FILE_MAX_BYTES);
  workspaces.writeFile(workspaceId, "bomb-entry.xlsx", bomb);
  await assert.rejects(() => listSheets(workspaces, workspaceId, "bomb-entry.xlsx"), /SPREADSHEET_XLSX_EXPANSION_LIMIT/);
});

test("spreadsheet: XLSX zip-bomb (total décompressé) rejeté via READ_RANGE", async () => {
  const { workspaces, workspaceId } = setup();
  const base = await xlsxBuffer((wb) => {
    const sheet = wb.addWorksheet("S");
    sheet.addRow(["a", "b"]);
    sheet.addRow([1, 2]);
  });
  const entryCount = countZipEntries(base);
  const perEntryDeclared = Math.min(
    WORKBENCH_LIMITS.SPREADSHEET_XLSX_MAX_ENTRY_UNCOMPRESSED_BYTES - 1,
    Math.ceil((WORKBENCH_LIMITS.SPREADSHEET_XLSX_MAX_TOTAL_UNCOMPRESSED_BYTES * 2) / entryCount),
  );
  const bomb = tamperXlsxDeclaredSizes(base, (out, _entryIndex, uncompressedOffset) => out.writeUInt32LE(perEntryDeclared, uncompressedOffset));
  assert.ok(bomb.length < WORKBENCH_LIMITS.INPUT_FILE_MAX_BYTES);
  assert.ok(perEntryDeclared * entryCount > WORKBENCH_LIMITS.SPREADSHEET_XLSX_MAX_TOTAL_UNCOMPRESSED_BYTES);
  workspaces.writeFile(workspaceId, "bomb-total.xlsx", bomb);
  await assert.rejects(() => readRange(workspaces, workspaceId, "bomb-total.xlsx", { startRow: 0 }), /SPREADSHEET_XLSX_EXPANSION_LIMIT/);
});

test("spreadsheet: XLSX zip-bomb (ratio de compression) rejeté, y compris via data_analysis", async () => {
  const { workspaces, workspaceId } = setup();
  const base = await xlsxBuffer((wb) => {
    const sheet = wb.addWorksheet("S");
    sheet.addRow(["v"]);
    sheet.addRow([1]);
  });
  const bomb = tamperXlsxDeclaredSizes(base, (out, entryIndex, uncompressedOffset, compressedOffset) => {
    if (entryIndex === 0) {
      out.writeUInt32LE(5 * 1024 * 1024, uncompressedOffset); // 5 MiB déclarés, sous les deux plafonds
      out.writeUInt32LE(4, compressedOffset); // ...pour 4 octets compressés déclarés : ratio ~1.3M
    }
  });
  assert.ok(bomb.length < WORKBENCH_LIMITS.INPUT_FILE_MAX_BYTES);
  workspaces.writeFile(workspaceId, "bomb-ratio.xlsx", bomb);
  await assert.rejects(
    () => runDataAnalysis(workspaces, { workspaceId, path: "bomb-ratio.xlsx", action: "COUNT" }),
    /SPREADSHEET_XLSX_EXPANSION_LIMIT/,
  );
});

test("spreadsheet: >200 colonnes bornées avec warning", async () => {
  const { workspaces, workspaceId } = setup();
  const header = Array.from({ length: 250 }, (_, i) => `c${i}`).join(",");
  const row = Array.from({ length: 250 }, (_, i) => String(i)).join(",");
  workspaces.writeFile(workspaceId, "wide.csv", `${header}\n${row}\n`);
  const dataset = await loadTabularDataset(workspaces, workspaceId, "wide.csv", {
    maxRows: 10,
    maxColumns: WORKBENCH_LIMITS.SPREADSHEET_MAX_COLUMNS,
    maxCells: WORKBENCH_LIMITS.SPREADSHEET_MAX_CELLS_PER_READ,
  });
  assert.equal(dataset.headers.length, WORKBENCH_LIMITS.SPREADSHEET_MAX_COLUMNS);
  assert.ok(dataset.warnings.includes("SPREADSHEET_COLUMNS_TRUNCATED"));
  assert.equal(dataset.truncated, true);
});

test("spreadsheet: >200 colonnes XLSX bornées, warning et truncated=true", async () => {
  const { workspaces, workspaceId } = setup();
  const buf = await xlsxBuffer((wb) => {
    const sheet = wb.addWorksheet("Wide");
    sheet.addRow(Array.from({ length: 250 }, (_, i) => `c${i}`));
    sheet.addRow(Array.from({ length: 250 }, (_, i) => i));
  });
  workspaces.writeFile(workspaceId, "wide.xlsx", buf);
  const dataset = await loadTabularDataset(workspaces, workspaceId, "wide.xlsx", {
    maxRows: 10,
    maxColumns: WORKBENCH_LIMITS.SPREADSHEET_MAX_COLUMNS,
    maxCells: WORKBENCH_LIMITS.SPREADSHEET_MAX_CELLS_PER_READ,
  });
  assert.equal(dataset.headers.length, WORKBENCH_LIMITS.SPREADSHEET_MAX_COLUMNS);
  assert.ok(dataset.warnings.includes("SPREADSHEET_COLUMNS_TRUNCATED"));
  assert.equal(dataset.truncated, true);
});

test("spreadsheet: >10k lignes bornées, XLSX arrêt anticipé, totalRowsKnown=false", async () => {
  const { workspaces, workspaceId } = setup();
  const rowCount = WORKBENCH_LIMITS.SPREADSHEET_MAX_ROWS_PER_READ + 5;
  const buf = await xlsxBuffer((wb) => {
    const sheet = wb.addWorksheet("Big");
    for (let i = 0; i < rowCount; i++) sheet.addRow([i, `v${i}`]);
  });
  workspaces.writeFile(workspaceId, "big.xlsx", buf);

  const full = await readRange(workspaces, workspaceId, "big.xlsx", { startRow: 0 });
  assert.equal(full.rows.length, WORKBENCH_LIMITS.SPREADSHEET_MAX_ROWS_PER_READ);
  assert.equal(full.truncated, true);
  assert.equal(full.totalRowsKnown, false);
  assert.equal(full.totalRows, undefined);

  const small = await readRange(workspaces, workspaceId, "big.xlsx", { startRow: 0, endRow: 2 });
  assert.equal(small.rows.length, 3);
  assert.deepEqual(small.rows[0], [0, "v0"]);
});

test("spreadsheet: petite feuille lue jusqu'au bout connaît son total réel", async () => {
  const { workspaces, workspaceId } = setup();
  const buf = await xlsxBuffer((wb) => {
    const sheet = wb.addWorksheet("Small");
    for (let i = 0; i < 5; i++) sheet.addRow([i]);
  });
  workspaces.writeFile(workspaceId, "small.xlsx", buf);
  const result = await readRange(workspaces, workspaceId, "small.xlsx", { startRow: 0 });
  assert.equal(result.totalRowsKnown, true);
  assert.equal(result.totalRows, 5);
  assert.equal(result.truncated, false);
});

test("spreadsheet: >250 000 cellules inspectées bornées", async () => {
  const { workspaces, workspaceId } = setup();
  const cols = 200;
  const rows = 2000; // 2000 * 200 = 400 000 cellules > 250 000
  const header = Array.from({ length: cols }, (_, i) => `c${i}`).join(",");
  const lines = [header];
  for (let r = 0; r < rows; r++) lines.push(Array.from({ length: cols }, (_, c) => `${r}-${c}`).join(","));
  workspaces.writeFile(workspaceId, "cells.csv", lines.join("\n") + "\n");

  const result = await inspectSpreadsheet(workspaces, workspaceId, "cells.csv");
  assert.equal(result.truncated, true);
  assert.ok(result.warnings.includes("SPREADSHEET_INSPECT_TRUNCATED"));
  assert.ok(result.sampleRowCount * result.columnCount <= WORKBENCH_LIMITS.SPREADSHEET_MAX_CELLS_PER_READ);
});

test("spreadsheet: formule XLSX retourne le résultat en cache, jamais exécutée", async () => {
  const { workspaces, workspaceId } = setup();
  const buf = await xlsxBuffer((wb) => {
    const sheet = wb.addWorksheet("Formulas");
    sheet.addRow(["label", "total"]);
    sheet.getCell("A2").value = "somme";
    sheet.getCell("B2").value = { formula: "1+2", result: 3 } as ExcelJS.CellValue;
    sheet.getCell("A3").value = "sans_cache";
    sheet.getCell("B3").value = { formula: "1+2" } as ExcelJS.CellValue;
  });
  workspaces.writeFile(workspaceId, "formulas.xlsx", buf);
  const result = await readRange(workspaces, workspaceId, "formulas.xlsx", { startRow: 0 });
  assert.equal(result.rows[1][1], 3);
  assert.equal(result.rows[2][1], null);
  assert.ok(result.warnings.includes("SPREADSHEET_FORMULA_NO_CACHED_RESULT"));
});

test("spreadsheet: .xls explicitement non supporté", async () => {
  const { workspaces, workspaceId } = setup();
  workspaces.writeFile(workspaceId, "legacy.xls", "not really xls but irrelevant");
  await assert.rejects(() => listSheets(workspaces, workspaceId, "legacy.xls"), /SPREADSHEET_FORMAT_XLS_UNSUPPORTED/);
});

test("spreadsheet: plage invalide rejetée", async () => {
  const { workspaces, workspaceId } = setup();
  workspaces.writeFile(workspaceId, "r.csv", "a,b\n1,2\n3,4\n");
  await assert.rejects(() => readRange(workspaces, workspaceId, "r.csv", { startRow: -1 }), /SPREADSHEET_RANGE_INVALID/);
  await assert.rejects(() => readRange(workspaces, workspaceId, "r.csv", { startRow: 3, endRow: 1 }), /SPREADSHEET_RANGE_INVALID/);
  await assert.rejects(
    () => readRange(workspaces, workspaceId, "r.csv", { startRow: 0, endRow: 1, columns: [99] }),
    /SPREADSHEET_RANGE_INVALID/,
  );
});

test("spreadsheet: une ligne creuse au-delà de endRow n'est jamais incluse", async () => {
  const { workspaces, workspaceId } = setup();
  const buf = await xlsxBuffer((wb) => {
    const sheet = wb.addWorksheet("Sparse");
    sheet.getCell("A1").value = "first";
    sheet.getCell("A10").value = "far-away";
  });
  workspaces.writeFile(workspaceId, "sparse.xlsx", buf);
  const result = await readRange(workspaces, workspaceId, "sparse.xlsx", { startRow: 0, endRow: 3 });
  assert.deepEqual(result.rows, [["first"]]);
});

test("spreadsheet: traversal et symlink rejetés", async () => {
  const { workspaces, workspaceId } = setup();
  workspaces.writeFile(workspaceId, "ok.csv", "a\n1\n");
  await assert.rejects(() => listSheets(workspaces, workspaceId, "../escape.csv"), /INVALID_WORKSPACE_PATH/);
  symlinkSync(tmpdir(), join(workspaces.root, workspaceId, "escape"));
  await assert.rejects(() => listSheets(workspaces, workspaceId, "escape/x.csv"), /SYMLINK_FORBIDDEN/);
});

test("spreadsheet: filtre numérique ignore les cellules non numériques comme 'n/a'", async () => {
  const { workspaces, workspaceId } = setup();
  workspaces.writeFile(workspaceId, "f.csv", "id,score\n1,5\n2,n/a\n3,15\n");
  const dataset = await loadTabularDataset(workspaces, workspaceId, "f.csv", { maxRows: 10, maxColumns: 10, maxCells: 100 });
  const above = applyFilters(dataset.headers, dataset.rows, [{ column: "score", operator: "greaterThan", value: 10 }]);
  const below = applyFilters(dataset.headers, dataset.rows, [{ column: "score", operator: "lessThan", value: 10 }]);
  assert.deepEqual(
    above.map((r) => r[0]),
    ["3"],
  );
  assert.deepEqual(
    below.map((r) => r[0]),
    ["1"],
  );
  assert.ok(!above.some((r) => r[0] === "2"));
  assert.ok(!below.some((r) => r[0] === "2"));
});

test("spreadsheet: aggregate ignore null/undefined/vide et les booléens", async () => {
  const { workspaces, workspaceId } = setup();
  workspaces.writeFile(workspaceId, "agg.csv", "v\n1\n\n3\n");
  const dataset = await loadTabularDataset(workspaces, workspaceId, "agg.csv", { maxRows: 10, maxColumns: 10, maxCells: 100 });
  assert.equal(computeAggregate(dataset.headers, dataset.rows, "v", "SUM"), 4);
  assert.equal(computeAggregate(dataset.headers, dataset.rows, "v", "COUNT"), 2);
  assert.equal(computeAggregate([...dataset.headers], [["1"], [true as unknown as string], ["3"]], "v", "SUM"), 4);
});

test("spreadsheet: Infinity/NaN textuels ou numériques ne contaminent jamais un agrégat", () => {
  const headers = ["v"];
  const rows = [["1"], ["Infinity"], ["-Infinity"], ["NaN"], [Infinity as unknown as string], [NaN as unknown as string], ["3"]];
  assert.equal(computeAggregate(headers, rows, "v", "SUM"), 4);
  assert.equal(computeAggregate(headers, rows, "v", "MEAN"), 2);
  assert.equal(Number.isFinite(computeAggregate(headers, rows, "v", "SUM")), true);
});

test("spreadsheet: un débordement numérique lève DATA_NUMERIC_OVERFLOW", () => {
  const headers = ["v"];
  const rows = [[Number.MAX_VALUE], [Number.MAX_VALUE]];
  assert.throws(() => computeAggregate(headers, rows, "v", "SUM"), /DATA_NUMERIC_OVERFLOW/);
});

test("spreadsheet: SORT est déterministe et gère les valeurs nulles", () => {
  const headers = ["v"];
  const rows = [["3"], [null], ["1"], [""], ["2"]];
  const sorted = applySort(headers, rows, [{ column: "v", direction: "asc" }]);
  assert.deepEqual(
    sorted.map((r) => r[0]),
    ["1", "2", "3", null, ""],
  );
});

test("spreadsheet: EXPORT_CSV et EXPORT_XLSX écrivent bien via ArtifactStore", async () => {
  const { workspaces, artifacts, workspaceId } = setup();
  workspaces.writeFile(workspaceId, "src.csv", "a,b\n2,x\n1,y\n");
  const csvResult = await exportCsv(workspaces, artifacts, workspaceId, {
    path: "src.csv",
    sortBy: [{ column: "a", direction: "asc" }],
  });
  assert.equal(csvResult.rowCount, 2);
  const csvArtifact = artifacts.get(csvResult.artifactId);
  assert.equal(csvArtifact?.contentStatus, "AVAILABLE");

  const xlsxResult = await exportXlsx(workspaces, artifacts, workspaceId, { path: "src.csv", targetPath: "out/export.xlsx" });
  assert.equal(workspaces.exists(workspaceId, "out/export.xlsx"), true);
  assert.equal(xlsxResult.workingPath, "out/export.xlsx");
});

// ---------------------------------------------------------------------------
// DATA ANALYSIS
// ---------------------------------------------------------------------------

test("analysis: statistiques de base (DESCRIBE/MEAN/STDDEV)", async () => {
  const { workspaces, workspaceId } = setup();
  workspaces.writeFile(workspaceId, "s.csv", "v\n1\n2\n3\n4\n");
  const describe = await runDataAnalysis(workspaces, { workspaceId, path: "s.csv", action: "DESCRIBE", column: "v" });
  assert.equal((describe.describe as Record<string, unknown>).mean, 2.5);
  const mean = await runDataAnalysis(workspaces, { workspaceId, path: "s.csv", action: "MEAN", column: "v" });
  assert.equal(mean.mean, 2.5);
  const stddev = await runDataAnalysis(workspaces, { workspaceId, path: "s.csv", action: "STDDEV", column: "v" });
  assert.ok(Math.abs((stddev.stddev as number) - 1.29099) < 1e-3);
});

test("analysis: GROUP_BY compte et agrège par clé, bornée à ANALYSIS_MAX_RESULTS", async () => {
  const { workspaces, workspaceId } = setup();
  const rows = ["group,value"];
  for (let i = 0; i < 1005; i++) rows.push(`g${i},${i}`);
  workspaces.writeFile(workspaceId, "groups.csv", rows.join("\n") + "\n");
  const result = await runDataAnalysis(workspaces, {
    workspaceId,
    path: "groups.csv",
    action: "GROUP_BY",
    groupColumn: "group",
    aggregateColumn: "value",
    aggregateOperation: "SUM",
  });
  const groups = result.groups as Array<Record<string, unknown>>;
  assert.equal(groups.length, WORKBENCH_LIMITS.ANALYSIS_MAX_RESULTS);
  assert.equal(result.truncated, true);
});

test("analysis: CORRELATION calcule un coefficient de Pearson fini", async () => {
  const { workspaces, workspaceId } = setup();
  workspaces.writeFile(workspaceId, "corr.csv", "x,y\n1,2\n2,4\n3,6\n4,8\n");
  const result = await runDataAnalysis(workspaces, { workspaceId, path: "corr.csv", action: "CORRELATION", columnX: "x", columnY: "y" });
  assert.ok(Math.abs((result.correlation as number) - 1) < 1e-9);
});

test("analysis: CORRELATION reste finie et correcte même si sxx*syy déborderait", async () => {
  const { workspaces, workspaceId } = setup();
  workspaces.writeFile(workspaceId, "corrbig.csv", "x,y\n1e80,1e80\n2e80,2e80\n3e80,3e80\n4e80,4e80\n");
  const result = await runDataAnalysis(workspaces, { workspaceId, path: "corrbig.csv", action: "CORRELATION", columnX: "x", columnY: "y" });
  assert.ok(Number.isFinite(result.correlation as number));
  assert.ok(Math.abs((result.correlation as number) - 1) < 1e-6);
});

test("analysis: TIME_SERIES ISO-8601 place 2021-01-01 en 2020-W53", async () => {
  const { workspaces, workspaceId } = setup();
  workspaces.writeFile(workspaceId, "ts.csv", "date,v\n2021-01-01,1\n2016-01-01,1\n2017-01-01,1\n");
  const result = await runDataAnalysis(workspaces, { workspaceId, path: "ts.csv", action: "TIME_SERIES", dateColumn: "date", granularity: "WEEK" });
  const buckets = (result.series as Array<{ bucket: string }>).map((b) => b.bucket);
  assert.ok(buckets.includes("2020-W53"));
  assert.ok(buckets.includes("2015-W53"));
  assert.ok(buckets.includes("2016-W52"));
});

test("analysis: entrées non finies ignorées, sorties toujours finies", async () => {
  const { workspaces, workspaceId } = setup();
  workspaces.writeFile(workspaceId, "nf.csv", "v\n1\nNaN\nInfinity\n3\n");
  const result = await runDataAnalysis(workspaces, { workspaceId, path: "nf.csv", action: "SUM", column: "v" });
  assert.equal(result.sum, 4);
  assert.equal(Number.isFinite(result.sum as number), true);
});

test("analysis: un débordement de sortie lève DATA_NUMERIC_OVERFLOW", async () => {
  const { workspaces, workspaceId } = setup();
  workspaces.writeFile(workspaceId, "overflow.csv", `v\n${Number.MAX_VALUE}\n${Number.MAX_VALUE}\n`);
  await assert.rejects(
    () => runDataAnalysis(workspaces, { workspaceId, path: "overflow.csv", action: "SUM", column: "v" }),
    /DATA_NUMERIC_OVERFLOW/,
  );
});

// ---------------------------------------------------------------------------
// DATABASE QUERY
// ---------------------------------------------------------------------------

function seedSqlite(workspaces: WorkspaceStore, workspaceId: string, name: string, rowCount: number): void {
  const scratch = mkdtempSync(join(tmpdir(), "wb-sqlite-"));
  const scratchPath = join(scratch, "seed.db");
  const seed = new Database(scratchPath);
  seed.exec("CREATE TABLE items(id INTEGER PRIMARY KEY, label TEXT)");
  const insert = seed.prepare("INSERT INTO items(id,label) VALUES (?,?)");
  const tx = seed.transaction((n: number) => {
    for (let i = 0; i < n; i++) insert.run(i, `item-${i}`);
  });
  tx(rowCount);
  seed.close();
  workspaces.writeFile(workspaceId, name, fsReadFileSync(scratchPath));
}

test("database: SELECT et WITH...SELECT fonctionnent en lecture seule", () => {
  const { workspaces, workspaceId } = setup();
  seedSqlite(workspaces, workspaceId, "app.db", 3);
  const select = runDatabaseQuery(workspaces, workspaceId, "app.db", "SELECT id, label FROM items ORDER BY id");
  assert.equal(select.rows.length, 3);
  assert.deepEqual(select.columns, ["id", "label"]);

  const withSelect = runDatabaseQuery(workspaces, workspaceId, "app.db", "WITH recent AS (SELECT * FROM items) SELECT * FROM recent ORDER BY id");
  assert.equal(withSelect.rows.length, 3);
});

test("database: toute mutation est rejetée, y compris via WITH", () => {
  const { workspaces, workspaceId } = setup();
  seedSqlite(workspaces, workspaceId, "app.db", 1);
  assert.throws(() => runDatabaseQuery(workspaces, workspaceId, "app.db", "INSERT INTO items(id,label) VALUES (99,'x')"), /DATABASE_WRITE_QUERY_FORBIDDEN/);
  assert.throws(() => runDatabaseQuery(workspaces, workspaceId, "app.db", "UPDATE items SET label='x' WHERE id=0"), /DATABASE_WRITE_QUERY_FORBIDDEN/);
  assert.throws(() => runDatabaseQuery(workspaces, workspaceId, "app.db", "DELETE FROM items"), /DATABASE_WRITE_QUERY_FORBIDDEN/);
  assert.throws(
    () => runDatabaseQuery(workspaces, workspaceId, "app.db", "WITH x AS (SELECT 1) INSERT INTO items(id,label) SELECT 1,'x'"),
    /DATABASE_WRITE_QUERY_FORBIDDEN/,
  );
  // La connexion elle-même est ouverte en lecture seule : une tentative d'écriture échapperait au filtre textuel échouerait quand même à s'exécuter.
  const rows = runDatabaseQuery(workspaces, workspaceId, "app.db", "SELECT COUNT(*) as n FROM items");
  assert.equal(rows.rows[0].n, 1);
});

test("database: mots interdits dans une chaîne ou un commentaire n'entraînent pas un faux rejet", () => {
  const { workspaces, workspaceId } = setup();
  seedSqlite(workspaces, workspaceId, "app.db", 1);
  const literal = runDatabaseQuery(workspaces, workspaceId, "app.db", "SELECT 'UPDATE' AS action");
  assert.equal(literal.rows[0].action, "UPDATE");
  const commented = runDatabaseQuery(workspaces, workspaceId, "app.db", "SELECT 1 AS n -- DELETE stale cache");
  assert.equal(commented.rows[0].n, 1);
});

test("database: préserve les entiers 64 bits hors de portée d'un double", () => {
  const { workspaces, workspaceId } = setup();
  seedSqlite(workspaces, workspaceId, "app.db", 1);
  const big = runDatabaseQuery(workspaces, workspaceId, "app.db", "SELECT 9223372036854775807 AS huge, 42 AS small");
  assert.equal(big.rows[0].huge, "9223372036854775807");
  assert.equal(big.rows[0].small, 42);
});

test("database: résultats tronqués à 1000 lignes sans matérialisation illimitée", () => {
  const { workspaces, workspaceId } = setup();
  seedSqlite(workspaces, workspaceId, "big.db", WORKBENCH_LIMITS.DATABASE_MAX_RESULT_ROWS + 250);
  const result = runDatabaseQuery(workspaces, workspaceId, "big.db", "SELECT id FROM items ORDER BY id");
  assert.equal(result.rows.length, WORKBENCH_LIMITS.DATABASE_MAX_RESULT_ROWS);
  assert.equal(result.rowCountReturned, WORKBENCH_LIMITS.DATABASE_MAX_RESULT_ROWS);
  assert.equal(result.truncated, true);
});

// ---------------------------------------------------------------------------
// REPORT GENERATION
// ---------------------------------------------------------------------------

test("report: génère un artifact Markdown avec hash et taille cohérents", () => {
  const { artifacts, workspaceId } = setup();
  const result = generateReport(artifacts, { workspaceId, title: "Mon rapport", content: "# Titre\ncontenu", format: "MARKDOWN" });
  const artifact = artifacts.get(result.artifactId);
  assert.equal(artifact?.kind, "REPORT");
  assert.equal(artifact?.sizeBytes, Buffer.byteLength("# Titre\ncontenu", "utf8"));
  assert.equal(result.sha256?.length, 64);
  assert.equal(result.sizeBytes, artifact?.sizeBytes);
});

test("report: JSON invalide est rejeté, JSON valide reformaté", () => {
  const { artifacts, workspaceId } = setup();
  assert.throws(() => generateReport(artifacts, { workspaceId, title: "bad", content: "{not json", format: "JSON" }), /REPORT_INVALID_JSON/);
  const ok = generateReport(artifacts, { workspaceId, title: "good", content: '{"a":1}', format: "JSON" });
  const artifact = artifacts.get(ok.artifactId)!;
  assert.deepEqual(JSON.parse(artifacts.files.readFile(workspaceId, artifact.relativePath!).toString()), { a: 1 });
});

test("report: targetPath écrit réellement une copie dans le workspace", () => {
  const { workspaces, artifacts, workspaceId } = setup();
  const result = generateReport(artifacts, { workspaceId, title: "Copie", content: "contenu", format: "MARKDOWN", targetPath: "reports/out.md" });
  assert.equal(result.workingPath, "reports/out.md");
  assert.equal(workspaces.readFile(workspaceId, "reports/out.md").toString(), "contenu");
});

test("report: targetPath hors workspace est rejeté, rien n'est écrit", () => {
  const { artifacts, workspaceId } = setup();
  assert.throws(() => generateReport(artifacts, { workspaceId, title: "Escape", content: "x", format: "MARKDOWN", targetPath: "../escape.md" }));
});

test("report: rollback atomique si une seconde écriture du lot échoue", () => {
  const { artifacts, workspaceId } = setup();
  assert.throws(() =>
    artifacts.createBatch([
      { workspaceId, kind: "REPORT", name: "first.md", mimeType: "text/markdown", content: Buffer.from("ok") },
      { workspaceId, kind: "REPORT", name: "second.md", mimeType: "text/markdown", content: Buffer.from("x"), workingPath: "../escape.md" },
    ]),
  );
  assert.equal(artifacts.listByWorkspace(workspaceId).length, 0);
});

// ---------------------------------------------------------------------------
// RUNTIME
// ---------------------------------------------------------------------------

function runtimeHarness() {
  config.db.path = ":memory:";
  config.workspace.root = mkdtempSync(join(tmpdir(), "workbench-runtime-"));
  closeDb();
  getDb();
  const services = new ServiceRegistry("/missing.json");
  const adapter = new ServiceAdapter();
  const orchestrator = new ServiceOrchestrator({ registry: services, adapter });
  const planner = new Planner();
  const runner = new PlanRunner(orchestrator, planner);
  const workflows = new WorkflowRegistry();
  const skills = createRuntimeSkills(orchestrator, planner, runner, workflows);
  return { orchestrator, skills, get: (id: string) => skills.find((s) => s.id === id)! };
}

test("runtime: catalogue canonique reste exactement 40 identifiants", () => {
  assert.equal(canonicalSkillCatalog.length, 40);
  assert.equal(new Set(CANONICAL_SKILL_IDS).size, 40);
  for (const id of ["document_work", "spreadsheet_work", "data_analysis", "database_query", "report_generation"]) {
    const skill = canonicalSkillCatalog.find((s) => s.id === id)!;
    assert.equal(skill.availability, "AVAILABLE");
    assert.equal(skill.exposure, "DYNAMIC");
    assert.equal(skill.executionTarget, "LOCAL_HANDLER");
    assert.equal(skill.requiresWorkspace, true);
  }
});

test("runtime: les 5 capacités Workbench sont réellement appelables depuis le skill runtime", async () => {
  const h = runtimeHarness();
  const workspace = h.orchestrator.workspaces.create({ name: "wb", ownerType: "ADHOC", ownerId: "runtime-wb" });
  h.orchestrator.workspaces.writeFile(workspace.id, "doc.txt", "hello runtime");
  h.orchestrator.workspaces.writeFile(workspace.id, "sheet.csv", "a,b\n1,2\n3,4\n");
  seedSqlite(h.orchestrator.workspaces, workspace.id, "app.db", 2);

  for (const id of ["document_work", "spreadsheet_work", "data_analysis", "database_query", "report_generation"]) {
    const skill = h.get(id);
    assert.ok(skill?.handler, `${id} doit avoir un handler`);
  }

  const doc = JSON.parse(await h.get("document_work").handler!({ action: "READ", workspaceId: workspace.id, path: "doc.txt" }, {} as never));
  assert.equal(doc.text, "hello runtime");

  const sheets = JSON.parse(await h.get("spreadsheet_work").handler!({ action: "LIST_SHEETS", workspaceId: workspace.id, path: "sheet.csv" }, {} as never));
  assert.equal(sheets.sheets[0].name, "Sheet1");

  const analysis = JSON.parse(
    await h.get("data_analysis").handler!({ workspaceId: workspace.id, path: "sheet.csv", action: "SUM", column: "a" }, {} as never),
  );
  assert.equal(analysis.sum, 4);

  const db = JSON.parse(await h.get("database_query").handler!({ workspaceId: workspace.id, path: "app.db", sql: "SELECT COUNT(*) as n FROM items" }, {} as never));
  assert.equal(db.rows[0].n, 2);

  const report = JSON.parse(
    await h.get("report_generation").handler!({ workspaceId: workspace.id, title: "Bilan", content: "# Bilan\nok", format: "MARKDOWN" }, {} as never),
  );
  assert.ok(report.artifactId);
});
