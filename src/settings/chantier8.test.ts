import test from "node:test";
import assert from "node:assert/strict";
import { closeDb, getDb } from "../persistence/db.js";
import { config } from "../config.js";
import { SETTINGS_CATALOG } from "./catalog.js";
import { SettingsStore } from "./store.js";
import { LocalHashingEmbeddingProvider } from "../llm/embeddings.js";
import type { ChatMessage } from "../types.js";
import type { CompletionOptions, LLMProvider } from "../llm/provider.js";
import { ServiceRegistry } from "../orchestration/serviceRegistry.js";
import { ServiceOrchestrator } from "../orchestration/serviceOrchestrator.js";
import type { ServiceAdapter } from "../orchestration/serviceAdapter.js";
import type { ServiceEvent, TaskRequest } from "../orchestration/contract.js";
import { resolveModelForRole, providerForRole } from "../llm/modelRouter.js";
import { completeWithFallback } from "../llm/fallbackChain.js";
import { resolveEffectiveInputBudget } from "../llm/contextWindow.js";
import { sweepExpiredEpisodicMemory } from "../memory/retentionSweeper.js";
import { runStartupHealthChecks } from "../connections/startupHealthCheck.js";
import { ActivityStore } from "../observability/activityStore.js";
import { VectorMemory } from "../memory/vectorMemory.js";
import { indexWorkspaceDocument, removeWorkspaceDocumentIndex, searchWorkspaceKnowledge } from "../workbench/knowledgeIndex.js";

function setupTestDb() {
  config.db.path = ":memory:";
  closeDb();
  getDb();
}

// ---------------------------------------------------------------------------
// Catalogue : les 23 réglages Chantier 8 sont AVAILABLE et éditables, sauf
// intelligence.visionModel (aucun pipeline multimodal n'existe encore).
// ---------------------------------------------------------------------------
const CHANTIER_8_KEYS = [
  "settings.language",
  "settings.responseLength",
  "intelligence.temperature",
  "intelligence.topP",
  "intelligence.maxOutputTokens",
  "intelligence.contextWindowOverride",
  "intelligence.fallbackModel1",
  "intelligence.fallbackModel2",
  "intelligence.codingModel",
  "intelligence.researchModel",
  "intelligence.utilityModel",
  "intelligence.toolCompatibilityTest",
  "autonomy.globalRiskLevel",
  "autonomy.permissionMatrix",
  "connections.autoTestOnStartup",
  "connections.healthTimeoutMs",
  "connections.requestTimeoutMs",
  "projects.projectIsolation",
  "projects.knowledgeRag",
  "projects.autoIndexing",
  "projects.memoryRetentionDays",
  "activity.logLevel",
];

test("CHANTIER 8: les 22 réglages raccordés sont AVAILABLE et éditables ; visionModel reste FUTURE", () => {
  for (const key of CHANTIER_8_KEYS) {
    const def = SETTINGS_CATALOG.find((s) => s.key === key);
    assert.ok(def, `${key} doit exister au catalogue`);
    assert.equal(def!.availability, "AVAILABLE", `${key} doit être AVAILABLE`);
    assert.equal(def!.editable, true, `${key} doit être éditable`);
  }
  const vision = SETTINGS_CATALOG.find((s) => s.key === "intelligence.visionModel")!;
  assert.equal(vision.availability, "FUTURE");
  assert.equal(vision.plannedChantier, 8);

  const autoMergePr = SETTINGS_CATALOG.find((s) => s.key === "autonomy.autoMergePr")!;
  assert.equal(autoMergePr.availability, "SYSTEM_LOCKED");
  assert.equal(autoMergePr.editable, false);
});

test("CHANTIER 8: validation des bornes/enums rejette les valeurs hors plage", () => {
  setupTestDb();
  const store = new SettingsStore();
  assert.throws(() => store.setSetting("intelligence.temperature", 5, "GLOBAL", "global"), /SETTING_OUT_OF_RANGE/);
  assert.throws(() => store.setSetting("intelligence.topP", -0.1, "GLOBAL", "global"), /SETTING_OUT_OF_RANGE/);
  assert.throws(() => store.setSetting("intelligence.maxOutputTokens", 100, "GLOBAL", "global"), /SETTING_OUT_OF_RANGE/);
  assert.throws(() => store.setSetting("intelligence.maxOutputTokens", 999999, "GLOBAL", "global"), /SETTING_OUT_OF_RANGE/);
  assert.throws(() => store.setSetting("settings.language", "de", "GLOBAL", "global"), /INVALID_SETTING_ENUM/);
  assert.throws(() => store.setSetting("autonomy.globalRiskLevel", "NUCLEAR", "GLOBAL", "global"), /INVALID_SETTING_ENUM/);
  assert.throws(() => store.setSetting("autonomy.permissionMatrix", "ADMIN", "GLOBAL", "global"), /INVALID_SETTING_ENUM/);
  assert.throws(() => store.setSetting("activity.logLevel", "TRACE", "GLOBAL", "global"), /INVALID_SETTING_ENUM/);
  assert.throws(() => store.setSetting("projects.memoryRetentionDays", 0, "GLOBAL", "global"), /SETTING_OUT_OF_RANGE/);
  assert.throws(() => store.setSetting("projects.memoryRetentionDays", 400, "GLOBAL", "global"), /SETTING_OUT_OF_RANGE/);
  assert.throws(() => store.setSetting("connections.healthTimeoutMs", 100, "GLOBAL", "global"), /SETTING_OUT_OF_RANGE/);

  // Valeurs valides acceptées
  assert.equal(store.setSetting("intelligence.maxOutputTokens", 32000, "GLOBAL", "global").effectiveValue, 32000);
  assert.equal(store.setSetting("settings.language", "en", "GLOBAL", "global").effectiveValue, "en");
});

