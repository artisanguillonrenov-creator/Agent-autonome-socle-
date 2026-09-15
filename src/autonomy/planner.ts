import type { Agent } from "../core/agent.js";
import { autonomyEventBus, type AutonomyEvent, type AutonomyEventType } from "./eventBus.js";
import { PreAttentionRouter } from "./preAttentionRouter.js";
import { IdleAutoAuditRunner } from "./idleAutoAudit.js";
import { NotificationStore } from "./notificationStore.js";
import { getDb } from "../persistence/db.js";
import { config } from "../config.js";

const WATCHED_EVENT_TYPES: AutonomyEventType[] = [
  "WORKBENCH_DOCUMENT_CHANGED",
  "SOFTWARE_FACTORY_PR_EVENT",
  "VOICE_COMMAND_RECEIVED",
  "TASK_EVENT",
];

/**
 * Vague 7B (déclencheurs commutés par l'état) : remplace l'éveil temporel strict de type
 * cron pour les routines lourdes d'arrière-plan par une réaction aux changements d'état
 * factuels publiés sur le bus d'autonomie (src/autonomy/eventBus.ts) — modification de
 * fichier dans le Document Workbench, PR/commit détecté par la Software Factory, commande
 * vocale reçue. Un scrutin résiduel à basse fréquence (idleCheckIntervalMs, tri par défaut
 * 60s) reste nécessaire pour détecter l'ABSENCE d'activité (7A) — aucune API ne notifie
 * "rien ne se passe" — mais l'audit lui-même ne s'exécute que si l'état constaté a changé
 * depuis le dernier passage (comparaison de signature), jamais à l'aveugle sur un système figé.
 */
export class AutonomyPlanner {
  private readonly preAttention = new PreAttentionRouter();
  private readonly idleAudit: IdleAutoAuditRunner;
  private readonly notifications = new NotificationStore();
  private readonly unsubscribers: Array<() => void> = [];
  private idleTimer?: NodeJS.Timeout;
  private stopped = true;
  private lastStateSignature = "";

  constructor(private readonly agent: Agent, private readonly idleCheckIntervalMs = config.autonomyPlanner.idleCheckIntervalMs) {
    this.idleAudit = new IdleAutoAuditRunner(agent);
  }

  start(): void {
    if (!this.stopped) return;
    this.stopped = false;
    for (const type of WATCHED_EVENT_TYPES) {
      this.unsubscribers.push(autonomyEventBus.on(type, (event) => { void this.onEvent(event); }));
    }
    this.scheduleIdleCheck();
  }

  stop(): void {
    this.stopped = true;
    for (const unsubscribe of this.unsubscribers.splice(0)) unsubscribe();
    if (this.idleTimer) clearTimeout(this.idleTimer);
  }

  private scheduleIdleCheck(): void {
    this.idleTimer = setTimeout(() => {
      void this.checkIdleAndMaybeAudit().finally(() => { if (!this.stopped) this.scheduleIdleCheck(); });
    }, this.idleCheckIntervalMs);
    this.idleTimer.unref?.();
  }

  /**
   * Vague 7A : ne lance IdleAutoAudit que si (a) aucune tâche utilisateur/planifiée n'est en
   * cours ET (b) l'état factuel observé a changé depuis le dernier passage — un système
   * inactif mais déjà audité dans son état courant ne redéclenche pas la routine en boucle.
   */
  private async checkIdleAndMaybeAudit(): Promise<void> {
    if (!this.isIdle()) return;
    const signature = this.stateSignature();
    if (signature === this.lastStateSignature) return;
    this.lastStateSignature = signature;
    await this.idleAudit.runOnce();
  }

  private isIdle(): boolean {
    if (this.agent.planner.activeRuns().length > 0) return false;
    const db = getDb();
    const inFlightOps = (db.prepare(`SELECT COUNT(*) count FROM service_operations WHERE status IN ('QUEUED','DISPATCHING','RUNNING')`).get() as { count: number }).count;
    if (inFlightOps > 0) return false;
    const dueTasks = (db.prepare(`SELECT COUNT(*) count FROM tasks WHERE enabled=1 AND status='pending' AND next_run_at IS NOT NULL AND next_run_at<=?`).get(Date.now()) as { count: number }).count;
    return dueTasks === 0;
  }

  private stateSignature(): string {
    const db = getDb();
    const activityCount = (db.prepare(`SELECT COUNT(*) count FROM activity_log`).get() as { count: number }).count;
    const notificationCount = (db.prepare(`SELECT COUNT(*) count FROM notifications`).get() as { count: number }).count;
    const memoryCount = (db.prepare(`SELECT COUNT(*) count FROM memory_entries`).get() as { count: number }).count;
    return `${activityCount}:${notificationCount}:${memoryCount}`;
  }

  /**
   * Vague 7C : chaque événement d'état passe d'abord par le filtre de pré-attention avant
   * de réveiller quoi que ce soit — un simple bruit (IGNORE) n'atteint jamais la brique 1.
   */
  private async onEvent(event: AutonomyEvent): Promise<void> {
    const verdict = await this.preAttention.classify(event);
    if (verdict.verdict === "IGNORE") return;

    if (verdict.verdict === "CRITICAL" && event.planRunId) {
      this.agent.requestInterrupt("PRODUCTION_ALERT", verdict.reason, event.planRunId);
    }

    await this.wakeNominalAgent(event, verdict);
  }

  /** Réveil complet du LLM nominal (brique 1, boucle agent) avec le contexte de l'événement qualifié. */
  private async wakeNominalAgent(event: AutonomyEvent, verdict: { verdict: string; reason: string }): Promise<void> {
    const prompt = [
      `[ÉVÉNEMENT D'ARRIÈRE-PLAN — ${verdict.verdict}]`,
      `Type : ${event.type} (source: ${event.source}).`,
      `Motif de qualification : ${verdict.reason}.`,
      `Contenu : ${JSON.stringify(event.payload).slice(0, 1500)}`,
      "Analyse cet événement et indique s'il nécessite une action, une alerte ou peut être classé sans suite.",
    ].join("\n");
    try {
      const result = await this.agent.step(prompt);
      this.notifications.create(
        {
          type: "AUTONOMY_EVENT_HANDLED",
          severity: verdict.verdict === "CRITICAL" ? "error" : "warning",
          title: verdict.verdict === "CRITICAL" ? "Événement critique analysé" : "Événement analysé (réflexion requise)",
          message: result.response.slice(0, 500),
        },
        `autonomy-wake:${event.type}:${event.emittedAt}`,
      );
    } catch (error) {
      console.warn("[AutonomyPlanner] Nominal wake failed:", (error as Error).message);
    }
  }
}
