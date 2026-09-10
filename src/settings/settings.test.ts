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

test("RUNTIME BEHAVIOR: autonomy.maxIterations changes actual Agent loop limit", async () => {
  setupTestDb();
  const { Agent } = await import("../core/agent.js");
  const { MockProvider } = await import("../llm/providers/mock.js");

  let mockCalls = 0;
  class InfiniteToolLoopProvider extends MockProvider {
    async complete(messages: any[], options?: any): Promise<any> {
      mockCalls++;
      // Return a tool call that triggers another step endlessly
      return {
        content: null,
        toolCalls: [
          {
            id: `call_${mockCalls}`,
            type: "function",
            function: { name: "get_current_time", arguments: "{}" },
          },
        ],
      };
    }
  }

  const agent = new Agent({
    llm: new InfiniteToolLoopProvider(),
    embeddings: new LocalHashingEmbeddingProvider(),
  });

  const store = new SettingsStore();
  store.setSetting("autonomy.maxIterations", 3, "GLOBAL", "global");
  const { applyAllEffectiveRuntimeSettings } = await import("./applier.js");
  applyAllEffectiveRuntimeSettings(agent, store);

  assert.equal(agent.maxIterations, 3);
  const result = await agent.step("Infinite loop test");

  assert.equal(result.iterations, 3);
  assert.ok(result.response.includes("Limite maximale d'itérations (3) atteinte"));
});

test("RUNTIME BEHAVIOR: system.tokenBudget changes ContextBudgetManager truncation threshold", async () => {
  setupTestDb();
  const { ContextBudgetManager } = await import("../context/contextBudgetManager.js");
  const store = new SettingsStore();

  store.setSetting("system.tokenBudget", 1000, "GLOBAL", "global"); // 1000 tokens ≈ 4000 chars
  const { applyAllEffectiveRuntimeSettings } = await import("./applier.js");
  applyAllEffectiveRuntimeSettings({} as any, store);

  const manager = new ContextBudgetManager();
  assert.equal(manager.tokenBudget, 1000);

  const assembled = manager.assemble([
    { label: "LongPiece", content: "A".repeat(10000), priority: 100 },
  ]);

  assert.ok(assembled.includes("(tronqué)"));
  assert.ok(assembled.length < 5000);
});

test("RUNTIME BEHAVIOR: skills.reflectionEveryNSteps changes ReflectionEngine trigger threshold", async () => {
  setupTestDb();
  const { ReflectionEngine } = await import("../reflection/reflectionEngine.js");
  const { MemoryManager } = await import("../memory/memoryManager.js");
  const { MockProvider } = await import("../llm/providers/mock.js");

  let reflectCalled = false;
  class SpyLLM extends MockProvider {
    async complete(messages: any[]): Promise<any> {
      reflectCalled = true;
      return "Reflection insight";
    }
  }

  const memory = new MemoryManager(new LocalHashingEmbeddingProvider());
  memory.working.add({ role: "user", content: "Hello world" });

  const store = new SettingsStore();
  store.setSetting("skills.reflectionEveryNSteps", 2, "GLOBAL", "global");
  const { applyAllEffectiveRuntimeSettings } = await import("./applier.js");
  applyAllEffectiveRuntimeSettings({} as any, store);

  const engine = new ReflectionEngine(new SpyLLM(), memory);
  assert.equal(engine.everyNSteps, 2);

  // Step 1: threshold 2 not reached yet
  const res1 = await engine.maybeReflect();
  assert.equal(res1, null);
  assert.equal(reflectCalled, false);

  // Step 2: threshold 2 reached -> triggers reflect
  const res2 = await engine.maybeReflect();
  assert.equal(res2, "Reflection insight");
  assert.equal(reflectCalled, true);
});

test("RUNTIME BEHAVIOR: automations.backgroundMaxConcurrent changes BackgroundRunner concurrency", async () => {
  setupTestDb();
  const { BackgroundRunner } = await import("../autonomy/backgroundRunner.js");
  const { ServiceOrchestrator } = await import("../orchestration/serviceOrchestrator.js");

  const store = new SettingsStore();
  store.setSetting("automations.backgroundMaxConcurrent", 4, "GLOBAL", "global");
  const { applyAllEffectiveRuntimeSettings } = await import("./applier.js");
  applyAllEffectiveRuntimeSettings({} as any, store);

  const runner = new BackgroundRunner(new ServiceOrchestrator());
  assert.equal(runner.maxConcurrent, 4);
});

