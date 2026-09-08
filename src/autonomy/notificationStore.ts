import { randomUUID } from "node:crypto";
import { getDb } from "../persistence/db.js";

export type NotificationType = "REMINDER_DUE" | "BACKGROUND_COMPLETED" | "BACKGROUND_FAILED" | "WATCH_CHANGED" | "RECOVERY_REQUIRED";
export interface Notification { id: string; type: NotificationType; severity: "info" | "warning" | "error"; title: string; message: string; taskId?: string; operationTaskId?: string; createdAt: number; readAt?: number }

function map(row: any): Notification { return { id: row.id, type: row.type, severity: row.severity, title: row.title, message: row.message, taskId: row.task_id ?? undefined, operationTaskId: row.operation_task_id ?? undefined, createdAt: row.created_at, readAt: row.read_at ?? undefined }; }

export class NotificationStore {
  create(input: Omit<Notification, "id" | "createdAt" | "readAt">, dedupeKey?: string): Notification {
    const db = getDb(); const id = randomUUID(); const now = Date.now();
    db.prepare(`INSERT OR IGNORE INTO notifications (id,type,severity,title,message,task_id,operation_task_id,dedupe_key,created_at) VALUES (?,?,?,?,?,?,?,?,?)`)
      .run(id, input.type, input.severity, input.title, input.message, input.taskId ?? null, input.operationTaskId ?? null, dedupeKey ?? null, now);
    if (dedupeKey) return map(db.prepare(`SELECT * FROM notifications WHERE dedupe_key=?`).get(dedupeKey));
    return this.get(id)!;
  }
  get(id: string): Notification | null { const row = getDb().prepare(`SELECT * FROM notifications WHERE id=?`).get(id); return row ? map(row) : null; }
  list(unread = false): Notification[] { return (getDb().prepare(`SELECT * FROM notifications ${unread ? "WHERE read_at IS NULL" : ""} ORDER BY created_at DESC`).all() as any[]).map(map); }
  markRead(id: string): boolean { return getDb().prepare(`UPDATE notifications SET read_at=COALESCE(read_at,?) WHERE id=?`).run(Date.now(), id).changes === 1; }
  unreadCount(): number { return (getDb().prepare(`SELECT COUNT(*) count FROM notifications WHERE read_at IS NULL`).get() as {count:number}).count; }
}
