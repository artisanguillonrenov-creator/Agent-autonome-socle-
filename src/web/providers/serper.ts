import type { SearchResult, WebSearchProvider } from "../searchProvider.js";

interface SerperResponse {
  organic?: Array<{
    title?: string;
    link?: string;
    snippet?: string;
  }>;
}

/**
 * Fournisseur Serper (Google Search API).
 */
export class SerperSearchProvider implements WebSearchProvider {
  readonly name = "serper";

  constructor(private readonly apiKey: string) {}

  async search(query: string, count = 5): Promise<SearchResult[]> {
    if (!this.apiKey) {
      throw new Error("SERPER_API_KEY manquant pour la recherche web.");
    }

    try {
      const res = await fetch("https://google.serper.dev/search", {
        method: "POST",
        headers: {
          "X-API-KEY": this.apiKey,
          "content-type": "application/json",
        },
        body: JSON.stringify({
          q: query,
          num: count,
        }),
      });

      if (!res.ok) {
        throw new Error(`Serper API ${res.status}: ${await res.text()}`);
      }

      const data = (await res.json()) as SerperResponse;
      const results: SearchResult[] = [];

      for (const item of data.organic ?? []) {
        if (item.title && item.link) {
          results.push({
            title: item.title.trim(),
            url: item.link.trim(),
            snippet: (item.snippet || "").replace(/<[^>]+>/g, "").trim(),
          });
        }
      }

      return results;
    } catch (err) {
      throw new Error(`Erreur Serper Search: ${(err as Error).message}`);
    }
  }
}
