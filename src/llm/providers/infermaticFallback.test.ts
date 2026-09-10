import { test } from "node:test";
import assert from "node:assert/strict";
import { InfermaticProvider } from "./infermatic.js";

const tools = [
  {
    type: "function" as const,
    function: {
      name: "knowledge_search",
      description: "Inspecte un dépôt GitHub en lecture seule",
      parameters: {
        type: "object" as const,
        properties: {
          action: { type: "string" },
          repository: { type: "string" },
        },
        required: ["action", "repository"],
        additionalProperties: false,
      },
    },
  },
];

test("InfermaticProvider bascule automatiquement en compatibilité quand tools provoque HTTP 400", async () => {
  const originalFetch = globalThis.fetch;
  const bodies: any[] = [];
  try {
    globalThis.fetch = (async (_url: unknown, init?: RequestInit) => {
      const body = JSON.parse(init?.body as string);
      bodies.push(body);
      if (bodies.length === 1) {
        return new Response(JSON.stringify({ error: { message: "Bad request" } }), {
          status: 400,
          headers: { "content-type": "application/json" },
        });
      }
      return new Response(
        JSON.stringify({
          choices: [
            {
              message: {
                content: JSON.stringify({
                  jarvis_tool_call: {
                    name: "knowledge_search",
                    arguments: { action: "AUDIT", repository: "owner/repo" },
                  },
                }),
              },
            },
          ],
        }),
        { status: 200, headers: { "content-type": "application/json" } },
      );
    }) as typeof fetch;

    const provider = new InfermaticProvider({
      apiKey: "k",
      baseUrl: "https://api.totalgpt.ai/v1",
      model: "Qwen-Qwen3.6-35B-A3B",
      sanitizeReasoning: true,
    });

    const result = await provider.complete([{ role: "user", content: "audite mon dépôt" }], { tools });

    assert.equal(bodies.length, 2);
    assert.deepEqual(bodies[0].tools, tools);
    assert.equal(bodies[0].tool_choice, "auto");
    assert.equal("tools" in bodies[1], false);
    assert.equal("tool_choice" in bodies[1], false);
    assert.ok(String(bodies[1].messages[0].content).includes("MODE DE COMPATIBILITÉ OUTILS JARVIS"));
    assert.equal(result.content, null);
    assert.equal(result.toolCalls?.length, 1);
    assert.equal(result.toolCalls?.[0].function.name, "knowledge_search");
    assert.deepEqual(JSON.parse(result.toolCalls?.[0].function.arguments || "{}"), {
      action: "AUDIT",
      repository: "owner/repo",
    });
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("Après le premier rejet natif, InfermaticProvider réutilise directement le mode compatibilité et sérialise les résultats d'outil", async () => {
  const originalFetch = globalThis.fetch;
  const bodies: any[] = [];
  try {
    globalThis.fetch = (async (_url: unknown, init?: RequestInit) => {
      const body = JSON.parse(init?.body as string);
      bodies.push(body);
      if (bodies.length === 1) {
        return new Response("tools unsupported", { status: 422 });
      }
      if (bodies.length === 2) {
        return new Response(
          JSON.stringify({
            choices: [{ message: { content: '{"jarvis_tool_call":{"name":"knowledge_search","arguments":{"action":"AUDIT","repository":"owner/repo"}}}' } }],
          }),
          { status: 200, headers: { "content-type": "application/json" } },
        );
      }
      return new Response(
        JSON.stringify({ choices: [{ message: { content: "Audit terminé." } }] }),
        { status: 200, headers: { "content-type": "application/json" } },
      );
    }) as typeof fetch;

    const provider = new InfermaticProvider({ apiKey: "k", baseUrl: "https://api.totalgpt.ai/v1", model: "m" });
    const first = await provider.complete([{ role: "user", content: "audite" }], { tools });
    assert.equal(first.toolCalls?.length, 1);

    const result = await provider.complete(
      [
        { role: "user", content: "audite" },
        {
          role: "assistant",
          content: null,
          toolCalls: first.toolCalls,
        },
        {
          role: "tool",
          name: "knowledge_search",
          toolCallId: first.toolCalls?.[0].id,
          content: "aucun problème bloquant",
        },
      ],
      { tools },
    );

    assert.equal(bodies.length, 3, "le deuxième cycle ne doit pas retenter une requête native condamnée");
    assert.equal("tools" in bodies[2], false);
    assert.ok(bodies[2].messages.every((message: any) => message.role !== "tool"));
    assert.ok(bodies[2].messages.some((message: any) => String(message.content).includes("JARVIS_TOOL_RESULT")));
    assert.equal(result.content, "Audit terminé.");
    assert.equal(result.toolCalls, undefined);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("Le fallback refuse de convertir un nom d'outil non exposé par Jarvis", async () => {
  const originalFetch = globalThis.fetch;
  try {
    let call = 0;
    globalThis.fetch = (async () => {
      call++;
      if (call === 1) return new Response("unsupported tools", { status: 400 });
      return new Response(
        JSON.stringify({ choices: [{ message: { content: '{"jarvis_tool_call":{"name":"dangerous_unknown_tool","arguments":{}}}' } }] }),
        { status: 200, headers: { "content-type": "application/json" } },
      );
    }) as typeof fetch;

    const provider = new InfermaticProvider({ apiKey: "k", baseUrl: "https://api.totalgpt.ai/v1", model: "m" });
    const result = await provider.complete([{ role: "user", content: "test" }], { tools });

    assert.equal(result.toolCalls, undefined);
    assert.ok(result.content?.includes("dangerous_unknown_tool"));
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("Une erreur 400 sans tools reste une vraie erreur API et ne déclenche pas de fallback", async () => {
  const originalFetch = globalThis.fetch;
  let calls = 0;
  try {
    globalThis.fetch = (async () => {
      calls++;
      return new Response(JSON.stringify({ error: { message: "invalid request" } }), {
        status: 400,
        headers: { "content-type": "application/json" },
      });
    }) as typeof fetch;

    const provider = new InfermaticProvider({ apiKey: "k", baseUrl: "https://api.totalgpt.ai/v1", model: "m" });
    await assert.rejects(() => provider.complete([{ role: "user", content: "test" }]), /Infermatic API 400/);
    assert.equal(calls, 1);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("InfermaticProvider autorise 4096 tokens de sortie par défaut pour éviter les réponses coupées", async () => {
  const originalFetch = globalThis.fetch;
  let sentBody: any = null;
  try {
    globalThis.fetch = (async (_url: unknown, init?: RequestInit) => {
      sentBody = JSON.parse(init?.body as string);
      return new Response(JSON.stringify({ choices: [{ message: { content: "Réponse complète" } }] }), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    }) as typeof fetch;

    const provider = new InfermaticProvider({ apiKey: "k", baseUrl: "https://api.totalgpt.ai/v1", model: "m" });
    await provider.complete([{ role: "user", content: "réponse longue" }]);

    assert.equal(sentBody.max_tokens, 4096);
  } finally {
    globalThis.fetch = originalFetch;
  }
});