test("CHANTIER 8: intelligence.maxOutputTokens vaut 20000 par défaut (jamais 4000), distinct de system.tokenBudget", () => {
  setupTestDb();
  const store = new SettingsStore();
  const maxOutputDef = SETTINGS_CATALOG.find((s) => s.key === "intelligence.maxOutputTokens")!;
  assert.equal(maxOutputDef.defaultValue, 20000);
  assert.equal(store.getEffectiveSetting("intelligence.maxOutputTokens").effectiveValue, 20000);

  // system.tokenBudget (budget d'ENTRÉE) reste un réglage totalement distinct : le
  // changer n'affecte jamais le plafond de sortie configuré, et réciproquement.
  store.setSetting("system.tokenBudget", 9000, "GLOBAL", "global");
  assert.equal(store.getEffectiveSetting("intelligence.maxOutputTokens").effectiveValue, 20000);
  store.setSetting("intelligence.maxOutputTokens", 12000, "GLOBAL", "global");
  assert.equal(store.getEffectiveSetting("system.tokenBudget").effectiveValue, 9000);
});

test("CHANTIER 8: persistance et restauration après redémarrage/recréation du runtime", async () => {
  setupTestDb();
  const store = new SettingsStore();
  const { applyAllEffectiveRuntimeSettings } = await import("./applier.js");
  const { Agent } = await import("../core/agent.js");
  const { MockProvider } = await import("../llm/providers/mock.js");

  store.setSetting("intelligence.temperature", 0.3, "GLOBAL", "global");
  store.setSetting("intelligence.topP", 0.5, "GLOBAL", "global");
  store.setSetting("intelligence.maxOutputTokens", 8192, "GLOBAL", "global");
  store.setSetting("intelligence.contextWindowOverride", 32000, "GLOBAL", "global");
  store.setSetting("autonomy.globalRiskLevel", "HIGH", "GLOBAL", "global");
  store.setSetting("autonomy.permissionMatrix", "DELETE", "GLOBAL", "global");
  store.setSetting("connections.healthTimeoutMs", 9000, "GLOBAL", "global");
  store.setSetting("connections.requestTimeoutMs", 60000, "GLOBAL", "global");
  store.setSetting("projects.memoryRetentionDays", 7, "GLOBAL", "global");
  store.setSetting("activity.logLevel", "DEBUG", "GLOBAL", "global");
  store.setSetting("settings.language", "en", "GLOBAL", "global");
  store.setSetting("settings.responseLength", "SHORT", "GLOBAL", "global");

  // "Redémarrage" simulé : nouvelle instance Agent + nouvelle instance SettingsStore
  // relisant depuis la même base — applier.ts reste le seul point d'application.
  const freshStore = new SettingsStore();
  const agent = new Agent({ llm: new MockProvider(), embeddings: new LocalHashingEmbeddingProvider() });
  applyAllEffectiveRuntimeSettings(agent, freshStore);

  assert.equal(config.llm.temperature, 0.3);
  assert.equal(config.llm.topP, 0.5);
  assert.equal(config.llm.maxOutputTokens, 8192);
  assert.equal(config.llm.contextWindowOverride, 32000);
  assert.equal(config.autonomy.globalRiskLevel, "HIGH");
  assert.equal(config.autonomy.permissionMatrix, "DELETE");
  assert.equal(config.connections.healthTimeoutMs, 9000);
  assert.equal(config.connections.requestTimeoutMs, 60000);
  assert.equal(config.projects.memoryRetentionDays, 7);
  assert.equal(config.activity.logLevel, "DEBUG");
  assert.equal(config.locale.language, "en");
  assert.equal(config.locale.responseLength, "SHORT");

  // reset -> défaults restaurés (persistance ET restauration vérifiées dans les deux sens)
  freshStore.resetAll("GLOBAL", "global");
  applyAllEffectiveRuntimeSettings(agent, freshStore);
  assert.equal(config.llm.temperature, 0.7);
  assert.equal(config.llm.maxOutputTokens, 20000);
  assert.equal(config.autonomy.globalRiskLevel, "MEDIUM");
  assert.equal(config.autonomy.permissionMatrix, "EXECUTE");
});