test("FACTORY SERVICE OVERRIDES: Export, reset, and import round-trip preserves undefined factory overrides and userCreated = false", async () => {
  setupTestDb();
  const previousToken = config.api.token;
  config.api.token = "roundtrip-test-token";

  const { startHttpApi } = await import("../interfaces/httpApi.js");
  const { Agent } = await import("../core/agent.js");
  const { MockProvider } = await import("../llm/providers/mock.js");

  const agent = new Agent({
    llm: new MockProvider(),
    embeddings: new LocalHashingEmbeddingProvider(),
  });

  const testPort = 4103;
  const server = startHttpApi(agent, testPort);
  const headers = { authorization: "Bearer roundtrip-test-token", "content-type": "application/json" };

  try {
    // 1. Verify all factory services return userCreated = false and DELETE returns 405
    for (const factoryId of ["software_factory", "mock_software_factory", "workspace_service", "research_service"]) {
      const svc = agent.serviceOrchestrator.registry.getServiceById(factoryId);
      if (svc) {
        assert.equal(svc.userCreated, false, `${factoryId} must have userCreated = false`);
        assert.throws(
          () => agent.serviceOrchestrator.registry.deleteService(factoryId),
          (err: any) => err.status === 405,
          `DELETE ${factoryId} must return 405`
        );
      }
    }

    // 2. Patch software_factory with ONLY enabled: false (no endpoint, priority or transport overrides)
    agent.serviceOrchestrator.registry.patchService("software_factory", { enabled: false });

    const overrideBeforeExport = agent.serviceOrchestrator.registry.connectionStore.getOverride("software_factory");
    assert.equal(overrideBeforeExport?.enabledOverride, false);
    assert.equal(overrideBeforeExport?.endpointOverride, undefined);
    assert.equal(overrideBeforeExport?.priorityOverride, undefined);

    // 3. Export settings and connection overrides via HTTP
    const exportRes = await fetch(`http://localhost:${testPort}/api/settings/export`, { headers });
    assert.equal(exportRes.status, 200);
    const exportData = await exportRes.json();

    const sfExportOverride = exportData.serviceOverrides.find((o: any) => o.serviceId === "software_factory");
    assert.ok(sfExportOverride);
    assert.equal(sfExportOverride.enabledOverride, false);
    assert.equal(sfExportOverride.endpointOverride, undefined);
    assert.equal(sfExportOverride.userCreated, false);

    // 4. Reset factory override in DB
    agent.serviceOrchestrator.registry.resetFactoryOverride("software_factory");
    assert.equal(agent.serviceOrchestrator.registry.connectionStore.getOverride("software_factory"), null);

    // 5. Import exported payload
    const importRes = await fetch(`http://localhost:${testPort}/api/settings/import`, {
      method: "POST",
      headers,
      body: JSON.stringify(exportData),
    });
    assert.equal(importRes.status, 200);

    // 6. Verify after import: enabledOverride is false, but endpointOverride/priorityOverride remain undefined!
    const overrideAfterImport = agent.serviceOrchestrator.registry.connectionStore.getOverride("software_factory");
    assert.equal(overrideAfterImport?.enabledOverride, false);
    assert.equal(overrideAfterImport?.endpointOverride, undefined);
    assert.equal(overrideAfterImport?.priorityOverride, undefined);

    const reimportedSvc = agent.serviceOrchestrator.registry.getServiceById("software_factory");
    assert.equal(reimportedSvc?.userCreated, false);
    assert.equal(reimportedSvc?.enabled, false);
    assert.ok(reimportedSvc?.endpoint.startsWith("http://localhost:"));
  } finally {
    server.close();
    config.api.token = previousToken;
  }
});

