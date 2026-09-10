import { test } from "node:test";
import assert from "node:assert/strict";
import { Agent } from "../core/agent.js";
import { MockProvider } from "../llm/providers/mock.js";
import { LocalHashingEmbeddingProvider } from "../llm/embeddings.js";
import { startHttpApi } from "./httpApi.js";
import { loadLLMConfig } from "../persistence/llmConfigStore.js";
import { getDb } from "../persistence/db.js";
import { config } from "../config.js";
import { NotificationStore } from "../autonomy/notificationStore.js";

import fs from "node:fs";
import vm from "node:vm";

async function startTestHttpApi(agent: Agent) {
  const server = startHttpApi(agent, 0);
  if (!server.listening) {
    await new Promise<void>((resolve, reject) => {
      server.once("listening", resolve);
      server.once("error", reject);
    });
  }
  const address = server.address();
  assert.ok(address && typeof address !== "string", "le serveur doit écouter sur un port TCP système");
  return { server, baseUrl: `http://127.0.0.1:${address.port}` };
}

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

  // Verify initialization ran immediately since document.readyState !== 'loading' without throwing
  assert.equal(contextObj.window.jarvisInitialized(), true);

  // Verify calling bootstrapJarvis again is idempotent and returns without re-initializing or throwing
  assert.doesNotThrow(() => {
    contextObj.window.bootstrapJarvis();
  });
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

