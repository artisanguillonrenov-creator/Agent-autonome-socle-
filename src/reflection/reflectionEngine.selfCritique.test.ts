import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
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

function isReflectionSystemPrompt(messages: ChatMessage[]): boolean {
  const system = messages[0]?.content;
  return typeof system === "string" && system.includes("module de réflexion");
}

test("une auto-critique insatisfaisante déclenche l'évolution de prompt même sans self-healing détecté par pattern", async () => {
  setupTestDb();
  const dir = mkdtempSync(join(tmpdir(), "reflection-self-critique-"));
  const rulesPath = join(dir, "dynamic_rules.json");
  const previousEnabled = config.promptEvolution.enabled;
  const previousPath = config.promptEvolution.rulesPath;
  config.promptEvolution.enabled = true;
  config.promptEvolution.rulesPath = rulesPath;
  try {
    const memory = new MemoryManager(new LocalHashingEmbeddingProvider());
    await memory.recordTurn({ role: "user", content: "Fais X" });
    await memory.recordTurn({ role: "assistant", content: "J'ai fait X mais mal." });

    const provider: LLMProvider = {
      name: "critique-spy",
      async complete(messages: ChatMessage[], _options?: CompletionOptions) {
        if (isReflectionSystemPrompt(messages)) {
          return {
            content:
              "Résumé bref de l'échange.\n" +
              '###CRITIQUE###\n{"score":0.2,"issues":["a répété la même erreur de format"]}',
          };
        }
        return { content: "Toujours revalider le format de sortie avant de répondre." };
      },
    };

    const engine = new ReflectionEngine(provider, memory, 1);
    const insight = await engine.reflect();

    assert.equal(insight, "Résumé bref de l'échange.", "l'insight ne doit pas inclure le bloc CRITIQUE");
    const rules = JSON.parse(readFileSync(rulesPath, "utf-8")) as string[];
    assert.ok(
      rules.some((r) => r.toLowerCase().includes("revalider")),
      "une règle d'or doit avoir été extraite malgré l'absence de correction de self-healing par pattern",
    );
  } finally {
    config.promptEvolution.enabled = previousEnabled;
    config.promptEvolution.rulesPath = previousPath;
    rmSync(dir, { recursive: true, force: true });
  }
});

test("un triplet suivi d'un bloc critique est extrait correctement, sans que le tableau issues ne pollue le JSON des triplets", async () => {
  setupTestDb();
  const memory = new MemoryManager(new LocalHashingEmbeddingProvider());
  await memory.recordTurn({ role: "user", content: "Jarvis est développé par artisanguillonrenov." });

  const provider: LLMProvider = {
    name: "combined-blocks-spy",
    async complete(messages: ChatMessage[]) {
      if (isReflectionSystemPrompt(messages)) {
        return {
          content:
            "Résumé.\n" +
            '###TRIPLES###\n[{"subject":"Jarvis","predicate":"développé par","object":"artisanguillonrenov"}]\n' +
            '###CRITIQUE###\n{"score":0.9,"issues":["détail mineur", "autre détail"]}',
        };
      }
      return { content: "ne devrait pas être appelé (score satisfaisant)" };
    },
  };

  const engine = new ReflectionEngine(provider, memory, 1);
  await engine.reflect();

  const triples = memory.graph.all();
  assert.equal(triples.length, 1, "le triplet doit être extrait malgré le bloc critique qui le suit");
  assert.equal(triples[0].subject, "Jarvis");
  assert.equal(triples[0].object, "artisanguillonrenov");
  assert.ok(
    triples[0].confidence < 0.4,
    "un triplet fraîchement extrait par la réflexion doit rester sous le seuil par défaut de rétention, sinon aucun réglage ne peut jamais le purger",
  );
});

test("une auto-critique satisfaisante ne déclenche pas l'évolution de prompt", async () => {
  setupTestDb();
  const dir = mkdtempSync(join(tmpdir(), "reflection-self-critique-"));
  const rulesPath = join(dir, "dynamic_rules.json");
  const previousEnabled = config.promptEvolution.enabled;
  const previousPath = config.promptEvolution.rulesPath;
  config.promptEvolution.enabled = true;
  config.promptEvolution.rulesPath = rulesPath;
  try {
    const memory = new MemoryManager(new LocalHashingEmbeddingProvider());
    await memory.recordTurn({ role: "user", content: "Fais Y" });
    await memory.recordTurn({ role: "assistant", content: "Fait sans problème." });

    let evolutionCalls = 0;
    const provider: LLMProvider = {
      name: "critique-satisfied-spy",
      async complete(messages: ChatMessage[]) {
        if (isReflectionSystemPrompt(messages)) {
          return { content: "Tout va bien.\n###CRITIQUE###\n{\"score\":0.95,\"issues\":[]}" };
        }
        evolutionCalls += 1;
        return { content: "Ne devrait jamais être appelé." };
      },
    };

    const engine = new ReflectionEngine(provider, memory, 1);
    const insight = await engine.reflect();

    assert.equal(insight, "Tout va bien.");
    assert.equal(evolutionCalls, 0, "promptEvolver ne doit pas être déclenché pour une trajectoire jugée satisfaisante");
    assert.throws(() => readFileSync(rulesPath, "utf-8"), "aucun fichier de règles ne doit être créé");
  } finally {
    config.promptEvolution.enabled = previousEnabled;
    config.promptEvolution.rulesPath = previousPath;
    rmSync(dir, { recursive: true, force: true });
  }
});
