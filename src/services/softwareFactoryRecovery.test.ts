import test from "node:test";
import assert from "node:assert/strict";
import { Octokit } from "@octokit/rest";
import { SoftwareFactoryService, extractTaskParams } from "./softwareFactoryService.js";
import { ServiceAdapter, type ServiceAdapterResponse } from "../orchestration/serviceAdapter.js";
import type { ServiceDefinition } from "../orchestration/serviceRegistry.js";
import { ServiceOrchestrator } from "../orchestration/serviceOrchestrator.js";
import { CONTRACT_SCHEMA_VERSION, type ServiceEvent, type TaskRequest } from "../orchestration/contract.js";
import { Agent } from "../core/agent.js";
import { LocalHashingEmbeddingProvider } from "../llm/embeddings.js";
import type { LLMProvider, CompletionOptions, LLMCompletionResult } from "../llm/provider.js";
import type { ChatMessage } from "../types.js";
import { closeDb, getDb } from "../persistence/db.js";
import { config } from "../config.js";

function setupDb(): void {
  config.db.path = ":memory:";
  config.autonomy.globalRiskLevel = "MEDIUM";
  config.autonomy.permissionMatrix = "EXECUTE";
  closeDb();
  getDb();
}

function request(context: Record<string, unknown>, taskId = "task-recovery"): TaskRequest {
  return {
    schema_version: CONTRACT_SCHEMA_VERSION,
    task_id: taskId,
    trace_id: `trace-${taskId}`,
    idempotency_key: `idemp-${taskId}`,
    capability: "software_development",
    objective: "Corriger le code sans fusion automatique",
    context,
    constraints: [],
    priority: "medium",
    permissions: [],
  };
}

function httpError(status: number, message: string): Error & { status: number } {
  const error = new Error(message) as Error & { status: number };
  error.status = status;
  return error;
}

test("extractTaskParams transporte createIfMissing explicitement et false par défaut", () => {
  assert.equal(extractTaskParams(request({ filePath: "src/a.ts", createIfMissing: true })).createIfMissing, true);
  assert.equal(extractTaskParams(request({ filePath: "src/a.ts" })).createIfMissing, false);
});

test("fichier absent sans createIfMissing échoue avant toute mutation et reste replannable", async () => {
  const mutations: string[] = [];
  const mock = {
    rest: {
      repos: {
        get: async () => ({ data: { default_branch: "main" } }),
        getContent: async () => { throw httpError(404, "Not Found"); },
        createOrUpdateFileContents: async () => { mutations.push("update"); return { data: { commit: { sha: "commit" } } }; },
      },
      git: {
        getRef: async ({ ref }: { ref: string }) => {
          if (ref === "heads/main") return { data: { object: { sha: "base" } } };
          throw httpError(404, "Not Found");
        },
        createRef: async () => { mutations.push("createRef"); return { data: {} }; },
      },
    },
  } as unknown as Octokit;
  const service = new SoftwareFactoryService({ githubToken: "token", octokitClient: mock });
  const events = await service.handleTaskRequest(request({ filePath: "src/missing.ts", exactContent: "x", createIfMissing: false }, "task-missing-guard"));
  const failed = events.find((event) => event.type === "TASK_FAILED");
  assert.ok(failed);
  assert.equal(failed.payload.error_code, "FILE_NOT_FOUND");
  assert.equal(failed.payload.replannable, true);
  assert.equal(failed.payload.side_effect_state, "none");
  assert.deepEqual(mutations, []);
});

