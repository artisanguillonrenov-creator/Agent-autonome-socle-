import { createLLMProvider, resolveLLMSelection } from "./llm/providers/index.js";
import { createEmbeddingProvider } from "./llm/embeddingFactory.js";
import { QueuedAgent } from "./core/queuedAgent.js";
import { builtinSkills } from "./skills/builtin/index.js";
import { runCli } from "./interfaces/cli.js";
import { startHttpApi } from "./interfaces/httpApi.js";
import { config } from "./config.js";
import { BackgroundRunner } from "./autonomy/backgroundRunner.js";
import { Scheduler } from "./autonomy/scheduler.js";
import { applyAllEffectiveRuntimeSettings } from "./settings/applier.js";
import { runStartupHealthChecks } from "./connections/startupHealthCheck.js";
import { MemoryRetentionScheduler } from "./memory/retentionSweeper.js";
import { registerChantier10Settings } from "./settings/chantier10Catalog.js";
import { VoiceIngressStore } from "./voice/voiceIngressStore.js";
import { AlertRouter } from "./voice/alertRouter.js";
import { installVoiceHttpIngress } from "./voice/httpVoiceIngress.js";
import { NotificationStore } from "./autonomy/notificationStore.js";

async function main(): Promise<void> {
  // Chantier 10 definitions must exist before SettingsStore applies persisted values.
  registerChantier10Settings();

  // Au démarrage, on fige la sélection active (options explicites > persistance > défaut)
  // dans config.llm — createLLMProvider lui-même reste pur (voir src/llm/providers/index.ts).
  const selection = resolveLLMSelection();
  config.llm.provider = selection.provider;
  config.llm.model = selection.model;
  // sanitizeReasoning: true — flux chat Jarvis destiné à un utilisateur humain, le
  // raisonnement interne (<think>) d'un modèle "reasoning" ne doit jamais y être visible.
  const llm = createLLMProvider({ ...selection, sanitizeReasoning: true });
  const embeddings = createEmbeddingProvider();
  // Toujours UNE SEULE instance de Jarvis : QueuedAgent ne change pas son intelligence,
  // il sérialise seulement les entrées interactives autour de Agent.step().
  const agent = new QueuedAgent({ llm, embeddings });

  for (const skill of builtinSkills) {
    agent.skills.register(skill);
  }

  // Applique les réglages persistés au runtime AVANT tout autre démarrage — chemin unique
  // (voir applier.ts), qu'on tourne en HTTP, en CLI ou les deux à la fois, pour que les réglages
  // restent réellement effectifs après un redémarrage quel que soit le mode d'interface.
  applyAllEffectiveRuntimeSettings(agent);

  const alertRouter = new AlertRouter();
  const unsubscribeAlerts = NotificationStore.subscribe((notification) => alertRouter.handle(notification));
  const voiceIngressStore = new VoiceIngressStore();
  // Un RUNNING provenant d'un processus précédent est ambigu : aucune ré-exécution automatique.
  voiceIngressStore.markRunningAsRecoveryRequired();

  // connections.autoTestOnStartup : health check réel de tous les services activés.
  if (config.connections.autoTestOnStartup) {
    runStartupHealthChecks(agent.serviceOrchestrator).catch((err) => {
      console.error("[Startup] Health check échoué:", err);
    });
  }

  // projects.memoryRetentionDays : purge périodique des souvenirs episodic expirés.
  const retentionScheduler = new MemoryRetentionScheduler(() => config.projects.memoryRetentionDays);
  retentionScheduler.start();

  const modes = new Set(config.interface.modes);

  if (modes.has("http")) {
    const backgroundRunner=new BackgroundRunner(agent.serviceOrchestrator);
    const scheduler=new Scheduler(agent.serviceOrchestrator);
    backgroundRunner.start(); scheduler.start(); agent.planRunner.start();
    const server=startHttpApi(agent, config.api.port);
    const voiceRuntime=installVoiceHttpIngress(server, agent, voiceIngressStore, alertRouter);
    const shutdown=()=>{backgroundRunner.stop();scheduler.stop();agent.planRunner.stop();retentionScheduler.stop();voiceRuntime.dispose();unsubscribeAlerts();server.close();};
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
