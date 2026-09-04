import type { EmbeddingProvider } from "../embeddings.js";

/** Voyage AI — recommandé par Anthropic pour les embeddings (Claude n'a pas d'API d'embeddings native). */
export class VoyageEmbeddingProvider implements EmbeddingProvider {
  readonly name = "voyage";
  readonly dimensions = 1024;

  constructor(private readonly apiKey: string, private readonly model = "voyage-3.5") {}

  async embed(text: string): Promise<number[]> {
    if (!this.apiKey) {
      throw new Error("VOYAGE_API_KEY manquant : impossible d'appeler les embeddings voyage.");
    }
    const res = await fetch("https://api.voyageai.com/v1/embeddings", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        authorization: `Bearer ${this.apiKey}`,
      },
      body: JSON.stringify({ model: this.model, input: [text] }),
    });
    if (!res.ok) {
      throw new Error(`Voyage embeddings API ${res.status}: ${await res.text()}`);
    }
    const data = (await res.json()) as { data: Array<{ embedding: number[] }> };
    return data.data[0].embedding;
  }
}
