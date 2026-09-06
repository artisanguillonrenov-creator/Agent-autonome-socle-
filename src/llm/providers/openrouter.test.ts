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
    assert.equal(result, "Hello from OpenRouter!");
  } finally {
    globalThis.fetch = originalFetch;
  }
});