test("RISK VALIDATION: POST, PATCH, and IMPORT reject invalid riskByCapability values", async () => {
  setupTestDb();
  const previousToken = config.api.token;
  config.api.token = "risk-test-token";

  const { startHttpApi } = await import("../interfaces/httpApi.js");
  const { Agent } = await import("../core/agent.js");
  const { MockProvider } = await import("../llm/providers/mock.js");

  const agent = new Agent({
    llm: new MockProvider(),
    embeddings: new LocalHashingEmbeddingProvider(),
  });

  const testPort = 4104;
  const server = startHttpApi(agent, testPort);
  const headers = { authorization: "Bearer risk-test-token", "content-type": "application/json" };

  try {
    // 1. POST with invalid risk level
    const postRes = await fetch(`http://localhost:${testPort}/api/connections`, {
      method: "POST",
      headers,
      body: JSON.stringify({
        id: "risk_svc_post",
        name: "Risk Svc Post",
        endpoint: "http://localhost:4000",
        capabilities: ["software_development"],
        riskByCapability: { software_development: "INVALID_RISK_LEVEL" },
      }),
    });
    assert.equal(postRes.status, 400);

    // 2. PATCH with invalid risk level
    const patchRes = await fetch(`http://localhost:${testPort}/api/connections/software_factory`, {
      method: "PATCH",
      headers,
      body: JSON.stringify({
        riskByCapability: { software_development: "SUPER_CRITICAL" },
      }),
    });
    assert.equal(patchRes.status, 400);

    // 3. IMPORT with invalid risk level
    const importRes = await fetch(`http://localhost:${testPort}/api/settings/import`, {
      method: "POST",
      headers,
      body: JSON.stringify({
        schemaVersion: 1,
        serviceOverrides: [
          {
            serviceId: "software_factory",
            riskByCapabilityJson: JSON.stringify({ software_development: "BOGUS_RISK" }),
          },
        ],
      }),
    });
    assert.equal(importRes.status, 400);
    const importErr = await importRes.json();
    assert.equal(importErr.error, "SETTINGS_IMPORT_INVALID");
  } finally {
    server.close();
    config.api.token = previousToken;
  }
});

test("SETTINGS BOUNDS: automations.backgroundMaxConcurrent rejects values out of range (1..8)", () => {
  setupTestDb();
  const store = new SettingsStore();

  assert.throws(
    () => store.setSetting("automations.backgroundMaxConcurrent", 0, "GLOBAL", "global"),
    /SETTING_OUT_OF_RANGE: automations.backgroundMaxConcurrent min is 1/
  );

  assert.throws(
    () => store.setSetting("automations.backgroundMaxConcurrent", 9, "GLOBAL", "global"),
    /SETTING_OUT_OF_RANGE: automations.backgroundMaxConcurrent max is 8/
  );

  const okSetting = store.setSetting("automations.backgroundMaxConcurrent", 8, "GLOBAL", "global");
  assert.equal(okSetting.effectiveValue, 8);
});

test("LEGACY TOGGLE ENV SAFETY: /api/services/:id/toggle uses patchService and does not freeze ENV endpoint", async () => {
  setupTestDb();
  const previousToken = config.api.token;
  const previousEnvUrl = process.env.SOFTWARE_FACTORY_URL;
  config.api.token = "toggle-test-token";
  process.env.SOFTWARE_FACTORY_URL = "http://env-server.local:5000";

  const { startHttpApi } = await import("../interfaces/httpApi.js");
  const { Agent } = await import("../core/agent.js");
  const { MockProvider } = await import("../llm/providers/mock.js");

  const agent = new Agent({
    llm: new MockProvider(),
    embeddings: new LocalHashingEmbeddingProvider(),
  });

  const testPort = 4105;
  const server = startHttpApi(agent, testPort);
  const headers = { authorization: "Bearer toggle-test-token", "content-type": "application/json" };

  try {
    // 1. Legacy toggle software_factory -> enabled = false
    const toggleRes = await fetch(`http://localhost:${testPort}/api/services/software_factory/toggle`, {
      method: "POST",
      headers,
      body: JSON.stringify({ enabled: false }),
    });
    assert.equal(toggleRes.status, 200);

    const toggledSvc = agent.serviceOrchestrator.registry.getServiceById("software_factory");
    assert.equal(toggledSvc?.enabled, false);
    assert.equal(toggledSvc?.endpoint, "http://env-server.local:5000");

    // 2. Verify endpointOverride in DB remains undefined!
    const dbOverride = agent.serviceOrchestrator.registry.connectionStore.getOverride("software_factory");
    assert.equal(dbOverride?.enabledOverride, false);
    assert.equal(dbOverride?.endpointOverride, undefined); // NOT frozen in DB!

    // 3. Remove ENV variable -> endpoint reverts to factory default
    delete process.env.SOFTWARE_FACTORY_URL;
    const revertedSvc = agent.serviceOrchestrator.registry.getServiceById("software_factory");
    assert.ok(revertedSvc?.endpoint.startsWith("http://localhost:"));
  } finally {
    server.close();
    config.api.token = previousToken;
    if (previousEnvUrl) process.env.SOFTWARE_FACTORY_URL = previousEnvUrl;
    else delete process.env.SOFTWARE_FACTORY_URL;
  }
});

