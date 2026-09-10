import { test } from "node:test";
import assert from "node:assert/strict";
import type { ChatMessage } from "../types.js";
import type { CompletionOptions, LLMProvider } from "../llm/provider.js";
import { ReflectionEngine } from "./reflectionEngine.js";
import { MemoryManager } from "../memory/memoryManager.js";
import { LocalHashingEmbeddingProvider } from "../llm/embeddings.js";
import { closeDb, getDb } from "../persistence/db.js";
import { config } from "../config.js";

function setupTestDb() {
  config.db.path = ":memory:";
  closeDb();
  getDb();
}

function makeSpyProvider(name: string, reply: string) {
  let calls = 0;
  const provider: LLMProvider = {
    name,
    async complete(_messages: ChatMessage[], _options?: CompletionOptions) {
      calls += 1;
      return { content: reply, toolCalls: undefined };
    },
  };
  return {
    provider,
    get calls() {
      return calls;
    },
  };
}

test("ReflectionEngine.setLLMProvider() route reflect() vers le nouveau fournisseur (point 3 de l'audit)", async () => {
  const memory = new MemoryManager(new LocalHashingEmbeddingProvider());
  await memory.recordTurn({ role: "user", content: "Le ciel est bleu aujourd'hui." });
  await memory.recordTurn({ role: "assistant", content: "Oui, il fait beau." });

  const providerA = makeSpyProvider("provider-a", "[A] insight");
  const providerB = makeSpyProvider("provider-b", "[B] insight");

  const engine = new ReflectionEngine(providerA.provider, memory, 1);

  const firstInsight = await engine.reflect();
  assert.equal(firstInsight, "[A] insight");
  assert.equal(providerA.calls, 1);
  assert.equal(providerB.calls, 0);

  engine.setLLMProvider(providerB.provider);

  const secondInsight = await engine.reflect();
  assert.equal(secondInsight, "[B] insight");
  assert.equal(providerA.calls, 1, "l'ancien provider ne doit plus être sollicité après setLLMProvider");
  assert.equal(providerB.calls, 1, "le nouveau provider doit être utilisé après setLLMProvider");
});

// ---------------------------------------------------------------------------
// CORRECTION BLOQUANTE (audit PR #59, suite) : ReflectionEngine lisait
// this.memory.working.recent(...) — l'historique GLOBAL — et enregistrait
// l'insight sans workspaceId, même quand projects.projectIsolation est actif.
// ---------------------------------------------------------------------------

test("REFLECTION ISOLATION (TEST 1): le transcript analysé pour un workspace ne contient jamais les messages d'un autre workspace", async () => {
  setupTestDb();
  const previousIsolation = config.projects.projectIsolation;
  config.projects.projectIsolation = true;
  try {
    const memory = new MemoryManager(new LocalHashingEmbeddingProvider());
    let capturedTranscript = "";
    const spy: LLMProvider = {
      name: "reflect-spy-transcript",
      async complete(messages: ChatMessage[]) {
        capturedTranscript = String(messages.find((m) => m.role === "user")?.content ?? "");
        return { content: "Insight B" };
      },
    };
    const engine = new ReflectionEngine(spy, memory, 2);

    await memory.recordTurn({ role: "user", content: "Message confidentiel du projet A1" }, "workspace-a");
    await memory.recordTurn({ role: "assistant", content: "Réponse assistant du projet A1" }, "workspace-a");

    await memory.recordTurn({ role: "user", content: "Message du projet B1" }, "workspace-b");
    await memory.recordTurn({ role: "assistant", content: "Réponse assistant du projet B1" }, "workspace-b");

    await engine.maybeReflect("workspace-b");
    const insight = await engine.maybeReflect("workspace-b");

    assert.equal(insight, "Insight B", "le seuil (2) doit déclencher la réflexion pour B");
    assert.equal(capturedTranscript.includes("projet A1"), false, "aucun message A dans le transcript analysé pour B");
    assert.ok(capturedTranscript.includes("Message du projet B1"), "le message B doit être présent");
    assert.ok(capturedTranscript.includes("Réponse assistant du projet B1"), "la réponse B doit être présente");
  } finally {
    config.projects.projectIsolation = previousIsolation;
  }
});

