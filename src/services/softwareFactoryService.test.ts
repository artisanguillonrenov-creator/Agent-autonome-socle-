import test from "node:test";
import assert from "node:assert/strict";
import { Octokit } from "@octokit/rest";
import {
  SoftwareFactoryService,
  SoftwareFactoryServer,
  parseRepoUrl,
  extractTaskParams,
} from "./softwareFactoryService.js";
import { OperationStore } from "../orchestration/operationStore.js";
import { ServiceAdapter } from "../orchestration/serviceAdapter.js";
import { ServiceOrchestrator } from "../orchestration/serviceOrchestrator.js";
import { ServiceRegistry } from "../orchestration/serviceRegistry.js";
import { Agent } from "../core/agent.js";
import { MockProvider } from "../llm/providers/mock.js";
import { LocalHashingEmbeddingProvider } from "../llm/embeddings.js";
import { config } from "../config.js";
import type { TaskRequest, ServiceEvent } from "../orchestration/contract.js";

test("parseRepoUrl extrait correctement owner et repo depuis différentes formats", () => {
  assert.deepEqual(parseRepoUrl("https://github.com/myorg/myrepo"), { owner: "myorg", repo: "myrepo" });
  assert.deepEqual(parseRepoUrl("https://github.com/myorg/myrepo.git"), { owner: "myorg", repo: "myrepo" });
  assert.deepEqual(parseRepoUrl("myorg/myrepo"), { owner: "myorg", repo: "myrepo" });
  assert.equal(parseRepoUrl("invalid-repo-format"), null);
  assert.equal(parseRepoUrl(undefined), null);
});

test("extractTaskParams parse le repoUrl du contexte ou utilise les valeurs par défaut du projet", () => {
  const reqWithUrl: TaskRequest = {
    schema_version: "1.0",
    task_id: "task-123",
    trace_id: "trace-123",
    idempotency_key: "idemp-123",
    capability: "software_development",
    objective: "Mise à jour du header",
    context: {
      repoUrl: "https://github.com/octocat/Hello-World",
      filePath: "src/header.ts",
      instructions: "Ajouter un bouton de déconnexion",
    },
    constraints: [],
    priority: "high",
    permissions: [],
  };

  const paramsWithUrl = extractTaskParams(reqWithUrl);
  assert.equal(paramsWithUrl.owner, "octocat");
  assert.equal(paramsWithUrl.repo, "Hello-World");
  assert.equal(paramsWithUrl.filePath, "src/header.ts");
  assert.equal(paramsWithUrl.instructions, "Ajouter un bouton de déconnexion");

  const reqDefault: TaskRequest = {
    schema_version: "1.0",
    task_id: "task-456",
    trace_id: "trace-456",
    idempotency_key: "idemp-456",
    capability: "software_development",
    objective: "Mise à jour sans URL explicitée",
    context: {
      filePath: "src/header.ts",
    },
    constraints: [],
    priority: "medium",
    permissions: [],
  };

  const paramsDefault = extractTaskParams(reqDefault);
  assert.equal(paramsDefault.owner, "artisanguillonrenov-creator");
  assert.equal(paramsDefault.repo, "Agent-autonome-socle-");
});

test("TEST 1 - dispatch_capability est toujours présent dans les skills disponibles de l'agent", async () => {
  const agent = new Agent({
    llm: new MockProvider(),
    embeddings: new LocalHashingEmbeddingProvider(),
  });

  const mandatory = agent.skills.get("dispatch_capability");
  assert.ok(mandatory, "dispatch_capability doit être enregistré dans les skills");
});

