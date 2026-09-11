import { createLLMProvider, resolveLLMSelection } from "./llm/providers/index.js";
import { createEmbeddingProvider } from "./llm/embeddingFactory.js";
import { QueuedAgent } from "./core/queuedAgent.js";
import { builtinSkills } from "./skills/builtin/index.js";
import { runCli } from "./interfaces/cli.js";
import { startHttpApi } from "./interfaces/httpApi.js";
import { installConversationHttpIngress } from "./interfaces/conversationHttpIngress.js";
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
import { createConversationRepository } from "./persistence/conversations/conversationRepositoryFactory.js";
import { ConversationCoordinator } from "./persistence/conversations/conversationCoordinator.js";
import { ConversationExecutionService } from "./persistence/conversations/conversationExecutionService.js";

async function main(): Promise<void> {
  registerChantier10Settings();

  const selection = resolveLLMSelection();
  config.llm.provider = selection.provider;
  config.llm.model = selection.model;
  const llm = createLLMProvider({ ...selection, sanitizeReasoning: true });
  const embeddings = createEmbeddingProvider();

  // Chantier 11A: the durable repository must be fully initialized and recovered
  // before HTTP, voice or CLI traffic can reach Jarvis.
  const conversationRepository = createConversationRepository();
  await conversationRepository.initialize();
  const recoveredTurns = await conversationRepository.recoverInterruptedTurns();
  if (recoveredTurns > 0) console.warn(`[Conversation] ${recoveredTurns} interrupted turn(s) marked FAILED after restart.`);

  const agent = new QueuedAgent({ llm, embeddings, conversationRepository });
  const conversationCoordinator = new ConversationCoordinator();
  const conversationService = new ConversationExecutionService(conversationRepository, conversationCoordinator, agent);

  for (const skill of builtinSkills) agent.skills.register(skill);
  applyAllEffectiveRuntimeSettings(agent);

  const alertRouter = new AlertRouter();
  const unsubscribeAlerts = NotificationStore.subscribe((notification) => alertRouter.handle(notification));
  const voiceIngressStore = new VoiceIngressStore();
  // Legacy Chantier-10 rows only. New voice commands are canonicalized in conversation_turns.
  voiceIngressStore.markRunningAsRecoveryRequired();

  if (config.connections.autoTestOnStartup) {
    runStartupHealthChecks(agent.serviceOrchestrator).catch((err) => {
      console.error("[Startup] Health check échoué:", err);
    });
  }

  const retentionScheduler = new MemoryRetentionScheduler(() => config.projects.memoryRetentionDays);
  retentionScheduler.start();
  const modes = new Set(config.interface.modes);

  if (modes.has("http")) {
    const backgroundRunner = new BackgroundRunner(agent.serviceOrchestrator);
    const scheduler = new Scheduler(agent.serviceOrchestrator);
    backgroundRunner.start();
    scheduler.start();
    agent.planRunner.start();

    const server = startHttpApi(agent, config.api.port);
    // Preserve Chantier-10 alerts/legacy polling, then wrap command/chat routes with 11A.
    const voiceRuntime = installVoiceHttpIngress(server, agent, voiceIngressStore, alertRouter);
    const conversationRuntime = installConversationHttpIngress(server, conversationService);

    const shutdown = () => {
      backgroundRunner.stop();
      scheduler.stop();
      agent.planRunner.stop();
      retentionScheduler.stop();
      conversationRuntime.dispose();
      voiceRuntime.dispose();
      unsubscribeAlerts();
      server.close();
    };
    process.once("SIGTERM", shutdown);
    process.once("SIGINT", shutdown);
  }

  if (modes.has("cli") || modes.size === 0) {
    await runCli(agent, conversationService);
  }
}

main().catch((err) => {
  console.error(err);
  process.exitCode = 1;
});