test("Chat UX V1 conserve des actions sûres et des interactions clavier explicites", async () => {
  const source = fs.readFileSync("./www/app.js", "utf-8");
  assert.match(source, /copyPlainText\(content\.textContent \|\| ''\)/, "la copie utilise seulement le texte de réponse");
  assert.match(source, /'speechSynthesis' in window/, "SpeechSynthesis absent est géré par détection de capacité");
  assert.match(source, /index !== responses\.length - 1/, "seule la dernière réponse peut être régénérée");
  assert.match(source, /const oldText = content\.textContent/);
  assert.match(source, /catch \{ content\.textContent = oldText/, "une erreur conserve l'ancienne réponse");
  assert.match(source, /e\.key === 'Enter' && !e\.shiftKey/, "Entrée envoie, contrairement à Maj+Entrée");
  assert.match(source, /if \(submitting\) return/, "la double soumission est bloquée");
  assert.match(source, /chat-timeline-toggle/, "la timeline existante reste dépliable");
  assert.match(source, /\{ regeneratable: false \}/, "le message d'accueil n'est pas une réponse finale");
  assert.match(source, /options\.regeneratable !== false/, "une vraie réponse Jarvis reste régénérable");

  let copied = "";
  const copyPlainText = async (text: string, navigatorRef: { clipboard?: { writeText(value: string): Promise<void> } }) => {
    if (navigatorRef.clipboard) await navigatorRef.clipboard.writeText(text);
  };
  await copyPlainText("Réponse sans boutons ni metadata", { clipboard: { writeText: async (value) => { copied = value; } } });
  assert.equal(copied, "Réponse sans boutons ni metadata");
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

test("la vue Plans rend toutes les données dynamiques par textContent", () => {
  const source=fs.readFileSync("./www/app.js","utf-8");
  const planRenderer=source.slice(source.indexOf("async function renderPlanDetails"),source.indexOf("async function renderTasksView"));
  assert.doesNotMatch(planRenderer,/innerHTML|onclick\s*=|insertAdjacentHTML/);
  assert.match(planRenderer,/objective\.textContent/);
  assert.match(planRenderer,/title\.textContent/);
  assert.match(planRenderer,/result\.textContent/);
  assert.match(planRenderer,/error\.textContent/);
  assert.match(planRenderer,/addEventListener\('click'/);
});

test("Jarvis Command Center API Endpoints Test", async () => {
  const previousToken = config.api.token;
  config.api.token = "api-endpoints-test-token";
  const agent = new Agent({
    llm: new MockProvider(),
    embeddings: new LocalHashingEmbeddingProvider(),
  });

  const { server, baseUrl } = await startTestHttpApi(agent);

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

    const cancelId=`cancel-http-${eventSuffix}`;
    agent.serviceOrchestrator.store.createOperation({taskId:cancelId,traceId:"cancel-trace",idempotencyKey:`cancel-${eventSuffix}`,objective:"Cancel",capability:"software_development",selectedService:"software_factory",status:"QUEUED",executionMode:"background"});
    const cancelled=await checkEndpoint(`${baseUrl}/api/operations/${cancelId}/cancel`,{method:"POST"});
    assert.equal(cancelled.cancelled,true);assert.equal(cancelled.operation.status,"CANCELLED");

    const notification=new NotificationStore().create({type:"REMINDER_DUE",severity:"info",title:"HTTP reminder",message:"Due"});
    assert.ok((await checkEndpoint(`${baseUrl}/api/notifications`)).some((item:{id:string})=>item.id===notification.id));
    assert.ok((await checkEndpoint(`${baseUrl}/api/notifications?unread=true`)).some((item:{id:string})=>item.id===notification.id));
    assert.ok((await checkEndpoint(`${baseUrl}/api/notifications/unread-count`)).count>=1);
    assert.equal((await checkEndpoint(`${baseUrl}/api/notifications/${notification.id}/read`,{method:"POST"})).ok,true);
    await checkEndpoint(`${baseUrl}/api/notifications/missing/read`,{method:"POST"},404);

    const schedule=await checkEndpoint(`${baseUrl}/api/schedules`,{method:"POST",headers:{"content-type":"application/json"},body:JSON.stringify({title:"HTTP schedule",taskType:"REMINDER",nextRunAt:Date.now()+60_000,repeatIntervalMs:1000})},201);
    assert.ok((await checkEndpoint(`${baseUrl}/api/schedules`)).some((item:{id:string})=>item.id===schedule.id));
    assert.equal((await checkEndpoint(`${baseUrl}/api/schedules/${schedule.id}/disable`,{method:"POST"})).ok,true);
    assert.equal((await checkEndpoint(`${baseUrl}/api/schedules/${schedule.id}/enable`,{method:"POST"})).ok,true);
    await checkEndpoint(`${baseUrl}/api/schedules`,{method:"POST",headers:{"content-type":"application/json"},body:JSON.stringify({title:"bad",taskType:"DISPATCH",nextRunAt:"tomorrow",repeatIntervalMs:0})},400);

    // A service-originated wait and an input wait must never be changed to RUNNING artificially.
    agent.serviceOrchestrator.store.updateStatus(eventTaskId, "WAITING_PERMISSION");
    await checkEndpoint(`${baseUrl}/api/operations/${eventTaskId}/respond`, {
      method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ action: "authorize" }),
    }, 409);
    assert.equal(agent.serviceOrchestrator.store.getOperation(eventTaskId)?.status, "WAITING_PERMISSION");
    await checkEndpoint(`${baseUrl}/api/operations/${eventTaskId}/respond`, {
      method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ action: "input", value: "suite" }),
    }, 409);

    const previousToken = config.api.token;
    config.api.token = "events-endpoint-token";
    try {
      const unauthorizedEvents = await fetch(`${baseUrl}/api/operations/${eventTaskId}/events`);
      assert.equal(unauthorizedEvents.status, 401);
      const unauthorizedRespond = await fetch(`${baseUrl}/api/operations/${eventTaskId}/respond`, {
        method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ action: "reject" }),
      });
      assert.equal(unauthorizedRespond.status, 401);
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

    const noResponseToRegenerate = await fetch(`${baseUrl}/api/chat/regenerate`, {
      method: "POST",
      headers: { authorization: `Bearer ${config.api.token}`, "content-type": "application/json" },
      body: "{}",
    });
    assert.equal(noResponseToRegenerate.status, 409);
    assert.deepEqual(await noResponseToRegenerate.json(), { error: "NO_REGENERATABLE_RESPONSE" });

    // Verify chat uses the updated agent model state
    const chatRes = await checkEndpoint(`${baseUrl}/api/chat`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ message: "Hello Jarvis" }),
    });
    assert.ok(chatRes.response);

    // Regeneration is a side-effect-free LLM-only path: no tools are supplied and
    // the existing operation count is unchanged.
    const operationsBeforeRegeneration = agent.serviceOrchestrator.store.listOperations().length;
    let regenerationOptions: unknown;
    agent.setLLMProvider({
      name: "regeneration-spy",
      async complete(_messages, options) {
        regenerationOptions = options;
        return { content: "Une formulation différente." };
      },
    });
    const regenerated = await checkEndpoint(`${baseUrl}/api/chat/regenerate`, { method: "POST", body: "{}" });
    assert.equal(regenerated.response, "Une formulation différente.");
    assert.deepEqual(regenerationOptions, { tools: undefined });
    assert.equal(agent.serviceOrchestrator.store.listOperations().length, operationsBeforeRegeneration);

    agent.setLLMProvider({
      name: "unexpected-tool",
      async complete() {
        return { content: null, toolCalls: [{ id: "unsafe", type: "function", function: { name: "execute_mission", arguments: "{}" } }] };
      },
    });
    const rejectedToolCall = await fetch(`${baseUrl}/api/chat/regenerate`, {
      method: "POST", headers: { authorization: `Bearer ${config.api.token}`, "content-type": "application/json" }, body: "{}",
    });
    assert.equal(rejectedToolCall.status, 500);
    assert.equal((await rejectedToolCall.json()).error, "UNEXPECTED_TOOL_CALL_DURING_REGENERATION");
    assert.equal(agent.serviceOrchestrator.store.listOperations().length, operationsBeforeRegeneration);
    agent.setLLMProvider(new MockProvider());

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
  const { server, baseUrl } = await startTestHttpApi(agent);

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
      ["/api/operations/anything/cancel", "POST"],
      ["/api/notifications", "GET"],
      ["/api/notifications?unread=true", "GET"],
      ["/api/notifications/unread-count", "GET"],
      ["/api/notifications/anything/read", "POST"],
      ["/api/schedules", "GET"],
      ["/api/schedules", "POST"],
      ["/api/schedules/anything/enable", "POST"],
      ["/api/schedules/anything/disable", "POST"],
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