test("TEST 2 - Auth SoftwareFactoryServer : token valide -> 200, token invalide -> 401", async () => {
  process.env.SOFTWARE_FACTORY_TOKEN = "secret-factory-token-123";
  config.softwareFactory.token = "secret-factory-token-123";

  const testPort = 4091;
  const mockOctokit = {
    rest: {
      users: { getAuthenticated: async () => ({ data: { login: "test" } }) },
      repos: { get: async () => ({ data: { id: 1 } }) },
    },
  } as unknown as Octokit;

  const service = new SoftwareFactoryService({ githubToken: "test", octokitClient: mockOctokit });
  const server = new SoftwareFactoryServer(testPort, service);
  await server.start();

  try {
    // Mauvais token -> 401
    const badRes = await fetch(`http://localhost:${testPort}/tasks`, {
      method: "POST",
      headers: { "content-type": "application/json", authorization: "Bearer wrong-token" },
      body: JSON.stringify({}),
    });
    assert.equal(badRes.status, 401);

    // /health est accessible pour diagnostic
    const healthRes = await fetch(`http://localhost:${testPort}/health`, { method: "GET" });
    assert.equal(healthRes.status, 200);
    const healthJson = (await healthRes.json()) as { ok: boolean };
    assert.equal(healthJson.ok, true);
  } finally {
    await server.stop();
    delete process.env.SOFTWARE_FACTORY_TOKEN;
    config.softwareFactory.token = "";
  }
});

test("TEST 3 & 4 - Idempotence COMPLETED et retry contrôlé FAILED retryable avec même taskId/traceId", async () => {
  const store = new OperationStore();
  const registry = new ServiceRegistry();
  const adapter = new ServiceAdapter();
  const orchestrator = new ServiceOrchestrator({ registry, adapter, store });

  const idempotencyKey = `idemp-test-${Date.now()}`;

  // 1. Première opération FAILED (retryable = true)
  store.createOperation({
    taskId: `task-${Date.now()}`,
    traceId: `trace-${Date.now()}`,
    idempotencyKey,
    objective: "Test idempotence",
    capability: "software_development",
    selectedService: "software_factory",
    status: "FAILED",
    error: "TRANSPORT_UNKNOWN: network error",
    retryable: true,
  });

  const firstOp = store.getByIdempotencyKey(idempotencyKey)!;
  assert.equal(firstOp.status, "FAILED");
  assert.equal(firstOp.retryable, true);

  // 2. Relancer avec la même idempotencyKey -> réutilise le MÊME taskId et MÊME traceId
  const retryRes = await orchestrator.dispatchCapability(
    {
      action: "DISPATCH_CAPABILITY",
      capability: "software_development",
      objective: "Test idempotence",
    },
    { idempotencyKey },
  );

  assert.equal(retryRes.taskId, firstOp.taskId);
  assert.equal(retryRes.traceId, firstOp.traceId);

  // 3. Passer en COMPLETED
  store.updateStatus(firstOp.taskId, "COMPLETED", "Résultat prêt");

  // 4. Troisième appel avec même idempotencyKey -> retourne immédiatement COMPLETED sans réexécuter
  const completedRes = await orchestrator.dispatchCapability(
    {
      action: "DISPATCH_CAPABILITY",
      capability: "software_development",
      objective: "Test idempotence",
    },
    { idempotencyKey },
  );

  assert.equal(completedRes.status, "COMPLETED");
  assert.equal(completedRes.taskId, firstOp.taskId);
});

