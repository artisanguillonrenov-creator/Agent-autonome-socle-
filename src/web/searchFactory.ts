import { config } from "../config.js";
import type { WebSearchProvider } from "./searchProvider.js";
import { BraveSearchProvider } from "./providers/brave.js";
import { DuckDuckGoSearchProvider } from "./providers/duckduckgo.js";
import { UnconfiguredSearchProvider } from "./providers/unconfigured.js";

export function createWebSearchProvider(): WebSearchProvider {
  switch (config.webSearch.provider) {
    case "brave":
      return new BraveSearchProvider(config.webSearch.braveApiKey);
    case "duckduckgo":
      return new DuckDuckGoSearchProvider();
    default:
      return new UnconfiguredSearchProvider();
  }
}