test("API plans: auth, list/detail/nodes, unknown et annulation sûre", async () => {
  const previousToken=config.api.token;config.api.token="plans-token";
  const agent=new Agent({llm:new MockProvider(),embeddings:new LocalHashingEmbeddingProvider()});
  const run=agent.planner.createExecutionPlan("Mission API",[{local_id:"one",title:"One",capability:"software_development",objective:"Do one",context:{},constraints:[],priority:"medium",depends_on:[]}],agent.serviceOrchestrator.registry);
  const {server,baseUrl:base}=await startTestHttpApi(agent);
  const auth={authorization:"Bearer plans-token"};
  try {
    let response=await fetch(`${base}/api/plans`,{headers:auth});assert.equal(response.status,200);assert.ok((await response.json() as Array<{id:string}>).some(plan=>plan.id===run.id));
    response=await fetch(`${base}/api/plans/${run.id}`,{headers:auth});assert.equal(response.status,200);assert.equal((await response.json() as {id:string}).id,run.id);
    response=await fetch(`${base}/api/plans/${run.id}/nodes`,{headers:auth});assert.equal(response.status,200);assert.equal((await response.json() as unknown[]).length,1);
    response=await fetch(`${base}/api/plans/unknown`,{headers:auth});assert.equal(response.status,404);
    response=await fetch(`${base}/api/plans`,{headers:{authorization:"Bearer wrong"}});assert.equal(response.status,401);
    response=await fetch(`${base}/api/plans/${run.id}/cancel`,{method:"POST",headers:auth});assert.equal(response.status,200);assert.equal((await response.json() as {status:string}).status,"CANCELLED");
    config.api.token="";response=await fetch(`${base}/api/plans`);assert.equal(response.status,503);
  } finally {config.api.token=previousToken;await new Promise<void>(resolve=>server.close(()=>resolve()));}
});

