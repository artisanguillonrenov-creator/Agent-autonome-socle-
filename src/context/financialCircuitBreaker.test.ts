import test from "node:test";
import assert from "node:assert/strict";
import { closeDb, getDb } from "../persistence/db.js";
import { config } from "../config.js";
import { FinancialCircuitBreaker, FinancialCircuitBreakerTrippedError } from "./financialCircuitBreaker.js";

function freshDb() {
  config.db.path = ":memory:";
  closeDb();
  getDb();
}

function withEnabled(fn: () => void | Promise<void>) {
  const previous = { ...config.financialCircuitBreaker };
  config.financialCircuitBreaker = { ...previous, enabled: true, hourlyLimitUsd: 1, windowMs: 60 * 60 * 1000 };
  return Promise.resolve()
    .then(fn)
    .finally(() => {
      config.financialCircuitBreaker = previous;
    });
}

test("FinancialCircuitBreaker : sous le seuil, n'affecte jamais les appels", async () => {
  await withEnabled(() => {
    freshDb();
    const breaker = new FinancialCircuitBreaker();
    breaker.record(0.1, "mock-model", "mock");
    assert.doesNotThrow(() => breaker.assertWithinBudget());
    assert.equal(breaker.isTripped(), false);
  });
});

test("FinancialCircuitBreaker : au-delà du seuil horaire, gèle et bloque tous les appels suivants jusqu'à réarmement", async () => {
  await withEnabled(() => {
    freshDb();
    const breaker = new FinancialCircuitBreaker();
    breaker.record(1.5, "mock-model", "mock");
    assert.throws(() => breaker.assertWithinBudget(), FinancialCircuitBreakerTrippedError);
    assert.equal(breaker.isTripped(), true);
    // Un appel ultérieur reste bloqué sans qu'aucun nouveau coût n'ait besoin d'être enregistré.
    assert.throws(() => breaker.assertWithinBudget(), FinancialCircuitBreakerTrippedError);

    const rearmed = breaker.rearm();
    assert.equal(rearmed.tripped, false);
    assert.doesNotThrow(() => breaker.assertWithinBudget());
  });
});

test("FinancialCircuitBreaker : reste opérationnel après un reset de connexion DB (closeDb + getDb), sans 'no such table'", async () => {
  await withEnabled(() => {
    freshDb();
    const breaker = new FinancialCircuitBreaker(); // singleton-like : construit une seule fois, avant le reset ci-dessous.
    freshDb(); // simule un test voisin qui recrée une base :memory: fraîche pendant le process.
    assert.doesNotThrow(() => breaker.record(0.1, "mock-model", "mock"));
    assert.doesNotThrow(() => breaker.assertWithinBudget());
  });
});

test("FinancialCircuitBreaker : désactivé (comportement par défaut en suite de tests), n'intervient jamais", async () => {
  freshDb();
  const previous = config.financialCircuitBreaker.enabled;
  config.financialCircuitBreaker.enabled = false;
  try {
    const breaker = new FinancialCircuitBreaker();
    breaker.record(1000, "mock-model", "mock");
    assert.doesNotThrow(() => breaker.assertWithinBudget());
    assert.equal(breaker.isTripped(), false);
  } finally {
    config.financialCircuitBreaker.enabled = previous;
  }
});
