import test from "node:test";
import assert from "node:assert/strict";
import { closeDb, getDb } from "../persistence/db.js";
import { config } from "../config.js";
import { Planner, flattenHierarchicalSteps, validatePlanSteps, type HierarchicalPlanStepSpec } from "./planner.js";
import { ServiceRegistry } from "../orchestration/serviceRegistry.js";

const leaf = (id: string, dependsOn: string[] = []): HierarchicalPlanStepSpec => ({
  local_id: id, title: id, capability: "cap", objective: `do ${id}`,
  context: {}, constraints: [], priority: "medium", depends_on: dependsOn,
});

function setup() {
  closeDb();
  config.db.path = ":memory:";
  const registry = new ServiceRegistry("/missing");
  registry.register({ id: "svc", name: "svc", enabled: true, endpoint: "local", capabilities: ["cap"], priority: 1, riskByCapability: { cap: "LOW" } });
  return { registry, planner: new Planner() };
}

test("flattenHierarchicalSteps() laisse un DAG déjà plat inchangé (comportement historique)", () => {
  const steps = [leaf("a"), leaf("b", ["a"])];
  const flat = flattenHierarchicalSteps(steps);
  assert.deepEqual(flat.map((s) => s.local_id), ["a", "b"]);
  assert.deepEqual(flat.find((s) => s.local_id === "b")?.depends_on, ["a"]);
});

test("flattenHierarchicalSteps() décompose un step composite et fait hériter ses dépendances aux enfants sans dépendance propre", () => {
  const composite: HierarchicalPlanStepSpec = {
    local_id: "gather", title: "Gather", capability: "ignored", objective: "ignored",
    context: {}, constraints: [], priority: "medium", depends_on: ["setup"],
    sub_steps: [leaf("gather.a"), leaf("gather.b", ["gather.a"])],
  };
  const flat = flattenHierarchicalSteps([leaf("setup"), composite]);
  const ids = flat.map((s) => s.local_id);
  assert.deepEqual(ids, ["setup", "gather.a", "gather.b"], "le composite lui-même n'est jamais un step exécutable");

  const a = flat.find((s) => s.local_id === "gather.a")!;
  assert.deepEqual(a.depends_on, ["setup"], "un enfant sans dépendance propre hérite des dépendances du composite parent");

  const b = flat.find((s) => s.local_id === "gather.b")!;
  assert.deepEqual(b.depends_on, ["gather.a"], "un enfant avec sa propre dépendance interne la conserve telle quelle");
});

test("flattenHierarchicalSteps() réécrit une dépendance externe vers le composite en dépendance vers la frontière de sa sous-arborescence", () => {
  const composite: HierarchicalPlanStepSpec = {
    local_id: "gather", title: "Gather", capability: "ignored", objective: "ignored",
    context: {}, constraints: [], priority: "medium", depends_on: [],
    sub_steps: [leaf("gather.a"), leaf("gather.b", ["gather.a"])],
  };
  const report = leaf("report", ["gather"]);
  const flat = flattenHierarchicalSteps([composite, report]);

  const reportFlat = flat.find((s) => s.local_id === "report")!;
  assert.deepEqual(reportFlat.depends_on, ["gather.b"], "seule la feuille terminale (frontière) de la sous-arborescence doit être requise");
});

test("flattenHierarchicalSteps() rejette une profondeur de décomposition excessive", () => {
  let deepest: HierarchicalPlanStepSpec = leaf("leaf");
  for (let i = 0; i < 5; i += 1) {
    deepest = { ...leaf(`level-${i}`), sub_steps: [deepest] };
  }
  assert.throws(() => flattenHierarchicalSteps([deepest]), /decomposition depth exceeds max/);
});

test("Planner.createExecutionPlan() persiste un plan hiérarchique comme un DAG plat de nœuds exécutables", () => {
  const { registry, planner } = setup();
  const composite: HierarchicalPlanStepSpec = {
    local_id: "gather", title: "Gather", capability: "ignored", objective: "ignored",
    context: {}, constraints: [], priority: "medium", depends_on: [],
    sub_steps: [leaf("gather.a"), leaf("gather.b", ["gather.a"])],
  };
  const run = planner.createExecutionPlan("mission", [composite, leaf("report", ["gather"])], registry);
  const nodes = planner.nodes(run.id);

  assert.equal(nodes.length, 3, "le composite ne doit jamais devenir un nœud exécutable propre");
  const byTitle = new Map(nodes.map((n) => [n.title, n]));
  assert.ok(byTitle.has("gather.a"));
  assert.ok(byTitle.has("gather.b"));
  const report = byTitle.get("report")!;
  const gatherB = byTitle.get("gather.b")!;
  assert.deepEqual(report.dependencies, [gatherB.id], "la dépendance vers le composite pointe vers le nœud réel de sa feuille terminale");
});

test("validatePlanSteps() rejette une décomposition dont l'aplatissement dépasse maxSteps", () => {
  const { registry } = setup();
  const subSteps: HierarchicalPlanStepSpec[] = Array.from({ length: 5 }, (_, i) => leaf(`sub-${i}`));
  const composite: HierarchicalPlanStepSpec = {
    local_id: "gather", title: "Gather", capability: "ignored", objective: "ignored",
    context: {}, constraints: [], priority: "medium", depends_on: [], sub_steps: subSteps,
  };
  assert.throws(
    () => validatePlanSteps([composite], registry, 3),
    /INVALID_PLAN: decomposition produces/,
  );
});
