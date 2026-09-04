import { test } from "node:test";
import assert from "node:assert/strict";
import { ContextBudgetManager } from "./contextBudgetManager.js";

test("garde les pièces prioritaires et tronque sous contrainte de budget", () => {
  const manager = new ContextBudgetManager(20); // ~80 caractères
  const result = manager.assemble([
    { label: "Haute priorité", content: "x".repeat(50), priority: 100 },
    { label: "Basse priorité", content: "y".repeat(50), priority: 10 },
  ]);

  assert.ok(result.includes("## Haute priorité"));
  assert.ok(result.length < 200, "le résultat doit rester dans le budget approximatif");
});

test("ignore les pièces vides", () => {
  const manager = new ContextBudgetManager(1000);
  const result = manager.assemble([
    { label: "Vide", content: "   ", priority: 100 },
    { label: "Contenu", content: "quelque chose", priority: 50 },
  ]);

  assert.ok(!result.includes("## Vide"));
  assert.ok(result.includes("## Contenu"));
});
