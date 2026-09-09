import { randomUUID } from "node:crypto";
import { getDb } from "../persistence/db.js";
import type { ServiceOrchestrator } from "../orchestration/serviceOrchestrator.js";
import { savePlanCheckpoint } from "../persistence/checkpoint.js";
import { Planner, type ExecutionPlanNode, type PlanRun } from "./planner.js";
import type { ReplanningEngine } from "./replanningEngine.js";

const LIVE=new Set(["QUEUED","DISPATCHING","RUNNING"]);
export class PlanRunner {
 private timer?:NodeJS.Timeout; private ticking=false;
 constructor(readonly orchestrator:ServiceOrchestrator,readonly planner=new Planner(),private replanning?:ReplanningEngine,private intervalMs=500){}
 start(){this.recover();this.timer=setInterval(()=>void this.tick(),this.intervalMs);this.timer.unref?.();}
 stop(){if(this.timer)clearInterval(this.timer);}
 recover(){getDb().prepare(`UPDATE plan_nodes SET claimed_at=NULL WHERE plan_run_id IS NOT NULL AND status='in_progress' AND operation_task_id IS NULL`).run();}
 async tick(){if(this.ticking)return;this.ticking=true;try{for(const run of this.planner.activeRuns()){try{await this.reconcile(run);}catch(error){this.planner.updateRun(run.id,"BLOCKED",error instanceof Error&&error.message==="INVALID_PERSISTED_PLAN_NODE"?"INVALID_PERSISTED_PLAN_NODE":"PLAN_RECONCILIATION_FAILED");}}}finally{this.ticking=false;}}
 private async reconcile(run:PlanRun){const nodes=this.planner.nodes(run.id);const active=nodes.filter(n=>n.status==="in_progress"||n.status==="waiting");
  if(active.length){await this.observe(run,active[0]);return;}
  const current=nodes.filter(n=>n.status!=="abandoned"&&n.status!=="cancelled");
  const pending=current.filter(n=>n.status==="pending");
  if(!pending.length){const unreplacedFailure=current.some(n=>n.status==="failed"&&n.generation===run.generation);if(unreplacedFailure){this.planner.updateRun(run.id,"FAILED");return;}this.planner.updateRun(run.id,"COMPLETED");this.planner.setStatus(run.rootNodeId,"done");return;}
  const done=new Set(nodes.filter(n=>n.status==="done").map(n=>n.id));const ready=current.filter(n=>n.status==="pending"&&n.dependencies.every(d=>done.has(d))).sort((a,b)=>(a.position??0)-(b.position??0))[0];
  if(!ready){this.planner.updateRun(run.id,"BLOCKED","NO_EXECUTABLE_STEP");return;}
  if(!this.orchestrator.registry.findServiceForCapability(ready.capability!)){this.planner.updateRun(run.id,"BLOCKED","INVALID_PERSISTED_PLAN_NODE");return;}
  await this.dispatch(run,ready);
 }
 private async dispatch(run:PlanRun,node:ExecutionPlanNode){const db=getDb(),key=node.operationIdempotencyKey??`plan:${run.id}:node:${node.id}:attempt:${node.attempt}`;const now=Date.now();const claimed=db.prepare(`UPDATE plan_nodes SET status='in_progress',claimed_at=?,operation_idempotency_key=?,updated_at=? WHERE id=? AND status='pending' AND operation_task_id IS NULL`).run(now,key,now,node.id).changes;if(!claimed)return;
  let op=this.orchestrator.store.getByIdempotencyKey(key);if(!op){const result=await this.orchestrator.dispatchCapability({action:"DISPATCH_CAPABILITY",capability:node.capability!,objective:node.objective!,context:node.context,constraints:node.constraints,priority:node.priority},{executionMode:"background",idempotencyKey:key,traceId:`plan-${run.id}`,workspaceId:run.workspaceId});op=this.orchestrator.store.getOperation(result.taskId);}
  if(!op){this.failNode(run,node,"OPERATION_NOT_PERSISTED",false);return;}db.prepare(`UPDATE plan_nodes SET operation_task_id=?,updated_at=? WHERE id=?`).run(op.taskId,Date.now(),node.id);this.planner.updateRun(run.id,op.status==="WAITING_PERMISSION"?"WAITING_PERMISSION":"RUNNING");await this.observe(run,{...node,status:"in_progress",operationTaskId:op.taskId,operationIdempotencyKey:key});
 }
 private async observe(run:PlanRun,node:ExecutionPlanNode){let op=node.operationTaskId?this.orchestrator.store.getOperation(node.operationTaskId):null;if(!op&&node.operationIdempotencyKey){op=this.orchestrator.store.getByIdempotencyKey(node.operationIdempotencyKey);if(op)getDb().prepare(`UPDATE plan_nodes SET operation_task_id=?,updated_at=? WHERE id=?`).run(op.taskId,Date.now(),node.id);}if(!op){this.planner.setStatus(node.id,"pending");return;}
  if(LIVE.has(op.status)){this.planner.updateRun(run.id,"RUNNING");return;}if(op.status==="WAITING_PERMISSION"){this.planner.setStatus(node.id,"waiting");this.planner.updateRun(run.id,"WAITING_PERMISSION");return;}if(op.status==="WAITING_INPUT"){this.planner.setStatus(node.id,"waiting");this.planner.updateRun(run.id,"BLOCKED","WAITING_INPUT");return;}if(op.status==="COMPLETED"){getDb().prepare(`UPDATE plan_nodes SET status='done',result=?,claimed_at=NULL,updated_at=? WHERE id=?`).run(op.result??null,Date.now(),node.id);this.planner.updateRun(run.id,"RUNNING");return;}if(op.status==="REJECTED"||op.status==="CANCELLED"){this.failNode(run,node,op.error??op.status,false,"BLOCKED");return;}
  if(op.status==="FAILED"){const unknown=(op.error??"").includes("TRANSPORT_UNKNOWN")||(op.error??"").includes("INTERRUPTED_EXECUTION_STATE_UNKNOWN");const event=this.orchestrator.store.listEvents(op.taskId).filter(e=>e.type==="TASK_FAILED").at(-1);const safe=!unknown&&event?.payload.replannable===true&&event.payload.side_effect_state==="none";if(!safe){this.failNode(run,node,op.error??"UNSAFE_FAILURE",false,unknown?"BLOCKED":"FAILED");return;}await this.replan(run,node,op.error??JSON.stringify(event.payload));}
 }
 private failNode(run:PlanRun,node:ExecutionPlanNode,error:string,_replan:boolean,status:"FAILED"|"BLOCKED"="FAILED"){getDb().prepare(`UPDATE plan_nodes SET status='failed',error=?,claimed_at=NULL,updated_at=? WHERE id=?`).run(error,Date.now(),node.id);this.planner.updateRun(run.id,status,error);}
 private async replan(run:PlanRun,node:ExecutionPlanNode,error:string){
  if(!this.replanning||run.replanCount>=run.maxReplans){this.failNode(run,node,error,false,"FAILED");return;}
  const all=this.planner.nodes(run.id),affectedIds=new Set([node.id]);let changed=true;
  while(changed){changed=false;for(const candidate of all){if(candidate.status==="pending"&&!affectedIds.has(candidate.id)&&candidate.dependencies.some(dependency=>affectedIds.has(dependency))){affectedIds.add(candidate.id);changed=true;}}}
  const failed={...node,status:"failed" as const,error};
  const affected=[failed,...all.filter(candidate=>candidate.id!==node.id&&affectedIds.has(candidate.id))];
  const preservedPending=all.filter(candidate=>candidate.status==="pending"&&!affectedIds.has(candidate.id));
  const completed=all.filter(candidate=>candidate.status==="done");
  const externalDependencies=new Set<string>();
  for(const candidate of affected)for(const dependency of candidate.dependencies){const target=all.find(existing=>existing.id===dependency);if(!affectedIds.has(dependency)&&target&&target.status!=="done"&&target.status!=="abandoned"&&target.status!=="cancelled"&&target.status!=="failed")externalDependencies.add(dependency);}
  const capabilities=[...new Set(this.orchestrator.registry.listServices().filter(service=>service.enabled).flatMap(service=>service.capabilities))];
  savePlanCheckpoint(run.id,this.planner);let specs;
  try{specs=await this.replanning.propose({objective:run.objective,completed,failed,affected,preservedPending,capabilities});}catch(e){this.failNode(run,node,`REPLAN_FAILED: ${(e as Error).message}`,false,"FAILED");return;}
  const normalize=(value:string)=>value.normalize("NFKC").trim().replace(/\s+/g," ").toLocaleLowerCase();
  const preservedSignatures=new Set(preservedPending.map(candidate=>`${normalize(candidate.capability!)}\u0000${normalize(candidate.objective!)}`));
  if(specs.some(spec=>preservedSignatures.has(`${normalize(spec.capability)}\u0000${normalize(spec.objective)}`))){this.failNode(run,node,"REPLAN_DUPLICATES_PRESERVED_STEP",false,"FAILED");return;}
  const obsolete=[...affectedIds].filter(id=>id!==node.id),db=getDb(),now=Date.now(),generation=run.generation+1;
  db.transaction(()=>{const abandon=db.prepare(`UPDATE plan_nodes SET status='abandoned',updated_at=? WHERE id=? AND status='pending'`);for(const id of obsolete)abandon.run(now,id);db.prepare(`UPDATE plan_nodes SET status='failed',error=?,claimed_at=NULL,updated_at=? WHERE id=? AND status!='done'`).run(error,now,node.id);const ids=new Map(specs.map(spec=>[spec.local_id,randomUUID()]));const q=db.prepare(`INSERT INTO plan_nodes(id,parent_id,title,status,created_at,plan_run_id,position,generation,capability,objective,context_json,constraints_json,priority,dependencies_json,updated_at,attempt)VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,1)`);specs.forEach((spec,index)=>{const dependencies:string[]=spec.depends_on.map(dependency=>ids.get(dependency)!);if(spec.depends_on.length===0)dependencies.push(...externalDependencies);q.run(ids.get(spec.local_id),run.rootNodeId,spec.title,"pending",now,run.id,index,generation,spec.capability,spec.objective,JSON.stringify(spec.context),JSON.stringify(spec.constraints),spec.priority,JSON.stringify([...new Set(dependencies)]),now);});db.prepare(`UPDATE plan_runs SET status='RUNNING',generation=?,replan_count=replan_count+1,last_error=?,updated_at=? WHERE id=?`).run(generation,error,now,run.id);})();
 }
 cancel(runId:string){const run=this.planner.getRun(runId);if(!run)return null;let uncertain=false;for(const n of this.planner.nodes(runId)){if(n.status==="pending")this.planner.setStatus(n.id,"cancelled");if(n.operationTaskId&&(n.status==="in_progress"||n.status==="waiting")){const r=this.orchestrator.store.cancel(n.operationTaskId);if(r&&!r.cancelled)uncertain=true;else this.planner.setStatus(n.id,"cancelled");}}this.planner.updateRun(runId,uncertain?"BLOCKED":"CANCELLED",uncertain?"CANCELLATION_REQUESTED_OPERATION_IN_PROGRESS":undefined);if(!uncertain)this.planner.setStatus(run.rootNodeId,"cancelled");return this.planner.getRun(runId);}
}