test("REFLECTION ISOLATION (TEST 2): la réflexion produite pour un workspace est stockée avec ce workspaceId et invisible depuis un autre", async () => {
  setupTestDb();
  const previousIsolation = config.projects.projectIsolation;
  config.projects.projectIsolation = true;
  try {
    const memory = new MemoryManager(new LocalHashingEmbeddingProvider());
    const spy: LLMProvider = {
      name: "reflect-spy-scope",
      async complete() {
        return { content: "Enseignement unique du projet B concernant Zorblax" };
      },
    };
    const engine = new ReflectionEngine(spy, memory, 1);

    await memory.recordTurn({ role: "user", content: "Message B" }, "workspace-b");
    const insight = await engine.maybeReflect("workspace-b");
    assert.equal(insight, "Enseignement unique du projet B concernant Zorblax");

    const foundInA = await memory.vector.search("Enseignement unique du projet B concernant Zorblax", 5, { workspaceId: "workspace-a" });
    assert.equal(
      foundInA.some((r) => r.text.includes("Zorblax")),
      false,
      "la réflexion de B ne doit jamais apparaître dans une recherche du workspace A",
    );

    const foundInB = await memory.vector.search("Enseignement unique du projet B concernant Zorblax", 5, { workspaceId: "workspace-b" });
    assert.ok(
      foundInB.some((r) => r.text.includes("Zorblax") && r.kind === "reflection"),
      "la réflexion doit être retrouvable, avec le bon kind, depuis son propre workspace",
    );
  } finally {
    config.projects.projectIsolation = previousIsolation;
  }
});

test("REFLECTION ISOLATION (TEST 3): le compteur de seuil est isolé par workspace", async () => {
  setupTestDb();
  const previousIsolation = config.projects.projectIsolation;
  config.projects.projectIsolation = true;
  try {
    const memory = new MemoryManager(new LocalHashingEmbeddingProvider());
    let reflectionCalls = 0;
    const spy: LLMProvider = {
      name: "counter-spy",
      async complete() {
        reflectionCalls += 1;
        return { content: "insight" };
      },
    };
    const engine = new ReflectionEngine(spy, memory, 3);

    await memory.recordTurn({ role: "user", content: "A1" }, "workspace-a");
    assert.equal(await engine.maybeReflect("workspace-a"), null);
    await memory.recordTurn({ role: "user", content: "A2" }, "workspace-a");
    assert.equal(await engine.maybeReflect("workspace-a"), null);

    // B n'a fait qu'un seul tour : même après 2 tours de A, son propre compteur ne doit
    // valoir que 1 (jamais 3) — les cycles doivent rester logiquement séparés.
    await memory.recordTurn({ role: "user", content: "B1" }, "workspace-b");
    const resultAfterB1 = await engine.maybeReflect("workspace-b");
    assert.equal(resultAfterB1, null, "1 seul tour de B ne doit pas déclencher le seuil 3, quel que soit l'état de A");
    assert.equal(reflectionCalls, 0);

    await memory.recordTurn({ role: "user", content: "B2" }, "workspace-b");
    assert.equal(await engine.maybeReflect("workspace-b"), null);
    await memory.recordTurn({ role: "user", content: "B3" }, "workspace-b");
    const resultAtThreshold = await engine.maybeReflect("workspace-b");
    assert.equal(resultAtThreshold, "insight", "le seuil de B doit se déclencher sur son propre cycle de 3 tours");
    assert.equal(reflectionCalls, 1);
  } finally {
    config.projects.projectIsolation = previousIsolation;
  }
});

test("REFLECTION ISOLATION (TEST 4): projectIsolation=false conserve le comportement global historique", async () => {
  setupTestDb();
  const previousIsolation = config.projects.projectIsolation;
  config.projects.projectIsolation = false;
  try {
    const memory = new MemoryManager(new LocalHashingEmbeddingProvider());
    let capturedTranscript = "";
    const spy: LLMProvider = {
      name: "global-spy",
      async complete(messages: ChatMessage[]) {
        capturedTranscript = String(messages.find((m) => m.role === "user")?.content ?? "");
        return { content: "insight global" };
      },
    };
    const engine = new ReflectionEngine(spy, memory, 1);

    await memory.recordTurn({ role: "user", content: "Message du projet A" }, "workspace-a");
    await memory.recordTurn({ role: "user", content: "Message du projet B" }, "workspace-b");
    await engine.maybeReflect("workspace-b");

    assert.ok(capturedTranscript.includes("Message du projet A"), "sans isolation, l'historique global reste mélangé (comportement historique)");
    assert.ok(capturedTranscript.includes("Message du projet B"));
  } finally {
    config.projects.projectIsolation = previousIsolation;
  }
});

test("REFLECTION ISOLATION (TEST 5): sans workspaceId, comportement global sûr sans crash", async () => {
  setupTestDb();
  const previousIsolation = config.projects.projectIsolation;
  config.projects.projectIsolation = true;
  try {
    const memory = new MemoryManager(new LocalHashingEmbeddingProvider());
    const spy: LLMProvider = {
      name: "no-workspace-spy",
      async complete() {
        return { content: "insight sans workspace" };
      },
    };
    const engine = new ReflectionEngine(spy, memory, 1);

    await memory.recordTurn({ role: "user", content: "Message sans workspace" });
    const insight = await engine.maybeReflect();
    assert.equal(insight, "insight sans workspace");
  } finally {
    config.projects.projectIsolation = previousIsolation;
  }
});
