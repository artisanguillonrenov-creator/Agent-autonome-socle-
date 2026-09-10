import { getDb } from "../persistence/db.js";

const DAY_MS = 24 * 60 * 60 * 1000;

/**
 * Chantier 8 (projects.memoryRetentionDays) : supprime uniquement les souvenirs
 * "episodic" (tours de conversation bruts) plus anciens que la rétention configurée.
 * Ne touche JAMAIS :
 *  - les "reflection" (enseignements consolidés destinés à durer) ;
 *  - les "knowledge" (index RAG projet, dont le cycle de vie suit les fichiers du
 *    workspace, pas le temps).
 * Comportement pur et déterministe : `now` est injectable pour des tests reproductibles.
 */
export function sweepExpiredEpisodicMemory(retentionDays: number, now: number = Date.now()): number {
  if (!Number.isFinite(retentionDays) || retentionDays <= 0) return 0;
  const cutoff = now - retentionDays * DAY_MS;
  const result = getDb()
    .prepare(`DELETE FROM memory_entries WHERE kind = 'episodic' AND created_at < ?`)
    .run(cutoff);
  return result.changes;
}

/**
 * Boucle périodique légère (pas de dépendance à un cron externe) : exécute le
 * sweep immédiatement au démarrage puis à intervalle régulier. Séparée du Scheduler
 * (tick 1s dédié aux tâches planifiées) pour ne jamais alourdir sa boucle chaude.
 */
export class MemoryRetentionScheduler {
  private timer?: NodeJS.Timeout;
  private stopped = true;

  constructor(private readonly getRetentionDays: () => number, private readonly intervalMs = 6 * 60 * 60 * 1000) {}

  start(): void {
    if (!this.stopped) return;
    this.stopped = false;
    const loop = () => {
      if (this.stopped) return;
      try {
        sweepExpiredEpisodicMemory(this.getRetentionDays());
      } catch {
        // Best-effort : un échec de sweep ne doit jamais interrompre le runtime.
      }
      if (!this.stopped) this.timer = setTimeout(loop, this.intervalMs);
    };
    this.timer = setTimeout(loop, 0);
  }

  stop(): void {
    this.stopped = true;
    if (this.timer) clearTimeout(this.timer);
  }
}
