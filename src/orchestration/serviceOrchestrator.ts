import { randomUUID } from "node:crypto";
import { ServiceRegistry, riskForCapability } from "./serviceRegistry.js";
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
  branch?: string;
  commitSha?: string;
  prNumber?: number;
  prUrl?: string;
}

export function extractOperationMetadata(resultStr?: string): {
  branch?: string;
  commitSha?: string;
  prNumber?: number;
  prUrl?: string;
} {
  if (!resultStr) return {};
  try {
    const p = JSON.parse(resultStr);
    if (p && typeof p === "object") {
      const branch = typeof p.branch === "string" ? p.branch : undefined;
      const commitSha =
        typeof p.commit_sha === "string"
          ? p.commit_sha
          : typeof p.commitSha === "string"
          ? p.commitSha
          : undefined;
      const prNumber =
        typeof p.pr_number === "number"
          ? p.pr_number
          : typeof p.prNumber === "number"
          ? p.prNumber
          : undefined;
      const prUrl =
        typeof p.pr_url === "string"
          ? p.pr_url
          : typeof p.prUrl === "string"
          ? p.prUrl
          : undefined;
      return { branch, commitSha, prNumber, prUrl };
    }
  } catch {
    // ignore
  }
  return {};
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
    opts?: { traceId?: string; idempotencyKey?: string; executionMode?: "foreground" | "background"; scheduleTaskId?: string },
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
        const meta = extractOperationMetadata(existingOp.result);
        return {
          taskId: existingOp.taskId,
          traceId: existingOp.traceId,
          status: existingOp.status,
          selectedService: existingOp.selectedService,
          result: existingOp.result,
          error: existingOp.error,
          ...meta,
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

    const riskLevel = riskForCapability(service, decision.capability);
    if (!riskLevel) {
      const taskId = `task-${randomUUID()}`;
      const error = `Configuration de risque invalide pour '${decision.capability}'`;
      this.store.createOperation({ taskId, traceId, idempotencyKey, objective: decision.objective,
        capability: decision.capability, selectedService: service.id, status: "REJECTED", error,
        riskLevel: "CRITICAL", approvalState: "REJECTED" });
      return { taskId, traceId, status: "REJECTED", selectedService: service.id, error };
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
        status: riskLevel === "HIGH" || riskLevel === "CRITICAL" ? "QUEUED" : opts?.executionMode === "background" ? "QUEUED" : "DISPATCHING",
        riskLevel,
        approvalState: "NOT_REQUIRED",
        executionMode: opts?.executionMode ?? "foreground",
        queuedAt: opts?.executionMode === "background" && riskLevel !== "HIGH" && riskLevel !== "CRITICAL" ? Date.now() : undefined,
        scheduleTaskId: opts?.scheduleTaskId,
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

    if (!existingOp && opts?.executionMode === "background") this.store.setDispatchRequest(taskId, request, riskLevel !== "HIGH" && riskLevel !== "CRITICAL");

    if (!existingOp && (riskLevel === "HIGH" || riskLevel === "CRITICAL")) {
      const reason = riskLevel === "CRITICAL"
        ? "Risque critique : confirmation renforcée obligatoire avant tout envoi au service."
        : "Risque élevé : approbation humaine obligatoire avant tout envoi au service.";
      if (!this.store.setPendingApproval(taskId, request, riskLevel, reason)) {
        this.store.updateStatus(taskId, "FAILED", undefined, "APPROVAL_PREPARATION_FAILED");
        const failed = this.store.getOperation(taskId)!;
        return { taskId, traceId: failed.traceId, status: failed.status, selectedService: failed.selectedService,
          result: failed.result, error: failed.error };
      }
      return { taskId, traceId, status: "WAITING_PERMISSION", selectedService: service.id };
    }

    if (opts?.executionMode === "background") return { taskId, traceId, status: "QUEUED", selectedService: service.id };

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
    const meta = extractOperationMetadata(updatedOp.result);

    return {
      taskId,
      traceId,
      status: updatedOp.status,
      selectedService: service.id,
      result: updatedOp.result,
      error: updatedOp.error,
      ...meta,
    };
  }

  async approvePendingOperation(taskId: string, confirmation?: string): Promise<OrchestrationResult | null> {
    const operation = this.store.getOperation(taskId);
    if (!operation || operation.status !== "WAITING_PERMISSION" || operation.approvalState !== "PENDING") return null;
    if (operation.riskLevel === "CRITICAL" && confirmation !== "APPROVE_CRITICAL") return null;
    if (operation.executionMode === "background") {
      if (!this.store.approveBackground(taskId)) return null;
      const updated=this.store.getOperation(taskId)!;
      return {taskId,traceId:updated.traceId,status:updated.status,selectedService:updated.selectedService};
    }
    const request = this.store.claimPendingApproval(taskId);
    if (!request) return null;
    const service = this.registry.getServiceById(operation.selectedService);
    if (!service) {
      this.store.updateStatus(taskId, "FAILED", undefined, "Service approuvé introuvable.");
    } else {
      const timeoutMs = service.id === "software_factory" ? config.softwareFactory.timeoutMs : 5000;
      const response = await this.adapter.dispatchTask(service.endpoint, request, timeoutMs);
      if (!response.success) this.store.updateStatus(taskId, "FAILED", undefined, `TRANSPORT_UNKNOWN: ${response.message}`, true);
      else for (const event of response.events) this.store.processEvent(event);
    }
    const updated = this.store.getOperation(taskId)!;
    return { taskId, traceId: updated.traceId, status: updated.status, selectedService: updated.selectedService,
      result: updated.result, error: updated.error, ...extractOperationMetadata(updated.result) };
  }


  async executeClaimed(request: TaskRequest): Promise<ServiceOperation> {
    const operation=this.store.getOperation(request.task_id); if(!operation) throw new Error("OPERATION_NOT_FOUND");
    const service=this.registry.getServiceById(operation.selectedService);
    if(!service){this.store.updateStatus(operation.taskId,"FAILED",undefined,"Service introuvable.");return this.store.getOperation(operation.taskId)!;}
    const timeoutMs=service.id==="software_factory"?config.softwareFactory.timeoutMs:5000;
    const response=await this.adapter.dispatchTask(service.endpoint,request,timeoutMs);
    if(!response.success)this.store.updateStatus(operation.taskId,"FAILED",undefined,`TRANSPORT_UNKNOWN: ${response.message}`,true);
    else for(const event of response.events)this.store.processEvent(event);
    return this.store.getOperation(operation.taskId)!;
  }

  rejectPendingOperation(taskId: string): boolean {
    return this.store.rejectPendingApproval(taskId);
  }

  getOperationStatus(taskId: string): ServiceOperation | null {
    return this.store.getOperation(taskId);
  }
}
