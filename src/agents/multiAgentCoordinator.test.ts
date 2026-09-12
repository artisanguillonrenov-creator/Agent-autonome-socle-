import { test } from "node:test";
import assert from "node:assert/strict";
import type { ChatMessage, SkillContext, SkillDefinition } from "../types.js";
import type { CompletionOptions, LLMProvider } from "../llm/provider.js";
import { SkillRegistry } from "../skills/registry.js";
import { LocalHashingEmbeddingProvider } from "../llm/embeddings.js";
import { closeDb, getDb } from "../persistence/db.js";
import { config } from "../config.js";
import { AgentProfileRegistry } from "./agentProfileRegistry.js";
import { AgentTeamStore } from "./agentTeamStore.js";
import { MultiAgentCoordinator } from "./multiAgentCoordinator.js";
import type { AgentProfileDefinition } from "./types.js";

function setupTestDb() {
  config.db.path = ":memory:";
  closeDb();
  getDb();
}

const profileA: AgentProfileDefinition = { id: "a", name: "Agent A", role: "a", systemPrompt: "Tu es A.", enabled: true, allowedSkills: [], order: 1 };
const profileB: AgentProfileDefinition = { id: "b", name: "Agent B", role: "b", systemPrompt: "Tu es B.", enabled: true, allowedSkills: [], order: 2 };

function providerRoutingBySystemPrompt(): LLMProvider {
  return {
    name: "team-routing",
    async complete(messages: ChatMessage[], _options?: CompletionOptions) {
      const system = messages.find((m) => m.role === "system")?.content ?? "";
      if (system.includes("Tu es A.")) return { content: "Contribution de A" };
      if (system.includes("Tu es B.")) return { content: "Contribution de B" };
      return { content: "?" };
    },
  };
}

test("MultiAgentCoordinator.run() fait collaborer les profils dans l'ordre déclaré et journalise le transcript durablement", async () => {
  setupTestDb();
  const skills = new SkillRegistry(new LocalHashingEmbeddingProvider());
  const registry = new AgentProfileRegistry(undefined, [profileB, profileA]); // ordre volontairement inversé, doit être trié
  const store = new AgentTeamStore();
  const coordinator = new MultiAgentCoordinator(providerRoutingBySystemPrompt(), skills, registry, store);

  const result = await coordinator.run("Objectif partagé");

  assert.equal(result.finalResponse, "Contribution de B", "le dernier profil (ordre 2) produit la réponse finale");
  assert.equal(result.transcript.length, 2);
  assert.equal(result.transcript[0].agentId, "a");
  assert.equal(result.transcript[1].agentId, "b");

  const run = store.get(result.teamRunId);
  assert.equal(run?.status, "COMPLETED");
  assert.equal(run?.currentIndex, 2);
});

test("MultiAgentCoordinator.resume() reprend une session interrompue après le dernier tour durablement enregistré", async () => {
  setupTestDb();
  const skills = new SkillRegistry(new LocalHashingEmbeddingProvider());
  const registry = new AgentProfileRegistry(undefined, [profileA, profileB]);
  const store = new AgentTeamStore();
  const coordinator = new MultiAgentCoordinator(providerRoutingBySystemPrompt(), skills, registry, store);

  // Simule un crash serveur survenu juste après le tour de l'agent A : le message de A
  // est déjà durablement enregistré, mais le run reste au statut RUNNING (jamais marqué
  // COMPLETED ni FAILED), exactement ce qu'un arrêt brutal laisserait derrière lui.
  const run = store.createRun({ objective: "Objectif interrompu", profileIds: ["a", "b"], maxRounds: 1 });
  store.appendMessage(run.id, "a", "assistant", "Contribution de A");
  store.advance(run.id, 1, 0);

  const result = await coordinator.resume(run.id);

  assert.equal(result.finalResponse, "Contribution de B");
  assert.equal(result.transcript.length, 2, "le message pré-existant de A est conservé, pas rejoué");
  assert.equal(result.transcript[0].content, "Contribution de A");
  assert.equal(result.transcript[1].content, "Contribution de B");
  assert.equal(store.get(run.id)?.status, "COMPLETED");
});

test("MultiAgentCoordinator restreint chaque agent à son pool de compétences autorisées", async () => {
  setupTestDb();
  const skills = new SkillRegistry(new LocalHashingEmbeddingProvider());
  const echoSkill: SkillDefinition = {
    name: "echo_tool",
    description: "Renvoie l'entrée telle quelle.",
    argsHint: "{}",
    parameters: { type: "object", properties: { value: { type: "string" } }, required: ["value"], additionalProperties: false },
    handler: async (input) => `echoed:${String(input.value)}`,
  };
  skills.register(echoSkill);

  const toolUser: AgentProfileDefinition = { id: "tool-user", name: "Outilleur", role: "tool", systemPrompt: "Tu utilises des outils.", enabled: true, allowedSkills: ["echo_tool"], order: 1 };
  const noToolAgent: AgentProfileDefinition = { id: "no-tool", name: "Sans outil", role: "notool", systemPrompt: "Tu n'utilises jamais d'outil.", enabled: true, allowedSkills: [], order: 2 };

  let toolStep = 0;
  const provider: LLMProvider = {
    name: "tool-routing",
    async complete(messages: ChatMessage[], options?: CompletionOptions) {
      const system = messages.find((m) => m.role === "system")?.content ?? "";
      if (system.includes("utilises des outils")) {
        toolStep += 1;
        if (toolStep === 1) {
          assert.ok(options?.tools?.some((t) => t.function.name === "echo_tool"), "echo_tool doit être exposé à l'agent autorisé");
          return { content: null, toolCalls: [{ id: "call_1", type: "function", function: { name: "echo_tool", arguments: '{"value":"hello"}' } }] };
        }
        return { content: "Outil exécuté avec succès." };
      }
      assert.equal(options?.tools, undefined, "un agent sans compétence autorisée ne doit se voir proposer aucun outil");
      return { content: "Rien à ajouter." };
    },
  };

  const registry = new AgentProfileRegistry(undefined, [toolUser, noToolAgent]);
  const store = new AgentTeamStore();
  const coordinator = new MultiAgentCoordinator(provider, skills, registry, store);
  const rememberFact: SkillContext["rememberFact"] = () => undefined;

  const result = await coordinator.run("Utilise l'outil disponible", { skillContext: { rememberFact } });

  assert.equal(result.transcript[0].content, "Outil exécuté avec succès.");
  assert.equal(result.transcript[1].content, "Rien à ajouter.");
});
