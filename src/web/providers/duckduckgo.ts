import type { SearchResult, WebSearchProvider } from "../searchProvider.js";

interface DuckDuckGoResponse {
  AbstractText?: string;
  AbstractURL?: string;
  Heading?: string;
  RelatedTopics?: Array<{ Text?: string; FirstURL?: string }>;
}

/**
 * Fournisseur DuckDuckGo : recherche via l'API Instant Answer
 * avec repli automatique sur la recherche HTML DuckDuckGo pour obtenir de vrais extraits du Web.
 */
export class DuckDuckGoSearchProvider implements WebSearchProvider {
  readonly name = "duckduckgo";

  async search(query: string, count = 5): Promise<SearchResult[]> {
    // 1. Essayer l'API Instant Answer
    const apiResults = await this.searchApi(query, count);
    if (apiResults.length > 0) return apiResults;

    // 2. Repli sur la recherche HTML DuckDuckGo si l'API ne renvoie aucun résultat
    return this.searchHtml(query, count);
  }

  private async searchApi(query: string, count: number): Promise<SearchResult[]> {
    try {
      const url = new URL("https://api.duckduckgo.com/");
      url.searchParams.set("q", query);
      url.searchParams.set("format", "json");
      url.searchParams.set("no_html", "1");
      url.searchParams.set("skip_disambig", "1");

      const res = await fetch(url);
      if (!res.ok) return [];

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
    } catch {
      return [];
    }
  }

  private async searchHtml(query: string, count: number): Promise<SearchResult[]> {
    try {
      const url = `https://html.duckduckgo.com/html/?q=${encodeURIComponent(query)}`;
      const res = await fetch(url, {
        headers: {
          "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36",
        },
      });

      if (!res.ok) return [];

      const html = await res.text();
      const results: SearchResult[] = [];

      const regex = /<a class="result__url"[^>]*href="([^"]+)"[^>]*>[\s\S]*?<a class="result__a"[^>]*>([\s\S]*?)<\/a>[\s\S]*?<a class="result__snippet"[^>]*>([\s\S]*?)<\/a>/g;
      let match: RegExpExecArray | null;

      while ((match = regex.exec(html)) !== null && results.length < count) {
        let rawUrl = match[1].trim();
        if (rawUrl.startsWith("//duckduckgo.com/l/?uddg=")) {
          const params = new URLSearchParams(rawUrl.split("?")[1]);
          rawUrl = params.get("uddg") || rawUrl;
        }

        const title = match[2].replace(/<[^>]+>/g, "").trim();
        const snippet = match[3].replace(/<[^>]+>/g, "").trim();

        if (title && snippet) {
          results.push({ title, url: rawUrl, snippet });
        }
      }

      return results;
    } catch {
      return [];
    }
  }
}
