import { beforeEach, test } from "node:test";
import assert from "node:assert/strict";
import { closeDb, getDb } from "../persistence/db.js";
import { config } from "../config.js";
import { OperationStore } from "./operationStore.js";
import { ServiceOrchestrator } from "./serviceOrchestrator.js";
import { ServiceRegistry } from "./serviceRegistry.js";
import type { ServiceAdapter } from "./serviceAdapter.js";
import type { ServiceEvent, TaskRequest } from "./contract.js";

beforeEach(() => { closeDb(); config.db.path = ":memory:"; getDb(); });

function harness(risk: string) {
  const registry = new ServiceRegistry("/does-not-exist");
  registry.register({ id: "test", name: "test", enabled: true, endpoint: "local", capabilities: ["cap"],
    priority: 1, riskByCapability: { cap: risk as never } });
  let dispatches = 0;
  const adapter = { dispatchTask: async (_endpoint: string, request: TaskRequest) => {
    dispatches++;
    const event = (sequence: number, type: ServiceEvent["type"]): ServiceEvent => ({ schema_version: "1.0",
      event_id: `${request.task_id}-${sequence}`, task_id: request.task_id, trace_id: request.trace_id,
      service: "test", sequence, type, timestamp: Date.now(), payload: type === "TASK_COMPLETED" ? { ok: true } : {} });
    return { success: true as const, events: [event(1, "TASK_ACCEPTED"), event(2, "TASK_COMPLETED")] };
  } } as ServiceAdapter;
  return { orchestrator: new ServiceOrchestrator({ registry, adapter }), count: () => dispatches };
}

test("machine d'état refuse toute transition absente et ne modifie pas la ligne", () => {
  const store = new OperationStore();
  store.createOperation({ taskId: "state", traceId: "t", idempotencyKey: "i", objective: "o",
    capability: "c", selectedService: "s", status: "QUEUED" });
  const before = store.getOperation("state")!;
  assert.equal(store.updateStatus("state", "COMPLETED", "interdit"), false);
  assert.deepEqual(store.getOperation("state"), before);
  assert.equal(store.updateStatus("state", "QUEUED", "autorisé"), true);
  assert.equal(store.updateStatus("state", "FAILED", undefined, "fatal"), true);
  assert.equal(store.updateStatus("state", "RUNNING"), false);
});

test("LOW et MEDIUM dispatchent, enregistrent leur risque, et une valeur invalide fail closed", async () => {
  for (const risk of ["LOW", "MEDIUM"]) {
    const h = harness(risk); const result = await h.orchestrator.dispatchCapability({ action: "DISPATCH_CAPABILITY", capability: "cap", objective: risk });
    assert.equal(result.status, "COMPLETED"); assert.equal(h.count(), 1);
    assert.equal(h.orchestrator.store.getOperation(result.taskId)?.riskLevel, risk);
  }
  const invalid = harness("DANGEROUS");
  const result = await invalid.orchestrator.dispatchCapability({ action: "DISPATCH_CAPABILITY", capability: "cap", objective: "invalid" });
  assert.equal(result.status, "REJECTED"); assert.equal(invalid.count(), 0);
});

test("HIGH attend, n'est dispatché qu'une fois après accord, ou jamais après refus", async () => {
  const h = harness("HIGH");
  const pending = await h.orchestrator.dispatchCapability({ action: "DISPATCH_CAPABILITY", capability: "cap", objective: "high" });
  assert.equal(pending.status, "WAITING_PERMISSION"); assert.equal(h.count(), 0);
  const [first, second] = await Promise.all([h.orchestrator.approvePendingOperation(pending.taskId), h.orchestrator.approvePendingOperation(pending.taskId)]);
  assert.equal(h.count(), 1); assert.equal([first, second].filter(Boolean).length, 1);
  const rejected = harness("HIGH");
  const p2 = await rejected.orchestrator.dispatchCapability({ action: "DISPATCH_CAPABILITY", capability: "cap", objective: "reject" });
  assert.equal(rejected.orchestrator.rejectPendingOperation(p2.taskId), true);
  assert.equal(rejected.count(), 0); assert.equal(rejected.orchestrator.store.getOperation(p2.taskId)?.status, "REJECTED");
});

