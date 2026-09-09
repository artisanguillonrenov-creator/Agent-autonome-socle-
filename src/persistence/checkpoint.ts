import { randomUUID } from "node:crypto";
import { getDb } from "./db.js";
import type { ChatMessage, PlanNode, ToolCall } from "../types.js";
import type { Planner } from "../planning/planner.js";

export interface CheckpointState { workingMemory: ChatMessage[]; planNodes: PlanNode[]; stepCount: number }
export interface CheckpointSummary { id:string; label:string; createdAt:number; kind:"AGENT_STATE"|"PLAN_EXECUTION"; scopeId?:string; schemaVersion:number }
const CHAT_ROLES=new Set(["system","user","assistant","tool"]);
const LEGACY_NODE_STATUSES=new Set(["pending","in_progress","done","abandoned"]);
const object=(value:unknown):value is Record<string,unknown>=>value!==null&&typeof value==="object"&&!Array.isArray(value);
function validToolCall(value:unknown):value is ToolCall{return object(value)&&typeof value.id==="string"&&value.id.length>0&&value.type==="function"&&object(value.function)&&typeof value.function.name==="string"&&value.function.name.length>0&&typeof value.function.arguments==="string";}
function validMessage(value:unknown):value is ChatMessage{
  if(!object(value)||typeof value.role!=="string"||!CHAT_ROLES.has(value.role)||(value.content!==null&&typeof value.content!=="string"))return false;
  if(value.role==="tool")return typeof value.name==="string"&&value.name.length>0&&typeof value.toolCallId==="string"&&value.toolCallId.length>0&&value.toolCalls===undefined;
  if(value.name!==undefined||value.toolCallId!==undefined)return false;
  if(value.toolCalls!==undefined){if(value.role!=="assistant"||!Array.isArray(value.toolCalls)||!value.toolCalls.every(validToolCall))return false;const ids=value.toolCalls.map(call=>(call as ToolCall).id);if(new Set(ids).size!==ids.length)return false;}
  return true;
}
function validLegacyNode(value:unknown):value is PlanNode{return object(value)&&typeof value.id==="string"&&value.id.length>0&&(value.parentId===null||typeof value.parentId==="string")&&typeof value.title==="string"&&typeof value.status==="string"&&LEGACY_NODE_STATUSES.has(value.status)&&Number.isSafeInteger(value.createdAt)&&(value.createdAt as number)>=0;}
export function isCheckpointState(value:unknown):value is CheckpointState{
  if(!object(value)||!Array.isArray(value.workingMemory)||!value.workingMemory.every(validMessage)||!Array.isArray(value.planNodes)||!value.planNodes.every(validLegacyNode)||!Number.isSafeInteger(value.stepCount)||(value.stepCount as number)<0)return false;
  const ids=(value.planNodes as PlanNode[]).map(node=>node.id);return new Set(ids).size===ids.length;
}
export function saveCheckpoint(label:string,state:CheckpointState){const id=randomUUID();getDb().prepare(`INSERT INTO checkpoints(id,label,created_at,state,kind,schema_version)VALUES(?,?,?,?,?,?)`).run(id,label,Date.now(),JSON.stringify(state),"AGENT_STATE",1);return id;}
export function savePlanCheckpoint(planRunId:string,planner:Planner){const run=planner.getRun(planRunId);if(!run)throw new Error("PLAN_NOT_FOUND");const id=randomUUID();getDb().prepare(`INSERT INTO checkpoints(id,label,created_at,state,kind,scope_id,schema_version)VALUES(?,?,?,?,?,?,?)`).run(id,`Plan ${planRunId} generation ${run.generation}`,Date.now(),JSON.stringify({planRun:run,nodes:planner.nodes(planRunId),generation:run.generation}),"PLAN_EXECUTION",planRunId,1);return id;}
export function loadCheckpoint(id:string):CheckpointState|null{const row=getDb().prepare(`SELECT state,kind FROM checkpoints WHERE id=?`).get(id) as {state:string;kind:string}|undefined;if(!row||row.kind!=="AGENT_STATE")return null;let parsed:unknown;try{parsed=JSON.parse(row.state)}catch{return null}return isCheckpointState(parsed)?parsed:null;}
export function listCheckpoints():CheckpointSummary[]{return getDb().prepare(`SELECT id,label,created_at createdAt,kind,scope_id scopeId,schema_version schemaVersion FROM checkpoints ORDER BY created_at DESC`).all() as CheckpointSummary[];}
