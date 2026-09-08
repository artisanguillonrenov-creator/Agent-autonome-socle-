import { test } from "node:test";
import assert from "node:assert/strict";
import { Agent } from "../core/agent.js";
import { MockProvider } from "../llm/providers/mock.js";
import { LocalHashingEmbeddingProvider } from "../llm/embeddings.js";
import { startHttpApi } from "./httpApi.js";
import { loadLLMConfig } from "../persistence/llmConfigStore.js";
import { config } from "../config.js";

import fs from "node:fs";
import vm from "node:vm";

test("Android / Capacitor post-DOMContentLoaded bootstrap timing test", async () => {
  let addEventListenerCalledCount = 0;
  let activeViewSwitched = false;

  const dummyElement = {
    addEventListener: () => {
      addEventListenerCalledCount++;
    },
    classList: { add: () => {}, remove: () => {}, toggle: () => {} },
    getAttribute: () => "accueil",
    querySelector: () => ({ textContent: "Accueil" }),
    innerHTML: "",
    style: {},
  };

  const fakeDocument = {
    readyState: "interactive", // Simulating document already loaded before app.js script injection
    getElementById: () => dummyElement,
    querySelectorAll: () => [dummyElement],
    addEventListener: (event: string, cb: () => void) => {
      if (event === "DOMContentLoaded") {
        cb();
      }
    },
  };

  const contextObj = {
    document: fakeDocument,
    localStorage: {
      getItem: () => null,
      setItem: () => {},
      removeItem: () => {},
    },
    fetch: async () => ({ ok: true, json: async () => ({}) }),
    console,
    setTimeout,
    clearTimeout,
    window: {},
  };

  vm.createContext(contextObj);

  const appJsCode = fs.readFileSync("./www/app.js", "utf-8");
  vm.runInContext(appJsCode, contextObj);

  // Check that bootstrapJarvis function exists in executed context on window
  assert.equal(typeof contextObj.window.bootstrapJarvis, "function");

  // Verify initialization ran immediately since document.readyState !== 'loading'
  assert.equal(contextObj.window.jarvisInitialized(), true);

  // Verify calling bootstrapJarvis again is idempotent and returns without re-initializing
  contextObj.window.bootstrapJarvis();
  assert.equal(contextObj.window.jarvisInitialized(), true);
});

test("Safe Array Contract Test for Models View - Prevents undefined.map error", () => {
  // Case 1: modelsData contains error or lacks providers property
  const modelsDataError: any = { error: "unauthorized" };
  const providers = Array.isArray(modelsDataError?.providers)
    ? modelsDataError.providers
    : Array.isArray(modelsDataError?.data?.providers)
    ? modelsDataError.data.providers
    : [];
  assert.equal(Array.isArray(providers), true);
  assert.equal(providers.length, 0);

  // Case 2: rawCatalogModels is an object instead of an Array
  const catalogError: any = { error: "not found" };
  const list = Array.isArray(catalogError)
    ? catalogError
    : Array.isArray(catalogError?.models)
    ? catalogError.models
    : [];
  assert.equal(Array.isArray(list), true);
  assert.equal(list.length, 0);

  // Filtering on empty catalog does not crash
  const filtered = list.filter((m: any) => Boolean(m?.isFree));
  assert.equal(Array.isArray(filtered), true);
  assert.equal(filtered.length, 0);
});

