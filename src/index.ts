import { createLLMProvider, resolveLLMSelection } from "./llm/providers/index.js";
import { createEmbeddingProvider } from "./llm/embeddingFactory.js";
import { QueuedAgent } from "./core/queuedAgent.js";
import { runCli } from "./interfaces/cli.js";
import { startHttpApi, assertApiTokenConfiguredForHttp } from "./interfaces/httpApi.js";
import { installConversationHttpIngress } from "./interfaces/conversationHttpIngress.js";
import { installConversationWebUiIngress } from "./interfaces/conversationWebUiIngress.js";
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
import { createPersonalityRepository } from "./personality/personalityRepositoryFactory.js";
import { PersonalityPolicyEngine } from "./personality/personalityPolicyEngine.js";
import { AgentTeamStore } from "./agents/agentTeamStore.js";
import { AutonomyPlanner } from "./autonomy/planner.js";
import { Heartbeat } from "./autonomy/heartbeat.js";
import { AudioStreamManager } from "./voice/audioStreamManager.js";
import { startAutonomyWatchers } from "./autonomy/watchers.js";
import { WsLogsChannel } from "./interfaces/wsLogsChannel.js";
import { WsUpgradeRouter } from "./interfaces/wsRouter.js";

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

  // Vague 7D : hydratation automatique depuis le dernier battement de coeur persisté — un
  // écart important entre `staleForMs` et l'intervalle de battement attendu signale une
  // coupure prolongée (ex: mise en veille d'un hébergement éphémère). La reprise effective
  // des opérations en vol reste assurée par BackgroundRunner.recover() plus bas ; ceci ne
  // fait que le journaliser explicitement.
  const heartbeatHydration = await Heartbeat.hydrate().catch((error) => {
    console.warn("[Heartbeat] Hydration check failed:", (error as Error).message);
    return { recovered: false } as const;
  });
  if (heartbeatHydration.recovered) {
    console.warn(`[Heartbeat] Resuming after ${Math.round((heartbeatHydration.staleForMs ?? 0) / 1000)}s since last beat (in-flight: ${heartbeatHydration.snapshot?.inFlightOperationTaskIds.length ?? 0} operation(s), ${heartbeatHydration.snapshot?.activePlanRunIds.length ?? 0} plan run(s)).`);
  }

  // Personality V1 state is separate from the transcript and must exist before traffic.
  const personalityRepository = createPersonalityRepository();
  await personalityRepository.initialize();
  const personalityPolicyEngine = new PersonalityPolicyEngine(personalityRepository);

  const agent = new QueuedAgent({ llm, embeddings, conversationRepository });
  // Vague 6C : un seul Agent vit pour toute la durée du process — l'abonnement au bus
  // d'autonomie est donc pris une fois ici, jamais dans le constructeur (voir
  // Agent.listenForAutonomyEvents pour la justification).
  agent.listenForAutonomyEvents();
  const conversationCoordinator = new ConversationCoordinator();
  const conversationService = new ConversationExecutionService(
    conversationRepository,
    conversationCoordinator,
    agent,
    personalityPolicyEngine,
  );

  // Le constructeur d'Agent enregistre déjà l'intégralité de builtinSkills (fusionnée avec
  // les skills runtime issues de createRuntimeSkills) — les réenregistrer ici écraserait cette
  // fusion et l'état de disponibilité déjà calculé par service.
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

  // Brique MCP : connexion best-effort aux serveurs externes déclarés. Ne bloque
  // jamais le démarrage — un serveur MCP indisponible reste simplement absent
  // des compétences disponibles (voir agent.getMcpStatuses()).
  agent.connectMcpServers().catch((err) => {
    console.error("[MCP] Connexion aux serveurs MCP échouée:", err);
  });

  // Brique durabilité (multi-agents) : reprend les collaborations d'équipe
  // interrompues par un crash serveur, une coupure réseau ou une erreur LLM.
  if (config.agentTeams.enabled) {
    const agentTeamStore = new AgentTeamStore();
    for (const run of agentTeamStore.incomplete()) {
      agent.multiAgent.resume(run.id).catch((err) => {
        console.warn(`[AgentTeam] Reprise de la session ${run.id} échouée:`, (err as Error).message);
      });
    }
  }

  const retentionScheduler = new MemoryRetentionScheduler(() => config.projects.memoryRetentionDays);
  retentionScheduler.start();
  const modes = new Set(config.interface.modes);

  if (modes.has("http")) {
    assertApiTokenConfiguredForHttp(modes);
    const backgroundRunner = new BackgroundRunner(agent.serviceOrchestrator);
    const scheduler = new Scheduler(agent.serviceOrchestrator);
    const autonomyPlanner = new AutonomyPlanner(agent);
    const heartbeat = new Heartbeat(agent.planner);
    backgroundRunner.start();
    scheduler.start();
    agent.planRunner.start();
    autonomyPlanner.start();
    heartbeat.start();

    const server = startHttpApi(agent, config.api.port);
    // Preserve Chantier-10 alerts/legacy polling, then wrap command/chat routes with 11A.
    const voiceRuntime = installVoiceHttpIngress(server, agent, voiceIngressStore, alertRouter);
    const conversationRuntime = installConversationHttpIngress(server, conversationService);
    const webConversationRuntime = installConversationWebUiIngress(server);

    // Vague 9A/9B/9C : streaming audio bidirectionnel (WebSocket), désactivé par défaut
    // (AUDIO_STREAMING_ENABLED=true requis) — n'affecte jamais le chat texte existant.
    // Vague 13A : un seul routeur d'upgrade WebSocket partagé entre tous les canaux
    // (/ws/audio, chemin audio legacy, /ws/logs) — voir wsRouter.ts pour la raison pour
    // laquelle plusieurs WebSocketServer indépendants sur le même http.Server ne peuvent pas
    // coexister via `{ server, path }`.
    const wsRouter = new WsUpgradeRouter();
    wsRouter.attach(server);

    const audioStreamManager = config.audio.enabled ? new AudioStreamManager(agent) : undefined;
    audioStreamManager?.attach(wsRouter);

    // Vague 13A : canal WebSocket /ws/logs (dashboard) — toujours actif dès que l'interface
    // HTTP l'est, indépendamment du streaming audio (AUDIO_STREAMING_ENABLED).
    const wsLogsChannel = new WsLogsChannel(agent);
    wsLogsChannel.attach(wsRouter);

    // Vague 11A : observateurs d'état (fichiers du Document Workbench, cycle de vie des
    // conteneurs sandbox) — best-effort, ne bloque jamais le démarrage.
    const autonomyWatchers = startAutonomyWatchers();

    const shutdown = () => {
      backgroundRunner.stop();
      scheduler.stop();
      agent.planRunner.stop();
      autonomyPlanner.stop();
      heartbeat.stop();
      retentionScheduler.stop();
      autonomyWatchers.dispose();
      audioStreamManager?.dispose();
      wsLogsChannel.dispose();
      wsRouter.dispose();
      webConversationRuntime.dispose();
      conversationRuntime.dispose();
      voiceRuntime.dispose();
      unsubscribeAlerts();
      agent.disposeInterrupts();
      agent.closeMcpServers().catch(() => undefined);
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
