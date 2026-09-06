import { config, type LLMProviderName } from "../../config.js";
import type { LLMProvider } from "../provider.js";
import { AnthropicProvider } from "./anthropic.js";
import { OpenAIProvider } from "./openai.js";
import { OpenRouterProvider } from "./openrouter.js";
import { OllamaProvider } from "./ollama.js";
import { InfermaticProvider } from "./infermatic.js";
import { MockProvider } from "./mock.js";
import { loadLLMConfig } from "../../persistence/llmConfigStore.js";

export interface LLMProviderOptions {
  provider?: LLMProviderName;
  model?: string;
}

/** Factory : crée une instance de LLMProvider selon la config active ou les options. */
export function createLLMProvider(opts?: LLMProviderOptions): LLMProvider {
  // Try loading persistent selection if not explicitly provided
  let providerName = opts?.provider;
  let modelName = opts?.model;

  if (!providerName || !modelName) {
    const saved = loadLLMConfig();
    if (saved) {
      providerName = providerName || saved.provider;
      modelName = modelName || saved.model;
    }
  }

  providerName = providerName || config.llm.provider;
  modelName = modelName || config.llm.model;

  // Sync config
  config.llm.provider = providerName;
  config.llm.model = modelName;

  switch (providerName) {
    case "anthropic":
      return new AnthropicProvider({ apiKey: config.llm.anthropicApiKey, model: modelName });
    case "openai":
      return new OpenAIProvider({ apiKey: config.llm.openaiApiKey, model: modelName });
    case "openrouter":
      return new OpenRouterProvider({ apiKey: config.llm.openrouterApiKey, model: modelName });
    case "ollama":
      return new OllamaProvider({ baseUrl: config.llm.ollamaBaseUrl, model: modelName });
    case "infermatic":
      return new InfermaticProvider({
        apiKey: config.llm.infermaticApiKey,
        baseUrl: config.llm.infermaticBaseUrl,
        model: modelName,
      });
    case "mock":
      return new MockProvider();
    default:
      throw new Error(`Fournisseur LLM inconnu: ${providerName}`);
  }
}
