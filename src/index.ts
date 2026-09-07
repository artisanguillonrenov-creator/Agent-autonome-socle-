// Version V2 non censurée avec recherche internet Tavily et Software Factory V1 active.
import { createLLMProvider } from "./llm/providers/index.js";
import { createEmbeddingProvider } from "./llm/embeddingFactory.js";
import { Agent } from "./core/agent.js";
import { builtinSkills } from "./skills/builtin/index.js";
import { runCli } from "./interfaces/cli.js";
import { startHttpApi } from "./interfaces/httpApi.js";
import { config } from "./config.js";

async function main(): Promise<void> {
  const llm = createLLMProvider();
  const embeddings = createEmbeddingProvider();
  const agent = new Agent({ llm, embeddings });

  for (const skill of builtinSkills) {
    agent.skills.register(skill);
  }

  const modes = new Set(config.interface.modes);

  if (modes.has("http")) {
    startHttpApi(agent, config.api.port);
  }

  if (modes.has("cli") || modes.size === 0) {
    await runCli(agent);
  }
}

main().catch((err) => {
  console.error(err);
  process.exitCode = 1;
});