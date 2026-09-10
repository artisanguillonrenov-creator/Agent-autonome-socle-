import { readFileSync } from "node:fs";
import { WORKBENCH_LIMITS, workbenchError } from "./limits.js";

const EOCD_SIGNATURE = 0x06054b50;
const CENTRAL_DIRECTORY_SIGNATURE = 0x02014b50;
const EOCD_MIN_SIZE = 22;
const CENTRAL_DIRECTORY_HEADER_SIZE = 46;
const MAX_ZIP_COMMENT_BYTES = 65535;
const ZIP64_SENTINEL_32 = 0xffffffff;
const ZIP64_SENTINEL_16 = 0xffff;

function findEndOfCentralDirectory(buf: Buffer): number {
  if (buf.length < EOCD_MIN_SIZE) throw workbenchError("SPREADSHEET_XLSX_MALFORMED");
  const searchStart = Math.max(0, buf.length - EOCD_MIN_SIZE - MAX_ZIP_COMMENT_BYTES);
  for (let i = buf.length - EOCD_MIN_SIZE; i >= searchStart; i--) {
    if (buf.readUInt32LE(i) === EOCD_SIGNATURE) return i;
  }
  throw workbenchError("SPREADSHEET_XLSX_MALFORMED");
}

/**
 * Contrôle préflight du conteneur ZIP d'un .xlsx, AVANT toute ouverture par
 * `ExcelJS.stream.xlsx.WorkbookReader` — donc avant toute décompression, y
 * compris de `xl/sharedStrings.xml` (mis en cache intégral en mémoire par
 * l'option `sharedStrings: "cache"`).
 *
 * Lit uniquement les métadonnées du répertoire central (tailles compressée
 * et décompressée déclarées par entrée) sans jamais inflater quoi que ce
 * soit, et rejette le fichier si :
 *  - une entrée déclare une taille décompressée individuellement excessive ;
 *  - la somme des tailles décompressées déclarées dépasse la limite globale ;
 *  - le ratio décompressé/compressé d'une entrée dépasse le seuil autorisé.
 *
 * Toute utilisation d'un champ ZIP64 (sentinelle 0xFFFF/0xFFFFFFFF) est
 * traitée comme suspecte et rejetée : un .xlsx légitime sous
 * INPUT_FILE_MAX_BYTES n'a jamais besoin de ZIP64.
 */
export function assertXlsxDecompressionSafe(absolutePath: string): void {
  const buf = readFileSync(absolutePath);
  const eocdOffset = findEndOfCentralDirectory(buf);

  const totalEntries = buf.readUInt16LE(eocdOffset + 10);
  const centralDirectorySize = buf.readUInt32LE(eocdOffset + 12);
  const centralDirectoryOffset = buf.readUInt32LE(eocdOffset + 16);
  if (
    totalEntries === ZIP64_SENTINEL_16 ||
    centralDirectorySize === ZIP64_SENTINEL_32 ||
    centralDirectoryOffset === ZIP64_SENTINEL_32
  ) {
    throw workbenchError("SPREADSHEET_XLSX_EXPANSION_LIMIT");
  }
  if (centralDirectoryOffset + centralDirectorySize > buf.length) throw workbenchError("SPREADSHEET_XLSX_MALFORMED");

  let pos = centralDirectoryOffset;
  let totalUncompressed = 0;
  for (let i = 0; i < totalEntries; i++) {
    if (pos + CENTRAL_DIRECTORY_HEADER_SIZE > buf.length || buf.readUInt32LE(pos) !== CENTRAL_DIRECTORY_SIGNATURE) {
      throw workbenchError("SPREADSHEET_XLSX_MALFORMED");
    }
    const compressedSize = buf.readUInt32LE(pos + 20);
    const uncompressedSize = buf.readUInt32LE(pos + 24);
    const nameLength = buf.readUInt16LE(pos + 28);
    const extraLength = buf.readUInt16LE(pos + 30);
    const commentLength = buf.readUInt16LE(pos + 32);

    if (compressedSize === ZIP64_SENTINEL_32 || uncompressedSize === ZIP64_SENTINEL_32) {
      throw workbenchError("SPREADSHEET_XLSX_EXPANSION_LIMIT");
    }
    if (uncompressedSize > WORKBENCH_LIMITS.SPREADSHEET_XLSX_MAX_ENTRY_UNCOMPRESSED_BYTES) {
      throw workbenchError("SPREADSHEET_XLSX_EXPANSION_LIMIT");
    }
    // Le ratio n'est évalué qu'au-delà d'un plancher : un minuscule fichier stocké peut
    // légitimement avoir un ratio élevé (ex: XML vide) sans être un zip-bomb.
    if (uncompressedSize > 1024 && uncompressedSize / Math.max(compressedSize, 1) > WORKBENCH_LIMITS.SPREADSHEET_XLSX_MAX_COMPRESSION_RATIO) {
      throw workbenchError("SPREADSHEET_XLSX_EXPANSION_LIMIT");
    }

    totalUncompressed += uncompressedSize;
    if (totalUncompressed > WORKBENCH_LIMITS.SPREADSHEET_XLSX_MAX_TOTAL_UNCOMPRESSED_BYTES) {
      throw workbenchError("SPREADSHEET_XLSX_EXPANSION_LIMIT");
    }

    pos += CENTRAL_DIRECTORY_HEADER_SIZE + nameLength + extraLength + commentLength;
  }
}
