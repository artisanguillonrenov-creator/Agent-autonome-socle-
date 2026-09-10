import test from "node:test";
import assert from "node:assert/strict";
import { Agent } from "../core/agent.js";
import { config } from "../config.js";
import { LocalHashingEmbeddingProvider } from "../llm/embeddings.js";
import type { LLMProvider, CompletionOptions, LLMCompletionResult } from "../llm/provider.js";
import { closeDb, getDb } from "../persistence/db.js";
import { ServiceAdapter, type ServiceAdapterResponse } from "../orchestration/serviceAdapter.js";
import type { ServiceDefinition } from "../orchestration/serviceRegistry.js";
import { ServiceOrchestrator } from "../orchestration/serviceOrchestrator.js";
import { CONTRACT_SCHEMA_VERSION, type ServiceEvent, type TaskRequest } from "../orchestration/contract.js";
import type { ChatMessage, SkillDefinition } from "../types.js";
import { SkillRegistry } from "./registry.js";
import { SkillSelector, detectSoftwareModificationIntent } from "./selector.js";

function setupDb(): void {
  config.db.path = ":memory:";
  config.autonomy.globalRiskLevel = "MEDIUM";
  config.autonomy.permissionMatrix = "EXECUTE";
  closeDb();
  getDb();
}

function legacySkill(name: string, availability: SkillDefinition["availability"] = "AVAILABLE"): SkillDefinition {
  return {
    name,
    description: name,
    argsHint: "{}",
    availability,
    exposure: "DYNAMIC",
    handler: async () => "ok",
    parameters: { type: "object", properties: {}, additionalProperties: false },
  };
}

test("detectSoftwareModificationIntent cible Jarvis/le code sans faux positifs éditoriaux", () => {
  const positives = [
    "améliore ta mémoire",
    "corrige ce bug",
    "répare Jarvis",
    "modifie ton code",
    "Ajoute cette fonction à ton application",
    "Patch ce bug GitHub",
  ];
  const negatives = [
    "améliore mon texte",
    "ajoute un rappel demain",
    "corrige l'orthographe de cette phrase",
    "améliore cette image",
  ];
  for (const input of positives) assert.equal(detectSoftwareModificationIntent(input), true, input);
  for (const input of negatives) assert.equal(detectSoftwareModificationIntent(input), false, input);
});

test("une intention logicielle expose knowledge_search et software_development ensemble", async () => {
  setupDb();
  const embeddings = new LocalHashingEmbeddingProvider();
  const registry = new SkillRegistry(embeddings);
  registry.register(legacySkill("knowledge_search"));
  registry.register(legacySkill("software_development"));
  registry.register(legacySkill("remember_fact"));
  const selector = new SkillSelector(registry, 3);
  const names = (await selector.select("améliore ta mémoire")).map((skill) => skill.name);
  assert.ok(names.includes("knowledge_search"));
  assert.ok(names.includes("software_development"));
});

test("l'injection ne contourne pas un skill software_development indisponible", async () => {
  setupDb();
  const embeddings = new LocalHashingEmbeddingProvider();
  const registry = new SkillRegistry(embeddings);
  registry.register(legacySkill("knowledge_search"));
  registry.register(legacySkill("software_development", "UNAVAILABLE"));
  const selector = new SkillSelector(registry, 3);
  const names = (await selector.select("corrige ce bug dans Jarvis")).map((skill) => skill.name);
  assert.ok(names.includes("knowledge_search"));
  assert.ok(!names.includes("software_development"));
});

class FakeFactoryAdapter extends ServiceAdapter {
  readonly factoryCalls: TaskRequest[] = [];