test("DIAGNOSTICS DO NOT ALTER SERVICE SOURCE: Testing connection records diagnostics without changing source from FACTORY or ENVIRONMENT", async () => {
  setupTestDb();
  const previousToken = config.api.token;
  const previousEnvUrl = process.env.SOFTWARE_FACTORY_URL;
  config.api.token = "diag-test-token";

  const { startHttpApi } = await import("../interfaces/httpApi.js");
  const { Agent } = await import("../core/agent.js");
  const { MockProvider } = await import("../llm/providers/mock.js");

  const agent = new Agent({
    llm: new MockProvider(),
    embeddings: new LocalHashingEmbeddingProvider(),
  });

  const testPort = 4106;
  const server = startHttpApi(agent, testPort);
  const headers = { authorization: "Bearer diag-test-token", "content-type": "application/json" };

  try {
    // 1. Factory service without override -> source FACTORY
    const initialSvc = agent.serviceOrchestrator.registry.getServiceById("software_factory");
    assert.equal(initialSvc?.source, "FACTORY");

    // 2. Run connection test POST /api/connections/software_factory/test
    await fetch(`http://localhost:${testPort}/api/connections/software_factory/test`, {
      method: "POST",
      headers,
    });

    // 3. Source remains FACTORY after test diagnostic is recorded!
    const testedSvc = agent.serviceOrchestrator.registry.getServiceById("software_factory");
    assert.equal(testedSvc?.source, "FACTORY");

    // 4. Set ENV variable -> source becomes ENVIRONMENT
    process.env.SOFTWARE_FACTORY_URL = "http://env-diag.local:5000";
    const envSvc = agent.serviceOrchestrator.registry.getServiceById("software_factory");
    assert.equal(envSvc?.source, "ENVIRONMENT");
  } finally {
    server.close();
    config.api.token = previousToken;
    if (previousEnvUrl) process.env.SOFTWARE_FACTORY_URL = previousEnvUrl;
    else delete process.env.SOFTWARE_FACTORY_URL;
  }
});

test("GENERIC FACTORY CLASSIFICATION: Custom factory service in config is automatically userCreated=false and DELETE forbidden", async () => {
  setupTestDb();
  const { writeFileSync, mkdtempSync } = await import("node:fs");
  const { tmpdir } = await import("node:os");
  const { join } = await import("node:path");

  const tempDir = mkdtempSync(join(tmpdir(), "factory-test-"));
  const customConfigPath = join(tempDir, "services.json");

  const customServices = [
    {
      id: "new_factory_service",
      name: "New 5th Factory Service",
      enabled: true,
      transport: "task_http",
      endpoint: "http://localhost:5005",
      capabilities: ["software_development"],
      priority: 50,
      auth: { type: "none" },
    },
  ];

  writeFileSync(customConfigPath, JSON.stringify(customServices));

  const registry = new ServiceRegistry(customConfigPath);
  const svc = registry.getServiceById("new_factory_service");

  assert.ok(svc);
  assert.equal(svc.userCreated, false);
  assert.equal(registry.isFactoryService("new_factory_service"), true);

  assert.throws(
    () => registry.deleteService("new_factory_service"),
    (err: any) => err.status === 405
  );
});

