import { test } from "node:test";
import assert from "node:assert/strict";
import type { ChatMessage } from "../types.js";
import type { CompletionOptions, LLMProvider } from "../llm/provider.js";
import { ReflectionEngine } from "./reflectionEngine.js";
import { MemoryManager } from "../memory/memoryManager.js";
import { LocalHashingEmbeddingProvider } from "../llm/embeddings.js";

function makeSpyProvider(name: string, reply: string) {
  let calls = 0;
  const provider: LLMProvider = {
    name,
    async complete(_messages: ChatMessage[], _options?: CompletionOptions) {
      calls += 1;
      return { content: reply, toolCalls: undefined };
    },
  };
  return {
    provider,
    get calls() {
      return calls;
    },
  };
}

test("ReflectionEngine.setLLMProvider() route reflect() vers le nouveau fournisseur (point 3 de l'audit)", async () => {
  const memory = new MemoryManager(new LocalHashingEmbeddingProvider());
  await memory.recordTurn({ role: "user", content: "Le ciel est bleu aujourd'hui." });
  await memory.recordTurn({ role: "assistant", content: "Oui, il fait beau." });

  const providerA = makeSpyProvider("provider-a", "[A] insight");
  const providerB = makeSpyProvider("provider-b", "[B] insight");

  const engine = new ReflectionEngine(providerA.provider, memory, 1);

  const firstInsight = await engine.reflect();
  assert.equal(firstInsight, "[A] insight");
  assert.equal(providerA.calls, 1);
  assert.equal(providerB.calls, 0);

  engine.setLLMProvider(providerB.provider);

  const secondInsight = await engine.reflect();
  assert.equal(secondInsight, "[B] insight");
  assert.equal(providerA.calls, 1, "l'ancien provider ne doit plus être sollicité après setLLMProvider");
  assert.equal(providerB.calls, 1, "le nouveau provider doit être utilisé après setLLMProvider");
});
