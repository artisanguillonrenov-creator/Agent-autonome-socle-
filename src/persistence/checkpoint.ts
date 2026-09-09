import { randomUUID } from "node:crypto";
import { getDb } from "./db.js";
import type { ChatMessage, PlanNode } from "../types.js";
import type { Planner } from "../planning/planner.js";
export interface CheckpointState { workingMemory:ChatMessage[]; planNodes:PlanNode[]; stepCount:number }
export interface CheckpointSummary { id:string;label:string;createdAt:number;kind:"AGENT_STATE"|"PLAN_EXECUTION";scopeId?:string;schemaVersion:number }
const object=(v:unknown):v is Record<string,unknown>=>!!v&&typeof v==="object"&&!Array.isArray(v);
export function isCheckpointState(v:unknown):v is CheckpointState{return object(v)&&Array.isArray(v.workingMemory)&&Array.isArray(v.planNodes)&&typeof v.stepCount==="number"&&v.planNodes.every(n=>object(n)&&typeof n.id==="string"&&typeof n.title==="string"&&typeof n.createdAt==="number");}
export function saveCheckpoint(label:string,state:CheckpointState){const id=randomUUID();getDb().prepare(`INSERT INTO checkpoints(id,label,created_at,state,kind,schema_version)VALUES(?,?,?,?,?,?)`).run(id,label,Date.now(),JSON.stringify(state),"AGENT_STATE",1);return id;}
export function savePlanCheckpoint(planRunId:string,planner:Planner){const run=planner.getRun(planRunId);if(!run)throw new Error("PLAN_NOT_FOUND");const id=randomUUID();getDb().prepare(`INSERT INTO checkpoints(id,label,created_at,state,kind,scope_id,schema_version)VALUES(?,?,?,?,?,?,?)`).run(id,`Plan ${planRunId} generation ${run.generation}`,Date.now(),JSON.stringify({planRun:run,nodes:planner.nodes(planRunId),generation:run.generation}),"PLAN_EXECUTION",planRunId,1);return id;}
export function loadCheckpoint(id:string):CheckpointState|null{const row=getDb().prepare(`SELECT state,kind FROM checkpoints WHERE id=?`).get(id) as {state:string;kind:string}|undefined;if(!row||row.kind!=="AGENT_STATE")return null;let parsed:unknown;try{parsed=JSON.parse(row.state)}catch{return null}return isCheckpointState(parsed)?parsed:null;}
export function listCheckpoints():CheckpointSummary[]{return(getDb().prepare(`SELECT id,label,created_at createdAt,kind,scope_id scopeId,schema_version schemaVersion FROM checkpoints ORDER BY created_at DESC`).all() as CheckpointSummary[]);}
