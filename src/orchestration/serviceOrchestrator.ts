import { randomUUID } from "node:crypto";
import { ServiceRegistry, riskForCapability } from "./serviceRegistry.js";
import { ServiceAdapter } from "./serviceAdapter.js";
import { OperationStore, type ServiceOperation } from "./operationStore.js";
import { CONTRACT_SCHEMA_VERSION, type TaskRequest, type ServiceEvent, type DispatchCapabilityDecision } from "./contract.js";
import { config } from "../config.js";
import { requiresApprovalForRisk, permissionForCapability, isPermissionGranted } from "./riskPolicy.js";
import { WorkspaceStore } from "../workspaces/workspaceStore.js";
import { ArtifactStore } from "../workspaces/artifactStore.js";
import { WorkspaceService } from "../services/workspaceService.js";
import { ResearchService } from "../services/researchService.js";
import { getDb } from "../persistence/db.js";
import type { ArtifactInput, ArtifactKind } from "../workspaces/artifactStore.js";

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
  readonly workspaces = new WorkspaceStore();
  readonly artifacts = new ArtifactStore(this.workspaces);

  constructor(opts?: { registry?: ServiceRegistry; adapter?: ServiceAdapter; store?: OperationStore }) {
    this.registry = opts?.registry ?? new ServiceRegistry();
    this.adapter = opts?.adapter ?? new ServiceAdapter();
    this.store = opts?.store ?? new OperationStore();
    if(typeof (this.adapter as any).registerLocal==="function"){
      this.adapter.registerLocal("workspace_service",new WorkspaceService(this.workspaces));
      this.adapter.registerLocal("research_service",new ResearchService());
    }
  }

  async dispatchCapability(
    decision: DispatchCapabilityDecision,
    opts?: { traceId?: string; idempotencyKey?: string; executionMode?: "foreground" | "background"; scheduleTaskId?: string; workspaceId?: string; specialistId?:string; planRunId?:string; planNodeId?:string; parallelAllowed?:boolean },
  ): Promise<OrchestrationResult> {
    const traceId = opts?.traceId || `trace-${randomUUID()}`;
    const idempotencyKey = opts?.idempotencyKey || `idemp-${randomUUID()}`;

    // 1. Check idempotency in OperationStore
    const existingOp = this.store.getByIdempotencyKey(idempotencyKey);
    if (existingOp) {
      if (
        existingOp.status === "QUEUED" ||
        existingOp.status === "COMPLETED" ||
        existingOp.status === "RUNNING" ||
        existingOp.status === "DISPATCHING" ||
        existingOp.status === "WAITING_INPUT" ||
        existingOp.status === "WAITING_PERMISSION" ||
        existingOp.status === "REJECTED" ||
        existingOp.status === "CANCELLED" ||
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

    // autonomy.permissionMatrix : vérifié au point d'exécution effectif, pas seulement
    // dans l'interface — une capacité qui exige plus que la permission maximale accordée
    // est refusée immédiatement, sans jamais atteindre le service.
    const requiredPermission = permissionForCapability(service, decision.capability);
    if (!isPermissionGranted(requiredPermission)) {
      const taskId = `task-${randomUUID()}`;
      const error = `PERMISSION_DENIED: la capacité '${decision.capability}' exige la permission ${requiredPermission}, non accordée par autonomy.permissionMatrix`;
      this.store.createOperation({ taskId, traceId, idempotencyKey, objective: decision.objective,
        capability: decision.capability, selectedService: service.id, status: "REJECTED", error,
        riskLevel, approvalState: "REJECTED" });
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
        status: requiresApprovalForRisk(riskLevel) ? "QUEUED" : opts?.executionMode === "background" ? "QUEUED" : "DISPATCHING",
        riskLevel,
        approvalState: "NOT_REQUIRED",
        executionMode: opts?.executionMode ?? "foreground",
        queuedAt: opts?.executionMode === "background" && !requiresApprovalForRisk(riskLevel) ? Date.now() : undefined,
        scheduleTaskId: opts?.scheduleTaskId,
        workspaceId: opts?.workspaceId, specialistId:opts?.specialistId,planRunId:opts?.planRunId,planNodeId:opts?.planNodeId,parallelAllowed:opts?.parallelAllowed??false,
      });
    } else {
      if (!this.store.updateStatus(taskId, "DISPATCHING", undefined, "Nouvelle tentative après échec réseau.")) {
        const persisted = this.store.getOperation(taskId)!;
        return { taskId, traceId: persisted.traceId, status: persisted.status,
          selectedService: persisted.selectedService, result: persisted.result, error: persisted.error,
          ...extractOperationMetadata(persisted.result) };
      }
    }

    // 4. Build Task Request
    const request: TaskRequest = {
      schema_version: CONTRACT_SCHEMA_VERSION,
      task_id: taskId,
      trace_id: traceId,
      idempotency_key: idempotencyKey,
      capability: decision.capability,
      objective: decision.objective,
      context: opts?.workspaceId ? {...(decision.context||{}),workspace:{id:opts.workspaceId}} : decision.context || {},
      constraints: decision.constraints || [],
      priority: decision.priority || "medium",
      permissions: [],
    };

    if (!existingOp && opts?.executionMode === "background") this.store.setDispatchRequest(taskId, request, !requiresApprovalForRisk(riskLevel));

    if (!existingOp && requiresApprovalForRisk(riskLevel)) {
      const reason = riskLevel === "CRITICAL"
        ? "Risque critique : confirmation renforcée obligatoire avant tout envoi au service."
        : `Risque ${riskLevel} au-delà du plafond autonomy.globalRiskLevel (${config.autonomy.globalRiskLevel}) : approbation humaine obligatoire avant tout envoi au service.`;
      if (!this.store.setPendingApproval(taskId, request, riskLevel, reason)) {
        this.store.updateStatus(taskId, "FAILED", undefined, "APPROVAL_PREPARATION_FAILED");
        const failed = this.store.getOperation(taskId)!;
        return { taskId, traceId: failed.traceId, status: failed.status, selectedService: failed.selectedService,
          result: failed.result, error: failed.error };
      }
      return { taskId, traceId, status: "WAITING_PERMISSION", selectedService: service.id };
    }

    if (opts?.executionMode === "background") return { taskId, traceId, status: "QUEUED", selectedService: service.id };

    // 5. Determine specific timeout for service — connections.requestTimeoutMs is the
    // global fallback default; un timeout explicite par service (requestTimeoutMs) garde
    // toujours la priorité.
    const timeoutMs =
      service.id === "software_factory"
        ? config.softwareFactory.timeoutMs
        : service.requestTimeoutMs ?? config.connections.requestTimeoutMs;

    // 6. Dispatch via ServiceAdapter
    const adapterRes = await this.adapter.dispatchTask(typeof (this.adapter as any).registerLocal==="function"?service:service.endpoint, request, timeoutMs);

    if (!adapterRes.success) {
      this.store.recordMetrics(taskId,adapterRes.transportDurationMs);
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
    const usage=this.processEvents(taskId, adapterRes.events);this.store.recordMetrics(taskId,adapterRes.transportDurationMs,usage);

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
      const timeoutMs = service.id === "software_factory" ? config.softwareFactory.timeoutMs : service.requestTimeoutMs ?? config.connections.requestTimeoutMs;
      const response = await this.adapter.dispatchTask(typeof (this.adapter as any).registerLocal==="function"?service:service.endpoint, request, timeoutMs);
      if (!response.success) {this.store.recordMetrics(taskId,response.transportDurationMs);this.store.updateStatus(taskId, "FAILED", undefined, `TRANSPORT_UNKNOWN: ${response.message}`, true);}
      else {const usage=this.processEvents(taskId,response.events);this.store.recordMetrics(taskId,response.transportDurationMs,usage);}
    }
    const updated = this.store.getOperation(taskId)!;
    return { taskId, traceId: updated.traceId, status: updated.status, selectedService: updated.selectedService,
      result: updated.result, error: updated.error, ...extractOperationMetadata(updated.result) };
  }


  async executeClaimed(request: TaskRequest): Promise<ServiceOperation> {
    const operation=this.store.getOperation(request.task_id); if(!operation) throw new Error("OPERATION_NOT_FOUND");
    const service=this.registry.getServiceById(operation.selectedService);
    if(!service){this.store.updateStatus(operation.taskId,"FAILED",undefined,"Service introuvable.");return this.store.getOperation(operation.taskId)!;}
    const timeoutMs=service.id==="software_factory"?config.softwareFactory.timeoutMs:service.requestTimeoutMs??config.connections.requestTimeoutMs;
    const response=await this.adapter.dispatchTask(typeof (this.adapter as any).registerLocal==="function"?service:service.endpoint,request,timeoutMs);
    if(!response.success){this.store.recordMetrics(operation.taskId,response.transportDurationMs);this.store.updateStatus(operation.taskId,"FAILED",undefined,`TRANSPORT_UNKNOWN: ${response.message}`,true);}
    else {const usage=this.processEvents(operation.taskId,response.events);this.store.recordMetrics(operation.taskId,response.transportDurationMs,usage);}
    return this.store.getOperation(operation.taskId)!;
  }

  rejectPendingOperation(taskId: string): boolean {
    return this.store.rejectPendingApproval(taskId);
  }

  getOperationStatus(taskId: string): ServiceOperation | null {
    return this.store.getOperation(taskId);
  }
  private processEvents(taskId:string,events:unknown):unknown {let usage:unknown;if(!Array.isArray(events)){this.store.updateStatus(taskId,"FAILED",undefined,"INVALID_SERVICE_EVENT_STATE_UNKNOWN",false);return undefined;}for(const raw of events){const validation=this.store.validateEvent(raw,taskId);if(!validation.valid){if(validation.duplicate)continue;this.store.updateStatus(taskId,"FAILED",undefined,"INVALID_SERVICE_EVENT_STATE_UNKNOWN",false);return undefined;}const event=validation.event;if(event.type==="TASK_COMPLETED"&&event.payload.artifacts!==undefined){try{this.persistArtifacts(event);}catch{this.store.updateStatus(taskId,"FAILED",undefined,"INVALID_ARTIFACT_DESCRIPTOR",false);return undefined;}}const applied=this.store.processEvent(event);if(applied.applied&&(event.type==="TASK_COMPLETED"||event.type==="TASK_FAILED"))usage=event.payload.usage;}return usage;}
  private persistArtifacts(event:ServiceEvent):void {const operation=this.store.getOperation(event.task_id);const workspaceId=operation?.workspaceId;if(!workspaceId||!Array.isArray(event.payload.artifacts))throw new Error();const plan=(getDb().prepare("SELECT id FROM plan_runs WHERE workspace_id=?").get(workspaceId) as any)?.id;const inputs:ArtifactInput[]=event.payload.artifacts.map(raw=>{if(!raw||typeof raw!=="object"||Array.isArray(raw))throw new Error();const descriptor=raw as Record<string,unknown>;if(typeof descriptor.name!=="string"||!descriptor.name.trim()||typeof descriptor.kind!=="string"||!["FILE","TEXT","REPORT","DATA","LINK"].includes(descriptor.kind)||(descriptor.mime_type!==undefined&&typeof descriptor.mime_type!=="string"))throw new Error();const common={workspaceId,planRunId:plan,operationTaskId:event.task_id,kind:descriptor.kind as ArtifactKind,name:descriptor.name,mimeType:descriptor.mime_type as string|undefined};if(descriptor.kind==="LINK"){if(typeof descriptor.url!=="string")throw new Error();const url=new URL(descriptor.url);if(!["http:","https:"].includes(url.protocol))throw new Error();return{...common,url:url.href};}if(typeof descriptor.content_base64!=="string"||!this.isStrictBase64(descriptor.content_base64))throw new Error();return{...common,content:Buffer.from(descriptor.content_base64,"base64"),workingPath:event.service==="research_service"?descriptor.name:undefined};});if(inputs.length)this.artifacts.createBatch(inputs);}
  private isStrictBase64(value:string):boolean {if(value.length%4!==0||!/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(value))return false;return Buffer.from(value,"base64").toString("base64")===value;}
}
