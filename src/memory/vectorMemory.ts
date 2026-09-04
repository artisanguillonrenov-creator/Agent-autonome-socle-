import { randomUUID } from "node:crypto";
import { getDb } from "../persistence/db.js";
import { cosineSimilarity } from "../llm/embeddings.js";
import type { EmbeddingProvider } from "../llm/embeddings.js";
import type { MemoryEntry } from "../types.js";

interface MemoryRow {
  id: string;
  text: string;
  kind: string;
  created_at: number;
  embedding: string;
}

/**
 * Brique 2b : mémoire longue par similarité. Stockage SQLite (une ligne par
 * souvenir), recherche par cosine similarity calculée en JS — pas de service
 * de vector DB à faire tourner, ça reste un fichier local.
 */
export class VectorMemory {
  constructor(private readonly embeddings: EmbeddingProvider) {}

  async add(text: string, kind: MemoryEntry["kind"] = "episodic"): Promise<MemoryEntry> {
    const embedding = await this.embeddings.embed(text);
    const entry: MemoryEntry = { id: randomUUID(), text, kind, createdAt: Date.now(), embedding };

    getDb()
      .prepare(
        `INSERT INTO memory_entries (id, text, kind, created_at, embedding) VALUES (?, ?, ?, ?, ?)`,
      )
      .run(entry.id, entry.text, entry.kind, entry.createdAt, JSON.stringify(entry.embedding));

    return entry;
  }

  async search(query: string, topK = 5): Promise<Array<MemoryEntry & { score: number }>> {
    const queryEmbedding = await this.embeddings.embed(query);
    const rows = getDb().prepare(`SELECT * FROM memory_entries`).all() as MemoryRow[];

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

  count(): number {
    const row = getDb().prepare(`SELECT COUNT(*) as n FROM memory_entries`).get() as { n: number };
    return row.n;
  }
}
