import { randomUUID } from "node:crypto";
import { getDb } from "../persistence/db.js";
import { config } from "../config.js";
import { createEmailProvider, type EmailProvider } from "../email/emailProvider.js";

export type NotificationType =
  | "REMINDER_DUE"
  | "BACKGROUND_COMPLETED"
  | "BACKGROUND_FAILED"
  | "WATCH_CHANGED"
  | "RECOVERY_REQUIRED"
  | "APPROVAL_REQUIRED"
  | "COMMERCIAL_ATTENTION_REQUIRED";
export interface Notification { id: string; type: NotificationType; severity: "info" | "warning" | "error"; title: string; message: string; taskId?: string; operationTaskId?: string; createdAt: number; readAt?: number }
export type NotificationListener = (notification: Notification) => void | Promise<void>;

/** activity.emailAlerts : types de notification jugés suffisamment importants pour justifier une alerte e-mail (Jarvis -> utilisateur). */
const ALERT_WORTHY = new Set<NotificationType>(["RECOVERY_REQUIRED", "BACKGROUND_FAILED", "APPROVAL_REQUIRED", "COMMERCIAL_ATTENTION_REQUIRED"]);

function map(row: any): Notification { return { id: row.id, type: row.type, severity: row.severity, title: row.title, message: row.message, taskId: row.task_id ?? undefined, operationTaskId: row.operation_task_id ?? undefined, createdAt: row.created_at, readAt: row.read_at ?? undefined }; }

export class NotificationStore {
  private static readonly listeners = new Set<NotificationListener>();

  constructor(private readonly emailProvider: EmailProvider = createEmailProvider()) {}

  /** Global process-level subscription: every NotificationStore instance emits here. */
  static subscribe(listener: NotificationListener): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  private static emit(notification: Notification): void {
    for (const listener of this.listeners) {
      Promise.resolve(listener(notification)).catch((error) => {
        console.error("[AlertRouter] notification fanout failed:", (error as Error).message);
      });
    }
  }

  create(input: Omit<Notification, "id" | "createdAt" | "readAt">, dedupeKey?: string): Notification {
    const db = getDb(); const id = randomUUID(); const now = Date.now();
    const inserted = db.prepare(`INSERT OR IGNORE INTO notifications (id,type,severity,title,message,task_id,operation_task_id,dedupe_key,created_at) VALUES (?,?,?,?,?,?,?,?,?)`)
      .run(id, input.type, input.severity, input.title, input.message, input.taskId ?? null, input.operationTaskId ?? null, dedupeKey ?? null, now);
    const notification = dedupeKey ? map(db.prepare(`SELECT * FROM notifications WHERE dedupe_key=?`).get(dedupeKey)) : this.get(id)!;
    // inserted.changes === 1 : cette notification vient réellement d'être créée (pas une
    // ré-émission dédupliquée) — évite tout canal d'alerte en double sur retry/redémarrage.
    if (inserted.changes === 1) {
      if (config.activity.emailAlerts && ALERT_WORTHY.has(notification.type)) {
        this.sendEmailAlert(notification).catch(() => undefined);
      }
      NotificationStore.emit(notification);
    }
    return notification;
  }

  private async sendEmailAlert(notification: Notification): Promise<void> {
    if (!config.email.alertTo) return; // Aucun destinataire configuré : jamais d'envoi simulé.
    const result = await this.emailProvider.send({
      to: config.email.alertTo,
      subject: `[Jarvis] ${notification.title}`,
      text: `${notification.message}\n\n(type: ${notification.type}, id: ${notification.id})`,
    });
    getDb()
      .prepare(`INSERT OR IGNORE INTO email_alerts_sent (dedupe_key, sent_at, ok, error) VALUES (?, ?, ?, ?)`)
      .run(`alert:${notification.id}`, Date.now(), result.ok ? 1 : 0, result.error ?? null);
  }

  get(id: string): Notification | null { const row = getDb().prepare(`SELECT * FROM notifications WHERE id=?`).get(id); return row ? map(row) : null; }
  list(unread = false): Notification[] { return (getDb().prepare(`SELECT * FROM notifications ${unread ? "WHERE read_at IS NULL" : ""} ORDER BY created_at DESC`).all() as any[]).map(map); }
  markRead(id: string): boolean { return getDb().prepare(`UPDATE notifications SET read_at=COALESCE(read_at,?) WHERE id=?`).run(Date.now(), id).changes === 1; }
  unreadCount(): number { return (getDb().prepare(`SELECT COUNT(*) count FROM notifications WHERE read_at IS NULL`).get() as {count:number}).count; }
}