test("TEST 6, 7 & 8 - OperationStore valide schema_version, trace_id, séquence et états terminaux", () => {
  const store = new OperationStore();
  const taskId = `task-state-test-${Date.now()}`;
  const traceId = `trace-state-test-${Date.now()}`;

  store.createOperation({
    taskId,
    traceId,
    idempotencyKey: `idemp-state-test-${Date.now()}`,
    objective: "Test state machine",
    capability: "software_development",
    selectedService: "software_factory",
    status: "DISPATCHING",
  });

  // Rejeter événement avec schema_version incompatible
  const evtBadSchema: ServiceEvent = {
    schema_version: "2.0", // version non supportée
    event_id: `evt-bad-schema-${Date.now()}`,
    task_id: taskId,
    trace_id: traceId,
    service: "software_factory",
    sequence: 1,
    type: "TASK_COMPLETED",
    timestamp: Date.now(),
    payload: {},
  };
  const resBadSchema = store.processEvent(evtBadSchema);
  assert.equal(resBadSchema.applied, false);

  // Événement valide COMPLETED (seq 1)
  const evt1: ServiceEvent = {
    schema_version: "1.0",
    event_id: `evt-seq-1-${Date.now()}`,
    task_id: taskId,
    trace_id: traceId,
    service: "software_factory",
    sequence: 1,
    type: "TASK_COMPLETED",
    timestamp: Date.now(),
    payload: { status: "ready" },
  };

  const res1 = store.processEvent(evt1);
  assert.ok(res1.applied);
  assert.equal(store.getOperation(taskId)?.status, "COMPLETED");

  // TEST 6 : un événement TASK_PROGRESS (seq 2) sur un état terminal COMPLETED ne doit PAS le faire repasser en RUNNING
  const evt2: ServiceEvent = {
    schema_version: "1.0",
    event_id: `evt-seq-2-${Date.now()}`,
    task_id: taskId,
    trace_id: traceId,
    service: "software_factory",
    sequence: 2,
    type: "TASK_PROGRESS",
    timestamp: Date.now(),
    payload: { progress: 50 },
  };

  const res2 = store.processEvent(evt2);
  assert.equal(res2.applied, false);
  assert.equal(store.getOperation(taskId)?.status, "COMPLETED");

  // TEST 8 : un événement avec un trace_id erroné est rejeté
  const evtWrongTrace: ServiceEvent = {
    schema_version: "1.0",
    event_id: `evt-seq-3-${Date.now()}`,
    task_id: taskId,
    trace_id: "wrong-trace-id",
    service: "software_factory",
    sequence: 3,
    type: "TASK_PROGRESS",
    timestamp: Date.now(),
    payload: {},
  };

  const resWrongTrace = store.processEvent(evtWrongTrace);
  assert.equal(resWrongTrace.applied, false);
});

test("TEST 9 - ServiceAdapter checkHealth effectue un GET /health authentifié", async () => {
  const adapter = new ServiceAdapter();
  const health = await adapter.checkHealth("in-process");
  assert.equal(health.reachable, true);
  assert.equal(health.status, 200);
});

test("SoftwareFactoryService initialise Octokit et respecte la limite de 3 retries max", async () => {
  let attempts = 0;

  const mockOctokit = {
    rest: {
      repos: {
        get: async () => {
          attempts++;
          throw new Error(`Simulated GitHub API Error (Attempt ${attempts})`);
        },
      },
    },
  } as unknown as Octokit;

  const service = new SoftwareFactoryService({
    githubToken: "ghp_fake_token_for_test",
    octokitClient: mockOctokit,
    maxRetries: 3,
  });

  assert.ok(service.getOctokit());
  assert.equal(service.maxRetries, 3);

  const req: TaskRequest = {
    schema_version: "1.0",
    task_id: "task-retry-test",
    trace_id: "trace-retry-test",
    idempotency_key: "idemp-retry-test",
    capability: "software_development",
    objective: "Tester le guardrail anti-boucle max retries",
    context: {
      repoUrl: "owner/repo",
      filePath: "src/main.ts",
      instructions: "Refactoriser",
    },
    constraints: [],
    priority: "medium",
    permissions: [],
  };

  const events = await service.handleTaskRequest(req);

  assert.equal(attempts, 3);

  const failedEvent = events.find((e) => e.type === "TASK_FAILED");
  assert.ok(failedEvent, "Un événement TASK_FAILED doit être émis après 3 tentatives échouées");
  assert.match(String(failedEvent?.payload.error), /après 3 tentatives/);
});

