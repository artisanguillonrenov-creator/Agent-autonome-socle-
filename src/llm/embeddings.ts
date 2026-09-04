export interface EmbeddingProvider {
  readonly name: string;
  readonly dimensions: number;
  embed(text: string): Promise<number[]>;
}

const HASH_DIMENSIONS = 256;

/**
 * Feature hashing déterministe (bag-of-words haché avec signe) : aucune dépendance
 * externe, aucun appel réseau. C'est l'option par défaut ("zéro dépendance").
 * Moins précis sémantiquement qu'un vrai modèle d'embeddings, mais suffisant pour
 * un socle qui doit tourner offline dès le départ.
 */
export class LocalHashingEmbeddingProvider implements EmbeddingProvider {
  readonly name = "local";
  readonly dimensions = HASH_DIMENSIONS;

  async embed(text: string): Promise<number[]> {
    const vec = new Array(this.dimensions).fill(0);
    const tokens = text.toLowerCase().match(/[a-zà-öø-ÿ0-9]+/gi) ?? [];

    for (const token of tokens) {
      let hash = 2166136261;
      for (let i = 0; i < token.length; i++) {
        hash ^= token.charCodeAt(i);
        hash = Math.imul(hash, 16777619);
      }
      const index = Math.abs(hash) % this.dimensions;
      const sign = (hash & 1) === 0 ? 1 : -1;
      vec[index] += sign;
    }

    const norm = Math.sqrt(vec.reduce((sum, v) => sum + v * v, 0)) || 1;
    return vec.map((v) => v / norm);
  }
}

export function cosineSimilarity(a: number[], b: number[]): number {
  const len = Math.min(a.length, b.length);
  let dot = 0;
  let normA = 0;
  let normB = 0;
  for (let i = 0; i < len; i++) {
    dot += a[i] * b[i];
    normA += a[i] * a[i];
    normB += b[i] * b[i];
  }
  const denom = Math.sqrt(normA) * Math.sqrt(normB);
  return denom === 0 ? 0 : dot / denom;
}
