import { test } from "node:test";
import assert from "node:assert/strict";
import type { ChatMessage } from "../types.js";
import type { CompletionOptions, LLMProvider } from "../llm/provider.js";

// Base de données en mémoire, isolée par exécution : les modules qui lisent
// process.env (config, db) doivent être importés dynamiquement APRÈS ces
// affectations, sinon leurs valeurs par défaut sont déjà figées (imports ESM hissés).
process.env.AGENT_DB_PATH = ":memory:";
process.env.LLM_PROVIDER = "mock";
process.env.EMBEDDING_PROVIDER = "local";

const { Agent } = await import("./agent.js");
const { LocalHashingEmbeddingProvider } = await import("../llm/embeddings.js");
const { MockProvider } = await import("../llm/providers/mock.js");
const { builtinSkills } = await import("../skills/builtin/index.js");

test("l'agent répond à une entrée simple (fournisseur mock)", async () => {
  const agent = new Agent({ llm: new MockProvider(), embeddings: new LocalHashingEmbeddingProvider() });
  const result = await agent.step("Bonjour");
  assert.match(result.response, /mock/);
  assert.equal(result.iterations, 1);
});

test("l'agent exécute une compétence puis répond au tour suivant", async () => {
  let calls = 0;
  const scriptedProvider: LLMProvider = {
    name: "scripted",
    async complete(_messages: ChatMessage[], _options?: CompletionOptions) {
      calls += 1;
      return calls === 1 ? '<<SKILL name="get_current_time">{}</SKILL>>' : "Voici l'heure demandée.";
    },
  };

  const agent = new Agent({ llm: scriptedProvider, embeddings: new LocalHashingEmbeddingProvider() });
  for (const skill of builtinSkills) agent.skills.register(skill);

  const result = await agent.step("Quelle heure est-il ?");
  assert.equal(result.response, "Voici l'heure demandée.");
  assert.equal(result.iterations, 2);
});

test("un checkpoint restaure la mémoire de travail et le plan", async () => {
  const agent = new Agent({ llm: new MockProvider(), embeddings: new LocalHashingEmbeddingProvider() });
  await agent.step("Premier message");
  agent.planner.createNode("Objectif de test");

  const checkpointId = agent.saveCheckpoint("test");

  const fresh = new Agent({ llm: new MockProvider(), embeddings: new LocalHashingEmbeddingProvider() });
  const restored = fresh.restoreCheckpoint(checkpointId);

  assert.ok(restored);
  assert.equal(fresh.planner.all().length, 1);
  assert.ok(fresh.memory.working.all().some((m) => m.content === "Premier message"));
});
