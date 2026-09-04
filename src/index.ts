import { createLLMProvider } from "./llm/providers/index.js";
import { createEmbeddingProvider } from "./llm/embeddingFactory.js";
import { Agent } from "./core/agent.js";
import { builtinSkills } from "./skills/builtin/index.js";
import { runCli } from "./interfaces/cli.js";

async function main(): Promise<void> {
  const llm = createLLMProvider();
  const embeddings = createEmbeddingProvider();
  const agent = new Agent({ llm, embeddings });

  for (const skill of builtinSkills) {
    agent.skills.register(skill);
  }

  await runCli(agent);
}

main().catch((err) => {
  console.error(err);
  process.exitCode = 1;
});
