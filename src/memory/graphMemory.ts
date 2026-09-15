import { randomUUID } from "node:crypto";
import { getDb } from "../persistence/db.js";

export interface GraphTriple {
  id: string;
  subject: string;
  predicate: string;
  object: string;
  confidence: number;
  source?: string;
  workspaceId?: string;
  createdAt: number;
  updatedAt: number;
}

interface GraphTripleRow {
  id: string;
  subject: string;
  predicate: string;
  object: string;
  confidence: number;
  source: string | null;
  workspace_id: string | null;
  created_at: number;
  updated_at: number;
}

function toTriple(row: GraphTripleRow): GraphTriple {
  return {
    id: row.id,
    subject: row.subject,
    predicate: row.predicate,
    object: row.object,
    confidence: row.confidence,
    source: row.source ?? undefined,
    workspaceId: row.workspace_id ?? undefined,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

/** Mots trop courants/peu discriminants pour servir de point d'entrée dans le graphe. */
const STOPWORDS = new Set([
  "le", "la", "les", "un", "une", "des", "de", "du", "et", "ou", "est", "sont", "pour", "avec",
  "dans", "sur", "que", "qui", "ce", "cette", "ces", "il", "elle", "je", "tu", "nous", "vous",
  "the", "a", "an", "and", "or", "is", "are", "for", "with", "in", "on", "that", "this", "these",
]);

function extractKeywords(text: string, max = 8): string[] {
  const words = text
    .toLowerCase()
    .replace(/[^a-zà-öø-ÿ0-9\s'-]/gi, " ")
    .split(/\s+/)
    .map((w) => w.trim())
    .filter((w) => w.length >= 3 && !STOPWORDS.has(w));
  return Array.from(new Set(words)).slice(0, max);
}

/**
 * Brique 4 : mémoire relationnelle (5ème couche mémoire, après working/vector/facts/user
 * model) — un graphe de connaissances léger stocké en SQLite (aucun moteur de graphe
 * dédié requis) : des triplets (Sujet, Prédicat, Objet) extraits par ReflectionEngine à la
 * fin des cycles/conversations, retrouvés par MemoryManager.retrieve() pour compléter la
 * recherche vectorielle par des relations explicites entre entités.
 */
export class GraphMemory {
  /** Upsert : une même (subject, predicate, object, workspace) vue à nouveau renforce sa confiance plutôt que de dupliquer la ligne. */
  addTriple(
    subject: string,
    predicate: string,
    object: string,
    opts: { confidence?: number; source?: string; workspaceId?: string } = {},
  ): GraphTriple {
    const s = subject.trim();
    const p = predicate.trim();
    const o = object.trim();
    if (!s || !p || !o) throw new Error("INVALID_TRIPLE: subject/predicate/object requis");

    const db = getDb();
    const workspaceId = opts.workspaceId ?? null;
    const existing = db
      .prepare(
        `SELECT * FROM knowledge_graph_triples WHERE subject = ? AND predicate = ? AND object = ? AND workspace_id IS ?`,
      )
      .get(s, p, o, workspaceId) as GraphTripleRow | undefined;

    const now = Date.now();
    if (existing) {
      const confidence = Math.min(1, Math.max(existing.confidence, opts.confidence ?? existing.confidence));
      db.prepare(`UPDATE knowledge_graph_triples SET confidence = ?, source = COALESCE(?, source), updated_at = ? WHERE id = ?`)
        .run(confidence, opts.source ?? null, now, existing.id);
      return toTriple({ ...existing, confidence, source: opts.source ?? existing.source, updated_at: now });
    }

    const triple: GraphTriple = {
      id: randomUUID(),
      subject: s,
      predicate: p,
      object: o,
      confidence: opts.confidence ?? 1,
      source: opts.source,
      workspaceId: opts.workspaceId,
      createdAt: now,
      updatedAt: now,
    };
    db.prepare(
      `INSERT INTO knowledge_graph_triples (id, subject, predicate, object, confidence, source, workspace_id, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run(triple.id, triple.subject, triple.predicate, triple.object, triple.confidence, triple.source ?? null, workspaceId, now, now);
    return triple;
  }

  /** Triplets où `entity` apparaît comme sujet OU objet (recherche insensible à la casse par substring). */
  findRelated(entity: string, opts: { workspaceId?: string; limit?: number } = {}): GraphTriple[] {
    const term = entity.trim();
    if (!term) return [];
    const limit = opts.limit ?? 10;
    const workspaceClause = opts.workspaceId ? "AND (workspace_id = ? OR workspace_id IS NULL)" : "";
    const params: unknown[] = [`%${term}%`, `%${term}%`];
    if (opts.workspaceId) params.push(opts.workspaceId);
    params.push(limit);
    const rows = getDb()
      .prepare(
        `SELECT * FROM knowledge_graph_triples WHERE (subject LIKE ? OR object LIKE ?) ${workspaceClause}
         ORDER BY confidence DESC, updated_at DESC LIMIT ?`,
      )
      .all(...params) as GraphTripleRow[];
    return rows.map(toTriple);
  }

  /** Extrait des mots-clés de `text` (ex. la requête utilisateur) et combine les triplets reliés à chacun, dédupliqués. */
  searchByKeywords(text: string, opts: { workspaceId?: string; limit?: number } = {}): GraphTriple[] {
    const limit = opts.limit ?? 5;
    const keywords = extractKeywords(text);
    if (keywords.length === 0) return [];
    const seen = new Set<string>();
    const results: GraphTriple[] = [];
    for (const keyword of keywords) {
      if (results.length >= limit) break;
      for (const triple of this.findRelated(keyword, { workspaceId: opts.workspaceId, limit })) {
        if (seen.has(triple.id)) continue;
        seen.add(triple.id);
        results.push(triple);
        if (results.length >= limit) break;
      }
    }
    return results;
  }

  all(workspaceId?: string): GraphTriple[] {
    const rows = workspaceId
      ? (getDb().prepare(`SELECT * FROM knowledge_graph_triples WHERE workspace_id = ?`).all(workspaceId) as GraphTripleRow[])
      : (getDb().prepare(`SELECT * FROM knowledge_graph_triples`).all() as GraphTripleRow[]);
    return rows.map(toTriple);
  }

  count(): number {
    const row = getDb().prepare(`SELECT COUNT(*) as n FROM knowledge_graph_triples`).get() as { n: number };
    return row.n;
  }
}

/** Formatte un triplet pour injection directe dans le contexte du prompt (voir src/core/agent.ts). */
export function formatTriple(triple: GraphTriple): string {
  return `${triple.subject} —${triple.predicate}→ ${triple.object}`;
}