test("fichier absent avec createIfMissing=true autorise une création volontaire", async () => {
  const mutations: string[] = [];
  let branchCreated = false;
  const mock = {
    rest: {
      repos: {
        get: async () => ({ data: { default_branch: "main" } }),
        getContent: async ({ ref }: { ref: string }) => {
          if (ref === "main" || ref.startsWith("jarvis/task-")) throw httpError(404, "Not Found");
          throw new Error(`unexpected ref ${ref}`);
        },
        createOrUpdateFileContents: async () => { mutations.push("update"); return { data: { commit: { sha: "commit-new" } } }; },
        compareCommits: async () => ({ data: { files: [{ filename: "src/new.ts" }] } }),
      },
      git: {
        getRef: async ({ ref }: { ref: string }) => {
          if (ref === "heads/main") return { data: { object: { sha: "base" } } };
          if (ref.startsWith("heads/jarvis/")) {
            if (!branchCreated) throw httpError(404, "Not Found");
            return { data: { object: { sha: "commit-new" } } };
          }
          throw httpError(404, "Not Found");
        },
        createRef: async () => { branchCreated = true; mutations.push("createRef"); return { data: {} }; },
      },
      pulls: {
        list: async () => ({ data: [] }),
        create: async () => ({ data: { number: 12, html_url: "https://github.test/pull/12" } }),
      },
    },
  } as unknown as Octokit;
  const service = new SoftwareFactoryService({ githubToken: "token", octokitClient: mock });
  const events = await service.handleTaskRequest(request({ filePath: "src/new.ts", exactContent: "export const x = 1;", createIfMissing: true }, "task-create-ok"));
  const completed = events.find((event) => event.type === "TASK_COMPLETED");
  assert.ok(completed);
  assert.equal(completed.payload.pr_url, "https://github.test/pull/12");
  assert.deepEqual(mutations, ["createRef", "update"]);
});

test("401/403/5xx de getContent ne sont jamais interprétés comme fichier absent", async () => {
  for (const status of [401, 403, 503]) {
    let mutations = 0;
    const mock = {
      rest: {
        repos: {
          get: async () => ({ data: { default_branch: "main" } }),
          getContent: async () => { throw httpError(status, `HTTP ${status}`); },
          createOrUpdateFileContents: async () => { mutations++; return { data: {} }; },
        },
        git: {
          getRef: async () => ({ data: { object: { sha: "base" } } }),
          createRef: async () => { mutations++; return { data: {} }; },
        },
      },
    } as unknown as Octokit;
    const service = new SoftwareFactoryService({ githubToken: "token", octokitClient: mock, maxRetries: 1 });
    const events = await service.handleTaskRequest(request({ filePath: "src/app.ts", exactContent: "x", createIfMissing: false }, `task-http-${status}`));
    const failed = events.find((event) => event.type === "TASK_FAILED");
    assert.ok(failed, `status ${status}`);
    assert.notEqual(failed.payload.error_code, "FILE_NOT_FOUND", `status ${status}`);
    assert.equal(failed.payload.replannable, false, `status ${status}`);
    assert.equal(failed.payload.side_effect_state, "none", `status ${status}`);
    assert.equal(mutations, 0, `status ${status}`);
  }
});

test("mutation de branche confirmée puis échec ultérieur produit side_effect_state=partial", async () => {
  let branchCreated = false;
  let updates = 0;
  const mock = {
    rest: {
      repos: {
        get: async () => ({ data: { default_branch: "main" } }),
        getContent: async ({ ref }: { ref: string }) => {
          if (ref === "main") return { data: { content: Buffer.from("old").toString("base64"), sha: "blob" } };
          if (branchCreated) throw httpError(403, "Forbidden after branch creation");
          return { data: { content: Buffer.from("old").toString("base64"), sha: "blob" } };
        },
        createOrUpdateFileContents: async () => { updates++; return { data: { commit: { sha: "commit" } } }; },
      },
      git: {
        getRef: async ({ ref }: { ref: string }) => {
          if (ref === "heads/main") return { data: { object: { sha: "base" } } };
          throw httpError(404, "Not Found");
        },
        createRef: async () => { branchCreated = true; return { data: {} }; },
      },
    },
  } as unknown as Octokit;
  const service = new SoftwareFactoryService({ githubToken: "token", octokitClient: mock });
  const events = await service.handleTaskRequest(request({ filePath: "src/app.ts", exactContent: "new", createIfMissing: false }, "task-partial"));
  const failed = events.find((event) => event.type === "TASK_FAILED");
  assert.ok(failed);
  assert.equal(failed.payload.replannable, false);
  assert.equal(failed.payload.side_effect_state, "partial");
  assert.equal(updates, 0);
});

