import crypto from "node:crypto";
import { getDb } from "../persistence/db.js";

export type VoiceIngressState = "RUNNING" | "DONE" | "RECOVERY_REQUIRED";

export interface VoiceIngressRecord {
  commandId: string;
  source: "VOICE";
  workspaceId?: string;
  requestHash: string;
  state: VoiceIngressState;
  responseJson?: string;
  createdAt: number;
  updatedAt: number;
}

export type BeginVoiceIngressResult =
  | { kind: "NEW"; record: VoiceIngressRecord }
  | { kind: "EXISTING"; record: VoiceIngressRecord }
  | { kind: "MISMATCH"; record: VoiceIngressRecord };

function mapRow(row: any): VoiceIngressRecord {
  return {
    commandId: row.command_id,
    source: row.source,
    workspaceId: row.workspace_id ?? undefined,
    requestHash: row.request_hash,
    state: row.state,
    responseJson: row.response_json ?? undefined,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

export function normalizeVoiceRequest(message: string, workspaceId?: string): { message: string; workspaceId: string | null } {
  const normalizedMessage = message.trim();
  const normalizedWorkspace = typeof workspaceId === "string" && workspaceId.trim().length > 0 ? workspaceId.trim() : null;
  return { message: normalizedMessage, workspaceId: normalizedWorkspace };
}

export function hashVoiceRequest(message: string, workspaceId?: string): string {
  const normalized = normalizeVoiceRequest(message, workspaceId);
  const canonical = JSON.stringify({ message: normalized.message, workspaceId: normalized.workspaceId });
  return crypto.createHash("sha256").update(canonical).digest("hex");
}

/**
 * Tiny persistent ingress registry. It is deliberately not a task/operation/plan store:
 * its only job is to guarantee at-most-once entry into Agent.step() for a client command.
 */
export class VoiceIngressStore {
  constructor() {
    getDb().exec(`
      CREATE TABLE IF NOT EXISTS agent_ingress_requests (
        command_id TEXT PRIMARY KEY,
        source TEXT NOT NULL CHECK(source IN ('VOICE')),
        workspace_id TEXT,
        request_hash TEXT NOT NULL,
        state TEXT NOT NULL CHECK(state IN ('RUNNING','DONE','RECOVERY_REQUIRED')),
        response_json TEXT,
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_agent_ingress_state_updated
        ON agent_ingress_requests(state, updated_at);
    `);
  }

  begin(commandId: string, requestHash: string, workspaceId?: string): BeginVoiceIngressResult {
    const db = getDb();
    const now = Date.now();
    const normalizedWorkspace = workspaceId?.trim() || null;
    const inserted = db.prepare(`
      INSERT OR IGNORE INTO agent_ingress_requests
        (command_id, source, workspace_id, request_hash, state, response_json, created_at, updated_at)
      VALUES (?, 'VOICE', ?, ?, 'RUNNING', NULL, ?, ?)
    `).run(commandId, normalizedWorkspace, requestHash, now, now);

    const row = db.prepare("SELECT * FROM agent_ingress_requests WHERE command_id=?").get(commandId);
    const record = mapRow(row);
    if (record.requestHash !== requestHash) return { kind: "MISMATCH", record };
    return inserted.changes === 1 ? { kind: "NEW", record } : { kind: "EXISTING", record };
  }

  get(commandId: string): VoiceIngressRecord | null {
    const row = getDb().prepare("SELECT * FROM agent_ingress_requests WHERE command_id=?").get(commandId);
    return row ? mapRow(row) : null;
  }

  complete(commandId: string, response: unknown): VoiceIngressRecord {
    const db = getDb();
    const serialized = JSON.stringify(response);
    const changed = db.prepare(`
      UPDATE agent_ingress_requests
      SET state='DONE', response_json=?, updated_at=?
      WHERE command_id=? AND state='RUNNING'
    `).run(serialized, Date.now(), commandId).changes;
    if (changed !== 1) throw new Error("VOICE_INGRESS_NOT_RUNNING");
    return this.get(commandId)!;
  }

  markRecoveryRequired(commandId: string, reason?: string): VoiceIngressRecord | null {
    const db = getDb();
    const existing = this.get(commandId);
    if (!existing) return null;
    const responseJson = reason ? JSON.stringify({ error: reason }) : existing.responseJson ?? null;
    db.prepare(`
      UPDATE agent_ingress_requests
      SET state='RECOVERY_REQUIRED', response_json=COALESCE(?, response_json), updated_at=?
      WHERE command_id=? AND state!='DONE'
    `).run(responseJson, Date.now(), commandId);
    return this.get(commandId);
  }

  /** Called exactly once at backend boot, before new HTTP requests are accepted. */
  markRunningAsRecoveryRequired(): number {
    return getDb().prepare(`
      UPDATE agent_ingress_requests
      SET state='RECOVERY_REQUIRED', updated_at=?
      WHERE state='RUNNING'
    `).run(Date.now()).changes;
  }

  cleanupDone(ttlMs: number, now = Date.now()): number {
    if (!Number.isFinite(ttlMs) || ttlMs <= 0) return 0;
    const cutoff = now - ttlMs;
    return getDb().prepare(`DELETE FROM agent_ingress_requests WHERE state='DONE' AND updated_at < ?`).run(cutoff).changes;
  }

  parseStoredResponse(record: VoiceIngressRecord): unknown | undefined {
    if (!record.responseJson) return undefined;
    try {
      return JSON.parse(record.responseJson);
    } catch {
      return undefined;
    }
  }
}
