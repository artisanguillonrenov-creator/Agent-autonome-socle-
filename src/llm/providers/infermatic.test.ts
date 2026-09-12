import { test } from "node:test";
import assert from "node:assert/strict";
import { InfermaticProvider, sanitizeInfermaticVisibleContent } from "./infermatic.js";

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

test("InfermaticProvider.supportsNativeTools() est vrai (tool calling natif disponible)", () => {
  const provider = new InfermaticProvider({ apiKey: "k", baseUrl: "https://api.totalgpt.ai/v1", model: "m" });
  assert.equal(provider.supportsNativeTools(), true);
});

test("InfermaticProvider envoie tools + tool_choice quand des tools sont fournis, sans imposer parallel_tool_calls", async () => {
  const originalFetch = globalThis.fetch;
  let sentBody: any = null;
  try {
    globalThis.fetch = (async (_url: unknown, init?: RequestInit) => {
      sentBody = JSON.parse(init?.body as string);
      return new Response(JSON.stringify({ choices: [{ message: { content: "réponse naturelle" } }] }), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    }) as typeof fetch;

    const provider = new InfermaticProvider({ apiKey: "k", baseUrl: "https://api.totalgpt.ai/v1", model: "m" });
    const tools = [
      {
        type: "function" as const,
        function: { name: "web_search", description: "search", parameters: { type: "object" as const, properties: {} } },
      },
    ];

    await provider.complete([{ role: "user", content: "cherche" }], { tools });
    assert.deepEqual(sentBody.tools, tools);
    assert.equal(sentBody.tool_choice, "auto");
    assert.equal("parallel_tool_calls" in sentBody, false, "parallel_tool_calls ne doit jamais être imposé sans validation Infermatic");

    await provider.complete([{ role: "user", content: "cherche" }], {
      tools,
      toolChoice: { type: "function", function: { name: "web_search" } },
    });
    assert.deepEqual(sentBody.tool_choice, { type: "function", function: { name: "web_search" } });
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("InfermaticProvider formate un message assistant avec tool_calls et un résultat tool avec tool_call_id/name conservés", async () => {
  const originalFetch = globalThis.fetch;
  let sentBody: any = null;
  try {
    globalThis.fetch = (async (_url: unknown, init?: RequestInit) => {
      sentBody = JSON.parse(init?.body as string);
      return new Response(JSON.stringify({ choices: [{ message: { content: "suite" } }] }), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    }) as typeof fetch;

    const provider = new InfermaticProvider({ apiKey: "k", baseUrl: "https://api.totalgpt.ai/v1", model: "m" });
    await provider.complete([
      { role: "user", content: "recherche" },
      {
        role: "assistant",
        content: null,
        toolCalls: [{ id: "call_1", type: "function", function: { name: "web_search", arguments: '{"query":"test"}' } }],
      },
      { role: "tool", toolCallId: "call_1", name: "web_search", content: "résultat web" },
    ]);

    assert.equal(sentBody.messages[1].role, "assistant");
    assert.equal(sentBody.messages[1].content, null);
    assert.deepEqual(sentBody.messages[1].tool_calls, [
      { id: "call_1", type: "function", function: { name: "web_search", arguments: '{"query":"test"}' } },
    ]);

    assert.equal(sentBody.messages[2].role, "tool");
    assert.equal(sentBody.messages[2].tool_call_id, "call_1");
    assert.equal(sentBody.messages[2].name, "web_search");
    assert.equal(sentBody.messages[2].content, "résultat web");
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("InfermaticProvider préserve à l'identique 2+ toolCallId dans le même tour, sans message role:'user' synthétique dupliqué", async () => {
  const originalFetch = globalThis.fetch;
  let sentBody: any = null;
  try {
    globalThis.fetch = (async (_url: unknown, init?: RequestInit) => {
      sentBody = JSON.parse(init?.body as string);
      return new Response(JSON.stringify({ choices: [{ message: { content: "suite" } }] }), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    }) as typeof fetch;

    const provider = new InfermaticProvider({ apiKey: "k", baseUrl: "https://api.totalgpt.ai/v1", model: "m" });
    await provider.complete([
      { role: "user", content: "donne-moi l'heure et mes tâches" },
      {
        role: "assistant",
        content: null,
        toolCalls: [
          { id: "call_time_101", type: "function", function: { name: "get_current_time", arguments: "{}" } },
          { id: "call_tasks_102", type: "function", function: { name: "list_tasks", arguments: '{"status":"pending"}' } },
        ],
      },
      { role: "tool", toolCallId: "call_time_101", name: "get_current_time", content: "12:00" },
      { role: "tool", toolCallId: "call_tasks_102", name: "list_tasks", content: "aucune tâche" },
    ]);

    // Exactement 4 messages envoyés : user, assistant(tool_calls), tool, tool — aucun
    // role "user" synthétique ajouté après l'exécution des tools natifs.
    assert.equal(sentBody.messages.length, 4);
    assert.deepEqual(sentBody.messages.map((m: any) => m.role), ["user", "assistant", "tool", "tool"]);

    assert.equal(sentBody.messages[2].tool_call_id, "call_time_101");
    assert.equal(sentBody.messages[3].tool_call_id, "call_tasks_102");
    assert.deepEqual(sentBody.messages[1].tool_calls.map((c: any) => c.id), ["call_time_101", "call_tasks_102"]);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("InfermaticProvider restitue les tool_calls (id, name, arguments) exactement tels que renvoyés, y compris s'il y en a plusieurs", async () => {
  const originalFetch = globalThis.fetch;
  try {
    globalThis.fetch = async () =>
      new Response(
        JSON.stringify({
          choices: [
            {
              message: {
                content: null,
                tool_calls: [
                  { id: "call_a", type: "function", function: { name: "tool_a", arguments: '{"x":1}' } },
                  { id: "call_b", type: "function", function: { name: "tool_b", arguments: '{"y":"z"}' } },
                ],
              },
            },
          ],
        }),
        { status: 200, headers: { "content-type": "application/json" } },
      );

    const provider = new InfermaticProvider({ apiKey: "k", baseUrl: "https://api.totalgpt.ai/v1", model: "m" });
    const result = await provider.complete([{ role: "user", content: "fais deux choses" }]);

    assert.equal(result.content, null);
    assert.equal(result.toolCalls?.length, 2);
    assert.deepEqual(result.toolCalls?.[0], { id: "call_a", type: "function", function: { name: "tool_a", arguments: '{"x":1}' } });
    assert.deepEqual(result.toolCalls?.[1], { id: "call_b", type: "function", function: { name: "tool_b", arguments: '{"y":"z"}' } });
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("InfermaticProvider renvoie une réponse naturelle sans tool_calls quand le modèle répond en texte", async () => {
  const originalFetch = globalThis.fetch;
  try {
    globalThis.fetch = async () =>
      new Response(JSON.stringify({ choices: [{ message: { content: "Bonjour, comment puis-je aider ?" } }] }), {
        status: 200,
        headers: { "content-type": "application/json" },
      });

    const provider = new InfermaticProvider({ apiKey: "k", baseUrl: "https://api.totalgpt.ai/v1", model: "m" });
    const result = await provider.complete([{ role: "user", content: "salut" }]);

    assert.equal(result.content, "Bonjour, comment puis-je aider ?");
    assert.equal(result.toolCalls, undefined);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

// --- sanitizeInfermaticVisibleContent : masquage du raisonnement interne Qwen ---

test("sanitizeInfermaticVisibleContent supprime un bloc <think> unique et garde le reste", () => {
  const raw = "<think>Internal reasoning</think>\nBonjour";
  assert.equal(sanitizeInfermaticVisibleContent(raw), "Bonjour");
});

test("sanitizeInfermaticVisibleContent supprime un bloc <think> multi-lignes en anglais", () => {
  const raw = "<think>\nEnglish reasoning\nline 2\nline 3\n</think>\n\nBonjour, que puis-je faire pour vous ?";
  assert.equal(sanitizeInfermaticVisibleContent(raw), "Bonjour, que puis-je faire pour vous ?");
});

test("sanitizeInfermaticVisibleContent laisse inchangé un texte normal sans balise <think>", () => {
  assert.equal(sanitizeInfermaticVisibleContent("Bonjour"), "Bonjour");
  assert.equal(
    sanitizeInfermaticVisibleContent("Explication technique normale sans balise think."),
    "Explication technique normale sans balise think.",
  );
});

test("sanitizeInfermaticVisibleContent supprime plusieurs blocs <think> successifs", () => {
  const raw = "<think>A</think>\n<think>B</think>\nRéponse finale";
  assert.equal(sanitizeInfermaticVisibleContent(raw), "Réponse finale");
});

test("sanitizeInfermaticVisibleContent renvoie null pour un bloc <think> jamais refermé", () => {
  const raw = "<think>\nraisonnement non terminé";
  const cleaned = sanitizeInfermaticVisibleContent(raw);
  assert.equal(cleaned, null);
  assert.ok(cleaned === null || !cleaned.includes("raisonnement"));
});

test("sanitizeInfermaticVisibleContent traite un </think> résiduel sans ouverture comme raisonnement", () => {
  const raw = "raisonnement interne...\n</think>\nBonjour";
  assert.equal(sanitizeInfermaticVisibleContent(raw), "Bonjour");
});

test("sanitizeInfermaticVisibleContent est insensible à la casse des balises", () => {
  const raw = "<THINK>Reasoning</THINK>\nBonjour";
  assert.equal(sanitizeInfermaticVisibleContent(raw), "Bonjour");
});

test("sanitizeInfermaticVisibleContent renvoie null quand rawContent est null ou vide", () => {
  assert.equal(sanitizeInfermaticVisibleContent(null), null);
  assert.equal(sanitizeInfermaticVisibleContent(undefined), null);
  assert.equal(sanitizeInfermaticVisibleContent(""), null);
  assert.equal(sanitizeInfermaticVisibleContent("<think>tout est raisonnement</think>"), null);
});

// --- complete() : sanitizeReasoning est opt-in, jamais appliqué par défaut ---
//
// InfermaticProvider est partagé par le chat Jarvis ET par la Software Factory
// (génération de code). Le nettoyage du raisonnement ne doit donc JAMAIS s'appliquer
// automatiquement à tous les appels : il ne doit s'activer que pour les points d'entrée
// du chat Jarvis qui passent explicitement `sanitizeReasoning: true` (voir index.ts /
// httpApi.ts / softwareFactoryService.ts).

test("InfermaticProvider (sanitizeReasoning: true) masque le raisonnement <think> dans content quand un tool_call est présent (tool_calls conservés)", async () => {
  const originalFetch = globalThis.fetch;
  try {
    const toolCalls = [{ id: "call_1", type: "function", function: { name: "web_search", arguments: '{"query":"test"}' } }];
    globalThis.fetch = async () =>
      new Response(
        JSON.stringify({
          choices: [
            {
              message: {
                content: "<think>reasoning</think>",
                tool_calls: toolCalls,
              },
            },
          ],
        }),
        { status: 200, headers: { "content-type": "application/json" } },
      );

    const provider = new InfermaticProvider({
      apiKey: "k",
      baseUrl: "https://api.totalgpt.ai/v1",
      model: "m",
      sanitizeReasoning: true,
    });
    const result = await provider.complete([{ role: "user", content: "cherche" }]);

    assert.equal(result.content, null);
    assert.deepEqual(result.toolCalls, toolCalls);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("InfermaticProvider (sanitizeReasoning: true) nettoie content en <think>...</think>\\nBonjour tout en conservant les tool_calls à l'identique", async () => {
  const originalFetch = globalThis.fetch;
  try {
    const toolCalls = [{ id: "call_2", type: "function", function: { name: "web_search", arguments: '{"query":"autre"}' } }];
    globalThis.fetch = async () =>
      new Response(
        JSON.stringify({
          choices: [
            {
              message: {
                content: "<think>reasoning</think>\nBonjour",
                tool_calls: toolCalls,
              },
            },
          ],
        }),
        { status: 200, headers: { "content-type": "application/json" } },
      );

    const provider = new InfermaticProvider({
      apiKey: "k",
      baseUrl: "https://api.totalgpt.ai/v1",
      model: "m",
      sanitizeReasoning: true,
    });
    const result = await provider.complete([{ role: "user", content: "cherche" }]);

    assert.equal(result.content, "Bonjour");
    assert.deepEqual(result.toolCalls, toolCalls);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("InfermaticProvider sans sanitizeReasoning (défaut) renvoie content brut, <think> compris — comportement Software Factory", async () => {
  const originalFetch = globalThis.fetch;
  try {
    globalThis.fetch = async () =>
      new Response(JSON.stringify({ choices: [{ message: { content: "<think>reasoning</think>\nBonjour" } }] }), {
        status: 200,
        headers: { "content-type": "application/json" },
      });

    const provider = new InfermaticProvider({ apiKey: "k", baseUrl: "https://api.totalgpt.ai/v1", model: "m" });
    const result = await provider.complete([{ role: "user", content: "génère du code" }]);

    assert.equal(result.content, "<think>reasoning</think>\nBonjour");
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("InfermaticProvider avec sanitizeReasoning: false explicite ne tronque jamais du code légitime contenant un <think> littéral non fermé", async () => {
  const originalFetch = globalThis.fetch;
  try {
    // Cas rapporté à l'audit de la PR : un modèle Infermatic (via la Software Factory)
    // peut légitimement générer du code source contenant la chaîne "<think>" sans jamais
    // la refermer (ex. une constante nommant une balise). Sans opt-in explicite, cela ne
    // doit JAMAIS être traité comme un raisonnement non terminé ni tronquer le fichier.
    const legitimateCode = 'const OPEN_TAG = "<think>";\nconst x = 1;';
    globalThis.fetch = async () =>
      new Response(JSON.stringify({ choices: [{ message: { content: legitimateCode } }] }), {
        status: 200,
        headers: { "content-type": "application/json" },
      });

    const provider = new InfermaticProvider({
      apiKey: "k",
      baseUrl: "https://api.totalgpt.ai/v1",
      model: "m",
      sanitizeReasoning: false,
    });
    const result = await provider.complete([{ role: "user", content: "génère du code" }]);

    assert.equal(result.content, legitimateCode);
    assert.ok(result.content?.includes("const x = 1;"), "le code après le <think> littéral ne doit pas être tronqué");
  } finally {
    globalThis.fetch = originalFetch;
  }
});
