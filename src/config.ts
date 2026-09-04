import "dotenv/config";

export type LLMProviderName = "anthropic" | "openai" | "openrouter" | "ollama" | "mock";
export type EmbeddingProviderName = "local" | "openai" | "voyage";
export type WebSearchProviderName = "brave" | "duckduckgo" | "none";

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
    openrouterApiKey: process.env.OPENROUTER_API_KEY || "",
    ollamaBaseUrl: process.env.OLLAMA_BASE_URL || "http://localhost:11434",
  },
  embeddings: {
    provider: (process.env.EMBEDDING_PROVIDER as EmbeddingProviderName) || "local",
    openaiApiKey: process.env.OPENAI_API_KEY || "",
    voyageApiKey: process.env.VOYAGE_API_KEY || "",
  },
  webSearch: {
    provider: (process.env.WEB_SEARCH_PROVIDER as WebSearchProviderName) || "none",
    braveApiKey: process.env.BRAVE_SEARCH_API_KEY || "",
  },
  codeExecution: {
    enabled: process.env.ENABLE_CODE_EXECUTION === "true",
    timeoutMs: int(process.env.CODE_EXECUTION_TIMEOUT_MS, 5000),
  },
  db: {
    path: process.env.AGENT_DB_PATH || "./data/agent.db",
  },
  interface: {
    /** Liste séparée par des virgules : "cli", "http", ou les deux à la fois. */
    modes: (process.env.AGENT_INTERFACE || "cli")
      .split(",")
      .map((m) => m.trim())
      .filter(Boolean),
  },
  api: {
    // La plupart des hébergeurs (Render, Railway...) imposent leur port via PORT.
    port: int(process.env.PORT || process.env.API_PORT, 3000),
    /** Si vide, l'API n'est pas protégée — à ne jamais exposer publiquement dans ce cas. */
    token: process.env.API_TOKEN || "",
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
