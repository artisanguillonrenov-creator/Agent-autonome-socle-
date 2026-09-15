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
  | "REJECTED"
  | "CANCELLED";

export type ExecutionMode = "foreground" | "background";

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

/**
 * Vague 6C (interruptions événementielles asynchrones) : signal prioritaire pouvant
 * mettre en pause ou avorter proprement l'exécution en cours de l'agent — externe à la
 * boucle synchrone de dispatch de tâche (TaskRequest/ServiceEvent ci-dessus), qui reste le
 * contrat Core<->Service. Un TASK_EVENT externe (alerte de production, commande d'arrêt
 * utilisateur, priorité concurrente) est traduit en AgentInterruptSignal et publié sur le
 * bus d'événements (src/autonomy/eventBus.ts) ; l'agent le consomme à son prochain point
 * de contrôle et avorte, le cas échéant, la mission de plan ciblée.
 */
export type AgentInterruptReason = "USER_STOP" | "PRODUCTION_ALERT" | "TASK_EVENT" | "PRIORITY_OVERRIDE";

export interface AgentInterruptSignal {
  schema_version: string;
  signal_id: string;
  reason: AgentInterruptReason;
  message?: string;
  /** Plan run ciblé pour un avortement immédiat (PlanRunner.cancel) ; absent = pause globale de la boucle conversationnelle seulement. */
  planRunId?: string;
  issuedAt: number;
}
