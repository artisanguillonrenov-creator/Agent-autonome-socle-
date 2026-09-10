import type { LLMProvider } from "../llm/provider.js";
import type { ServiceRegistry } from "../orchestration/serviceRegistry.js";
import { validatePlanSteps, type ExecutionPlanNode, type PlanStepSpec } from "./planner.js";

export interface ReplanningFacts {
  objective: string;
  completed: ExecutionPlanNode[];
  failed: ExecutionPlanNode;
  affected: ExecutionPlanNode[];
  preservedPending: ExecutionPlanNode[];
  capabilities: string[];
}

export class ReplanningEngine {
  constructor(private llm: LLMProvider, private registry: ServiceRegistry) {}

  /** Permet à Agent.setLLMProvider() de propager le nouveau fournisseur jusqu'ici. */
  setLLMProvider(llm: LLMProvider): void {
    this.llm = llm;
  }

  async propose(facts: ReplanningFacts): Promise<PlanStepSpec[]> {
    const payload = {
      objective: facts.objective,
      completed: facts.completed.map((node) => ({ title: node.title, result: node.result })),
      failed: { title: facts.failed.title, capability: facts.failed.capability, error: facts.failed.error, result: facts.failed.result },
      affected: facts.affected.map((node) => ({ title: node.title, capability: node.capability, objective: node.objective })),
      preservedPending: facts.preservedPending.map((node) => ({ title: node.title, capability: node.capability, objective: node.objective })),
      capabilities: facts.capabilities,
    };
    const result = await this.llm.complete([
      { role: "system", content: "Return only a JSON array of replacement PlanStepSpec objects. Return replacement steps ONLY for the affected branch. Preserved pending steps already exist and MUST NOT be recreated. No reasoning or prose." },
      { role: "user", content: JSON.stringify(payload) },
    ], { temperature: 0 });
    let parsed: unknown;
    try { parsed = JSON.parse(result.content ?? ""); } catch { throw new Error("INVALID_REPLAN_PROPOSAL"); }
    return validatePlanSteps(parsed, this.registry);
  }
}
