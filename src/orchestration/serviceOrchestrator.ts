import { randomUUID } from "node:crypto";
import { ServiceRegistry, type ServiceDefinition } from "./serviceRegistry.js";
import { ServiceAdapter } from "./serviceAdapter.js";
import { OperationStore, type ServiceOperation } from "./operationStore.js";
import { CONTRACT_SCHEMA_VERSION, type TaskRequest, type ServiceEvent, type DispatchCapabilityDecision } from "./contract.js";
import { config } from "../config.js";

export interface OrchestrationResult {
  taskId: string;
  traceId: string;
  status: string;
  selectedService: string;
  result?: string;
  error?: string;
}

export class ServiceOrchestrator {
  readonly registry: ServiceRegistry;
  readonly adapter: ServiceAdapter;
  readonly store: OperationStore;

  constructor(opts?: { registry?: ServiceRegistry; adapter?: ServiceAdapter; store?: OperationStore }) {
    this.registry = opts?.registry ?? new ServiceRegistry();
    this.adapter = opts?.adapter ?? new ServiceAdapter();
    this.store = opts?.store ?? new OperationStore();
  }

  async dispatchCapability(
    decision: DispatchCapabilityDecision,
    opts?: { traceId?: string; idempotencyKey?: string },
  ): Promise<OrchestrationResult> {
    const traceId = opts?.traceId || `trace-${randomUUID()}`;
    const idempotencyKey = opts?.idempotencyKey || `idemp-${randomUUID()}`;

    // 1. Check idempotency in OperationStore
    const existingOp = this.store.getByIdempotencyKey(idempotencyKey);
    if (existingOp) {
      if (
        existingOp.status === "COMPLETED" ||
        existingOp.status === "RUNNING" ||
        existingOp.status === "DISPATCHING" ||
        existingOp.status === "WAITING_INPUT" ||
        existingOp.status === "WAITING_PERMISSION" ||
        existingOp.status === "REJECTED" ||
        (existingOp.status === "FAILED" && !existingOp.retryable)
      ) {
        return {
          taskId: existingOp.taskId,
          traceId: existingOp.traceId,
          status: existingOp.status,
          selectedService: existingOp.selectedService,
          result: existingOp.result,
          error: existingOp.error,
        };
      }
      // If FAILED and retryable, proceed with controlled retry dispatch below
    }

    // 2. Lookup Service by capability
    const service = this.registry.findServiceForCapability(decision.capability);
    if (!service) {
      const taskId = `task-${randomUUID()}`;
      const errMessage = `Aucun service trouvé pour la capacité '${decision.capability}'`;
      this.store.createOperation({
        taskId,
        traceId,
        idempotencyKey,
        objective: decision.objective,
        capability: decision.capability,
        selectedService: "none",
        status: "REJECTED",
        error: errMessage,
      });

      return {
        taskId,
        traceId,
        status: "REJECTED",
        selectedService: "none",
        error: errMessage,
      };
    }

    // 3. Create Operation record (or reuse taskId if retrying existingOp)
    const taskId = existingOp?.taskId || `task-${randomUUID()}`;
    if (!existingOp) {
      this.store.createOperation({
        taskId,
        traceId,
        idempotencyKey,
        objective: decision.objective,
        capability: decision.capability,
        selectedService: service.id,
        status: "DISPATCHING",
      });
    } else {
      this.store.updateStatus(taskId, "DISPATCHING", undefined, "Nouvelle tentative après échec réseau.");
    }

    // 4. Build Task Request
    const request: TaskRequest = {
      schema_version: CONTRACT_SCHEMA_VERSION,
      task_id: taskId,
      trace_id: traceId,
      idempotency_key: idempotencyKey,
      capability: decision.capability,
      objective: decision.objective,
      context: decision.context || {},
      constraints: decision.constraints || [],
      priority: decision.priority || "medium",
      permissions: [],
    };

    // 5. Determine specific timeout for service
    const timeoutMs =
      service.id === "software_factory"
        ? config.softwareFactory.timeoutMs
        : 5000;

    // 6. Dispatch via ServiceAdapter
    const adapterRes = await this.adapter.dispatchTask(service.endpoint, request, timeoutMs);

    if (!adapterRes.success) {
      // Transport/Network Error: mark as FAILED (retryable = true) with transport info
      this.store.updateStatus(taskId, "FAILED", undefined, `TRANSPORT_UNKNOWN: ${adapterRes.message}`, true);
      return {
        taskId,
        traceId,
        status: "FAILED",
        selectedService: service.id,
        error: adapterRes.message,
      };
    }

    // 7. Process received events
    for (const event of adapterRes.events) {
      this.store.processEvent(event);
    }

    const updatedOp = this.store.getOperation(taskId)!;
    return {
      taskId,
      traceId,
      status: updatedOp.status,
      selectedService: service.id,
      result: updatedOp.result,
      error: updatedOp.error,
    };
  }

  getOperationStatus(taskId: string): ServiceOperation | null {
    return this.store.getOperation(taskId);
  }
}