test("SoftwareFactoryService exécute le workflow complet avec branche unique par tâche (jarvis/task-<id>)", async () => {
  const calls: string[] = [];

  const mockOctokit = {
    rest: {
      repos: {
        get: async ({ owner, repo }: { owner: string; repo: string }) => {
          calls.push("repos.get");
          return { data: { default_branch: "main" } };
        },
        getContent: async ({ path, ref }: { path: string; ref: string }) => {
          calls.push(`repos.getContent:${ref}`);
          return {
            data: {
              content: Buffer.from("console.log('v1');").toString("base64"),
              sha: "sha-file-v1",
            },
          };
        },
        createOrUpdateFileContents: async ({ branch, path }: { branch: string; path: string }) => {
          calls.push(`repos.createOrUpdateFileContents:${branch}:${path}`);
          return { data: { content: { sha: "sha-file-v2" } } };
        },
      },
      git: {
        getRef: async ({ ref }: { ref: string }) => {
          calls.push(`git.getRef:${ref}`);
          if (ref.startsWith("heads/jarvis/")) {
            throw new Error("404 Not Found");
          }
          return { data: { object: { sha: "sha-commit-main" } } };
        },
        createRef: async ({ ref, sha }: { ref: string; sha: string }) => {
          calls.push(`git.createRef:${ref}`);
          return { data: { ref } };
        },
      },
      pulls: {
        list: async () => {
          calls.push("pulls.list");
          return { data: [] };
        },
        create: async ({ head, base, title }: { head: string; base: string; title: string }) => {
          calls.push(`pulls.create:${head}->${base}`);
          return {
            data: {
              html_url: "https://github.com/owner/repo/pull/42",
              number: 42,
            },
          };
        },
      },
    },
  } as unknown as Octokit;

  const service = new SoftwareFactoryService({
    githubToken: "ghp_fake_token_for_test",
    octokitClient: mockOctokit,
  });

  service.generateCodeUpdate = async (content, path, inst) => `${content}\n// Patched: ${inst}`;

  const req: TaskRequest = {
    schema_version: "1.0",
    task_id: "task-success-test",
    trace_id: "trace-success-test",
    idempotency_key: "idemp-success-test",
    capability: "software_development",
    objective: "Ajouter la fonction salut()",
    context: {
      repoUrl: "https://github.com/testowner/testrepo",
      filePath: "src/app.ts",
      instructions: "Ajouter la fonction salut()",
    },
    constraints: [],
    priority: "medium",
    permissions: [],
  };

  const events = await service.handleTaskRequest(req);

  const completedEvent = events.find((e) => e.type === "TASK_COMPLETED");
  assert.ok(completedEvent, "L'événement TASK_COMPLETED doit être présent");
  assert.equal(completedEvent?.payload.branch, "jarvis/task-success-test");
  assert.equal(completedEvent?.payload.pr_url, "https://github.com/owner/repo/pull/42");
  assert.equal(completedEvent?.payload.pr_number, 42);

  assert.ok(calls.includes("git.createRef:refs/heads/jarvis/task-success-test"));
  assert.ok(calls.includes("repos.createOrUpdateFileContents:jarvis/task-success-test:src/app.ts"));
  assert.ok(calls.includes("pulls.create:jarvis/task-success-test->main"));
});

test("SoftwareFactoryServer démarre, traite les requêtes HTTP POST /tasks et s'arrête proprement", async () => {
  const mockOctokit = {
    rest: {
      repos: {
        get: async () => ({ data: { default_branch: "main" } }),
        getContent: async () => ({ data: { content: Buffer.from("code").toString("base64"), sha: "sha-1" } }),
        createOrUpdateFileContents: async () => ({ data: { commit: { sha: "commit-sha-http" }, content: { sha: "file-sha-http" } } }),
        compareCommits: async () => ({
          data: { files: [{ filename: "index.ts" }], ahead_by: 1 },
        }),
      },
      git: {
        getRef: async ({ ref }: { ref: string }) => {
          if (ref.startsWith("heads/jarvis/")) throw new Error("404 Not Found");
          return { data: { object: { sha: "sha-main" } } };
        },
        createRef: async () => ({ data: {} }),
      },
      pulls: {
        list: async () => ({ data: [] }),
        create: async () => ({ data: { html_url: "https://github.com/org/repo/pull/1", number: 1 } }),
      },
    },
  } as unknown as Octokit;

  const service = new SoftwareFactoryService({
    githubToken: "test-token",
    octokitClient: mockOctokit,
  });

  service.generateCodeUpdate = async (content) => content + "\n// Patched";

  const testPort = 4088;
  const server = new SoftwareFactoryServer(testPort, service);
  await server.start();

  try {
    const res = await fetch(`http://localhost:${testPort}/tasks`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        schema_version: "1.0",
        task_id: "task-http-test",
        trace_id: "trace-http-test",
        idempotency_key: "idemp-http-test",
        capability: "software_development",
        objective: "Test via HTTP",
        context: { repoUrl: "org/repo", filePath: "index.ts", instructions: "Update index" },
        constraints: [],
        priority: "medium",
        permissions: [],
      }),
    });

    assert.equal(res.status, 200);
    const json = (await res.json()) as { events: Array<{ type: string }> };
    assert.ok(Array.isArray(json.events));
    assert.ok(json.events.some((e) => e.type === "TASK_COMPLETED"));
  } finally {
    await server.stop();
  }
});

