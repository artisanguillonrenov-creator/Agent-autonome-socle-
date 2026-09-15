import { randomUUID } from "node:crypto";
import { getDb } from "../persistence/db.js";
import { config } from "../config.js";

export type AndroidIntentType =
  | "OPEN_NAVIGATION_APP"
  | "TRIGGER_SOUND_ALERT"
  | "UPDATE_WIDGET"
  | "OPEN_URL"
  | "CUSTOM";

export interface AndroidCommand {
  id: string;
  type: AndroidIntentType;
  payload: Record<string, unknown>;
  createdAt: number;
  deliveredAt?: number;
  ackedAt?: number;
}

function map(row: any): AndroidCommand {
  return {
    id: row.id,
    type: row.type,
    payload: JSON.parse(row.payload_json || "{}"),
    createdAt: row.created_at,
    deliveredAt: row.delivered_at ?? undefined,
    ackedAt: row.acked_at ?? undefined,
  };
}

/**
 * Vague 9D (sync des alertes Android / intent routing) : file de commandes destinées au
 * smartphone Android en arrière-plan (ouvrir une app, déclencher une alerte sonore système,
 * rafraîchir un widget). Deux canaux complémentaires, jamais mutuellement exclusifs :
 * - push best-effort via un webhook FCM externe si ANDROID_FCM_WEBHOOK_URL est configuré
 *   (payload JSON enrichi prêt à être relayé vers un Intent Android côté app) ;
 * - persistance dans une file consultable par polling (GET /api/android/commands), le
 *   mécanisme déjà en place pour les alertes natives (voir voice/alertRouter.ts) — garantit la
 *   livraison même sans FCM configuré ou lors d'une coupure réseau temporaire.
 */
export class AndroidCommandBus {
  constructor() {
    getDb().exec(`
      CREATE TABLE IF NOT EXISTS android_commands (
        id TEXT PRIMARY KEY,
        type TEXT NOT NULL,
        payload_json TEXT NOT NULL,
        created_at INTEGER NOT NULL,
        delivered_at INTEGER,
        acked_at INTEGER
      );
      CREATE INDEX IF NOT EXISTS idx_android_commands_pending ON android_commands(acked_at);
    `);
  }

  async send(type: AndroidIntentType, payload: Record<string, unknown> = {}): Promise<AndroidCommand> {
    const id = randomUUID();
    const now = Date.now();
    getDb()
      .prepare(`INSERT INTO android_commands(id, type, payload_json, created_at) VALUES (?,?,?,?)`)
      .run(id, type, JSON.stringify(payload), now);

    let deliveredAt: number | undefined;
    if (config.android.fcmWebhookUrl) {
      deliveredAt = await this.pushViaFcm(id, type, payload);
    }
    return { id, type, payload, createdAt: now, deliveredAt };
  }

  /** Best-effort : un échec du webhook FCM ne fait jamais échouer l'enqueue — la commande reste consultable par polling. */
  private async pushViaFcm(id: string, type: AndroidIntentType, payload: Record<string, unknown>): Promise<number | undefined> {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 10_000);
    try {
      const response = await fetch(config.android.fcmWebhookUrl, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          ...(config.android.fcmWebhookToken ? { authorization: `Bearer ${config.android.fcmWebhookToken}` } : {}),
        },
        body: JSON.stringify({ commandId: id, type, payload, intent: `jarvis.android.${type}` }),
        signal: controller.signal,
      });
      if (!response.ok) return undefined;
      const now = Date.now();
      getDb().prepare(`UPDATE android_commands SET delivered_at=? WHERE id=?`).run(now, id);
      return now;
    } catch {
      return undefined;
    } finally {
      clearTimeout(timeout);
    }
  }

  pending(limit = 25): AndroidCommand[] {
    return (
      getDb()
        .prepare(`SELECT * FROM android_commands WHERE acked_at IS NULL ORDER BY created_at ASC LIMIT ?`)
        .all(Math.max(1, Math.min(limit, 100))) as any[]
    ).map(map);
  }

  acknowledge(id: string): boolean {
    return getDb().prepare(`UPDATE android_commands SET acked_at=COALESCE(acked_at,?) WHERE id=?`).run(Date.now(), id).changes === 1;
  }
}

export const androidCommandBus = new AndroidCommandBus();