test("FACTORY NAME ROUNDTRIP: Factory service name override is preserved on export, cleared on reset, and restored on import", async () => {
  setupTestDb();
  const previousToken = config.api.token;
  config.api.token = "name-test-token";

  const { startHttpApi } = await import("../interfaces/httpApi.js");
  const { Agent } = await import("../core/agent.js");
  const { MockProvider } = await import("../llm/providers/mock.js");

  const agent = new Agent({
    llm: new MockProvider(),
    embeddings: new LocalHashingEmbeddingProvider(),
  });

  const testPort = 4107;
  const server = startHttpApi(agent, testPort);
  const headers = { authorization: "Bearer name-test-token", "content-type": "application/json" };

  try {
    // 1. Patch software_factory name
    const patchRes = await fetch(`http://localhost:${testPort}/api/connections/software_factory`, {
      method: "PATCH",
      headers,
      body: JSON.stringify({ name: "Software Factory Custom Name" }),
    });
    assert.equal(patchRes.status, 200);

    const patchedSvc = agent.serviceOrchestrator.registry.getServiceById("software_factory");
    assert.equal(patchedSvc?.name, "Software Factory Custom Name");

    // 2. Export settings
    const exportRes = await fetch(`http://localhost:${testPort}/api/settings/export`, { headers });
    const exportData = await exportRes.json();
    const sfOverride = exportData.serviceOverrides.find((o: any) => o.serviceId === "software_factory");
    assert.equal(sfOverride.nameOverride, "Software Factory Custom Name");

    // 3. Reset override
    await fetch(`http://localhost:${testPort}/api/connections/software_factory/reset`, {
      method: "POST",
      headers,
    });
    const resetSvc = agent.serviceOrchestrator.registry.getServiceById("software_factory");
    assert.equal(resetSvc?.name, "Software Factory Service V1");

    // 4. Import exported payload
    const importRes = await fetch(`http://localhost:${testPort}/api/settings/import`, {
      method: "POST",
      headers,
      body: JSON.stringify(exportData),
    });
    assert.equal(importRes.status, 200);

    // 5. Verify name is restored!
    const restoredSvc = agent.serviceOrchestrator.registry.getServiceById("software_factory");
    assert.equal(restoredSvc?.name, "Software Factory Custom Name");
  } finally {
    server.close();
    config.api.token = previousToken;
  }
});

test("DUPLICATE POST REJECTED: POST /api/connections rejects existing factory or user service IDs with 409", async () => {
  setupTestDb();
  const previousToken = config.api.token;
  config.api.token = "duplicate-post-token";

  const { startHttpApi } = await import("../interfaces/httpApi.js");
  const { Agent } = await import("../core/agent.js");
  const { MockProvider } = await import("../llm/providers/mock.js");

  const agent = new Agent({
    llm: new MockProvider(),
    embeddings: new LocalHashingEmbeddingProvider(),
  });

  const testPort = 4108;
  const server = startHttpApi(agent, testPort);
  const headers = { authorization: "Bearer duplicate-post-token", "content-type": "application/json" };

  try {
    // 1. Duplicate POST with existing factory service ID "software_factory" -> 409 CONNECTION_ALREADY_EXISTS
    const factoryPostRes = await fetch(`http://localhost:${testPort}/api/connections`, {
      method: "POST",
      headers,
      body: JSON.stringify({
        id: "software_factory",
        name: "Software Factory Duplicate",
        endpoint: "http://localhost:9999",
      }),
    });
    assert.equal(factoryPostRes.status, 409);
    const factoryErr = await factoryPostRes.json();
    assert.equal(factoryErr.error, "CONNECTION_ALREADY_EXISTS");

    // 2. Create user service
    const createRes = await fetch(`http://localhost:${testPort}/api/connections`, {
      method: "POST",
      headers,
      body: JSON.stringify({
        id: "my_user_service_post_test",
        name: "My User Service",
        endpoint: "http://localhost:4000",
        capabilities: ["software_development"],
      }),
    });
    assert.equal(createRes.status, 201);

    // 3. Repeat POST with same user service ID -> 409
    const repeatPostRes = await fetch(`http://localhost:${testPort}/api/connections`, {
      method: "POST",
      headers,
      body: JSON.stringify({
        id: "my_user_service_post_test",
        name: "My User Service Modified",
        endpoint: "http://localhost:5000",
      }),
    });
    assert.equal(repeatPostRes.status, 409);
    const repeatErr = await repeatPostRes.json();
    assert.equal(repeatErr.error, "CONNECTION_ALREADY_EXISTS");

    // 4. Verify original user service definition is intact
    const svc = agent.serviceOrchestrator.registry.getServiceById("my_user_service_post_test");
    assert.equal(svc?.endpoint, "http://localhost:4000");
  } finally {
    server.close();
    config.api.token = previousToken;
  }
});

