import { randomUUID } from "node:crypto";
import { ServiceRegistry, type ServiceDefinition } from "./serviceRegistry.js";
import { ServiceAdapter } from "./serviceAdapter.js";
import { OperationStore, type ServiceOperation } from "./operationStore.js";
import { CONTRACT_SCHEMA_VERSION, type TaskRequest, type ServiceEvent, type DispatchCapabilityDecision } from "./contract.js";

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
      return {
        taskId: existingOp.taskId,
        traceId: existingOp.traceId,
        status: existingOp.status,
        selectedService: existingOp.selectedService,
        result: existingOp.result,
        error: existingOp.error,
      };
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

    // 3. Create Operation record
    const taskId = `task-${randomUUID()}`;
    this.store.createOperation({
      taskId,
      traceId,
      idempotencyKey,
      objective: decision.objective,
      capability: decision.capability,
      selectedService: service.id,
      status: "DISPATCHING",
    });

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

    // 5. Dispatch via ServiceAdapter
    const adapterRes = await this.adapter.dispatchTask(service.endpoint, request);

    if (!adapterRes.success) {
      // Transport/Network Error: mark as FAILED with transport info (can be retried with same idempotencyKey)
      this.store.updateStatus(taskId, "FAILED", undefined, adapterRes.message);
      return {
        taskId,
        traceId,
        status: "FAILED",
        selectedService: service.id,
        error: adapterRes.message,
      };
    }

    // 6. Process received events
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
