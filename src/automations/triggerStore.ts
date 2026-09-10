import { randomUUID } from "node:crypto";
import { getDb } from "../persistence/db.js";
import { bureauScope } from "../services/bureauScope.js";

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

/**
 * Le statut stocké n'est que l'instantané au moment du dispatch (QUEUED/WAITING_PERMISSION/
 * REJECTED) — un dispatch en arrière-plan continue ensuite d'évoluer dans
 * service_operations sans jamais revenir mettre à jour trigger_events. Plutôt que de coupler
 * ce store à ServiceOrchestrator pour pousser chaque transition, on résout le statut courant
 * à la lecture directement depuis service_operations quand un operation_task_id existe.
 */
function liveStatus(operationTaskId: string | null, fallback: string): string {
  if (!operationTaskId) return fallback;
  const row = getDb().prepare("SELECT status FROM service_operations WHERE task_id=?").get(operationTaskId) as { status: string } | undefined;
  return row?.status ?? fallback;
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
    status: liveStatus(r.operation_task_id ?? null, r.status),
  };
}

/**
 * Idempotence des trois familles de triggers (email/CRM/externe) via une contrainte
 * UNIQUE(source, workspace_id, external_id) : `claim()` est une réclamation atomique
 * (INSERT OR IGNORE, synchrone, sans `await` intermédiaire) — deux livraisons concurrentes
 * du même événement ne peuvent jamais déclencher deux missions, même sous retry/redémarrage.
 * workspace_id est toujours normalisé (bureauScope) : deux workspaces distincts peuvent
 * réutiliser le même external_id sans jamais se confondre ni se voir mutuellement.
 */
export class TriggerStore {
  claim(source: TriggerSource, externalId: string, payload: unknown, workspaceId?: string): { claimed: boolean; record: TriggerEventRecord } {
    const scope = bureauScope(workspaceId);
    const id = randomUUID();
    const res = getDb()
      .prepare(`INSERT OR IGNORE INTO trigger_events (id, source, external_id, received_at, payload_json, workspace_id, status) VALUES (?,?,?,?,?,?,?)`)
      .run(id, source, externalId, Date.now(), JSON.stringify(payload), scope, "ACCEPTED");
    return { claimed: res.changes === 1, record: this.get(source, externalId, workspaceId)! };
  }

  /**
   * Relâche une réclamation qui n'a jamais réellement été prise en charge (ex. capacité
   * désactivée -> dispatchCapability REJECTED) : sans cela, un événement rejeté pour une
   * raison de configuration resterait bloqué pour toujours, même après correction.
   */
  release(source: TriggerSource, externalId: string, workspaceId?: string): void {
    getDb().prepare("DELETE FROM trigger_events WHERE source=? AND workspace_id=? AND external_id=?").run(source, bureauScope(workspaceId), externalId);
  }

  attach(
    source: TriggerSource,
    externalId: string,
    workspaceId: string | undefined,
    fields: { operationTaskId?: string; capability?: string; objective?: string; status?: string },
  ): void {
    getDb()
      .prepare(
        `UPDATE trigger_events SET operation_task_id=COALESCE(?,operation_task_id), capability=COALESCE(?,capability),
         objective=COALESCE(?,objective), status=COALESCE(?,status) WHERE source=? AND workspace_id=? AND external_id=?`,
      )
      .run(fields.operationTaskId ?? null, fields.capability ?? null, fields.objective ?? null, fields.status ?? null, source, bureauScope(workspaceId), externalId);
  }

  get(source: TriggerSource, externalId: string, workspaceId?: string): TriggerEventRecord | null {
    const row = getDb().prepare("SELECT * FROM trigger_events WHERE source=? AND workspace_id=? AND external_id=?").get(source, bureauScope(workspaceId), externalId);
    return row ? toRecord(row) : null;
  }

  list(source?: TriggerSource, limit = 100): TriggerEventRecord[] {
    const rows = source
      ? getDb().prepare("SELECT * FROM trigger_events WHERE source=? ORDER BY received_at DESC LIMIT ?").all(source, limit)
      : getDb().prepare("SELECT * FROM trigger_events ORDER BY received_at DESC LIMIT ?").all(limit);
    return (rows as any[]).map(toRecord);
  }
}
