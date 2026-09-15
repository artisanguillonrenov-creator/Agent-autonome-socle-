import { randomUUID } from "node:crypto";
import { getDb } from "../persistence/db.js";
import { config } from "../config.js";
import { saveCheckpoint } from "../persistence/checkpoint.js";
import { NotificationStore } from "../autonomy/notificationStore.js";

/**
 * Vague 8A : levée lorsque le disjoncteur financier est déclenché (déjà armé) ou vient de
 * l'être. Volontairement une exception "dure" — elle doit interrompre immédiatement la boucle
 * agent (Agent.step n'attrape pas les erreurs de complétion LLM elle-même, voir core/agent.ts)
 * plutôt qu'être absorbée comme une erreur d'outil ordinaire (Vague 11C), pour qu'aucune
 * routine incontrôlée ne puisse continuer à consommer des tokens après dépassement du budget.
 */
export class FinancialCircuitBreakerTrippedError extends Error {
  constructor(public readonly windowCostUsd: number, public readonly limitUsd: number) {
    super(
      `FINANCIAL_CIRCUIT_BREAKER_TRIPPED: coût glissant sur la fenêtre courante ($${windowCostUsd.toFixed(4)}) ` +
      `au-delà du seuil configuré ($${limitUsd.toFixed(2)}). Agent gelé — validation humaine requise pour réarmer.`,
    );
    this.name = "FinancialCircuitBreakerTrippedError";
  }
}

export interface FinancialCircuitBreakerStatus {
  enabled: boolean;
  tripped: boolean;
  trippedAt?: number;
  tripReason?: string;
  windowCostUsd: number;
  limitUsd: number;
  windowMs: number;
  checkpointId?: string;
}

interface StateRow {
  tripped: number;
  tripped_at: number | null;
  trip_reason: string | null;
  window_cost_usd: number | null;
  checkpoint_id: string | null;
}

/**
 * Vague 8A (disjoncteur financier évolué) : convertit chaque coût LLM déjà estimé par le
 * Tracer (src/observability/pricing.ts, appelé depuis tracedProvider.ts) en une fenêtre
 * glissante de dépense réelle (USD/heure par défaut). Un dépassement gèle immédiatement tout
 * nouvel appel LLM (le process reste vivant, mais FinancialCircuitBreaker.assertWithinBudget
 * lève avant même d'atteindre le fournisseur), persiste un instantané de gel et notifie en
 * mode CRITICAL (email + SMS, déjà acheminés par NotificationStore/AlertRouter). Seul un appel
 * humain explicite à rearm() peut lever le gel — jamais un redémarrage silencieux, jamais un
 * retour à la normale automatique au bout d'un délai.
 */
const SCHEMA_SQL = `
  CREATE TABLE IF NOT EXISTS financial_cost_events (
    id TEXT PRIMARY KEY,
    ts INTEGER NOT NULL,
    usd REAL NOT NULL,
    model TEXT,
    provider TEXT
  );
  CREATE INDEX IF NOT EXISTS idx_financial_cost_events_ts ON financial_cost_events(ts);

  CREATE TABLE IF NOT EXISTS financial_circuit_breaker_state (
    id TEXT PRIMARY KEY CHECK(id = 'singleton'),
    tripped INTEGER NOT NULL DEFAULT 0,
    tripped_at INTEGER,
    trip_reason TEXT,
    window_cost_usd REAL,
    checkpoint_id TEXT,
    updated_at INTEGER NOT NULL
  );
`;

export class FinancialCircuitBreaker {
  constructor(private readonly notifications = new NotificationStore()) {}

  /**
   * `financialCircuitBreaker` est un singleton importé une seule fois au chargement du
   * module, mais getDb() peut renvoyer une connexion différente au fil du process (ex. tests
   * qui appellent closeDb()+getDb() avec un nouveau chemin/`:memory:`). S'assurer du schéma à
   * CHAQUE accès (idempotent, CREATE TABLE IF NOT EXISTS) plutôt qu'une seule fois au
   * constructeur évite un "no such table" après un tel changement de connexion.
   */
  private db() {
    const db = getDb();
    db.exec(SCHEMA_SQL);
    return db;
  }

  private get windowMs(): number {
    return config.financialCircuitBreaker.windowMs;
  }

  private get limitUsd(): number {
    return config.financialCircuitBreaker.hourlyLimitUsd;
  }

  private stateRow(): StateRow | undefined {
    return this.db().prepare(`SELECT tripped, tripped_at, trip_reason, window_cost_usd, checkpoint_id FROM financial_circuit_breaker_state WHERE id='singleton'`).get() as
      | StateRow
      | undefined;
  }

