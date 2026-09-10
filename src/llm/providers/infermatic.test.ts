import { test } from "node:test";
import assert from "node:assert/strict";
import { InfermaticProvider } from "./infermatic.js";

test("InfermaticProvider refuse d'appeler l'API sans clé configurée", async () => {
  const provider = new InfermaticProvider({ apiKey: "", baseUrl: "https://api.totalgpt.ai/v1", model: "any-model" });
  await assert.rejects(
    () => provider.complete([{ role: "user", content: "hi" }]),
    (err: Error) => {
      assert.match(err.message, /INFERMATIC_API_KEY/);
      return true;
    },
  );
});

test("InfermaticProvider envoie Authorization: Bearer <clé> et POST vers <baseUrl>/chat/completions", async () => {
  const originalFetch = globalThis.fetch;
  let capturedUrl: string | null = null;
  let capturedHeaders: Record<string, string> | null = null;
  try {
    globalThis.fetch = (async (url: unknown, init?: RequestInit) => {
      capturedUrl = String(url);
      capturedHeaders = init?.headers as Record<string, string>;
      return new Response(JSON.stringify({ choices: [{ message: { content: "OK" } }] }), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    }) as typeof fetch;

    const provider = new InfermaticProvider({
      apiKey: "sk-secret-test-key",
      baseUrl: "https://api.totalgpt.ai/v1",
      model: "Qwen-Qwen3.6-35B-A3B",
    });

    await provider.complete([{ role: "user", content: "hi" }]);

    assert.equal(capturedUrl, "https://api.totalgpt.ai/v1/chat/completions");
    assert.equal(capturedHeaders?.authorization, "Bearer sk-secret-test-key");
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("InfermaticProvider normalise les doubles slashs de baseUrl sans casser le endpoint", async () => {
  const originalFetch = globalThis.fetch;
  let capturedUrl: string | null = null;
  try {
    globalThis.fetch = (async (url: unknown) => {
      capturedUrl = String(url);
      return new Response(JSON.stringify({ choices: [{ message: { content: "OK" } }] }), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    }) as typeof fetch;

    const provider = new InfermaticProvider({ apiKey: "k", baseUrl: "https://api.totalgpt.ai/v1/", model: "m" });
    await provider.complete([{ role: "user", content: "hi" }]);

    assert.equal(capturedUrl, "https://api.totalgpt.ai/v1/chat/completions");
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("InfermaticProvider conserve exactement le model id choisi (aucune transformation de casse)", async () => {
  const originalFetch = globalThis.fetch;
  let sentBody: any = null;
  try {
    globalThis.fetch = (async (_url: unknown, init?: RequestInit) => {
      sentBody = JSON.parse(init?.body as string);
      return new Response(JSON.stringify({ choices: [{ message: { content: "OK" } }] }), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    }) as typeof fetch;

    const provider = new InfermaticProvider({
      apiKey: "k",
      baseUrl: "https://api.totalgpt.ai/v1",
      model: "Qwen-Qwen3.6-35B-A3B",
    });
    await provider.complete([{ role: "user", content: "hi" }], { maxTokens: 5 });

    assert.equal(sentBody.model, "Qwen-Qwen3.6-35B-A3B");
    assert.equal(sentBody.max_tokens, 5);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("InfermaticProvider produit une erreur 401 propre sans fuite de la clé API", async () => {
  const originalFetch = globalThis.fetch;
  try {
    globalThis.fetch = async () =>
      new Response(JSON.stringify({ error: { message: "Invalid API key" } }), {
        status: 401,
        headers: { "content-type": "application/json" },
      });

    const provider = new InfermaticProvider({
      apiKey: "sk-super-secret-do-not-leak",
      baseUrl: "https://api.totalgpt.ai/v1",
      model: "m",
    });

    await assert.rejects(
      () => provider.complete([{ role: "user", content: "hi" }]),
      (err: Error) => {
        assert.match(err.message, /401/);
        assert.match(err.message, /Invalid API key/);
        assert.ok(!err.message.includes("sk-super-secret-do-not-leak"));
        return true;
      },
    );
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("InfermaticProvider signale proprement une réponse sans choix (modèle incompatible chat)", async () => {
  const originalFetch = globalThis.fetch;
  try {
    globalThis.fetch = async () =>
      new Response(JSON.stringify({}), { status: 200, headers: { "content-type": "application/json" } });

    const provider = new InfermaticProvider({ apiKey: "k", baseUrl: "https://api.totalgpt.ai/v1", model: "m" });
    await assert.rejects(
      () => provider.complete([{ role: "user", content: "hi" }]),
      (err: Error) => {
        assert.match(err.message, /sans choix/i);
        return true;
      },
    );
  } finally {
    globalThis.fetch = originalFetch;
  }
});
