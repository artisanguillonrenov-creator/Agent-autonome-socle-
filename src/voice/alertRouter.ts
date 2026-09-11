import { config } from "../config.js";
import { getDb } from "../persistence/db.js";
import type { Notification, NotificationType } from "../autonomy/notificationStore.js";
import { createSmsProvider, type SmsProvider } from "./smsProvider.js";

const IMPORTANT_FOR_SMS_OR_VOICE = new Set<NotificationType>([
  "RECOVERY_REQUIRED",
  "BACKGROUND_FAILED",
  "APPROVAL_REQUIRED",
  "COMMERCIAL_ATTENTION_REQUIRED",
]);

export interface NativeAlertEnvelope {
  notificationId: string;
  type: NotificationType;
  severity: "info" | "warning" | "error";
  title: string;
  lockscreenMessage: string;
  taskId?: string;
  operationTaskId?: string;
  android: boolean;
  voice: boolean;
  createdAt: number;
}

/**
 * NotificationStore remains the event source of truth. This router only fans newly
 * created notifications out to optional channels. Existing email delivery stays in
 * NotificationStore and is intentionally not duplicated here.
 */
export class AlertRouter {
  constructor(private readonly smsProvider: SmsProvider = createSmsProvider()) {
    getDb().exec(`
      CREATE TABLE IF NOT EXISTS native_alert_outbox (
        notification_id TEXT PRIMARY KEY,
        android INTEGER NOT NULL CHECK(android IN (0,1)),
        voice INTEGER NOT NULL CHECK(voice IN (0,1)),
        created_at INTEGER NOT NULL,
        acked_at INTEGER
      );
      CREATE TABLE IF NOT EXISTS sms_alerts_sent (
        notification_id TEXT PRIMARY KEY,
        sent_at INTEGER NOT NULL,
        ok INTEGER NOT NULL CHECK(ok IN (0,1)),
        error TEXT
      );
    `);
  }

  async handle(notification: Notification): Promise<void> {
    const nativeAndroid = config.activity.androidPush;
    const nativeVoice = config.activity.voiceAlerts && IMPORTANT_FOR_SMS_OR_VOICE.has(notification.type);
    if (nativeAndroid || nativeVoice) {
      getDb().prepare(`
        INSERT OR IGNORE INTO native_alert_outbox(notification_id,android,voice,created_at,acked_at)
        VALUES (?,?,?,?,NULL)
      `).run(notification.id, nativeAndroid ? 1 : 0, nativeVoice ? 1 : 0, notification.createdAt);
    }

    if (config.activity.smsAlerts && IMPORTANT_FOR_SMS_OR_VOICE.has(notification.type)) {
      const already = getDb().prepare("SELECT notification_id FROM sms_alerts_sent WHERE notification_id=?").get(notification.id);
      if (!already) {
        const result = await this.smsProvider.send({
          to: config.sms.alertTo,
          text: `[Jarvis] ${notification.title}: ${notification.message}`.slice(0, 900),
        });
        getDb().prepare(`
          INSERT OR IGNORE INTO sms_alerts_sent(notification_id,sent_at,ok,error)
          VALUES (?,?,?,?)
        `).run(notification.id, Date.now(), result.ok ? 1 : 0, result.error ?? null);
      }
    }
  }

  pendingNative(limit = 25): NativeAlertEnvelope[] {
    const rows = getDb().prepare(`
      SELECT o.notification_id,o.android,o.voice,o.created_at,
             n.type,n.severity,n.title,n.task_id,n.operation_task_id
      FROM native_alert_outbox o
      INNER JOIN notifications n ON n.id=o.notification_id
      WHERE o.acked_at IS NULL
      ORDER BY o.created_at ASC
      LIMIT ?
    `).all(Math.max(1, Math.min(limit, 100))) as any[];

    return rows.map((row) => ({
      notificationId: row.notification_id,
      type: row.type,
      severity: row.severity,
      title: String(row.title).slice(0, 120),
      // Lockscreen payload is intentionally generic. Full details remain in NotificationStore.
      lockscreenMessage: "Ouvrez Jarvis pour consulter les détails.",
      taskId: row.task_id ?? undefined,
      operationTaskId: row.operation_task_id ?? undefined,
      android: row.android === 1,
      voice: row.voice === 1,
      createdAt: row.created_at,
    }));
  }

  acknowledgeNative(notificationId: string): boolean {
    return getDb().prepare(`
      UPDATE native_alert_outbox SET acked_at=COALESCE(acked_at,?) WHERE notification_id=?
    `).run(Date.now(), notificationId).changes === 1;
  }
}
