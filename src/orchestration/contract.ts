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

function validateAndMapDecision(parsed: any): CoreDecision | null {
  if (!parsed || typeof parsed !== "object") return null;

  // 1. Standard action format
  if (typeof parsed.action === "string") {
    if (parsed.action === "RESPOND" && typeof parsed.response === "string") {
      return { action: "RESPOND", response: parsed.response };
    }
    if (parsed.action === "CALL_SKILL") {
      const skillName = String(parsed.skill || parsed.name || parsed.tool || "").trim();
      if (skillName) {
        let input: Record<string, unknown> = {};
        if (typeof parsed.input === "object" && parsed.input !== null) {
          input = parsed.input as Record<string, unknown>;
        } else if (typeof parsed.arguments === "object" && parsed.arguments !== null) {
          input = parsed.arguments as Record<string, unknown>;
        } else if (typeof parsed.query === "string") {
          input = { query: parsed.query };
        }
        return { action: "CALL_SKILL", skill: skillName, input };
      }
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

  // 2. OpenRouter / Nemotron / Llama / DeepSeek Tool Call format: { name: "web_search", arguments: { query: "..." } }
  const skillName = String(parsed.name || parsed.skill || parsed.tool || parsed.function || "").trim();
  const knownSkills = ["web_search", "get_current_time", "remember_fact", "manage_tasks", "execute_code"];
  if (skillName && knownSkills.includes(skillName)) {
    let input: Record<string, unknown> = {};
    if (typeof parsed.arguments === "object" && parsed.arguments !== null) {
      input = parsed.arguments as Record<string, unknown>;
    } else if (typeof parsed.parameters === "object" && parsed.parameters !== null) {
      input = parsed.parameters as Record<string, unknown>;
    } else if (typeof parsed.input === "object" && parsed.input !== null) {
      input = parsed.input as Record<string, unknown>;
    } else if (typeof parsed.query === "string") {
      input = { query: parsed.query };
    }
    return { action: "CALL_SKILL", skill: skillName, input };
  }

  return null;
}

/**
 * Validation et parsing ultra-robuste d'une décision produite par n'importe quel LLM
 */
export function parseCoreDecision(rawText: string): CoreDecision | null {
  const trimmed = rawText.trim();

  // 1. Direct JSON or markdown block
  let cleanJsonStr = trimmed;
  if (cleanJsonStr.includes("```")) {
    const match = cleanJsonStr.match(/```(?:json)?\s*([\s\S]*?)\s*```/);
    if (match) cleanJsonStr = match[1].trim();
  }

  try {
    const parsed = JSON.parse(cleanJsonStr);
    const decision = validateAndMapDecision(parsed);
    if (decision) return decision;
  } catch {
    // Continue
  }

  // 2. Extract <tool_call> ... </tool_call> (Nemotron / Llama / DeepSeek / OpenRouter)
  const toolCallMatch = trimmed.match(/<tool_call>([\s\S]*?)<\/tool_call>/i) || trimmed.match(/<function_call>([\s\S]*?)<\/function_call>/i);
  if (toolCallMatch) {
    try {
      const parsed = JSON.parse(toolCallMatch[1].trim());
      const decision = validateAndMapDecision(parsed);
      if (decision) return decision;
    } catch {
      // Continue
    }
  }

  // 3. Extract embedded JSON object with "action", "name", "skill", or "tool"
  const jsonMatch = trimmed.match(/\{[\s\S]*?"(?:action|name|skill|tool)"\s*:\s*"(?:RESPOND|CALL_SKILL|DISPATCH_CAPABILITY|web_search|get_current_time|remember_fact|manage_tasks|execute_code)"[\s\S]*?\}/i);
  if (jsonMatch) {
    try {
      const parsed = JSON.parse(jsonMatch[0]);
      const decision = validateAndMapDecision(parsed);
      if (decision) return decision;
    } catch {
      // Continue
    }
  }

  // 4. CALL_SKILL textual format e.g. CALL_SKILL: web_search query="..."
  const callSkillTextMatch = trimmed.match(/CALL_SKILL\s*:\s*([a-z_]+)\s*(\([\s\S]*?\)|[\s\S]*)/i) || trimmed.match(/CALL_SKILL\s+([a-z_]+)([\s\S]*)/i);
  if (callSkillTextMatch) {
    const skillName = callSkillTextMatch[1].trim();
    let queryStr = callSkillTextMatch[2] ? callSkillTextMatch[2].trim() : "";
    let input: Record<string, unknown> = {};

    if (queryStr.startsWith("(") && queryStr.endsWith(")")) {
      queryStr = queryStr.slice(1, -1).trim();
    }
    if (queryStr.startsWith("{") && queryStr.endsWith("}")) {
      try {
        input = JSON.parse(queryStr);
      } catch {
        input = { query: queryStr };
      }
    } else if (queryStr) {
      const queryVal = queryStr.replace(/^query\s*=\s*["']?|["']?$/gi, "").trim();
      input = { query: queryVal || queryStr };
    }

    return { action: "CALL_SKILL", skill: skillName, input };
  }

  return null;
}
