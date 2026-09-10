import { test } from "node:test";
import assert from "node:assert/strict";
import type { ChatMessage } from "../types.js";
import type { CompletionOptions, LLMProvider } from "../llm/provider.js";
import { ReplanningEngine, type ReplanningFacts } from "./replanningEngine.js";
import type { ServiceRegistry } from "../orchestration/serviceRegistry.js";

function makeSpyProvider(name: string) {
  let calls = 0;
  const provider: LLMProvider = {
    name,
    async complete(_messages: ChatMessage[], _options?: CompletionOptions) {
      calls += 1;
      // Contenu volontairement non-JSON : ce test vérifie uniquement le routage vers
      // le bon provider (setLLMProvider), pas la validation du plan produit.
      return { content: "not-a-json-plan", toolCalls: undefined };
    },
  };
  return {
    provider,
    get calls() {
      return calls;
    },
  };
}

const facts: ReplanningFacts = {
  objective: "mission",
  completed: [],
  failed: { title: "failed step", capability: "software_development", error: "boom" } as unknown as ReplanningFacts["failed"],
  affected: [],
  preservedPending: [],
  capabilities: ["software_development"],
};

test("ReplanningEngine.setLLMProvider() route les appels suivants vers le nouveau fournisseur (point 3 de l'audit)", async () => {
  const providerA = makeSpyProvider("provider-a");
  const providerB = makeSpyProvider("provider-b");
  const engine = new ReplanningEngine(providerA.provider, {} as ServiceRegistry);

  await assert.rejects(() => engine.propose(facts));
  assert.equal(providerA.calls, 1);
  assert.equal(providerB.calls, 0);

  engine.setLLMProvider(providerB.provider);

  await assert.rejects(() => engine.propose(facts));
  assert.equal(providerA.calls, 1, "l'ancien provider ne doit plus être sollicité après setLLMProvider");
  assert.equal(providerB.calls, 1, "le nouveau provider doit être utilisé après setLLMProvider");
});