  /** Enregistre un coût déjà estimé (voir tracedProvider.ts) dans la fenêtre glissante. Best-effort : n'échoue jamais la complétion appelante. */
  record(usd: number, model?: string, provider?: string): void {
    if (!config.financialCircuitBreaker.enabled || !Number.isFinite(usd) || usd <= 0) return;
    try {
      const db = this.db();
      db.prepare(`INSERT INTO financial_cost_events(id, ts, usd, model, provider) VALUES (?,?,?,?,?)`)
        .run(randomUUID(), Date.now(), usd, model ?? null, provider ?? null);
      // Purge conservatrice (2x la fenêtre) : la table ne doit jamais croître sans borne.
      db.prepare(`DELETE FROM financial_cost_events WHERE ts < ?`).run(Date.now() - this.windowMs * 2);
    } catch (error) {
      console.warn("[FinancialCircuitBreaker] record failed (best-effort):", (error as Error).message);
    }
  }

  windowCostUsd(now = Date.now()): number {
    try {
      const row = this.db()
        .prepare(`SELECT COALESCE(SUM(usd),0) AS total FROM financial_cost_events WHERE ts > ?`)
        .get(now - this.windowMs) as { total: number };
      return row.total;
    } catch {
      return 0;
    }
  }

  isTripped(): boolean {
    return this.stateRow()?.tripped === 1;
  }

  /**
   * Point de contrôle appelé par tracedProvider.ts AVANT tout nouvel appel LLM. Si le
   * disjoncteur est déjà armé, refuse immédiatement (aucun appel réseau au fournisseur n'a
   * lieu). Sinon, vérifie si la dépense de la fenêtre courante vient de franchir le seuil et,
   * si oui, déclenche le gel pour tous les appels SUIVANTS (celui qui vient de dépasser le
   * seuil a déjà été facturé et ne peut pas être annulé rétroactivement).
   */
  assertWithinBudget(): void {
    if (!config.financialCircuitBreaker.enabled) return;
    if (this.isTripped()) throw new FinancialCircuitBreakerTrippedError(this.windowCostUsd(), this.limitUsd);
    const cost = this.windowCostUsd();
    if (cost > this.limitUsd) {
      this.trip(cost);
      throw new FinancialCircuitBreakerTrippedError(cost, this.limitUsd);
    }
  }

  private trip(windowCostUsd: number): void {
    if (this.isTripped()) return;
    const now = Date.now();
    let checkpointId: string | undefined;
    try {
      checkpointId = saveCheckpoint(`FINANCIAL_CIRCUIT_BREAKER_FREEZE_${now}`, { workingMemory: [], planNodes: [], stepCount: 0 });
    } catch (error) {
      console.warn("[FinancialCircuitBreaker] Freeze checkpoint failed (best-effort):", (error as Error).message);
    }
    const reason =
      `Coût glissant estimé sur la dernière fenêtre ($${windowCostUsd.toFixed(4)}) au-delà du seuil configuré ` +
      `($${this.limitUsd.toFixed(2)}). Boucle incontrôlée ou routine hors contrôle suspectée.`;
    this.db()
      .prepare(`
        INSERT INTO financial_circuit_breaker_state(id, tripped, tripped_at, trip_reason, window_cost_usd, checkpoint_id, updated_at)
        VALUES('singleton', 1, ?, ?, ?, ?, ?)
        ON CONFLICT(id) DO UPDATE SET
          tripped = 1, tripped_at = excluded.tripped_at, trip_reason = excluded.trip_reason,
          window_cost_usd = excluded.window_cost_usd, checkpoint_id = excluded.checkpoint_id, updated_at = excluded.updated_at
      `)
      .run(now, reason, windowCostUsd, checkpointId ?? null, now);

    this.notifications.create(
      {
        type: "COST_CIRCUIT_BREAKER_TRIPPED",
        severity: "error",
        title: "CRITIQUE — Disjoncteur financier déclenché : agent gelé",
        message: `${reason} Aucun nouvel appel LLM ne sera exécuté tant qu'un opérateur humain n'aura pas explicitement réarmé le disjoncteur.`,
      },
      `financial-circuit-breaker:${now}`,
    );
  }

  /** Seule voie de sortie du gel : appel humain explicite (CLI/API), jamais automatique. */
  rearm(): FinancialCircuitBreakerStatus {
    this.db().prepare(`UPDATE financial_circuit_breaker_state SET tripped=0, updated_at=? WHERE id='singleton'`).run(Date.now());
    return this.status();
  }

  status(): FinancialCircuitBreakerStatus {
    const row = this.stateRow();
    return {
      enabled: config.financialCircuitBreaker.enabled,
      tripped: row?.tripped === 1,
      trippedAt: row?.tripped_at ?? undefined,
      tripReason: row?.trip_reason ?? undefined,
      windowCostUsd: this.windowCostUsd(),
      limitUsd: this.limitUsd,
      windowMs: this.windowMs,
      checkpointId: row?.checkpoint_id ?? undefined,
    };
  }
}

/** Instance unique — le budget est un état process-wide, pas un état par appelant. */
export const financialCircuitBreaker = new FinancialCircuitBreaker();
