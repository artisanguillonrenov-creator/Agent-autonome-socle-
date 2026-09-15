import { randomUUID } from "node:crypto";
import { getDb } from "../persistence/db.js";
import { cosineSimilarity } from "../llm/embeddings.js";
import type { EmbeddingProvider } from "../llm/embeddings.js";
import type { LLMCompletionResult } from "../llm/provider.js";
import { config } from "../config.js";

interface SemanticCacheRow {
  id: string;
  role: string;
  model: string;
  prompt_text: string;
  prompt_embedding: string;
  response_json: string;
  created_at: number;
  last_hit_at: number;
  hit_count: number;
}

export interface SemanticCacheHit {
  response: LLMCompletionResult;
  similarity: number;
  cachedAt: number;
}

/**
 * Vague 6D (cache sémantique local) : évite de repayer un appel LLM pour une requête déjà
 * traitée récemment. Réutilise la base SQLite existante (aucune dépendance supplémentaire)
 * et le fournisseur d'embeddings actif (EMBEDDING_PROVIDER=local par défaut) pour calculer
 * une similarité cosinus entre la nouvelle requête et les entrées déjà en cache — un score
 * >= threshold (0.95 par défaut) déclenche un renvoi immédiat, sans appel réseau.
 * Partitionné par (role, model) : un changement de modèle actif ou de rôle de routage
 * (reasoning/fast/coding/...) ne peut jamais réutiliser la réponse d'un autre.
 */
export class SemanticCache {
  constructor(
    private readonly embeddings: EmbeddingProvider,
    private readonly similarityThreshold = config.semanticCache.similarityThreshold,
    private readonly ttlMs = config.semanticCache.ttlMs,
    private readonly maxCandidates = 200,
  ) {}

  async lookup(role: string, model: string, promptText: string): Promise<SemanticCacheHit | null> {
    const normalized = promptText.trim();
    if (!normalized) return null;
    try {
      const cutoff = Date.now() - this.ttlMs;
      const rows = getDb()
        .prepare(`SELECT * FROM semantic_cache_entries WHERE role=? AND model=? AND created_at>=? ORDER BY last_hit_at DESC LIMIT ?`)
        .all(role, model, cutoff, this.maxCandidates) as SemanticCacheRow[];
      if (rows.length === 0) return null;

      const queryEmbedding = await this.embeddings.embed(normalized);
      let best: { row: SemanticCacheRow; score: number } | null = null;
      for (const row of rows) {
        let embedding: number[];
        try { embedding = JSON.parse(row.prompt_embedding) as number[]; } catch { continue; }
        const score = cosineSimilarity(queryEmbedding, embedding);
        if (!best || score > best.score) best = { row, score };
      }
      if (!best || best.score < this.similarityThreshold) return null;

      let response: LLMCompletionResult;
      try { response = JSON.parse(best.row.response_json) as LLMCompletionResult; } catch { return null; }

      const now = Date.now();
      getDb().prepare(`UPDATE semantic_cache_entries SET last_hit_at=?, hit_count=hit_count+1 WHERE id=?`).run(now, best.row.id);
      return { response, similarity: best.score, cachedAt: best.row.created_at };
    } catch (error) {
      // Ne bloque jamais le tour en cours : un cache indisponible équivaut à un cache vide.
      console.warn("[SemanticCache] lookup failed:", (error as Error).message);
      return null;
    }
  }

  /** Best-effort, jamais bloquant pour le tour en cours — un échec d'écriture n'invalide jamais la réponse déjà servie. */
  async store(role: string, model: string, promptText: string, response: LLMCompletionResult): Promise<void> {
    const normalized = promptText.trim();
    if (!normalized) return;
    try {
      const embedding = await this.embeddings.embed(normalized);
      const now = Date.now();
      getDb()
        .prepare(`INSERT INTO semantic_cache_entries(id,role,model,prompt_text,prompt_embedding,response_json,created_at,last_hit_at,hit_count) VALUES(?,?,?,?,?,?,?,?,0)`)
        .run(randomUUID(), role, model, normalized.slice(0, 4000), JSON.stringify(embedding), JSON.stringify(response), now, now);
    } catch (error) {
      console.warn("[SemanticCache] store failed:", (error as Error).message);
    }
  }

  /** Purge les entrées expirées (TTL) — appelée périodiquement par la routine IdleAutoAudit (Vague 7A). */
  sweepExpired(): number {
    return sweepExpiredSemanticCache(this.ttlMs);
  }
}

/** Variante autonome (pas besoin d'un EmbeddingProvider) pour les routines de maintenance. */
export function sweepExpiredSemanticCache(ttlMs = config.semanticCache.ttlMs): number {
  return getDb().prepare(`DELETE FROM semantic_cache_entries WHERE created_at < ?`).run(Date.now() - ttlMs).changes;
}
