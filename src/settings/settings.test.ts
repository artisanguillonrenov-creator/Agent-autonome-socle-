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

test("SERVICE REGISTRY: authority order ENVIRONMENT > DATABASE > FACTORY and PATCH enabled does not freeze ENV endpoint", () => {
  setupTestDb();
  const previousEnvUrl = process.env.SOFTWARE_FACTORY_URL;
  try {
    delete process.env.SOFTWARE_FACTORY_URL;

    const registry = new ServiceRegistry();
    const initialSf = registry.getServiceById("software_factory")!;
    assert.equal(initialSf.source, "FACTORY");
    const factoryEndpoint = initialSf.endpoint;

    // Set ENV endpoint
    process.env.SOFTWARE_FACTORY_URL = "http://env-server.local:5000";
    const envSf = registry.getServiceById("software_factory")!;
    assert.equal(envSf.endpoint, "http://env-server.local:5000");
    assert.equal(envSf.source, "ENVIRONMENT");

    // PATCH enabled: false while ENV endpoint is active
    registry.patchService("software_factory", { enabled: false });

    const disabledSf = registry.getServiceById("software_factory")!;
    assert.equal(disabledSf.enabled, false);
    assert.equal(disabledSf.endpoint, "http://env-server.local:5000");
    assert.equal(disabledSf.source, "ENVIRONMENT");

    // Verify database override does NOT contain endpoint_override
    const dbOverride = registry.connectionStore.getOverride("software_factory")!;
    assert.equal(dbOverride.endpointOverride, undefined); // Never frozen in DB!

    // Remove ENV variable -> endpoint reverts to factory/historical DB endpoint
    delete process.env.SOFTWARE_FACTORY_URL;
    const revertedSf = registry.getServiceById("software_factory")!;
    assert.equal(revertedSf.endpoint, factoryEndpoint);
    assert.equal(revertedSf.source, "DATABASE");
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

test("HTTP IMPORT/EXPORT: Full export/import cycle, secret masking, and atomic transaction rollback", async () => {
  setupTestDb();
  const previousToken = config.api.token;
  config.api.token = "export-import-test-token";

  const { startHttpApi } = await import("../interfaces/httpApi.js");
  const { Agent } = await import("../core/agent.js");
  const { MockProvider } = await import("../llm/providers/mock.js");

  const agent = new Agent({
    llm: new MockProvider(),
    embeddings: new LocalHashingEmbeddingProvider(),
  });

  const testPort = 4098;
  const server = startHttpApi(agent, testPort);
  const headers = { authorization: "Bearer export-import-test-token", "content-type": "application/json" };

  try {
    // 1. Configure initial setting
    await fetch(`http://localhost:${testPort}/api/settings`, {
      method: "PATCH",
      headers,
      body: JSON.stringify({ key: "system.tokenBudget", value: 6500 }),
    });

    // 2. Export settings
    const exportRes = await fetch(`http://localhost:${testPort}/api/settings/export`, { headers });
    assert.equal(exportRes.status, 200);
    const exportData = await exportRes.json();
    assert.equal(exportData.schemaVersion, 1);
    assert.ok(Array.isArray(exportData.settings));

    const exportStr = JSON.stringify(exportData);
    assert.equal(exportStr.includes("export-import-test-token"), false);
    assert.equal(exportStr.includes("Bearer"), false);
    assert.equal(exportStr.includes("sk-"), false);
    assert.equal(exportStr.includes("ghp_"), false);

    // 3. Valid import
    exportData.settings.push({ key: "autonomy.maxIterations", value: 14 });
    const validImportRes = await fetch(`http://localhost:${testPort}/api/settings/import`, {
      method: "POST",
      headers,
      body: JSON.stringify(exportData),
    });
    assert.equal(validImportRes.status, 200);

    const getSettingsRes = await fetch(`http://localhost:${testPort}/api/settings`, { headers });
    const settingsList = await getSettingsRes.json();
    const maxIterSetting = settingsList.find((s: any) => s.definition.key === "autonomy.maxIterations");
    assert.equal(maxIterSetting.effectiveValue, 14);

    // 4. Invalid import (valid setting + valid service change + invalid/unknown setting in middle)
    const invalidPayload = {
      schemaVersion: 1,
      settings: [
        { key: "system.tokenBudget", value: 9999 }, // valid change
        { key: "unknown.setting.key", value: "bad" }, // INVALID!
      ],
      serviceOverrides: [
        {
          serviceId: "software_factory",
          name: "Factory Changed Rollback Test",
          userCreated: false,
          transportOverride: "task_http",
          endpointOverride: "http://invalid-rollback.local:9999",
        },
      ],
    };

    const invalidImportRes = await fetch(`http://localhost:${testPort}/api/settings/import`, {
      method: "POST",
      headers,
      body: JSON.stringify(invalidPayload),
    });
    assert.equal(invalidImportRes.status, 400);
    const invalidJson = await invalidImportRes.json();
    assert.equal(invalidJson.error, "SETTINGS_IMPORT_INVALID");

    // 5. Verify total SQLite rollback: BOTH system.tokenBudget AND software_factory remain unchanged!
    const getSettingsAfterRollback = await fetch(`http://localhost:${testPort}/api/settings`, { headers });
    const settingsAfterRollback = await getSettingsAfterRollback.json();
    const tokenBudgetSetting = settingsAfterRollback.find((s: any) => s.definition.key === "system.tokenBudget");
    assert.equal(tokenBudgetSetting.effectiveValue, 6500);

    const sfService = agent.serviceOrchestrator.registry.getServiceById("software_factory");
    assert.notEqual(sfService?.endpoint, "http://invalid-rollback.local:9999");
  } finally {
    server.close();
    config.api.token = previousToken;
  }
});

test("SETTINGS: applyAllEffectiveRuntimeSettings applies values on startup/restart and reset restores defaults", async () => {
  setupTestDb();
  const store = new SettingsStore();
  const { applyAllEffectiveRuntimeSettings } = await import("./applier.js");
  const { Agent } = await import("../core/agent.js");
  const { MockProvider } = await import("../llm/providers/mock.js");

  const agent = new Agent({
    llm: new MockProvider(),
    embeddings: new LocalHashingEmbeddingProvider(),
  });

  store.setSetting("system.tokenBudget", 9500, "GLOBAL", "global");
  store.setSetting("autonomy.maxIterations", 12, "GLOBAL", "global");

  applyAllEffectiveRuntimeSettings(agent, store);

  assert.equal(config.context.tokenBudget, 9500);
  assert.equal(config.agent.maxIterations, 12);

  // Reset settings
  store.resetAll("GLOBAL", "global");
  applyAllEffectiveRuntimeSettings(agent, store);

  assert.equal(config.context.tokenBudget, 4000); // restored default
  assert.equal(config.agent.maxIterations, 5); // restored default
});

test("CONNECTIONS PATCH VALIDATION & SERVER-SIDE USERCREATED DETERMINATION", async () => {
  setupTestDb();
  const previousToken = config.api.token;
  config.api.token = "conn-val-test-token";

  const { startHttpApi } = await import("../interfaces/httpApi.js");
  const { Agent } = await import("../core/agent.js");
  const { MockProvider } = await import("../llm/providers/mock.js");

  const agent = new Agent({
    llm: new MockProvider(),
    embeddings: new LocalHashingEmbeddingProvider(),
  });

  const testPort = 4101;
  const server = startHttpApi(agent, testPort);
  const headers = { authorization: "Bearer conn-val-test-token", "content-type": "application/json" };

  try {
    // 1. Invalid PATCH endpoint protocol
    const badEndpointRes = await fetch(`http://localhost:${testPort}/api/connections/software_factory`, {
      method: "PATCH",
      headers,
      body: JSON.stringify({ endpoint: "ftp://invalid-protocol.local" }),
    });
    assert.equal(badEndpointRes.status, 400);

    // 2. Invalid priority (> 100)
    const badPriorityRes = await fetch(`http://localhost:${testPort}/api/connections/software_factory`, {
      method: "PATCH",
      headers,
      body: JSON.stringify({ priority: 150 }),
    });
    assert.equal(badPriorityRes.status, 400);

    // 3. Invalid healthPath (traversal)
    const badPathRes = await fetch(`http://localhost:${testPort}/api/connections/software_factory`, {
      method: "PATCH",
      headers,
      body: JSON.stringify({ healthPath: "/../etc/passwd" }),
    });
    assert.equal(badPathRes.status, 400);

    // 4. Register new user-created service with userCreated: false claims & unknown capability -> rejected with 400
    const unknownCapRes = await fetch(`http://localhost:${testPort}/api/connections`, {
      method: "POST",
      headers,
      body: JSON.stringify({
        id: "user_svc_cap_test",
        name: "User Service Cap Test",
        userCreated: false, // Claiming to be factory service!
        endpoint: "http://localhost:4000",
        capabilities: ["unknown_fake_capability"], // INVALID!
      }),
    });
    assert.equal(unknownCapRes.status, 400);
    const jsonCap = await unknownCapRes.json();
    assert.ok(jsonCap.error.includes("CONNECTION_CAPABILITY_UNKNOWN"));
  } finally {
    server.close();
    config.api.token = previousToken;
  }
});

test("WORKSPACE LIMITS: Modifying workspaceMaxFileBytes via /api/settings immediately enforces upload limit", async () => {
  setupTestDb();
  const previousToken = config.api.token;
  config.api.token = "ws-limit-test-token";

  const { startHttpApi } = await import("../interfaces/httpApi.js");
  const { Agent } = await import("../core/agent.js");
  const { MockProvider } = await import("../llm/providers/mock.js");

  const agent = new Agent({
    llm: new MockProvider(),
    embeddings: new LocalHashingEmbeddingProvider(),
  });

  const testPort = 4102;
  const server = startHttpApi(agent, testPort);
  const headers = { authorization: "Bearer ws-limit-test-token", "content-type": "application/json" };

  try {
    // 1. Create workspace
    const wsRes = await fetch(`http://localhost:${testPort}/api/workspaces`, {
      method: "POST",
      headers,
      body: JSON.stringify({ name: "Limit Test Workspace" }),
    });
    const workspace = await wsRes.json();

    // 2. Reduce max file bytes setting to 1024 bytes (min allowed) via /api/settings
    const patchRes = await fetch(`http://localhost:${testPort}/api/settings`, {
      method: "PATCH",
      headers,
      body: JSON.stringify({ key: "projects.workspaceMaxFileBytes", value: 1024 }),
    });
    assert.equal(patchRes.status, 200);

    // 3. Upload a file of 2000 bytes -> must be rejected with 400 WORKSPACE_FILE_TOO_LARGE
    const largeContentBase64 = Buffer.from("A".repeat(2000)).toString("base64");
    const uploadRes = await fetch(`http://localhost:${testPort}/api/workspaces/${workspace.id}/files`, {
      method: "POST",
      headers,
      body: JSON.stringify({
        path: "test.txt",
        contentBase64: largeContentBase64,
      }),
    });
    assert.equal(uploadRes.status, 400);
    const uploadErr = await uploadRes.json();
    assert.equal(uploadErr.error, "WORKSPACE_FILE_TOO_LARGE");
  } finally {
    server.close();
    config.api.token = previousToken;
  }
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
