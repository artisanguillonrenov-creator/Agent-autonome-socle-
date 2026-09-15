import { getDb } from "../persistence/db.js";
import { cosineSimilarity } from "../llm/embeddings.js";
import { sweepExpiredSemanticCache } from "../context/semanticCache.js";
import { ActivityStore } from "../observability/activityStore.js";
import type { Agent } from "../core/agent.js";

interface MemoryRow { id: string; text: string; embedding: string; created_at: number }

/**
 * Vague 7A (routines d'auto-amélioration en mode idle) : tâches de maintenance basse
 * priorité que l'agent s'auto-saisit uniquement pendant une période d'inactivité (aucune
 * tâche utilisateur/planifiée en cours) — jamais en concurrence avec du travail réel.
 * Trois passes, toutes best-effort et bornées : (1) recherche d'erreurs récentes dans le
 * journal d'activité, (2) vérification d'arborescence via la skill knowledge_search,
 * (3) nettoyage/compression sémantique (mémoire vectorielle + cache sémantique Vague 6D).
 */
export class IdleAutoAuditRunner {
  private running = false;

  constructor(private readonly agent: Agent, private readonly dedupeSimilarityThreshold = 0.97, private readonly scanWindow = 200) {}

  get isRunning(): boolean { return this.running; }

  async runOnce(): Promise<{ findings: string[] }> {
    if (this.running) return { findings: [] };
    this.running = true;
    const activity = new ActivityStore();
    activity.append({ eventType: "IDLE_AUDIT_STARTED", message: "Idle auto-audit started" });
    const findings: string[] = [];
    try {
      findings.push(...this.scanRecentErrors());
      findings.push(...(await this.checkKnowledgeTree()));
      findings.push(...this.compressVectorMemory());
      findings.push(...this.sweepCaches());
    } catch (error) {
      findings.push(`Idle audit pass failed: ${(error as Error).message}`);
    } finally {
      activity.append({
        eventType: "IDLE_AUDIT_COMPLETED",
        message: `Idle auto-audit completed (${findings.length} finding(s))`,
        metadata: { findings: findings.slice(0, 20) },
      });
      this.running = false;
    }
    return { findings };
  }

  /** Passe 1 : erreurs récentes du journal d'activité — signal brut, aucune action corrective automatique. */
  private scanRecentErrors(): string[] {
    const rows = new ActivityStore().list({ level: "error", limit: 50 });
    return rows.length ? [`${rows.length} recent error(s) found in activity log`] : [];
  }

  /** Passe 2 : vérification d'arborescence via la skill knowledge_search (action TREE), si disponible. */
  private async checkKnowledgeTree(): Promise<string[]> {
    const skill = this.agent.skills.get("knowledge_search");
    if (!skill?.handler || skill.availability !== "AVAILABLE") return [];
    const result = await this.agent.skills.execute("knowledge_search", { action: "TREE" }, { rememberFact: () => undefined });
    const failed = result.startsWith("Erreur");
    return [`knowledge_search TREE check ${failed ? "unavailable" : "OK"} (${result.length} char(s) returned)`];
  }

  /**
   * Passe 3a : compression sémantique de la mémoire épisodique — deux souvenirs quasi
   * identiques (similarité cosinus >= threshold) n'apportent rien de plus qu'un seul ;
   * on garde le plus récent et supprime les doublons. Fenêtre bornée (scanWindow) pour
   * rester O(n²) sur un lot raisonnable plutôt que sur toute la table.
   */
  private compressVectorMemory(): string[] {
    const db = getDb();
    const rows = db
      .prepare(`SELECT id, text, embedding, created_at FROM memory_entries WHERE kind='episodic' ORDER BY created_at DESC LIMIT ?`)
      .all(this.scanWindow) as MemoryRow[];
    const parsed = rows.map((row) => {
      let vector: number[] = [];
      try { vector = JSON.parse(row.embedding) as number[]; } catch { /* ignore malformed row */ }
      return { id: row.id, vector };
    });
    const toDelete: string[] = [];
    const dropped = new Set<string>();
    for (let i = 0; i < parsed.length; i += 1) {
      if (dropped.has(parsed[i].id) || parsed[i].vector.length === 0) continue;
      for (let j = i + 1; j < parsed.length; j += 1) {
        if (dropped.has(parsed[j].id) || parsed[j].vector.length === 0) continue;
        if (cosineSimilarity(parsed[i].vector, parsed[j].vector) >= this.dedupeSimilarityThreshold) {
          dropped.add(parsed[j].id);
          toDelete.push(parsed[j].id);
        }
      }
    }
    if (toDelete.length === 0) return [];
    const del = db.prepare(`DELETE FROM memory_entries WHERE id=?`);
    db.transaction((ids: string[]) => { for (const id of ids) del.run(id); })(toDelete);
    return [`Compressed ${toDelete.length} near-duplicate episodic memory entr${toDelete.length > 1 ? "ies" : "y"}`];
  }

  /** Passe 3b : purge des entrées de cache sémantique (Vague 6D) expirées par leur propre TTL. */
  private sweepCaches(): string[] {
    const swept = sweepExpiredSemanticCache();
    return swept ? [`Swept ${swept} expired semantic cache entr${swept > 1 ? "ies" : "y"}`] : [];
  }
}
