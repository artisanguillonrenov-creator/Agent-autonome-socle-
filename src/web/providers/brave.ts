import type { SearchResult, WebSearchProvider } from "../searchProvider.js";

interface BraveResponse {
  web?: { results?: Array<{ title: string; url: string; description: string }> };
}

/** Brave Search API — clé gratuite (tier limité) sur https://brave.com/search/api/ */
export class BraveSearchProvider implements WebSearchProvider {
  readonly name = "brave";

  constructor(private readonly apiKey: string) {}

  async search(query: string, count = 5): Promise<SearchResult[]> {
    if (!this.apiKey) {
      throw new Error("BRAVE_SEARCH_API_KEY manquant : impossible d'appeler la recherche web.");
    }

    const url = new URL("https://api.search.brave.com/res/v1/web/search");
    url.searchParams.set("q", query);
    url.searchParams.set("count", String(count));

    const res = await fetch(url, {
      headers: { Accept: "application/json", "X-Subscription-Token": this.apiKey },
    });
    if (!res.ok) {
      throw new Error(`Brave Search API ${res.status}: ${await res.text()}`);
    }

    const data = (await res.json()) as BraveResponse;
    return (data.web?.results ?? []).map((r) => ({ title: r.title, url: r.url, snippet: r.description }));
  }
}
