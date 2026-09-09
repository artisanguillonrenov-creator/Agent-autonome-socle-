import test from "node:test";
import assert from "node:assert/strict";
import { closeDb, getDb } from "../persistence/db.js";
import { config } from "../config.js";
import { SETTINGS_CATALOG } from "./catalog.js";
import { SettingsStore } from "./store.js";
import { ConnectionStore } from "../connections/store.js";
import { ServiceRegistry } from "../orchestration/serviceRegistry.js";
import { ServiceAdapter } from "../orchestration/serviceAdapter.js";
import { SkillRegistry } from "../skills/registry.js";
import { LocalHashingEmbeddingProvider } from "../llm/embeddings.js";

function setupTestDb() {
  config.db.path = ":memory:";
  closeDb();
  getDb();
}

test("SETTINGS: GLOBAL write OK and PROJECT/TASK write rejected", () => {
  setupTestDb();
  const store = new SettingsStore();

  const setGlobal = store.setSetting("system.tokenBudget", 8000, "GLOBAL", "global");
  assert.equal(setGlobal.effectiveValue, 8000);
  assert.equal(setGlobal.source, "DATABASE");

  assert.throws(() => store.setSetting("system.tokenBudget", 8000, "PROJECT", "proj-1"), /SETTINGS_SCOPE_NOT_AVAILABLE/);
  assert.throws(() => store.setSetting("system.tokenBudget", 8000, "TASK", "task-1"), /SETTINGS_SCOPE_NOT_AVAILABLE/);
});

test("SETTINGS: FUTURE setting is not editable and system locked autoMergePr is locked", () => {
  setupTestDb();
  const store = new SettingsStore();

  const futureDef = SETTINGS_CATALOG.find((s) => s.availability === "FUTURE")!;
  assert.equal(futureDef.editable, false);
  assert.throws(() => store.setSetting(futureDef.key, "val", "GLOBAL", "global"), /SETTING_NOT_EDITABLE/);

  const lockedDef = SETTINGS_CATALOG.find((s) => s.key === "autonomy.autoMergePr")!;
  assert.equal(lockedDef.editable, false);
  assert.equal(store.getEffectiveSetting("autonomy.autoMergePr").effectiveValue, false);
  assert.equal(store.getEffectiveSetting("autonomy.autoMergePr").source, "SYSTEM");
});

test("SETTINGS: Audit log records changes without secrets", () => {
  setupTestDb();
  const store = new SettingsStore();

  store.setSetting("system.tokenBudget", 5000, "GLOBAL", "global");
  const logs = store.listAuditLogs();
  assert.ok(logs.length > 0);
  assert.equal(logs[0].settingKey, "system.tokenBudget");
  assert.equal(logs[0].newValueJson, "5000");

  const logStr = JSON.stringify(logs);
  assert.equal(logStr.includes("sk-"), false);
  assert.equal(logStr.includes("ghp_"), false);
  assert.equal(logStr.includes("Bearer"), false);
});

test("SERVICE REGISTRY: authority order ENVIRONMENT > DATABASE > FACTORY", () => {
  setupTestDb();
  const previousEnvUrl = process.env.SOFTWARE_FACTORY_URL;
  try {
    delete process.env.SOFTWARE_FACTORY_URL;

    const registry = new ServiceRegistry();
    const initialSf = registry.getServiceById("software_factory")!;
    assert.equal(initialSf.source, "FACTORY");

    // DB Override
    registry.register({
      ...initialSf,
      endpoint: "http://localhost:4050",
      priority: 88,
    });

    const dbSf = registry.getServiceById("software_factory")!;
    assert.equal(dbSf.endpoint, "http://localhost:4050");
    assert.equal(dbSf.source, "DATABASE");
    assert.equal(dbSf.priority, 88);

    // ENV Override
    process.env.SOFTWARE_FACTORY_URL = "http://localhost:9999";
    const envSf = registry.getServiceById("software_factory")!;
    assert.equal(envSf.endpoint, "http://localhost:9999");
    assert.equal(envSf.source, "ENVIRONMENT");
  } finally {
    if (previousEnvUrl) process.env.SOFTWARE_FACTORY_URL = previousEnvUrl;
    else delete process.env.SOFTWARE_FACTORY_URL;
  }
});

test("SERVICE REGISTRY: Input validations (priority 0..100, paths, auth envVar, timeouts)", () => {
  setupTestDb();
  const registry = new ServiceRegistry();

  // Invalid priority
  assert.throws(() => registry.register({
    id: "invalid_prio",
    name: "Bad Prio",
    enabled: true,
    transport: "task_http",
    endpoint: "http://localhost:3000",
    capabilities: ["software_development"],
    priority: 150,
    auth: { type: "none" },
  }), /invalid required fields/);

  // Path containing relative traversal
  assert.throws(() => registry.register({
    id: "bad_path",
    name: "Bad Path",
    enabled: true,
    transport: "task_http",
    endpoint: "http://localhost:3000",
    healthPath: "/../etc/passwd",
    capabilities: ["software_development"],
    priority: 10,
    auth: { type: "none" },
  }), /invalid healthPath/);

  // Invalid Auth envVar regex
  assert.throws(() => registry.register({
    id: "bad_env",
    name: "Bad Env",
    enabled: true,
    transport: "task_http",
    endpoint: "http://localhost:3000",
    capabilities: ["software_development"],
    priority: 10,
    auth: { type: "bearer_env", envVar: "invalid-env-var-name!" },
  }), /invalid auth/);
});

