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

test("Test obligatoire : Interception format Nemotron / OpenRouter <tool_call> pour recherche de films au cinéma", async () => {
  let calls = 0;
  let receivedSearchData = false;

  const nemotronProvider: LLMProvider = {
    name: "openrouter_nemotron",
    async complete(messages: ChatMessage[]) {
      calls += 1;
      if (calls === 1) {
        // Nemotron / OpenRouter style tool call output
        return '<tool_call>{"name": "web_search", "arguments": {"query": "films au cinema en france ce mois-ci"}}</tool_call>';
      }

      // Second pass: verify web_search results were received in messages
      const toolMsg = messages.find((m) => m.role === "tool" && m.name === "web_search");
      if (toolMsg && toolMsg.content) {
        receivedSearchData = true;
      }

      return '{"action": "RESPOND", "response": "Voici les principaux films à l\'affiche au cinéma en France ce mois-ci : Film A, Film B, Film C."}';
    },
  };

  const agent = new Agent({ llm: nemotronProvider, embeddings: new LocalHashingEmbeddingProvider() });
  for (const skill of builtinSkills) agent.skills.register(skill);

  const query = "Trouve-moi les films qui sortent au cinéma en France ce mois-ci.";
  const result = await agent.step(query);

  assert.equal(calls, 2);
  assert.equal(receivedSearchData, true);
  assert.equal(result.iterations, 2);
  assert.equal(result.response.includes("<tool_call>"), false);
  assert.equal(result.response.includes("CALL_SKILL"), false);
  assert.match(result.response, /cinéma/i);
});

test("Test Format Réel XML : <tool_call>CALL_SKILL <arg_key>...</arg_key><arg_value>...</arg_value></tool_call>", async () => {
  let calls = 0;
  let receivedSearchData = false;

  const xmlToolCallProvider: LLMProvider = {
    name: "xml_tool_call",
    async complete(messages: ChatMessage[]) {
      calls += 1;
      if (calls === 1) {
        return `<tool_call>CALL_SKILL
<arg_key>skill</arg_key>
<arg_value>web_search</arg_value>
<arg_key>input</arg_key>
<arg_value>{"query":"films au cinéma en france ce mois-ci"}</arg_value>
</tool_call>`;
      }

      const toolMsg = messages.find((m) => m.role === "tool" && m.name === "web_search");
      if (toolMsg && toolMsg.content) {
        receivedSearchData = true;
      }

      return '{"action": "RESPOND", "response": "Voici les films à l\'affiche ce mois-ci."}';
    },
  };

  const agent = new Agent({ llm: xmlToolCallProvider, embeddings: new LocalHashingEmbeddingProvider() });
  for (const skill of builtinSkills) agent.skills.register(skill);

  const result = await agent.step("Trouve-moi les films qui sortent au cinéma en France ce mois-ci.");

  assert.equal(calls, 2);
  assert.equal(receivedSearchData, true);
  assert.equal(result.iterations, 2);
  assert.equal(result.response, "Voici les films à l'affiche ce mois-ci.");
  assert.equal(result.response.includes("<arg_key>"), false);
  assert.equal(result.response.includes("<arg_value>"), false);
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

test("Native Tool Calling : flux natif web_search unique (TEST A)", async () => {
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

      // Second call: check if tool message was received with matching toolCallId
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
