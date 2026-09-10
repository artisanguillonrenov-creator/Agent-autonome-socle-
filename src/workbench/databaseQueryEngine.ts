import Database from "better-sqlite3";
import { statSync } from "node:fs";
import { WorkspaceStore } from "../workspaces/workspaceStore.js";
import {
  DatabaseQueryResult,
  resolveWorkspacePath,
  TableColumnDescription,
  TableDescription,
  WORKBENCH_ERRORS
} from "./workbenchTypes.js";

export const DATABASE_LIMITS = {
  maxRows: 1000,
  timeoutMs: 5000
};

const FORBIDDEN_KEYWORDS = [
  "INSERT",
  "UPDATE",
  "DELETE",
  "DROP",
  "ALTER",
  "CREATE",
  "REPLACE",
  "ATTACH",
  "DETACH",
  "VACUUM",
  "REINDEX",
  "TRIGGER",
  "PRAGMA",
  "TRANSACTION",
  "BEGIN",
  "COMMIT",
  "ROLLBACK",
  "SAVEPOINT",
  "GRANT",
  "REVOKE",
  "WRITABLE_SCHEMA"
];

export class DatabaseQueryEngine {
  constructor(private workspaceStore: WorkspaceStore = new WorkspaceStore()) {}

  private validateQuery(sql: string): void {
    if (!sql || typeof sql !== "string") {
      throw new Error(WORKBENCH_ERRORS.DATABASE_QUERY_INVALID);
    }

    const cleaned = sql.trim();
    if (!cleaned) {
      throw new Error(WORKBENCH_ERRORS.DATABASE_QUERY_INVALID);
    }

    // Check for multiple SQL statements (semicolon in middle)
    const statements = cleaned
      .split(";")
      .map((s) => s.trim())
      .filter((s) => s.length > 0);

    if (statements.length > 1) {
      throw new Error(WORKBENCH_ERRORS.DATABASE_QUERY_NOT_READ_ONLY);
    }

    // Must start with SELECT or WITH (for CTE read-only queries)
    const upper = statements[0].toUpperCase();
    if (!upper.startsWith("SELECT") && !upper.startsWith("WITH")) {
      throw new Error(WORKBENCH_ERRORS.DATABASE_QUERY_NOT_READ_ONLY);
    }

    // Scan for forbidden mutation keywords as whole words
    for (const kw of FORBIDDEN_KEYWORDS) {
      const regex = new RegExp(`\\b${kw}\\b`, "i");
      if (regex.test(statements[0])) {
        throw new Error(WORKBENCH_ERRORS.DATABASE_QUERY_NOT_READ_ONLY);
      }
    }
  }

  private openDb(workspaceId: string, relativePath: string): { db: Database.Database; cleanRel: string } {
    const { relativePath: cleanRel, absolutePath } = resolveWorkspacePath(
      this.workspaceStore,
      workspaceId,
      relativePath
    );

    try {
      const stats = statSync(absolutePath);
      if (!stats.isFile()) {
        throw new Error(WORKBENCH_ERRORS.DATABASE_NOT_FOUND);
      }
    } catch {
      throw new Error(WORKBENCH_ERRORS.DATABASE_NOT_FOUND);
    }

    try {
      // Open connection strictly in read-only mode
      const db = new Database(absolutePath, { readonly: true, fileMustExist: true, timeout: DATABASE_LIMITS.timeoutMs });
      return { db, cleanRel };
    } catch {
      throw new Error(WORKBENCH_ERRORS.DATABASE_NOT_FOUND);
    }
  }

  listTables(workspaceId: string, relativePath: string): string[] {
    const { db } = this.openDb(workspaceId, relativePath);
    try {
      const rows = db
        .prepare("SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' ORDER BY name")
        .all() as { name: string }[];
      return rows.map((r) => r.name);
    } finally {
      db.close();
    }
  }

  describeTable(workspaceId: string, relativePath: string, tableName: string): TableDescription {
    if (!tableName || typeof tableName !== "string" || !/^[a-zA-Z0-9_]+$/.test(tableName)) {
      throw new Error(WORKBENCH_ERRORS.DATABASE_QUERY_INVALID);
    }

    const { db } = this.openDb(workspaceId, relativePath);
    try {
      const pragmaRows = db.prepare(`PRAGMA table_info("${tableName}")`).all() as any[];
      if (pragmaRows.length === 0) {
        throw new Error(WORKBENCH_ERRORS.DATABASE_QUERY_INVALID);
      }

      const columns: TableColumnDescription[] = pragmaRows.map((r) => ({
        name: r.name,
        type: r.type,
        notNull: r.notnull === 1,
        defaultValue: r.dflt_value,
        primaryKey: r.pk === 1
      }));

      const countRow = db.prepare(`SELECT COUNT(*) as count FROM "${tableName}"`).get() as { count: number };

      return {
        tableName,
        columns,
        rowCount: countRow ? countRow.count : 0
      };
    } finally {
      db.close();
    }
  }

  select(workspaceId: string, relativePath: string, sql: string): DatabaseQueryResult {
    this.validateQuery(sql);
    const { db, cleanRel } = this.openDb(workspaceId, relativePath);

    const startMs = Date.now();
    try {
      const stmt = db.prepare(sql);
      if (!stmt.reader) {
        throw new Error(WORKBENCH_ERRORS.DATABASE_QUERY_NOT_READ_ONLY);
      }

      const rows = stmt.all() as Record<string, unknown>[];
      const executionMs = Date.now() - startMs;

      let truncated = false;
      let finalRows = rows;

      if (rows.length > DATABASE_LIMITS.maxRows) {
        finalRows = rows.slice(0, DATABASE_LIMITS.maxRows);
        truncated = true;
      }

      const columns = finalRows.length > 0 ? Object.keys(finalRows[0]) : [];

      return {
        columns,
        rows: finalRows,
        rowCount: finalRows.length,
        truncated,
        executionMs,
        source: cleanRel
      };
    } catch (err: any) {
      if (Object.values(WORKBENCH_ERRORS).includes(err?.message)) {
        throw err;
      }
      throw new Error(WORKBENCH_ERRORS.DATABASE_QUERY_INVALID);
    } finally {
      db.close();
    }
  }
}
