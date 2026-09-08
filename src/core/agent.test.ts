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

test("Native Tool Calling : protocole complet sans message user synthétique", async () => {
  let calls = 0;
  let secondTurnMessages: ChatMessage[] = [];
  let receivedToolCallId = "";

  const provider: LLMProvider = {
    name: "protocol_complete",
    supportsNativeTools() {
      return true;
    },
    async complete(messages: ChatMessage[], options?: CompletionOptions) {
      calls += 1;

      if (calls === 1) {
        assert.ok(options?.tools?.some((tool) => tool.function?.name === "web_search"));

        return {
          content: null,
          toolCalls: [
            {
              id: "exact_tool_call_id_001",
              type: "function",
              function: {
                name: "web_search",
                arguments: '{"query":"actualité"}',
              },
            },
          ],
        };
      }

      secondTurnMessages = messages;
      const toolMessages = messages.filter((message) => message.role === "tool");
      assert.equal(toolMessages.length, 1);
      assert.equal(toolMessages[0]?.toolCallId, "exact_tool_call_id_001");
      receivedToolCallId = toolMessages[0]?.toolCallId || "";

      return { content: "Réponse finale après recherche." };
    },
  };

  const agent = new Agent({ llm: provider, embeddings: new LocalHashingEmbeddingProvider() });
  for (const skill of builtinSkills) agent.skills.register(skill);

  const result = await agent.step("Recherche cette information");

  assert.equal(calls, 2);
  assert.equal(result.iterations, 2);
  assert.equal(receivedToolCallId, "exact_tool_call_id_001");
  assert.equal(
    secondTurnMessages.some((message) => message.role === "user" && message.content !== "Recherche cette information"),
    false,
  );
  assert.equal(result.response, "Réponse finale après recherche.");
});

test("Native Tool Calling : un message role tool par appel et conservation des identifiants", async () => {
  let calls = 0;
  let secondTurnMessages: ChatMessage[] = [];

  const provider: LLMProvider = {
    name: "one_tool_message_per_call",
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
              id: "tool_call_a",
              type: "function",
              function: {
                name: "get_current_time",
                arguments: "{}",
              },
            },
            {
              id: "tool_call_b",
              type: "function",
              function: {
                name: "list_tasks",
                arguments: '{"status":"pending"}',
              },
            },
          ],
        };
      }

      secondTurnMessages = messages;

      return {
        content: "Les deux outils ont été exécutés.",
      };
    },
  };

  const agent = new Agent({ llm: provider, embeddings: new LocalHashingEmbeddingProvider() });
  for (const skill of builtinSkills) agent.skills.register(skill);

  await agent.step("Utilise deux outils");

  const toolMessages = secondTurnMessages.filter((message) => message.role === "tool");
  assert.equal(toolMessages.length, 2);
  assert.deepEqual(
    toolMessages.map((message) => message.toolCallId),
    ["tool_call_a", "tool_call_b"],
  );
  assert.equal(
    secondTurnMessages.filter((message) => message.role === "user").length,
    1,
  );
});

