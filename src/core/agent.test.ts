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

test("PROTOCOLE NATIF — TEST 1 : Un tool call complet se termine proprement", async () => {
  let calls = 0;

  const mockLLM: LLMProvider = {
    name: "test1_llm",
    supportsNativeTools: () => true,
    async complete() {
      calls++;
      if (calls === 1) {
        return {
          content: null,
          toolCalls: [
            {
              id: "call_dispatch_1",
              type: "function",
              function: {
                name: "dispatch_capability",
                arguments: JSON.stringify({ capability: "software_development", objective: "App test" }),
              },
            },
          ],
        };
      }
      return { content: "TERMINÉ" };
    },
  };

  const agent = new Agent({ llm: mockLLM, embeddings: new LocalHashingEmbeddingProvider() });
  const res = await agent.step("Test 1 tool call");

  assert.equal(calls, 2);
  assert.equal(res.response, "TERMINÉ");
});

test("PROTOCOLE NATIF — TEST 2 : Séquence stricte des messages sans message user synthétique", async () => {
  let calls = 0;
  let messagesCapturedOnCall2: ChatMessage[] = [];

  const mockLLM: LLMProvider = {
    name: "test2_llm",
    supportsNativeTools: () => true,
    async complete(messages) {
      calls++;
      if (calls === 1) {
        return {
          content: null,
          toolCalls: [
            {
              id: "call_dispatch_1",
              type: "function",
              function: {
                name: "dispatch_capability",
                arguments: JSON.stringify({ capability: "software_development", objective: "App test" }),
              },
            },
          ],
        };
      }
      messagesCapturedOnCall2 = [...messages];
      return { content: "TERMINÉ" };
    },
  };

  const agent = new Agent({ llm: mockLLM, embeddings: new LocalHashingEmbeddingProvider() });
  await agent.step("Mon message initial");

  assert.equal(calls, 2);

  // Vérification de la séquence
  const userInitMsg = messagesCapturedOnCall2.find((m) => m.role === "user" && m.content === "Mon message initial");
  assert.ok(userInitMsg, "Le message initial utilisateur doit être présent");

  const assistantMsgIndex = messagesCapturedOnCall2.findIndex(
    (m) => m.role === "assistant" && m.toolCalls && m.toolCalls[0]?.id === "call_dispatch_1",
  );
  assert.ok(assistantMsgIndex !== -1, "Le message assistant avec toolCalls doit être présent");

  const toolMsgIndex = messagesCapturedOnCall2.findIndex(
    (m) => m.role === "tool" && m.toolCallId === "call_dispatch_1",
  );
  assert.ok(toolMsgIndex !== -1, "Le message tool avec toolCallId 'call_dispatch_1' doit être présent");

  assert.equal(toolMsgIndex, assistantMsgIndex + 1, "Le message tool doit suivre immédiatement le message assistant");

  // Vérification de l'absence totale de message synthetic 'user' entre l'assistant toolCall et l'appel LLM 2
  const syntheticUserMsgAfterTool = messagesCapturedOnCall2.slice(toolMsgIndex + 1).filter((m) => m.role === "user");
  assert.equal(syntheticUserMsgAfterTool.length, 0, "Aucun message user synthétique ne doit être intercalé après le message tool");
});

test("PROTOCOLE NATIF — TEST 3 : Exactly un tool result message par tool call", async () => {
  let messagesCapturedOnCall2: ChatMessage[] = [];

  const mockLLM: LLMProvider = {
    name: "test3_llm",
    supportsNativeTools: () => true,
    async complete(messages) {
      if (messages.some((m) => m.role === "tool")) {
        messagesCapturedOnCall2 = [...messages];
        return { content: "TERMINÉ" };
      }
      return {
        content: null,
        toolCalls: [
          {
            id: "call_dispatch_single",
            type: "function",
            function: {
              name: "dispatch_capability",
              arguments: JSON.stringify({ capability: "software_development", objective: "App test" }),
            },
          },
        ],
      };
    },
  };

  const agent = new Agent({ llm: mockLLM, embeddings: new LocalHashingEmbeddingProvider() });
  await agent.step("Message test 3");

  const toolMsgs = messagesCapturedOnCall2.filter(
    (m) => m.role === "tool" && m.toolCallId === "call_dispatch_single",
  );
  assert.equal(toolMsgs.length, 1, "Il doit y avoir exactement un message tool pour 'call_dispatch_single'");
});

