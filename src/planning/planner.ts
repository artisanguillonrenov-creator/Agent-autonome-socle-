import { randomUUID } from "node:crypto";
import { getDb } from "../persistence/db.js";
import type { ServiceRegistry } from "../orchestration/serviceRegistry.js";
import type { PlanNode, PlanNodeStatus } from "../types.js";
import { ActivityStore } from "../observability/activityStore.js";
import { WorkspaceStore } from "../workspaces/workspaceStore.js";
import { savePlanCheckpoint, loadPlanCheckpoint, listPlanCheckpoints, type PlanSnapshotState } from "../persistence/checkpoint.js";
import type { CheckpointSummary } from "../persistence/checkpoint.js";
import { hierarchicalPlanStepsArraySchema } from "../llm/schemas.js";

export const PLAN_STATUSES = ["PENDING","RUNNING","WAITING_PERMISSION","BLOCKED","CONSOLIDATING","COMPLETED","FAILED","CANCELLED"] as const;
export type PlanRunStatus = typeof PLAN_STATUSES[number];
export const STEP_PRIORITIES = ["low","medium","high","urgent"] as const;
export type StepPriority = typeof STEP_PRIORITIES[number];
export type ExecutionNodeStatus = PlanNodeStatus | "waiting" | "failed" | "cancelled";
export interface PlanStepSpec { local_id:string; title:string; capability:string; objective:string; context:Record<string,unknown>; constraints:string[]; priority:StepPriority; depends_on:string[] }
/** Entrée brute avant aplatissement — voir flattenHierarchicalSteps ci-dessous. */
export interface HierarchicalPlanStepSpec extends PlanStepSpec { sub_steps?: HierarchicalPlanStepSpec[] }
export interface ExecutionPlanNode extends Omit<PlanNode,"status"> { status:ExecutionNodeStatus; planRunId?:string; position?:number; generation:number; capability?:string; objective?:string; context:Record<string,unknown>; constraints:string[]; priority?:StepPriority; dependencies:string[]; operationTaskId?:string; operationIdempotencyKey?:string; result?:string; error?:string; updatedAt:number; claimedAt?:number; attempt:number; specialistId?:string }
export interface PlanRun { id:string; rootNodeId:string; objective:string; status:PlanRunStatus; generation:number; replanCount:number; maxReplans:number; workspaceId?:string; lastError?:string; createdAt:number; updatedAt:number; maxParallelism:number; peakParallelism:number; pendingReplanNodeId?:string; rollbackCount:number; maxRollbacks:number }

const isObject=(v:unknown):v is Record<string,unknown>=>!!v&&typeof v==="object"&&!Array.isArray(v);

const MAX_DECOMPOSITION_DEPTH = 3;

function collectAllLocalIds(steps: HierarchicalPlanStepSpec[], out = new Set<string>()): Set<string> {
  for (const step of steps) {
    if (out.has(step.local_id)) throw new Error("INVALID_PLAN: local_id must be unique");
    out.add(step.local_id);
    if (step.sub_steps?.length) collectAllLocalIds(step.sub_steps, out);
  }
  return out;
}

/**
 * Décomposition hiérarchique (façon LangGraph) : aplatit une arborescence de steps
 * imbriqués en un DAG plat de PlanStepSpec, réutilisable tel quel par le reste du
 * pipeline (validatePlanSteps, PlanRunner) sans aucun changement d'exécution. Un step
 * "composite" (sub_steps non vide) n'est jamais exécuté lui-même — son capability/
 * objective ne sert qu'à la lisibilité du plan proposé par le LLM ; il est entièrement
 * remplacé par ses descendants. Tout step qui dépendait du composite dépend désormais de
 * la "frontière" de sa sous-arborescence (les feuilles dont aucune autre feuille interne
 * ne dépend), afin que l'ordre d'exécution respecte la décomposition sans changer le
 * modèle de dépendances (toujours un simple DAG de local_id).
 */
