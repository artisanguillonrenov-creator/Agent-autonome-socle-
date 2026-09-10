import { createReadStream } from "node:fs";
import * as unzipper from "unzipper";
import { WORKBENCH_LIMITS, workbenchError } from "./limits.js";

/**
 * Contrôle préflight anti zip-bomb du conteneur XLSX, AVANT qu'ExcelJS ne consomme le fichier.
 *
 * ExcelJS's `WorkbookReader` (`sharedStrings: "cache"` inclus) décompresse en interne via
 * `unzipper.Parse({ forceStream: true })`, un parseur ZIP *séquentiel* (lecture des Local File
 * Headers dans l'ordre du flux, sans jamais s'appuyer sur l'EOCD/Central Directory pour localiser
 * les entrées — c'est justement ce qui lui permet de fonctionner en flux).
 *
 * Une première version de ce garde réimplémentait sa propre lecture EOCD/Central Directory et ne
 * validait que les tailles *déclarées*. Deux failles en découlaient :
 *  1. Un second parseur ZIP écrit à la main peut structurellement diverger du parseur réel
 *     (EOCD falsifié dans le commentaire, totalEntries sous-déclaré, Central Directory
 *     incohérent avec les Local File Headers...) — la garde voit alors un fichier différent de
 *     celui qu'ExcelJS traitera réellement.
 *  2. Une taille déclarée reste une affirmation de l'attaquant, jamais une preuve du volume
 *     réellement produit par l'inflation.
 *
 * La correction : ne PAS réécrire un second parseur ZIP à faire concorder avec le premier — mais
 * réutiliser le MÊME parseur (`unzipper.Parse({ forceStream: true })`), avec les mêmes options que
 * `ExcelJS.stream.xlsx.WorkbookReader`, et décompresser réellement chaque entrée nous-mêmes en
 * comptant les octets effectivement produits, coupant immédiatement dès qu'une limite est
 * dépassée. Comme il s'agit littéralement du même parseur, il n'existe plus de fichier que la
 * garde et ExcelJS interpréteraient différemment.
 */

interface EntryState {
  totalUncompressed: number;
}

/**
 * ExcelJS's own internal `lib/utils/iterate-stream.js` — the exact function `WorkbookReader` uses
 * to drain this same `unzipper.Parse({ forceStream: true })` stream — calls `stream.pause()`
 * immediately before every `yield`. That pattern is the confirmed cause of
 * https://github.com/exceljs/exceljs/issues/3064: on Node ≥18 (worst on Node 22 — reproduced here
 * locally at roughly a 85-90% failure rate for a 5-sheet workbook), the pause/resume dance can let
 * the parser's internal engine advance past an entry — observably, `xl/workbook.xml` sometimes
 * never reaches `WorkbookReader._parseWorkbook`, so `this.model` stays `undefined` and any
 * worksheet access throws `Cannot read properties of undefined (reading 'sheets')`.
 *
 * This guard never called into that buggy function directly, but originally mirrored its
 * pause()-before-yield shape for the sake of literal parity with ExcelJS's own consumption
 * protocol (see the module doc comment above). Since that shape is the actual bug, faithfully
 * reproducing it was faithfully reproducing the race. Fixed here — and, since this project also
 * ships `patches/exceljs+4.4.0.patch` (applied deterministically on every `npm install` via
 * `postinstall`) rewriting ExcelJS's own `iterate-stream.js` the identical way — by never pausing
 * the source stream at all: a single permanent `'data'` listener drains every chunk straight into
 * a queue, and the generator only ever waits (never un-listens) when that queue is empty. There is
 * no window in which an emitted entry is not being captured.
 */
