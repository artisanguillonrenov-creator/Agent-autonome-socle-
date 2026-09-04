export interface SearchResult {
  title: string;
  url: string;
  snippet: string;
}

/** Interface agnostique, comme LLMProvider/EmbeddingProvider : aucun moteur de recherche gratuit sans clé n'existe. */
export interface WebSearchProvider {
  readonly name: string;
  search(query: string, count?: number): Promise<SearchResult[]>;
}
