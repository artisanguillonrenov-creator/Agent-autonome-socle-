import { randomUUID } from "node:crypto";
import { getDb } from "../persistence/db.js";
import type { TaskItem, TaskStatus } from "../types.js";

interface TaskRow {
  id: string;
  title: string;
  status: string;
  due_at: number | null;
  created_at: number;
  task_type: "REMINDER"|"DISPATCH"|"WATCH"; payload_json:string|null; enabled:number; repeat_interval_ms:number|null;
  next_run_at:number|null; last_run_at:number|null; last_result_hash:string|null; last_error:string|null;
}

function rowToTask(row: TaskRow): TaskItem {
  return {
    id: row.id,
    title: row.title,
    status: row.status as TaskStatus,
    dueAt: row.due_at,
    createdAt: row.created_at,
    taskType:row.task_type??"REMINDER",enabled:row.enabled!==0,repeatIntervalMs:row.repeat_interval_ms??undefined,
    nextRunAt:row.next_run_at,lastRunAt:row.last_run_at??undefined,lastResultHash:row.last_result_hash??undefined,lastError:row.last_error??undefined,
  };
}

/** Gestion de tâches/rappels — brique complémentaire au socle, stockage local. */
export class TaskStore {
  create(title: string, dueAt: number | null = null): TaskItem {
    const task: TaskItem = { id: randomUUID(), title, status: "pending", dueAt, createdAt: Date.now() };
    getDb()
      .prepare(`INSERT INTO tasks (id, title, status, due_at, created_at) VALUES (?, ?, ?, ?, ?)`)
      .run(task.id, task.title, task.status, task.dueAt, task.createdAt);
    return task;
  }

  createSchedule(input:{title:string;taskType:"REMINDER"|"DISPATCH"|"WATCH";nextRunAt:number;repeatIntervalMs?:number;payload?:unknown}):TaskItem {
    const task={id:randomUUID(),title:input.title,status:"pending" as const,dueAt:input.nextRunAt,createdAt:Date.now()};
    getDb().prepare(`INSERT INTO tasks(id,title,status,due_at,created_at,task_type,payload_json,enabled,repeat_interval_ms,next_run_at) VALUES(?,?,?,?,?,?,?,?,?,?)`).run(task.id,task.title,task.status,task.dueAt,task.createdAt,input.taskType,JSON.stringify(input.payload??{}),1,input.repeatIntervalMs??null,input.nextRunAt); return this.get(task.id)!;
  }
  get(id:string):TaskItem|null {const row=getDb().prepare(`SELECT * FROM tasks WHERE id=?`).get(id) as TaskRow|undefined;return row?rowToTask(row):null;}
  listSchedules():TaskItem[]{return (getDb().prepare(`SELECT * FROM tasks WHERE task_type IN ('REMINDER','DISPATCH','WATCH') AND next_run_at IS NOT NULL ORDER BY next_run_at`).all() as TaskRow[]).map(rowToTask);}
  setEnabled(id:string,enabled:boolean):boolean{return getDb().prepare(`UPDATE tasks SET enabled=? WHERE id=?`).run(enabled?1:0,id).changes===1;}
  claimDue(now=Date.now()):Array<{task:TaskItem;payload:unknown;occurrence:number}>{const db=getDb();return db.transaction(()=>{const rows=db.prepare(`SELECT * FROM tasks WHERE enabled=1 AND status='pending' AND next_run_at<=? AND claimed_at IS NULL ORDER BY next_run_at`).all(now) as TaskRow[];const out=[] as Array<{task:TaskItem;payload:unknown;occurrence:number}>;for(const row of rows){const occurrence=row.next_run_at!;const next=row.repeat_interval_ms?occurrence+row.repeat_interval_ms:null;const changed=db.prepare(`UPDATE tasks SET claimed_at=?,last_run_at=?,next_run_at=?,status=CASE WHEN ? IS NULL THEN 'done' ELSE status END WHERE id=? AND claimed_at IS NULL AND next_run_at=?`).run(now,now,next,next,row.id,occurrence).changes;if(changed){let payload:unknown={};try{payload=JSON.parse(row.payload_json??"{}");}catch{}out.push({task:rowToTask(row),payload,occurrence});}}return out;})();}
  releaseRecurring(id:string):void{getDb().prepare(`UPDATE tasks SET claimed_at=NULL WHERE id=? AND next_run_at IS NOT NULL`).run(id);}
  setWatchHash(id:string,hash:string):string|undefined{const old=(getDb().prepare(`SELECT last_result_hash FROM tasks WHERE id=?`).get(id) as any)?.last_result_hash??undefined;getDb().prepare(`UPDATE tasks SET last_result_hash=? WHERE id=?`).run(hash,id);return old;}

  complete(id: string): boolean {
    const result = getDb().prepare(`UPDATE tasks SET status = 'done' WHERE id = ?`).run(id);
    return result.changes > 0;
  }

  list(status?: TaskStatus): TaskItem[] {
    const rows = status
      ? (getDb().prepare(`SELECT * FROM tasks WHERE status = ? ORDER BY due_at IS NULL, due_at ASC, created_at ASC`).all(status) as TaskRow[])
      : (getDb().prepare(`SELECT * FROM tasks ORDER BY due_at IS NULL, due_at ASC, created_at ASC`).all() as TaskRow[]);
    return rows.map(rowToTask);
  }

  /** Tâches en retard : échéance passée et toujours non terminées. */
  dueNow(): TaskItem[] {
    const rows = getDb()
      .prepare(`SELECT * FROM tasks WHERE status = 'pending' AND due_at IS NOT NULL AND due_at <= ?`)
      .all(Date.now()) as TaskRow[];
    return rows.map(rowToTask);
  }
}