export function flattenHierarchicalSteps(steps: HierarchicalPlanStepSpec[], depth = 1): PlanStepSpec[] {
  if (depth > MAX_DECOMPOSITION_DEPTH) throw new Error("INVALID_PLAN: decomposition depth exceeds max");
  const flat: PlanStepSpec[] = [];
  const frontierByCompositeId = new Map<string, string[]>();

  for (const step of steps) {
    if (step.sub_steps && step.sub_steps.length > 0) {
      const childFlat = flattenHierarchicalSteps(step.sub_steps, depth + 1);
      const childIds = new Set(childFlat.map((child) => child.local_id));
      for (const child of childFlat) {
        if (child.depends_on.length === 0) child.depends_on = [...step.depends_on];
      }
      const dependedUpon = new Set(childFlat.flatMap((child) => child.depends_on.filter((d) => childIds.has(d))));
      const frontier = childFlat.filter((child) => !dependedUpon.has(child.local_id)).map((child) => child.local_id);
      frontierByCompositeId.set(step.local_id, frontier);
      flat.push(...childFlat);
    } else {
      flat.push({
        local_id: step.local_id, title: step.title, capability: step.capability, objective: step.objective,
        context: step.context, constraints: step.constraints, priority: step.priority, depends_on: [...step.depends_on],
      });
    }
  }

  if (frontierByCompositeId.size > 0) {
    for (const s of flat) s.depends_on = s.depends_on.flatMap((d) => frontierByCompositeId.get(d) ?? [d]);
  }
  return flat;
}

/**
 * Vague 6B (guardrails Zod) : la forme structurelle de chaque étape (types, présence des
 * champs, priorité dans l'énumération autorisée, décomposition hiérarchique optionnelle
 * via sub_steps) est validée par le schéma Zod hierarchicalPlanStepsArraySchema — rejet
 * immédiat, avant toute autre logique. L'arborescence est ensuite aplatie
 * (flattenHierarchicalSteps) en un DAG plat avant que la sémantique propre au plan
 * (capacité connue du registre, dépendances résolues, absence de cycle) ne soit vérifiée
 * ici, car elle dépend de l'état runtime (ServiceRegistry) que Zod ignore. Un appel avec
 * des steps déjà plats (sans sub_steps, cas historique) traverse ce chemin sans aucun
 * changement de comportement.
 */