async function* iterateZipEntries(stream: unzipper.ParseStream): AsyncGenerator<unzipper.Entry> {
  const pending: unzipper.Entry[] = [];
  let ended = false;
  let streamError: Error | false = false;
  let notify: (() => void) | null = null;

  const wake = () => {
    if (notify) {
      const resolve = notify;
      notify = null;
      resolve();
    }
  };

  stream.on("data", (entry: unzipper.Entry) => {
    pending.push(entry);
    wake();
  });
  stream.on("end", () => {
    ended = true;
    wake();
  });
  stream.on("error", (err: Error) => {
    streamError = err;
    wake();
  });

  while (true) {
    while (pending.length > 0) {
      yield pending.shift()!;
    }
    if (streamError) throw streamError;
    if (ended) return;
    await new Promise<void>((resolve) => {
      notify = resolve;
    });
  }
}

/** Draine une entrée "Directory" (jamais de contenu réel à inflater) sans jamais en dépendre. */
function drainDirectoryEntry(entry: unzipper.Entry): Promise<void> {
  return new Promise((resolve, reject) => {
    const drain = entry.autodrain();
    drain.on("finish", resolve);
    drain.on("error", reject);
  });
}

const RATIO_MIN_SAMPLE_BYTES = 4096;

/**
 * Décompresse réellement une entrée en comptant chaque octet produit — jamais la taille déclarée
 * dans le Local File Header — et coupe immédiatement (destroy) dès qu'une limite réelle est
 * dépassée : taille par entrée, total cumulé, ou ratio décompressé/compressé (heuristique
 * d'arrêt anticipé, la taille réelle restant l'unique garantie contraignante).
 */
function consumeEntryBounded(entry: unzipper.Entry, state: EntryState): Promise<void> {
  const declaredCompressed = Math.max(entry.vars?.compressedSize ?? 0, 0);
  let entryBytes = 0;

  return new Promise((resolve, reject) => {
    let settled = false;
    const fail = (err: Error) => {
      if (settled) return;
      settled = true;
      entry.destroy(err);
      reject(err);
    };
    const succeed = () => {
      if (settled) return;
      settled = true;
      resolve();
    };

    entry.on("data", (chunk: Buffer) => {
      if (settled) return;
      entryBytes += chunk.length;
      state.totalUncompressed += chunk.length;
      if (entryBytes > WORKBENCH_LIMITS.SPREADSHEET_XLSX_MAX_ENTRY_UNCOMPRESSED_BYTES) {
        fail(workbenchError("SPREADSHEET_XLSX_EXPANSION_LIMIT"));
        return;
      }
      if (state.totalUncompressed > WORKBENCH_LIMITS.SPREADSHEET_XLSX_MAX_TOTAL_UNCOMPRESSED_BYTES) {
        fail(workbenchError("SPREADSHEET_XLSX_EXPANSION_LIMIT"));
        return;
      }
      if (
        declaredCompressed > 0 &&
        entryBytes > RATIO_MIN_SAMPLE_BYTES &&
        entryBytes / declaredCompressed > WORKBENCH_LIMITS.SPREADSHEET_XLSX_MAX_COMPRESSION_RATIO
      ) {
        fail(workbenchError("SPREADSHEET_XLSX_EXPANSION_LIMIT"));
      }
    });
    entry.on("end", succeed);
    entry.on("error", (err: Error) => fail(err instanceof Error ? err : new Error(String(err))));
  });
}

export async function assertXlsxDecompressionSafe(absolutePath: string): Promise<void> {
  const fileStream = createReadStream(absolutePath);
  const zip = unzipper.Parse({ forceStream: true });
  fileStream.on("error", (err) => zip.destroy(err));
  fileStream.pipe(zip);

  const state: EntryState = { totalUncompressed: 0 };
  try {
    for await (const entry of iterateZipEntries(zip)) {
      if (entry.type === "Directory") {
        await drainDirectoryEntry(entry);
        continue;
      }
      await consumeEntryBounded(entry, state);
    }
  } catch (err) {
    if (err instanceof Error && err.message === "SPREADSHEET_XLSX_EXPANSION_LIMIT") throw err;
    throw workbenchError("SPREADSHEET_XLSX_MALFORMED");
  } finally {
    fileStream.destroy();
    zip.destroy();
  }
}
