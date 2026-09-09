export type ChatRole = "system" | "user" | "assistant" | "tool";

export interface ToolCall {
  id: string;
  type: "function";
  function: {
    name: string;
    arguments: string;
  };
}

export interface ChatMessage {
  role: ChatRole;
  content: string | null;
  /** Nom de la compétence, quand role === "tool" */
  name?: string;
  /** Identifiant unique de l'appel de tool, quand role === "tool" */
  toolCallId?: string;
  /** Liste des appels d'outils générés par l'assistant, quand role === "assistant" */
  toolCalls?: ToolCall[];
}

export interface MemoryEntry {
  id: string;
  text: string;
  /** "episodic" (événement brut) | "reflection" (enseignement de haut niveau) */
  kind: "episodic" | "reflection";
  createdAt: number;
  embedding: number[];
}

export interface Fact {
  entity: string;
  attribute: string;
  value: string;
  updatedAt: number;
}

export interface UserPreference {
  key: string;
  value: string;
  updatedAt: number;
}

export type PlanNodeStatus = "pending" | "in_progress" | "done" | "abandoned";

export interface PlanNode {
  id: string;
  parentId: string | null;
  title: string;
  status: PlanNodeStatus;
  createdAt: number;
}

export type TaskStatus = "pending" | "done";

export interface TaskItem {
  id: string;
  title: string;
  status: TaskStatus;
  /** Timestamp epoch ms de l'échéance/rappel, ou null si aucune. */
  dueAt: number | null;
  createdAt: number;
  taskType?: "REMINDER" | "DISPATCH" | "WATCH";
  enabled?: boolean;
  repeatIntervalMs?: number;
  nextRunAt?: number | null;
  lastRunAt?: number;
  lastResultHash?: string;
  lastError?: string;
}

export interface SkillParameterSchema {
  type: "object";
  properties: Record<string, unknown>;
  required?: string[];
  additionalProperties?: boolean;
}

export interface SkillDefinition {
  id?: string;
  name: string;
  displayName?: string;
  description: string;
  category?: SkillCategory;
  kind?: SkillKind;
  availability?: SkillAvailability;
  exposure?: SkillExposure;
  risk?: SkillRisk;
  executionTarget?: SkillExecutionTarget;
  serviceCapability?: string;
  aliases?: string[];
  tags?: string[];
  requiresWorkspace?: boolean;
  requiresConnector?: boolean;
  unavailableReason?: string;
  defaultEnabled?: boolean;
  /** Description textuelle des arguments attendus (pour rétrocompatibilité/affichage UI). */
  argsHint: string;
  /** Spécification JSON Schema native pour le Tool Calling OpenAI / OpenRouter. */
  parameters?: SkillParameterSchema;
  handler?: (input: Record<string, unknown>, ctx: SkillContext) => Promise<string>;
}

export type SkillKind = "SKILL" | "WORKFLOW" | "INTERNAL" | "FUTURE" | "SYSTEM" | "LEGACY";
export type SkillAvailability = "AVAILABLE" | "UNAVAILABLE" | "DISABLED";
export type SkillExposure = "ALWAYS" | "DYNAMIC" | "NEVER";
export type SkillRisk = "LOW" | "MEDIUM" | "HIGH" | "CRITICAL";
export type SkillExecutionTarget = "LOCAL_HANDLER" | "SERVICE_CAPABILITY" | "WORKFLOW" | "INTERNAL";
export type SkillCategory = "Contrôle" | "Recherche" | "Fichiers" | "Communication" | "Technique" | "Workflows" | "Interne" | "Futur";

export interface SkillContext {
  rememberFact(entity: string, attribute: string, value: string): void;
  serviceOrchestrator?: any;
  planner?: any;
  skillRegistry?: any;
}

export interface AgentStepResult {
  response: string;
  iterations: number;
}
