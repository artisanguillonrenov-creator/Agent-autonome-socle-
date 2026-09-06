import { config } from "../../config.js";
import type { LLMProvider } from "../provider.js";
import { AnthropicProvider } from "./anthropic.js";
import { OpenAIProvider } from "./openai.js";
import { OpenRouterProvider } from "./openrouter.js";
import { OllamaProvider } from "./ollama.js";
import { InfermaticProvider } from "./infermatic.js";
import { MockProvider } from "./mock.js";

/** Factory : le reste du système ne connaît que l'interface LLMProvider. */
export function createLLMProvider(): LLMProvider {
  switch (config.llm.provider) {
    case "anthropic":
      return new AnthropicProvider({ apiKey: config.llm.anthropicApiKey, model: config.llm.model });
    case "openai":
      return new OpenAIProvider({ apiKey: config.llm.openaiApiKey, model: config.llm.model });
    case "openrouter":
      return new OpenRouterProvider({ apiKey: config.llm.openrouterApiKey, model: config.llm.model });
    case "ollama":
      return new OllamaProvider({ baseUrl: config.llm.ollamaBaseUrl, model: config.llm.model });
    case "infermatic":
      return new InfermaticProvider({
        apiKey: config.llm.infermaticApiKey,
        baseUrl: config.llm.infermaticBaseUrl,
        model: config.llm.model,
      });
    case "mock":
      return new MockProvider();
    default:
      throw new Error(`Fournisseur LLM inconnu: ${config.llm.provider}`);
  }
}