test("USER SERVICE TRANSPORT RESTRICTION: User connections must use task_http transport only", async () => {
  setupTestDb();
  const previousToken = config.api.token;
  config.api.token = "transport-test-token";

  const { startHttpApi } = await import("../interfaces/httpApi.js");
  const { Agent } = await import("../core/agent.js");
  const { MockProvider } = await import("../llm/providers/mock.js");

  const agent = new Agent({
    llm: new MockProvider(),
    embeddings: new LocalHashingEmbeddingProvider(),
  });

  const testPort = 4109;
  const server = startHttpApi(agent, testPort);
  const headers = { authorization: "Bearer transport-test-token", "content-type": "application/json" };

  try {
    // 1. POST user service with local transport -> 400
    const postLocalRes = await fetch(`http://localhost:${testPort}/api/connections`, {
      method: "POST",
      headers,
      body: JSON.stringify({
        id: "user_svc_local_post",
        name: "User Service Local Post",
        transport: "local",
        capabilities: ["software_development"],
      }),
    });
    assert.equal(postLocalRes.status, 400);

    // 2. Create valid user service (task_http)
    const postHttpRes = await fetch(`http://localhost:${testPort}/api/connections`, {
      method: "POST",
      headers,
      body: JSON.stringify({
        id: "user_svc_valid_http",
        name: "User Service Valid HTTP",
        transport: "task_http",
        endpoint: "http://localhost:4000",
        capabilities: ["software_development"],
      }),
    });
    assert.equal(postHttpRes.status, 201);

    // 3. PATCH user service to local transport -> 400
    const patchLocalRes = await fetch(`http://localhost:${testPort}/api/connections/user_svc_valid_http`, {
      method: "PATCH",
      headers,
      body: JSON.stringify({ transport: "local" }),
    });
    assert.equal(patchLocalRes.status, 400);

    // 4. IMPORT user service with local transport -> 400 SETTINGS_IMPORT_INVALID
    const importLocalRes = await fetch(`http://localhost:${testPort}/api/settings/import`, {
      method: "POST",
      headers,
      body: JSON.stringify({
        schemaVersion: 1,
        serviceOverrides: [
          {
            serviceId: "user_svc_imported_local",
            name: "User Svc Imported Local",
            userCreated: true,
            transportOverride: "local",
          },
        ],
      }),
    });
    assert.equal(importLocalRes.status, 400);
    const importErr = await importLocalRes.json();
    assert.equal(importErr.error, "SETTINGS_IMPORT_INVALID");

    // 5. Verify factory service with local transport remains valid
    const sfSvc = agent.serviceOrchestrator.registry.getServiceById("software_factory");
    assert.ok(sfSvc);
  } finally {
    server.close();
    config.api.token = previousToken;
  }
});

