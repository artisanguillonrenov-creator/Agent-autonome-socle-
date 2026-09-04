import type { SearchResult, WebSearchProvider } from "../searchProvider.js";

interface DuckDuckGoResponse {
  AbstractText?: string;
  AbstractURL?: string;
  Heading?: string;
  RelatedTopics?: Array<{ Text?: string; FirstURL?: string }>;
}

/**
 * API "Instant Answer" de DuckDuckGo : gratuite, sans clé, sans inscription,
 * sans carte bancaire. En échange : pas de liste de résultats classique,
 * seulement des réponses factuelles courtes (définitions, résumés,
 * désambiguïsations) — plus limité qu'un vrai moteur de recherche.
 */
export class DuckDuckGoSearchProvider implements WebSearchProvider {
  readonly name = "duckduckgo";

  async search(query: string, count = 5): Promise<SearchResult[]> {
    const url = new URL("https://api.duckduckgo.com/");
    url.searchParams.set("q", query);
    url.searchParams.set("format", "json");
    url.searchParams.set("no_html", "1");
    url.searchParams.set("skip_disambig", "1");

    const res = await fetch(url);
    if (!res.ok) {
      throw new Error(`DuckDuckGo API ${res.status}: ${await res.text()}`);
    }

    const data = (await res.json()) as DuckDuckGoResponse;
    const results: SearchResult[] = [];

    if (data.AbstractText && data.AbstractURL) {
      results.push({ title: data.Heading || query, url: data.AbstractURL, snippet: data.AbstractText });
    }

    for (const topic of data.RelatedTopics ?? []) {
      if (topic.Text && topic.FirstURL) {
        results.push({ title: topic.Text.split(" - ")[0], url: topic.FirstURL, snippet: topic.Text });
      }
      if (results.length >= count) break;
    }

    return results.slice(0, count);
  }
}
