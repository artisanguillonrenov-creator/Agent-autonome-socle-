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
import { Agent } from "../core/agent.js";
import { MockProvider } from "../llm/providers/mock.js";
import { LocalHashingEmbeddingProvider } from "../llm/embeddings.js";
import type { TaskRequest, ServiceEvent } from "../orchestration/contract.js";
import { config } from "../config.js";

test("parseRepoUrl extrait correctement owner et repo depuis différentes formats", () => {
  assert.deepEqual(parseRepoUrl("https://github.com/myorg/myrepo"), { owner: "myorg", repo: "myrepo" });
  assert.deepEqual(parseRepoUrl("https://github.com/myorg/myrepo.git"), { owner: "myorg", repo: "myrepo" });
  assert.deepEqual(parseRepoUrl("myorg/myrepo"), { owner: "myorg", repo: "myrepo" });
  assert.equal(parseRepoUrl("invalid-repo-format"), null);
  assert.equal(parseRepoUrl(undefined), null);
});

test("extractTaskParams retourne les valeurs fixées du projet (owner et repo avec tiret final)", () => {
  const req: TaskRequest = {
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

  const params = extractTaskParams(req);
  assert.equal(params.owner, "artisanguillonrenov-creator");
  assert.equal(params.repo, "Agent-autonome-socle-");
  assert.equal(params.filePath, "src/header.ts");
  assert.equal(params.instructions, "Ajouter un bouton de déconnexion");
});

test("TEST 1 - dispatch_capability est toujours présent dans les skills disponibles de l'agent", async () => {
  const agent = new Agent({
    llm: new MockProvider(),
    embeddings: new LocalHashingEmbeddingProvider(),
  });

  const mandatory = agent.skills.get("dispatch_capability");
  assert.ok(mandatory, "dispatch_capability doit être enregistré dans les skills");
});

test("TEST 6 & 7 - OperationStore protège les états terminaux et rejette la désynchronisation de séquence/trace", () => {
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
          return { data: { commit: { sha: "sha-commit-file-v2" } } };
        },
        compareCommits: async () => {
          calls.push("repos.compareCommits");
          return { data: { files: [{ filename: "src/app.ts", status: "modified" }], total_commits: 1 } };
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

test("TEST A — exactContent simple", () => {
  const req: TaskRequest = {
    schema_version: "1.0",
    task_id: "task-exact-1",
    trace_id: "trace-exact-1",
    idempotency_key: "idemp-exact-1",
    capability: "software_development",
    objective: "Crée docs/exact.md avec exactement ce contenu :\n\nBonjour",
    context: {},
    constraints: [],
    priority: "medium",
    permissions: [],
  };

  const params = extractTaskParams(req);
  assert.equal(params.filePath, "docs/exact.md");
  assert.equal(params.exactContent, "Bonjour");
});

test("TEST B — exactContent multilignes", () => {
  const req: TaskRequest = {
    schema_version: "1.0",
    task_id: "task-exact-2",
    trace_id: "trace-exact-2",
    idempotency_key: "idemp-exact-2",
    capability: "software_development",
    objective: "Crée docs/exact-multiline.md avec exactement ce contenu :\n\nLigne 1\nLigne 2\nLigne 3",
    context: {},
    constraints: [],
    priority: "medium",
    permissions: [],
  };

  const params = extractTaskParams(req);
  assert.equal(params.filePath, "docs/exact-multiline.md");
  assert.equal(params.exactContent, "Ligne 1\nLigne 2\nLigne 3");
});

test("TEST C — caractères Unicode dans exactContent", () => {
  const req: TaskRequest = {
    schema_version: "1.0",
    task_id: "task-exact-3",
    trace_id: "trace-exact-3",
    idempotency_key: "idemp-exact-3",
    capability: "software_development",
    objective: "Crée docs/unicode.md avec exactement ce contenu :\n\nTest réussi : Jarvis → Software Factory → GitHub",
    context: {},
    constraints: [],
    priority: "medium",
    permissions: [],
  };

  const params = extractTaskParams(req);
  assert.equal(params.exactContent, "Test réussi : Jarvis → Software Factory → GitHub");
});

test("TEST D — Cas réel critique (instructions opérationnelles exclues du contenu exact)", () => {
  const req: TaskRequest = {
    schema_version: "1.0",
    task_id: "task-real-case",
    trace_id: "trace-real-case",
    idempotency_key: "idemp-real-case",
    capability: "software_development",
    objective: "Crée docs/test.md avec exactement ce contenu :\n\nJARVIS_EXACT_CONTENT_OK\n\nCrée ensuite une nouvelle branche. Ouvre une Pull Request. Ne fusionne pas.",
    context: {},
    constraints: [],
    priority: "medium",
    permissions: [],
  };

  const params = extractTaskParams(req);
  assert.equal(params.filePath, "docs/test.md");
  assert.equal(params.exactContent, "JARVIS_EXACT_CONTENT_OK");
  assert.ok(!params.exactContent.includes("Crée ensuite"));
});

test("TEST E — context.exactContent prioritaire sur le texte libre", () => {
  const req: TaskRequest = {
    schema_version: "1.0",
    task_id: "task-prio-ctx",
    trace_id: "trace-prio-ctx",
    idempotency_key: "idemp-prio-ctx",
    capability: "software_development",
    objective: "Crée docs/prio.md avec exactement ce contenu :\n\nTEXTE_LIBRE_AUTRE",
    context: {
      filePath: "docs/prio.md",
      exactContent: "CONTENU_PRIORITAIRE_CONTEXTE",
    },
    constraints: [],
    priority: "medium",
    permissions: [],
  };

  const params = extractTaskParams(req);
  assert.equal(params.exactContent, "CONTENU_PRIORITAIRE_CONTEXTE");
});

test("TEST F — bypass LLM quand exactContent est présent", async () => {
  let writtenContent = "";

  const mockOctokit = {
    rest: {
      repos: {
        get: async () => ({ data: { default_branch: "main" } }),
        getContent: async () => { throw new Error("404 Not Found"); },
        createOrUpdateFileContents: async ({ content }: { content: string }) => {
          writtenContent = Buffer.from(content, "base64").toString("utf-8");
          return { data: { commit: { sha: "sha-exact-commit" } } };
        },
        compareCommits: async () => ({ data: { files: [{ filename: "docs/exact.md", status: "added" }] } }),
      },
      git: {
        getRef: async ({ ref }: { ref: string }) => {
          if (ref.startsWith("heads/jarvis/")) throw new Error("404 Not Found");
          return { data: { object: { sha: "base-sha" } } };
        },
        createRef: async () => ({ data: {} }),
      },
      pulls: {
        list: async () => ({ data: [] }),
        create: async () => ({ data: { html_url: "https://github.com/org/repo/pull/99", number: 99 } }),
      },
    },
  } as unknown as Octokit;

  const service = new SoftwareFactoryService({
    githubToken: "test-token",
    octokitClient: mockOctokit,
    // openrouterApiKey est volontairement non configuré
  });

  service.generateCodeUpdate = async () => {
    throw new Error("generateCodeUpdate ne doit PAS être appelé si exactContent est présent !");
  };

  const res = await service.executeWorkflow(
    {
      owner: "artisanguillonrenov-creator",
      repo: "Agent-autonome-socle-",
      filePath: "docs/exact.md",
      instructions: "Créer le fichier",
      exactContent: "JARVIS_EXACT_CONTENT_OK",
    },
    "task-bypass-llm",
  );

  assert.equal(writtenContent, "JARVIS_EXACT_CONTENT_OK");
  assert.equal(res.commitSha, "sha-exact-commit");
  assert.equal(res.prNumber, 99);
});

test("TEST G — Ambiguïté de contenu exact sans code fences lève EXACT_CONTENT_AMBIGUOUS", () => {
  const req: TaskRequest = {
    schema_version: "1.0",
    task_id: "task-ambiguous",
    trace_id: "trace-ambiguous",
    idempotency_key: "idemp-ambiguous",
    capability: "software_development",
    objective: "Crée docs/ambig.md avec exactement ce contenu :\n\nLigne 1 de texte\nLigne 2 de texte\nCrée ensuite une nouvelle branche.",
    context: {
      filePath: "docs/ambig.md",
    },
    constraints: [],
    priority: "medium",
    permissions: [],
  };

  assert.throws(
    () => extractTaskParams(req),
    (err: unknown) => err instanceof Error && err.message.includes("EXACT_CONTENT_AMBIGUOUS"),
  );
});

test("TEST H — Vrai commit SHA direct depuis repos.createOrUpdateFileContents (updateRes.data.commit.sha)", async () => {
  const mockOctokit = {
    rest: {
      repos: {
        get: async () => ({ data: { default_branch: "main" } }),
        getContent: async () => { throw new Error("404 Not Found"); },
        createOrUpdateFileContents: async () => ({
          data: { commit: { sha: "real-commit-123" } },
        }),
        compareCommits: async () => ({ data: { files: [{ filename: "src/test.ts", status: "added" }] } }),
      },
      git: {
        getRef: async ({ ref }: { ref: string }) => {
          if (ref.startsWith("heads/jarvis/")) throw new Error("404 Not Found");
          return { data: { object: { sha: "base-sha" } } };
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

  const res = await service.executeWorkflow(
    {
      owner: "artisanguillonrenov-creator",
      repo: "Agent-autonome-socle-",
      filePath: "src/test.ts",
      instructions: "Create test",
      exactContent: "test content",
    },
    "task-commit-sha-test",
  );

  assert.equal(res.commitSha, "real-commit-123");
});

test("TEST I — Fallback HEAD commit SHA via git.getRef quand updateRes.data.commit.sha est absent", async () => {
  const mockOctokit = {
    rest: {
      repos: {
        get: async () => ({ data: { default_branch: "main" } }),
        getContent: async () => { throw new Error("404 Not Found"); },
        createOrUpdateFileContents: async () => ({
          data: {}, // commit.sha absent
        }),
        compareCommits: async () => ({ data: { files: [{ filename: "src/test.ts", status: "added" }] } }),
      },
      git: {
        getRef: async ({ ref }: { ref: string }) => {
          if (ref === "heads/jarvis/task-fallback-head") {
            return { data: { object: { sha: "real-head-456" } } };
          }
          return { data: { object: { sha: "base-sha-old" } } };
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

  const res = await service.executeWorkflow(
    {
      owner: "artisanguillonrenov-creator",
      repo: "Agent-autonome-socle-",
      filePath: "src/test.ts",
      instructions: "Create test",
      exactContent: "test content",
    },
    "task-fallback-head",
  );

  assert.equal(res.commitSha, "real-head-456");
});

test("TEST J — content.sha (blob SHA) est strictement interdit comme commit SHA", async () => {
  const mockOctokit = {
    rest: {
      repos: {
        get: async () => ({ data: { default_branch: "main" } }),
        getContent: async () => { throw new Error("404 Not Found"); },
        createOrUpdateFileContents: async () => ({
          data: { content: { sha: "blob-sha-111" } }, // content.sha ne doit PAS être utilisé comme commitSha !
        }),
        compareCommits: async () => ({ data: { files: [{ filename: "src/test.ts", status: "added" }] } }),
      },
      git: {
        getRef: async ({ ref }: { ref: string }) => {
          if (ref.startsWith("heads/jarvis/")) {
            return { data: { object: { sha: "real-head-sha-222" } } };
          }
          return { data: { object: { sha: "base-sha" } } };
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

  const res = await service.executeWorkflow(
    {
      owner: "artisanguillonrenov-creator",
      repo: "Agent-autonome-socle-",
      filePath: "src/test.ts",
      instructions: "Create test",
      exactContent: "test content",
    },
    "task-blob-sha-forbidden",
  );

  assert.equal(res.commitSha, "real-head-sha-222");
  assert.notEqual(res.commitSha, "blob-sha-111");
});

test("TEST K — baseSha (ancien commit de main) est interdit comme nouveau commit SHA", async () => {
  const mockOctokit = {
    rest: {
      repos: {
        get: async () => ({ data: { default_branch: "main" } }),
        getContent: async () => { throw new Error("404 Not Found"); },
        createOrUpdateFileContents: async () => ({ data: {} }),
        compareCommits: async () => ({ data: { files: [{ filename: "src/test.ts", status: "added" }] } }),
      },
      git: {
        getRef: async () => {
          return { data: { object: { sha: "old-main-sha" } } }; // retourne toujours baseSha, donc aucun nouveau commit
        },
        createRef: async () => ({ data: {} }),
      },
    },
  } as unknown as Octokit;

  const service = new SoftwareFactoryService({
    githubToken: "test-token",
    octokitClient: mockOctokit,
  });

  await assert.rejects(
    async () => {
      await service.executeWorkflow(
        {
          owner: "artisanguillonrenov-creator",
          repo: "Agent-autonome-socle-",
          filePath: "src/test.ts",
          instructions: "Create test",
          exactContent: "test content",
        },
        "task-basesha-forbidden",
      );
    },
    (err: unknown) => err instanceof Error && err.message.includes("GITHUB_COMMIT_SHA_MISSING"),
  );
});

test("TEST L — TASK_COMPLETED payload contient les métadonnées complètes", async () => {
  const mockOctokit = {
    rest: {
      repos: {
        get: async () => ({ data: { default_branch: "main" } }),
        getContent: async () => ({ data: { content: Buffer.from("v1").toString("base64"), sha: "sha-1" } }),
        createOrUpdateFileContents: async () => ({
          data: { commit: { sha: "commit-sha-123456" } },
        }),
        compareCommits: async () => ({ data: { files: [{ filename: "src/main.ts", status: "modified" }] } }),
      },
      git: {
        getRef: async ({ ref }: { ref: string }) => {
          if (ref.startsWith("heads/jarvis/")) throw new Error("404 Not Found");
          return { data: { object: { sha: "base-sha" } } };
        },
        createRef: async () => ({ data: {} }),
      },
      pulls: {
        list: async () => ({ data: [] }),
        create: async () => ({ data: { html_url: "https://github.com/org/repo/pull/100", number: 100 } }),
      },
    },
  } as unknown as Octokit;

  const service = new SoftwareFactoryService({
    githubToken: "test-token",
    octokitClient: mockOctokit,
  });

  const req: TaskRequest = {
    schema_version: "1.0",
    task_id: "task-payload-test-123",
    trace_id: "trace-payload-test-456",
    idempotency_key: "idemp-payload-test-789",
    capability: "software_development",
    objective: "Crée src/main.ts avec exactement ce contenu :\n\nconsole.log('OK');",
    context: {},
    constraints: [],
    priority: "medium",
    permissions: [],
  };

  const events = await service.handleTaskRequest(req);
  const completedEvt = events.find((e) => e.type === "TASK_COMPLETED");
  assert.ok(completedEvt, "TASK_COMPLETED doit être émis");
  assert.equal(completedEvt?.payload.status, "COMPLETED");
  assert.equal(completedEvt?.payload.task_id, "task-payload-test-123");
  assert.equal(completedEvt?.payload.trace_id, "trace-payload-test-456");
  assert.equal(completedEvt?.payload.branch, "jarvis/task-payload-test-123");
  assert.equal(completedEvt?.payload.commit_sha, "commit-sha-123456");
  assert.equal(completedEvt?.payload.pr_number, 100);
  assert.equal(completedEvt?.payload.pr_url, "https://github.com/org/repo/pull/100");
});

test("TEST M — Orchestration bout en bout et dispatch_capability", async () => {
  const { ServiceRegistry } = await import("../orchestration/serviceRegistry.js");
  const { ServiceOrchestrator } = await import("../orchestration/serviceOrchestrator.js");
  const { dispatchCapabilitySkill } = await import("../skills/builtin/dispatchCapability.js");

  const mockOctokit = {
    rest: {
      repos: {
        get: async () => ({ data: { default_branch: "main" } }),
        getContent: async () => ({ data: { content: Buffer.from("v1").toString("base64"), sha: "sha-1" } }),
        createOrUpdateFileContents: async () => ({
          data: { commit: { sha: "sha-commit-e2e-777" } },
        }),
        compareCommits: async () => ({ data: { files: [{ filename: "src/app.ts", status: "modified" }] } }),
      },
      git: {
        getRef: async ({ ref }: { ref: string }) => {
          if (ref.startsWith("heads/jarvis/")) throw new Error("404 Not Found");
          return { data: { object: { sha: "base-sha" } } };
        },
        createRef: async () => ({ data: {} }),
      },
      pulls: {
        list: async () => ({ data: [] }),
        create: async () => ({ data: { html_url: "https://github.com/org/repo/pull/55", number: 55 } }),
      },
    },
  } as unknown as Octokit;

  const sfService = new SoftwareFactoryService({
    githubToken: "test-token",
    octokitClient: mockOctokit,
  });

  const registry = new ServiceRegistry();
  const adapter = new ServiceAdapter();
  // Injection direct in-process de sfService dans ServiceAdapter
  (adapter as unknown as { localSoftwareFactory: unknown }).localSoftwareFactory = sfService;

  registry.register({
    id: "software_factory",
    name: "Software Factory",
    enabled: true,
    endpoint: "in-process",
    capabilities: ["software_development"],
    priority: 100,
  });

  const orchestrator = new ServiceOrchestrator({ registry, adapter });

  const resultStr = await dispatchCapabilitySkill.handler(
    {
      capability: "software_development",
      objective: "Crée src/app.ts avec exactement ce contenu :\n\nconst x = 1;",
    },
    { serviceOrchestrator: orchestrator },
  );

  assert.match(resultStr, /Statut : COMPLETED/);
  assert.match(resultStr, /task_id : task-/);
  assert.match(resultStr, /trace_id : trace-/);
  assert.match(resultStr, /Service : software_factory/);
  assert.match(resultStr, /Branche : jarvis\/task-/);
  assert.match(resultStr, /SHA commit : sha-commit-e2e-777/);
  assert.match(resultStr, /PR : #55/);
  assert.match(resultStr, /URL : https:\/\/github.com\/org\/repo\/pull\/55/);
});

test("TEST N — FILE_PATH_MISSING sans fallback vers src/index.ts", () => {
  const req: TaskRequest = {
    schema_version: "1.0",
    task_id: "task-missing-path-n",
    trace_id: "trace-missing-path-n",
    idempotency_key: "idemp-missing-path-n",
    capability: "software_development",
    objective: "Mise à jour sans spécifier de fichier",
    context: {},
    constraints: [],
    priority: "medium",
    permissions: [],
  };

  assert.throws(
    () => extractTaskParams(req),
    (err: unknown) => err instanceof Error && err.message.includes("FILE_PATH_MISSING"),
  );
});

test("TEST O — NO_GITHUB_DIFF quand compareCommits retourne zéro fichier", async () => {
  const mockOctokit = {
    rest: {
      repos: {
        get: async () => ({ data: { default_branch: "main" } }),
        getContent: async () => ({ data: { content: Buffer.from("v1").toString("base64"), sha: "sha-1" } }),
        createOrUpdateFileContents: async () => ({ data: { commit: { sha: "commit-sha-diff-0" } } }),
        compareCommits: async () => ({ data: { files: [] } }), // 0 fichiers modifiés !
      },
      git: {
        getRef: async ({ ref }: { ref: string }) => {
          if (ref.startsWith("heads/jarvis/")) throw new Error("404 Not Found");
          return { data: { object: { sha: "base-sha" } } };
        },
        createRef: async () => ({ data: {} }),
      },
    },
  } as unknown as Octokit;

  const service = new SoftwareFactoryService({
    githubToken: "test-token",
    octokitClient: mockOctokit,
  });

  await assert.rejects(
    async () => {
      await service.executeWorkflow(
        {
          owner: "artisanguillonrenov-creator",
          repo: "Agent-autonome-socle-",
          filePath: "src/test.ts",
          instructions: "Modif sans diff",
          exactContent: "v1",
        },
        "task-no-diff",
      );
    },
    (err: unknown) => err instanceof Error && err.message.includes("NO_GITHUB_DIFF"),
  );
});

test("TEST P — NO_CHANGES_GENERATED quand le contenu généré est vide ou identique", async () => {
  const service = new SoftwareFactoryService({
    openrouterApiKey: "fake-key",
  });

  const originalFetch = globalThis.fetch;
  globalThis.fetch = async () =>
    new Response(
      JSON.stringify({
        choices: [{ message: { content: "console.log('identical');" } }],
      }),
      { status: 200 },
    );

  try {
    await assert.rejects(
      async () => {
        await service.generateCodeUpdate("console.log('identical');", "src/test.ts", "pas de changement");
      },
      (err: unknown) => err instanceof Error && err.message.includes("NO_CHANGES_GENERATED"),
    );
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("TEST Q — Création d'un nouveau fichier quand getContent retourne 404", async () => {
  let createdSha: string | undefined = "UNKNOWN";

  const mockOctokit = {
    rest: {
      repos: {
        get: async () => ({ data: { default_branch: "main" } }),
        getContent: async () => { throw new Error("404 Not Found"); },
        createOrUpdateFileContents: async ({ sha }: { sha?: string }) => {
          createdSha = sha;
          return { data: { commit: { sha: "new-file-commit-sha" } } };
        },
        compareCommits: async () => ({ data: { files: [{ filename: "src/newfile.ts", status: "added" }] } }),
      },
      git: {
        getRef: async ({ ref }: { ref: string }) => {
          if (ref.startsWith("heads/jarvis/")) throw new Error("404 Not Found");
          return { data: { object: { sha: "base-sha" } } };
        },
        createRef: async () => ({ data: {} }),
      },
      pulls: {
        list: async () => ({ data: [] }),
        create: async () => ({ data: { html_url: "https://github.com/org/repo/pull/10", number: 10 } }),
      },
    },
  } as unknown as Octokit;

  const service = new SoftwareFactoryService({
    githubToken: "test-token",
    octokitClient: mockOctokit,
  });

  const res = await service.executeWorkflow(
    {
      owner: "artisanguillonrenov-creator",
      repo: "Agent-autonome-socle-",
      filePath: "src/newfile.ts",
      instructions: "Créer un nouveau module",
      exactContent: "export const x = 1;",
    },
    "task-newfile-q",
  );

  assert.equal(createdSha, undefined, "sha doit être undefined pour la création d'un nouveau fichier");
  assert.equal(res.commitSha, "new-file-commit-sha");
  assert.equal(res.prNumber, 10);
});

test("TEST R — Serveur HTTP Software Factory POST /tasks", async () => {
  const previousFactoryToken = config.softwareFactory.token;
  const previousApiToken = config.api.token;
  config.softwareFactory.token = "software-factory-test-token";
  config.api.token = "";
  const mockOctokit = {
    rest: {
      repos: {
        get: async () => ({ data: { default_branch: "main" } }),
        getContent: async () => ({ data: { content: Buffer.from("code").toString("base64"), sha: "sha-1" } }),
        createOrUpdateFileContents: async () => ({ data: { commit: { sha: "sha-commit-http-test" } } }),
        compareCommits: async () => ({ data: { files: [{ filename: "index.ts", status: "modified" }] } }),
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
      headers: {
        "content-type": "application/json",
        authorization: "Bearer software-factory-test-token",
      },
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

    const noClientToken = await fetch(`http://localhost:${testPort}/tasks`, { method: "POST" });
    assert.equal(noClientToken.status, 401);

    const incorrectToken = await fetch(`http://localhost:${testPort}/tasks`, {
      method: "POST",
      headers: { authorization: "Bearer incorrect-token" },
    });
    assert.equal(incorrectToken.status, 401);
    assert.ok(!(await incorrectToken.text()).includes("software-factory-test-token"));

    config.softwareFactory.token = "";
    const noServerToken = await fetch(`http://localhost:${testPort}/tasks`, { method: "POST" });
    assert.equal(noServerToken.status, 503);
    assert.deepEqual(await noServerToken.json(), { error: "TOKEN_NOT_CONFIGURED" });

    const health = await fetch(`http://localhost:${testPort}/health`);
    assert.equal(health.status, 200);
  } finally {
    await server.stop();
    config.softwareFactory.token = previousFactoryToken;
    config.api.token = previousApiToken;
  }
});
