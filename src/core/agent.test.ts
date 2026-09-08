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

function createAgent(llm: LLMProvider): InstanceType<typeof Agent> {
  const agent = new Agent({
    llm,
    embeddings: new LocalHashingEmbeddingProvider(),
  });

  for (const skill of builtinSkills) {
    agent.skills.register(skill);
  }

  return agent;
}

test("l'agent répond à une entrée simple (fournisseur mock)", async () => {
  const agent = new Agent({
    llm: new MockProvider(),
    embeddings: new LocalHashingEmbeddingProvider(),
  });

  const result = await agent.step("Bonjour");

  assert.match(result.response, /mock/);
  assert.equal(result.iterations, 1);
});

test("le prompt système contient la date actuelle et les instructions d'accès Internet", async () => {
  let capturedSystemPrompt = "";

  const promptCheckProvider: LLMProvider = {
    name: "prompt_check",
    async complete(messages: ChatMessage[]) {
      const sysMsg = messages.find((message) => message.role === "system");
      if (sysMsg && sysMsg.content) {
        capturedSystemPrompt = sysMsg.content;
      }

      return { content: "OK" };
    },
  };

  const agent = new Agent({
    llm: promptCheckProvider,
    embeddings: new LocalHashingEmbeddingProvider(),
  });

  await agent.step("Test date et internet");

  const isoYear = new Date().getFullYear().toString();

  assert.match(capturedSystemPrompt, new RegExp(isoYear));
  assert.match(capturedSystemPrompt, /ACCÈS INTERNET/i);
  assert.match(capturedSystemPrompt, /web_search/i);
});

test("un checkpoint restaure la mémoire de travail et le plan", async () => {
  const agent = new Agent({
    llm: new MockProvider(),
    embeddings: new LocalHashingEmbeddingProvider(),
  });

  await agent.step("Premier message");
  agent.planner.createNode("Objectif de test");

  const checkpointId = agent.saveCheckpoint("test");

  const fresh = new Agent({
    llm: new MockProvider(),
    embeddings: new LocalHashingEmbeddingProvider(),
  });
  const restored = fresh.restoreCheckpoint(checkpointId);

  assert.ok(restored);
  assert.equal(fresh.planner.all().length, 1);
  assert.ok(
    fresh.memory.working.all().some((message) => message.content === "Premier message"),
  );
});

test("le protocole natif enchaîne assistant tool_calls, role tool, second appel LLM puis réponse", async () => {
  const calls: ChatMessage[][] = [];

  const provider: LLMProvider = {
    name: "native_protocol",
    supportsNativeTools() {
      return true;
    },
    async complete(messages: ChatMessage[]) {
      calls.push(messages);

      if (calls.length === 1) {
        return {
          content: null,
          toolCalls: [
            {
              id: "call_time_001",
              type: "function",
              function: {
                name: "get_current_time",
                arguments: "{}",
              },
            },
          ],
        };
      }

      const assistantIndex = messages.findIndex(
        (message) => message.role === "assistant" && message.toolCalls?.length,
      );
      const toolIndex = messages.findIndex(
        (message) => message.role === "tool" && message.toolCallId === "call_time_001",
      );

      assert.ok(assistantIndex >= 0);
      assert.equal(toolIndex, assistantIndex + 1);
      assert.equal(messages[toolIndex]?.role, "tool");

      return { content: "Il est actuellement l'heure demandée." };
    },
  };

  const result = await createAgent(provider).step("Quelle heure est-il ?");

  assert.equal(calls.length, 2);
  assert.equal(result.iterations, 2);
  assert.match(result.response, /heure/i);
});

test("le second appel natif ne contient aucun message user synthétique", async () => {
  let secondCallMessages: ChatMessage[] = [];

  const provider: LLMProvider = {
    name: "no_synthetic_user",
    supportsNativeTools() {
      return true;
    },
    async complete(messages: ChatMessage[]) {
      if (secondCallMessages.length === 0) {
        return {
          content: null,
          toolCalls: [
            {
              id: "call_time_002",
              type: "function",
              function: {
                name: "get_current_time",
                arguments: "{}",
              },
            },
          ],
        };
      }

      secondCallMessages = messages;
      return { content: "Réponse finale." };
    },
  };

  await createAgent(provider).step("Donne-moi l'heure.");

  const userMessages = secondCallMessages.filter((message) => message.role === "user");

  assert.equal(userMessages.length, 1);
  assert.equal(secondCallMessages.at(-1)?.role, "tool");
  assert.equal(
    secondCallMessages.slice(0, -1).some((message) => message.role === "user"),
    true,
  );
});

test("un tool call produit exactement un message role tool", async () => {
  let secondCallMessages: ChatMessage[] = [];

  const provider: LLMProvider = {
    name: "one_tool_message",
    supportsNativeTools() {
      return true;
    },
    async complete(messages: ChatMessage[]) {
      if (secondCallMessages.length === 0) {
        return {
          content: null,
          toolCalls: [
            {
              id: "call_tasks_003",
              type: "function",
              function: {
                name: "list_tasks",
                arguments: JSON.stringify({ status: "pending" }),
              },
            },
          ],
        };
      }

      secondCallMessages = messages;
      return { content: "Aucune tâche en attente." };
    },
  };

  await createAgent(provider).step("Liste mes tâches.");

  const toolMessages = secondCallMessages.filter((message) => message.role === "tool");

  assert.equal(toolMessages.length, 1);
  assert.equal(toolMessages[0]?.toolCallId, "call_tasks_003");
});

