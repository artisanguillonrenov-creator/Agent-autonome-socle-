import { test } from "node:test";
import assert from "node:assert/strict";
import type { ChatMessage } from "../types.js";
import type { CompletionOptions, LLMProvider } from "../llm/provider.js";
import { Agent } from "./agent.js";
import { LocalHashingEmbeddingProvider } from "../llm/embeddings.js";
import { closeDb, getDb } from "../persistence/db.js";
import { config } from "../config.js";
import { ActivityStore } from "../observability/activityStore.js";

function setupTestDb() {
  config.db.path = ":memory:";
  closeDb();
  getDb();
}

test("guardrail désactivé (défaut) : aucune évaluation, aucun changement de comportement", async () => {
  setupTestDb();
  let calls = 0;
  const provider: LLMProvider = {
    name: "no-guardrail",
    async complete(_messages: ChatMessage[], _options?: CompletionOptions) {
      calls += 1;
      return { content: "Réponse quelconque." };
    },
  };
  const agent = new Agent({ llm: provider, embeddings: new LocalHashingEmbeddingProvider() });
  const result = await agent.step("Question simple");
  assert.equal(calls, 1, "sans guardrail, un seul appel LLM par tour");
  assert.equal(result.response, "Réponse quelconque.");
});

test("guardrail activé : une réponse rejetée déclenche une reformulation, sans affecter le compteur d'itérations", async () => {
  setupTestDb();
  const previousEnabled = config.guardrail.enabled;
  const previousRetries = config.guardrail.maxRetries;
  config.guardrail.enabled = true;
  config.guardrail.maxRetries = 2;
  try {
    let judgeCalls = 0;
    let chatCalls = 0;
    const provider: LLMProvider = {
      name: "guardrail-integration",
      async complete(messages: ChatMessage[], _options?: CompletionOptions) {
        const systemContent = messages.find((m) => m.role === "system")?.content ?? "";
        if (systemContent.includes("garde-fou")) {
          judgeCalls += 1;
          if (judgeCalls === 1) return { content: '{"valid": false, "issues": ["Réponse incomplète"]}' };
          return { content: '{"valid": true, "issues": []}' };
        }
        chatCalls += 1;
        if (chatCalls === 1) return { content: "Réponse initiale insuffisante." };
        return { content: "Réponse corrigée et complète." };
      },
    };
    const agent = new Agent({ llm: provider, embeddings: new LocalHashingEmbeddingProvider() });
    const result = await agent.step("Explique-moi le sujet en détail");

    assert.equal(result.response, "Réponse corrigée et complète.");
    assert.equal(chatCalls, 2, "la réponse initiale rejetée doit être suivie d'une reformulation");
    assert.equal(judgeCalls, 2, "le guardrail réévalue la réponse corrigée");
    assert.equal(result.iterations, 1, "la boucle de guardrail ne doit pas consommer d'itérations de la boucle principale");

    const events = new ActivityStore().list({ eventType: "REFLECTION_FAILED" });
    assert.ok(events.length >= 1, "un rejet de guardrail doit être journalisé");
    const passed = new ActivityStore().list({ eventType: "REFLECTION_PASSED" });
    assert.ok(passed.length >= 1, "une validation de guardrail doit être journalisée");
  } finally {
    config.guardrail.enabled = previousEnabled;
    config.guardrail.maxRetries = previousRetries;
  }
});

test("guardrail activé : une réponse toujours rejetée après épuisement des relances retourne la meilleure version obtenue", async () => {
  setupTestDb();
  const previousEnabled = config.guardrail.enabled;
  const previousRetries = config.guardrail.maxRetries;
  config.guardrail.enabled = true;
  config.guardrail.maxRetries = 1;
  try {
    let chatCalls = 0;
    const provider: LLMProvider = {
      name: "guardrail-always-invalid",
      async complete(messages: ChatMessage[]) {
        const systemContent = messages.find((m) => m.role === "system")?.content ?? "";
        if (systemContent.includes("garde-fou")) return { content: '{"valid": false, "issues": ["Toujours incomplet"]}' };
        chatCalls += 1;
        return { content: `Tentative ${chatCalls}` };
      },
    };
    const agent = new Agent({ llm: provider, embeddings: new LocalHashingEmbeddingProvider() });
    const result = await agent.step("Question difficile");
    // maxRetries=1 : une unique tentative de reformulation a lieu même si le verdict
    // reste négatif après coup — le guardrail ne boucle jamais indéfiniment.
    assert.equal(result.response, "Tentative 2");
    assert.equal(chatCalls, 2);
  } finally {
    config.guardrail.enabled = previousEnabled;
    config.guardrail.maxRetries = previousRetries;
  }
});
