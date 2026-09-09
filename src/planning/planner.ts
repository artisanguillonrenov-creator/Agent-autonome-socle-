import { randomUUID } from "node:crypto";
import { getDb } from "../persistence/db.js";
import type { ServiceRegistry } from "../orchestration/serviceRegistry.js";
import type { PlanNode, PlanNodeStatus } from "../types.js";

export const PLAN_STATUSES = ["PENDING","RUNNING","WAITING_PERMISSION","BLOCKED","COMPLETED","FAILED","CANCELLED"] as const;
export type PlanRunStatus = typeof PLAN_STATUSES[number];
export const STEP_PRIORITIES = ["low","medium","high","urgent"] as const;
export type StepPriority = typeof STEP_PRIORITIES[number];
export type ExecutionNodeStatus = PlanNodeStatus | "waiting" | "failed" | "cancelled";
export interface PlanStepSpec { local_id:string; title:string; capability:string; objective:string; context:Record<string,unknown>; constraints:string[]; priority:StepPriority; depends_on:string[] }
export interface ExecutionPlanNode extends Omit<PlanNode,"status"> { status:ExecutionNodeStatus; planRunId?:string; position?:number; generation:number; capability?:string; objective?:string; context:Record<string,unknown>; constraints:string[]; priority?:StepPriority; dependencies:string[]; operationTaskId?:string; operationIdempotencyKey?:string; result?:string; error?:string; updatedAt:number; claimedAt?:number; attempt:number }
export interface PlanRun { id:string; rootNodeId:string; objective:string; status:PlanRunStatus; generation:number; replanCount:number; maxReplans:number; lastError?:string; createdAt:number; updatedAt:number }

const isObject=(v:unknown):v is Record<string,unknown>=>!!v&&typeof v==="object"&&!Array.isArray(v);
export function validatePlanSteps(input:unknown, registry:ServiceRegistry, maxSteps=50):PlanStepSpec[] {
  if(!Array.isArray(input)||input.length<1||input.length>maxSteps) throw new Error("INVALID_PLAN: step count");
  const ids=new Set<string>(); const steps:PlanStepSpec[]=[];
  for(const raw of input){
    if(!isObject(raw)) throw new Error("INVALID_PLAN: step must be an object");
    const local_id=typeof raw.local_id==="string"?raw.local_id.trim():"";
    const title=typeof raw.title==="string"?raw.title.trim():"";
    const capability=typeof raw.capability==="string"?raw.capability.trim():"";
    const objective=typeof raw.objective==="string"?raw.objective.trim():"";
    if(!local_id||ids.has(local_id)) throw new Error("INVALID_PLAN: local_id must be unique"); ids.add(local_id);
    if(!title||!objective||!capability||!isObject(raw.context)||!Array.isArray(raw.constraints)||!raw.constraints.every(x=>typeof x==="string")||!Array.isArray(raw.depends_on)||!raw.depends_on.every(x=>typeof x==="string")||!STEP_PRIORITIES.includes(raw.priority as StepPriority)) throw new Error(`INVALID_PLAN: malformed step ${local_id}`);
    if(!registry.findServiceForCapability(capability)) throw new Error(`INVALID_PLAN: unknown capability ${capability}`);
    steps.push({local_id,title,capability,objective,context:raw.context,constraints:raw.constraints as string[],priority:raw.priority as StepPriority,depends_on:raw.depends_on as string[]});
  }
  for(const s of steps) for(const d of s.depends_on) if(!ids.has(d)) throw new Error(`INVALID_PLAN: unknown dependency ${d}`);
  const map=new Map(steps.map(s=>[s.local_id,s])); const visiting=new Set<string>(),done=new Set<string>();
  const visit=(id:string)=>{if(visiting.has(id))throw new Error("INVALID_PLAN: dependency cycle");if(done.has(id))return;visiting.add(id);for(const d of map.get(id)!.depends_on)visit(d);visiting.delete(id);done.add(id);};
  for(const s of steps)visit(s.local_id); return steps;
}
function parse<T>(value:string|null,fallback:T):T{try{return value?JSON.parse(value) as T:fallback}catch{return fallback}}
function rowToNode(r:any):ExecutionPlanNode{return{id:r.id,parentId:r.parent_id,title:r.title,status:r.status,createdAt:r.created_at,planRunId:r.plan_run_id??undefined,position:r.position??undefined,generation:r.generation??0,capability:r.capability??undefined,objective:r.objective??undefined,context:parse(r.context_json,{}),constraints:parse(r.constraints_json,[]),priority:r.priority??undefined,dependencies:parse(r.dependencies_json,[]),operationTaskId:r.operation_task_id??undefined,operationIdempotencyKey:r.operation_idempotency_key??undefined,result:r.result??undefined,error:r.error??undefined,updatedAt:r.updated_at??r.created_at,claimedAt:r.claimed_at??undefined,attempt:r.attempt??1};}
function rowToRun(r:any):PlanRun{return{id:r.id,rootNodeId:r.root_node_id,objective:r.objective,status:r.status,generation:r.generation,replanCount:r.replan_count,maxReplans:r.max_replans,lastError:r.last_error??undefined,createdAt:r.created_at,updatedAt:r.updated_at};}