test("API workspaces couvre CRUD, artifacts, téléchargements et validation", async () => {
  const previousToken=config.api.token;config.api.token="workspace-api-token";
  const agent=new Agent({llm:new MockProvider(),embeddings:new LocalHashingEmbeddingProvider()});
  const {server,baseUrl:base}=await startTestHttpApi(agent);
  const call=(path:string,init:RequestInit={})=>fetch(`${base}${path}`,{...init,headers:{"content-type":"application/json",authorization:`Bearer ${config.api.token}`,...init.headers}});
  try {
    assert.equal((await fetch(`${base}/api/workspaces`)).status,401);
    const created=await call("/api/workspaces",{method:"POST",body:JSON.stringify({name:"API workspace"})});assert.equal(created.status,201);const workspace=await created.json() as {id:string};
    assert.equal((await call("/api/workspaces")).status,200);assert.equal((await call(`/api/workspaces/${workspace.id}`)).status,200);assert.equal((await call("/api/workspaces/unknown")).status,404);
    const upload=await call(`/api/workspaces/${workspace.id}/files`,{method:"POST",body:JSON.stringify({path:"hello.txt",contentBase64:"aGVsbG8=",mimeType:"text/plain"})});assert.equal(upload.status,201);const uploaded=await upload.json() as {artifact:{id:string}};
    assert.equal((await call(`/api/workspaces/${workspace.id}/files`)).status,200);const content=await call(`/api/workspaces/${workspace.id}/files/content?path=hello.txt`);assert.equal(await content.text(),"hello");
    assert.equal((await call(`/api/workspaces/${workspace.id}/artifacts`)).status,200);assert.equal((await call(`/api/artifacts/${uploaded.artifact.id}`)).status,200);assert.equal(await (await call(`/api/artifacts/${uploaded.artifact.id}?download=1`)).text(),"hello");assert.equal((await call("/api/artifacts/unknown")).status,404);
    for(const path of ["../escape","/tmp/escape"])assert.equal((await call(`/api/workspaces/${workspace.id}/files`,{method:"POST",body:JSON.stringify({path,contentBase64:"eA=="})})).status,400);
    assert.equal((await call(`/api/workspaces/${workspace.id}/files`,{method:"POST",body:JSON.stringify({path:"bad",contentBase64:"not base64"})})).status,400);
    assert.equal((await call(`/api/workspaces/${workspace.id}/files?path=hello.txt`,{method:"DELETE"})).status,200);
    config.api.token="";assert.equal((await fetch(`${base}/api/workspaces`)).status,503);
  } finally {config.api.token=previousToken;await new Promise<void>(resolve=>server.close(()=>resolve()));}
});

