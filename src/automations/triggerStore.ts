import { randomUUID } from "node:crypto";
import { getDb } from "../persistence/db.js";

export type TriggerSource = "EMAIL" | "CRM" | "EXTERNAL";

export interface TriggerEventRecord {
  id: string;
  source: TriggerSource;
  externalId: string;
  receivedAt: number;
  payload: unknown;
  workspaceId?: string;
  capability?: string;
  objective?: string;
  operationTaskId?: string;
  status: string;
}

function toRecord(r: any): TriggerEventRecord {
  let payload: unknown = null;
  try {
    payload = JSON.parse(r.payload_json);
  } catch {
    payload = r.payload_json;
  }
  return {
    id: r.id,
    source: r.source,
    externalId: r.external_id,
    receivedAt: r.received_at,
    payload,
    workspaceId: r.workspace_id ?? undefined,
    capability: r.capability ?? undefined,
    objective: r.objective ?? undefined,
    operationTaskId: r.operation_task_id ?? undefined,
    status: r.status,
  };
}

/**
 * Idempotence des trois familles de triggers (email/CRM/externe) via une contrainte
 * UNIQUE(source, external_id) : `claim()` est une réclamation atomique (INSERT OR IGNORE,
 * synchrone, sans `await` intermédiaire) — deux livraisons concurrentes du même événement
 * ne peuvent jamais déclencher deux missions, même sous retry/redémarrage.
 */
export class TriggerStore {
  claim(source: TriggerSource, externalId: string, payload: unknown, workspaceId?: string): { claimed: boolean; record: TriggerEventRecord } {
    const id = randomUUID();
    const res = getDb()
      .prepare(`INSERT OR IGNORE INTO trigger_events (id, source, external_id, received_at, payload_json, workspace_id, status) VALUES (?,?,?,?,?,?,?)`)
      .run(id, source, externalId, Date.now(), JSON.stringify(payload), workspaceId ?? null, "ACCEPTED");
    return { claimed: res.changes === 1, record: this.get(source, externalId)! };
  }

  attach(source: TriggerSource, externalId: string, fields: { operationTaskId?: string; capability?: string; objective?: string; status?: string }): void {
    getDb()
      .prepare(
        `UPDATE trigger_events SET operation_task_id=COALESCE(?,operation_task_id), capability=COALESCE(?,capability),
         objective=COALESCE(?,objective), status=COALESCE(?,status) WHERE source=? AND external_id=?`,
      )
      .run(fields.operationTaskId ?? null, fields.capability ?? null, fields.objective ?? null, fields.status ?? null, source, externalId);
  }

  get(source: TriggerSource, externalId: string): TriggerEventRecord | null {
    const row = getDb().prepare("SELECT * FROM trigger_events WHERE source=? AND external_id=?").get(source, externalId);
    return row ? toRecord(row) : null;
  }

  list(source?: TriggerSource, limit = 100): TriggerEventRecord[] {
    const rows = source
      ? getDb().prepare("SELECT * FROM trigger_events WHERE source=? ORDER BY received_at DESC LIMIT ?").all(source, limit)
      : getDb().prepare("SELECT * FROM trigger_events ORDER BY received_at DESC LIMIT ?").all(limit);
    return (rows as any[]).map(toRecord);
  }
}
