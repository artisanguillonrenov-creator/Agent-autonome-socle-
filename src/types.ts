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
  name: string;
  description: string;
  /** Description textuelle des arguments attendus (pour rétrocompatibilité/affichage UI). */
  argsHint: string;
  /** Spécification JSON Schema native pour le Tool Calling OpenAI / OpenRouter. */
  parameters?: SkillParameterSchema;
  handler: (input: Record<string, unknown>, ctx: SkillContext) => Promise<string>;
}

export interface SkillContext {
  rememberFact(entity: string, attribute: string, value: string): void;
  serviceOrchestrator?: any;
}

export interface AgentStepResult {
  response: string;
  iterations: number;
}