test("Infermatic : base URL par défaut, catalogue dynamique, jamais de faux repli, aucune fuite de clé, effets de bord nuls", async () => {
  const previousToken = config.api.token;
  const previousInfermaticKey = config.llm.infermaticApiKey;
  const previousInfermaticBaseUrl = config.llm.infermaticBaseUrl;
  const previousProvider = config.llm.provider;
  const previousModel = config.llm.model;
  const originalFetch = globalThis.fetch;

  config.api.token = "infermatic-test-token";
  config.llm.provider = "mock";
  config.llm.model = "active-mock-model";

  const agent = new Agent({ llm: new MockProvider(), embeddings: new LocalHashingEmbeddingProvider() });
  const { server, baseUrl } = await startTestHttpApi(agent);
  const auth = { authorization: `Bearer ${config.api.token}` };
  const fakeKey = "sk-test-infermatic-should-never-leak";

  function mockUpstream(handler: (urlStr: string, init?: RequestInit) => Response | Promise<Response>) {
    globalThis.fetch = (async (url: unknown, init?: RequestInit) => {
      const urlStr = String(url);
      if (urlStr === `${config.llm.infermaticBaseUrl}/models` || urlStr === `${config.llm.infermaticBaseUrl}/chat/completions`) {
        return handler(urlStr, init);
      }
      return originalFetch(url as string, init);
    }) as typeof fetch;
  }

  // Modèle pleinement compatible Jarvis : répond "OK" au test conversationnel simple,
  // ET sait déclencher jarvis_compatibility_probe(value="OK") quand des tools sont fournis.
  function fullyCompatibleResponder(_urlStr: string, init?: RequestInit): Response {
    const requestBody = init?.body ? JSON.parse(init.body as string) : {};
    if (Array.isArray(requestBody.tools) && requestBody.tools.length > 0) {
      return new Response(
        JSON.stringify({
          choices: [
            {
              message: {
                content: null,
                tool_calls: [
                  {
                    id: "call_probe",
                    type: "function",
                    function: { name: "jarvis_compatibility_probe", arguments: JSON.stringify({ value: "OK" }) },
                  },
                ],
              },
            },
          ],
        }),
        { status: 200, headers: { "content-type": "application/json" } },
      );
    }
    return new Response(JSON.stringify({ choices: [{ message: { content: "OK" } }] }), {
      status: 200,
      headers: { "content-type": "application/json" },
    });
  }

  try {
    // Base URL par défaut = https://api.totalgpt.ai/v1 (point 15)
    assert.equal(previousInfermaticBaseUrl, "https://api.totalgpt.ai/v1");

    // Clé absente => erreur propre, catalogue vide (jamais les 3 anciens modèles statiques)
    config.llm.infermaticApiKey = "";
    let res = await fetch(`${baseUrl}/api/models/catalog/infermatic`, { headers: auth });
    assert.equal(res.status, 400);
    let json: any = await res.json();
    assert.equal(json.error, "INFERMATIC_KEY_MISSING");
    assert.deepEqual(json.models, []);

    config.llm.infermaticApiKey = fakeKey;

    // Catalogue dynamique : Authorization Bearer envoyé, id exact conservé, name replié sur l'id si absent
    let capturedAuth: string | null = null;
    mockUpstream((urlStr, init) => {
      capturedAuth = (init?.headers as Record<string, string> | undefined)?.authorization ?? null;
      return new Response(
        JSON.stringify({ data: [{ id: "Qwen-Qwen3.6-35B-A3B" }, { id: "some-other-model", name: "Some Other Model" }] }),
        { status: 200, headers: { "content-type": "application/json" } },
      );
    });
    res = await fetch(`${baseUrl}/api/models/catalog/infermatic`, { headers: auth });
    assert.equal(res.status, 200);
    json = await res.json();
    assert.equal(capturedAuth, `Bearer ${fakeKey}`);
    assert.deepEqual(json, [
      { id: "Qwen-Qwen3.6-35B-A3B", name: "Qwen-Qwen3.6-35B-A3B" },
      { id: "some-other-model", name: "Some Other Model" },
    ]);
    assert.ok(!JSON.stringify(json).includes(fakeKey), "la clé ne doit jamais transiter vers le frontend");

    // 401 upstream => erreur propre distincte, jamais un repli sur les anciens modèles statiques
    mockUpstream(() => new Response(JSON.stringify({ error: "unauthorized" }), { status: 401 }));
    res = await fetch(`${baseUrl}/api/models/catalog/infermatic`, { headers: auth });
    assert.equal(res.status, 502);
    json = await res.json();
    assert.equal(json.error, "INFERMATIC_CATALOG_UNAUTHORIZED");
    assert.deepEqual(json.models, []);
    for (const staleId of ["llama-3.3-70b-instruct", "mistral-large-2411", "qwen2.5-72b-instruct"]) {
      assert.ok(!JSON.stringify(json).includes(staleId), `${staleId} ne doit plus jamais apparaître`);
    }

    // Timeout réseau => erreur propre dédiée
    mockUpstream(() => {
      const err = new Error("aborted");
      err.name = "AbortError";
      throw err;
    });
    res = await fetch(`${baseUrl}/api/models/catalog/infermatic`, { headers: auth });
    assert.equal(res.status, 504);
    assert.equal((await res.json()).error, "INFERMATIC_CATALOG_TIMEOUT");

    // Panne réseau générique => catalogue indisponible, jamais de repli statique
    mockUpstream(() => {
      throw new Error("network down");
    });
    res = await fetch(`${baseUrl}/api/models/catalog/infermatic`, { headers: auth });
    assert.equal(res.status, 502);
    assert.equal((await res.json()).error, "INFERMATIC_CATALOG_UNAVAILABLE");

    // /api/models/test : un test RATÉ ne doit jamais changer le fournisseur/modèle actif
    mockUpstream(() => new Response(JSON.stringify({ error: { message: "model does not support chat" } }), { status: 400 }));
    let testRes = await fetch(`${baseUrl}/api/models/test`, {
      method: "POST",
      headers: { ...auth, "content-type": "application/json" },
      body: JSON.stringify({ provider: "infermatic", model: "Qwen-Qwen3.6-35B-A3B" }),
    });
    let testJson: any = await testRes.json();
    assert.equal(testJson.ok, false);
    assert.ok(!JSON.stringify(testJson).includes(fakeKey));
    assert.equal(config.llm.provider, "mock", "un test raté ne doit jamais changer le fournisseur actif");
    assert.equal(config.llm.model, "active-mock-model", "un test raté ne doit jamais changer le modèle actif");
    let persisted = loadLLMConfig();
    assert.ok(!persisted || persisted.provider !== "infermatic", "un test raté ne doit rien écrire dans llmConfigStore");

    // /api/models/test : un test RÉUSSI non plus ne doit pas changer le fournisseur/modèle actif tant que /select n'est pas appelé.
    // Un modèle pleinement compatible (chat + tool calling natif) doit atteindre JARVIS_TOOL_COMPATIBLE.
    mockUpstream(fullyCompatibleResponder);
    testRes = await fetch(`${baseUrl}/api/models/test`, {
      method: "POST",
      headers: { ...auth, "content-type": "application/json" },
      body: JSON.stringify({ provider: "infermatic", model: "Qwen-Qwen3.6-35B-A3B" }),
    });
    testJson = await testRes.json();
    assert.equal(testJson.ok, true);
    assert.equal(testJson.compatibility, "JARVIS_TOOL_COMPATIBLE");
    assert.ok(!JSON.stringify(testJson).includes(fakeKey));
    assert.equal(config.llm.provider, "mock");
    assert.equal(config.llm.model, "active-mock-model");

    // /api/models/test : le chat simple réussit mais le modèle ne sait pas déclencher de tool_call
    // => JARVIS_TOOL_COMPATIBLE est refusé, erreur explicite, jamais un simple succès CHAT_COMPATIBLE
    // silencieux (Jarvis fonctionne avec du tool calling natif).
    mockUpstream((urlStr, init) => {
      const requestBody = init?.body ? JSON.parse(init.body as string) : {};
      if (Array.isArray(requestBody.tools) && requestBody.tools.length > 0) {
        return new Response(JSON.stringify({ choices: [{ message: { content: "Je ne peux pas appeler d'outil." } }] }), {
          status: 200,
          headers: { "content-type": "application/json" },
        });
      }
      return new Response(JSON.stringify({ choices: [{ message: { content: "OK" } }] }), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    });
    testRes = await fetch(`${baseUrl}/api/models/test`, {
      method: "POST",
      headers: { ...auth, "content-type": "application/json" },
      body: JSON.stringify({ provider: "infermatic", model: "Qwen-Qwen3.6-35B-A3B" }),
    });
    testJson = await testRes.json();
    assert.equal(testJson.ok, false);
    assert.match(testJson.error, /INFERMATIC_NATIVE_TOOLS_UNSUPPORTED/);
    assert.equal(config.llm.provider, "mock", "un modèle non tool-compatible ne doit jamais devenir actif");
    assert.equal(config.llm.model, "active-mock-model");
    persisted = loadLLMConfig();
    assert.ok(!persisted || persisted.provider !== "infermatic");

    // /api/models/select : échec => ancien fournisseur/modèle intégralement conservé, rien persisté
    mockUpstream(() => new Response(JSON.stringify({ error: { message: "model does not support chat" } }), { status: 400 }));
    let selectRes: any = await (
      await fetch(`${baseUrl}/api/models/select`, {
        method: "POST",
        headers: { ...auth, "content-type": "application/json" },
        body: JSON.stringify({ provider: "infermatic", model: "Qwen-Qwen3.6-35B-A3B" }),
      })
    ).json();
    assert.equal(selectRes.ok, false);
    assert.equal(selectRes.activeProvider, "mock");
    assert.equal(selectRes.activeModel, "active-mock-model");
    assert.equal(config.llm.provider, "mock");
    assert.equal(config.llm.model, "active-mock-model");
    persisted = loadLLMConfig();
    assert.ok(!persisted || persisted.provider !== "infermatic");

    // /api/models/select : succès => appliqué et persisté seulement après validation réussie (atomique)
    mockUpstream(fullyCompatibleResponder);
    selectRes = await (
      await fetch(`${baseUrl}/api/models/select`, {
        method: "POST",
        headers: { ...auth, "content-type": "application/json" },
        body: JSON.stringify({ provider: "infermatic", model: "Qwen-Qwen3.6-35B-A3B" }),
      })
    ).json();
    assert.equal(selectRes.ok, true);
    assert.equal(selectRes.activeProvider, "infermatic");
    assert.equal(selectRes.activeModel, "Qwen-Qwen3.6-35B-A3B");
    assert.equal(selectRes.compatibility, "JARVIS_TOOL_COMPATIBLE");
    assert.equal(config.llm.provider, "infermatic");
    assert.equal(config.llm.model, "Qwen-Qwen3.6-35B-A3B");
    persisted = loadLLMConfig();
    assert.equal(persisted?.provider, "infermatic");
    assert.equal(persisted?.model, "Qwen-Qwen3.6-35B-A3B");

    // /api/models/select : la validation réussit mais la PERSISTANCE échoue (panne DB artificielle) =>
    // aucun état partiellement appliqué. saveLLMConfig() est appelée AVANT toute mutation en mémoire
    // (agent + config), donc un échec ici ne doit rien avoir changé : ni l'agent, ni config.llm, ni
    // le store persistant, qui doit rester sur l'état d'avant la tentative.
    {
      const activeProviderBeforeOutage = config.llm.provider;
      const activeModelBeforeOutage = config.llm.model;
      const db = getDb();
      db.exec("ALTER TABLE user_preferences RENAME TO user_preferences_test_backup");
      try {
        const persistFailRes: any = await (
          await fetch(`${baseUrl}/api/models/select`, {
            method: "POST",
            headers: { ...auth, "content-type": "application/json" },
            body: JSON.stringify({ provider: "mock", model: "other-mock-model" }),
          })
        ).json();
        assert.equal(persistFailRes.ok, false);
        assert.equal(persistFailRes.activeProvider, activeProviderBeforeOutage);
        assert.equal(persistFailRes.activeModel, activeModelBeforeOutage);
        assert.equal(
          config.llm.provider,
          activeProviderBeforeOutage,
          "une panne de persistance ne doit jamais laisser un état partiellement appliqué",
        );
        assert.equal(config.llm.model, activeModelBeforeOutage);
      } finally {
        db.exec("ALTER TABLE user_preferences_test_backup RENAME TO user_preferences");
      }
      const persistedAfterOutage = loadLLMConfig();
      assert.equal(persistedAfterOutage?.provider, activeProviderBeforeOutage, "la persistance doit rester sur l'ancien état après une panne");
      assert.equal(persistedAfterOutage?.model, activeModelBeforeOutage);
    }

    // Aucune fuite de clé dans GET /api/models
    const modelsJson = await (await fetch(`${baseUrl}/api/models`, { headers: auth })).json();
    assert.ok(!JSON.stringify(modelsJson).includes(fakeKey));
  } finally {
    globalThis.fetch = originalFetch;
    server.close();
    config.api.token = previousToken;
    config.llm.infermaticApiKey = previousInfermaticKey;
    config.llm.infermaticBaseUrl = previousInfermaticBaseUrl;
    config.llm.provider = previousProvider;
    config.llm.model = previousModel;
  }
});
