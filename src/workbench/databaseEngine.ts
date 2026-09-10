import Database from "better-sqlite3";
import type { WorkspaceStore } from "../workspaces/workspaceStore.js";
import { WORKBENCH_LIMITS, workbenchError } from "./limits.js";

const FORBIDDEN_KEYWORDS =
  /\b(INSERT|UPDATE|DELETE|DROP|ALTER|CREATE|REPLACE|VACUUM|ATTACH|DETACH|REINDEX|PRAGMA|TRIGGER|BEGIN|COMMIT|ROLLBACK)\b/i;
const ALLOWED_START = /^(SELECT|WITH)\b/i;

/**
 * Retire les littéraux de chaîne ('...', '' échappé), les identifiants entre guillemets
 * ("...", ainsi que les crochets [...] et backticks `...`) et les commentaires (--, /* *\/)
 * avant l'analyse par mots-clés, pour ne jamais rejeter une requête de lecture légitime au seul
 * motif qu'un mot interdit apparaît dans une chaîne ou un commentaire (ex: SELECT 'UPDATE' AS x).
 */
function stripSqlNoise(sql: string): string {
  let out = "";
  let i = 0;
  const n = sql.length;
  while (i < n) {
    const ch = sql[i];
    if (ch === "'" || ch === '"' || ch === "`") {
      const quote = ch;
      i++;
      while (i < n) {
        if (sql[i] === quote && sql[i + 1] === quote) {
          i += 2;
          continue;
        }
        if (sql[i] === quote) {
          i++;
          break;
        }
        i++;
      }
      continue;
    }
    if (ch === "[") {
      i++;
      while (i < n && sql[i] !== "]") i++;
      i++;
      continue;
    }
    if (ch === "-" && sql[i + 1] === "-") {
      while (i < n && sql[i] !== "\n") i++;
      continue;
    }
    if (ch === "/" && sql[i + 1] === "*") {
      i += 2;
      while (i < n && !(sql[i] === "*" && sql[i + 1] === "/")) i++;
      i += 2;
      continue;
    }
    out += ch;
    i++;
  }
  return out;
}

/**
 * Rejet précoce (avant prepare) sur la forme textuelle de la requête ; complété
 * après `prepare` par la vérification `reader`/`readonly` réellement exposée
 * par better-sqlite3 — ne jamais se fier au seul premier mot du SQL.
 */
function assertReadOnlyQueryText(sql: string): void {
  const trimmed = sql.trim();
  if (!trimmed) throw workbenchError("DATABASE_QUERY_EMPTY");
  if (!ALLOWED_START.test(trimmed)) throw workbenchError("DATABASE_WRITE_QUERY_FORBIDDEN");
  if (FORBIDDEN_KEYWORDS.test(stripSqlNoise(trimmed))) throw workbenchError("DATABASE_WRITE_QUERY_FORBIDDEN");
}

/**
 * better-sqlite3 renvoie par défaut des `number` pour les entiers SQLite, silencieusement
 * arrondis au-delà de Number.MAX_SAFE_INTEGER. On active `safeIntegers` sur le statement puis on
 * ne convertit en BigInt->string (préservant la valeur exacte) que lorsque c'est réellement hors
 * de portée d'un double ; sinon on renvoie un `number` JSON ordinaire.
 */
function normalizeSqliteValue(value: unknown): unknown {
  if (typeof value !== "bigint") return value;
  return value >= BigInt(Number.MIN_SAFE_INTEGER) && value <= BigInt(Number.MAX_SAFE_INTEGER) ? Number(value) : value.toString();
}

export interface DatabaseQueryResult {
  columns: string[];
  rows: Record<string, unknown>[];
  rowCountReturned: number;
  truncated: boolean;
  warnings: string[];
}

export function runDatabaseQuery(workspaces: WorkspaceStore, workspaceId: string, path: string, sql: string): DatabaseQueryResult {
  if (typeof sql !== "string") throw workbenchError("DATABASE_QUERY_EMPTY");
  assertReadOnlyQueryText(sql);

  const { absolutePath, size } = workspaces.resolveExistingFile(workspaceId, path);
  if (size > WORKBENCH_LIMITS.INPUT_FILE_MAX_BYTES) throw workbenchError("DATABASE_FILE_TOO_LARGE");

  const db = new Database(absolutePath, { readonly: true, fileMustExist: true });
  try {
    try {
      db.pragma("query_only = ON");
    } catch {
      /* certains environnements SQLite ignorent ce pragma en lecture seule : sans conséquence, readonly:true protège déjà */
    }

    let stmt;
    try {
      stmt = db.prepare(sql);
    } catch {
      throw workbenchError("DATABASE_QUERY_INVALID");
    }
    if (stmt.reader === false || stmt.readonly === false) throw workbenchError("DATABASE_WRITE_QUERY_FORBIDDEN");
    stmt.safeIntegers(true);

    const columns = stmt.columns().map((c) => c.name);
    const rows: Record<string, unknown>[] = [];
    let truncated = false;
    for (const row of stmt.iterate() as IterableIterator<Record<string, unknown>>) {
      if (rows.length >= WORKBENCH_LIMITS.DATABASE_MAX_RESULT_ROWS) {
        truncated = true;
        break;
      }
      rows.push(Object.fromEntries(Object.entries(row).map(([key, value]) => [key, normalizeSqliteValue(value)])));
    }
    return { columns, rows, rowCountReturned: rows.length, truncated, warnings: [] };
  } finally {
    db.close();
  }
}
