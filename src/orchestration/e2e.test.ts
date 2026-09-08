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
import { config } from "../config.js";
import Database from "better-sqlite3";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ServiceEvent } from "./contract.js";

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
  const originalDbPath = config.db.path;

  beforeEach(() => {
    process.env.AGENT_DB_PATH = ":memory:";
    config.db.path = ":memory:";
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
    config.db.path = originalDbPath;
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

  test("Structured Event Log persiste uniquement les ServiceEvent valides et les restitue dans l'ordre", () => {
    const store = new OperationStore();
    store.createOperation({
      taskId: "task-event-log",
      traceId: "trace-event-log",
      idempotencyKey: "idempotency-event-log",
      objective: "Tester le journal structuré",
      capability: "software_development",
      selectedService: "software_factory",
      status: "QUEUED",
    });

    const accepted: ServiceEvent = {
      schema_version: "1.0",
      event_id: "event-log-1",
      task_id: "task-event-log",
      trace_id: "trace-event-log",
      service: "software_factory",
      sequence: 1,
      type: "TASK_ACCEPTED",
      timestamp: 1710000000001,
      payload: { message: "Tâche acceptée" },
    };
    const progress: ServiceEvent = {
      ...accepted,
      event_id: "event-log-2",
      sequence: 2,
      type: "TASK_PROGRESS",
      timestamp: 1710000000002,
      payload: { stage: "GITHUB_UPDATING_FILE", path: "src/test.ts" },
    };

    assert.deepEqual(store.processEvent(accepted), { duplicate: false, applied: true });
    assert.deepEqual(store.processEvent(progress), { duplicate: false, applied: true });
    assert.deepEqual(store.listEvents("task-event-log"), [accepted, progress]);

    assert.deepEqual(store.processEvent({ ...progress, payload: { stage: "duplicate" } }), {
      duplicate: true,
      applied: false,
    });
    assert.deepEqual(store.processEvent({ ...progress, event_id: "wrong-trace", sequence: 3, trace_id: "wrong" }), {
      duplicate: false,
      applied: false,
    });
    assert.deepEqual(store.processEvent({ ...progress, event_id: "wrong-service", sequence: 3, service: "other" }), {
      duplicate: false,
      applied: false,
    });
    assert.deepEqual(store.processEvent({ ...progress, event_id: "old-sequence", sequence: 1 }), {
      duplicate: false,
      applied: false,
    });
    assert.deepEqual(store.listEvents("task-event-log"), [accepted, progress]);
  });

  test("OperationStore refuse strictement les transitions absentes sans modifier la base", () => {
    const store = new OperationStore();
    const makeOperation = (taskId: string, status: "RUNNING" | "COMPLETED" | "REJECTED" | "WAITING_INPUT" | "FAILED", error?: string) =>
      store.createOperation({
        taskId,
        traceId: `trace-${taskId}`,
        idempotencyKey: `key-${taskId}`,
        objective: "Tester la machine d'état",
        capability: "test",
        selectedService: "test-service",
        status,
        error,
      });

    makeOperation("strict-completed", "COMPLETED");
    makeOperation("strict-rejected", "REJECTED");
    makeOperation("strict-running", "RUNNING");
    makeOperation("strict-input", "WAITING_INPUT");
    makeOperation("strict-failed", "FAILED", "Erreur fonctionnelle");

    for (const [taskId, target, original] of [
      ["strict-completed", "RUNNING", "COMPLETED"],
      ["strict-rejected", "RUNNING", "REJECTED"],
      ["strict-running", "QUEUED", "RUNNING"],
      ["strict-input", "COMPLETED", "WAITING_INPUT"],
      ["strict-failed", "DISPATCHING", "FAILED"],
    ] as const) {
      assert.equal(store.updateStatus(taskId, target), false);
      assert.equal(store.getOperation(taskId)?.status, original);
    }
  });

  test("moteur de risque contrôle LOW, MEDIUM, HIGH et CRITICAL sans double dispatch", async () => {
    let dispatches = 0;
    const adapter = new ServiceAdapter();
    adapter.dispatchTask = async (_endpoint, request) => {
      dispatches++;
      return {
        success: true,
        status: 200,
        events: [{
          schema_version: "1.0",
          event_id: `completed-${request.task_id}`,
          task_id: request.task_id,
          trace_id: request.trace_id,
          service: "risk-service",
          sequence: 1,
          type: "TASK_COMPLETED",
          timestamp: Date.now(),
          payload: { result: "ok" },
        }],
      };
    };
    const registry = new ServiceRegistry("/path/that/does/not/exist");
    registry.register({
      id: "risk-service",
      name: "Risk Service",
      enabled: true,
      endpoint: "in-process",
      capabilities: ["low", "medium", "high", "critical", "legacy"],
      priority: 1,
      riskByCapability: { low: "LOW", medium: "MEDIUM", high: "HIGH", critical: "CRITICAL" },
    });
    const orchestrator = new ServiceOrchestrator({ registry, adapter, store: new OperationStore() });

    const low = await orchestrator.dispatchCapability({ action: "DISPATCH_CAPABILITY", capability: "low", objective: "Low" });
    assert.equal(low.status, "COMPLETED");
    assert.equal(dispatches, 1);

    const legacy = await orchestrator.dispatchCapability({ action: "DISPATCH_CAPABILITY", capability: "legacy", objective: "Legacy" });
    assert.equal(legacy.status, "COMPLETED");
    assert.equal(orchestrator.store.getOperation(legacy.taskId)?.riskLevel, "LOW");
    assert.equal(dispatches, 2);

    const medium = await orchestrator.dispatchCapability({ action: "DISPATCH_CAPABILITY", capability: "medium", objective: "Medium" });
    assert.equal(medium.status, "COMPLETED");
    assert.equal(orchestrator.store.getOperation(medium.taskId)?.riskLevel, "MEDIUM");
    assert.equal(dispatches, 3);

    const high = await orchestrator.dispatchCapability({ action: "DISPATCH_CAPABILITY", capability: "high", objective: "High" });
    assert.equal(high.status, "WAITING_PERMISSION");
    assert.equal(orchestrator.store.getOperation(high.taskId)?.approvalState, "PENDING");
    assert.equal(dispatches, 3);
    const highApprovals = await Promise.allSettled([
      orchestrator.approvePendingOperation(high.taskId),
      orchestrator.approvePendingOperation(high.taskId),
    ]);
    assert.equal(highApprovals.filter((result) => result.status === "fulfilled").length, 1);
    assert.equal(dispatches, 4);

    const rejectedHigh = await orchestrator.dispatchCapability({ action: "DISPATCH_CAPABILITY", capability: "high", objective: "Reject" });
    assert.equal(orchestrator.rejectPendingOperation(rejectedHigh.taskId).status, "REJECTED");
    assert.equal(orchestrator.store.getOperation(rejectedHigh.taskId)?.approvalState, "REJECTED");
    assert.equal(dispatches, 4);

    const critical = await orchestrator.dispatchCapability({ action: "DISPATCH_CAPABILITY", capability: "critical", objective: "Critical" });
    await assert.rejects(orchestrator.approvePendingOperation(critical.taskId), /CRITICAL_CONFIRMATION_REQUIRED/);
    assert.equal(orchestrator.store.getOperation(critical.taskId)?.status, "WAITING_PERMISSION");
    await orchestrator.approvePendingOperation(critical.taskId, "APPROVE_CRITICAL");
    assert.equal(dispatches, 5);

    registry.register({
      id: "invalid-risk-service",
      name: "Invalid Risk",
      enabled: true,
      endpoint: "in-process",
      capabilities: ["invalid-risk"],
      priority: 2,
      riskByCapability: { "invalid-risk": "UNKNOWN" as never },
    });
    await assert.rejects(
      orchestrator.dispatchCapability({ action: "DISPATCH_CAPABILITY", capability: "invalid-risk", objective: "Invalid" }),
      /RISK_LEVEL_INVALID/,
    );
    assert.equal(dispatches, 5);
  });

  test("une permission émise par un service ne peut pas déclencher une fausse reprise", async () => {
    const store = new OperationStore();
    store.createOperation({
      taskId: "service-permission",
      traceId: "service-permission-trace",
      idempotencyKey: "service-permission-key",
      objective: "Permission du service",
      capability: "test",
      selectedService: "test-service",
      status: "RUNNING",
    });
    store.processEvent({
      schema_version: "1.0",
      event_id: "service-permission-event",
      task_id: "service-permission",
      trace_id: "service-permission-trace",
      service: "test-service",
      sequence: 1,
      type: "NEEDS_PERMISSION",
      timestamp: Date.now(),
      payload: { permission: "Accès requis" },
    });
    const orchestrator = new ServiceOrchestrator({ store });
    await assert.rejects(orchestrator.approvePendingOperation("service-permission"), /APPROVAL_STATE_CONFLICT/);
    assert.equal(store.getOperation("service-permission")?.status, "WAITING_PERMISSION");
  });

  test("migration de processed_service_events complète l'ancien schéma sans perdre ses lignes", () => {
    const previousPath = config.db.path;
    const directory = mkdtempSync(join(tmpdir(), "jarvis-event-log-"));
    const databasePath = join(directory, "legacy.sqlite");
    closeDb();

    try {
      const legacyDb = new Database(databasePath);
      legacyDb.exec(`
        CREATE TABLE service_operations (
          task_id TEXT PRIMARY KEY,
          trace_id TEXT NOT NULL,
          idempotency_key TEXT NOT NULL,
          objective TEXT NOT NULL,
          capability TEXT NOT NULL,
          selected_service TEXT NOT NULL,
          status TEXT NOT NULL,
          result TEXT,
          error TEXT,
          created_at INTEGER NOT NULL,
          updated_at INTEGER NOT NULL
        );
        INSERT INTO service_operations (
          task_id, trace_id, idempotency_key, objective, capability, selected_service, status, created_at, updated_at
        ) VALUES ('legacy-operation', 'legacy-trace', 'legacy-key', 'Legacy', 'legacy', 'legacy-service', 'COMPLETED', 1, 1);

        CREATE TABLE processed_service_events (
          event_id TEXT PRIMARY KEY,
          task_id TEXT NOT NULL,
          sequence INTEGER NOT NULL,
          processed_at INTEGER NOT NULL
        );
        INSERT INTO processed_service_events (event_id, task_id, sequence, processed_at)
        VALUES ('legacy-event', 'legacy-task', 1, 1700000000000);
      `);
      legacyDb.close();

      config.db.path = databasePath;
      const migratedDb = getDb();
      const columns = migratedDb.pragma("table_info(processed_service_events)") as Array<{ name: string }>;
      assert.deepEqual(
        ["schema_version", "trace_id", "service", "type", "event_timestamp", "payload_json"].filter(
          (name) => !columns.some((column) => column.name === name),
        ),
        [],
      );
      assert.equal(
        (migratedDb.prepare("SELECT COUNT(*) AS count FROM processed_service_events WHERE event_id = ?").get("legacy-event") as { count: number }).count,
        1,
      );
      const migratedStore = new OperationStore();
      assert.deepEqual(migratedStore.listEvents("legacy-task"), []);
      assert.equal(migratedStore.getOperation("legacy-operation")?.objective, "Legacy");
      assert.equal(migratedStore.getOperation("legacy-operation")?.riskLevel, "LOW");
      assert.equal(migratedStore.getOperation("legacy-operation")?.approvalState, "NOT_REQUIRED");
      migratedStore.createOperation({
        taskId: "post-migration-task",
        traceId: "post-migration-trace",
        idempotencyKey: "post-migration-key",
        objective: "Vérifier l'écriture après migration",
        capability: "software_development",
        selectedService: "software_factory",
        status: "QUEUED",
      });
      const postMigrationEvent: ServiceEvent = {
        schema_version: "1.0",
        event_id: "post-migration-event",
        task_id: "post-migration-task",
        trace_id: "post-migration-trace",
        service: "software_factory",
        sequence: 1,
        type: "TASK_ACCEPTED",
        timestamp: 1710000000003,
        payload: { message: "Persisté après migration" },
      };
      assert.deepEqual(migratedStore.processEvent(postMigrationEvent), { duplicate: false, applied: true });
      assert.deepEqual(migratedStore.listEvents("post-migration-task"), [postMigrationEvent]);
    } finally {
      closeDb();
      config.db.path = previousPath;
      rmSync(directory, { recursive: true, force: true });
      getDb();
    }
  });
});
