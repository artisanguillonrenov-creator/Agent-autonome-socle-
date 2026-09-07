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

test("le prompt système contient la date actuelle et les instructions d'accès Internet", async () => {
  let capturedSystemPrompt = "";

  const promptCheckProvider: LLMProvider = {
    name: "prompt_check",
    async complete(messages: ChatMessage[]) {
      const sysMsg = messages.find((m) => m.role === "system");
      if (sysMsg && sysMsg.content) capturedSystemPrompt = sysMsg.content;
      return { content: "OK" };
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

test("Native Tool Calling : flux natif web_search unique (TEST A & G)", async () => {
  let calls = 0;
  let receivedToolCallIdInSecondCall = "";

  const nativeProvider: LLMProvider = {
    name: "native_llm",
    supportsNativeTools() {
      return true;
    },
    async complete(messages: ChatMessage[], options?: CompletionOptions) {
      calls += 1;
      if (calls === 1) {
        assert.ok(options?.tools && options.tools.length > 0);
        return {
          content: null,
          toolCalls: [
            {
              id: "call_web_search_999",
              type: "function",
              function: {
                name: "web_search",
                arguments: '{"query":"films au cinema septembre 2026"}',
              },
            },
          ],
        };
      }

      const toolMsg = messages.find((m) => m.role === "tool" && m.name === "web_search");
      if (toolMsg) {
        receivedToolCallIdInSecondCall = toolMsg.toolCallId || "";
      }

      return {
        content: "Voici les films actuellement à l'affiche au cinéma : Film X, Film Y et Film Z.",
      };
    },
  };

  const agent = new Agent({ llm: nativeProvider, embeddings: new LocalHashingEmbeddingProvider() });
  for (const skill of builtinSkills) agent.skills.register(skill);

  const result = await agent.step("Regarde sur internet les films sortis au cinéma");

  assert.equal(calls, 2);
  assert.equal(result.iterations, 2);
  assert.equal(receivedToolCallIdInSecondCall, "call_web_search_999");
  assert.match(result.response, /Film X/);
  assert.equal(result.response.includes("CALL_SKILL"), false);
  assert.equal(result.response.includes("{"), false);
});

test("Native Tool Calling : flux natif multi-outils simultanés (TEST B)", async () => {
  let calls = 0;
  const toolCallIdsReceived: string[] = [];

  const multiToolProvider: LLMProvider = {
    name: "multi_native_llm",
    supportsNativeTools() {
      return true;
    },
    async complete(messages: ChatMessage[]) {
      calls += 1;
      if (calls === 1) {
        return {
          content: "Je vérifie l'heure et la liste des tâches.",
          toolCalls: [
            {
              id: "call_time_101",
              type: "function",
              function: {
                name: "get_current_time",
                arguments: "{}",
              },
            },
            {
              id: "call_tasks_102",
              type: "function",
              function: {
                name: "list_tasks",
                arguments: '{"status":"pending"}',
              },
            },
          ],
        };
      }

      const toolMsgs = messages.filter((m) => m.role === "tool");
      toolMsgs.forEach((m) => {
        if (m.toolCallId) toolCallIdsReceived.push(m.toolCallId);
      });

      return {
        content: "Voici l'heure actuelle et vous n'avez aucune tâche en attente.",
      };
    },
  };

  const agent = new Agent({ llm: multiToolProvider, embeddings: new LocalHashingEmbeddingProvider() });
  for (const skill of builtinSkills) agent.skills.register(skill);

  const result = await agent.step("Donne-moi l'heure et mes tâches");

  assert.equal(calls, 2);
  assert.equal(result.iterations, 2);
  assert.ok(toolCallIdsReceived.includes("call_time_101"));
  assert.ok(toolCallIdsReceived.includes("call_tasks_102"));
  assert.match(result.response, /heure/i);
});

test("Native Tool Calling : gestion d'arguments JSON invalides (TEST F)", async () => {
  let calls = 0;
  let receivedErrorInToolResult = false;

  const badJsonProvider: LLMProvider = {
    name: "bad_json_llm",
    supportsNativeTools() {
      return true;
    },
    async complete(messages: ChatMessage[]) {
      calls += 1;
      if (calls === 1) {
        return {
          content: null,
          toolCalls: [
            {
              id: "call_bad_json",
              type: "function",
              function: {
                name: "web_search",
                arguments: "{INVALID_JSON_PAYLOAD...",
              },
            },
          ],
        };
      }

      const toolMsg = messages.find((m) => m.role === "tool" && m.toolCallId === "call_bad_json");
      if (toolMsg && toolMsg.content?.includes("Erreur")) {
        receivedErrorInToolResult = true;
      }

      return {
        content: "Désolé, la requête de recherche contenait un format invalide.",
      };
    },
  };

  const agent = new Agent({ llm: badJsonProvider, embeddings: new LocalHashingEmbeddingProvider() });
  for (const skill of builtinSkills) agent.skills.register(skill);

  const result = await agent.step("Test bad json");

  assert.equal(calls, 2);
  assert.equal(receivedErrorInToolResult, true);
  assert.match(result.response, /Désolé/i);
});

test("Native Tool Calling : dispatch_capability natif vers ServiceOrchestrator (TEST H)", async () => {
  let calls = 0;

  const dispatchProvider: LLMProvider = {
    name: "dispatch_llm",
    supportsNativeTools() {
      return true;
    },
    async complete(messages: ChatMessage[]) {
      calls += 1;
      if (calls === 1) {
        return {
          content: null,
          toolCalls: [
            {
              id: "call_dispatch_999",
              type: "function",
              function: {
                name: "dispatch_capability",
                arguments: JSON.stringify({
                  capability: "software_development",
                  objective: "Créer une application Android de prise de notes.",
                }),
              },
            },
          ],
        };
      }

      const toolMsg = messages.find((m) => m.role === "tool" && m.name === "dispatch_capability");
      assert.ok(toolMsg);

      return {
        content: "J'ai délégué la création de l'application à la Software Factory.",
      };
    },
  };

  const agent = new Agent({ llm: dispatchProvider, embeddings: new LocalHashingEmbeddingProvider() });
  const result = await agent.step("Crée-moi une application Android de prise de notes.");

  assert.equal(calls, 2);
  assert.equal(result.iterations, 2);
  assert.match(result.response, /Software Factory/i);
  assert.equal(result.response.includes("DISPATCH_CAPABILITY"), false);
  assert.equal(result.response.includes("{"), false);
});