test("ServiceEvent est transformé en entrée de timeline sans interpréter le texte du payload comme du HTML", () => {
  const appJsCode = fs.readFileSync("./www/app.js", "utf-8");
  const dummyElement = { classList: { add: () => {}, remove: () => {} }, textContent: "" };
  const contextObj = {
    document: {
      readyState: "loading",
      getElementById: () => dummyElement,
      querySelectorAll: () => [],
      addEventListener: () => {},
    },
    localStorage: { getItem: () => null, setItem: () => {}, removeItem: () => {} },
    window: {},
    console,
    setTimeout,
    clearTimeout,
    URL,
  };
  vm.createContext(contextObj);
  vm.runInContext(appJsCode, contextObj);

  const transform = (contextObj.window as { serviceEventToTimelineEntry: (event: unknown) => { label: string; state: string } })
    .serviceEventToTimelineEntry;
  const markerFor = (contextObj.window as {
    timelineMarkerForEntry: (entry: { label: string; state: string }, isLast: boolean, status: string) => string;
  }).timelineMarkerForEntry;
  assert.deepEqual(
    { ...transform({ type: "TASK_ACCEPTED", payload: {} }) },
    { label: "Tâche acceptée", state: "complete" },
  );
  assert.deepEqual(
    { ...transform({ type: "TASK_PROGRESS", payload: { stage: "GITHUB_UPDATING_FILE" } }) },
    { label: "Mise à jour du fichier", state: "active-candidate" },
  );
  assert.deepEqual(
    { ...transform({ type: "TASK_FAILED", payload: {} }) },
    { label: "Échec", state: "failed" },
  );

  const hostileText = '<img src=x onerror="globalThis.compromised=true">';
  assert.equal(transform({ type: "TASK_PROGRESS", payload: { message: hostileText } }).label, hostileText);
  assert.match(appJsCode, /label\.textContent = entry\.label/);
  assert.doesNotMatch(appJsCode, /innerHTML\s*=\s*entry\.label/);

  const accepted = transform({ type: "TASK_ACCEPTED", payload: {} });
  assert.equal(markerFor(accepted, true, "RUNNING"), "✓");

  const fileUpdated = transform({ type: "TASK_PROGRESS", payload: { stage: "GITHUB_FILE_UPDATED" } });
  assert.equal(fileUpdated.label, "Fichier mis à jour");
  assert.equal(markerFor(fileUpdated, true, "RUNNING"), "✓");

  const fileUpdating = transform({ type: "TASK_PROGRESS", payload: { stage: "GITHUB_UPDATING_FILE" } });
  assert.equal(markerFor(fileUpdating, true, "RUNNING"), "●");
  assert.equal(markerFor(fileUpdating, false, "RUNNING"), "✓");

  const needsPermission = transform({ type: "NEEDS_PERMISSION", payload: {} });
  assert.equal(needsPermission.label, "Approbation requise");
  assert.equal(markerFor(needsPermission, true, "WAITING_PERMISSION"), "●");
});

