import { getDb } from "../persistence/db.js";
import type { ApprovalState, ExecutionMode, OperationStatus, RiskLevel, ServiceEvent, TaskRequest } from "./contract.js";

export interface ServiceOperation {
  taskId: string;
  traceId: string;
  idempotencyKey: string;
  objective: string;
  capability: string;
  selectedService: string;
  status: OperationStatus;
  result?: string;
  error?: string;
  retryable?: boolean;
  riskLevel: RiskLevel;
  approvalState: ApprovalState;
  approvalReason?: string;
  approvalRequestedAt?: number;
  approvalDecidedAt?: number;
  executionMode: ExecutionMode;
  queuedAt?: number;
  startedAt?: number;
  finishedAt?: number;
  cancelRequestedAt?: number;
  scheduleTaskId?: string;
  workspaceId?: string;
  createdAt: number;
  updatedAt: number;
}

const ALLOWED_TRANSITIONS: Record<OperationStatus, OperationStatus[]> = {
  QUEUED: ["DISPATCHING", "RUNNING", "FAILED", "REJECTED", "CANCELLED"],
  DISPATCHING: ["RUNNING", "COMPLETED", "FAILED", "REJECTED"],
  RUNNING: ["WAITING_INPUT", "WAITING_PERMISSION", "COMPLETED", "FAILED", "REJECTED"],
  WAITING_INPUT: ["RUNNING", "FAILED", "REJECTED"],
  WAITING_PERMISSION: ["QUEUED", "DISPATCHING", "REJECTED", "FAILED", "CANCELLED"],
  COMPLETED: [], // Terminal
  REJECTED: [], // Terminal
  FAILED: ["RUNNING", "DISPATCHING"], // Terminal unless retryable
  CANCELLED: [],
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function validatePendingTaskRequest(
  value: unknown,
  expected: Pick<ServiceOperation, "taskId" | "traceId" | "idempotencyKey" | "capability">,
): TaskRequest | null {
  if (!isRecord(value)) return null;
  if (typeof value.schema_version !== "string" || value.schema_version.length === 0) return null;
  if (value.task_id !== expected.taskId) return null;
  if (typeof value.trace_id !== "string" || value.trace_id.length === 0 || value.trace_id !== expected.traceId) return null;
  if (
    typeof value.idempotency_key !== "string" ||
    value.idempotency_key.length === 0 ||
    value.idempotency_key !== expected.idempotencyKey
  ) return null;
  if (typeof value.capability !== "string" || value.capability.length === 0 || value.capability !== expected.capability) return null;
  if (typeof value.objective !== "string") return null;
  if (!isRecord(value.context)) return null;
  if (!Array.isArray(value.constraints)) return null;
  if (typeof value.priority !== "string") return null;
  if (!Array.isArray(value.permissions)) return null;
  return value as unknown as TaskRequest;
}

export class OperationStore {
  validateEvent(event: unknown, expectedTaskId?: string): { valid: true; event: ServiceEvent } | { valid: false; duplicate: boolean; reason: string } {
    if (!isRecord(event)) return { valid: false, duplicate: false, reason: "EVENT_NOT_OBJECT" };
    const types = new Set(["TASK_ACCEPTED", "TASK_REJECTED", "TASK_PROGRESS", "NEEDS_INPUT", "NEEDS_PERMISSION", "TASK_COMPLETED", "TASK_FAILED"]);
    if (typeof event.schema_version !== "string" || !event.schema_version.trim() ||
      typeof event.event_id !== "string" || !event.event_id.trim() ||
      typeof event.task_id !== "string" || !event.task_id.trim() ||
      (expectedTaskId !== undefined && event.task_id !== expectedTaskId) ||
      typeof event.trace_id !== "string" || !event.trace_id.trim() ||
      typeof event.service !== "string" || !event.service.trim() ||
      !Number.isSafeInteger(event.sequence) || (event.sequence as number) <= 0 ||
      typeof event.type !== "string" || !types.has(event.type) ||
      !Number.isFinite(event.timestamp) || (event.timestamp as number) < 0 ||
      !isRecord(event.payload)) return { valid: false, duplicate: false, reason: "INVALID_SERVICE_EVENT" };
    const candidate = event as unknown as ServiceEvent;
    if (getDb().prepare("SELECT 1 FROM processed_service_events WHERE event_id=?").get(candidate.event_id)) return { valid: false, duplicate: true, reason: "DUPLICATE_EVENT" };
    const operation = this.getOperation(candidate.task_id);
    if (!operation || operation.traceId !== candidate.trace_id) return { valid: false, duplicate: false, reason: "EVENT_OPERATION_MISMATCH" };
    const serviceMatches = operation.selectedService === "none" || operation.selectedService === candidate.service || (operation.selectedService.includes("factory") && candidate.service.includes("factory"));
    if (!serviceMatches) return { valid: false, duplicate: false, reason: "EVENT_SERVICE_MISMATCH" };
    const last = getDb().prepare("SELECT MAX(sequence) max_sequence FROM processed_service_events WHERE task_id=?").get(candidate.task_id) as {max_sequence:number|null};
    if (candidate.sequence <= (last?.max_sequence ?? 0)) return { valid: false, duplicate: false, reason: "EVENT_SEQUENCE_INVALID" };
    return { valid: true, event: candidate };
  }
  createOperation(op: Omit<ServiceOperation, "createdAt" | "updatedAt" | "riskLevel" | "approvalState" | "executionMode"> &
    Partial<Pick<ServiceOperation, "riskLevel" | "approvalState" | "executionMode">>): ServiceOperation {
    const db = getDb();
    const now = Date.now();
    const fullOp: ServiceOperation = {
      ...op,
      retryable: op.retryable ?? false,
      riskLevel: op.riskLevel ?? "LOW",
      approvalState: op.approvalState ?? "NOT_REQUIRED",
      executionMode: op.executionMode ?? "foreground",
      createdAt: now,
      updatedAt: now,
    };

    db.prepare(`
      INSERT INTO service_operations (
        task_id, trace_id, idempotency_key, objective, capability, selected_service, status, result, error,
        risk_level, approval_state, approval_reason, approval_requested_at, pending_request_json,
        execution_mode, dispatch_request_json, queued_at, schedule_task_id, workspace_id, created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      fullOp.taskId,
      fullOp.traceId,
      fullOp.idempotencyKey,
      fullOp.objective,
      fullOp.capability,
      fullOp.selectedService,
      fullOp.status,
      fullOp.result ?? null,
      fullOp.error ?? null,
      fullOp.riskLevel,
      fullOp.approvalState,
      fullOp.approvalReason ?? null,
      fullOp.approvalRequestedAt ?? null,
      null,
      fullOp.executionMode,
      null,
      fullOp.queuedAt ?? null,
      fullOp.scheduleTaskId ?? null,
      fullOp.workspaceId ?? null,
      fullOp.createdAt,
      fullOp.updatedAt,
    );

    return fullOp;
  }

  setDispatchRequest(taskId: string, request: TaskRequest, queued: boolean): boolean {
    const now = Date.now();
    return getDb().prepare(`UPDATE service_operations SET dispatch_request_json=?, queued_at=CASE WHEN ? THEN ? ELSE queued_at END, updated_at=? WHERE task_id=?`)
      .run(JSON.stringify(request), queued ? 1 : 0, now, now, taskId).changes === 1;
  }

  claimNextBackground(): { operation: ServiceOperation; request: TaskRequest | null } | null {
    const db = getDb();
    return db.transaction(() => {
      const row = db.prepare(`SELECT task_id,dispatch_request_json FROM service_operations WHERE execution_mode='background' AND status='QUEUED' ORDER BY queued_at,created_at LIMIT 1`).get() as any;
      if (!row) return null;
      const op = this.getOperation(row.task_id); if (!op) return null;
      let parsed: unknown; try { parsed = JSON.parse(row.dispatch_request_json); } catch { parsed = null; }
      const request = validatePendingTaskRequest(parsed, op); if (!request) {
        const now=Date.now(); const changed=db.prepare(`UPDATE service_operations SET status='FAILED',error='INVALID_DISPATCH_REQUEST',finished_at=?,updated_at=? WHERE task_id=? AND status='QUEUED'`).run(now,now,op.taskId).changes;
        return changed === 1 ? { operation: this.getOperation(op.taskId)!, request: null } : null;
      }
      const now=Date.now(); const changed=db.prepare(`UPDATE service_operations SET status='DISPATCHING',started_at=?,updated_at=? WHERE task_id=? AND status='QUEUED'`).run(now,now,op.taskId).changes;
      return changed === 1 ? { operation: { ...op, status: "DISPATCHING" as const, startedAt: now }, request } : null;
    })();
  }

  approveBackground(taskId: string): boolean {
    const now=Date.now(); return getDb().prepare(`UPDATE service_operations SET approval_state='APPROVED',approval_decided_at=?,status='QUEUED',queued_at=?,dispatch_request_json=pending_request_json,updated_at=? WHERE task_id=? AND status='WAITING_PERMISSION' AND approval_state='PENDING' AND execution_mode='background'`).run(now,now,now,taskId).changes===1;
  }

  cancel(taskId: string): { cancelled: boolean; requested: boolean; operation: ServiceOperation } | null {
    const op=this.getOperation(taskId); if(!op)return null; const now=Date.now();
    if(op.status==="QUEUED"||op.status==="WAITING_PERMISSION") getDb().prepare(`UPDATE service_operations SET status='CANCELLED',cancel_requested_at=?,finished_at=?,updated_at=? WHERE task_id=? AND status=?`).run(now,now,now,taskId,op.status);
    else if(op.status==="DISPATCHING"||op.status==="RUNNING") getDb().prepare(`UPDATE service_operations SET cancel_requested_at=?,updated_at=? WHERE task_id=?`).run(now,now,taskId);
    const updated=this.getOperation(taskId)!; return {cancelled:updated.status==="CANCELLED",requested:updated.cancelRequestedAt!==undefined,operation:updated};
  }

  recoverInterrupted(): ServiceOperation[] {
    const db=getDb(); const rows=db.prepare(`SELECT task_id FROM service_operations WHERE execution_mode='background' AND status IN ('DISPATCHING','RUNNING')`).all() as Array<{task_id:string}>; const now=Date.now();
    for(const row of rows) db.prepare(`UPDATE service_operations SET status='FAILED',error='INTERRUPTED_EXECUTION_STATE_UNKNOWN',finished_at=?,updated_at=? WHERE task_id=?`).run(now,now,row.task_id);
    return rows.map(r=>this.getOperation(r.task_id)!).filter(Boolean);
  }

  updateStatus(taskId: string, status: OperationStatus, result?: string, error?: string, retryable?: boolean): boolean {
    const currentOp = this.getOperation(taskId);
    if (!currentOp) return false;

    // Transition state machine validation
    if (currentOp.status === status) {
      // Direct result update on same status allowed
    } else {
      const allowed = ALLOWED_TRANSITIONS[currentOp.status] || [];
      if (!allowed.includes(status)) return false;
      if (currentOp.status === "FAILED" && !currentOp.retryable) return false;
    }

    const db = getDb();
    const now = Date.now();

    db.prepare(`
      UPDATE service_operations
      SET status = ?, result = COALESCE(?, result), error = COALESCE(?, error),
          finished_at = CASE WHEN ? IN ('COMPLETED','FAILED','REJECTED','CANCELLED') THEN ? ELSE finished_at END, updated_at = ?
      WHERE task_id = ?
    `).run(status, result ?? null, error ?? null, status, now, now, taskId);

    return true;
  }

  setPendingApproval(taskId: string, request: TaskRequest, riskLevel: RiskLevel, reason: string): boolean {
    const now = Date.now();
    const result = getDb().prepare(`UPDATE service_operations SET status = 'WAITING_PERMISSION', risk_level = ?,
      approval_state = 'PENDING', approval_reason = ?, approval_requested_at = ?, pending_request_json = ?, updated_at = ?
      WHERE task_id = ? AND status = 'QUEUED'`).run(riskLevel, reason, now, JSON.stringify(request), now, taskId);
    return result.changes === 1;
  }

  claimPendingApproval(taskId: string): TaskRequest | null {
    const db = getDb();
    return db.transaction(() => {
      const row = db.prepare(`SELECT pending_request_json, task_id, trace_id, idempotency_key, capability FROM service_operations
        WHERE task_id = ? AND status = 'WAITING_PERMISSION' AND approval_state = 'PENDING'`).get(taskId) as
        | { pending_request_json: string | null; task_id: string; trace_id: string; idempotency_key: string; capability: string }
        | undefined;
      if (!row?.pending_request_json) return null;
      let parsed: unknown;
      try { parsed = JSON.parse(row.pending_request_json) as unknown; } catch { return null; }
      const request = validatePendingTaskRequest(parsed, {
        taskId: row.task_id,
        traceId: row.trace_id,
        idempotencyKey: row.idempotency_key,
        capability: row.capability,
      });
      if (!request) return null;
      const now = Date.now();
      const changed = db.prepare(`UPDATE service_operations SET approval_state = 'APPROVED', approval_decided_at = ?,
        status = 'DISPATCHING', updated_at = ? WHERE task_id = ? AND status = 'WAITING_PERMISSION' AND approval_state = 'PENDING' AND execution_mode='foreground'`)
        .run(now, now, taskId).changes;
      return changed === 1 ? request : null;
    })();
  }

  rejectPendingApproval(taskId: string): boolean {
    const now = Date.now();
    return getDb().prepare(`UPDATE service_operations SET approval_state = 'REJECTED', approval_decided_at = ?,
      status = 'REJECTED', error = 'Refusé par l’utilisateur.', updated_at = ?
      WHERE task_id = ? AND status = 'WAITING_PERMISSION' AND approval_state = 'PENDING'`)
      .run(now, now, taskId).changes === 1;
  }

  getOperation(taskId: string): ServiceOperation | null {
    const db = getDb();
    const row = db.prepare("SELECT * FROM service_operations WHERE task_id = ?").get(taskId) as
      | {
          task_id: string;
          trace_id: string;
          idempotency_key: string;
          objective: string;
          capability: string;
          selected_service: string;
          status: string;
          result: string | null;
          error: string | null;
          created_at: number;
          updated_at: number;
          risk_level: RiskLevel;
          approval_state: ApprovalState;
          approval_reason: string | null;
          approval_requested_at: number | null;
          approval_decided_at: number | null;
          execution_mode: ExecutionMode; queued_at: number | null; started_at: number | null; finished_at: number | null;
          cancel_requested_at: number | null; schedule_task_id: string | null;
          workspace_id: string | null;
        }
      | undefined;

    if (!row) return null;

    const status = row.status as OperationStatus;
    const isRetryable = status === "FAILED" && (row.error?.includes("TRANSPORT") || row.error?.includes("timeout") || row.error?.includes("Network"));

    return {
      taskId: row.task_id,
      traceId: row.trace_id,
      idempotencyKey: row.idempotency_key,
      objective: row.objective,
      capability: row.capability,
      selectedService: row.selected_service,
      status,
      result: row.result ?? undefined,
      error: row.error ?? undefined,
      retryable: isRetryable,
      riskLevel: row.risk_level,
      approvalState: row.approval_state,
      approvalReason: row.approval_reason ?? undefined,
      approvalRequestedAt: row.approval_requested_at ?? undefined,
      approvalDecidedAt: row.approval_decided_at ?? undefined,
      executionMode: row.execution_mode ?? "foreground", queuedAt: row.queued_at ?? undefined,
      startedAt: row.started_at ?? undefined, finishedAt: row.finished_at ?? undefined,
      cancelRequestedAt: row.cancel_requested_at ?? undefined, scheduleTaskId: row.schedule_task_id ?? undefined,
      workspaceId: row.workspace_id ?? undefined,
      createdAt: row.created_at,
      updatedAt: row.updated_at,
    };
  }

  getByIdempotencyKey(idempotencyKey: string): ServiceOperation | null {
    const db = getDb();
    const row = db.prepare("SELECT * FROM service_operations WHERE idempotency_key = ? ORDER BY created_at DESC").get(idempotencyKey) as
      | {
          task_id: string;
          trace_id: string;
          idempotency_key: string;
          objective: string;
          capability: string;
          selected_service: string;
          status: string;
          result: string | null;
          error: string | null;
          created_at: number;
          updated_at: number;
          risk_level: RiskLevel; approval_state: ApprovalState; approval_reason: string | null;
          approval_requested_at: number | null; approval_decided_at: number | null;
          execution_mode: ExecutionMode; queued_at: number | null; started_at: number | null; finished_at: number | null;
          cancel_requested_at: number | null; schedule_task_id: string | null;
          workspace_id: string | null;
        }
      | undefined;

    if (!row) return null;

    const status = row.status as OperationStatus;
    const isRetryable = status === "FAILED" && (row.error?.includes("TRANSPORT") || row.error?.includes("timeout") || row.error?.includes("Network"));

    return {
      taskId: row.task_id,
      traceId: row.trace_id,
      idempotencyKey: row.idempotency_key,
      objective: row.objective,
      capability: row.capability,
      selectedService: row.selected_service,
      status,
      result: row.result ?? undefined,
      error: row.error ?? undefined,
      retryable: isRetryable,
      riskLevel: row.risk_level, approvalState: row.approval_state,
      approvalReason: row.approval_reason ?? undefined, approvalRequestedAt: row.approval_requested_at ?? undefined,
      approvalDecidedAt: row.approval_decided_at ?? undefined,
      executionMode: row.execution_mode ?? "foreground", queuedAt: row.queued_at ?? undefined,
      startedAt: row.started_at ?? undefined, finishedAt: row.finished_at ?? undefined,
      cancelRequestedAt: row.cancel_requested_at ?? undefined, scheduleTaskId: row.schedule_task_id ?? undefined,
      workspaceId: row.workspace_id ?? undefined,
      createdAt: row.created_at,
      updatedAt: row.updated_at,
    };
  }

  listOperations(): ServiceOperation[] {
    const db = getDb();
    const rows = db.prepare("SELECT * FROM service_operations ORDER BY created_at DESC").all() as Array<{
      task_id: string;
      trace_id: string;
      idempotency_key: string;
      objective: string;
      capability: string;
      selected_service: string;
      status: string;
      result: string | null;
      error: string | null;
      created_at: number;
      updated_at: number;
      risk_level: RiskLevel; approval_state: ApprovalState; approval_reason: string | null;
      approval_requested_at: number | null; approval_decided_at: number | null;
      execution_mode: ExecutionMode; queued_at: number | null; started_at: number | null; finished_at: number | null;
      cancel_requested_at: number | null; schedule_task_id: string | null;
      workspace_id: string | null;
    }>;

    return rows.map((row) => {
      const status = row.status as OperationStatus;
      const isRetryable = status === "FAILED" && (row.error?.includes("TRANSPORT") || row.error?.includes("timeout") || row.error?.includes("Network"));
      return {
        taskId: row.task_id,
        traceId: row.trace_id,
        idempotencyKey: row.idempotency_key,
        objective: row.objective,
        capability: row.capability,
        selectedService: row.selected_service,
        status,
        result: row.result ?? undefined,
        error: row.error ?? undefined,
        retryable: isRetryable,
        riskLevel: row.risk_level, approvalState: row.approval_state,
        approvalReason: row.approval_reason ?? undefined, approvalRequestedAt: row.approval_requested_at ?? undefined,
        approvalDecidedAt: row.approval_decided_at ?? undefined,
        executionMode: row.execution_mode ?? "foreground", queuedAt: row.queued_at ?? undefined,
        startedAt: row.started_at ?? undefined, finishedAt: row.finished_at ?? undefined,
        cancelRequestedAt: row.cancel_requested_at ?? undefined, scheduleTaskId: row.schedule_task_id ?? undefined,
        workspaceId: row.workspace_id ?? undefined,
        createdAt: row.created_at,
        updatedAt: row.updated_at,
      };
    });
  }

  listEvents(taskId: string): ServiceEvent[] {
    const db = getDb();
    const rows = db.prepare(`
      SELECT event_id, task_id, sequence, schema_version, trace_id, service, type, event_timestamp, payload_json
      FROM processed_service_events
      WHERE task_id = ?
      ORDER BY sequence ASC
    `).all(taskId) as Array<{
      event_id: string;
      task_id: string;
      sequence: number;
      schema_version: string | null;
      trace_id: string | null;
      service: string | null;
      type: ServiceEvent["type"] | null;
      event_timestamp: number | null;
      payload_json: string | null;
    }>;

    const events: ServiceEvent[] = [];
    for (const row of rows) {
      if (
        !row.schema_version ||
        !row.trace_id ||
        !row.service ||
        !row.type ||
        row.event_timestamp === null ||
        row.payload_json === null
      ) {
        continue;
      }

      try {
        const payload = JSON.parse(row.payload_json) as unknown;
        if (!payload || typeof payload !== "object" || Array.isArray(payload)) continue;
        events.push({
          schema_version: row.schema_version,
          event_id: row.event_id,
          task_id: row.task_id,
          trace_id: row.trace_id,
          service: row.service,
          sequence: row.sequence,
          type: row.type,
          timestamp: row.event_timestamp,
          payload: payload as Record<string, unknown>,
        });
      } catch {
        // Ignore legacy or corrupted rows rather than synthesizing an event.
      }
    }
    return events;
  }

  processEvent(event: ServiceEvent): { duplicate: boolean; applied: boolean } {
    const db = getDb();

    const validation = this.validateEvent(event, event?.task_id);
    if (!validation.valid) return { duplicate: validation.duplicate, applied: false };

    // 1. Deduplication by event_id
    const existingEvt = db.prepare("SELECT event_id FROM processed_service_events WHERE event_id = ?").get(event.event_id);
    if (existingEvt) {
      return { duplicate: true, applied: false };
    }

    // 2. Task validation
    const currentOp = this.getOperation(event.task_id);
    if (!currentOp) {
      return { duplicate: false, applied: false };
    }

    // Trace ID & Service validation (allowing service aliases like software_factory <-> mock_software_factory)
    const serviceMatches =
      currentOp.selectedService === "none" ||
      currentOp.selectedService === event.service ||
      (currentOp.selectedService.includes("factory") && event.service.includes("factory"));

    if (currentOp.traceId !== event.trace_id || !serviceMatches) {
      return { duplicate: false, applied: false };
    }

    // 3. Sequence validation (must be strictly greater than last processed sequence)
    const lastSeqRow = db.prepare("SELECT MAX(sequence) as max_seq FROM processed_service_events WHERE task_id = ?").get(event.task_id) as
      | { max_seq: number | null }
      | undefined;
    const lastSequence = lastSeqRow?.max_seq ?? 0;

    if (event.sequence <= lastSequence) {
      return { duplicate: false, applied: false };
    }

    // Record processed event
    db.prepare(`
      INSERT INTO processed_service_events (
        event_id, task_id, sequence, processed_at,
        schema_version, trace_id, service, type, event_timestamp, payload_json
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      event.event_id,
      event.task_id,
      event.sequence,
      Date.now(),
      event.schema_version,
      event.trace_id,
      event.service,
      event.type,
      event.timestamp,
      JSON.stringify(event.payload),
    );

    // Map event type to operation status
    let status: OperationStatus | null = null;
    let result: string | undefined;
    let error: string | undefined;

    switch (event.type) {
      case "TASK_ACCEPTED":
      case "TASK_PROGRESS":
        status = "RUNNING";
        if (event.payload?.message) {
          result = String(event.payload.message);
        }
        break;
      case "TASK_REJECTED":
        status = "REJECTED";
        error = event.payload?.reason ? String(event.payload.reason) : "Tâche rejetée par le service";
        break;
      case "NEEDS_INPUT":
        status = "WAITING_INPUT";
        result = event.payload?.prompt ? String(event.payload.prompt) : "Information requise par le service";
        break;
      case "NEEDS_PERMISSION":
        status = "WAITING_PERMISSION";
        result = event.payload?.permission ? String(event.payload.permission) : "Autorisation requise par le service";
        break;
      case "TASK_COMPLETED":
        status = "COMPLETED";
        result = JSON.stringify(event.payload ?? {});
        break;
      case "TASK_FAILED":
        status = "FAILED";
        error = event.payload?.error ? String(event.payload.error) : "Erreur survenue lors de l'exécution de la tâche";
        break;
    }

    let applied = false;
    if (status) {
      applied = this.updateStatus(event.task_id, status, result, error);
    }

    return { duplicate: false, applied };
  }
}