export function validatePlanSteps(input:unknown, registry:ServiceRegistry, maxSteps=50):PlanStepSpec[] {
  const parsed=hierarchicalPlanStepsArraySchema(maxSteps).safeParse(input);
  if(!parsed.success){const issue=parsed.error.issues[0];throw new Error(`INVALID_PLAN: ${issue?.path?.length?`${issue.path.join(".")}: `:""}${issue?.message??"malformed steps"}`);}
  const hierarchical=parsed.data as HierarchicalPlanStepSpec[];
  collectAllLocalIds(hierarchical);
  const steps=flattenHierarchicalSteps(hierarchical);
  if(steps.length>maxSteps) throw new Error(`INVALID_PLAN: decomposition produces ${steps.length} steps, exceeds maxSteps ${maxSteps}`);
  const ids=new Set<string>();
  for(const s of steps){if(ids.has(s.local_id)) throw new Error("INVALID_PLAN: local_id must be unique"); ids.add(s.local_id);}
  for(const s of steps) if(!registry.findServiceForCapability(s.capability)) throw new Error(`INVALID_PLAN: unknown capability ${s.capability}`);
  for(const s of steps) for(const d of s.depends_on) if(!ids.has(d)) throw new Error(`INVALID_PLAN: unknown dependency ${d}`);
  const map=new Map(steps.map(s=>[s.local_id,s])); const visiting=new Set<string>(),done=new Set<string>();
  const visit=(id:string)=>{if(visiting.has(id))throw new Error("INVALID_PLAN: dependency cycle");if(done.has(id))return;visiting.add(id);for(const d of map.get(id)!.depends_on)visit(d);visiting.delete(id);done.add(id);};
  for(const s of steps)visit(s.local_id); return steps;
}
export class InvalidPersistedPlanNodeError extends Error {
  readonly code = "INVALID_PERSISTED_PLAN_NODE";
  constructor(readonly planRunId: string | undefined) { super("INVALID_PERSISTED_PLAN_NODE"); }
}
const EXECUTION_STATUSES = new Set<ExecutionNodeStatus>(["pending","in_progress","done","abandoned","waiting","failed","cancelled"]);
function parseExecutionJson(value:unknown,kind:"object"|"strings"):Record<string,unknown>|string[]{
  if(typeof value!=="string")throw new Error();const parsed:unknown=JSON.parse(value);
  if(kind==="object"&&isObject(parsed))return parsed;
  if(kind==="strings"&&Array.isArray(parsed)&&parsed.every(item=>typeof item==="string"))return parsed;
  throw new Error();
}
function rowToNode(r:any):ExecutionPlanNode{
  if(r.plan_run_id==null)return{id:r.id,parentId:r.parent_id,title:r.title,status:r.status,createdAt:r.created_at,generation:r.generation??0,context:{},constraints:[],dependencies:[],updatedAt:r.updated_at??r.created_at,attempt:r.attempt??1};
  try{
    if(typeof r.id!=="string"||!r.id||typeof r.plan_run_id!=="string"||!r.plan_run_id||!EXECUTION_STATUSES.has(r.status)||!Number.isInteger(r.generation)||r.generation<1||!Number.isInteger(r.position)||r.position<0||typeof r.capability!=="string"||!r.capability.trim()||typeof r.objective!=="string"||!r.objective.trim()||!STEP_PRIORITIES.includes(r.priority)||!Number.isInteger(r.attempt)||r.attempt<1||(r.operation_task_id!==null&&(typeof r.operation_task_id!=="string"||!r.operation_task_id))||(r.operation_idempotency_key!==null&&(typeof r.operation_idempotency_key!=="string"||!r.operation_idempotency_key)))throw new Error();
    return{id:r.id,parentId:r.parent_id,title:r.title,status:r.status,createdAt:r.created_at,planRunId:r.plan_run_id,position:r.position,generation:r.generation,capability:r.capability,objective:r.objective,context:parseExecutionJson(r.context_json,"object") as Record<string,unknown>,constraints:parseExecutionJson(r.constraints_json,"strings") as string[],priority:r.priority,dependencies:parseExecutionJson(r.dependencies_json,"strings") as string[],operationTaskId:r.operation_task_id??undefined,operationIdempotencyKey:r.operation_idempotency_key??undefined,result:r.result??undefined,error:r.error??undefined,updatedAt:r.updated_at,claimedAt:r.claimed_at??undefined,attempt:r.attempt,specialistId:r.specialist_id??undefined};
  }catch{throw new InvalidPersistedPlanNodeError(typeof r.plan_run_id==="string"?r.plan_run_id:undefined);}
}
function rowToRun(r:any):PlanRun{return{id:r.id,rootNodeId:r.root_node_id,objective:r.objective,status:r.status,generation:r.generation,replanCount:r.replan_count,maxReplans:r.max_replans,workspaceId:r.workspace_id??undefined,lastError:r.last_error??undefined,createdAt:r.created_at,updatedAt:r.updated_at,maxParallelism:r.max_parallelism??1,peakParallelism:r.peak_parallelism??0,pendingReplanNodeId:r.pending_replan_node_id??undefined,rollbackCount:r.rollback_count??0,maxRollbacks:r.max_rollbacks??1};}

