/**
 * Contrat d'échange Jarvis Core <-> Service
 * Version 1.0
 */

export const CONTRACT_SCHEMA_VERSION = "1.0";

export type RiskLevel = "LOW" | "MEDIUM" | "HIGH" | "CRITICAL";
export type ApprovalState = "NOT_REQUIRED" | "PENDING" | "APPROVED" | "REJECTED";

export type OperationStatus =
  | "QUEUED"
  | "DISPATCHING"
  | "RUNNING"
  | "WAITING_INPUT"
  | "WAITING_PERMISSION"
  | "COMPLETED"
  | "FAILED"
  | "REJECTED";

/**
 * Structure de requête pour délégation de capacité externe vers ServiceOrchestrator
 */
export interface DispatchCapabilityDecision {
  action: "DISPATCH_CAPABILITY";
  capability: string;
  objective: string;
  context?: Record<string, unknown>;
  constraints?: string[];
  priority?: "low" | "medium" | "high" | "urgent";
}

/**
 * Contrat de requête de tâche transmise au service
 */
export interface TaskRequest {
  schema_version: string;
  task_id: string;
  trace_id: string;
  idempotency_key: string;
  capability: string;
  objective: string;
  context: Record<string, unknown>;
  constraints: string[];
  priority: string;
  permissions: string[];
}

/**
 * Types d'événements émis par un service
 */
export type ServiceEventType =
  | "TASK_ACCEPTED"
  | "TASK_REJECTED"
  | "TASK_PROGRESS"
  | "NEEDS_INPUT"
  | "NEEDS_PERMISSION"
  | "TASK_COMPLETED"
  | "TASK_FAILED";

export interface ServiceEvent {
  schema_version: string;
  event_id: string;
  task_id: string;
  trace_id: string;
  service: string;
  sequence: number;
  type: ServiceEventType;
  timestamp: number;
  payload: Record<string, unknown>;
}
