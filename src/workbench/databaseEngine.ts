import Database from "better-sqlite3";
import type { WorkspaceStore } from "../workspaces/workspaceStore.js";
import { WORKBENCH_LIMITS, workbenchError } from "./limits.js";

const FORBIDDEN_KEYWORDS =
  /\b(INSERT|UPDATE|DELETE|DROP|ALTER|CREATE|REPLACE|VACUUM|ATTACH|DETACH|REINDEX|PRAGMA|TRIGGER|BEGIN|COMMIT|ROLLBACK)\b/i;
const ALLOWED_START = /^(SELECT|WITH)\b/i;

/**
 * Rejet précoce (avant prepare) sur la forme textuelle de la requête ; complété
 * après `prepare` par la vérification `reader`/`readonly` réellement exposée
 * par better-sqlite3 — ne jamais se fier au seul premier mot du SQL.
 */
function assertReadOnlyQueryText(sql: string): void {
  const trimmed = sql.trim();
  if (!trimmed) throw workbenchError("DATABASE_QUERY_EMPTY");
  if (!ALLOWED_START.test(trimmed)) throw workbenchError("DATABASE_WRITE_QUERY_FORBIDDEN");
  if (FORBIDDEN_KEYWORDS.test(trimmed)) throw workbenchError("DATABASE_WRITE_QUERY_FORBIDDEN");
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

    const columns = stmt.columns().map((c) => c.name);
    const rows: Record<string, unknown>[] = [];
    let truncated = false;
    for (const row of stmt.iterate() as IterableIterator<Record<string, unknown>>) {
      if (rows.length >= WORKBENCH_LIMITS.DATABASE_MAX_RESULT_ROWS) {
        truncated = true;
        break;
      }
      rows.push(row);
    }
    return { columns, rows, rowCountReturned: rows.length, truncated, warnings: [] };
  } finally {
    db.close();
  }
}
