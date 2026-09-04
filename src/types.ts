export type ChatRole = "system" | "user" | "assistant" | "tool";

export interface ChatMessage {
  role: ChatRole;
  content: string;
  /** Nom de la compétence, quand role === "tool" */
  name?: string;
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

export interface SkillDefinition {
  name: string;
  description: string;
  /** Description textuelle des arguments attendus (pas de JSON Schema pour rester simple/agnostique). */
  argsHint: string;
  handler: (input: Record<string, unknown>, ctx: SkillContext) => Promise<string>;
}

export interface SkillContext {
  rememberFact(entity: string, attribute: string, value: string): void;
}

export interface AgentStepResult {
  response: string;
  iterations: number;
}