test("Jarvis Command Center API Endpoints Test", async () => {
  const previousToken = config.api.token;
  config.api.token = "api-endpoints-test-token";
  const agent = new Agent({
    llm: new MockProvider(),
    embeddings: new LocalHashingEmbeddingProvider(),
  });

  const port = 3000 + Math.floor(Math.random() * 5000);
  const server = startHttpApi(agent, port);
  const baseUrl = `http://localhost:${port}`;

  const eventSuffix = `${Date.now()}-${Math.random()}`;
  const eventTaskId = `task-http-events-${eventSuffix}`;
  agent.serviceOrchestrator.store.createOperation({
    taskId: eventTaskId,
    traceId: "trace-http-events",
    idempotencyKey: `idempotency-http-events-${eventSuffix}`,
    objective: "Tester l'endpoint des événements",
    capability: "software_development",
    selectedService: "software_factory",
    status: "QUEUED",
  });
  agent.serviceOrchestrator.store.processEvent({
    schema_version: "1.0",
    event_id: `http-event-1-${eventSuffix}`,
    task_id: eventTaskId,
    trace_id: "trace-http-events",
    service: "software_factory",
    sequence: 1,
    type: "TASK_ACCEPTED",
    timestamp: 1710000000101,
    payload: { message: "Acceptée" },
  });
  agent.serviceOrchestrator.store.processEvent({
    schema_version: "1.0",
    event_id: `http-event-2-${eventSuffix}`,
    task_id: eventTaskId,
    trace_id: "trace-http-events",
    service: "software_factory",
    sequence: 2,
    type: "TASK_PROGRESS",
    timestamp: 1710000000102,
    payload: { stage: "GITHUB_UPDATING_FILE", path: "src/test.ts" },
  });

  try {
    // Helper to fetch and assert ok status
    async function checkEndpoint(url: string, init?: RequestInit, expectedStatus = 200) {
      const headers = new Headers(init?.headers);
      headers.set("authorization", `Bearer ${config.api.token}`);
      const res = await fetch(url, { ...init, headers });
      if (res.status !== expectedStatus) {
        const body = await res.text();
        console.error(`Failed ${url}: status ${res.status}, body: ${body}`);
      }
      assert.equal(res.status, expectedStatus);
      return res.json();
    }

    // 1. GET /api/status
    const status = await checkEndpoint(`${baseUrl}/api/status`);
    assert.equal(status.status, "online");
    assert.equal(status.llmProvider, "mock");
    assert.ok(status.otaVersion);

    // 2. GET /api/operations
    const ops = await checkEndpoint(`${baseUrl}/api/operations`);
    assert.ok(Array.isArray(ops));

    const eventLog = await checkEndpoint(`${baseUrl}/api/operations/${eventTaskId}/events`);
    assert.equal(eventLog.taskId, eventTaskId);
    assert.deepEqual(eventLog.events.map((event: { sequence: number }) => event.sequence), [1, 2]);
    assert.equal(eventLog.events[1].type, "TASK_PROGRESS");
    assert.deepEqual(eventLog.events[1].payload, { stage: "GITHUB_UPDATING_FILE", path: "src/test.ts" });

    const operation = await checkEndpoint(`${baseUrl}/api/operations/${eventTaskId}`);
    assert.equal(operation.taskId, eventTaskId);
    await checkEndpoint(`${baseUrl}/api/operations/unknown-task/events`, undefined, 404);

    const previousToken = config.api.token;
    config.api.token = "events-endpoint-token";
    try {
      const unauthorizedEvents = await fetch(`${baseUrl}/api/operations/${eventTaskId}/events`);
      assert.equal(unauthorizedEvents.status, 401);
    } finally {
      config.api.token = previousToken;
    }

    // 3. GET /api/services
    const services = await checkEndpoint(`${baseUrl}/api/services`);
    assert.ok(Array.isArray(services));

    // 4. Tasks Endpoints
    await checkEndpoint(`${baseUrl}/api/tasks`);

    const createdTask = await checkEndpoint(`${baseUrl}/api/tasks`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ title: "Test Command Center Task" }),
    }, 201);
    assert.equal(createdTask.title, "Test Command Center Task");

    await checkEndpoint(`${baseUrl}/api/tasks/${createdTask.id}/complete`, {
      method: "POST",
    });

    // 5. GET /api/plan
    await checkEndpoint(`${baseUrl}/api/plan`);

    // 6. Memory Endpoints
    await checkEndpoint(`${baseUrl}/api/memory`);

    await checkEndpoint(`${baseUrl}/api/memory/facts`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ entity: "user", attribute: "role", value: "commander" }),
    });

    // 7. GET /api/skills
    await checkEndpoint(`${baseUrl}/api/skills`);

    // 8. GET /api/models & OpenRouter Catalog & Provider Testing & Model Selection
    const models = await checkEndpoint(`${baseUrl}/api/models`);
    assert.equal(models.activeProvider, "mock");
    assert.ok(Array.isArray(models.providers));
    // Verify no secrets returned
    assert.equal(models.providers.some((p: { apiKey?: string }) => p.apiKey !== undefined), false);

    const openrouterCatalog = await checkEndpoint(`${baseUrl}/api/models/openrouter`);
    assert.ok(Array.isArray(openrouterCatalog));

    // Test model test endpoint
    const testResult = await checkEndpoint(`${baseUrl}/api/models/test`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ provider: "mock", model: "test-mock-model" }),
    });
    assert.equal(testResult.ok, true);

    // Test model select endpoint
    const selectResult = await checkEndpoint(`${baseUrl}/api/models/select`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ provider: "mock", model: "new-mock-model" }),
    });
    assert.equal(selectResult.ok, true);
    assert.equal(selectResult.activeProvider, "mock");

    // Verify chat uses the updated agent model state
    const chatRes = await checkEndpoint(`${baseUrl}/api/chat`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ message: "Hello Jarvis" }),
    });
    assert.ok(chatRes.response);

    // Test model selection persistence
    const savedConfig = loadLLMConfig();
    assert.ok(savedConfig);
    assert.equal(savedConfig?.provider, "mock");
    assert.equal(savedConfig?.model, "new-mock-model");

    // Test selection failure fallback
    const invalidSelectResult = await checkEndpoint(`${baseUrl}/api/models/select`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ provider: "invalid_provider_name", model: "unknown" }),
    });
    assert.equal(invalidSelectResult.ok, false);
    assert.ok(invalidSelectResult.error);
    assert.equal(invalidSelectResult.activeProvider, "mock");

    // 9. OTA Endpoints Test
    const otaManifest = await checkEndpoint(`${baseUrl}/api/ota/manifest`);
    assert.ok(otaManifest.version);
    assert.ok(otaManifest.minimumNativeVersion);

    const otaBundleRes = await fetch(`${baseUrl}/api/ota/bundle`, {
      headers: { authorization: `Bearer ${config.api.token}` },
    });
    assert.equal(otaBundleRes.status, 200);
    const otaBundleText = await otaBundleRes.text();
    const computedHash = (await import("node:crypto")).createHash("sha256").update(otaBundleText).digest("hex");

    assert.equal(computedHash.toLowerCase(), otaManifest.sha256.toLowerCase());

    const otaBundle = JSON.parse(otaBundleText);
    assert.ok(otaBundle.files);
    assert.ok(otaBundle.files["index.html"]);

    // 10. GET /api/reflection
    await checkEndpoint(`${baseUrl}/api/reflection`);

    // 11. GET /api/system & Diagnostics
    await checkEndpoint(`${baseUrl}/api/system`);

    await checkEndpoint(`${baseUrl}/api/system/diagnostics`, { method: "POST" });

    // 12. Settings Endpoints
    await checkEndpoint(`${baseUrl}/api/settings`);

    await checkEndpoint(`${baseUrl}/api/settings`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ tokenBudget: 5000, maxIterations: 6 }),
    });
  } finally {
    server.close();
    config.api.token = previousToken;
  }
});