test("CHANTIER 8: temperature/topP/maxOutputTokens sont réellement transmis à l'appel LLM principal", async () => {
  setupTestDb();
  const { Agent } = await import("../core/agent.js");
  const store = new SettingsStore();
  store.setSetting("intelligence.temperature", 0.15, "GLOBAL", "global");
  store.setSetting("intelligence.topP", 0.4, "GLOBAL", "global");
  store.setSetting("intelligence.maxOutputTokens", 4321, "GLOBAL", "global");
  const { applyAllEffectiveRuntimeSettings } = await import("./applier.js");

  let captured: CompletionOptions | undefined;
  const spy: LLMProvider = {
    name: "mock",
    async complete(_messages: ChatMessage[], options?: CompletionOptions) {
      captured = options;
      return { content: "ok" };
    },
  };
  const agent = new Agent({ llm: spy, embeddings: new LocalHashingEmbeddingProvider() });
  applyAllEffectiveRuntimeSettings(agent, store);

  await agent.step("bonjour");
  assert.equal(captured?.temperature, 0.15);
  assert.equal(captured?.topP, 0.4);
  assert.equal(captured?.maxTokens, 4321);
});

test("CHANTIER 8: un appel explicite (probe/petite limite technique) conserve sa propre limite", async () => {
  setupTestDb();
  const { withGenerationDefaults } = await import("../llm/generationDefaults.js");
  const merged = withGenerationDefaults({ maxTokens: 5, temperature: 0 });
  assert.equal(merged.maxTokens, 5);
  assert.equal(merged.temperature, 0);
  assert.equal(merged.topP, config.llm.topP);
});

test("CHANTIER 8: settings.language et settings.responseLength influencent le prompt système de Jarvis", async () => {
  setupTestDb();
  const { Agent } = await import("../core/agent.js");
  const store = new SettingsStore();
  const { applyAllEffectiveRuntimeSettings } = await import("./applier.js");

  let capturedPrompt = "";
  const spy: LLMProvider = {
    name: "mock",
    async complete(messages: ChatMessage[]) {
      capturedPrompt = messages.find((m) => m.role === "system")?.content ?? "";
      return { content: "ok" };
    },
  };
  const agent = new Agent({ llm: spy, embeddings: new LocalHashingEmbeddingProvider() });

  store.setSetting("settings.language", "en", "GLOBAL", "global");
  store.setSetting("settings.responseLength", "DETAILED", "GLOBAL", "global");
  applyAllEffectiveRuntimeSettings(agent, store);
  await agent.step("hi");
  assert.match(capturedPrompt, /Respond exclusively in English/);
  assert.match(capturedPrompt, /Développe en détail/);

  store.setSetting("settings.language", "fr", "GLOBAL", "global");
  store.setSetting("settings.responseLength", "SHORT", "GLOBAL", "global");
  applyAllEffectiveRuntimeSettings(agent, store);
  await agent.step("bonjour");
  assert.match(capturedPrompt, /Réponds exclusivement en français/);
  assert.match(capturedPrompt, /courtes et directes/);
});

test("CHANTIER 8: contextWindowOverride plafonne le budget d'entrée pour protéger entrée+sortie", () => {
  const generousBudget = resolveEffectiveInputBudget(undefined, 200000, 2000);
  assert.ok(generousBudget < 200000, "doit être plafonné par la fenêtre de contexte par défaut");

  const previousOverride = config.llm.contextWindowOverride;
  try {
    config.llm.contextWindowOverride = 3000;
    const tightBudget = resolveEffectiveInputBudget(undefined, 100000, 2000);
    // fenêtre 3000 - sortie 2000 - marge 500 = 500 tokens d'entrée max
    assert.equal(tightBudget, 500);
  } finally {
    config.llm.contextWindowOverride = previousOverride;
  }

  // Un modèle connu (Claude) utilise sa vraie fenêtre, pas l'override générique.
  const knownModelBudget = resolveEffectiveInputBudget("claude-3-5-sonnet-20241022", 5000, 2000);
  assert.equal(knownModelBudget, 5000, "5000 < 200000-2000-500, donc le budget demandé n'est pas réduit");
});