export class Planner {
 createNode(title:string,parentId:string|null=null):PlanNode{const n={id:randomUUID(),parentId,title,status:"pending" as const,createdAt:Date.now()};getDb().prepare(`INSERT INTO plan_nodes(id,parent_id,title,status,created_at,updated_at)VALUES(?,?,?,?,?,?)`).run(n.id,parentId,title,n.status,n.createdAt,n.createdAt);return n;}
 decompose(parentId:string,titles:string[]){return titles.map(t=>this.createNode(t,parentId));}
 setStatus(id:string,status:ExecutionNodeStatus){getDb().prepare(`UPDATE plan_nodes SET status=?,updated_at=? WHERE id=?`).run(status,Date.now(),id);}
 children(parentId:string|null):ExecutionPlanNode[]{return(getDb().prepare(`SELECT * FROM plan_nodes WHERE parent_id IS ? ORDER BY created_at`).all(parentId) as any[]).map(rowToNode);}
 regenerateBranch(id:string,titles:string[]){for(const n of this.children(id))this.setStatus(n.id,"abandoned");return this.decompose(id,titles);}
 all():ExecutionPlanNode[]{return(getDb().prepare(`SELECT * FROM plan_nodes ORDER BY created_at`).all() as any[]).map(rowToNode);}
 restore(nodes:PlanNode[]):void{if(!Array.isArray(nodes)||nodes.some(n=>!n||typeof n.id!=="string"||typeof n.title!=="string"||typeof n.createdAt!=="number"))throw new Error("INVALID_CHECKPOINT");const db=getDb();db.transaction(()=>{db.prepare(`DELETE FROM plan_nodes WHERE plan_run_id IS NULL`).run();const q=db.prepare(`INSERT INTO plan_nodes(id,parent_id,title,status,created_at,updated_at)VALUES(?,?,?,?,?,?)`);for(const n of nodes)q.run(n.id,n.parentId,n.title,n.status,n.createdAt,n.createdAt);})();}
 createExecutionPlan(objective:string,input:unknown,registry:ServiceRegistry,maxReplans=2):PlanRun{const steps=validatePlanSteps(input,registry);if(!objective.trim())throw new Error("INVALID_PLAN: objective");const db=getDb(),now=Date.now(),runId=randomUUID(),rootId=randomUUID();return db.transaction(()=>{db.prepare(`INSERT INTO plan_nodes(id,parent_id,title,status,created_at,updated_at,generation,plan_run_id)VALUES(?,?,?,?,?,?,?,?)`).run(rootId,null,objective,"in_progress",now,now,1,runId);db.prepare(`INSERT INTO plan_runs(id,root_node_id,objective,status,generation,replan_count,max_replans,created_at,updated_at)VALUES(?,?,?,?,?,?,?,?,?)`).run(runId,rootId,objective,"PENDING",1,0,maxReplans,now,now);const ids=new Map(steps.map(s=>[s.local_id,randomUUID()]));const q=db.prepare(`INSERT INTO plan_nodes(id,parent_id,title,status,created_at,plan_run_id,position,generation,capability,objective,context_json,constraints_json,priority,dependencies_json,updated_at,attempt)VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,1)`);steps.forEach((s,i)=>q.run(ids.get(s.local_id),rootId,s.title,"pending",now,runId,i,1,s.capability,s.objective,JSON.stringify(s.context),JSON.stringify(s.constraints),s.priority,JSON.stringify(s.depends_on.map(d=>ids.get(d))),now));return this.getRun(runId)!;})();}
 getRun(id:string){const r=getDb().prepare(`SELECT * FROM plan_runs WHERE id=?`).get(id);return r?rowToRun(r):null;}
 listRuns(){return(getDb().prepare(`SELECT * FROM plan_runs ORDER BY created_at DESC`).all() as any[]).map(rowToRun);}
 activeRuns(){return(getDb().prepare(`SELECT * FROM plan_runs WHERE status NOT IN ('COMPLETED','FAILED','CANCELLED') ORDER BY created_at`).all() as any[]).map(rowToRun);}
 nodes(runId:string){return(getDb().prepare(`SELECT * FROM plan_nodes WHERE plan_run_id=? AND capability IS NOT NULL ORDER BY generation,position,created_at`).all(runId) as any[]).map(rowToNode);}
 updateRun(id:string,status:PlanRunStatus,lastError?:string){getDb().prepare(`UPDATE plan_runs SET status=?,last_error=COALESCE(?,last_error),updated_at=? WHERE id=?`).run(status,lastError??null,Date.now(),id);}
}