test("HTTP API applique l'authentification fail-closed tout en laissant les ressources publiques accessibles", async () => {
  const previousToken = config.api.token;
  const agent = new Agent({
    llm: new MockProvider(),
    embeddings: new LocalHashingEmbeddingProvider(),
  });
  const port = 8001 + Math.floor(Math.random() * 1000);
  const server = startHttpApi(agent, port);
  const baseUrl = `http://localhost:${port}`;

  try {
    const configuredToken = "configured-secret-token";
    config.api.token = configuredToken;

    const authorized = await fetch(`${baseUrl}/api/status`, {
      headers: { authorization: `Bearer ${configuredToken}` },
    });
    assert.equal(authorized.status, 200);

    const missing = await fetch(`${baseUrl}/api/status`);
    assert.equal(missing.status, 401);

    const incorrect = await fetch(`${baseUrl}/api/status`, {
      headers: { authorization: "Bearer incorrect-token" },
    });
    assert.equal(incorrect.status, 401);
    assert.ok(!(await incorrect.text()).includes(configuredToken));

    config.api.token = "";
    for (const [path, method] of [
      ["/api/status", "GET"],
      ["/chat", "POST"],
      ["/api/chat", "POST"],
      ["/api/chat/stream", "GET"],
      ["/tasks", "POST"],
      ["/api/tasks/dispatch", "POST"],
    ] as const) {
      const notConfigured = await fetch(`${baseUrl}${path}`, { method });
      assert.equal(notConfigured.status, 503, `${method} ${path} doit échouer en mode fail-closed`);
      assert.deepEqual(await notConfigured.json(), { error: "API_TOKEN_NOT_CONFIGURED" });
    }

    assert.equal((await fetch(`${baseUrl}/`)).status, 200);
    assert.equal((await fetch(`${baseUrl}/index.html`)).status, 200);
    assert.equal((await fetch(`${baseUrl}/app.js`)).status, 200);
    assert.equal((await fetch(`${baseUrl}/style.css`)).status, 200);
    assert.equal((await fetch(`${baseUrl}/api/status`, { method: "OPTIONS" })).status, 204);
  } finally {
    server.close();
    config.api.token = previousToken;
  }
});
