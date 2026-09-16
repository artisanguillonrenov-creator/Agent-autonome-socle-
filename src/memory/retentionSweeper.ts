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
 * Brique mémoire relationnelle (GraphMemory) : contrairement à la mémoire épisodique,
 * un triplet n'est JAMAIS purgé par la seule ancienneté (voir config.memory) — il doit
 * être à la fois non renforcé depuis `maxAgeDays` (updated_at, pas created_at : un
 * triplet régulièrement revu ne s'use jamais) ET rester sous le seuil de confiance
 * `maxConfidence`. Un triplet établi (confidence haute) survit indéfiniment.
 */
export function sweepStaleGraphTriples(maxAgeDays: number, maxConfidence: number, now: number = Date.now()): number {
  if (!Number.isFinite(maxAgeDays) || maxAgeDays <= 0) return 0;
  const cutoff = now - maxAgeDays * DAY_MS;
  const result = getDb()
    .prepare(`DELETE FROM knowledge_graph_triples WHERE updated_at < ? AND confidence < ?`)
    .run(cutoff, maxConfidence);
  return result.changes;
}

export interface RetentionSweepResult {
  episodicDeleted: number;
  graphTriplesDeleted: number;
}

/**
 * Point d'entrée unique de la rétention mémoire cross-store : mémoire épisodique
 * (vectorielle) et graphe de connaissances, chacun avec sa propre politique (voir les
 * fonctions ci-dessus). Les faits (FactStore) et la mémoire de travail n'ont pas besoin
 * de sweep : le premier n'a qu'une valeur courante par (entité, attribut) — déjà
 * "unifiée" par construction — et la seconde est un cache borné en mémoire process, pas
 * en base.
 */
export function runRetentionSweep(
  options: { episodicRetentionDays: number; graphRetentionDays: number; graphRetentionMaxConfidence: number },
  now: number = Date.now(),
): RetentionSweepResult {
  return {
    episodicDeleted: sweepExpiredEpisodicMemory(options.episodicRetentionDays, now),
    graphTriplesDeleted: sweepStaleGraphTriples(options.graphRetentionDays, options.graphRetentionMaxConfidence, now),
  };
}

/**
 * Boucle périodique légère (pas de dépendance à un cron externe) : exécute le
 * sweep immédiatement au démarrage puis à intervalle régulier. Séparée du Scheduler
 * (tick 1s dédié aux tâches planifiées) pour ne jamais alourdir sa boucle chaude.
 */
export class MemoryRetentionScheduler {
  private timer?: NodeJS.Timeout;
  private stopped = true;

  constructor(
    private readonly getRetentionDays: () => number,
    private readonly intervalMs = 6 * 60 * 60 * 1000,
    private readonly getGraphRetention: () => { maxAgeDays: number; maxConfidence: number } = () => ({ maxAgeDays: 0, maxConfidence: 0 }),
  ) {}

  start(): void {
    if (!this.stopped) return;
    this.stopped = false;
    const loop = () => {
      if (this.stopped) return;
      try {
        const graph = this.getGraphRetention();
        runRetentionSweep({
          episodicRetentionDays: this.getRetentionDays(),
          graphRetentionDays: graph.maxAgeDays,
          graphRetentionMaxConfidence: graph.maxConfidence,
        });
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
