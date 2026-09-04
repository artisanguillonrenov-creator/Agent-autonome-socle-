import { config } from "../config.js";
import type { EmbeddingProvider } from "./embeddings.js";
import { LocalHashingEmbeddingProvider } from "./embeddings.js";
import { OpenAIEmbeddingProvider } from "./providers/openaiEmbeddings.js";
import { VoyageEmbeddingProvider } from "./providers/voyageEmbeddings.js";

export function createEmbeddingProvider(): EmbeddingProvider {
  switch (config.embeddings.provider) {
    case "local":
      return new LocalHashingEmbeddingProvider();
    case "openai":
      return new OpenAIEmbeddingProvider(config.embeddings.openaiApiKey);
    case "voyage":
      return new VoyageEmbeddingProvider(config.embeddings.voyageApiKey);
    default:
      throw new Error(`Fournisseur d'embeddings inconnu: ${config.embeddings.provider}`);
  }
}