test("erreur 5xx pendant la première mutation produit side_effect_state=uncertain", async () => {
  let updateCalls = 0;
  const mock = {
    rest: {
      repos: {
        get: async () => ({ data: { default_branch: "main" } }),
        getContent: async () => ({ data: { content: Buffer.from("old").toString("base64"), sha: "blob" } }),
        createOrUpdateFileContents: async () => { updateCalls++; throw httpError(503, "Service unavailable during write"); },
      },
      git: {
        getRef: async ({ ref }: { ref: string }) => ({ data: { object: { sha: ref === "heads/main" ? "base" : "feature-head" } } }),
      },
    },
  } as unknown as Octokit;
  const service = new SoftwareFactoryService({ githubToken: "token", octokitClient: mock });
  const events = await service.handleTaskRequest(request({ filePath: "src/app.ts", exactContent: "new", instructions: "TARGET_BRANCH=feature/existing", createIfMissing: false }, "task-uncertain"));
  const failed = events.find((event) => event.type === "TASK_FAILED");
  assert.ok(failed);
  assert.equal(updateCalls, 1);
  assert.equal(failed.payload.replannable, false);
  assert.equal(failed.payload.side_effect_state, "uncertain");
});

class MetadataAdapter extends ServiceAdapter {
  calls = 0;
  override async dispatchTask(value: ServiceDefinition | string, req: TaskRequest): Promise<ServiceAdapterResponse> {
    const serviceId = typeof value === "string" ? value : value.id;
    if (serviceId !== "software_factory") return super.dispatchTask(value, req);
    this.calls++;
    const events: ServiceEvent[] = [
      {
        schema_version: CONTRACT_SCHEMA_VERSION,
        event_id: `evt-${req.task_id}-accepted-${this.calls}`,
        task_id: req.task_id,
        trace_id: req.trace_id,
        service: "software_factory",
        sequence: 1,
        type: "TASK_ACCEPTED",
        timestamp: Date.now(),
        payload: { message: "accepted" },
      },
      {
        schema_version: CONTRACT_SCHEMA_VERSION,
        event_id: `evt-${req.task_id}-failed-${this.calls}`,
        task_id: req.task_id,
        trace_id: req.trace_id,
        service: "software_factory",
        sequence: 2,
        type: "TASK_FAILED",
        timestamp: Date.now(),
        payload: { error: "FILE_NOT_FOUND", replannable: true, side_effect_state: "none" },
      },
    ];
    return { success: true, events, transportDurationMs: 0 };
  }
}

test("OrchestrationResult expose replannable/sideEffectState aussi sur retour idempotent", async () => {
  setupDb();
  const adapter = new MetadataAdapter();
  const orchestrator = new ServiceOrchestrator({ adapter });
  const decision = { action: "DISPATCH_CAPABILITY" as const, capability: "software_development", objective: "corriger", context: { filePath: "src/missing.ts" }, constraints: [] };
  const first = await orchestrator.dispatchCapability(decision, { idempotencyKey: "idemp-recovery-meta" });
  assert.equal(first.status, "FAILED");
  assert.equal(first.replannable, true);
  assert.equal(first.sideEffectState, "none");
  const second = await orchestrator.dispatchCapability(decision, { idempotencyKey: "idemp-recovery-meta" });
  assert.equal(second.status, "FAILED");
  assert.equal(second.replannable, true);
  assert.equal(second.sideEffectState, "none");
  assert.equal(adapter.calls, 1, "le retour idempotent doit relire les métadonnées persistées sans redispatch");
});

