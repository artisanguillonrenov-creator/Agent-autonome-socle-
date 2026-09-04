import "dotenv/config";

export type LLMProviderName = "anthropic" | "openai" | "ollama" | "mock";
export type EmbeddingProviderName = "local" | "openai" | "voyage";

function int(value: string | undefined, fallback: number): number {
  const n = Number(value);
  return Number.isFinite(n) && n > 0 ? n : fallback;
}

export const config = {
  llm: {
    provider: (process.env.LLM_PROVIDER as LLMProviderName) || "mock",
    model: process.env.LLM_MODEL || "claude-sonnet-5",
    anthropicApiKey: process.env.ANTHROPIC_API_KEY || "",
    openaiApiKey: process.env.OPENAI_API_KEY || "",
    ollamaBaseUrl: process.env.OLLAMA_BASE_URL || "http://localhost:11434",
  },
  embeddings: {
    provider: (process.env.EMBEDDING_PROVIDER as EmbeddingProviderName) || "local",
    openaiApiKey: process.env.OPENAI_API_KEY || "",
    voyageApiKey: process.env.VOYAGE_API_KEY || "",
  },
  db: {
    path: process.env.AGENT_DB_PATH || "./data/agent.db",
  },
  agent: {
    maxIterations: int(process.env.AGENT_MAX_ITERATIONS, 5),
  },
  reflection: {
    everyNSteps: int(process.env.REFLECTION_EVERY_N_STEPS, 8),
  },
  context: {
    tokenBudget: int(process.env.CONTEXT_TOKEN_BUDGET, 4000),
  },
};
