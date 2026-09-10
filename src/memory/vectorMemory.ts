import { randomUUID } from "node:crypto";
import { getDb } from "../persistence/db.js";
import { cosineSimilarity } from "../llm/embeddings.js";
import type { EmbeddingProvider } from "../llm/embeddings.js";
import type { MemoryEntry } from "../types.js";
import { config } from "../config.js";

interface MemoryRow {
  id: string;
  text: string;
  kind: string;
  created_at: number;
  embedding: string;
  workspace_id: string | null;
  source_key: string | null;
}

export interface VectorMemoryAddOptions {
  /** Projet/workspace propriétaire de ce souvenir (projects.projectIsolation). */
  workspaceId?: string;
  /** Clé stable identifiant la source (ex: chemin de fichier) — permet de retrouver/supprimer tous les chunks d'un même document (projects.knowledgeRag / autoIndexing). */
  sourceKey?: string;
}

/**
 * Brique 2b : mémoire longue par similarité. Stockage SQLite (une ligne par
 * souvenir), recherche par cosine similarity calculée en JS — pas de service
 * de vector DB à faire tourner, ça reste un fichier local.
 */
export class VectorMemory {
  constructor(private readonly embeddings: EmbeddingProvider) {}

  async add(text: string, kind: MemoryEntry["kind"] = "episodic", opts: VectorMemoryAddOptions = {}): Promise<MemoryEntry> {
    const embedding = await this.embeddings.embed(text);
    const entry: MemoryEntry = { id: randomUUID(), text, kind, createdAt: Date.now(), embedding };

    getDb()
      .prepare(
        `INSERT INTO memory_entries (id, text, kind, created_at, embedding, workspace_id, source_key) VALUES (?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(entry.id, entry.text, entry.kind, entry.createdAt, JSON.stringify(entry.embedding), opts.workspaceId ?? null, opts.sourceKey ?? null);

    return entry;
  }

  /**
   * `strictWorkspaceScope` : filtrage par workspace TOUJOURS appliqué quand un
   * `workspaceId` est fourni — utilisé par le RAG projet (searchWorkspaceKnowledge), où
   * "chercher dans ce projet" est le sens même de l'appel, indépendamment du réglage
   * d'isolation.
   * Sans ce flag (mémoire conversationnelle), le filtrage ne s'applique que si
   * projects.projectIsolation est activé ; sinon comportement historique inchangé :
   * recherche sur l'ensemble des souvenirs.
   */
  async search(
    query: string,
    topK = 5,
    opts: { workspaceId?: string; kind?: MemoryEntry["kind"]; strictWorkspaceScope?: boolean } = {},
  ): Promise<Array<MemoryEntry & { score: number }>> {
    const queryEmbedding = await this.embeddings.embed(query);
    const isolate = Boolean(opts.workspaceId) && (opts.strictWorkspaceScope || config.projects.projectIsolation);

    let rows: MemoryRow[];
    if (isolate && opts.kind) {
      rows = getDb().prepare(`SELECT * FROM memory_entries WHERE workspace_id = ? AND kind = ?`).all(opts.workspaceId, opts.kind) as MemoryRow[];
    } else if (isolate) {
      rows = getDb().prepare(`SELECT * FROM memory_entries WHERE workspace_id = ?`).all(opts.workspaceId) as MemoryRow[];
    } else if (opts.kind) {
      rows = getDb().prepare(`SELECT * FROM memory_entries WHERE kind = ?`).all(opts.kind) as MemoryRow[];
    } else {
      rows = getDb().prepare(`SELECT * FROM memory_entries`).all() as MemoryRow[];
    }

    return rows
      .map((row) => {
        const embedding = JSON.parse(row.embedding) as number[];
        return {
          id: row.id,
          text: row.text,
          kind: row.kind as MemoryEntry["kind"],
          createdAt: row.created_at,
          embedding,
          score: cosineSimilarity(queryEmbedding, embedding),
        };
      })
      .sort((a, b) => b.score - a.score)
      .slice(0, topK);
  }

  /** Supprime tous les chunks indexés pour `sourceKey` (ré-indexation sans doublon, ou suppression du document source). */
  removeBySourceKey(sourceKey: string): number {
    const result = getDb().prepare(`DELETE FROM memory_entries WHERE source_key = ?`).run(sourceKey);
    return result.changes;
  }

  count(): number {
    const row = getDb().prepare(`SELECT COUNT(*) as n FROM memory_entries`).get() as { n: number };
    return row.n;
  }
}