// ---------------------------------------------------------------------------
// Fallback modèle principal -> fallback1 -> fallback2
// ---------------------------------------------------------------------------
test("CHANTIER 8: sans fallback configuré, l'échec du modèle principal remonte tel quel", async () => {
  const previous1 = config.llm.fallbackModel1;
  const previous2 = config.llm.fallbackModel2;
  config.llm.fallbackModel1 = "";
  config.llm.fallbackModel2 = "";
  try {
    const primary: LLMProvider = { name: "mock", async complete() { throw new Error("PRIMARY_DOWN"); } };
    await assert.rejects(() => completeWithFallback(primary, [{ role: "user", content: "hi" }], {}), /PRIMARY_DOWN/);
  } finally {
    config.llm.fallbackModel1 = previous1;
    config.llm.fallbackModel2 = previous2;
  }
});

test("CHANTIER 8: échec du modèle principal bascule sur fallback1", async () => {
  const previous1 = config.llm.fallbackModel1;
  const previous2 = config.llm.fallbackModel2;
  config.llm.fallbackModel1 = "some-other-mock-model";
  config.llm.fallbackModel2 = "";
  try {
    const primary: LLMProvider = { name: "mock", async complete() { throw new Error("PRIMARY_DOWN"); } };
    const result = await completeWithFallback(primary, [{ role: "user", content: "hi" }], {});
    assert.match(result.content ?? "", /mock/i);
  } finally {
    config.llm.fallbackModel1 = previous1;
    config.llm.fallbackModel2 = previous2;
  }
});

test("CHANTIER 8: chaîne complète épuisée (principal + fallback1 + fallback2) échoue explicitement, sans boucle infinie", async () => {
  const previousKey = config.llm.anthropicApiKey;
  const previous1 = config.llm.fallbackModel1;
  const previous2 = config.llm.fallbackModel2;
  config.llm.anthropicApiKey = ""; // garantit un échec synchrone et déterministe, sans réseau
  config.llm.fallbackModel1 = "claude-fallback-1";
  config.llm.fallbackModel2 = "claude-fallback-2";
  try {
    const primary: LLMProvider = { name: "anthropic", async complete() { throw new Error("PRIMARY_DOWN"); } };
    await assert.rejects(
      () => completeWithFallback(primary, [{ role: "user", content: "hi" }], {}),
      (err: Error) => {
        assert.match(err.message, /LLM_FALLBACK_CHAIN_EXHAUSTED/);
        assert.match(err.message, /claude-fallback-1/);
        assert.match(err.message, /claude-fallback-2/);
        assert.match(err.message, /PRIMARY_DOWN/);
        return true;
      },
    );
  } finally {
    config.llm.anthropicApiKey = previousKey;
    config.llm.fallbackModel1 = previous1;
    config.llm.fallbackModel2 = previous2;
  }
});

// ---------------------------------------------------------------------------
// Modèles spécialisés (coding/research/utility)
// ---------------------------------------------------------------------------
test("CHANTIER 8: sans modèle spécialisé configuré, le modèle principal est utilisé", () => {
  const previous = config.llm.codingModel;
  config.llm.codingModel = "";
  try {
    assert.equal(resolveModelForRole("coding"), undefined);
    const fallback: LLMProvider = { name: "mock", async complete() { return { content: "x" }; } };
    assert.equal(providerForRole("coding", fallback), fallback);
  } finally {
    config.llm.codingModel = previous;
  }
});

test("CHANTIER 8: un modèle spécialisé configuré est réellement utilisé pour son rôle", () => {
  const previous = config.llm.researchModel;
  config.llm.researchModel = "research-specialist-model";
  try {
    const fallback: LLMProvider = { name: "infermatic", model: "main-model", async complete() { return { content: "x" }; } };
    const routed = providerForRole("research", fallback);
    assert.notEqual(routed, fallback);
    assert.equal(routed.model, "research-specialist-model");
    assert.equal(routed.name, "infermatic");
  } finally {
    config.llm.researchModel = previous;
  }
});

// ---------------------------------------------------------------------------
// Autonomie & sécurité : globalRiskLevel, permissionMatrix, autoMergePr
// ---------------------------------------------------------------------------
function riskHarness(risk: string, permission?: string) {
  const registry = new ServiceRegistry("/does-not-exist");
  registry.register({
    id: "test",
    name: "test",
    enabled: true,
    endpoint: "local",
    capabilities: ["cap"],
    priority: 1,
    riskByCapability: { cap: risk as never },
    ...(permission ? { permissionByCapability: { cap: permission } } : {}),
  });
  let dispatches = 0;
  const adapter = {
    dispatchTask: async (_endpoint: string, request: TaskRequest) => {
      dispatches++;
      const event = (sequence: number, type: ServiceEvent["type"]): ServiceEvent => ({
        schema_version: "1.0", event_id: `${request.task_id}-${sequence}`, task_id: request.task_id,
        trace_id: request.trace_id, service: "test", sequence, type, timestamp: Date.now(),
        payload: type === "TASK_COMPLETED" ? { ok: true } : {},
      });
      return { success: true as const, events: [event(1, "TASK_ACCEPTED"), event(2, "TASK_COMPLETED")] };
    },
  } as ServiceAdapter;
  return { orchestrator: new ServiceOrchestrator({ registry, adapter }), count: () => dispatches };
}

