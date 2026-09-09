import { createLLMProvider } from "./llm/providers/index.js";
import { createEmbeddingProvider } from "./llm/embeddingFactory.js";
import { Agent } from "./core/agent.js";
import { builtinSkills } from "./skills/builtin/index.js";
import { runCli } from "./interfaces/cli.js";
import { startHttpApi } from "./interfaces/httpApi.js";
import { config } from "./config.js";
import { BackgroundRunner } from "./autonomy/backgroundRunner.js";
import { Scheduler } from "./autonomy/scheduler.js";

async function main(): Promise<void> {
  const llm = createLLMProvider();
  const embeddings = createEmbeddingProvider();
  const agent = new Agent({ llm, embeddings });

  for (const skill of builtinSkills) {
    agent.skills.register(skill);
  }

  const modes = new Set(config.interface.modes);

  if (modes.has("http")) {
    const backgroundRunner=new BackgroundRunner(agent.serviceOrchestrator);
    const scheduler=new Scheduler(agent.serviceOrchestrator);
    backgroundRunner.start(); scheduler.start(); agent.planRunner.start();
    const server=startHttpApi(agent, config.api.port);
    const shutdown=()=>{backgroundRunner.stop();scheduler.stop();agent.planRunner.stop();server.close();};
    process.once("SIGTERM",shutdown);process.once("SIGINT",shutdown);
  }

  if (modes.has("cli") || modes.size === 0) {
    await runCli(agent);
  }
}

main().catch((err) => {
  console.error(err);
  process.exitCode = 1;
});
