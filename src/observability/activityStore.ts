import { randomUUID } from "node:crypto";import { getDb } from "../persistence/db.js";import { config } from "../config.js";
export const ACTIVITY_TYPES=["SKILLS_SELECTED","PLAN_CREATED","PLAN_STARTED","STEP_READY","STEP_DISPATCHED","SPECIALIST_ASSIGNED","APPROVAL_REQUIRED","STEP_COMPLETED","STEP_FAILED","REPLAN_PENDING","REPLAN_STARTED","REPLAN_APPLIED","ARTIFACT_CREATED","CONSOLIDATION_STARTED","CONSOLIDATION_COMPLETED","PLAN_COMPLETED","PLAN_BLOCKED","PLAN_CANCEL_REQUESTED","PLAN_CANCELLED","RECOVERY_REQUIRED","HEALTH_CHECK_COMPLETED","HUMAN_EDIT_RECEIVED","HUMAN_EDIT_APPLIED"] as const;
export type ActivityType=typeof ACTIVITY_TYPES[number];const forbidden=/authorization|api[_-]?key|token|secret|password|\.env/i;
export interface ActivityInput{dedupeKey?:string;timestamp?:number;traceId?:string;planRunId?:string;planNodeId?:string;operationTaskId?:string;specialistId?:string;eventType:ActivityType;level?:"info"|"warning"|"error";message:string;metadata?:Record<string,unknown>}
const hasUndefined=(value:unknown):boolean=>value===undefined||(value!==null&&typeof value==="object"&&Object.values(value as Record<string,unknown>).some(hasUndefined));
/**
 * Chantier 8 (activity.logLevel) : granularité réelle du journal d'activité.
 * NORMAL (tier 0) ne garde que les événements de haut niveau ; DETAILED (tier 1) ajoute
 * le détail d'exécution ; DEBUG (tier 2) ajoute le détail technique interne (sélection de
 * compétences, démarrage de replanning). Un événement absent de cette table est toujours
 * conservé (fail-open) plutôt que silencieusement perdu si la liste évolue.
 */
const ACTIVITY_TIERS:Partial<Record<ActivityType,0|1|2>>={
  SKILLS_SELECTED:2,REPLAN_STARTED:2,
  STEP_READY:1,STEP_DISPATCHED:1,STEP_COMPLETED:1,SPECIALIST_ASSIGNED:1,ARTIFACT_CREATED:1,
  REPLAN_PENDING:1,REPLAN_APPLIED:1,CONSOLIDATION_STARTED:1,CONSOLIDATION_COMPLETED:1,HEALTH_CHECK_COMPLETED:1,
  PLAN_CREATED:0,PLAN_STARTED:0,PLAN_COMPLETED:0,PLAN_BLOCKED:0,PLAN_CANCEL_REQUESTED:0,PLAN_CANCELLED:0,
  APPROVAL_REQUIRED:0,STEP_FAILED:0,RECOVERY_REQUIRED:0,
};
const LOG_LEVEL_TIER:Record<string,0|1|2>={NORMAL:0,DETAILED:1,DEBUG:2};
export class ActivityStore{append(input:ActivityInput){if(!ACTIVITY_TYPES.includes(input.eventType)||!input.message.trim()||forbidden.test(input.message))throw new Error("INVALID_ACTIVITY");const metadata=input.metadata??{};const json=JSON.stringify(metadata);if(!metadata||Array.isArray(metadata)||hasUndefined(metadata)||json.length>8192||forbidden.test(json))throw new Error("INVALID_ACTIVITY_METADATA");const eventTier=ACTIVITY_TIERS[input.eventType]??0;const allowedTier=LOG_LEVEL_TIER[config.activity.logLevel]??0;if(eventTier>allowedTier)return null;const id=randomUUID();getDb().prepare(`INSERT OR IGNORE INTO activity_log(id,dedupe_key,timestamp,trace_id,plan_run_id,plan_node_id,operation_task_id,specialist_id,event_type,level,message,metadata_json)VALUES(?,?,?,?,?,?,?,?,?,?,?,?)`).run(id,input.dedupeKey??null,input.timestamp??Date.now(),input.traceId??null,input.planRunId??null,input.planNodeId??null,input.operationTaskId??null,input.specialistId??null,input.eventType,input.level??"info",input.message.trim(),json);return input.dedupeKey?this.byDedupe(input.dedupeKey):this.get(id);}
 get(id:string){return getDb().prepare("SELECT * FROM activity_log WHERE id=?").get(id)??null;}private byDedupe(k:string){return getDb().prepare("SELECT * FROM activity_log WHERE dedupe_key=?").get(k)??null;}
 list(filters:{planRunId?:string;operationTaskId?:string;specialistId?:string;eventType?:string;level?:string;limit?:number;offset?:number}={}){const where:string[]=[];const args:unknown[]=[];for(const [key,column] of [["planRunId","plan_run_id"],["operationTaskId","operation_task_id"],["specialistId","specialist_id"],["eventType","event_type"],["level","level"]] as const){const v=filters[key];if(v){where.push(`${column}=?`);args.push(v);}}args.push(Math.min(Math.max(filters.limit??100,1),200),Math.max(filters.offset??0,0));return getDb().prepare(`SELECT * FROM activity_log ${where.length?`WHERE ${where.join(" AND ")}`:""} ORDER BY timestamp,id LIMIT ? OFFSET ?`).all(...args);}}
