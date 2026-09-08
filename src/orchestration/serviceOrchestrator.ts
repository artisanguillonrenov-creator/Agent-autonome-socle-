import { randomUUID } from "node:crypto";
import { ServiceRegistry, type ServiceDefinition, type RiskLevel } from "./serviceRegistry.js";
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
  riskLevel?: RiskLevel;
  approvalState?: ServiceOperation["approvalState"];
  approvalReason?: string;
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

  private resolveRiskLevel(service: ServiceDefinition, capability: string): RiskLevel {
    const configured = service.riskByCapability?.[capability];
    if (configured === undefined) return "LOW";
    if (configured === "LOW" || configured === "MEDIUM" || configured === "HIGH" || configured === "CRITICAL") {
      return configured;
    }
    throw new Error(`RISK_LEVEL_INVALID: Niveau de risque invalide pour '${capability}'.`);
  }

  private async dispatchPreparedRequest(service: ServiceDefinition, request: TaskRequest): Promise<OrchestrationResult> {
    const timeoutMs = service.id === "software_factory" ? config.softwareFactory.timeoutMs : 5000;
    const adapterRes = await this.adapter.dispatchTask(service.endpoint, request, timeoutMs);

    if (!adapterRes.success) {
      this.store.updateStatus(request.task_id, "FAILED", undefined, `TRANSPORT_UNKNOWN: ${adapterRes.message}`, true);
      return {
        taskId: request.task_id,
        traceId: request.trace_id,
        status: "FAILED",
        selectedService: service.id,
        error: adapterRes.message,
      };
    }

    for (const event of adapterRes.events) this.store.processEvent(event);
    const updatedOp = this.store.getOperation(request.task_id)!;
    return {
      taskId: request.task_id,
      traceId: request.trace_id,
      status: updatedOp.status,
      selectedService: service.id,
      result: updatedOp.result,
      error: updatedOp.error,
      ...extractOperationMetadata(updatedOp.result),
    };
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
        const meta = extractOperationMetadata(existingOp.result);
        return {
          taskId: existingOp.taskId,
          traceId: existingOp.traceId,
          status: existingOp.status,
          selectedService: existingOp.selectedService,
          result: existingOp.result,
          error: existingOp.error,
          riskLevel: existingOp.riskLevel,
          approvalState: existingOp.approvalState,
          approvalReason: existingOp.approvalReason,
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

    const riskLevel = this.resolveRiskLevel(service, decision.capability);

    const taskId = existingOp?.taskId || `task-${randomUUID()}`;
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

    // 3. Create Operation record (or reuse taskId if retrying existingOp)
    if (!existingOp) {
      this.store.createOperation({
        taskId,
        traceId,
        idempotencyKey,
        objective: decision.objective,
        capability: decision.capability,
        selectedService: service.id,
        status: "DISPATCHING",
        riskLevel,
        approvalState: riskLevel === "HIGH" || riskLevel === "CRITICAL" ? "PENDING" : "NOT_REQUIRED",
      });
    } else {
      this.store.updateStatus(taskId, "DISPATCHING", undefined, "Nouvelle tentative après échec réseau.");
    }

    if (riskLevel === "HIGH" || riskLevel === "CRITICAL") {
      const reason = `Approbation humaine requise pour le niveau de risque ${riskLevel}.`;
      if (!this.store.setPendingApproval(taskId, riskLevel, reason, request)) {
        throw new Error("APPROVAL_STATE_CONFLICT: Impossible de préparer l'approbation.");
      }
      const pending = this.store.getOperation(taskId)!;
      return {
        taskId,
        traceId,
        status: pending.status,
        selectedService: service.id,
        result: pending.result,
        riskLevel: pending.riskLevel,
        approvalState: pending.approvalState,
        approvalReason: pending.approvalReason,
      };
    }

    return this.dispatchPreparedRequest(service, request);
  }

  async approvePendingOperation(taskId: string, confirmation?: string): Promise<OrchestrationResult> {
    const operation = this.store.getOperation(taskId);
    if (!operation) throw new Error("OPERATION_NOT_FOUND");
    if (operation.status !== "WAITING_PERMISSION" || operation.approvalState !== "PENDING") {
      throw new Error("APPROVAL_STATE_CONFLICT");
    }
    if (operation.riskLevel === "CRITICAL" && confirmation !== "APPROVE_CRITICAL") {
      throw new Error("CRITICAL_CONFIRMATION_REQUIRED");
    }

    const request = this.store.claimPendingApproval(taskId);
    if (!request) throw new Error("APPROVAL_STATE_CONFLICT");
    const service = this.registry.getServiceById(operation.selectedService);
    if (!service) {
      this.store.updateStatus(taskId, "FAILED", undefined, "SERVICE_NOT_FOUND");
      throw new Error("SERVICE_NOT_FOUND");
    }
    return this.dispatchPreparedRequest(service, request);
  }

  rejectPendingOperation(taskId: string): ServiceOperation {
    const operation = this.store.getOperation(taskId);
    if (!operation) throw new Error("OPERATION_NOT_FOUND");
    if (!this.store.rejectPendingApproval(taskId)) throw new Error("APPROVAL_STATE_CONFLICT");
    return this.store.getOperation(taskId)!;
  }

  getOperationStatus(taskId: string): ServiceOperation | null {
    return this.store.getOperation(taskId);
  }
}