test("NAME OVERRIDE DISTINCT FROM DIAGNOSTICS: Diagnostic health check does not create a name override nor change source", async () => {
  setupTestDb();
  const previousToken = config.api.token;
  config.api.token = "name-diag-test-token";

  const { startHttpApi } = await import("../interfaces/httpApi.js");
  const { Agent } = await import("../core/agent.js");
  const { MockProvider } = await import("../llm/providers/mock.js");

  const agent = new Agent({
    llm: new MockProvider(),
    embeddings: new LocalHashingEmbeddingProvider(),
  });

  const testPort = 4110;
  const server = startHttpApi(agent, testPort);
  const headers = { authorization: "Bearer name-diag-test-token", "content-type": "application/json" };

  try {
    // 1. Initial factory service name & source
    const initialSvc = agent.serviceOrchestrator.registry.getServiceById("software_factory");
    assert.equal(initialSvc?.name, "Software Factory Service V1");
    assert.equal(initialSvc?.source, "FACTORY");

    // 2. Perform connection health check test
    await fetch(`http://localhost:${testPort}/api/connections/software_factory/test`, {
      method: "POST",
      headers,
    });

    // 3. Export settings and connection overrides
    const exportRes = await fetch(`http://localhost:${testPort}/api/settings/export`, { headers });
    const exportData = await exportRes.json();
    const sfOverride = exportData.serviceOverrides.find((o: any) => o.serviceId === "software_factory");

    assert.equal(sfOverride?.nameOverride, undefined); // No name override created!

    // 4. Reset factory override
    await fetch(`http://localhost:${testPort}/api/connections/software_factory/reset`, {
      method: "POST",
      headers,
    });

    // 5. Import exported payload
    const importRes = await fetch(`http://localhost:${testPort}/api/settings/import`, {
      method: "POST",
      headers,
      body: JSON.stringify(exportData),
    });
    assert.equal(importRes.status, 200);

    // 6. Verify name remains "Software Factory Service V1" and source remains FACTORY
    const reimportedSvc = agent.serviceOrchestrator.registry.getServiceById("software_factory");
    assert.equal(reimportedSvc?.name, "Software Factory Service V1");
    assert.equal(reimportedSvc?.source, "FACTORY");
  } finally {
    server.close();
    config.api.token = previousToken;
  }
});

test("NAME OVERRIDE EXPLICIT RENAME: Renaming factory service sets nameOverride and source = DATABASE", async () => {
  setupTestDb();
  const previousToken = config.api.token;
  config.api.token = "rename-test-token";

  const { startHttpApi } = await import("../interfaces/httpApi.js");
  const { Agent } = await import("../core/agent.js");
  const { MockProvider } = await import("../llm/providers/mock.js");

  const agent = new Agent({
    llm: new MockProvider(),
    embeddings: new LocalHashingEmbeddingProvider(),
  });

  const testPort = 4111;
  const server = startHttpApi(agent, testPort);
  const headers = { authorization: "Bearer rename-test-token", "content-type": "application/json" };

  try {
    // 1. Rename software_factory to "Ma Factory"
    const patchRes = await fetch(`http://localhost:${testPort}/api/connections/software_factory`, {
      method: "PATCH",
      headers,
      body: JSON.stringify({ name: "Ma Factory" }),
    });
    assert.equal(patchRes.status, 200);

    const renamedSvc = agent.serviceOrchestrator.registry.getServiceById("software_factory");
    assert.equal(renamedSvc?.name, "Ma Factory");
    assert.equal(renamedSvc?.source, "DATABASE");

    // 2. Export settings
    const exportRes = await fetch(`http://localhost:${testPort}/api/settings/export`, { headers });
    const exportData = await exportRes.json();
    const sfOverride = exportData.serviceOverrides.find((o: any) => o.serviceId === "software_factory");
    assert.equal(sfOverride?.nameOverride, "Ma Factory");

    // 3. Reset factory override
    await fetch(`http://localhost:${testPort}/api/connections/software_factory/reset`, {
      method: "POST",
      headers,
    });
    const resetSvc = agent.serviceOrchestrator.registry.getServiceById("software_factory");
    assert.equal(resetSvc?.name, "Software Factory Service V1");
    assert.equal(resetSvc?.source, "FACTORY");

    // 4. Import exported payload
    const importRes = await fetch(`http://localhost:${testPort}/api/settings/import`, {
      method: "POST",
      headers,
      body: JSON.stringify(exportData),
    });
    assert.equal(importRes.status, 200);

    // 5. Verify name "Ma Factory" and source DATABASE are restored
    const reimportedSvc = agent.serviceOrchestrator.registry.getServiceById("software_factory");
    assert.equal(reimportedSvc?.name, "Ma Factory");
    assert.equal(reimportedSvc?.source, "DATABASE");
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