test("Native Tool Calling : plusieurs tours d'outils consécutifs sans message user intermédiaire", async () => {
  let calls = 0;
  const turns: ChatMessage[][] = [];

  const provider: LLMProvider = {
    name: "consecutive_tools",
    supportsNativeTools() {
      return true;
    },
    async complete(messages: ChatMessage[]) {
      calls += 1;
      turns.push(messages);

      if (calls === 1) {
        return {
          content: null,
          toolCalls: [
            {
              id: "consecutive_call_1",
              type: "function",
              function: {
                name: "get_current_time",
                arguments: "{}",
              },
            },
          ],
        };
      }

      if (calls === 2) {
        return {
          content: null,
          toolCalls: [
            {
              id: "consecutive_call_2",
              type: "function",
              function: {
                name: "list_tasks",
                arguments: '{"status":"pending"}',
              },
            },
          ],
        };
      }

      return { content: "Réponse finale après deux tours d'outils." };
    },
  };

  const agent = new Agent({ llm: provider, embeddings: new LocalHashingEmbeddingProvider() });
  for (const skill of builtinSkills) agent.skills.register(skill);

  const result = await agent.step("Effectue deux vérifications");

  assert.equal(calls, 3);
  assert.equal(result.iterations, 3);
  assert.equal(result.response, "Réponse finale après deux tours d'outils.");

  const secondTurn = turns[1] || [];
  const thirdTurn = turns[2] || [];

  assert.ok(secondTurn.some((message) => message.role === "tool" && message.toolCallId === "consecutive_call_1"));
  assert.ok(thirdTurn.some((message) => message.role === "tool" && message.toolCallId === "consecutive_call_2"));
  assert.equal(
    secondTurn.some((message) => message.role === "user" && message.content !== "Effectue deux vérifications"),
    false,
  );
  assert.equal(
    thirdTurn.some((message) => message.role === "user" && message.content !== "Effectue deux vérifications"),
    false,
  );
});

test("Native Tool Calling : arguments invalides conservés en role tool avec le même toolCallId", async () => {
  let calls = 0;
  let invalidToolMessage: ChatMessage | undefined;

  const provider: LLMProvider = {
    name: "invalid_arguments_protocol",
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
              id: "invalid_arguments_call_777",
              type: "function",
              function: {
                name: "web_search",
                arguments: "{not-valid-json",
              },
            },
          ],
        };
      }

      invalidToolMessage = messages.find(
        (message) => message.role === "tool" && message.toolCallId === "invalid_arguments_call_777",
      );

      return { content: "Erreur traitée correctement." };
    },
  };

  const agent = new Agent({ llm: provider, embeddings: new LocalHashingEmbeddingProvider() });
  for (const skill of builtinSkills) agent.skills.register(skill);

  const result = await agent.step("Teste des arguments invalides");

  assert.equal(calls, 2);
  assert.ok(invalidToolMessage);
  assert.equal(invalidToolMessage?.role, "tool");
  assert.equal(invalidToolMessage?.toolCallId, "invalid_arguments_call_777");
  assert.match(invalidToolMessage?.content || "", /Erreur/i);
  assert.equal(result.response, "Erreur traitée correctement.");
});

test("Native Tool Calling : une réponse normale sans outil est préservée", async () => {
  let calls = 0;
  let receivedOptions: CompletionOptions | undefined;

  const provider: LLMProvider = {
    name: "no_tool_response",
    supportsNativeTools() {
      return true;
    },
    async complete(_messages: ChatMessage[], options?: CompletionOptions) {
      calls += 1;
      receivedOptions = options;
      return { content: "Réponse directe sans appel d'outil." };
    },
  };

  const agent = new Agent({ llm: provider, embeddings: new LocalHashingEmbeddingProvider() });
  const result = await agent.step("Réponds directement");

  assert.equal(calls, 1);
  assert.equal(result.iterations, 1);
  assert.equal(result.response, "Réponse directe sans appel d'outil.");
  assert.ok(receivedOptions?.tools);
});

test("Native Tool Calling : dispatch_capability est présent dans les outils envoyés au LLM", async () => {
  let capturedTools: CompletionOptions["tools"] | undefined;

  const provider: LLMProvider = {
    name: "dispatch_tools_advertisement",
    supportsNativeTools() {
      return true;
    },
    async complete(_messages: ChatMessage[], options?: CompletionOptions) {
      capturedTools = options?.tools;
      return { content: "Aucune délégation nécessaire." };
    },
  };

  const agent = new Agent({ llm: provider, embeddings: new LocalHashingEmbeddingProvider() });
  await agent.step("Réponds sans déléguer");

  assert.ok(capturedTools);
  assert.ok(
    capturedTools.some((tool) => tool.function?.name === "dispatch_capability"),
  );
});