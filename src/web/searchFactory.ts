import { config } from "../config.js";
import type { WebSearchProvider } from "./searchProvider.js";
import { BraveSearchProvider } from "./providers/brave.js";
import { UnconfiguredSearchProvider } from "./providers/unconfigured.js";

export function createWebSearchProvider(): WebSearchProvider {
  switch (config.webSearch.provider) {
    case "brave":
      return new BraveSearchProvider(config.webSearch.braveApiKey);
    default:
      return new UnconfiguredSearchProvider();
  }
}