test("une requête HIGH restaurée invalide échoue fermée sans transition ni dispatch", async () => {
  const malformedRequests = [
    "{}",
    "{json-corrompu",
    JSON.stringify({
      schema_version: "1.0", task_id: "wrong-task", trace_id: "wrong-trace", idempotency_key: "key",
      capability: "cap", objective: "high", context: {}, constraints: [], priority: "medium", permissions: [],
    }),
  ];

  for (const [index, pendingJson] of malformedRequests.entries()) {
    const h = harness("HIGH");
    const pending = await h.orchestrator.dispatchCapability(
      { action: "DISPATCH_CAPABILITY", capability: "cap", objective: `invalid-${index}` },
      { traceId: `trace-${index}`, idempotencyKey: `key-${index}` },
    );
    getDb().prepare("UPDATE service_operations SET pending_request_json = ? WHERE task_id = ?")
      .run(pendingJson, pending.taskId);

    assert.equal(await h.orchestrator.approvePendingOperation(pending.taskId), null);
    assert.equal(h.count(), 0);
    const unchanged = h.orchestrator.store.getOperation(pending.taskId)!;
    assert.equal(unchanged.status, "WAITING_PERMISSION");
    assert.equal(unchanged.approvalState, "PENDING");
    assert.equal(unchanged.approvalDecidedAt, undefined);
  }
});

test("un échec de préparation d'approbation retourne l'état sûr réel sans dispatch", async () => {
  const h = harness("HIGH");
  h.orchestrator.store.setPendingApproval = () => false;
  const result = await h.orchestrator.dispatchCapability({ action: "DISPATCH_CAPABILITY", capability: "cap", objective: "race" });
  assert.equal(result.status, "FAILED");
  assert.equal(result.error, "APPROVAL_PREPARATION_FAILED");
  assert.equal(h.count(), 0);
});

test("CRITICAL exige la chaîne de confirmation exacte", async () => {
  const h = harness("CRITICAL");
  const pending = await h.orchestrator.dispatchCapability({ action: "DISPATCH_CAPABILITY", capability: "cap", objective: "critical" });
  assert.equal(await h.orchestrator.approvePendingOperation(pending.taskId), null); assert.equal(h.count(), 0);
  assert.equal(h.orchestrator.store.getOperation(pending.taskId)?.approvalState, "PENDING");
  const approved = await h.orchestrator.approvePendingOperation(pending.taskId, "APPROVE_CRITICAL");
  assert.equal(approved?.status, "COMPLETED"); assert.equal(h.count(), 1);
});

test("les attentes émises par un service ne sont pas des approbations pre-dispatch", () => {
  const store = new OperationStore();
  for (const [id, type] of [["permission", "NEEDS_PERMISSION"], ["input", "NEEDS_INPUT"]] as const) {
    store.createOperation({ taskId: id, traceId: id, idempotencyKey: id, objective: id, capability: "c", selectedService: "s", status: "RUNNING" });
    store.processEvent({ schema_version: "1.0", event_id: `e-${id}`, task_id: id, trace_id: id, service: "s",
      sequence: 1, type, timestamp: 1, payload: {} });
    assert.equal(store.getOperation(id)?.approvalState, "NOT_REQUIRED");
  }
});

test("migration additive de service_operations conserve les lignes et ajoute les contrôles", () => {
  const columns = getDb().pragma("table_info(service_operations)") as Array<{ name: string }>;
  for (const name of ["risk_level", "approval_state", "approval_reason", "approval_requested_at", "approval_decided_at", "pending_request_json"])
    assert.ok(columns.some((column) => column.name === name));
});
