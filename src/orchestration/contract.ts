/**
 * Contrat d'échange Jarvis Core <-> Service
 * Version 1.0
 */

export const CONTRACT_SCHEMA_VERSION = "1.0";

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
 * Types de décisions de Jarvis Core
 */
export type CoreDecisionAction = "RESPOND" | "CALL_SKILL" | "DISPATCH_CAPABILITY";

export interface RespondDecision {
  action: "RESPOND";
  response: string;
}

export interface CallSkillDecision {
  action: "CALL_SKILL";
  skill: string;
  input: Record<string, unknown>;
}

export interface DispatchCapabilityDecision {
  action: "DISPATCH_CAPABILITY";
  capability: string;
  objective: string;
  context?: Record<string, unknown>;
  constraints?: string[];
  priority?: "low" | "medium" | "high" | "urgent";
}

export type CoreDecision = RespondDecision | CallSkillDecision | DispatchCapabilityDecision;

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
 * Validation et parsing robuste d'une décision produite par le LLM
 */
export function parseCoreDecision(rawText: string): CoreDecision | null {
  const trimmed = rawText.trim();

  // 1. Tenter le parsing direct JSON (si le LLM renvoie le JSON pur ou entouré de ```json ... ```)
  let cleanJsonStr = trimmed;
  if (cleanJsonStr.startsWith("```")) {
    cleanJsonStr = cleanJsonStr.replace(/^```(?:json)?\n?/, "").replace(/\n?```$/, "").trim();
  }

  try {
    const parsed = JSON.parse(cleanJsonStr);
    if (parsed && typeof parsed === "object" && typeof parsed.action === "string") {
      if (parsed.action === "RESPOND" && typeof parsed.response === "string") {
        return { action: "RESPOND", response: parsed.response };
      }
      if (parsed.action === "CALL_SKILL" && typeof parsed.skill === "string") {
        return {
          action: "CALL_SKILL",
          skill: parsed.skill,
          input: (typeof parsed.input === "object" && parsed.input !== null) ? parsed.input as Record<string, unknown> : {},
        };
      }
      if (parsed.action === "DISPATCH_CAPABILITY" && typeof parsed.capability === "string" && typeof parsed.objective === "string") {
        return {
          action: "DISPATCH_CAPABILITY",
          capability: parsed.capability,
          objective: parsed.objective,
          context: parsed.context ?? {},
          constraints: Array.isArray(parsed.constraints) ? parsed.constraints : [],
          priority: parsed.priority ?? "medium",
        };
      }
    }
  } catch {
    // Si la chaîne n'est pas un JSON valide, on continuera
  }

  // Si non trouvé ou invalide, retourner null pour permettre les fallbacks
  return null;
}
