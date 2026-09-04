import type { SearchResult, WebSearchProvider } from "../searchProvider.js";

/** Provider par défaut : message clair plutôt qu'un échec silencieux tant qu'aucune clé n'est configurée. */
export class UnconfiguredSearchProvider implements WebSearchProvider {
  readonly name = "none";

  async search(_query: string, _count?: number): Promise<SearchResult[]> {
    throw new Error(
      "Aucun fournisseur de recherche web configuré. Définis WEB_SEARCH_PROVIDER=brave et " +
        "BRAVE_SEARCH_API_KEY dans .env (clé gratuite sur https://brave.com/search/api/).",
    );
  }
}
