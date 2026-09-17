import "dotenv/config";

export type LLMProviderName = "anthropic" | "openai" | "openrouter" | "ollama" | "infermatic" | "mock";
export type EmbeddingProviderName = "local" | "openai" | "voyage";
export type WebSearchProviderName = "brave" | "tavily" | "serper" | "duckduckgo" | "none";

function int(value: string | undefined, fallback: number): number {
  const n = Number(value);
  return Number.isFinite(n) && n > 0 ? n : fallback;
}

/** Retire les "/" finaux pour éviter les doubles slashs lors de la concaténation d'URLs. */
function stripTrailingSlash(url: string): string {
  return url.replace(/\/+$/, "");
}

export const config = {
  llm: {
    provider: (process.env.LLM_PROVIDER as LLMProviderName) || "infermatic",
    model: process.env.LLM_MODEL || "Qwen-Qwen3.6-35B-A3B",
    anthropicApiKey: process.env.ANTHROPIC_API_KEY || "",
    openaiApiKey: process.env.OPENAI_API_KEY || "",
    openrouterApiKey: process.env.OPENROUTER_API_KEY || "",
    ollamaBaseUrl: stripTrailingSlash(process.env.OLLAMA_BASE_URL || "http://localhost:11434"),
    infermaticApiKey: process.env.INFERMATIC_API_KEY || "",
    infermaticBaseUrl: stripTrailingSlash(process.env.INFERMATIC_BASE_URL || "https://api.totalgpt.ai/v1"),
    /**
     * Overrides de génération pilotés par settings.intelligence.* (Chantier 8).
     * `undefined` = pas d'override explicite (le provider applique son propre défaut).
     * maxOutputTokens par défaut 20000 — ne jamais réintroduire l'ancien plafond 4000.
     */
    temperature: 0.7 as number | undefined,
    topP: 1.0 as number | undefined,
    maxOutputTokens: 20000,
    contextWindowOverride: 128000,
    fallbackModel1: "",
    fallbackModel2: "",
    visionModel: "",
    codingModel: "",
    researchModel: "",
    utilityModel: "",
    /**
     * Routage dynamique vers modèles de raisonnement : un modèle "Rapide & Économique"
     * (ex: GPT-4o-mini, Claude Haiku) pour les tâches d'exécution de routine, et un modèle
     * de "Raisonnement Lourd" (ex: o1/o3, DeepSeek-R1, Claude Sonnet en mode thinking) pour
     * la planification et les boucles d'auto-réflexion/critique. `undefined`/vide = pas de
     * modèle dédié configuré -> retombe sur le modèle principal actif (jamais d'échec).
     */
    reasoningModel: process.env.LLM_REASONING_MODEL || "",
    fastModel: process.env.LLM_FAST_MODEL || "",
    /** Chantier 10 : candidat local distinct du provider nominal. V1 supporte Ollama. */
    localModelPriority: false,
    localProvider: ((process.env.LOCAL_LLM_PROVIDER as LLMProviderName) || "ollama") as LLMProviderName,
    localModel: process.env.LOCAL_LLM_MODEL || "",
    /** 0 = inconnu ; Ollama /api/show peut fournir la vraie fenêtre du modèle. */
    localContextWindow: int(process.env.LOCAL_LLM_CONTEXT_WINDOW, 0),
    localProbeTtlMs: int(process.env.LOCAL_LLM_PROBE_TTL_MS, 60_000),
  },
  embeddings: {
    provider: (process.env.EMBEDDING_PROVIDER as EmbeddingProviderName) || "local",
    openaiApiKey: process.env.OPENAI_API_KEY || "",
    voyageApiKey: process.env.VOYAGE_API_KEY || "",
  },
  webSearch: {
    provider: (process.env.WEB_SEARCH_PROVIDER as WebSearchProviderName) || "duckduckgo",
    braveApiKey: process.env.BRAVE_SEARCH_API_KEY || "",
    tavilyApiKey: process.env.TAVILY_API_KEY || "",
    serperApiKey: process.env.SERPER_API_KEY || "",
  },
  softwareFactory: {
    token: process.env.SOFTWARE_FACTORY_TOKEN || process.env.API_TOKEN || "",
    timeoutMs: int(process.env.SOFTWARE_FACTORY_TIMEOUT_MS, 120000),
    /**
     * Provider/modèle de la Software Factory : indépendants du provider/modèle actif
     * de Jarvis (config.llm.*), pour ne jamais être affectés par un changement fait
     * depuis le panneau "Modèles IA" ou la sélection persistée llm_active_model.
     */
    provider: (process.env.SOFTWARE_FACTORY_PROVIDER as LLMProviderName) || "infermatic",
    model: process.env.SOFTWARE_FACTORY_MODEL || "Qwen-Qwen3.6-35B-A3B",
    maxTokens: int(process.env.SOFTWARE_FACTORY_MAX_TOKENS, 7000),
  },
  codeExecution: {
    enabled: process.env.ENABLE_CODE_EXECUTION === "true",
    timeoutMs: int(process.env.CODE_EXECUTION_TIMEOUT_MS, 5000),
  },
  db: {
    path: process.env.AGENT_DB_PATH || "./data/agent.db",
  },
  workspace: {
    root: process.env.WORKSPACE_ROOT || "./data/workspaces",
    maxFileBytes: int(process.env.WORKSPACE_MAX_FILE_BYTES, 10 * 1024 * 1024),
    maxTotalBytes: int(process.env.WORKSPACE_MAX_TOTAL_BYTES, 50 * 1024 * 1024),
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
  callback: {
    /**
     * Secret HMAC-SHA256 pour l'authentification des callbacks asynchrones
     * entrants (n8n / workers -> JARVIS-00, PR-F). Jamais généré
     * automatiquement, jamais journalisé, jamais persisté, jamais renvoyé par
     * l'API. Absent -> CALLBACK_AUTH_NOT_CONFIGURED.
     */
    hmacSecret: process.env.JARVIS_CALLBACK_HMAC_SECRET || "",
  },
  agent: {
    maxIterations: int(process.env.AGENT_MAX_ITERATIONS, 5),
  },
  skills: {
    selectorMax: Math.min(Math.max(int(process.env.SKILL_SELECTOR_MAX, 8), 3), 12),
    studioProduct: false,
    studioCreative: false,
    officeCommercial: false,
    officeMarketing: false,
  },
  automations: {
    emailTriggers: false,
    crmTriggers: false,
    externalEventTriggers: false,
  },
  email: {
    /** Générique et provider-agnostic : tout endpoint acceptant POST {to,subject,text} avec un Bearer optionnel. */
    webhookUrl: process.env.EMAIL_WEBHOOK_URL || "",
    webhookToken: process.env.EMAIL_WEBHOOK_TOKEN || "",
    /** Destinataire des alertes activity.emailAlerts — jamais inventé si absent. */
    alertTo: process.env.ALERT_EMAIL_TO || "",
  },
  sms: {
    /** Chantier 10 : passerelle HTTP externe, jamais la permission Android SEND_SMS. */
    webhookUrl: process.env.SMS_WEBHOOK_URL || "",
    webhookToken: process.env.SMS_WEBHOOK_TOKEN || "",
    alertTo: process.env.ALERT_SMS_TO || "",
  },
  voice: {
    automaticVoiceReading: false,
    mode: "OFF" as "OFF" | "PUSH_TO_TALK" | "CONVERSATION" | "ALWAYS_LISTENING",
    responseMode: "AUTO" as "AUTO" | "FULL" | "SUMMARY",
    ingressTtlMs: int(process.env.VOICE_INGRESS_TTL_MS, 7 * 24 * 60 * 60 * 1000),
    summaryThresholdChars: int(process.env.VOICE_SUMMARY_THRESHOLD_CHARS, 400),
  },
  planning: { maxParallel: Math.min(int(process.env.PLAN_MAX_PARALLEL, 3), 8) },
  background: { maxConcurrent: Math.min(int(process.env.BACKGROUND_MAX_CONCURRENT, 3), 8) },
  reflection: {
    everyNSteps: int(process.env.REFLECTION_EVERY_N_STEPS, 8),
    /**
     * Auto-critique structurée (score 0-1 émis par le LLM de réflexion) : en-dessous de ce
     * seuil, l'évolution de prompt (promptEvolver) est déclenchée même en l'absence de
     * correction de self-healing détectée par pattern — la trajectoire récente est jugée
     * insatisfaisante par le modèle lui-même, pas seulement par une regex.
     */
    selfCritiqueMinScore: (() => {
      const n = Number(process.env.REFLECTION_SELF_CRITIQUE_MIN_SCORE);
      return Number.isFinite(n) && n >= 0 && n <= 1 ? n : 0.5;
    })(),
  },
  context: {
    tokenBudget: int(process.env.CONTEXT_TOKEN_BUDGET, 4000),
  },
  locale: {
    language: "fr" as "fr" | "en",
    responseLength: "NORMAL" as "SHORT" | "NORMAL" | "DETAILED",
  },
  autonomy: {
    /** Niveau de risque maximal exécuté sans approbation — "MEDIUM" reproduit le comportement historique (LOW/MEDIUM auto, HIGH/CRITICAL approuvés). */
    globalRiskLevel: "MEDIUM" as "LOW" | "MEDIUM" | "HIGH" | "CRITICAL",
    /** Permission maximale accordée sans intervention — "EXECUTE" couvre toutes les capacités existantes (READ/WRITE/DELETE/EXECUTE), SEND/PURCHASE/COMPUTER_CONTROL restent bloquées par défaut. */
    permissionMatrix: "EXECUTE" as "READ" | "WRITE" | "DELETE" | "EXECUTE" | "SEND" | "PURCHASE" | "COMPUTER_CONTROL",
  },
  connections: {
    autoTestOnStartup: true,
    healthTimeoutMs: int(process.env.CONNECTIONS_HEALTH_TIMEOUT_MS, 5000),
    requestTimeoutMs: int(process.env.CONNECTIONS_REQUEST_TIMEOUT_MS, 120000),
  },
  projects: {
    projectIsolation: false,
    knowledgeRag: false,
    autoIndexing: false,
    memoryRetentionDays: 30,
  },
  /**
   * Rétention du graphe de connaissances (GraphMemory) : contrairement à la mémoire
   * épisodique (projects.memoryRetentionDays), un triplet n'est jamais purgé par simple
   * ancienneté — seuls les triplets à la fois anciens (non renforcés depuis
   * graphRetentionDays) ET peu fiables (confidence < graphRetentionMaxConfidence) sont
   * balayés. Désactivé par défaut (0 = no-op) pour ne changer aucun comportement existant.
   */
  memory: {
    graphRetentionDays: int(process.env.MEMORY_GRAPH_RETENTION_DAYS, 0),
    graphRetentionMaxConfidence: (() => {
      const n = Number(process.env.MEMORY_GRAPH_RETENTION_MAX_CONFIDENCE);
      return Number.isFinite(n) && n >= 0 && n <= 1 ? n : 0.4;
    })(),
  },
  activity: {
    logLevel: "NORMAL" as "NORMAL" | "DETAILED" | "DEBUG",
    emailAlerts: false,
    /** V1 : notification Android locale acheminée au runtime natif actif, pas un push distant FCM. */
    androidPush: false,
    smsAlerts: false,
    voiceAlerts: false,
  },
  /** Brique multi-agents : équipes de profils spécialisés collaborant sur un même objectif. */
  agentTeams: {
    enabled: process.env.AGENT_TEAMS_ENABLED !== "false",
    configPath: process.env.AGENT_PROFILES_PATH || "./config/agent-profiles.json",
    maxRounds: int(process.env.AGENT_TEAM_MAX_ROUNDS, 4),
  },
  /** Brique MCP (Model Context Protocol) : découverte et exécution dynamique d'outils distants. */
  mcp: {
    enabled: process.env.MCP_ENABLED === "true",
    configPath: process.env.MCP_SERVERS_PATH || "./config/mcp-servers.json",
    connectTimeoutMs: int(process.env.MCP_CONNECT_TIMEOUT_MS, 10_000),
    requestTimeoutMs: int(process.env.MCP_REQUEST_TIMEOUT_MS, 60_000),
  },
  /** Brique auto-réflexion / guardrail : validation critique du résultat par rapport à l'objectif, avec relance automatique. */
  guardrail: {
    enabled: process.env.GUARDRAIL_ENABLED === "true",
    maxRetries: int(process.env.GUARDRAIL_MAX_RETRIES, 1),
  },
  /** Vague 6D : cache sémantique local des complétions LLM. */
  semanticCache: {
    similarityThreshold: (() => { const n = Number(process.env.SEMANTIC_CACHE_SIMILARITY_THRESHOLD); return Number.isFinite(n) && n > 0 && n <= 1 ? n : 0.95; })(),
    ttlMs: int(process.env.SEMANTIC_CACHE_TTL_MS, 24 * 60 * 60 * 1000),
  },
  /** Vague 7D : battement de coeur anti-veille (hébergements éphémères) + hydratation au redémarrage. */
  heartbeat: {
    intervalMs: int(process.env.HEARTBEAT_INTERVAL_MS, 4 * 60 * 1000),
    selfUrl: process.env.HEARTBEAT_SELF_URL || "",
  },
  /** Vague 7B : intervalle de scrutin résiduel pour détecter l'ABSENCE d'activité (7A) — les routines elles-mêmes restent déclenchées par événement. */
  autonomyPlanner: {
    idleCheckIntervalMs: int(process.env.AUTONOMY_IDLE_CHECK_INTERVAL_MS, 60_000),
  },
  /**
   * Tracing/observabilité Langfuse (optionnel, best-effort) : chaque span du Tracer local
   * (src/observability/tracer.ts) est aussi exporté vers Langfuse quand ces clés sont
   * renseignées. Absent -> aucun appel réseau n'est jamais effectué (comportement historique
   * inchangé, le Tracer local reste la seule source de vérité).
   */
  langfuse: {
    enabled: process.env.LANGFUSE_ENABLED === "true" && !!process.env.LANGFUSE_PUBLIC_KEY && !!process.env.LANGFUSE_SECRET_KEY,
    publicKey: process.env.LANGFUSE_PUBLIC_KEY || "",
    secretKey: process.env.LANGFUSE_SECRET_KEY || "",
    baseUrl: stripTrailingSlash(process.env.LANGFUSE_BASE_URL || "https://cloud.langfuse.com"),
    flushIntervalMs: int(process.env.LANGFUSE_FLUSH_INTERVAL_MS, 3000),
    maxBatchSize: int(process.env.LANGFUSE_MAX_BATCH_SIZE, 20),
  },
  /**
   * Sandboxing sécurisé (Software Factory / execute_code) : par défaut, toute exécution de
   * code/commande générée passe par un conteneur Docker éphémère et isolé (aucun accès réseau,
   * aucun montage du système hôte, jamais le .env principal). Si E2B_API_KEY est fourni, la
   * sandbox managée E2B est utilisée à la place (aucune installation Docker requise). Si ni
   * Docker ni E2B ne sont disponibles, on retombe sur l'isolation légère historique
   * (src/execution/sandbox.ts::runJavaScript), jamais bloquant pour l'agent.
   */
  execution: {
    e2bApiKey: process.env.E2B_API_KEY || "",
    e2bTimeoutMs: int(process.env.E2B_TIMEOUT_MS, 30_000),
    dockerEnabled: process.env.SANDBOX_DOCKER_ENABLED !== "false",
    dockerImage: process.env.SANDBOX_DOCKER_IMAGE || "node:22-slim",
    dockerMemoryMb: int(process.env.SANDBOX_DOCKER_MEMORY_MB, 256),
    dockerNanoCpus: int(process.env.SANDBOX_DOCKER_NANO_CPUS, 1_000_000_000),
    dockerNetworkEnabled: process.env.SANDBOX_DOCKER_NETWORK_ENABLED === "true",
  },
  /**
   * Software Factory : validation optionnelle en sandbox isolée avant commit (désactivée par
   * défaut, aucun changement de comportement). build/test/lint/typecheck (tâche 5 sous-priorité
   * 3) sont des vérifications NOMMÉES distinctes de validationCommand — même mécanisme
   * (runCommandInSandbox, uniquement le fichier patché monté, jamais le dépôt hôte), chacune
   * indépendamment configurable et désactivée par défaut.
   *
   * IMPORTANT (scope, review Codex #114) : la commande configurée doit être un contrôle
   * AUTONOME sur le fichier seul (ex. "node --check %FILE%", "tsc --noEmit %FILE%", un lint
   * sans config projet) — jamais un script de projet complet ("npm run build", "npm test"),
   * qui échouerait systématiquement (pas de package.json/node_modules/reste du dépôt dans le
   * sandbox : par conception, jamais le dépôt hôte ni un accès réseau).
   */
  softwareFactorySandbox: {
    validationCommand: process.env.SOFTWARE_FACTORY_SANDBOX_VALIDATION_COMMAND || "",
    buildCommand: process.env.SOFTWARE_FACTORY_SANDBOX_BUILD_COMMAND || "",
    testCommand: process.env.SOFTWARE_FACTORY_SANDBOX_TEST_COMMAND || "",
    lintCommand: process.env.SOFTWARE_FACTORY_SANDBOX_LINT_COMMAND || "",
    typecheckCommand: process.env.SOFTWARE_FACTORY_SANDBOX_TYPECHECK_COMMAND || "",
    timeoutMs: int(process.env.SOFTWARE_FACTORY_SANDBOX_TIMEOUT_MS, 60_000),
  },
  /**
   * Vague 8A : disjoncteur financier évolué — gèle l'agent (aucun nouvel appel LLM) dès que
   * le coût estimé glissant dépasse le seuil horaire configuré. Actif par défaut (seuil de
   * sécurité), désactivable explicitement pour le développement local.
   */
  financialCircuitBreaker: {
    enabled: process.env.FINANCIAL_CIRCUIT_BREAKER_ENABLED !== "false",
    hourlyLimitUsd: (() => {
      const n = Number(process.env.FINANCIAL_CIRCUIT_BREAKER_HOURLY_LIMIT_USD);
      return Number.isFinite(n) && n > 0 ? n : 2.0;
    })(),
    windowMs: int(process.env.FINANCIAL_CIRCUIT_BREAKER_WINDOW_MS, 60 * 60 * 1000),
  },
  /** Vague 8B : vision multi-modale — modèle de repli explicitement dédié à l'analyse d'image, distinct du modèle de chat actif. */
  vision: {
    enabled: process.env.VISION_ENABLED !== "false",
    model: process.env.VISION_MODEL || "",
    screenshotTimeoutMs: int(process.env.VISION_SCREENSHOT_TIMEOUT_MS, 20_000),
  },
  /** Vague 8C : apprentissage par renforcement local — extraction de "règles d'or" après une correction de self-healing, injectées au démarrage de chaque session suivante. */
  promptEvolution: {
    enabled: process.env.PROMPT_EVOLUTION_ENABLED === "true",
    rulesPath: process.env.DYNAMIC_RULES_PATH || "./config/dynamic_rules.json",
    maxRules: int(process.env.PROMPT_EVOLUTION_MAX_RULES, 200),
  },
  /** Vague 9 : streaming audio bidirectionnel (WebSocket) + VAD + STT/TTS faible latence. */
  audio: {
    enabled: process.env.AUDIO_STREAMING_ENABLED === "true",
    wsPath: process.env.AUDIO_STREAMING_WS_PATH || "/api/voice/stream",
    /** Fenêtre de tolérance de reconnexion (coupure 4G/5G) avant expiration définitive de la session audio. */
    sessionGraceMs: int(process.env.AUDIO_SESSION_GRACE_MS, 30_000),
    /** VAD énergie : silence prolongé (ms) au-delà duquel on considère la parole terminée. */
    vadSilenceMs: int(process.env.AUDIO_VAD_SILENCE_MS, 500),
    vadEnergyThreshold: (() => {
      const n = Number(process.env.AUDIO_VAD_ENERGY_THRESHOLD);
      return Number.isFinite(n) && n > 0 ? n : 500;
    })(),
    sttWebhookUrl: process.env.STT_WEBHOOK_URL || "",
    sttWebhookToken: process.env.STT_WEBHOOK_TOKEN || "",
    ttsWebhookUrl: process.env.TTS_WEBHOOK_URL || "",
    ttsWebhookToken: process.env.TTS_WEBHOOK_TOKEN || "",
  },
  /** Vague 9D : intents Android poussés en arrière-plan (FCM ou WebSocket persistant). */
  android: {
    fcmWebhookUrl: process.env.ANDROID_FCM_WEBHOOK_URL || "",
    fcmWebhookToken: process.env.ANDROID_FCM_WEBHOOK_TOKEN || "",
  },
  /**
   * Vague 12A : génération d'images (ComfyUI local ou provider cloud FLUX). "comfyui" cible
   * une instance ComfyUI locale/distante déjà démarrée (aucun lancement automatique du
   * process) ; "together" appelle l'API Together AI (modèle FLUX.1-dev par défaut).
   */
  image: {
    provider: (process.env.IMAGE_PROVIDER as "comfyui" | "together") || "comfyui",
    defaultWidth: int(process.env.IMAGE_DEFAULT_WIDTH, 1024),
    defaultHeight: int(process.env.IMAGE_DEFAULT_HEIGHT, 1024),
    defaultSteps: int(process.env.IMAGE_DEFAULT_STEPS, 20),
    timeoutMs: int(process.env.IMAGE_GENERATION_TIMEOUT_MS, 120_000),
    comfyUi: {
      baseUrl: stripTrailingSlash(process.env.COMFYUI_BASE_URL || "http://127.0.0.1:8188"),
      workflowTemplatePath: process.env.COMFYUI_WORKFLOW_TEMPLATE_PATH || "./config/comfyui-workflow-template.json",
      checkpoint: process.env.COMFYUI_CHECKPOINT || "flux1-dev-fp8.safetensors",
    },
    together: {
      apiKey: process.env.TOGETHER_API_KEY || "",
      baseUrl: stripTrailingSlash(process.env.TOGETHER_BASE_URL || "https://api.together.xyz"),
      model: process.env.TOGETHER_IMAGE_MODEL || "black-forest-labs/FLUX.1-dev",
    },
  },
};
