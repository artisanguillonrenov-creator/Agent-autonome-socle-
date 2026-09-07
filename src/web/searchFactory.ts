import { config } from "../config.js";
import type { WebSearchProvider } from "./searchProvider.js";
import { BraveSearchProvider } from "./providers/brave.js";
import { TavilySearchProvider } from "./providers/tavily.js";
import { SerperSearchProvider } from "./providers/serper.js";
import { DuckDuckGoSearchProvider } from "./providers/duckduckgo.js";

export function createWebSearchProvider(): WebSearchProvider {
  // Sélection automatique prioritaire par clé d'API explicite si renseignée
  if (config.webSearch.tavilyApiKey) {
    return new TavilySearchProvider(config.webSearch.tavilyApiKey);
  }
  if (config.webSearch.serperApiKey) {
    return new SerperSearchProvider(config.webSearch.serperApiKey);
  }

  switch (config.webSearch.provider) {
    case "tavily":
      return new TavilySearchProvider(config.webSearch.tavilyApiKey);
    case "serper":
      return new SerperSearchProvider(config.webSearch.serperApiKey);
    case "brave":
      return new BraveSearchProvider(config.webSearch.braveApiKey);
    case "duckduckgo":
    case "none":
    default:
      return new DuckDuckGoSearchProvider();
  }
}