test("CHANTIER 8: autonomy.globalRiskLevel par défaut (MEDIUM) reproduit le comportement historique", async () => {
  setupTestDb();
  assert.equal(config.autonomy.globalRiskLevel, "MEDIUM");
  for (const risk of ["LOW", "MEDIUM"]) {
    const h = riskHarness(risk);
    const result = await h.orchestrator.dispatchCapability({ action: "DISPATCH_CAPABILITY", capability: "cap", objective: risk });
    assert.equal(result.status, "COMPLETED");
  }
  const high = riskHarness("HIGH");
  const pending = await high.orchestrator.dispatchCapability({ action: "DISPATCH_CAPABILITY", capability: "cap", objective: "high" });
  assert.equal(pending.status, "WAITING_PERMISSION");
});

test("CHANTIER 8: abaisser autonomy.globalRiskLevel bloque désormais MEDIUM sans approbation", async () => {
  setupTestDb();
  const previous = config.autonomy.globalRiskLevel;
  config.autonomy.globalRiskLevel = "LOW";
  try {
    const h = riskHarness("MEDIUM");
    const result = await h.orchestrator.dispatchCapability({ action: "DISPATCH_CAPABILITY", capability: "cap", objective: "medium" });
    assert.equal(result.status, "WAITING_PERMISSION");
    assert.equal(h.count(), 0);
  } finally {
    config.autonomy.globalRiskLevel = previous;
  }
});

test("CHANTIER 8: CRITICAL exige toujours la confirmation renforcée, même avec globalRiskLevel=CRITICAL", async () => {
  setupTestDb();
  const previous = config.autonomy.globalRiskLevel;
  config.autonomy.globalRiskLevel = "CRITICAL";
  try {
    const h = riskHarness("CRITICAL");
    const pending = await h.orchestrator.dispatchCapability({ action: "DISPATCH_CAPABILITY", capability: "cap", objective: "critical" });
    assert.equal(pending.status, "WAITING_PERMISSION");
    assert.equal(await h.orchestrator.approvePendingOperation(pending.taskId), null, "sans APPROVE_CRITICAL, refusé");
    const approved = await h.orchestrator.approvePendingOperation(pending.taskId, "APPROVE_CRITICAL");
    assert.equal(approved?.status, "COMPLETED");
  } finally {
    config.autonomy.globalRiskLevel = previous;
  }
});

test("CHANTIER 8: autonomy.permissionMatrix bloque au point d'exécution effectif une capacité au-delà du plafond", async () => {
  setupTestDb();
  const h = riskHarness("LOW", "SEND"); // EXECUTE (défaut) < SEND -> refusé
  const result = await h.orchestrator.dispatchCapability({ action: "DISPATCH_CAPABILITY", capability: "cap", objective: "send" });
  assert.equal(result.status, "REJECTED");
  assert.match(result.error ?? "", /PERMISSION_DENIED/);
  assert.equal(h.count(), 0);
});

test("CHANTIER 8: élever autonomy.permissionMatrix autorise une capacité SEND explicitement déclarée", async () => {
  setupTestDb();
  const previous = config.autonomy.permissionMatrix;
  config.autonomy.permissionMatrix = "SEND";
  try {
    const h = riskHarness("LOW", "SEND");
    const result = await h.orchestrator.dispatchCapability({ action: "DISPATCH_CAPABILITY", capability: "cap", objective: "send" });
    assert.equal(result.status, "COMPLETED");
  } finally {
    config.autonomy.permissionMatrix = previous;
  }
});

test("CHANTIER 8: autonomy.autoMergePr reste verrouillé false quoi qu'il arrive", () => {
  setupTestDb();
  const store = new SettingsStore();
  assert.equal(store.getEffectiveSetting("autonomy.autoMergePr").effectiveValue, false);
  assert.equal(store.getEffectiveSetting("autonomy.autoMergePr").source, "SYSTEM");
  assert.throws(() => store.setSetting("autonomy.autoMergePr", true, "GLOBAL", "global"), /SETTING_NOT_EDITABLE/);
  // Aucun chemin d'import ne peut l'activer non plus (garde de /api/settings/import).
  const def = SETTINGS_CATALOG.find((s) => s.key === "autonomy.autoMergePr")!;
  assert.equal(def.availability, "SYSTEM_LOCKED");
});

