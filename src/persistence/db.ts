import Database from "better-sqlite3";
import pg from "pg";
import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { config } from "../config.js";

let sqliteInstance: Database.Database | null = null;
let pgPoolInstance: pg.Pool | null = null;

export function getPgPool(): pg.Pool | null {
  const connectionString = process.env.DATABASE_URL;
  if (!connectionString) return null;

  if (!pgPoolInstance) {
    pgPoolInstance = new pg.Pool({
      connectionString,
      ssl: connectionString.includes("localhost") ? false : { rejectUnauthorized: false },
    });
  }
  return pgPoolInstance;
}

/** Base de données unique — SQLite local ou PostgreSQL managé (Render/Neon/Supabase). */
export function getDb(): Database.Database {
  if (sqliteInstance) return sqliteInstance;

  const path = config.db.path;
  if (path !== ":memory:") {
    mkdirSync(dirname(path), { recursive: true });
  }

  const db = new Database(path);
  db.pragma("journal_mode = WAL");
  db.exec(`
    CREATE TABLE IF NOT EXISTS memory_entries (
      id TEXT PRIMARY KEY,
      text TEXT NOT NULL,
      kind TEXT NOT NULL,
      created_at INTEGER NOT NULL,
      embedding TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS facts (
      entity TEXT NOT NULL,
      attribute TEXT NOT NULL,
      value TEXT NOT NULL,
      updated_at INTEGER NOT NULL,
      PRIMARY KEY (entity, attribute)
    );

    CREATE TABLE IF NOT EXISTS user_preferences (
      key TEXT PRIMARY KEY,
      value TEXT NOT NULL,
      updated_at INTEGER NOT NULL
    );

    CREATE TABLE IF NOT EXISTS plan_nodes (
      id TEXT PRIMARY KEY,
      parent_id TEXT,
      title TEXT NOT NULL,
      status TEXT NOT NULL,
      created_at INTEGER NOT NULL
    );

    CREATE TABLE IF NOT EXISTS checkpoints (
      id TEXT PRIMARY KEY,
      label TEXT NOT NULL,
      created_at INTEGER NOT NULL,
      state TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS tasks (
      id TEXT PRIMARY KEY,
      title TEXT NOT NULL,
      status TEXT NOT NULL,
      due_at INTEGER,
      created_at INTEGER NOT NULL
    );

    CREATE TABLE IF NOT EXISTS service_operations (
      task_id TEXT PRIMARY KEY,
      trace_id TEXT NOT NULL,
      idempotency_key TEXT NOT NULL,
      objective TEXT NOT NULL,
      capability TEXT NOT NULL,
      selected_service TEXT NOT NULL,
      status TEXT NOT NULL,
      result TEXT,
      error TEXT,
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL
    );

    CREATE TABLE IF NOT EXISTS processed_service_events (
      event_id TEXT PRIMARY KEY,
      task_id TEXT NOT NULL,
      sequence INTEGER NOT NULL,
      processed_at INTEGER NOT NULL
    );
  `);

  const processedEventColumns = new Set(
    (db.pragma("table_info(processed_service_events)") as Array<{ name: string }>).map((column) => column.name),
  );
  const missingProcessedEventColumns: Record<string, string> = {
    schema_version: "TEXT",
    trace_id: "TEXT",
    service: "TEXT",
    type: "TEXT",
    event_timestamp: "INTEGER",
    payload_json: "TEXT",
  };

  for (const [column, sqlType] of Object.entries(missingProcessedEventColumns)) {
    if (!processedEventColumns.has(column)) {
      db.exec(`ALTER TABLE processed_service_events ADD COLUMN ${column} ${sqlType}`);
    }
  }

  // Additive migration: existing operation data must never be recreated or dropped.
  const operationColumns = new Set(
    (db.pragma("table_info(service_operations)") as Array<{ name: string }>).map((column) => column.name),
  );
  const missingOperationColumns: Record<string, string> = {
    risk_level: "TEXT NOT NULL DEFAULT 'LOW'",
    approval_state: "TEXT NOT NULL DEFAULT 'NOT_REQUIRED'",
    approval_reason: "TEXT",
    approval_requested_at: "INTEGER",
    approval_decided_at: "INTEGER",
    pending_request_json: "TEXT",
  };
  for (const [column, definition] of Object.entries(missingOperationColumns)) {
    if (!operationColumns.has(column)) {
      db.exec(`ALTER TABLE service_operations ADD COLUMN ${column} ${definition}`);
    }
  }

  sqliteInstance = db;
  return db;
}

export function closeDb(): void {
  sqliteInstance?.close();
  sqliteInstance = null;
  pgPoolInstance?.end();
  pgPoolInstance = null;
}
