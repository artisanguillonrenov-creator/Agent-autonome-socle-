import { test } from "node:test";
import assert from "node:assert/strict";
import { OpenRouterProvider } from "./openrouter.js";

test("OpenRouterProvider handles response without choices without throwing undefined[0]", async () => {
  const originalFetch = globalThis.fetch;
  try {
    globalThis.fetch = async () =>
      new Response(JSON.stringify({}), { status: 200, headers: { "content-type": "application/json" } });

    const provider = new OpenRouterProvider({ apiKey: "test-key", model: "test-model" });
    await assert.rejects(
      async () => {
        await provider.complete([{ role: "user", content: "hi" }]);
      },
      (err: Error) => {
        assert.match(err.message, /sans choix/i);
        return true;
      },
    );
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("OpenRouterProvider handles error response payload cleanly", async () => {
  const originalFetch = globalThis.fetch;
  try {
    globalThis.fetch = async () =>
      new Response(JSON.stringify({ error: { message: "Model overloaded" } }), {
        status: 200,
        headers: { "content-type": "application/json" },
      });

    const provider = new OpenRouterProvider({ apiKey: "test-key", model: "test-model" });
    await assert.rejects(
      async () => {
        await provider.complete([{ role: "user", content: "hi" }]);
      },
      (err: Error) => {
        assert.match(err.message, /Model overloaded/i);
        return true;
      },
    );
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("OpenRouterProvider parses valid completion response", async () => {
  const originalFetch = globalThis.fetch;
  try {
    globalThis.fetch = async () =>
      new Response(JSON.stringify({ choices: [{ message: { content: "Hello from OpenRouter!" } }] }), {
        status: 200,
        headers: { "content-type": "application/json" },
      });

    const provider = new OpenRouterProvider({ apiKey: "test-key", model: "test-model" });
    const result = await provider.complete([{ role: "user", content: "hi" }]);
    assert.deepEqual(result, { content: "Hello from OpenRouter!", toolCalls: undefined });
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("OpenRouterProvider supportsNativeTools and handles tool_calls with null content", async () => {
  const originalFetch = globalThis.fetch;
  let sentBody: any = null;

  try {
    globalThis.fetch = async (_url, init) => {
      sentBody = JSON.parse(init?.body as string);
      return new Response(
        JSON.stringify({
          choices: [
            {
              message: {
                content: null,
                tool_calls: [
                  {
                    id: "call_abc123",
                    type: "function",
                    function: {
                      name: "web_search",
                      arguments: '{"query":"actualites france"}',
                    },
                  },
                ],
              },
            },
          ],
        }),
        { status: 200, headers: { "content-type": "application/json" } },
      );
    };

    const provider = new OpenRouterProvider({ apiKey: "test-key", model: "test-model" });
    assert.equal(provider.supportsNativeTools(), true);

    const result = await provider.complete([{ role: "user", content: "actualités" }], {
      tools: [
        {
          type: "function",
          function: {
            name: "web_search",
            description: "search web",
            parameters: { type: "object", properties: { query: { type: "string" } } },
          },
        },
      ],
    });

    assert.equal(sentBody.tools.length, 1);
    assert.equal(sentBody.tool_choice, "auto");
    assert.equal(sentBody.parallel_tool_calls, false);

    assert.equal(result.content, null);
    assert.ok(Array.isArray(result.toolCalls));
    assert.equal(result.toolCalls?.length, 1);
    assert.equal(result.toolCalls?.[0].id, "call_abc123");
    assert.equal(result.toolCalls?.[0].function.name, "web_search");
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("OpenRouterProvider formats tool role and toolCalls assistant messages correctly", async () => {
  const originalFetch = globalThis.fetch;
  let sentBody: any = null;

  try {
    globalThis.fetch = async (_url, init) => {
      sentBody = JSON.parse(init?.body as string);
      return new Response(
        JSON.stringify({
          choices: [{ message: { content: "Réponse finale" } }],
        }),
        { status: 200, headers: { "content-type": "application/json" } },
      );
    };

    const provider = new OpenRouterProvider({ apiKey: "test-key", model: "test-model" });

    await provider.complete([
      { role: "user", content: "recherche" },
      {
        role: "assistant",
        content: null,
        toolCalls: [
          {
            id: "call_1",
            type: "function",
            function: { name: "web_search", arguments: '{"query":"test"}' },
          },
        ],
      },
      {
        role: "tool",
        toolCallId: "call_1",
        name: "web_search",
        content: "résultat web",
      },
    ]);

    assert.equal(sentBody.messages[1].role, "assistant");
    assert.equal(sentBody.messages[1].content, null);
    assert.equal(sentBody.messages[1].tool_calls[0].id, "call_1");

    assert.equal(sentBody.messages[2].role, "user");
    assert.equal(sentBody.messages[2].content, "[Résultat de l'outil [Outil: web_search]]: résultat web");
  } finally {
    globalThis.fetch = originalFetch;
  }
});
