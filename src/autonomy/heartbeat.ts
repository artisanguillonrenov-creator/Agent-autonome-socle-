import { getDb, getPgPool } from "../persistence/db.js";
import type { Planner } from "../planning/planner.js";
import { config } from "../config.js";

export interface InFlightSnapshot {
  beatAt: number;
  activePlanRunIds: string[];
  inFlightOperationTaskIds: string[];
}

const HEARTBEAT_SCHEMA_PG = `CREATE TABLE IF NOT EXISTS heartbeat_state (
  id TEXT PRIMARY KEY,
  beat_at BIGINT NOT NULL,
  in_flight_json TEXT NOT NULL,
  updated_at BIGINT NOT NULL
);`;

/**
 * Vague 7D (heartbeat, hydratation, auto-récupération) : un hébergement éphémère gratuit
 * (ex: Render free tier) met le process en veille après une période sans requête HTTP
 * entrante. Un battement périodique (a) garde le process éveillé en s'auto-pingant si
 * HEARTBEAT_SELF_URL est configurée, et (b) persiste dans Postgres (ou SQLite en
 * développement sans DATABASE_URL) un instantané des opérations async en vol, pour que le
 * redémarrage suivant sache immédiatement ce qui était en cours au moment de la coupure.
 */
export class Heartbeat {
  private timer?: NodeJS.Timeout;
  private stopped = true;

  constructor(
    private readonly planner: Planner,
    private readonly intervalMs = config.heartbeat.intervalMs,
    private readonly selfUrl = config.heartbeat.selfUrl,
  ) {}

  start(): void {
    if (!this.stopped) return;
    this.stopped = false;
    const loop = async () => {
      if (this.stopped) return;
      await this.beat().catch((error) => console.warn("[Heartbeat] beat failed:", (error as Error).message));
      if (!this.stopped) this.timer = setTimeout(loop, this.intervalMs);
    };
    this.timer = setTimeout(loop, 0);
  }

  stop(): void {
    this.stopped = true;
    if (this.timer) clearTimeout(this.timer);
  }

  async beat(): Promise<void> {
    await this.selfPing();
    await this.persistSnapshot();
  }

  /** Best-effort : une absence de réponse ne doit jamais interrompre le battement lui-même. */
  private async selfPing(): Promise<void> {
    if (!this.selfUrl) return;
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 10_000);
    try {
      await fetch(this.selfUrl, { signal: controller.signal });
    } catch {
      // La cible peut être temporairement indisponible : sans conséquence pour ce battement.
    } finally {
      clearTimeout(timeout);
    }
  }

  private collectInFlightOperations(): string[] {
    return (
      getDb()
        .prepare(`SELECT task_id FROM service_operations WHERE status IN ('QUEUED','DISPATCHING','RUNNING')`)
        .all() as Array<{ task_id: string }>
    ).map((row) => row.task_id);
  }

  private async persistSnapshot(): Promise<void> {
    const snapshot: InFlightSnapshot = {
      beatAt: Date.now(),
      activePlanRunIds: this.planner.activeRuns().map((run) => run.id),
      inFlightOperationTaskIds: this.collectInFlightOperations(),
    };
    const pool = getPgPool();
    if (pool) {
      await pool.query(HEARTBEAT_SCHEMA_PG);
      await pool.query(
        `INSERT INTO heartbeat_state(id, beat_at, in_flight_json, updated_at) VALUES('singleton',$1,$2,$3)
         ON CONFLICT(id) DO UPDATE SET beat_at=$1, in_flight_json=$2, updated_at=$3`,
        [snapshot.beatAt, JSON.stringify(snapshot), Date.now()],
      );
      return;
    }
    getDb()
      .prepare(
        `INSERT INTO heartbeat_state(id,beat_at,in_flight_json,updated_at) VALUES('singleton',?,?,?)
         ON CONFLICT(id) DO UPDATE SET beat_at=excluded.beat_at, in_flight_json=excluded.in_flight_json, updated_at=excluded.updated_at`,
      )
      .run(snapshot.beatAt, JSON.stringify(snapshot), Date.now());
  }

  /**
   * Hydratation automatique au (re)démarrage : relit le dernier instantané persisté pour
   * savoir si le process précédent s'est arrêté avec des opérations en vol. La reprise
   * effective de ces opérations est déjà assurée par le mécanisme existant
   * (OperationStore.recoverInterrupted, appelé par BackgroundRunner.recover() au démarrage
   * de la boucle principale) ; cette fonction fournit le diagnostic explicite — "combien de
   * temps le process a été indisponible, avec quoi en cours" — plutôt qu'un redémarrage
   * silencieux qui masquerait une coupure prolongée.
   */
  static async hydrate(): Promise<{ recovered: boolean; staleForMs?: number; snapshot?: InFlightSnapshot }> {
    const pool = getPgPool();
    let row: { beat_at: number; in_flight_json: string } | undefined;
    if (pool) {
      try {
        await pool.query(HEARTBEAT_SCHEMA_PG);
        const result = await pool.query(`SELECT beat_at, in_flight_json FROM heartbeat_state WHERE id='singleton'`);
        const first = result.rows[0] as { beat_at: string | number; in_flight_json: string } | undefined;
        row = first ? { beat_at: Number(first.beat_at), in_flight_json: String(first.in_flight_json) } : undefined;
      } catch (error) {
        console.warn("[Heartbeat] Postgres hydration failed:", (error as Error).message);
      }
    } else {
      row = getDb().prepare(`SELECT beat_at, in_flight_json FROM heartbeat_state WHERE id='singleton'`).get() as
        | { beat_at: number; in_flight_json: string }
        | undefined;
    }
    if (!row) return { recovered: false };
    let snapshot: InFlightSnapshot | undefined;
    try { snapshot = JSON.parse(row.in_flight_json) as InFlightSnapshot; } catch { snapshot = undefined; }
    return { recovered: true, staleForMs: Date.now() - row.beat_at, snapshot };
  }
}