// ---------------------------------------------------------------------------
// Connexions : timeouts globaux effectifs + health check au démarrage
// ---------------------------------------------------------------------------
test("CHANTIER 8: connections.healthTimeoutMs/requestTimeoutMs deviennent le défaut effectif, un override par service garde la priorité", () => {
  setupTestDb();
  const previousHealth = config.connections.healthTimeoutMs;
  const previousRequest = config.connections.requestTimeoutMs;
  try {
    config.connections.healthTimeoutMs = 8000;
    config.connections.requestTimeoutMs = 45000;

    const registry = new ServiceRegistry("/does-not-exist");
    registry.register({ id: "no-override", name: "no-override", enabled: true, transport: "task_http", endpoint: "http://localhost:9", capabilities: ["cap"], priority: 1, auth: { type: "none" } });
    registry.register({ id: "with-override", name: "with-override", enabled: true, transport: "task_http", endpoint: "http://localhost:9", capabilities: ["cap"], priority: 1, auth: { type: "none" }, healthTimeoutMs: 1500, requestTimeoutMs: 5000 });

    const noOverride = registry.getServiceById("no-override")!;
    const withOverride = registry.getServiceById("with-override")!;
    assert.equal(noOverride.healthTimeoutMs, 8000);
    assert.equal(noOverride.requestTimeoutMs, 45000);
    assert.equal(withOverride.healthTimeoutMs, 1500);
    assert.equal(withOverride.requestTimeoutMs, 5000);
  } finally {
    config.connections.healthTimeoutMs = previousHealth;
    config.connections.requestTimeoutMs = previousRequest;
  }
});

test("CHANTIER 8: connections.autoTestOnStartup exécute réellement un health check de tous les services activés", async () => {
  setupTestDb();
  const registry = new ServiceRegistry("/does-not-exist");
  const adapter = {
    checkHealth: async (value: unknown) => ({
      serviceId: (value as { id: string }).id, reachable: true, status: 200, latencyMs: 1, checkedAt: Date.now(),
    }),
  } as unknown as ServiceAdapter;
  registry.register({ id: "svc-a", name: "svc-a", enabled: true, transport: "task_http", endpoint: "http://localhost:9", capabilities: ["cap"], priority: 1, auth: { type: "none" } });
  registry.register({ id: "svc-b", name: "svc-b", enabled: false, transport: "task_http", endpoint: "http://localhost:9", capabilities: ["cap2"], priority: 1, auth: { type: "none" } });
  const orchestrator = new ServiceOrchestrator({ registry, adapter });

  const results = await runStartupHealthChecks(orchestrator);
  assert.equal(results.length, 1, "seul le service activé (enabled=true) est testé");
  assert.equal(results[0].serviceId, "svc-a");
  assert.equal(results[0].reachable, true);
});

// ---------------------------------------------------------------------------
// intelligence.toolCompatibilityTest : réellement exécuté, sans modifier le modèle actif
// ---------------------------------------------------------------------------
test("CHANTIER 8: le test de compatibilité tool calling s'exécute réellement sur le modèle actif et ne le modifie jamais", async () => {
  setupTestDb();
  const previousToken = config.api.token;
  config.api.token = "compat-test-token";
  const { startHttpApi } = await import("../interfaces/httpApi.js");
  const { Agent } = await import("../core/agent.js");
  const { MockProvider } = await import("../llm/providers/mock.js");
  const agent = new Agent({ llm: new MockProvider(), embeddings: new LocalHashingEmbeddingProvider() });
  const beforeProvider = agent.getLLMProvider();
  const testPort = 4155;
  const server = startHttpApi(agent, testPort);
  try {
    const res = await fetch(`http://localhost:${testPort}/api/settings/tool-compatibility-test`, {
      method: "POST",
      headers: { authorization: `Bearer compat-test-token` },
    });
    assert.equal(res.status, 200);
    const body = await res.json();
    assert.equal(body.ok, true);
    assert.equal(body.provider, "mock");
    assert.ok(body.compatibility);
    assert.equal(agent.getLLMProvider(), beforeProvider, "le modèle actif ne doit jamais être modifié par le test");
  } finally {
    server.close();
    config.api.token = previousToken;
  }
});

