import type { WorkspaceStore } from "../workspaces/workspaceStore.js";
import type { VectorMemory } from "../memory/vectorMemory.js";
import { readDocument } from "./documentEngine.js";

const CHUNK_CHARS = 1500;
const CHUNK_OVERLAP = 200;

function sourceKeyFor(workspaceId: string, path: string): string {
  return `knowledge:${workspaceId}:${path}`;
}

function chunk(text: string): string[] {
  const trimmed = text.trim();
  if (!trimmed) return [];
  if (trimmed.length <= CHUNK_CHARS) return [trimmed];

  const chunks: string[] = [];
  let start = 0;
  while (start < trimmed.length) {
    const end = Math.min(start + CHUNK_CHARS, trimmed.length);
    chunks.push(trimmed.slice(start, end));
    if (end >= trimmed.length) break;
    start = end - CHUNK_OVERLAP;
  }
  return chunks;
}

/**
 * Chantier 8 (projects.knowledgeRag / autoIndexing) : indexe un document du workspace
 * dans la même brique VectorMemory que le reste de la mémoire (kind="knowledge",
 * scopée au workspace). Idempotent : supprime d'abord tout index existant pour ce
 * chemin (source_key) avant de ré-indexer — jamais de doublons après une mise à jour.
 */
export async function indexWorkspaceDocument(
  workspaces: WorkspaceStore,
  vectorMemory: VectorMemory,
  workspaceId: string,
  path: string,
): Promise<{ indexed: boolean; chunks: number; reason?: string }> {
  const sourceKey = sourceKeyFor(workspaceId, path);
  vectorMemory.removeBySourceKey(sourceKey);

  let text: string;
  try {
    const doc = await readDocument(workspaces, workspaceId, path);
    text = doc.text;
  } catch (err) {
    return { indexed: false, chunks: 0, reason: (err as Error).message };
  }

  const pieces = chunk(text);
  for (const piece of pieces) {
    await vectorMemory.add(piece, "knowledge", { workspaceId, sourceKey });
  }
  return { indexed: pieces.length > 0, chunks: pieces.length };
}

/** Retire l'index d'un document supprimé du workspace — l'index reste cohérent avec le contenu réel. */
export function removeWorkspaceDocumentIndex(vectorMemory: VectorMemory, workspaceId: string, path: string): number {
  return vectorMemory.removeBySourceKey(sourceKeyFor(workspaceId, path));
}

export interface KnowledgeMatch {
  text: string;
  score: number;
}

/** Recherche sémantique confinée aux chunks indexés de ce workspace (kind="knowledge"). */
export async function searchWorkspaceKnowledge(
  vectorMemory: VectorMemory,
  workspaceId: string,
  query: string,
  topK = 5,
): Promise<KnowledgeMatch[]> {
  const results = await vectorMemory.search(query, topK, { workspaceId, kind: "knowledge", strictWorkspaceScope: true });
  return results.map((r) => ({ text: r.text, score: r.score }));
}
