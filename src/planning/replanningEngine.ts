import type { LLMProvider } from "../llm/provider.js";
import type { ServiceRegistry } from "../orchestration/serviceRegistry.js";
import { validatePlanSteps, type ExecutionPlanNode, type PlanRun, type PlanStepSpec } from "./planner.js";
export interface ReplanningFacts { plan:PlanRun; completed:ExecutionPlanNode[]; failed:ExecutionPlanNode; remaining:ExecutionPlanNode[] }
export class ReplanningEngine { constructor(private llm:LLMProvider,private registry:ServiceRegistry){}
 async propose(facts:ReplanningFacts):Promise<PlanStepSpec[]>{const capabilities=[...new Set(this.registry.listServices().filter(s=>s.enabled).flatMap(s=>s.capabilities))];const payload={objective:facts.plan.objective,completed:facts.completed.map(n=>({title:n.title,result:n.result})),failed:{title:facts.failed.title,error:facts.failed.error,result:facts.failed.result},remaining:facts.remaining.map(n=>({title:n.title,capability:n.capability})),capabilities};const out=await this.llm.complete([{role:"system",content:"Return only a JSON array of replacement PlanStepSpec objects. No reasoning or prose."},{role:"user",content:JSON.stringify(payload)}],{temperature:0});let parsed:unknown;try{parsed=JSON.parse(out.content??"")}catch{throw new Error("INVALID_REPLAN_PROPOSAL")}return validatePlanSteps(parsed,this.registry);}
}