// ---------------------------------------------------------------------------
// activity.logLevel : granularité réelle, sans fuite de secrets à aucun niveau
// ---------------------------------------------------------------------------
test("CHANTIER 8: activity.logLevel change réellement la granularité des événements journalisés", () => {
  setupTestDb();
  const previous = config.activity.logLevel;
  try {
    const store = new ActivityStore();

    config.activity.logLevel = "NORMAL";
    assert.equal(store.append({ eventType: "SKILLS_SELECTED", message: "debug-tier-event" }), null, "DEBUG filtré à NORMAL");
    assert.ok(store.append({ eventType: "PLAN_STARTED", message: "normal-tier-event" }), "NORMAL toujours conservé");

    config.activity.logLevel = "DETAILED";
    assert.ok(store.append({ eventType: "STEP_COMPLETED", message: "detailed-tier-event" }), "DETAILED conservé à DETAILED");
    assert.equal(store.append({ eventType: "SKILLS_SELECTED", message: "still-debug-event" }), null, "DEBUG reste filtré à DETAILED");

    config.activity.logLevel = "DEBUG";
    assert.ok(store.append({ eventType: "SKILLS_SELECTED", message: "debug-event-visible-now" }), "DEBUG conservé à DEBUG");
  } finally {
    config.activity.logLevel = previous;
  }
});

test("CHANTIER 8: aucun niveau de journalisation n'expose de secret", () => {
  setupTestDb();
  const previous = config.activity.logLevel;
  try {
    const store = new ActivityStore();
    for (const level of ["NORMAL", "DETAILED", "DEBUG"] as const) {
      config.activity.logLevel = level;
      assert.throws(() => store.append({ eventType: "PLAN_STARTED", message: "Authorization: Bearer sk-secret-value" }));
      assert.throws(() => store.append({ eventType: "PLAN_STARTED", message: "ok", metadata: { apiKey: "sk-leak" } }));
    }
  } finally {
    config.activity.logLevel = previous;
  }
});

// ---------------------------------------------------------------------------
// Projets, Fichiers & Mémoire : isolation, RAG, auto-indexation, rétention
// ---------------------------------------------------------------------------
test("CHANTIER 8: projects.projectIsolation confine la mémoire vectorielle par workspace quand activé", async () => {
  setupTestDb();
  const previous = config.projects.projectIsolation;
  try {
    const vector = new VectorMemory(new LocalHashingEmbeddingProvider());
    await vector.add("Le chat mange une souris grise.", "episodic", { workspaceId: "ws-a" });
    await vector.add("Le chien aboie fort dans le jardin.", "episodic", { workspaceId: "ws-b" });

    config.projects.projectIsolation = false;
    const globalResults = await vector.search("chat souris grise", 5, { workspaceId: "ws-b" });
    assert.ok(globalResults.some((r) => r.text.includes("souris")), "isolation désactivée : comportement global inchangé");

    config.projects.projectIsolation = true;
    const isolatedResults = await vector.search("chat souris grise", 5, { workspaceId: "ws-b" });
    assert.equal(isolatedResults.some((r) => r.text.includes("souris")), false, "isolation activée : le souvenir d'un autre workspace ne fuite pas");

    const ownResults = await vector.search("chat souris grise", 5, { workspaceId: "ws-a" });
    assert.ok(ownResults.some((r) => r.text.includes("souris")), "le souvenir du bon workspace reste accessible");
  } finally {
    config.projects.projectIsolation = previous;
  }
});

test("CHANTIER 8: projects.knowledgeRag indexe et recherche sémantiquement les documents d'un workspace (RAG projet réel)", async () => {
  setupTestDb();
  const { WorkspaceStore } = await import("../workspaces/workspaceStore.js");
  const workspaces = new WorkspaceStore(undefined);
  const vector = new VectorMemory(new LocalHashingEmbeddingProvider());
  const wsA = workspaces.create({ name: "ws-a", ownerType: "ADHOC", ownerId: "rag-a" });
  const wsB = workspaces.create({ name: "ws-b", ownerType: "ADHOC", ownerId: "rag-b" });
  workspaces.writeFile(wsA.id, "notes.txt", "La recette du gâteau au chocolat demande du beurre et des oeufs.");
  workspaces.writeFile(wsB.id, "notes.txt", "Le rapport financier trimestriel montre une croissance de 12%.");

  const indexResult = await indexWorkspaceDocument(workspaces, vector, wsA.id, "notes.txt");
  assert.equal(indexResult.indexed, true);
  assert.ok(indexResult.chunks >= 1);
  await indexWorkspaceDocument(workspaces, vector, wsB.id, "notes.txt");

  // Recherche strictement scopée à ws-a, indépendamment de projects.projectIsolation.
  const matches = await searchWorkspaceKnowledge(vector, wsA.id, "recette gâteau chocolat", 3);
  assert.ok(matches.length > 0);
  assert.ok(matches.every((m) => m.text.includes("gâteau") || m.text.includes("beurre")));

  const crossWorkspace = await searchWorkspaceKnowledge(vector, wsB.id, "recette gâteau chocolat", 3);
  assert.equal(crossWorkspace.some((m) => m.text.includes("gâteau")), false, "le RAG ne fuite jamais entre workspaces");
});