export class Planner {
 createNode(title:string,parentId:string|null=null):PlanNode{const n={id:randomUUID(),parentId,title,status:"pending" as const,createdAt:Date.now()};getDb().prepare(`INSERT INTO plan_nodes(id,parent_id,title,status,created_at,updated_at)VALUES(?,?,?,?,?,?)`).run(n.id,parentId,title,n.status,n.createdAt,n.createdAt);return n;}
 decompose(parentId:string,titles:string[]){return titles.map(t=>this.createNode(t,parentId));}
 setStatus(id:string,status:ExecutionNodeStatus){getDb().prepare(`UPDATE plan_nodes SET status=?,updated_at=? WHERE id=?`).run(status,Date.now(),id);}
 children(parentId:string|null):ExecutionPlanNode[]{return(getDb().prepare(`SELECT * FROM plan_nodes WHERE parent_id IS ? ORDER BY created_at`).all(parentId) as any[]).map(rowToNode);}
 regenerateBranch(id:string,titles:string[]){for(const n of this.children(id))this.setStatus(n.id,"abandoned");return this.decompose(id,titles);}
 all():ExecutionPlanNode[]{return(getDb().prepare(`SELECT * FROM plan_nodes ORDER BY created_at`).all() as any[]).map(rowToNode);}
 legacyNodes():PlanNode[]{return(getDb().prepare(`SELECT * FROM plan_nodes WHERE plan_run_id IS NULL AND id NOT IN (SELECT root_node_id FROM plan_runs) ORDER BY created_at`).all() as any[]).map(rowToNode) as PlanNode[];}
 restore(nodes:PlanNode[]):void{if(!Array.isArray(nodes))throw new Error("INVALID_CHECKPOINT");const db=getDb();db.transaction(()=>{db.prepare(`DELETE FROM plan_nodes WHERE plan_run_id IS NULL AND id NOT IN (SELECT root_node_id FROM plan_runs)`).run();const q=db.prepare(`INSERT INTO plan_nodes(id,parent_id,title,status,created_at,updated_at)VALUES(?,?,?,?,?,?)`);for(const n of nodes)q.run(n.id,n.parentId,n.title,n.status,n.createdAt,n.createdAt);})();}
 createExecutionPlan(objective:string,input:unknown,registry:ServiceRegistry,maxReplans=2,maxParallelism?:number):PlanRun{const steps=validatePlanSteps(input,registry);if(!objective.trim())throw new Error("INVALID_PLAN: objective");const db=getDb(),now=Date.now(),runId=randomUUID(),rootId=randomUUID();return db.transaction(()=>{const workspace=new WorkspaceStore().create({name:objective,ownerType:"PLAN_RUN",ownerId:runId});db.prepare(`INSERT INTO plan_nodes(id,parent_id,title,status,created_at,updated_at,generation)VALUES(?,?,?,?,?,?,?)`).run(rootId,null,objective,"in_progress",now,now,1);db.prepare(`INSERT INTO plan_runs(id,root_node_id,objective,status,generation,replan_count,max_replans,workspace_id,max_parallelism,created_at,updated_at)VALUES(?,?,?,?,?,?,?,?,?,?,?)`).run(runId,rootId,objective,"PENDING",1,0,maxReplans,workspace.id,Math.min(Math.max(maxParallelism??3,1),8),now,now);const ids=new Map(steps.map(s=>[s.local_id,randomUUID()]));const q=db.prepare(`INSERT INTO plan_nodes(id,parent_id,title,status,created_at,plan_run_id,position,generation,capability,objective,context_json,constraints_json,priority,dependencies_json,updated_at,attempt)VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,1)`);steps.forEach((s,i)=>q.run(ids.get(s.local_id),rootId,s.title,"pending",now,runId,i,1,s.capability,s.objective,JSON.stringify(s.context),JSON.stringify(s.constraints),s.priority,JSON.stringify(s.depends_on.map(d=>ids.get(d))),now));const run=this.getRun(runId)!;new ActivityStore().append({dedupeKey:`plan-created:${runId}`,planRunId:runId,eventType:"PLAN_CREATED",message:"Mission plan created"});return run;})();}
 getRun(id:string){const r=getDb().prepare(`SELECT * FROM plan_runs WHERE id=?`).get(id);return r?rowToRun(r):null;}
 listRuns(){return(getDb().prepare(`SELECT * FROM plan_runs ORDER BY created_at DESC`).all() as any[]).map(rowToRun);}
 activeRuns(){return(getDb().prepare(`SELECT * FROM plan_runs WHERE status NOT IN ('COMPLETED','FAILED','CANCELLED') ORDER BY created_at`).all() as any[]).map(rowToRun);}
 nodes(runId:string){return(getDb().prepare(`SELECT * FROM plan_nodes WHERE plan_run_id=? AND capability IS NOT NULL ORDER BY generation,position,created_at`).all(runId) as any[]).map(rowToNode);}
 updateRun(id:string,status:PlanRunStatus,lastError?:string){getDb().prepare(`UPDATE plan_runs SET status=?,last_error=COALESCE(?,last_error),updated_at=? WHERE id=?`).run(status,lastError??null,Date.now(),id);}
 /**
  * Co-édition humaine : fusionne `patch` dans le contexte JSON persisté d'un nœud sans
  * toucher à son statut ni à ses dépendances — permet d'injecter une nouvelle information
  * (ex: contenu d'artefact modifié par l'utilisateur) dans une étape déjà planifiée, avant
  * son (re)dispatch, sans relancer le plan depuis zéro.
  */
 /**
  * Vague 6A (versioning / rollback) : sauvegarde un instantané cohérent (état N) du plan
  * avant d'engager une branche ou une action jugée risquée. Réutilise le mécanisme de
  * checkpoint PLAN_EXECUTION déjà existant (savePlanCheckpoint) — un simple alias nommé
  * pour exprimer l'intention "snapshot avant risque" au niveau de l'appelant.
  */
 snapshot(runId:string,label?:string):string{return savePlanCheckpoint(runId,this,label);}
 listSnapshots(runId:string):CheckpointSummary[]{return listPlanCheckpoints(runId);}
 /**
  * Restaure le plan `runId` à l'état persisté dans l'instantané `checkpointId` (état N-1) :
  * les nœuds non racine de la génération courante sont remplacés par ceux du snapshot,
  * remis en file ("pending") pour que PlanRunner les redispatche proprement — les acquis
  * (nœuds "done" au moment du snapshot) sont conservés tels quels, rien n'est rejoué.
  * Incrémente rollback_count ; l'appelant (PlanRunner) est responsable de respecter
  * max_rollbacks pour ne jamais boucler indéfiniment.
  */
 rollback(runId:string,checkpointId:string):PlanSnapshotState|null{
  const snapshot=loadPlanCheckpoint(checkpointId);
  if(!snapshot||snapshot.planRun.id!==runId)return null;
  const db=getDb();
  db.transaction(()=>{
   db.prepare(`DELETE FROM plan_nodes WHERE plan_run_id=? AND capability IS NOT NULL`).run(runId);
   const q=db.prepare(`INSERT INTO plan_nodes(id,parent_id,title,status,created_at,plan_run_id,position,generation,capability,objective,context_json,constraints_json,priority,dependencies_json,operation_task_id,operation_idempotency_key,result,error,updated_at,claimed_at,attempt,specialist_id)VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`);
   const now=Date.now();
   for(const raw of snapshot.nodes as ExecutionPlanNode[]){
    // Un nœud N-1 qui n'était pas "done" est remis "pending" : son éventuelle opération
    // externe associée au moment du snapshot est abandonnée (operation_task_id effacé),
    // jamais réutilisée telle quelle — évite tout doublon d'effet de bord au redispatch.
    const restoredStatus=raw.status==="done"||raw.status==="abandoned"||raw.status==="cancelled"?raw.status:"pending";
    // Un nouvel essai doit porter une idempotency key inédite (attempt incrémenté) : sinon
    // le redispatch retomberait sur l'OperationStore existant déjà marqué FAILED pour la
    // même clé et renverrait immédiatement le même échec au lieu de retenter.
    const attempt=restoredStatus==="pending"?(raw.attempt??1)+1:raw.attempt??1;
    q.run(raw.id,raw.parentId,raw.title,restoredStatus,raw.createdAt,runId,raw.position??0,raw.generation,raw.capability??null,raw.objective??null,JSON.stringify(raw.context??{}),JSON.stringify(raw.constraints??[]),raw.priority??null,JSON.stringify(raw.dependencies??[]),restoredStatus==="pending"?null:raw.operationTaskId??null,restoredStatus==="pending"?null:raw.operationIdempotencyKey??null,raw.result??null,restoredStatus==="pending"?null:raw.error??null,now,null,attempt,restoredStatus==="pending"?null:raw.specialistId??null);
   }
   db.prepare(`UPDATE plan_runs SET status='RUNNING',generation=?,pending_replan_node_id=NULL,rollback_count=rollback_count+1,last_error=?,updated_at=? WHERE id=?`).run(snapshot.generation,"ROLLED_BACK_TO_SNAPSHOT",now,runId);
  })();
  new ActivityStore().append({dedupeKey:`plan-rolled-back:${runId}:${checkpointId}`,planRunId:runId,eventType:"PLAN_ROLLED_BACK",message:`Mission rolled back to snapshot ${checkpointId}`,metadata:{checkpointId,generation:snapshot.generation}});
  return snapshot;
 }
 mergeContext(id:string,patch:Record<string,unknown>):void{
  const row=getDb().prepare(`SELECT context_json FROM plan_nodes WHERE id=?`).get(id) as {context_json:string|null}|undefined;
  if(!row)return;
  let context:Record<string,unknown>={};
  try{const parsed=JSON.parse(row.context_json??"{}");if(parsed&&typeof parsed==="object"&&!Array.isArray(parsed))context=parsed;}catch{context={};}
  getDb().prepare(`UPDATE plan_nodes SET context_json=?,updated_at=? WHERE id=?`).run(JSON.stringify({...context,...patch}),Date.now(),id);
 }
}