test("le toolCallId est préservé jusqu'au message role tool", async () => {
  let receivedToolCallId = "";

  const provider: LLMProvider = {
    name: "preserved_tool_call_id",
    supportsNativeTools() {
      return true;
    },
    async complete(messages: ChatMessage[]) {
      if (receivedToolCallId === "") {
        return {
          content: null,
          toolCalls: [
            {
              id: "call_time_preserved_004",
              type: "function",
              function: {
                name: "get_current_time",
                arguments: "{}",
              },
            },
          ],
        };
      }

      const toolMessage = messages.find((message) => message.role === "tool");
      receivedToolCallId = toolMessage?.toolCallId ?? "";

      return { content: "Terminé." };
    },
  };

  await createAgent(provider).step("Vérifie l'heure.");

  assert.equal(receivedToolCallId, "call_time_preserved_004");
});

test("deux tool calls consécutifs produisent deux messages role tool sans intermédiaire", async () => {
  let calls = 0;
  let secondCallMessages: ChatMessage[] = [];

  const provider: LLMProvider = {
    name: "multiple_native_tools",
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
              id: "call_time_005",
              type: "function",
              function: {
                name: "get_current_time",
                arguments: "{}",
              },
            },
            {
              id: "call_tasks_006",
              type: "function",
              function: {
                name: "list_tasks",
                arguments: JSON.stringify({ status: "pending" }),
              },
            },
          ],
        };
      }

      secondCallMessages = messages;
      return { content: "Voici les résultats des deux outils." };
    },
  };

  const result = await createAgent(provider).step("Donne-moi l'heure et mes tâches.");

  const toolMessages = secondCallMessages.filter((message) => message.role === "tool");
  const firstToolIndex = secondCallMessages.findIndex(
    (message) => message.role === "tool" && message.toolCallId === "call_time_005",
  );
  const secondToolIndex = secondCallMessages.findIndex(
    (message) => message.role === "tool" && message.toolCallId === "call_tasks_006",
  );

  assert.equal(calls, 2);
  assert.equal(result.iterations, 2);
  assert.equal(toolMessages.length, 2);
  assert.equal(secondToolIndex, firstToolIndex + 1);
  assert.deepEqual(
    toolMessages.map((message) => message.toolCallId),
    ["call_time_005", "call_tasks_006"],
  );
});

test("un JSON invalide est retourné en role tool avec le même toolCallId", async () => {
  let calls = 0;
  let receivedError = false;
  let receivedToolCallId = "";

  const provider: LLMProvider = {
    name: "invalid_json_native_tool",
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
              id: "call_invalid_json_007",
              type: "function",
              function: {
                name: "web_search",
                arguments: "{INVALID_JSON",
              },
            },
          ],
        };
      }

      const toolMessage = messages.find((message) => message.role === "tool");
      receivedToolCallId = toolMessage?.toolCallId ?? "";
      receivedError = Boolean(toolMessage?.content?.includes("Erreur"));

      return { content: "Le format de la requête était invalide." };
    },
  };

  const result = await createAgent(provider).step("Effectue une recherche.");

  assert.equal(calls, 2);
  assert.equal(receivedToolCallId, "call_invalid_json_007");
  assert.equal(receivedError, true);
  assert.match(result.response, /invalide/i);
});

test("une réponse native sans outil ne déclenche pas de second appel", async () => {
  let calls = 0;

  const provider: LLMProvider = {
    name: "native_without_tool",
    supportsNativeTools() {
      return true;
    },
    async complete() {
      calls += 1;
      return { content: "Réponse directe sans appel d'outil." };
    },
  };

  const result = await createAgent(provider).step("Réponds directement.");

  assert.equal(calls, 1);
  assert.equal(result.iterations, 1);
  assert.equal(result.response, "Réponse directe sans appel d'outil.");
});

test("dispatch_capability est présent dans les outils natifs", async () => {
  let receivedTools: CompletionOptions["tools"] = [];

  const provider: LLMProvider = {
    name: "dispatch_tools",
    supportsNativeTools() {
      return true;
    },
    async complete(_messages: ChatMessage[], options?: CompletionOptions) {
      receivedTools = options?.tools ?? [];
      return { content: "Les capacités disponibles ont été vérifiées." };
    },
  };

  const result = await new Agent({
    llm: provider,
    embeddings: new LocalHashingEmbeddingProvider(),
  }).step("Quelles capacités peux-tu utiliser ?");

  assert.ok(receivedTools.length > 0);
  assert.ok(
    receivedTools.some((tool) => {
      if (tool.type !== "function") return false;
      return tool.function.name === "dispatch_capability";
    }),
  );
  assert.equal(result.iterations, 1);
});