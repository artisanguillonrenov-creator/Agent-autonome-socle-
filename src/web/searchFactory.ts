import { config } from "../config.js";
import type { WebSearchProvider } from "./searchProvider.js";
import { BraveSearchProvider } from "./providers/brave.js";
import { DuckDuckGoSearchProvider } from "./providers/duckduckgo.js";

export function createWebSearchProvider(): WebSearchProvider {
  switch (config.webSearch.provider) {
    case "brave":
      return new BraveSearchProvider(config.webSearch.braveApiKey);
    case "duckduckgo":
    case "none":
    default:
      return new DuckDuckGoSearchProvider();
  }
}
