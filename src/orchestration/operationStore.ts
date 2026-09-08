import { getDb } from "../persistence/db.js";
import type { OperationStatus, ServiceEvent, TaskRequest } from "./contract.js";
import type { RiskLevel } from "./serviceRegistry.js";

export type ApprovalState = "NOT_REQUIRED" | "PENDING" | "APPROVED" | "REJECTED";

function isTaskRequest(value: unknown, taskId: string): value is TaskRequest {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const request = value as Partial<TaskRequest>;
  return (
    typeof request.schema_version === "string" &&
    request.task_id === taskId &&
    typeof request.trace_id === "string" &&
    typeof request.idempotency_key === "string" &&
    typeof request.capability === "string" &&
    typeof request.objective === "string" &&
    Boolean(request.context) &&
    typeof request.context === "object" &&
    !Array.isArray(request.context) &&
    Array.isArray(request.constraints) &&
    typeof request.priority === "string" &&
    Array.isArray(request.permissions)
  );
}

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
  riskLevel?: RiskLevel;
  approvalState?: ApprovalState;
  approvalReason?: string;
  approvalRequestedAt?: number;
  approvalDecidedAt?: number;
  createdAt: number;
  updatedAt: number;
}

const ALLOWED_TRANSITIONS: Record<OperationStatus, OperationStatus[]> = {
  QUEUED: ["DISPATCHING", "RUNNING", "FAILED", "REJECTED"],
  DISPATCHING: ["RUNNING", "COMPLETED", "FAILED", "REJECTED"],
  RUNNING: ["WAITING_INPUT", "WAITING_PERMISSION", "COMPLETED", "FAILED", "REJECTED"],
  WAITING_INPUT: ["RUNNING", "FAILED", "REJECTED"],
  WAITING_PERMISSION: ["RUNNING", "REJECTED", "FAILED"],
  COMPLETED: [], // Terminal
  REJECTED: [], // Terminal
  FAILED: ["RUNNING", "DISPATCHING"], // Terminal unless retryable
};

export class OperationStore {
  createOperation(op: Omit<ServiceOperation, "createdAt" | "updatedAt">): ServiceOperation {
    const db = getDb();
    const now = Date.now();
    const fullOp: ServiceOperation = {
      ...op,
      retryable: op.retryable ?? false,
      riskLevel: op.riskLevel ?? "LOW",
      approvalState: op.approvalState ?? "NOT_REQUIRED",
      createdAt: now,
      updatedAt: now,
    };

    db.prepare(`
      INSERT INTO service_operations (
        task_id, trace_id, idempotency_key, objective, capability, selected_service, status, result, error, created_at, updated_at,
        risk_level, approval_state, approval_reason, approval_requested_at, approval_decided_at, pending_request_json
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
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
      fullOp.createdAt,
      fullOp.updatedAt,
      fullOp.riskLevel ?? "LOW",
      fullOp.approvalState ?? "NOT_REQUIRED",
      fullOp.approvalReason ?? null,
      fullOp.approvalRequestedAt ?? null,
      fullOp.approvalDecidedAt ?? null,
      null,
    );

    return fullOp;
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
      if (currentOp.status === "FAILED" && !currentOp.retryable) {
        return false;
      }
    }

    const db = getDb();
    const now = Date.now();

    db.prepare(`
      UPDATE service_operations
      SET status = ?, result = COALESCE(?, result), error = COALESCE(?, error), updated_at = ?
      WHERE task_id = ?
    `).run(status, result ?? null, error ?? null, now, taskId);

    return true;
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
          risk_level: RiskLevel | null;
          approval_state: ApprovalState | null;
          approval_reason: string | null;
          approval_requested_at: number | null;
          approval_decided_at: number | null;
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
      createdAt: row.created_at,
      updatedAt: row.updated_at,
      riskLevel: row.risk_level ?? "LOW",
      approvalState: row.approval_state ?? "NOT_REQUIRED",
      approvalReason: row.approval_reason ?? undefined,
      approvalRequestedAt: row.approval_requested_at ?? undefined,
      approvalDecidedAt: row.approval_decided_at ?? undefined,
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
          risk_level: RiskLevel | null;
          approval_state: ApprovalState | null;
          approval_reason: string | null;
          approval_requested_at: number | null;
          approval_decided_at: number | null;
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
      createdAt: row.created_at,
      updatedAt: row.updated_at,
      riskLevel: row.risk_level ?? "LOW",
      approvalState: row.approval_state ?? "NOT_REQUIRED",
      approvalReason: row.approval_reason ?? undefined,
      approvalRequestedAt: row.approval_requested_at ?? undefined,
      approvalDecidedAt: row.approval_decided_at ?? undefined,
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
      risk_level: RiskLevel | null;
      approval_state: ApprovalState | null;
      approval_reason: string | null;
      approval_requested_at: number | null;
      approval_decided_at: number | null;
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
        createdAt: row.created_at,
        updatedAt: row.updated_at,
        riskLevel: row.risk_level ?? "LOW",
        approvalState: row.approval_state ?? "NOT_REQUIRED",
        approvalReason: row.approval_reason ?? undefined,
        approvalRequestedAt: row.approval_requested_at ?? undefined,
        approvalDecidedAt: row.approval_decided_at ?? undefined,
      };
    });
  }

  setPendingApproval(taskId: string, riskLevel: RiskLevel, reason: string, request: TaskRequest): boolean {
    const now = Date.now();
    const result = getDb().prepare(`
      UPDATE service_operations
      SET status = 'WAITING_PERMISSION', risk_level = ?, approval_state = 'PENDING',
          approval_reason = ?, approval_requested_at = ?, approval_decided_at = NULL,
          pending_request_json = ?, updated_at = ?
      WHERE task_id = ? AND status = 'DISPATCHING'
    `).run(riskLevel, reason, now, JSON.stringify(request), now, taskId);
    return result.changes === 1;
  }

  claimPendingApproval(taskId: string): TaskRequest | null {
    const db = getDb();
    return db.transaction(() => {
      const row = db.prepare(`
        SELECT pending_request_json FROM service_operations
        WHERE task_id = ? AND status = 'WAITING_PERMISSION' AND approval_state = 'PENDING'
      `).get(taskId) as { pending_request_json: string | null } | undefined;
      if (!row?.pending_request_json) return null;

      let request: unknown;
      try {
        request = JSON.parse(row.pending_request_json) as unknown;
      } catch {
        return null;
      }
      if (!isTaskRequest(request, taskId)) return null;

      const now = Date.now();
      const claimed = db.prepare(`
        UPDATE service_operations
        SET status = 'DISPATCHING', approval_state = 'APPROVED', approval_decided_at = ?, updated_at = ?
        WHERE task_id = ? AND status = 'WAITING_PERMISSION' AND approval_state = 'PENDING'
      `).run(now, now, taskId);
      return claimed.changes === 1 ? request : null;
    })();
  }

  rejectPendingApproval(taskId: string): boolean {
    const now = Date.now();
    const result = getDb().prepare(`
      UPDATE service_operations
      SET status = 'REJECTED', approval_state = 'REJECTED', approval_decided_at = ?, updated_at = ?
      WHERE task_id = ? AND status = 'WAITING_PERMISSION' AND approval_state = 'PENDING'
    `).run(now, now, taskId);
    return result.changes === 1;
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