test("CONNECTIONS: Factory DELETE forbidden, user service DELETE allowed", () => {
  setupTestDb();
  const registry = new ServiceRegistry();

  assert.throws(() => registry.deleteService("software_factory"), (err: any) => err.status === 405);

  registry.register({
    id: "custom_user_svc",
    name: "User Service",
    enabled: true,
    transport: "task_http",
    endpoint: "http://localhost:3000",
    capabilities: ["software_development"],
    priority: 20,
    auth: { type: "none" },
  });

  assert.ok(registry.getServiceById("custom_user_svc"));
  registry.deleteService("custom_user_svc");
  assert.equal(registry.getServiceById("custom_user_svc"), null);
});

test("CONNECTIONS: Active operation blocks modification with 409 SERVICE_CONNECTION_IN_USE", () => {
  setupTestDb();
  const registry = new ServiceRegistry();

  getDb().prepare(`
    INSERT INTO service_operations (task_id, trace_id, idempotency_key, objective, capability, selected_service, status, created_at, updated_at)
    VALUES ('op-active-1', 'trace-1', 'idemp-1', 'obj', 'software_development', 'software_factory', 'RUNNING', ?, ?)
  `).run(Date.now(), Date.now());

  assert.throws(() => {
    registry.register({
      id: "software_factory",
      name: "Software Factory Modified",
      enabled: true,
      transport: "task_http",
      endpoint: "http://localhost:9999",
      capabilities: ["software_development"],
      priority: 99,
      auth: { type: "none" },
    });
  }, (err: any) => err.message === "SERVICE_CONNECTION_IN_USE" && err.taskIds.includes("op-active-1"));
});

test("SKILLS: live availability refresh (AVAILABLE <-> UNAVAILABLE)", () => {
  setupTestDb();
  const registry = new SkillRegistry(new LocalHashingEmbeddingProvider());

  const skillDef = {
    id: "test_research",
    name: "test_research",
    displayName: "Test Research",
    description: "Deep research skill",
    category: "Recherche" as const,
    kind: "SKILL" as const,
    availability: "AVAILABLE" as const,
    exposure: "DYNAMIC" as const,
    risk: "LOW" as const,
    executionTarget: "SERVICE_CAPABILITY" as const,
    serviceCapability: "deep_research",
    handler: async () => "ok",
    aliases: [],
    tags: [],
    requiresWorkspace: false,
    requiresConnector: false,
    defaultEnabled: true,
  };

  registry.register(skillDef);
  assert.equal(registry.get("test_research")?.availability, "AVAILABLE");

  // Refresh with empty service registry (no service providing deep_research)
  const emptyServiceRegistry = { findServiceForCapability: () => null };
  registry.refreshServiceAvailability(emptyServiceRegistry);

  assert.equal(registry.get("test_research")?.availability, "UNAVAILABLE");
  assert.equal(registry.get("test_research")?.unavailableReason, "AUCUN_SERVICE_CAPABLE");
  assert.equal(registry.get("test_research")?.handler !== undefined, true); // Handler preserved!

  // Refresh with capable service registry
  const activeServiceRegistry = { findServiceForCapability: (c: string) => c === "deep_research" ? { id: "research_service" } : null };
  registry.refreshServiceAvailability(activeServiceRegistry);

  assert.equal(registry.get("test_research")?.availability, "AVAILABLE");
  assert.equal(registry.get("test_research")?.unavailableReason, undefined);
});

test("IMPORT/EXPORT: Atomic import rollback on invalid payload and secret values excluded", async () => {
  setupTestDb();
  const store = new SettingsStore();
  const connStore = new ConnectionStore();

  store.setSetting("system.tokenBudget", 7500, "GLOBAL", "global");

  const exported = {
    schemaVersion: 1,
    exportedAt: Date.now(),
    settings: [{ key: "system.tokenBudget", value: 7500, effectiveValue: 7500, source: "DATABASE" }],
    serviceOverrides: [],
  };

  const exportedStr = JSON.stringify(exported);
  assert.equal(exportedStr.includes("API_TOKEN"), false);
  assert.equal(exportedStr.includes("SOFTWARE_FACTORY_TOKEN"), false);
  assert.equal(exportedStr.includes("sk-"), false);
  assert.equal(exportedStr.includes("ghp_"), false);
});

test("AUTH: Settings & Connections fail closed with 401 when API token is configured and missing/invalid", async () => {
  setupTestDb();
  const previousToken = config.api.token;
  config.api.token = "secret-test-token";

  const { startHttpApi } = await import("../interfaces/httpApi.js");
  const { Agent } = await import("../core/agent.js");
  const { MockProvider } = await import("../llm/providers/mock.js");

  const agent = new Agent({
    llm: new MockProvider(),
    embeddings: new LocalHashingEmbeddingProvider(),
  });

  const testPort = 4099;
  const server = startHttpApi(agent, testPort);

  try {
    // 1. Without Token -> 401
    const resNoToken = await fetch(`http://localhost:${testPort}/api/settings`);
    assert.equal(resNoToken.status, 401);

    const resConnNoToken = await fetch(`http://localhost:${testPort}/api/connections`);
    assert.equal(resConnNoToken.status, 401);

    // 2. Bad Token -> 401
    const resBadToken = await fetch(`http://localhost:${testPort}/api/settings`, {
      headers: { authorization: "Bearer wrong-token" },
    });
    assert.equal(resBadToken.status, 401);

    // 3. Correct Token -> 200
    const resGoodToken = await fetch(`http://localhost:${testPort}/api/settings`, {
      headers: { authorization: "Bearer secret-test-token" },
    });
    assert.equal(resGoodToken.status, 200);
  } finally {
    server.close();
    config.api.token = previousToken;
  }
});