  override async dispatchTask(value: ServiceDefinition | string, request: TaskRequest): Promise<ServiceAdapterResponse> {
    const serviceId = typeof value === "string" ? value : value.id;
    if (serviceId !== "software_factory") return super.dispatchTask(value, request);
    this.factoryCalls.push(request);
    const events: ServiceEvent[] = [
      {
        schema_version: CONTRACT_SCHEMA_VERSION,
        event_id: `evt-${request.task_id}-accepted-test`,
        task_id: request.task_id,
        trace_id: request.trace_id,
        service: "software_factory",
        sequence: 1,
        type: "TASK_ACCEPTED",
        timestamp: Date.now(),
        payload: { message: "accepted" },
      },
      {
        schema_version: CONTRACT_SCHEMA_VERSION,
        event_id: `evt-${request.task_id}-completed-test`,
        task_id: request.task_id,
        trace_id: request.trace_id,
        service: "software_factory",
        sequence: 2,
        type: "TASK_COMPLETED",
        timestamp: Date.now(),
        payload: {
          status: "COMPLETED",
          branch: "jarvis/test-chain",
          commit_sha: "abc123",
          pr_number: 999,
          pr_url: "https://github.com/example/repo/pull/999",
          filePath: request.context.filePath,
          summary: "Pull Request créée",
        },
      },
    ];
    return { success: true, events, transportDurationMs: 0 };
  }
}

class SequenceLLM implements LLMProvider {
  readonly name = "sequence-test";
  readonly model = "sequence-test-model";
  private call = 0;
  sawSearchResult = false;
  toolSets: string[][] = [];

  async complete(messages: ChatMessage[], options?: CompletionOptions): Promise<LLMCompletionResult> {
    this.toolSets.push((options?.tools ?? []).map((tool) => tool.function.name));
    this.call += 1;
    if (this.call === 1) {
      return {
        content: null,
        toolCalls: [{ id: "call-search", type: "function", function: { name: "knowledge_search", arguments: "{}" } }],
      };
    }
    if (this.call === 2) {
      this.sawSearchResult = messages.some(
        (message) => message.role === "tool" && (message.content ?? "").includes("src/memory/memoryManager.ts"),
      );
      return {
        content: null,
        toolCalls: [
          {
            id: "call-dev",
            type: "function",
            function: {
              name: "software_development",
              arguments: JSON.stringify({
                objective: "Corriger le bug de mémoire identifié",
                filePath: "src/memory/memoryManager.ts",
                instructions: "Corriger le bug identifié sans fusion automatique.",
              }),
            },
          },
        ],
      };
    }
    return { content: "PR créée : https://github.com/example/repo/pull/999" };
  }
}

test("Agent enchaîne knowledge_search puis software_development jusqu'à la PR", async () => {
  setupDb();
  const llm = new SequenceLLM();
  const adapter = new FakeFactoryAdapter();
  const orchestrator = new ServiceOrchestrator({ adapter });
  const agent = new Agent({
    llm,
    embeddings: new LocalHashingEmbeddingProvider(),
    orchestrator,
    maxIterations: 4,
    reflectionEveryNSteps: 999,
  });

  agent.skills.register({
    name: "knowledge_search",
    description: "Inspecte le dépôt de test.",
    argsHint: "{}",
    parameters: { type: "object", properties: {}, additionalProperties: false },
    handler: async () => JSON.stringify({ path: "src/memory/memoryManager.ts", content: "export class MemoryManager {}" }),
  });

  const result = await agent.step("Inspecte ton dépôt et corrige ce bug.");

  assert.equal(llm.sawSearchResult, true, "le tour suivant doit recevoir le résultat de knowledge_search");
  assert.ok(llm.toolSets[0].includes("knowledge_search"));
  assert.ok(llm.toolSets[0].includes("software_development"));
  assert.ok(llm.toolSets[1].includes("knowledge_search"));
  assert.ok(llm.toolSets[1].includes("software_development"));
  assert.equal(adapter.factoryCalls.length, 1, "software_factory doit recevoir exactement une tâche");
  assert.equal(adapter.factoryCalls[0].capability, "software_development");
  assert.equal(adapter.factoryCalls[0].context.filePath, "src/memory/memoryManager.ts");
  assert.equal(adapter.factoryCalls[0].context.instructions, "Corriger le bug identifié sans fusion automatique.");
  assert.match(result.response, /https:\/\/github\.com\/example\/repo\/pull\/999/);
  assert.equal(result.iterations, 3, "Jarvis ne doit pas s'arrêter après knowledge_search");
});
