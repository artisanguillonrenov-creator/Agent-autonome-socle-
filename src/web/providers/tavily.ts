import type { SearchResult, WebSearchProvider } from "../searchProvider.js";

interface TavilyResponse {
  results?: Array<{
    title?: string;
    url?: string;
    content?: string;
  }>;
}

/**
 * Fournisseur Tavily : API de recherche IA optimisée.
 */
export class TavilySearchProvider implements WebSearchProvider {
  readonly name = "tavily";

  constructor(private readonly apiKey: string) {}

  async search(query: string, count = 5): Promise<SearchResult[]> {
    if (!this.apiKey) {
      throw new Error("TAVILY_API_KEY manquant pour la recherche web.");
    }

    try {
      const res = await fetch("https://api.tavily.com/search", {
        method: "POST",
        headers: {
          "content-type": "application/json",
        },
        body: JSON.stringify({
          api_key: this.apiKey,
          query,
          max_results: count,
          search_depth: "basic",
        }),
      });

      if (!res.ok) {
        throw new Error(`Tavily API ${res.status}: ${await res.text()}`);
      }

      const data = (await res.json()) as TavilyResponse;
      const results: SearchResult[] = [];

      for (const item of data.results ?? []) {
        if (item.title && item.url) {
          results.push({
            title: item.title.trim(),
            url: item.url.trim(),
            snippet: (item.content || "").replace(/<[^>]+>/g, "").trim(),
          });
        }
      }

      return results;
    } catch (err) {
      throw new Error(`Erreur Tavily Search: ${(err as Error).message}`);
    }
  }
}