test("TEST 1 - filePath transmis dans context.filePath est respecté sans modification", () => {
  const req: TaskRequest = {
    schema_version: "1.0",
    task_id: "task-fp-1",
    trace_id: "trace-fp-1",
    idempotency_key: "idemp-fp-1",
    capability: "software_development",
    objective: "Mettre à jour la documentation",
    context: {
      filePath: "docs/example.md",
      instructions: "Ajouter la section d'exemple",
    },
    constraints: [],
    priority: "medium",
    permissions: [],
  };

  const params = extractTaskParams(req);
  assert.equal(params.filePath, "docs/example.md");
});

test("TEST 2 - nouveau fichier : traitement lorsque le fichier n'existe pas sur main", async () => {
  let createdFilePath = "";
  let createdBranch = "";

  const mockOctokit = {
    rest: {
      repos: {
        get: async () => ({ data: { default_branch: "main" } }),
        getContent: async () => {
          throw new Error("404 Not Found");
        },
        createOrUpdateFileContents: async ({ path, branch }: { path: string; branch: string }) => {
          createdFilePath = path;
          createdBranch = branch;
          return { data: { commit: { sha: "commit-sha-new" }, content: { sha: "file-sha-new" } } };
        },
        compareCommits: async () => ({
          data: { files: [{ filename: "docs/new-file.md" }], ahead_by: 1 },
        }),
      },
      git: {
        getRef: async ({ ref }: { ref: string }) => {
          if (ref.startsWith("heads/jarvis/")) throw new Error("404 Not Found");
          return { data: { object: { sha: "sha-base-main" } } };
        },
        createRef: async () => ({ data: {} }),
      },
      pulls: {
        list: async () => ({ data: [] }),
        create: async () => ({
          data: { html_url: "https://github.com/owner/repo/pull/101", number: 101 },
        }),
      },
    },
  } as unknown as Octokit;

  const service = new SoftwareFactoryService({
    githubToken: "test-token",
    octokitClient: mockOctokit,
  });

  service.generateCodeUpdate = async () => "# Nouveau Fichier Documentation\nBonjour";

  const req: TaskRequest = {
    schema_version: "1.0",
    task_id: "task-new-file",
    trace_id: "trace-new-file",
    idempotency_key: "idemp-new-file",
    capability: "software_development",
    objective: "Créer docs/new-file.md",
    context: {
      filePath: "docs/new-file.md",
      instructions: "Créer le fichier de documentation",
    },
    constraints: [],
    priority: "medium",
    permissions: [],
  };

  const events = await service.handleTaskRequest(req);
  const completed = events.find((e) => e.type === "TASK_COMPLETED");
  assert.ok(completed);
  assert.equal(createdFilePath, "docs/new-file.md");
  assert.equal(completed?.payload.pr_number, 101);
});

test("TEST 3 - pas de fallback dangereux : absence de filePath jette FILE_PATH_MISSING", () => {
  const req: TaskRequest = {
    schema_version: "1.0",
    task_id: "task-no-path",
    trace_id: "trace-no-path",
    idempotency_key: "idemp-no-path",
    capability: "software_development",
    objective: "Fais une mise à jour générale sans nom de fichier",
    context: {},
    constraints: [],
    priority: "medium",
    permissions: [],
  };

  assert.throws(
    () => extractTaskParams(req),
    (err: Error) => err.message.includes("FILE_PATH_MISSING") && !err.message.includes("src/index.ts"),
  );
});