class DirectRecoveryAdapter extends ServiceAdapter {
  readonly requests: TaskRequest[] = [];
  override async dispatchTask(value: ServiceDefinition | string, req: TaskRequest): Promise<ServiceAdapterResponse> {
    const serviceId = typeof value === "string" ? value : value.id;
    if (serviceId !== "software_factory") return super.dispatchTask(value, req);
    this.requests.push(req);
    const common = {
      schema_version: CONTRACT_SCHEMA_VERSION,
      task_id: req.task_id,
      trace_id: req.trace_id,
      service: "software_factory",
      timestamp: Date.now(),
    };
    const accepted: ServiceEvent = { ...common, event_id: `evt-${req.task_id}-accepted`, sequence: 1, type: "TASK_ACCEPTED", payload: { message: "accepted" } };
    if (req.context.filePath === "src/wrong.ts") {
      return {
        success: true,
        transportDurationMs: 0,
        events: [accepted, { ...common, event_id: `evt-${req.task_id}-failed`, sequence: 2, type: "TASK_FAILED", payload: { error: "FILE_NOT_FOUND", replannable: true, side_effect_state: "none" } }],
      };
    }
    return {
      success: true,
      transportDurationMs: 0,
      events: [accepted, { ...common, event_id: `evt-${req.task_id}-completed`, sequence: 2, type: "TASK_COMPLETED", payload: { status: "COMPLETED", branch: "jarvis/recovery", commit_sha: "abc", pr_number: 77, pr_url: "https://github.test/pull/77" } }],
    };
  }
}

class RecoverySequenceLLM implements LLMProvider {
  readonly name = "recovery-sequence";
  readonly model = "recovery-sequence";
  call = 0;
  sawFailureMetadata = false;
  sawObservation = false;

  async complete(messages: ChatMessage[], _options?: CompletionOptions): Promise<LLMCompletionResult> {
    this.call++;
    if (this.call === 1) {
      return { content: null, toolCalls: [{ id: "dev-bad", type: "function", function: { name: "software_development", arguments: JSON.stringify({ objective: "Corriger", filePath: "src/wrong.ts", instructions: "Corriger ce bug", createIfMissing: false }) } }] };
    }
    if (this.call === 2) {
      this.sawFailureMetadata = messages.some((message) => message.role === "tool" && (message.content ?? "").includes('"replannable":true') && (message.content ?? "").includes('"sideEffectState":"none"'));
      return { content: null, toolCalls: [{ id: "observe", type: "function", function: { name: "knowledge_search", arguments: "{}" } }] };
    }
    if (this.call === 3) {
      this.sawObservation = messages.some((message) => message.role === "tool" && (message.content ?? "").includes("src/right.ts"));
      return { content: null, toolCalls: [{ id: "dev-good", type: "function", function: { name: "software_development", arguments: JSON.stringify({ objective: "Corriger", filePath: "src/right.ts", instructions: "Corriger ce bug", createIfMissing: false }) } }] };
    }
    return { content: "Correction prête : https://github.test/pull/77" };
  }
}

test("Agent direct reçoit les flags, pivote vers observation puis retente avec un filePath différent", async () => {
  setupDb();
  const adapter = new DirectRecoveryAdapter();
  const llm = new RecoverySequenceLLM();
  const orchestrator = new ServiceOrchestrator({ adapter });
  const agent = new Agent({ llm, embeddings: new LocalHashingEmbeddingProvider(), orchestrator, maxIterations: 5, reflectionEveryNSteps: 999 });
  agent.skills.register({
    name: "knowledge_search",
    description: "Inspecte le dépôt",
    argsHint: "{}",
    parameters: { type: "object", properties: {}, additionalProperties: false },
    handler: async () => JSON.stringify({ path: "src/right.ts", content: "export const ok = true;" }),
  });
  const result = await agent.step("Corrige ce bug dans Jarvis.");
  assert.equal(llm.sawFailureMetadata, true);
  assert.equal(llm.sawObservation, true);
  assert.equal(adapter.requests.length, 2);
  assert.equal(adapter.requests[0].context.filePath, "src/wrong.ts");
  assert.equal(adapter.requests[0].context.createIfMissing, false);
  assert.equal(adapter.requests[1].context.filePath, "src/right.ts");
  assert.match(result.response, /https:\/\/github\.test\/pull\/77/);
});
