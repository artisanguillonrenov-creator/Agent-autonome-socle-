import { test, describe, before, after, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { MockServiceServer } from "../services/mockService.js";
import { Agent } from "../core/agent.js";
import { LocalHashingEmbeddingProvider } from "../llm/embeddings.js";
import type { LLMProvider } from "../llm/provider.js";
import type { ChatMessage } from "../types.js";
import { ServiceOrchestrator } from "./serviceOrchestrator.js";
import { ServiceRegistry } from "./serviceRegistry.js";
import { ServiceAdapter } from "./serviceAdapter.js";
import { OperationStore } from "./operationStore.js";
import { getDb, closeDb } from "../persistence/db.js";

import type { LLMCompletionResult } from "../llm/provider.js";

class StructuredMockLLM implements LLMProvider {
  readonly name = "structured-mock";
  public mode: "SUCCESS" | "UNKNOWN_CAPABILITY" | "MAX_ITERATIONS" = "SUCCESS";

  supportsNativeTools(): boolean {
    return true;
  }

  async complete(messages: ChatMessage[]): Promise<LLMCompletionResult> {
    const toolMsg = [...messages].reverse().find((m) => m.role === "tool");

    if (this.mode === "MAX_ITERATIONS") {
      return {
        content: null,
        toolCalls: [
          {
            id: "call_loop_1",
            type: "function",
            function: { name: "unknown_skill", arguments: "{}" },
          },
        ],
      };
    }

    if (toolMsg) {
      return {
        content: "L'application de prise de notes a été créée avec succès par la Software Factory.",
      };
    }

    if (this.mode === "UNKNOWN_CAPABILITY") {
      return {
        content: null,
        toolCalls: [
          {
            id: "call_dispatch_err",
            type: "function",
            function: {
              name: "dispatch_capability",
              arguments: JSON.stringify({
                capability: "non_existent_capability",
                objective: "Faire quelque chose d'impossible",
              }),
            },
          },
        ],
      };
    }

    // Default DISPATCH_CAPABILITY
    return {
      content: null,
      toolCalls: [
        {
          id: "call_dispatch_1",
          type: "function",
          function: {
            name: "dispatch_capability",
            arguments: JSON.stringify({
              capability: "software_development",
              objective: "Crée-moi une petite application de prise de notes.",
              context: { framework: "react" },
              constraints: ["clean code"],
            }),
          },
        },
      ],
    };
  }
}

describe("Jarvis Command Center V1 - End to End & Orchestration Tests", () => {
  let mockService: MockServiceServer;
  const mockPort = 4005;

  beforeEach(() => {
    process.env.AGENT_DB_PATH = ":memory:";
    closeDb();
    getDb();
  });

  before(async () => {
    mockService = new MockServiceServer(mockPort);
    await mockService.start();
  });

  after(async () => {
    await mockService.stop();
    closeDb();
  });

  test("SCÉNARIO E2E OBLIGATOIRE : Utilisateur demande une app de prise de notes -> Dispatch HTTP -> Succès", async () => {
    const registry = new ServiceRegistry();
    registry.register({
      id: "mock_software_factory",
      name: "Mock Software Factory",
      enabled: true,
      endpoint: `http://localhost:${mockPort}`,
      capabilities: ["software_development"],
      priority: 100,
    });

    const store = new OperationStore();
    const adapter = new ServiceAdapter();
    const orchestrator = new ServiceOrchestrator({ registry, adapter, store });

    const llm = new StructuredMockLLM();
    const embeddings = new LocalHashingEmbeddingProvider();

    const agent = new Agent({
      llm,
      embeddings,
      orchestrator,
    });

    mockService.currentBehavior = "SUCCESS";

    const res = await agent.step("Crée-moi une petite application de prise de notes.");

    assert.ok(res.response.includes("créée avec succès"), `Réponse attendue, reçu: ${res.response}`);
    assert.strictEqual(res.iterations, 2);

    const ops = store.listOperations();
    assert.ok(ops.length >= 1);
    assert.strictEqual(ops[0].capability, "software_development");
    assert.strictEqual(ops[0].status, "COMPLETED");
  });

  test("Test Service Failure : TASK_FAILED est remonté au Core", async () => {
    const registry = new ServiceRegistry();
    registry.register({
      id: "mock_software_factory",
      name: "Mock Software Factory",
      enabled: true,
      endpoint: `http://localhost:${mockPort}`,
      capabilities: ["software_development"],
      priority: 100,
    });

    const store = new OperationStore();
    const adapter = new ServiceAdapter();
    const orchestrator = new ServiceOrchestrator({ registry, adapter, store });

    mockService.currentBehavior = "FAILURE";

    const res = await orchestrator.dispatchCapability({
      action: "DISPATCH_CAPABILITY",
      capability: "software_development",
      objective: "App echouee",
    });

    assert.strictEqual(res.status, "FAILED");
    assert.ok(res.error?.includes("Échec de compilation"));
  });

  test("Test Service Rejection : TASK_REJECTED est géré proprement", async () => {
    const registry = new ServiceRegistry();
    registry.register({
      id: "mock_software_factory",
      name: "Mock Software Factory",
      enabled: true,
      endpoint: `http://localhost:${mockPort}`,
      capabilities: ["software_development"],
      priority: 100,
    });

    const store = new OperationStore();
    const adapter = new ServiceAdapter();
    const orchestrator = new ServiceOrchestrator({ registry, adapter, store });

    mockService.currentBehavior = "REJECT";

    const res = await orchestrator.dispatchCapability({
      action: "DISPATCH_CAPABILITY",
      capability: "software_development",
      objective: "App rejetée",
    });

    assert.strictEqual(res.status, "REJECTED");
    assert.ok(res.error?.includes("rejetée par le service") || res.error?.includes("Capacité indisponible") || res.error?.includes("rejetée"));
  });

  test("Test Network Timeout & Retry Idempotent", async () => {
    const registry = new ServiceRegistry();
    registry.register({
      id: "mock_software_factory",
      name: "Mock Software Factory",
      enabled: true,
      endpoint: `http://localhost:${mockPort}`,
      capabilities: ["software_development"],
      priority: 100,
    });

    const store = new OperationStore();
    const adapter = new ServiceAdapter();
    const orchestrator = new ServiceOrchestrator({ registry, adapter, store });

    mockService.currentBehavior = "TIMEOUT";

    const idempotencyKey = "key-timeout-test-123";

    // 1st call -> network timeout
    const res1 = await orchestrator.dispatchCapability(
      {
        action: "DISPATCH_CAPABILITY",
        capability: "software_development",
        objective: "Test Timeout",
      },
      { idempotencyKey },
    );

    assert.strictEqual(res1.status, "FAILED");
    assert.ok(res1.error?.includes("Network timeout") || res1.error?.includes("Transport error"));

    // 2nd call with same idempotency key returns stored operation without re-running
    const res2 = await orchestrator.dispatchCapability(
      {
        action: "DISPATCH_CAPABILITY",
        capability: "software_development",
        objective: "Test Timeout",
      },
      { idempotencyKey },
    );

    assert.strictEqual(res2.taskId, res1.taskId);
  });

  test("Test Max Iterations Guardrail avec message explicatif", async () => {
    const llm = new StructuredMockLLM();
    llm.mode = "MAX_ITERATIONS";
    const embeddings = new LocalHashingEmbeddingProvider();

    const agent = new Agent({
      llm,
      embeddings,
      maxIterations: 2,
    });

    const res = await agent.step("Fais une boucle infinie");

    assert.ok(res.response.includes("Limite maximale d'itérations (2) atteinte"));
    assert.ok(res.response.includes("Dernière étape exécutée"));
  });
});