test("TEST 4 - extraction fallback depuis l'objectif", () => {
  const req: TaskRequest = {
    schema_version: "1.0",
    task_id: "task-extract-obj",
    trace_id: "trace-extract-obj",
    idempotency_key: "idemp-extract-obj",
    capability: "software_development",
    objective: "Crée docs/example.md avec le contenu Test V2",
    context: {},
    constraints: [],
    priority: "medium",
    permissions: [],
  };

  const params = extractTaskParams(req);
  assert.equal(params.filePath, "docs/example.md");
});

test("TEST 5 - no-op : si contenu inchangé, émet NO_CHANGES_GENERATED sans commit ni PR", async () => {
  let commitCalled = false;

  const mockOctokit = {
    rest: {
      repos: {
        get: async () => ({ data: { default_branch: "main" } }),
        getContent: async () => ({
          data: { content: Buffer.from("Contenu inchangé").toString("base64"), sha: "sha-same" },
        }),
        createOrUpdateFileContents: async () => {
          commitCalled = true;
          return { data: {} };
        },
      },
      git: {
        getRef: async () => ({ data: { object: { sha: "sha-main" } } }),
      },
    },
  } as unknown as Octokit;

  const service = new SoftwareFactoryService({
    githubToken: "test-token",
    octokitClient: mockOctokit,
  });

  service.generateCodeUpdate = async () => "Contenu inchangé";

  const req: TaskRequest = {
    schema_version: "1.0",
    task_id: "task-noop",
    trace_id: "trace-noop",
    idempotency_key: "idemp-noop",
    capability: "software_development",
    objective: "Tester le no-op",
    context: {
      filePath: "docs/test.md",
      instructions: "Conserver le contenu",
    },
    constraints: [],
    priority: "medium",
    permissions: [],
  };

  const events = await service.handleTaskRequest(req);
  const failed = events.find((e) => e.type === "TASK_FAILED");

  assert.ok(failed);
  assert.equal(commitCalled, false, "Aucun commit ne doit être créé pour un no-op");
  assert.match(String(failed?.payload.error_code || failed?.payload.error), /NO_CHANGES_GENERATED/);
});

test("TEST 6 - création réelle d'une PR simulée avec diff valide", async () => {
  let prCreated = false;

  const mockOctokit = {
    rest: {
      repos: {
        get: async () => ({ data: { default_branch: "main" } }),
        getContent: async () => ({
          data: { content: Buffer.from("Ligne 1\n").toString("base64"), sha: "sha-orig" },
        }),
        createOrUpdateFileContents: async () => ({
          data: { commit: { sha: "sha-commit-new" }, content: { sha: "sha-file-new" } },
        }),
        compareCommits: async () => ({
          data: { files: [{ filename: "docs/test.md", status: "modified" }], ahead_by: 1 },
        }),
      },
      git: {
        getRef: async ({ ref }: { ref: string }) => {
          if (ref.startsWith("heads/jarvis/")) throw new Error("404 Not Found");
          return { data: { object: { sha: "sha-base" } } };
        },
        createRef: async () => ({ data: {} }),
      },
      pulls: {
        list: async () => ({ data: [] }),
        create: async () => {
          prCreated = true;
          return { data: { html_url: "https://github.com/owner/repo/pull/202", number: 202 } };
        },
      },
    },
  } as unknown as Octokit;

  const service = new SoftwareFactoryService({
    githubToken: "test-token",
    octokitClient: mockOctokit,
  });

  service.generateCodeUpdate = async () => "Ligne 1\nLigne 2 modifiée";

  const req: TaskRequest = {
    schema_version: "1.0",
    task_id: "task-diff-pr",
    trace_id: "trace-diff-pr",
    idempotency_key: "idemp-diff-pr",
    capability: "software_development",
    objective: "Ajouter la ligne 2",
    context: {
      filePath: "docs/test.md",
      instructions: "Ajouter la ligne 2",
    },
    constraints: [],
    priority: "medium",
    permissions: [],
  };

  const events = await service.handleTaskRequest(req);
  const completed = events.find((e) => e.type === "TASK_COMPLETED");

  assert.ok(completed);
  assert.equal(prCreated, true);
  assert.equal(completed?.payload.pr_number, 202);
  assert.equal(completed?.payload.pr_url, "https://github.com/owner/repo/pull/202");
});
