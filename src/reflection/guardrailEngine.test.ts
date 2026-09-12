import { test } from "node:test";
import assert from "node:assert/strict";
import type { ChatMessage } from "../types.js";
import type { CompletionOptions, LLMProvider } from "../llm/provider.js";
import { GuardrailEngine } from "./guardrailEngine.js";

function providerReturning(text: string): LLMProvider {
  return {
    name: "guardrail-spy",
    async complete(_messages: ChatMessage[], _options?: CompletionOptions) {
      return { content: text, toolCalls: undefined };
    },
  };
}

test("GuardrailEngine.evaluate() reconnaît un verdict valide", async () => {
  const engine = new GuardrailEngine(providerReturning('{"valid": true, "issues": []}'));
  const verdict = await engine.evaluate("Résume l'article", "Voici le résumé.");
  assert.equal(verdict.valid, true);
  assert.deepEqual(verdict.issues, []);
});

test("GuardrailEngine.evaluate() reconnaît un verdict invalide et remonte les problèmes", async () => {
  const engine = new GuardrailEngine(providerReturning('Voici mon analyse : {"valid": false, "issues": ["Ne répond pas à la question", "Source manquante"]} Merci.'));
  const verdict = await engine.evaluate("Objectif précis", "Réponse hors-sujet");
  assert.equal(verdict.valid, false);
  assert.deepEqual(verdict.issues, ["Ne répond pas à la question", "Source manquante"]);
});

test("GuardrailEngine.evaluate() fail-open si le juge ne renvoie pas de JSON exploitable", async () => {
  const engine = new GuardrailEngine(providerReturning("Je ne sais pas répondre à cette question."));
  const verdict = await engine.evaluate("Objectif", "Résultat");
  assert.equal(verdict.valid, true, "un verdict non parsable ne doit jamais bloquer l'agent");
});

test("GuardrailEngine.evaluate() fail-open si le provider LLM échoue", async () => {
  const failing: LLMProvider = {
    name: "failing",
    async complete() {
      throw new Error("NETWORK_DOWN");
    },
  };
  const engine = new GuardrailEngine(failing);
  const verdict = await engine.evaluate("Objectif", "Résultat");
  assert.equal(verdict.valid, true, "une panne du juge ne doit jamais bloquer l'agent");
});

test("GuardrailEngine.setLLMProvider() route les évaluations suivantes vers le nouveau fournisseur", async () => {
  let usedName = "";
  const providerA: LLMProvider = {
    name: "a",
    async complete() {
      usedName = "a";
      return { content: '{"valid":true,"issues":[]}' };
    },
  };
  const providerB: LLMProvider = {
    name: "b",
    async complete() {
      usedName = "b";
      return { content: '{"valid":true,"issues":[]}' };
    },
  };
  const engine = new GuardrailEngine(providerA);
  await engine.evaluate("obj", "res");
  assert.equal(usedName, "a");
  engine.setLLMProvider(providerB);
  await engine.evaluate("obj", "res");
  assert.equal(usedName, "b");
});
