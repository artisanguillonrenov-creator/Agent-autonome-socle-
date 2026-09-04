import { test } from "node:test";
import assert from "node:assert/strict";

process.env.AGENT_DB_PATH = ":memory:";

const { TaskStore } = await import("./taskStore.js");

test("crée, liste et complète une tâche", () => {
  const store = new TaskStore();
  const task = store.create("Écrire les tests");
  assert.equal(task.status, "pending");

  assert.equal(store.list("pending").length, 1);
  assert.equal(store.list("done").length, 0);

  const ok = store.complete(task.id);
  assert.ok(ok);
  assert.equal(store.list("done").length, 1);
  assert.equal(store.list("pending").length, 0);
});

test("dueNow ne renvoie que les tâches en retard et non terminées", () => {
  const store = new TaskStore();
  const past = store.create("Tâche en retard", Date.now() - 1000);
  store.create("Tâche future", Date.now() + 1000 * 60 * 60);
  store.create("Sans échéance");

  const due = store.dueNow();
  assert.equal(due.length, 1);
  assert.equal(due[0].id, past.id);
});
