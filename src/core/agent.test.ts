import { test } from "node:test";
import assert from "node:assert/strict";
import type { ChatMessage } from "../types.js";
import type { CompletionOptions, LLMProvider } from "../llm/provider.js";

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

test("l'agent intercepte CALL_SKILL web_search, exécute la recherche et synthétise la réponse", async () => {
  let calls = 0;
  let receivedToolMessage = false;

  const scriptedSearchProvider: LLMProvider = {
    name: "scripted_search",
    async complete(messages: ChatMessage[], _options?: CompletionOptions) {
      calls += 1;
      if (calls === 1) {
        return JSON.stringify({
          action: "CALL_SKILL",
          skill: "web_search",
          input: { query: "actualités france" },
        });
      }
      // Second call: check if tool output was passed back
      const toolMsg = messages.find((m) => m.role === "tool" && m.name === "web_search");
      if (toolMsg) receivedToolMessage = true;

      return JSON.stringify({
        action: "RESPOND",
        response: "Voici les dernières actualités en France suite à la recherche web.",
      });
    },
  };

  const agent = new Agent({ llm: scriptedSearchProvider, embeddings: new LocalHashingEmbeddingProvider() });
  for (const skill of builtinSkills) agent.skills.register(skill);

  const result = await agent.step("Quelles sont les actualités en France ce mois-ci ?");
  assert.equal(result.iterations, 2);
  assert.equal(receivedToolMessage, true);
  assert.equal(result.response, "Voici les dernières actualités en France suite à la recherche web.");
  // Verify no raw tool_call tags or JSON syntax in response
  assert.equal(result.response.includes("CALL_SKILL"), false);
});

test("le prompt système contient la date actuelle et les instructions d'accès Internet", async () => {
  let capturedSystemPrompt = "";

  const promptCheckProvider: LLMProvider = {
    name: "prompt_check",
    async complete(messages: ChatMessage[]) {
      const sysMsg = messages.find((m) => m.role === "system");
      if (sysMsg) capturedSystemPrompt = sysMsg.content;
      return "OK";
    },
  };

  const agent = new Agent({ llm: promptCheckProvider, embeddings: new LocalHashingEmbeddingProvider() });
  await agent.step("Test date et internet");

  const isoYear = new Date().getFullYear().toString();
  assert.match(capturedSystemPrompt, new RegExp(isoYear));
  assert.match(capturedSystemPrompt, /ACCÈS INTERNET/i);
  assert.match(capturedSystemPrompt, /web_search/i);
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
