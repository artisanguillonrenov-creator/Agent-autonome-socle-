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

    CREATE TABLE IF NOT EXISTS plan_runs (
      id TEXT PRIMARY KEY, root_node_id TEXT NOT NULL, objective TEXT NOT NULL,
      status TEXT NOT NULL, generation INTEGER NOT NULL DEFAULT 1,
      replan_count INTEGER NOT NULL DEFAULT 0, max_replans INTEGER NOT NULL DEFAULT 2,
      last_error TEXT, created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL
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

    CREATE TABLE IF NOT EXISTS notifications (
      id TEXT PRIMARY KEY, type TEXT NOT NULL, severity TEXT NOT NULL,
      title TEXT NOT NULL, message TEXT NOT NULL, task_id TEXT,
      operation_task_id TEXT, dedupe_key TEXT UNIQUE, created_at INTEGER NOT NULL,
      read_at INTEGER
    );

    CREATE TABLE IF NOT EXISTS workspaces (
      id TEXT PRIMARY KEY, name TEXT NOT NULL, owner_type TEXT NOT NULL,
      owner_id TEXT NOT NULL, status TEXT NOT NULL, created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL
    );
    CREATE UNIQUE INDEX IF NOT EXISTS idx_workspace_owner ON workspaces(owner_type, owner_id);
    CREATE TABLE IF NOT EXISTS artifacts (
      id TEXT PRIMARY KEY, workspace_id TEXT NOT NULL, plan_run_id TEXT,
      operation_task_id TEXT, kind TEXT NOT NULL, name TEXT NOT NULL, mime_type TEXT,
      relative_path TEXT, external_url TEXT, size_bytes INTEGER, sha256 TEXT,
      metadata_json TEXT, created_at INTEGER NOT NULL
    );
    CREATE TABLE IF NOT EXISTS activity_log (
      id TEXT PRIMARY KEY, dedupe_key TEXT UNIQUE, timestamp INTEGER NOT NULL, trace_id TEXT,
      plan_run_id TEXT, plan_node_id TEXT, operation_task_id TEXT, specialist_id TEXT,
      event_type TEXT NOT NULL, level TEXT NOT NULL, message TEXT NOT NULL, metadata_json TEXT
    );
    CREATE TABLE IF NOT EXISTS skill_preferences (
      skill_id TEXT PRIMARY KEY, enabled INTEGER NOT NULL CHECK(enabled IN (0,1)), updated_at INTEGER NOT NULL
    );
    CREATE TABLE IF NOT EXISTS workflows (
      id TEXT PRIMARY KEY, name TEXT NOT NULL UNIQUE, description TEXT NOT NULL, status TEXT NOT NULL,
      source TEXT NOT NULL, version INTEGER NOT NULL, input_schema_json TEXT NOT NULL,
      objective_template TEXT NOT NULL, steps_json TEXT NOT NULL, created_from_plan_run_id TEXT,
      created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL, last_success_at INTEGER, success_count INTEGER NOT NULL DEFAULT 0
    );
    CREATE TABLE IF NOT EXISTS workflow_executions (
      invocation_id TEXT PRIMARY KEY, workflow_id TEXT NOT NULL, workflow_version INTEGER NOT NULL,
      result_type TEXT NOT NULL CHECK(result_type IN ('PLAN_RUN','SCHEDULE')), result_id TEXT NOT NULL,
      input_json TEXT NOT NULL, created_at INTEGER NOT NULL, success_recorded_at INTEGER
    );

    CREATE TABLE IF NOT EXISTS app_settings (
      scope_type TEXT NOT NULL,
      scope_id TEXT NOT NULL,
      setting_key TEXT NOT NULL,
      value_json TEXT NOT NULL,
      updated_at INTEGER NOT NULL,
      PRIMARY KEY (scope_type, scope_id, setting_key)
    );

    CREATE TABLE IF NOT EXISTS settings_audit (
      id TEXT PRIMARY KEY,
      timestamp INTEGER NOT NULL,
      scope_type TEXT NOT NULL,
      scope_id TEXT NOT NULL,
      setting_key TEXT NOT NULL,
      old_value_json TEXT,
      new_value_json TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS service_connections (
      service_id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      user_created INTEGER NOT NULL DEFAULT 0,
      enabled_override INTEGER,
      transport_override TEXT,
      endpoint_override TEXT,
      health_path TEXT,
      task_path TEXT,
      auth_type_override TEXT,
      auth_env_var TEXT,
      priority_override INTEGER,
      request_timeout_ms INTEGER,
      health_timeout_ms INTEGER,
      capabilities_json TEXT,
      parallel_safe_capabilities_json TEXT,
      risk_by_capability_json TEXT,
      last_test_at INTEGER,
      last_success_at INTEGER,
      last_latency_ms INTEGER,
      last_error TEXT,
      updated_at INTEGER NOT NULL
    );
  `);

  // Additive replacement of the short-lived V1 workflow execution schema. The
  // relation remains authoritative while allowing schedule results as well as plans.
  const workflowExecutionColumns = new Set(
    (db.pragma("table_info(workflow_executions)") as Array<{ name:string }>).map(column=>column.name),
  );
  if(workflowExecutionColumns.has("plan_run_id")) db.transaction(()=>{
    db.exec("ALTER TABLE workflow_executions RENAME TO workflow_executions_legacy");
    db.exec(`CREATE TABLE workflow_executions (
      invocation_id TEXT PRIMARY KEY, workflow_id TEXT NOT NULL, workflow_version INTEGER NOT NULL,
      result_type TEXT NOT NULL CHECK(result_type IN ('PLAN_RUN','SCHEDULE')), result_id TEXT NOT NULL,
      input_json TEXT NOT NULL, created_at INTEGER NOT NULL, success_recorded_at INTEGER
    )`);
    db.exec(`INSERT INTO workflow_executions(invocation_id,workflow_id,workflow_version,result_type,result_id,input_json,created_at,success_recorded_at)
      SELECT invocation_id,workflow_id,workflow_version,'PLAN_RUN',plan_run_id,'{}',created_at,success_recorded_at FROM workflow_executions_legacy`);
    db.exec("DROP TABLE workflow_executions_legacy");
  })();

  const planNodeColumns = new Set(
    (db.pragma("table_info(plan_nodes)") as Array<{ name: string }>).map((column) => column.name),
  );
  const missingPlanNodeColumns: Record<string, string> = {
    plan_run_id: "TEXT", position: "INTEGER", generation: "INTEGER NOT NULL DEFAULT 0",
    capability: "TEXT", objective: "TEXT", context_json: "TEXT", constraints_json: "TEXT",
    priority: "TEXT", dependencies_json: "TEXT", operation_task_id: "TEXT",
    operation_idempotency_key: "TEXT", result: "TEXT", error: "TEXT", updated_at: "INTEGER",
    claimed_at: "INTEGER", attempt: "INTEGER NOT NULL DEFAULT 1",
    specialist_id: "TEXT",
  };
  for (const [column, definition] of Object.entries(missingPlanNodeColumns)) {
    if (!planNodeColumns.has(column)) db.exec(`ALTER TABLE plan_nodes ADD COLUMN ${column} ${definition}`);
  }
  db.exec(`CREATE UNIQUE INDEX IF NOT EXISTS idx_plan_node_position ON plan_nodes(plan_run_id,generation,position) WHERE plan_run_id IS NOT NULL`);

  const checkpointColumns = new Set(
    (db.pragma("table_info(checkpoints)") as Array<{ name: string }>).map((column) => column.name),
  );
  const missingCheckpointColumns: Record<string, string> = {
    kind: "TEXT NOT NULL DEFAULT 'AGENT_STATE'", scope_id: "TEXT", schema_version: "INTEGER NOT NULL DEFAULT 1",
  };
  for (const [column, definition] of Object.entries(missingCheckpointColumns)) {
    if (!checkpointColumns.has(column)) db.exec(`ALTER TABLE checkpoints ADD COLUMN ${column} ${definition}`);
  }

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
    execution_mode: "TEXT NOT NULL DEFAULT 'foreground'",
    dispatch_request_json: "TEXT",
    queued_at: "INTEGER",
    started_at: "INTEGER",
    finished_at: "INTEGER",
    cancel_requested_at: "INTEGER",
    schedule_task_id: "TEXT",
    watch_processed_at: "INTEGER",
    workspace_id: "TEXT",
    specialist_id: "TEXT", plan_run_id: "TEXT", plan_node_id: "TEXT",
    parallel_allowed: "INTEGER NOT NULL DEFAULT 0", retry_count: "INTEGER NOT NULL DEFAULT 0",
    transport_duration_ms: "INTEGER", model: "TEXT", input_tokens: "INTEGER", output_tokens: "INTEGER",
    total_tokens: "INTEGER", cost_usd: "REAL",
  };
  for (const [column, definition] of Object.entries(missingOperationColumns)) {
    if (!operationColumns.has(column)) {
      db.exec(`ALTER TABLE service_operations ADD COLUMN ${column} ${definition}`);
    }
  }

  const planRunColumns = new Set((db.pragma("table_info(plan_runs)") as Array<{name:string}>).map(c=>c.name));
  if (!planRunColumns.has("workspace_id")) db.exec("ALTER TABLE plan_runs ADD COLUMN workspace_id TEXT");
  const planRunAdditions:Record<string,string>={max_parallelism:"INTEGER NOT NULL DEFAULT 1",peak_parallelism:"INTEGER NOT NULL DEFAULT 0",pending_replan_node_id:"TEXT",consolidated_at:"INTEGER"};
  for(const [column,definition] of Object.entries(planRunAdditions))if(!planRunColumns.has(column))db.exec(`ALTER TABLE plan_runs ADD COLUMN ${column} ${definition}`);
  const artifactColumns=new Set((db.pragma("table_info(artifacts)") as Array<{name:string}>).map(c=>c.name));
  if(!artifactColumns.has("dedupe_key"))db.exec("ALTER TABLE artifacts ADD COLUMN dedupe_key TEXT");
  db.exec("CREATE UNIQUE INDEX IF NOT EXISTS idx_artifacts_dedupe ON artifacts(dedupe_key) WHERE dedupe_key IS NOT NULL");

  const taskColumns = new Set(
    (db.pragma("table_info(tasks)") as Array<{ name: string }>).map((column) => column.name),
  );
  const missingTaskColumns: Record<string, string> = {
    task_type: "TEXT NOT NULL DEFAULT 'REMINDER'", payload_json: "TEXT",
    enabled: "INTEGER NOT NULL DEFAULT 1", repeat_interval_ms: "INTEGER",
    last_run_at: "INTEGER", next_run_at: "INTEGER", last_result_hash: "TEXT",
    last_error: "TEXT", claimed_at: "INTEGER", claimed_occurrence_at: "INTEGER",
  };
  for (const [column, definition] of Object.entries(missingTaskColumns)) {
    if (!taskColumns.has(column)) db.exec(`ALTER TABLE tasks ADD COLUMN ${column} ${definition}`);
  }
  db.exec(`UPDATE tasks SET next_run_at = due_at WHERE next_run_at IS NULL AND due_at IS NOT NULL AND status = 'pending'`);

  sqliteInstance = db;
  return db;
}

export function closeDb(): void {
  sqliteInstance?.close();
  sqliteInstance = null;
  pgPoolInstance?.end();
  pgPoolInstance = null;
}
