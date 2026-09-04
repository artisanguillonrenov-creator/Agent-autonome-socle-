import type { EmbeddingProvider } from "../embeddings.js";

export class OpenAIEmbeddingProvider implements EmbeddingProvider {
  readonly name = "openai";
  readonly dimensions = 1536;

  constructor(private readonly apiKey: string, private readonly model = "text-embedding-3-small") {}

  async embed(text: string): Promise<number[]> {
    if (!this.apiKey) {
      throw new Error("OPENAI_API_KEY manquant : impossible d'appeler les embeddings openai.");
    }
    const res = await fetch("https://api.openai.com/v1/embeddings", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        authorization: `Bearer ${this.apiKey}`,
      },
      body: JSON.stringify({ model: this.model, input: text }),
    });
    if (!res.ok) {
      throw new Error(`OpenAI embeddings API ${res.status}: ${await res.text()}`);
    }
    const data = (await res.json()) as { data: Array<{ embedding: number[] }> };
    return data.data[0].embedding;
  }
}
