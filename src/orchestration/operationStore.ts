import { getDb } from "../persistence/db.js";
import { CONTRACT_SCHEMA_VERSION, type OperationStatus, type ServiceEvent } from "./contract.js";

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
      createdAt: now,
      updatedAt: now,
    };

    db.prepare(`
      INSERT INTO service_operations (
        task_id, trace_id, idempotency_key, objective, capability, selected_service, status, result, error, created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
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
      if (!allowed.includes(status)) {
        if (currentOp.status === "FAILED" && !currentOp.retryable && (status === "RUNNING" || status === "DISPATCHING")) {
          return false;
        }
        if (currentOp.status === "COMPLETED" || currentOp.status === "REJECTED") {
          return false;
        }
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
      };
    });
  }

  processEvent(event: ServiceEvent): { duplicate: boolean; applied: boolean } {
    const db = getDb();

    // 0. Schema version validation
    if (event.schema_version !== CONTRACT_SCHEMA_VERSION) {
      return { duplicate: false, applied: false };
    }

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
      INSERT INTO processed_service_events (event_id, task_id, sequence, processed_at)
      VALUES (?, ?, ?, ?)
    `).run(event.event_id, event.task_id, event.sequence, Date.now());

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