test("CHANTIER 8: la ré-indexation d'un même document ne crée jamais de doublon, la suppression maintient l'index cohérent", async () => {
  setupTestDb();
  const { WorkspaceStore } = await import("../workspaces/workspaceStore.js");
  const workspaces = new WorkspaceStore(undefined);
  const vector = new VectorMemory(new LocalHashingEmbeddingProvider());
  const ws = workspaces.create({ name: "dedup", ownerType: "ADHOC", ownerId: "dedup" });
  workspaces.writeFile(ws.id, "doc.txt", "Contenu original du document de test pour la déduplication.");

  await indexWorkspaceDocument(workspaces, vector, ws.id, "doc.txt");
  const countAfterFirst = vector.count();
  await indexWorkspaceDocument(workspaces, vector, ws.id, "doc.txt");
  assert.equal(vector.count(), countAfterFirst, "ré-indexer le même chemin ne duplique jamais les chunks");

  const removed = removeWorkspaceDocumentIndex(vector, ws.id, "doc.txt");
  assert.ok(removed > 0);
  assert.equal(vector.count(), 0, "la suppression retire bien tout l'index de ce document");
});

test("CHANTIER 8: document_work INDEX/RAG_SEARCH exigent projects.knowledgeRag activé", async () => {
  setupTestDb();
  const { createRuntimeSkills } = await import("../skills/runtime.js");
  const { ServiceOrchestrator: Orchestrator } = await import("../orchestration/serviceOrchestrator.js");
  const { Planner } = await import("../planning/planner.js");
  const { PlanRunner } = await import("../planning/planRunner.js");
  const { WorkflowRegistry } = await import("../workflows/workflowRegistry.js");

  const previous = config.projects.knowledgeRag;
  config.projects.knowledgeRag = false;
  try {
    const orchestrator = new Orchestrator();
    const planner = new Planner();
    const runner = new PlanRunner(orchestrator, planner);
    const workflows = new WorkflowRegistry();
    const skills = createRuntimeSkills(orchestrator, planner, runner, workflows);
    const documentWork = skills.find((s) => s.id === "document_work")!;
    const ws = orchestrator.workspaces.create({ name: "gate", ownerType: "ADHOC", ownerId: "gate" });

    await assert.rejects(
      () => documentWork.handler!({ action: "INDEX", workspaceId: ws.id, path: "x.txt" }, {} as never),
      /KNOWLEDGE_RAG_DISABLED/,
    );

    config.projects.knowledgeRag = true;
    orchestrator.workspaces.writeFile(ws.id, "x.txt", "contenu indexable");
    const indexed = JSON.parse(await documentWork.handler!({ action: "INDEX", workspaceId: ws.id, path: "x.txt" }, {} as never));
    assert.equal(indexed.indexed, true);
  } finally {
    config.projects.knowledgeRag = previous;
  }
});

test("CHANTIER 8: projects.memoryRetentionDays supprime uniquement les souvenirs episodic expirés, jamais les reflections consolidées", async () => {
  setupTestDb();
  const vector = new VectorMemory(new LocalHashingEmbeddingProvider());
  const now = Date.now();
  const oldEpisodic = await vector.add("vieux souvenir de conversation", "episodic");
  const recentEpisodic = await vector.add("souvenir récent de conversation", "episodic");
  const oldReflection = await vector.add("enseignement consolidé ancien", "reflection");
  const oldKnowledge = await vector.add("chunk RAG ancien", "knowledge");

  // Recule artificiellement created_at pour simuler l'ancienneté (comportement déterministe et testable).
  const db = getDb();
  const THIRTY_ONE_DAYS_AGO = now - 31 * 24 * 60 * 60 * 1000;
  for (const id of [oldEpisodic.id, oldReflection.id, oldKnowledge.id]) {
    db.prepare("UPDATE memory_entries SET created_at = ? WHERE id = ?").run(THIRTY_ONE_DAYS_AGO, id);
  }

  const deleted = sweepExpiredEpisodicMemory(30, now);
  assert.equal(deleted, 1, "seul le souvenir episodic expiré est supprimé");

  const remaining = db.prepare("SELECT id FROM memory_entries").all() as Array<{ id: string }>;
  const remainingIds = remaining.map((r) => r.id);
  assert.equal(remainingIds.includes(oldEpisodic.id), false);
  assert.ok(remainingIds.includes(recentEpisodic.id), "l'episodic récent est conservé");
  assert.ok(remainingIds.includes(oldReflection.id), "les reflections consolidées ne sont jamais supprimées par la rétention");
  assert.ok(remainingIds.includes(oldKnowledge.id), "l'index RAG (knowledge) suit le cycle de vie des fichiers, pas la rétention temporelle");

  assert.equal(sweepExpiredEpisodicMemory(0, now), 0, "une rétention nulle/invalide est un no-op sûr");
});
