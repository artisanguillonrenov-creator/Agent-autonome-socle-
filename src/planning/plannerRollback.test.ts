import test from "node:test";
import assert from "node:assert/strict";
import { closeDb, getDb } from "../persistence/db.js";
import { config } from "../config.js";
import { Planner, type PlanStepSpec } from "./planner.js";
import { ServiceRegistry } from "../orchestration/serviceRegistry.js";

const step = (id: string): PlanStepSpec => ({
  local_id: id, title: id, capability: "cap", objective: `do ${id}`,
  context: {}, constraints: [], priority: "medium", depends_on: [],
});

function setup() {
  closeDb();
  config.db.path = ":memory:";
  const registry = new ServiceRegistry("/missing");
  registry.register({ id: "svc", name: "svc", enabled: true, endpoint: "local", capabilities: ["cap"], priority: 1, riskByCapability: { cap: "LOW" } });
  return { registry, planner: new Planner() };
}

// Vague 6A : versioning et rollback du plan.
test("snapshot puis rollback restaure l'état N-1 sans perdre les étapes déjà validées", () => {
  const { registry, planner } = setup();
  const run = planner.createExecutionPlan("mission", [step("a"), step("b")], registry);
  const nodes = planner.nodes(run.id);
  const a = nodes.find((n) => n.title === "a")!;
  const b = nodes.find((n) => n.title === "b")!;

  // "a" est déjà acquis au moment de l'instantané.
  getDb().prepare(`UPDATE plan_nodes SET status='done' WHERE id=?`).run(a.id);
  const snapshotId = planner.snapshot(run.id, "before risky step");
  assert.equal(planner.listSnapshots(run.id).length, 1);

  // "b" échoue de façon critique après l'instantané, avec une opération externe attachée.
  getDb().prepare(`UPDATE plan_nodes SET status='failed', error='boom', operation_task_id='task-x' WHERE id=?`).run(b.id);
  planner.updateRun(run.id, "FAILED", "boom");

  const restored = planner.rollback(run.id, snapshotId);
  assert.ok(restored);

  const afterNodes = planner.nodes(run.id);
  assert.equal(afterNodes.find((n) => n.title === "a")?.status, "done", "l'acquis avant le snapshot doit être conservé");
  const restoredB = afterNodes.find((n) => n.title === "b")!;
  assert.equal(restoredB.status, "pending", "l'étape en échec est remise en file pour un nouvel essai");
  assert.equal(restoredB.operationTaskId, undefined, "l'opération externe abandonnée n'est jamais réutilisée");
  assert.equal(restoredB.attempt, 2, "un nouvel essai porte une idempotency key inédite");

  const updatedRun = planner.getRun(run.id)!;
  assert.equal(updatedRun.status, "RUNNING");
  assert.equal(updatedRun.rollbackCount, 1);
});

test("rollback échoue proprement pour un checkpoint appartenant à un autre plan", () => {
  const { registry, planner } = setup();
  const runA = planner.createExecutionPlan("mission A", [step("a")], registry);
  const runB = planner.createExecutionPlan("mission B", [step("a")], registry);
  const snapshotId = planner.snapshot(runA.id);
  assert.equal(planner.rollback(runB.id, snapshotId), null);
});

test("rollback avec un checkpoint inconnu renvoie null sans muter le plan", () => {
  const { registry, planner } = setup();
  const run = planner.createExecutionPlan("mission", [step("a")], registry);
  assert.equal(planner.rollback(run.id, "does-not-exist"), null);
  assert.equal(planner.getRun(run.id)?.rollbackCount, 0);
});
