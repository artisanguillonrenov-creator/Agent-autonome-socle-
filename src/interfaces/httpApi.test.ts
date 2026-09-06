import { test } from "node:test";
import assert from "node:assert/strict";
import { Agent } from "../core/agent.js";
import { MockProvider } from "../llm/providers/mock.js";
import { LocalHashingEmbeddingProvider } from "../llm/embeddings.js";
import { startHttpApi } from "./httpApi.js";
import { loadLLMConfig } from "../persistence/llmConfigStore.js";

test("Jarvis Command Center API Endpoints Test", async () => {
  const agent = new Agent({
    llm: new MockProvider(),
    embeddings: new LocalHashingEmbeddingProvider(),
  });

  const port = 3000 + Math.floor(Math.random() * 5000);
  const server = startHttpApi(agent, port);
  const baseUrl = `http://localhost:${port}`;

  try {
    // Helper to fetch and assert ok status
    async function checkEndpoint(url: string, init?: RequestInit, expectedStatus = 200) {
      const res = await fetch(url, init);
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

    const otaBundle = await checkEndpoint(`${baseUrl}/api/ota/bundle`);
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
  }
});
