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

// --- Correction bloquante : le fallback au-delà de MAX_DIFF_CELLS ne doit
// jamais fabriquer un remplacement total. ---

test("1 — diffLines : fichier volumineux (> seuil MAX_DIFF_CELLS), une seule ligne modifiée → diff exact grâce au retrait du préfixe/suffixe commun", () => {
  // 2001 lignes : n*m pour le fichier ENTIER (~4 004 001) dépasserait déjà
  // MAX_DIFF_CELLS (4 000 000) si on ne réduisait pas au "cœur" différent.
  const lineCount = 2001;
  const lines = Array.from({ length: lineCount }, (_, i) => `ligne ${i}`);
  const original = lines.join("\n");
  const modifiedLines = [...lines];
  modifiedLines[1000] = "ligne 1000 MODIFIEE";
  const updated = modifiedLines.join("\n");

  const result = diffLines(original, updated);
  // Une seule ligne change : le diff exact doit le refléter précisément,
  // pas un remplacement des 2001 lignes.
  assert.equal(result.additions, 1);
  assert.equal(result.deletions, 1);
});

test("1 bis — checkDiffFidelity : modification normale d'une seule ligne sur un très grand fichier → PASS, jamais DIFF_FIDELITY_FAILED", () => {
  const lineCount = 2001;
  const lines = Array.from({ length: lineCount }, (_, i) => `ligne ${i}`);
  const original = lines.join("\n");
  const modifiedLines = [...lines];
  modifiedLines[1000] = "ligne 1000 MODIFIEE";
  const updated = modifiedLines.join("\n");

  const result = checkDiffFidelity({ filePath: "docs/big.md", fileExistedBefore: true, originalContent: original, updatedContent: updated });
  assert.equal(result.fidelityStatus, "PASS", `un fichier volumineux avec une seule ligne modifiée ne doit jamais être traité comme une réécriture totale (reason: ${result.reason})`);
  assert.equal(result.additions, 1);
  assert.equal(result.deletions, 1);
});

test("2 — diffLines : fichier volumineux avec lignes uniques complètement inversées → réorganisation massive détectée, jamais 100% conservé", () => {
  // Aucun préfixe/suffixe commun (la 1re et dernière ligne sont différentes une fois inversées) :
  // le "cœur" couvre tout le fichier et dépasse MAX_DIFF_CELLS, donc le repli patience-diff
  // s'applique. Toutes les lignes sont uniques et strictement identiques ensemble : une simple
  // intersection de multiset (l'ancien repli) donnerait à tort 0 addition/0 suppression.
  const n = 2200;
  const lines = Array.from({ length: n }, (_, i) => `ligne-unique-${i}`);
  const original = lines.join("\n");
  const updated = [...lines].reverse().join("\n");

  const result = diffLines(original, updated);
  // La séquence de positions vue en ordre inverse est strictement décroissante : la plus longue
  // sous-suite croissante ne peut excéder 1 élément, donc la quasi-totalité des lignes est
  // comptée comme changée — jamais "tout conservé".
  assert.ok(result.additions > n * 0.9, `additions trop faible (${result.additions}) : un fichier inversé ne doit jamais apparaître comme presque entièrement conservé`);
  assert.ok(result.deletions > n * 0.9, `deletions trop faible (${result.deletions})`);
});

test("2 bis — checkDiffFidelity : fichier volumineux entièrement inversé → DIFF_FIDELITY_FAILED (réécriture/réorganisation massive)", () => {
  const n = 2200;
  const lines = Array.from({ length: n }, (_, i) => `ligne-unique-${i}`);
  const original = lines.join("\n");
  const updated = [...lines].reverse().join("\n");

  const result = checkDiffFidelity({ filePath: "docs/reversed.md", fileExistedBefore: true, originalContent: original, updatedContent: updated });
  assert.equal(result.fidelityStatus, "FAIL", "une inversion quasi totale de l'ordre des lignes doit être détectée comme une réorganisation massive, pas laissée passer");
});

test("3 — diffLines : gros bloc déplacé (mêmes lignes, un bloc contigu relocalisé) → jamais compté comme 100% conservé", () => {
  const n = 2200;
  const blockSize = Math.floor(n / 2);
  const lines = Array.from({ length: n }, (_, i) => `ligne-unique-${i}`);
  const block = lines.slice(0, blockSize);
  const rest = lines.slice(blockSize);
  const original = lines.join("\n");
  // Le même bloc, désormais après `rest` au lieu d'avant.
  const updated = [...rest, ...block].join("\n");

  const result = diffLines(original, updated);
  // Ni 0 (les deux moitiés restent chacune dans leur ordre interne, donc une bonne partie
  // "s'aligne" via la LIS), ni 100% conservé (le déplacement d'un bloc de cette taille doit se
  // voir) : le nombre de lignes réellement additionnées/supprimées doit être une fraction
  // significative du fichier, jamais nul.
  assert.ok(result.additions > 0, "un déplacement de bloc de cette taille ne doit jamais ressortir comme un no-op");
  assert.ok(result.deletions > 0);
});

test("3 bis — checkDiffFidelity : gros bloc déplacé sur un très grand fichier → détecté, pas une conservation totale artificielle", () => {
  const n = 2200;
  const blockSize = Math.floor(n / 2);
  const lines = Array.from({ length: n }, (_, i) => `ligne-unique-${i}`);
  const block = lines.slice(0, blockSize);
  const rest = lines.slice(blockSize);
  const original = lines.join("\n");
  const updated = [...rest, ...block].join("\n");

  const result = checkDiffFidelity({ filePath: "docs/moved-block.md", fileExistedBefore: true, originalContent: original, updatedContent: updated });
  // Le déplacement d'un bloc de moitié du fichier ne doit jamais ressortir comme un diff vide.
  assert.ok(result.additions > 0 && result.deletions > 0, `le déplacement de bloc doit être visible dans le diff (additions=${result.additions}, deletions=${result.deletions})`);
});

test("4 — diffCore (via diffLines) : cœur réellement volumineux et sans rapport (pas de préfixe/suffixe commun) → réécriture massive détectée, jamais fabriquée par le repli", () => {
  // Cas pathologique où le préfixe/suffixe commun ne réduit rien (première et
  // dernière ligne déjà différentes) et où le "cœur" dépasse MAX_DIFF_CELLS :
  // vérifie que le repli (patience diff par ancres uniques + LIS) reste
  // cohérent — ici additions=n/deletions=n découlent bien du fait qu'aucune
  // ligne n'est partagée entre les deux côtés (aucune ancre trouvée), pas
  // d'une valeur fabriquée arbitrairement.
  const n = 2500;
  const original = Array.from({ length: n }, (_, i) => `orig-unique-line-${i}`).join("\n");
  const updated = Array.from({ length: n }, (_, i) => `completely-different-unique-line-${i}`).join("\n");
  const result = diffLines(original, updated);
  // Aucune ligne n'est partagée entre les deux côtés (contenus tous uniques et distincts) :
  // l'intersection de multiset est bien 0, donc additions=n, deletions=n ici — mais ce n'est
  // pas une valeur fabriquée arbitrairement, elle découle du contenu réellement disjoint.
  assert.equal(result.additions, n);
  assert.equal(result.deletions, n);
});