test("PROTOCOLE NATIF — TEST 4 : Plusieurs tool calls consécutifs sans message intermédiaire", async () => {
  let messagesCapturedOnCall2: ChatMessage[] = [];

  const multiToolLLM: LLMProvider = {
    name: "test4_llm",
    supportsNativeTools: () => true,
    async complete(messages) {
      if (messages.some((m) => m.role === "tool")) {
        messagesCapturedOnCall2 = [...messages];
        return { content: "TERMINÉ" };
      }
      return {
        content: "Execution de 2 outils",
        toolCalls: [
          {
            id: "call_A",
            type: "function",
            function: { name: "get_current_time", arguments: "{}" },
          },
          {
            id: "call_B",
            type: "function",
            function: { name: "list_tasks", arguments: "{}" },
          },
        ],
      };
    },
  };

  const agent = new Agent({ llm: multiToolLLM, embeddings: new LocalHashingEmbeddingProvider() });
  for (const skill of builtinSkills) agent.skills.register(skill);

  await agent.step("Exécute deux outils");

  const assistantIndex = messagesCapturedOnCall2.findIndex(
    (m) => m.role === "assistant" && m.toolCalls && m.toolCalls.length === 2,
  );
  assert.ok(assistantIndex !== -1);

  const toolAIndex = messagesCapturedOnCall2.findIndex((m) => m.role === "tool" && m.toolCallId === "call_A");
  const toolBIndex = messagesCapturedOnCall2.findIndex((m) => m.role === "tool" && m.toolCallId === "call_B");

  assert.equal(toolAIndex, assistantIndex + 1);
  assert.equal(toolBIndex, assistantIndex + 2);

  const messagesBetweenTools = messagesCapturedOnCall2.slice(toolAIndex, toolBIndex + 1);
  assert.equal(messagesBetweenTools.length, 2);
  assert.equal(messagesBetweenTools[0].role, "tool");
  assert.equal(messagesBetweenTools[1].role, "tool");
});

test("PROTOCOLE NATIF — TEST 5 : Tool call ID exact du provider préservé (ex: dispatch_capability_s7w13qka3vzs)", async () => {
  const customCallId = "dispatch_capability_s7w13qka3vzs";
  let capturedToolCallId = "";

  const mockLLM: LLMProvider = {
    name: "test5_llm",
    supportsNativeTools: () => true,
    async complete(messages) {
      const toolMsg = messages.find((m) => m.role === "tool");
      if (toolMsg) {
        capturedToolCallId = toolMsg.toolCallId || "";
        return { content: "TERMINÉ" };
      }
      return {
        content: null,
        toolCalls: [
          {
            id: customCallId,
            type: "function",
            function: {
              name: "dispatch_capability",
              arguments: JSON.stringify({ capability: "software_development", objective: "App test" }),
            },
          },
        ],
      };
    },
  };

  const agent = new Agent({ llm: mockLLM, embeddings: new LocalHashingEmbeddingProvider() });
  await agent.step("Test call ID");

  assert.equal(capturedToolCallId, customCallId);
});

test("PROTOCOLE NATIF — TEST 7 : Pas de régression sur une réponse naturelle sans outils", async () => {
  let calls = 0;

  const mockLLM: LLMProvider = {
    name: "test7_llm",
    supportsNativeTools: () => true,
    async complete() {
      calls++;
      return { content: "Réponse naturelle sans outils" };
    },
  };

  const agent = new Agent({ llm: mockLLM, embeddings: new LocalHashingEmbeddingProvider() });
  const res = await agent.step("Bonjour");

  assert.equal(calls, 1);
  assert.equal(res.iterations, 1);
  assert.equal(res.response, "Réponse naturelle sans outils");
});

test("PROTOCOLE NATIF — TEST 8 : dispatch_capability est toujours inclus dans les outils envoyés au LLM", async () => {
  let sentToolsCount = 0;
  let sentDispatchCapability = false;

  const mockLLM: LLMProvider = {
    name: "test8_llm",
    supportsNativeTools: () => true,
    async complete(_messages, options) {
      if (options?.tools) {
        sentToolsCount = options.tools.length;
        sentDispatchCapability = options.tools.some((t) => t.function.name === "dispatch_capability");
      }
      return { content: "OK" };
    },
  };

  const agent = new Agent({ llm: mockLLM, embeddings: new LocalHashingEmbeddingProvider() });
  await agent.step("N'importe quelle question");

  assert.ok(sentToolsCount > 0, "Des outils doivent être envoyés au LLM");
  assert.equal(sentDispatchCapability, true, "dispatch_capability doit être obligatoirement présent");
});
