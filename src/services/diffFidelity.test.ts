import test from "node:test";
import assert from "node:assert/strict";
import { checkDiffFidelity, diffLines } from "./diffFidelity.js";

test("diffLines : contenu identique → aucune addition/suppression", () => {
  assert.deepEqual(diffLines("a\nb\nc", "a\nb\nc"), { additions: 0, deletions: 0 });
});

test("diffLines : création pure (avant vide) → toutes les lignes sont des additions", () => {
  assert.deepEqual(diffLines("", "a\nb\nc"), { additions: 3, deletions: 0 });
});

test("diffLines : ajout d'une ligne au milieu compte 1 addition, 0 suppression", () => {
  assert.deepEqual(diffLines("a\nb\nc", "a\nX\nb\nc"), { additions: 1, deletions: 0 });
});

test("diffLines : suppression d'une ligne compte 0 addition, 1 suppression", () => {
  assert.deepEqual(diffLines("a\nb\nc", "a\nc"), { additions: 0, deletions: 1 });
});

test("A — changement exact attendu (fichier existant, ratio conservé suffisant) → PASS", () => {
  const original = "line1\nline2\nline3\nline4\nline5\nline6";
  const updated = "line1\nline2\nline3-modifiee\nline4\nline5\nline6";
  const result = checkDiffFidelity({ filePath: "docs/a.md", fileExistedBefore: true, originalContent: original, updatedContent: updated });
  assert.equal(result.fidelityStatus, "PASS");
  assert.equal(result.reason, null);
  assert.equal(result.files.length, 1);
  assert.equal(result.files[0].changeType, "modified");
  assert.equal(result.unexpectedFiles.length, 0);
});

test("B — fichier inattendu (hors périmètre de la mission) → FAIL", () => {
  const result = checkDiffFidelity({
    filePath: "docs/actual.md",
    expectedFilePath: "docs/authorized.md",
    fileExistedBefore: true,
    originalContent: "x",
    updatedContent: "y",
  });
  assert.equal(result.fidelityStatus, "FAIL");
  assert.deepEqual(result.unexpectedFiles, ["docs/actual.md"]);
  assert.match(result.reason ?? "", /fichier inattendu/);
});

test("C — suppression inattendue : le contenu est vidé alors que le fichier existait → FAIL", () => {
  const result = checkDiffFidelity({
    filePath: "docs/a.md",
    fileExistedBefore: true,
    originalContent: "contenu important\nligne 2\nligne 3",
    updatedContent: "",
  });
  assert.equal(result.fidelityStatus, "FAIL");
  assert.match(result.reason ?? "", /vidé/);
});

test("D — contenu hors périmètre modifié : réécriture qui ne conserve presque aucune ligne d'origine → FAIL", () => {
  const original = Array.from({ length: 20 }, (_, i) => `ligne originale ${i}`).join("\n");
  const updated = "contenu totalement différent, sans rapport avec l'original";
  const result = checkDiffFidelity({ filePath: "docs/a.md", fileExistedBefore: true, originalContent: original, updatedContent: updated });
  assert.equal(result.fidelityStatus, "FAIL");
  assert.match(result.reason ?? "", /réécriture massive/);
});

test("D bis — allowFullRewrite lève explicitement le garde-fou de réécriture massive", () => {
  const original = Array.from({ length: 20 }, (_, i) => `ligne originale ${i}`).join("\n");
  const updated = "contenu totalement différent, sans rapport avec l'original";
  const result = checkDiffFidelity({ filePath: "docs/a.md", fileExistedBefore: true, originalContent: original, updatedContent: updated, allowFullRewrite: true });
  assert.equal(result.fidelityStatus, "PASS");
});

test("E — création autorisée (fichier n'existait pas, expectedChangeType=create) → PASS", () => {
  const result = checkDiffFidelity({
    filePath: "docs/new.md",
    expectedChangeType: "create",
    fileExistedBefore: false,
    originalContent: "",
    updatedContent: "# Nouveau document\n\nContenu.",
  });
  assert.equal(result.fidelityStatus, "PASS");
  assert.equal(result.files[0].changeType, "created");
  assert.equal(result.files[0].deletions, 0);
});

test("F — création demandée alors que le fichier existe déjà → FAIL (jamais de remplacement silencieux)", () => {
  const result = checkDiffFidelity({
    filePath: "docs/new.md",
    expectedChangeType: "create",
    fileExistedBefore: true,
    originalContent: "contenu préexistant que la mission ignorait",
    updatedContent: "contenu qui écraserait l'existant",
  });
  assert.equal(result.fidelityStatus, "FAIL");
  assert.match(result.reason ?? "", /existe déjà/);
});

test("expectedChangeType=update alors que le fichier n'existe pas encore → FAIL (symétrique de F)", () => {
  const result = checkDiffFidelity({
    filePath: "docs/missing.md",
    expectedChangeType: "update",
    fileExistedBefore: false,
    originalContent: "",
    updatedContent: "contenu",
  });
  assert.equal(result.fidelityStatus, "FAIL");
});

test("G — diff vide/inutile (aucun changement réel) → comportement propre, PASS sans anomalie", () => {
  const content = "ligne1\nligne2\nligne3\nligne4\nligne5\nligne6\nligne7";
  const result = checkDiffFidelity({ filePath: "docs/a.md", fileExistedBefore: true, originalContent: content, updatedContent: content });
  assert.equal(result.fidelityStatus, "PASS");
  assert.equal(result.additions, 0);
  assert.equal(result.deletions, 0);
  assert.equal(result.reason, null);
});

test("fichier existant minuscule (≤ seuil de lignes) : le garde-fou de réécriture massive ne se déclenche pas à tort", () => {
  const result = checkDiffFidelity({ filePath: "docs/tiny.md", fileExistedBefore: true, originalContent: "a\nb", updatedContent: "contenu complètement différent" });
  assert.equal(result.fidelityStatus, "PASS", "un fichier de 2 lignes est sous le seuil de fiabilité du ratio, pas de faux positif");
});

test("aucun champ expected fourni : comportement historique, aucune vérification fichier/type de changement", () => {
  const result = checkDiffFidelity({
    filePath: "docs/whatever.md",
    fileExistedBefore: true,
    originalContent: "line1\nline2\nline3\nline4\nline5\nline6",
    updatedContent: "line1-modifiee\nline2\nline3\nline4\nline5\nline6",
  });
  assert.equal(result.fidelityStatus, "PASS");
});
