import test from "node:test";
import assert from "node:assert/strict";
import { Octokit } from "@octokit/rest";
import {
  SoftwareFactoryService,
  SoftwareFactoryServer,
  SoftwareFactoryWorkflowError,
  parseRepoUrl,
  extractTaskParams,
  cleanLLMCodeOutput,
  type ParsedSoftwareTask,
} from "./softwareFactoryService.js";
import { OperationStore } from "../orchestration/operationStore.js";
import { ServiceAdapter } from "../orchestration/serviceAdapter.js";
import { Agent } from "../core/agent.js";
import { MockProvider } from "../llm/providers/mock.js";
import { LocalHashingEmbeddingProvider } from "../llm/embeddings.js";
import type { TaskRequest, ServiceEvent } from "../orchestration/contract.js";
import { config } from "../config.js";
import type { LLMProvider, CompletionOptions } from "../llm/provider.js";
import type { ChatMessage } from "../types.js";

/** Fournisseur LLM contrôlable en test : capture messages/options, renvoie un contenu fixé ou lève une erreur. */
class StubLLMProvider implements LLMProvider {
  readonly name = "stub";
  public lastMessages: ChatMessage[] = [];
  public lastOptions: CompletionOptions = {};
  constructor(
    private readonly content: string | null,
    private readonly errorToThrow?: Error,
  ) {}

  async complete(messages: ChatMessage[], options: CompletionOptions = {}) {
    this.lastMessages = messages;
    this.lastOptions = options;
    if (this.errorToThrow) throw this.errorToThrow;
    return { content: this.content };
  }
}

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

function targetedWorkflowMock(options: {
  branchExists?: boolean;
  branchHeadAfterUpdate?: string;
  updateHasCommitSha?: boolean;
  pull?: { number: number; state: string; headBranch: string; fullName: string; url: string };
  pullGetFails?: boolean;
  existingPull?: { number: number; html_url: string };
} = {}) {
  const calls: string[] = [];
  let updatePerformed = false;
  const mock = {
    rest: {
      repos: {
        get: async () => ({ data: { default_branch: "main" } }),
        getContent: async ({ ref }: { ref: string }) => {
          calls.push(`getContent:${ref}`);
          return { data: { content: Buffer.from(`content-${ref}`).toString("base64"), sha: `blob-${ref}` } };
        },
        createOrUpdateFileContents: async ({ branch }: { branch: string }) => {
          calls.push(`update:${branch}`);
          updatePerformed = true;
          return options.updateHasCommitSha === false
            ? { data: {} }
            : { data: { commit: { sha: `commit-${branch}` } } };
        },
        compareCommits: async () => ({ data: { files: [{ filename: "src/app.ts" }] } }),
      },
      git: {
        getRef: async ({ ref }: { ref: string }) => {
          calls.push(`getRef:${ref}`);
          if (ref === "heads/main") return { data: { object: { sha: "base-sha" } } };
          if (options.branchExists === false) throw new Error("404");
          const sha = updatePerformed && options.branchHeadAfterUpdate
            ? options.branchHeadAfterUpdate
            : `sha-${ref}`;
          return { data: { object: { sha } } };
        },
        createRef: async () => {
          calls.push("createRef");
          return { data: {} };
        },
      },
      pulls: {
        get: async () => {
          calls.push("pulls.get");
          if (options.pullGetFails) throw new Error("404");
          const pull = options.pull!;
          return {
            data: {
              number: pull.number,
              state: pull.state,
              html_url: pull.url,
              head: { ref: pull.headBranch, repo: { full_name: pull.fullName } },
            },
          };
        },
        list: async () => {
          calls.push("pulls.list");
          return { data: options.existingPull ? [options.existingPull] : [] };
        },
        create: async () => {
          calls.push("pulls.create");
          return { data: { number: 88, html_url: "https://github.test/pull/88" } };
        },
      },
    },
  } as unknown as Octokit;
  return { mock, calls };
}

const targetedParams = (instructions: string): ParsedSoftwareTask => ({
  owner: "artisanguillonrenov-creator",
  repo: "Agent-autonome-socle-",
  filePath: "src/app.ts",
  instructions,
  exactContent: "updated",
  ...(() => {
    const request = {
      objective: "update",
      context: { filePath: "src/app.ts", instructions },
    } as TaskRequest;
    const parsed = extractTaskParams(request);
    return { targetBranch: parsed.targetBranch, targetPr: parsed.targetPr };
  })(),
});

test("TARGET_PR valide réutilise sa branche et sa PR sans en créer une nouvelle", async () => {
  const { mock, calls } = targetedWorkflowMock({
    pull: { number: 31, state: "open", headBranch: "feature/existing", fullName: "artisanguillonrenov-creator/Agent-autonome-socle-", url: "https://github.test/pull/31" },
  });
  const service = new SoftwareFactoryService({ githubToken: "token", octokitClient: mock });
  const result = await service.executeWorkflow(targetedParams("TARGET_PR=31"), "task-target-pr");
  assert.equal(result.branch, "feature/existing");
  assert.equal(result.prNumber, 31);
  assert.equal(result.prUrl, "https://github.test/pull/31");
  assert.ok(calls.includes("getContent:feature/existing"));
  assert.ok(calls.includes("update:feature/existing"));
  assert.ok(!calls.includes("createRef"));
  assert.ok(!calls.includes("pulls.list"));
  assert.ok(!calls.includes("pulls.create"));
});

test("TARGET_PR + TARGET_BRANCH identiques réussissent", async () => {
  const { mock } = targetedWorkflowMock({
    pull: { number: 31, state: "open", headBranch: "feature/existing", fullName: "artisanguillonrenov-creator/Agent-autonome-socle-", url: "url-31" },
  });
  const result = await new SoftwareFactoryService({ githubToken: "token", octokitClient: mock })
    .executeWorkflow(targetedParams("TARGET_PR=31\nTARGET_BRANCH=feature/existing"), "task-both");
  assert.equal(result.branch, "feature/existing");
});

for (const scenario of [
  { name: "fermée", options: { pull: { number: 31, state: "closed", headBranch: "feature/x", fullName: "artisanguillonrenov-creator/Agent-autonome-socle-", url: "url" } }, instructions: "TARGET_PR=31" },
  { name: "inexistante", options: { pullGetFails: true }, instructions: "TARGET_PR=404" },
  { name: "issue d'un autre dépôt", options: { pull: { number: 31, state: "open", headBranch: "feature/x", fullName: "someone/fork", url: "url" } }, instructions: "TARGET_PR=31" },
  { name: "associée à une TARGET_BRANCH différente", options: { pull: { number: 31, state: "open", headBranch: "feature/x", fullName: "artisanguillonrenov-creator/Agent-autonome-socle-", url: "url" } }, instructions: "TARGET_PR=31\nTARGET_BRANCH=feature/y" },
]) {
  test(`TARGET_PR ${scenario.name} échoue avec TARGET_PR_INVALID`, async () => {
    const { mock } = targetedWorkflowMock(scenario.options);
    const service = new SoftwareFactoryService({ githubToken: "token", octokitClient: mock });
    await assert.rejects(service.executeWorkflow(targetedParams(scenario.instructions), "task-invalid-pr"), /TARGET_PR_INVALID/);
  });
}

test("TARGET_PR non entier positif échoue avec TARGET_PR_INVALID", () => {
  assert.throws(() => targetedParams("TARGET_PR=0"), /TARGET_PR_INVALID/);
  assert.throws(() => targetedParams("TARGET_PR=12x"), /TARGET_PR_INVALID/);
});

test("TARGET_BRANCH seule réutilise une branche existante et sa PR ouverte", async () => {
  const { mock, calls } = targetedWorkflowMock({ existingPull: { number: 44, html_url: "https://github.test/pull/44" } });
  const result = await new SoftwareFactoryService({ githubToken: "token", octokitClient: mock })
    .executeWorkflow(targetedParams("TARGET_BRANCH=feature/existing"), "task-target-branch");
  assert.equal(result.branch, "feature/existing");
  assert.equal(result.prNumber, 44);
  assert.ok(!calls.includes("createRef"));
  assert.ok(!calls.includes("pulls.create"));
});

test("TARGET_BRANCH seule ouvre au maximum une PR lorsqu'il n'en existe pas", async () => {
  const { mock, calls } = targetedWorkflowMock();
  const result = await new SoftwareFactoryService({ githubToken: "token", octokitClient: mock })
    .executeWorkflow(targetedParams("TARGET_BRANCH=feature/existing"), "task-target-branch-new-pr");
  assert.equal(result.prNumber, 88);
  assert.equal(calls.filter((call) => call === "pulls.create").length, 1);
});

test("TARGET_BRANCH inexistante échoue sans créer la branche", async () => {
  const { mock, calls } = targetedWorkflowMock({ branchExists: false });
  const service = new SoftwareFactoryService({ githubToken: "token", octokitClient: mock });
  await assert.rejects(service.executeWorkflow(targetedParams("TARGET_BRANCH=missing"), "task-missing"), /TARGET_BRANCH_INVALID/);
  assert.ok(!calls.includes("createRef"));
});

test("TARGET_BRANCH=main est rejetée avant toute écriture", async () => {
  const { mock, calls } = targetedWorkflowMock();
  const service = new SoftwareFactoryService({ githubToken: "token", octokitClient: mock });
  await assert.rejects(
    service.executeWorkflow(targetedParams("TARGET_BRANCH=main"), "task-default-branch"),
    /TARGET_BRANCH_INVALID: La branche cible ne peut pas être la branche par défaut\./,
  );
  assert.ok(!calls.some((call) => call.startsWith("update:")));
});

test("TARGET_PR dont la branche head est main est rejetée avant toute écriture", async () => {
  const { mock, calls } = targetedWorkflowMock({
    pull: { number: 32, state: "open", headBranch: "main", fullName: "artisanguillonrenov-creator/Agent-autonome-socle-", url: "url-32" },
  });
  const service = new SoftwareFactoryService({ githubToken: "token", octokitClient: mock });
  await assert.rejects(
    service.executeWorkflow(targetedParams("TARGET_PR=32"), "task-pr-default-branch"),
    /TARGET_BRANCH_INVALID: La branche cible ne peut pas être la branche par défaut\./,
  );
  assert.ok(!calls.some((call) => call.startsWith("update:")));
});

test("TARGET_BRANCH accepte le nouveau HEAD du fallback après l'écriture", async () => {
  const { mock } = targetedWorkflowMock({ updateHasCommitSha: false, branchHeadAfterUpdate: "new-target-head" });
  const result = await new SoftwareFactoryService({ githubToken: "token", octokitClient: mock })
    .executeWorkflow(targetedParams("TARGET_BRANCH=feature/existing"), "task-target-new-head");
  assert.equal(result.commitSha, "new-target-head");
});

test("TARGET_BRANCH refuse l'ancien HEAD inchangé comme SHA du commit", async () => {
  const { mock } = targetedWorkflowMock({ updateHasCommitSha: false });
  const service = new SoftwareFactoryService({ githubToken: "token", octokitClient: mock });
  await assert.rejects(
    service.executeWorkflow(targetedParams("TARGET_BRANCH=feature/existing"), "task-target-old-head"),
    /GITHUB_COMMIT_SHA_MISSING: Impossible de déterminer le véritable SHA du commit GitHub\./,
  );
});

test("TARGET_PR refuse l'ancien HEAD inchangé comme SHA du commit", async () => {
  const { mock } = targetedWorkflowMock({
    updateHasCommitSha: false,
    pull: { number: 32, state: "open", headBranch: "feature/existing", fullName: "artisanguillonrenov-creator/Agent-autonome-socle-", url: "url-32" },
  });
  const service = new SoftwareFactoryService({ githubToken: "token", octokitClient: mock });
  await assert.rejects(
    service.executeWorkflow(targetedParams("TARGET_PR=32"), "task-pr-old-head"),
    /GITHUB_COMMIT_SHA_MISSING: Impossible de déterminer le véritable SHA du commit GitHub\./,
  );
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
    // Aucun llmProvider fourni : le LLM ne doit jamais être appelé grâce à exactContent
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
  const { closeDb, getDb } = await import("../persistence/db.js");
  config.db.path = ":memory:";
  closeDb();
  getDb();

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

test("TEST P — NO_CHANGES_GENERATED quand le contenu généré est identique au contenu existant", async () => {
  const stub = new StubLLMProvider("console.log('identical');");
  const service = new SoftwareFactoryService({ llmProvider: stub });

  await assert.rejects(
    async () => {
      await service.generateCodeUpdate("console.log('identical');", "src/test.ts", "pas de changement");
    },
    (err: unknown) => err instanceof Error && err.message.includes("NO_CHANGES_GENERATED"),
  );
});

// --- Bascule OpenRouter -> Infermatic : configuration par défaut ---

test("config.softwareFactory expose des valeurs par défaut Infermatic indépendantes de config.llm", () => {
  assert.equal(config.softwareFactory.provider, "infermatic");
  assert.equal(config.softwareFactory.model, "Qwen-Qwen3.6-35B-A3B");
  assert.equal(config.softwareFactory.maxTokens, 7000);
});

// --- Utilisation effective du provider Infermatic ---

test("Software Factory appelle Infermatic (api.totalgpt.ai) et jamais OpenRouter quand SOFTWARE_FACTORY_PROVIDER=infermatic", async () => {
  const originalFetch = globalThis.fetch;
  const previousInfermaticKey = config.llm.infermaticApiKey;
  const calledUrls: string[] = [];
  let capturedBody: Record<string, unknown> | undefined;

  config.llm.infermaticApiKey = "test-infermatic-key";
  globalThis.fetch = (async (url: unknown, init?: RequestInit) => {
    calledUrls.push(String(url));
    capturedBody = init?.body ? JSON.parse(String(init.body)) : undefined;
    return new Response(JSON.stringify({ choices: [{ message: { content: "export const patched = true;" } }] }), {
      status: 200,
    });
  }) as typeof fetch;

  try {
    // La sélection persistée de Jarvis pointe volontairement vers un autre provider :
    // la Software Factory ne doit jamais s'y raccrocher.
    const { closeDb, getDb } = await import("../persistence/db.js");
    config.db.path = ":memory:";
    closeDb();
    getDb();
    const { saveLLMConfig } = await import("../persistence/llmConfigStore.js");
    saveLLMConfig("anthropic", "claude-3-5-sonnet");

    const service = new SoftwareFactoryService({
      softwareFactoryProvider: "infermatic",
      softwareFactoryModel: "Qwen-Qwen3.6-35B-A3B",
    });
    const result = await service.generateCodeUpdate("old", "src/x.ts", "faire X");

    assert.equal(result, "export const patched = true;");
    assert.equal(calledUrls.length, 1);
    assert.match(calledUrls[0], /^https:\/\/api\.totalgpt\.ai\/v1\/chat\/completions$/);
    assert.ok(!calledUrls.some((u) => u.includes("openrouter.ai")), "Aucune requête ne doit atteindre OpenRouter");
    assert.equal(capturedBody?.model, "Qwen-Qwen3.6-35B-A3B");
  } finally {
    globalThis.fetch = originalFetch;
    config.llm.infermaticApiKey = previousInfermaticKey;
  }
});

test("TEST BLOQUANT — le sanitizer <think> du chat Jarvis ne doit jamais tronquer du code Infermatic contenant un <think> littéral non fermé", async () => {
  // Suite à l'audit de la PR : InfermaticProvider est partagé par le chat Jarvis et par
  // la Software Factory. Du code source légitime peut contenir la chaîne "<think>" sans
  // jamais la refermer (ex. une constante nommant une balise) — cela ne doit JAMAIS être
  // traité comme un raisonnement non terminé et tronquer le reste du fichier généré.
  const originalFetch = globalThis.fetch;
  const previousInfermaticKey = config.llm.infermaticApiKey;
  config.llm.infermaticApiKey = "test-infermatic-key";

  const legitimateCode = 'const OPEN_TAG = "<think>";\nconst x = 1;';
  globalThis.fetch = (async () =>
    new Response(JSON.stringify({ choices: [{ message: { content: legitimateCode } }] }), { status: 200 })) as typeof fetch;

  try {
    const service = new SoftwareFactoryService({
      softwareFactoryProvider: "infermatic",
      softwareFactoryModel: "Qwen-Qwen3.6-35B-A3B",
    });

    const result = await service.generateCodeUpdate("old", "src/tags.ts", "ajouter OPEN_TAG");

    assert.equal(result, legitimateCode);
    assert.ok(result.includes("const x = 1;"), "le code après le <think> littéral ne doit pas être tronqué");
  } finally {
    globalThis.fetch = originalFetch;
    config.llm.infermaticApiKey = previousInfermaticKey;
  }
});

test("Le provider/modèle actif de Jarvis (llm_active_model persisté) n'est jamais modifié par la Software Factory", async () => {
  const { closeDb, getDb } = await import("../persistence/db.js");
  config.db.path = ":memory:";
  closeDb();
  getDb();
  const { saveLLMConfig, loadLLMConfig } = await import("../persistence/llmConfigStore.js");
  saveLLMConfig("anthropic", "claude-3-5-sonnet");

  const stub = new StubLLMProvider("export const y = 2;");
  const service = new SoftwareFactoryService({
    llmProvider: stub,
    softwareFactoryProvider: "infermatic",
    softwareFactoryModel: "Qwen-Qwen3.6-35B-A3B",
  });
  await service.generateCodeUpdate("old", "src/y.ts", "faire Y");

  assert.deepEqual(loadLLMConfig(), { provider: "anthropic", model: "claude-3-5-sonnet" });
});

test("generateCodeUpdate transmet maxTokens (défaut 7000) et temperature 0.2 au provider", async () => {
  const stub = new StubLLMProvider("export const a = 1;");
  const service = new SoftwareFactoryService({ llmProvider: stub });
  await service.generateCodeUpdate("old", "src/a.ts", "faire A");

  assert.equal(stub.lastOptions.maxTokens, 7000);
  assert.equal(stub.lastOptions.temperature, 0.2);
});

test("SOFTWARE_FACTORY_MAX_TOKENS personnalisé est bien transmis au provider", async () => {
  const stub = new StubLLMProvider("export const b = 2;");
  const service = new SoftwareFactoryService({ llmProvider: stub, softwareFactoryMaxTokens: 4321 });
  await service.generateCodeUpdate("old", "src/b.ts", "faire B");

  assert.equal(stub.lastOptions.maxTokens, 4321);
});

test("Une erreur de génération de code n'expose jamais la clé API Infermatic", async () => {
  const originalFetch = globalThis.fetch;
  const previousInfermaticKey = config.llm.infermaticApiKey;
  const secretKey = "sk-super-secret-infermatic-key-12345";
  config.llm.infermaticApiKey = secretKey;
  globalThis.fetch = (async () => new Response("Erreur interne, en-tête Authorization rejeté", { status: 500 })) as typeof fetch;

  try {
    const service = new SoftwareFactoryService({
      softwareFactoryProvider: "infermatic",
      softwareFactoryModel: "Qwen-Qwen3.6-35B-A3B",
    });
    await assert.rejects(
      service.generateCodeUpdate("old", "src/x.ts", "faire X"),
      (err: unknown) => {
        assert.ok(err instanceof Error);
        assert.match((err as Error).message, /CODE_GENERATION_FAILED/);
        assert.ok(!(err as Error).message.includes(secretKey), "La clé API ne doit jamais apparaître dans l'erreur");
        return true;
      },
    );
  } finally {
    globalThis.fetch = originalFetch;
    config.llm.infermaticApiKey = previousInfermaticKey;
  }
});

// --- Récupération et nettoyage de la réponse LLM ---

test("generateCodeUpdate récupère correctement une réponse avec code complet", async () => {
  const code = "export function greet(): string {\n  return 'hi';\n}";
  const stub = new StubLLMProvider(code);
  const service = new SoftwareFactoryService({ llmProvider: stub });
  const result = await service.generateCodeUpdate("old content", "src/greet.ts", "ajouter greet()");
  assert.equal(result, code);
});

test("cleanLLMCodeOutput nettoie un bloc Markdown ```typescript ... ```", () => {
  const result = cleanLLMCodeOutput("```typescript\nexport const x = 42;\n```");
  assert.equal(result, "export const x = 42;");
});

test("cleanLLMCodeOutput retire les balises <think>...</think> avant utilisation", () => {
  const result = cleanLLMCodeOutput("<think>Je réfléchis à la meilleure implémentation...</think>\nexport const y = 1;");
  assert.equal(result, "export const y = 1;");
  assert.ok(!result.includes("<think>") && !result.includes("</think>"));
});

test("cleanLLMCodeOutput retire <think> puis nettoie le bloc Markdown restant", () => {
  const result = cleanLLMCodeOutput("<think>raisonnement interne...</think>\n```ts\nexport const z = 2;\n```");
  assert.equal(result, "export const z = 2;");
});

test("generateCodeUpdate nettoie une réponse ```typescript ... ``` avant de retourner le code", async () => {
  const stub = new StubLLMProvider("```typescript\nexport const x = 42;\n```");
  const service = new SoftwareFactoryService({ llmProvider: stub });
  const result = await service.generateCodeUpdate("old", "src/x.ts", "faire X");
  assert.equal(result, "export const x = 42;");
});

test("generateCodeUpdate nettoie une réponse avec balise <think> avant de retourner le code", async () => {
  const stub = new StubLLMProvider("<think>je réfléchis...</think>\nexport const y = 1;");
  const service = new SoftwareFactoryService({ llmProvider: stub });
  const result = await service.generateCodeUpdate("old", "src/y.ts", "faire Y");
  assert.equal(result, "export const y = 1;");
  assert.ok(!result.includes("<think>"));
});

test("generateCodeUpdate rejette une réponse vide avec NO_CHANGES_GENERATED", async () => {
  const stub = new StubLLMProvider("");
  const service = new SoftwareFactoryService({ llmProvider: stub });
  await assert.rejects(
    service.generateCodeUpdate("old", "src/x.ts", "faire X"),
    (err: unknown) => err instanceof Error && err.message.includes("NO_CHANGES_GENERATED"),
  );
});

test("generateCodeUpdate rejette une réponse null avec NO_CHANGES_GENERATED", async () => {
  const stub = new StubLLMProvider(null);
  const service = new SoftwareFactoryService({ llmProvider: stub });
  await assert.rejects(
    service.generateCodeUpdate("old", "src/x.ts", "faire X"),
    (err: unknown) => err instanceof Error && err.message.includes("NO_CHANGES_GENERATED"),
  );
});

test("generateCodeUpdate rejette une réponse qui ne contient qu'un bloc <think> vide de code", async () => {
  const stub = new StubLLMProvider("<think>je réfléchis encore et encore...</think>");
  const service = new SoftwareFactoryService({ llmProvider: stub });
  await assert.rejects(
    service.generateCodeUpdate("old", "src/x.ts", "faire X"),
    (err: unknown) => err instanceof Error && err.message.includes("NO_CHANGES_GENERATED"),
  );
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
  let diagnosticsCalls = 0;
  service.getGitHubDiagnostics = async () => {
    diagnosticsCalls++;
    return { configured: true, authenticated: true, repositoryAccessible: true };
  };

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
    assert.deepEqual(await health.json(), {
      status: "ok",
      service: "software_factory",
    });
    assert.equal(diagnosticsCalls, 0);
  } finally {
    await server.stop();
    config.softwareFactory.token = previousFactoryToken;
    config.api.token = previousApiToken;
  }
});

// --- PR-B : secret guard pre-push + protection de base obsolète ---

function mockOctokitForWriteFlow(overrides: {
  baseSha?: string;
  createOrUpdateFileContents?: (args: { content: string }) => Promise<{ data: unknown }>;
  createRefCalls?: { count: number };
  /** Si fourni, getContent renvoie ce contenu existant au lieu de lever un 404. */
  existingContent?: string;
} = {}): Octokit {
  const baseSha = overrides.baseSha ?? "base-sha";
  const createRefCalls = overrides.createRefCalls;
  return {
    rest: {
      repos: {
        get: async () => ({ data: { default_branch: "main" } }),
        getContent:
          overrides.existingContent !== undefined
            ? async () => ({
                data: { type: "file", content: Buffer.from(overrides.existingContent!, "utf-8").toString("base64"), encoding: "base64", sha: "existing-file-sha" },
              })
            : async () => { throw new Error("404 Not Found"); },
        createOrUpdateFileContents:
          overrides.createOrUpdateFileContents ??
          (async () => ({ data: { commit: { sha: "sha-after-write" } } })),
        compareCommits: async () => ({ data: { files: [{ filename: "docs/secret.md", status: "added" }] } }),
      },
      git: {
        getRef: async ({ ref }: { ref: string }) => {
          if (ref.startsWith("heads/jarvis/")) throw new Error("404 Not Found");
          return { data: { object: { sha: baseSha } } };
        },
        createRef: async () => {
          if (createRefCalls) createRefCalls.count += 1;
          return { data: {} };
        },
      },
      pulls: {
        list: async () => ({ data: [] }),
        create: async () => ({ data: { html_url: "https://github.com/org/repo/pull/42", number: 42 } }),
      },
    },
  } as unknown as Octokit;
}

test("PR-B.A — secret guard : contenu propre laisse passer l'écriture normalement", async () => {
  const octokit = mockOctokitForWriteFlow();
  const service = new SoftwareFactoryService({ githubToken: "test-token", octokitClient: octokit });

  const res = await service.executeWorkflow(
    {
      owner: "artisanguillonrenov-creator",
      repo: "Agent-autonome-socle-",
      filePath: "docs/secret.md",
      instructions: "Créer un fichier de doc sans rien de sensible",
      exactContent: "# Documentation publique\n\nAucun secret ici.",
    },
    "task-secret-clean",
  );
  assert.equal(res.commitSha, "sha-after-write");
});

test("PR-B.B — secret guard : un token GitHub dans le contenu bloque l'écriture avec SECRET_DETECTED", async () => {
  const createRefCalls = { count: 0 };
  let writeAttempted = false;
  const octokit = mockOctokitForWriteFlow({
    createRefCalls,
    createOrUpdateFileContents: async () => {
      writeAttempted = true;
      return { data: { commit: { sha: "should-not-happen" } } };
    },
  });
  const service = new SoftwareFactoryService({ githubToken: "test-token", octokitClient: octokit });

  const leakedToken = "ghp_1234567890abcdef1234567890abcdef1234";
  await assert.rejects(
    () =>
      service.executeWorkflow(
        {
          owner: "artisanguillonrenov-creator",
          repo: "Agent-autonome-socle-",
          filePath: "docs/secret.md",
          instructions: "Ajouter la config",
          exactContent: `# Config\n\nGITHUB_TOKEN=${leakedToken}\n`,
          createIfMissing: true,
        },
        "task-secret-leak",
      ),
    (err: unknown) => {
      assert.ok(err instanceof SoftwareFactoryWorkflowError);
      assert.equal(err.code, "SECRET_DETECTED");
      assert.equal(err.sideEffectState, "none");
      return true;
    },
  );
  // Aucune écriture GitHub (ni branche, ni commit) n'a eu lieu après détection.
  assert.equal(createRefCalls.count, 0, "aucune branche ne doit être créée après un secret détecté");
  assert.equal(writeAttempted, false, "aucun commit ne doit être tenté après un secret détecté");
});

test("PR-B.C — secret guard : le secret détecté n'apparaît jamais en clair dans le message d'erreur", async () => {
  const octokit = mockOctokitForWriteFlow();
  const service = new SoftwareFactoryService({ githubToken: "test-token", octokitClient: octokit });

  const leakedToken = "ghp_1234567890abcdef1234567890abcdef1234";
  await assert.rejects(
    () =>
      service.executeWorkflow(
        {
          owner: "artisanguillonrenov-creator",
          repo: "Agent-autonome-socle-",
          filePath: "docs/secret.md",
          instructions: "Ajouter la config",
          exactContent: `GITHUB_TOKEN=${leakedToken}`,
          createIfMissing: true,
        },
        "task-secret-no-leak-in-message",
      ),
    (err: unknown) => {
      assert.ok(err instanceof Error);
      assert.equal(err.message.includes(leakedToken), false, "le token brut ne doit jamais apparaître dans le message d'erreur");
      assert.match(err.message, /occurrence/);
      return true;
    },
  );
});

test("PR-B.D — protection de base : base_sha attendu == HEAD réel, le workflow continue normalement", async () => {
  const octokit = mockOctokitForWriteFlow({ baseSha: "current-head-sha" });
  const service = new SoftwareFactoryService({ githubToken: "test-token", octokitClient: octokit });

  const res = await service.executeWorkflow(
    {
      owner: "artisanguillonrenov-creator",
      repo: "Agent-autonome-socle-",
      filePath: "docs/secret.md",
      instructions: "Créer un fichier",
      exactContent: "contenu ok",
      expectedBaseSha: "current-head-sha",
    },
    "task-base-fresh",
  );
  assert.equal(res.commitSha, "sha-after-write");
});

test("PR-B.E — protection de base : base_sha attendu différent du HEAD réel lève STALE_BASE avant toute écriture", async () => {
  const createRefCalls = { count: 0 };
  let writeAttempted = false;
  const octokit = mockOctokitForWriteFlow({
    baseSha: "new-head-after-someone-else-merged",
    createRefCalls,
    createOrUpdateFileContents: async () => {
      writeAttempted = true;
      return { data: { commit: { sha: "should-not-happen" } } };
    },
  });
  const service = new SoftwareFactoryService({ githubToken: "test-token", octokitClient: octokit });

  await assert.rejects(
    () =>
      service.executeWorkflow(
        {
          owner: "artisanguillonrenov-creator",
          repo: "Agent-autonome-socle-",
          filePath: "docs/secret.md",
          instructions: "Créer un fichier",
          exactContent: "contenu ok",
          expectedBaseSha: "stale-sha-from-when-mission-was-planned",
        },
        "task-base-stale",
      ),
    (err: unknown) => {
      assert.ok(err instanceof SoftwareFactoryWorkflowError);
      assert.equal(err.code, "STALE_BASE");
      assert.equal(err.sideEffectState, "none");
      assert.equal(err.replannable, true);
      return true;
    },
  );
  assert.equal(createRefCalls.count, 0, "aucune branche ne doit être créée sur une base obsolète");
  assert.equal(writeAttempted, false, "aucun commit ne doit être tenté sur une base obsolète");
});

test("PR-B — expectedBaseSha absent (appelant historique) : comportement inchangé, aucune régression", async () => {
  const octokit = mockOctokitForWriteFlow({ baseSha: "whatever-head" });
  const service = new SoftwareFactoryService({ githubToken: "test-token", octokitClient: octokit });

  const res = await service.executeWorkflow(
    {
      owner: "artisanguillonrenov-creator",
      repo: "Agent-autonome-socle-",
      filePath: "docs/secret.md",
      instructions: "Créer un fichier",
      exactContent: "contenu ok",
      // Pas de expectedBaseSha : le contrôle STALE_BASE ne doit pas s'appliquer.
    },
    "task-no-expected-base",
  );
  assert.equal(res.commitSha, "sha-after-write");
});

// --- PR-D : diff/fidelity control ---

test("PR-D.A — changement exact attendu sur fichier existant : diffFidelity PASS et exposé dans le résultat", async () => {
  const octokit = mockOctokitForWriteFlow({ existingContent: "ligne1\nligne2\nligne3\nligne4\nligne5\nligne6" });
  const service = new SoftwareFactoryService({ githubToken: "test-token", octokitClient: octokit });

  const res = await service.executeWorkflow(
    {
      owner: "artisanguillonrenov-creator",
      repo: "Agent-autonome-socle-",
      filePath: "docs/fidelity.md",
      instructions: "Modifier la ligne 3",
      exactContent: "ligne1\nligne2\nligne3-modifiee\nligne4\nligne5\nligne6",
      expectedFilePath: "docs/fidelity.md",
      expectedChangeType: "update",
    },
    "task-fidelity-a",
  );
  assert.equal(res.diffFidelity.fidelityStatus, "PASS");
  assert.equal(res.diffFidelity.files[0].changeType, "modified");
  assert.equal(res.commitSha, "sha-after-write");
});

test("PR-D.B — fichier inattendu (hors périmètre de la mission) : DIFF_FIDELITY_FAILED avant toute écriture", async () => {
  const createRefCalls = { count: 0 };
  let writeAttempted = false;
  const octokit = mockOctokitForWriteFlow({
    createRefCalls,
    createOrUpdateFileContents: async () => { writeAttempted = true; return { data: { commit: { sha: "should-not-happen" } } }; },
  });
  const service = new SoftwareFactoryService({ githubToken: "test-token", octokitClient: octokit });

  await assert.rejects(
    () =>
      service.executeWorkflow(
        {
          owner: "artisanguillonrenov-creator",
          repo: "Agent-autonome-socle-",
          filePath: "docs/unexpected.md",
          instructions: "Créer un fichier",
          exactContent: "contenu",
          createIfMissing: true,
          expectedFilePath: "docs/authorized.md",
        },
        "task-fidelity-b",
      ),
    (err: unknown) => {
      assert.ok(err instanceof SoftwareFactoryWorkflowError);
      assert.equal(err.code, "DIFF_FIDELITY_FAILED");
      assert.equal(err.sideEffectState, "none");
      return true;
    },
  );
  assert.equal(createRefCalls.count, 0);
  assert.equal(writeAttempted, false);
});

test("PR-D.C — suppression inattendue (contenu vidé) sur fichier existant : DIFF_FIDELITY_FAILED avant toute écriture", async () => {
  const createRefCalls = { count: 0 };
  let writeAttempted = false;
  const octokit = mockOctokitForWriteFlow({
    existingContent: "contenu important\nligne 2\nligne 3",
    createRefCalls,
    createOrUpdateFileContents: async () => { writeAttempted = true; return { data: { commit: { sha: "should-not-happen" } } }; },
  });
  const service = new SoftwareFactoryService({ githubToken: "test-token", octokitClient: octokit });

  await assert.rejects(
    () =>
      service.executeWorkflow(
        {
          owner: "artisanguillonrenov-creator",
          repo: "Agent-autonome-socle-",
          filePath: "docs/fidelity.md",
          instructions: "Ajouter une phrase",
          exactContent: "",
        },
        "task-fidelity-c",
      ),
    (err: unknown) => {
      assert.ok(err instanceof SoftwareFactoryWorkflowError);
      assert.equal(err.code, "DIFF_FIDELITY_FAILED");
      return true;
    },
  );
  assert.equal(createRefCalls.count, 0);
  assert.equal(writeAttempted, false);
});

test("PR-D.D — contenu hors périmètre modifié (réécriture massive non justifiée) : DIFF_FIDELITY_FAILED avant toute écriture", async () => {
  const createRefCalls = { count: 0 };
  let writeAttempted = false;
  const originalContent = Array.from({ length: 20 }, (_, i) => `ligne originale ${i}`).join("\n");
  const octokit = mockOctokitForWriteFlow({
    existingContent: originalContent,
    createRefCalls,
    createOrUpdateFileContents: async () => { writeAttempted = true; return { data: { commit: { sha: "should-not-happen" } } }; },
  });
  const service = new SoftwareFactoryService({ githubToken: "test-token", octokitClient: octokit });

  await assert.rejects(
    () =>
      service.executeWorkflow(
        {
          owner: "artisanguillonrenov-creator",
          repo: "Agent-autonome-socle-",
          filePath: "docs/fidelity.md",
          instructions: "Corriger une faute de frappe",
          exactContent: "contenu totalement différent, sans rapport avec l'original",
        },
        "task-fidelity-d",
      ),
    (err: unknown) => {
      assert.ok(err instanceof SoftwareFactoryWorkflowError);
      assert.equal(err.code, "DIFF_FIDELITY_FAILED");
      return true;
    },
  );
  assert.equal(createRefCalls.count, 0);
  assert.equal(writeAttempted, false);
});

test("PR-D.E — création autorisée (fichier absent, expectedChangeType=create) : PASS, écriture normale", async () => {
  const octokit = mockOctokitForWriteFlow();
  const service = new SoftwareFactoryService({ githubToken: "test-token", octokitClient: octokit });

  const res = await service.executeWorkflow(
    {
      owner: "artisanguillonrenov-creator",
      repo: "Agent-autonome-socle-",
      filePath: "docs/new-fidelity.md",
      instructions: "Créer le fichier",
      exactContent: "# Nouveau document",
      createIfMissing: true,
      expectedChangeType: "create",
    },
    "task-fidelity-e",
  );
  assert.equal(res.diffFidelity.fidelityStatus, "PASS");
  assert.equal(res.diffFidelity.files[0].changeType, "created");
  assert.equal(res.commitSha, "sha-after-write");
});

test("PR-D.F — création demandée alors que le fichier existe déjà : DIFF_FIDELITY_FAILED, jamais de remplacement silencieux", async () => {
  const createRefCalls = { count: 0 };
  let writeAttempted = false;
  const octokit = mockOctokitForWriteFlow({
    existingContent: "contenu préexistant que la mission ignorait",
    createRefCalls,
    createOrUpdateFileContents: async () => { writeAttempted = true; return { data: { commit: { sha: "should-not-happen" } } }; },
  });
  const service = new SoftwareFactoryService({ githubToken: "test-token", octokitClient: octokit });

  await assert.rejects(
    () =>
      service.executeWorkflow(
        {
          owner: "artisanguillonrenov-creator",
          repo: "Agent-autonome-socle-",
          filePath: "docs/fidelity.md",
          instructions: "Créer le fichier",
          exactContent: "contenu qui écraserait l'existant",
          createIfMissing: true,
          expectedChangeType: "create",
        },
        "task-fidelity-f",
      ),
    (err: unknown) => {
      assert.ok(err instanceof SoftwareFactoryWorkflowError);
      assert.equal(err.code, "DIFF_FIDELITY_FAILED");
      return true;
    },
  );
  assert.equal(createRefCalls.count, 0, "aucune branche ne doit être créée : le fichier existant ne doit jamais être silencieusement remplacé");
  assert.equal(writeAttempted, false);
});

test("PR-D.G — diff vide/inutile (contenu final identique à l'original) : comportement propre, PASS", async () => {
  const identical = "ligne1\nligne2\nligne3\nligne4\nligne5\nligne6\nligne7";
  const octokit = mockOctokitForWriteFlow({ existingContent: identical });
  const service = new SoftwareFactoryService({ githubToken: "test-token", octokitClient: octokit });

  const res = await service.executeWorkflow(
    {
      owner: "artisanguillonrenov-creator",
      repo: "Agent-autonome-socle-",
      filePath: "docs/fidelity.md",
      instructions: "Aucun changement réel",
      exactContent: identical,
    },
    "task-fidelity-g",
  );
  assert.equal(res.diffFidelity.fidelityStatus, "PASS");
  assert.equal(res.diffFidelity.additions, 0);
  assert.equal(res.diffFidelity.deletions, 0);
});

test("PR-D.I — compatibilité avec SECRET_DETECTED : un secret bloque avant même d'atteindre le contrôle de fidélité", async () => {
  const createRefCalls = { count: 0 };
  const octokit = mockOctokitForWriteFlow({ createRefCalls });
  const service = new SoftwareFactoryService({ githubToken: "test-token", octokitClient: octokit });

  // Contenu qui échouerait de toute façon la fidélité (fichier inattendu) ET contient un secret :
  // le secret guard (étage antérieur) doit se déclencher en premier.
  await assert.rejects(
    () =>
      service.executeWorkflow(
        {
          owner: "artisanguillonrenov-creator",
          repo: "Agent-autonome-socle-",
          filePath: "docs/fidelity.md",
          instructions: "Ajouter la config",
          exactContent: "GITHUB_TOKEN=ghp_1234567890abcdefghij1234567890abcdef",
          createIfMissing: true,
          expectedFilePath: "docs/other.md", // aurait aussi échoué la fidélité
        },
        "task-fidelity-secret-priority",
      ),
    (err: unknown) => {
      assert.ok(err instanceof SoftwareFactoryWorkflowError);
      assert.equal(err.code, "SECRET_DETECTED", "le secret guard doit se déclencher avant le contrôle de fidélité");
      return true;
    },
  );
  assert.equal(createRefCalls.count, 0);
});

test("PR-D.J — compatibilité avec STALE_BASE : une base obsolète bloque avant même d'atteindre le contrôle de fidélité", async () => {
  const createRefCalls = { count: 0 };
  const octokit = mockOctokitForWriteFlow({ baseSha: "new-head-after-merge", createRefCalls });
  const service = new SoftwareFactoryService({ githubToken: "test-token", octokitClient: octokit });

  await assert.rejects(
    () =>
      service.executeWorkflow(
        {
          owner: "artisanguillonrenov-creator",
          repo: "Agent-autonome-socle-",
          filePath: "docs/fidelity.md",
          instructions: "Créer le fichier",
          exactContent: "contenu ok",
          createIfMissing: true,
          expectedBaseSha: "stale-sha",
          expectedFilePath: "docs/other-file.md", // aurait aussi échoué la fidélité
        },
        "task-fidelity-stale-priority",
      ),
    (err: unknown) => {
      assert.ok(err instanceof SoftwareFactoryWorkflowError);
      assert.equal(err.code, "STALE_BASE", "la protection de base obsolète doit se déclencher avant le contrôle de fidélité");
      return true;
    },
  );
  assert.equal(createRefCalls.count, 0);
});

test("PR-D — aucun champ de fidélité fourni (appelant historique) : comportement inchangé, aucune régression", async () => {
  const octokit = mockOctokitForWriteFlow({ existingContent: "contenu existant sans rapport avec le seuil de réécriture" });
  const service = new SoftwareFactoryService({ githubToken: "test-token", octokitClient: octokit });

  const res = await service.executeWorkflow(
    {
      owner: "artisanguillonrenov-creator",
      repo: "Agent-autonome-socle-",
      filePath: "docs/fidelity.md",
      instructions: "Remplacer tout le contenu",
      exactContent: "contenu complètement réécrit, sans expectedFilePath/expectedChangeType/allowFullRewrite déclarés",
    },
    "task-fidelity-no-fields",
  );
  // Sans champs de fidélité déclarés, seul le garde-fou de réécriture massive
  // (activé dès qu'un fichier existant est modifié) peut s'appliquer ; ici le
  // fichier original ne dépasse pas le seuil de lignes (MIN_LINES_FOR_REWRITE_GUARD),
  // donc PASS — la régression testée est l'absence de crash/de blocage inattendu.
  assert.equal(res.diffFidelity.fidelityStatus, "PASS");
});

// --- Correction bloquante PR-D : les champs de fidélité/sécurité doivent
// traverser le chemin runtime réel (TaskRequest.context → extractTaskParams
// → executeWorkflow), pas seulement les appels directs à executeWorkflow. ---

function mockOctokitForTaskRequestFlow(overrides: {
  baseSha?: string;
  existingContent?: string;
  calls?: string[];
} = {}): Octokit {
  const baseSha = overrides.baseSha ?? "base-sha";
  const calls = overrides.calls;
  const record = (c: string) => { if (calls) calls.push(c); };
  return {
    rest: {
      repos: {
        get: async () => { record("repos.get"); return { data: { default_branch: "main" } }; },
        getContent:
          overrides.existingContent !== undefined
            ? async () => { record("repos.getContent"); return { data: { type: "file", content: Buffer.from(overrides.existingContent!, "utf-8").toString("base64"), encoding: "base64", sha: "existing-file-sha" } }; }
            : async () => { record("repos.getContent"); throw new Error("404 Not Found"); },
        createOrUpdateFileContents: async () => { record("repos.createOrUpdateFileContents"); return { data: { commit: { sha: "sha-after-write" } } }; },
        compareCommits: async () => { record("repos.compareCommits"); return { data: { files: [{ filename: "docs/runtime.md", status: "added" }] } }; },
      },
      git: {
        getRef: async ({ ref }: { ref: string }) => {
          record(`git.getRef:${ref}`);
          if (ref.startsWith("heads/jarvis/")) throw new Error("404 Not Found");
          return { data: { object: { sha: baseSha } } };
        },
        createRef: async () => { record("git.createRef"); return { data: {} }; },
      },
      pulls: {
        list: async () => { record("pulls.list"); return { data: [] }; },
        create: async () => { record("pulls.create"); return { data: { html_url: "https://github.com/org/repo/pull/77", number: 77 } }; },
      },
    },
  } as unknown as Octokit;
}

function baseTaskRequest(context: Record<string, unknown>, taskId: string): TaskRequest {
  return {
    schema_version: "1.0",
    task_id: taskId,
    trace_id: `trace-${taskId}`,
    idempotency_key: `idemp-${taskId}`,
    capability: "software_development",
    objective: "Tâche de test du chemin runtime",
    context,
    constraints: [],
    priority: "medium",
    permissions: [],
  };
}

test("Chemin runtime 1 — expectedFilePath dans TaskRequest.context atteint réellement le fidelity gate", async () => {
  const calls: string[] = [];
  const octokit = mockOctokitForTaskRequestFlow({ calls });
  const service = new SoftwareFactoryService({ githubToken: "test-token", octokitClient: octokit });

  const req = baseTaskRequest(
    { filePath: "docs/runtime.md", instructions: "Créer le fichier", exactContent: "contenu", createIfMissing: true, expectedFilePath: "docs/authorized-only.md" },
    "task-runtime-expected-file-path",
  );
  const events = await service.handleTaskRequest(req);
  const failed = events.find((e) => e.type === "TASK_FAILED");
  assert.ok(failed, "un événement TASK_FAILED doit être émis");
  assert.equal(failed?.payload.error_code, "DIFF_FIDELITY_FAILED");
  assert.equal(calls.includes("git.createRef"), false, "aucune branche ne doit être créée");
  assert.equal(calls.includes("repos.createOrUpdateFileContents"), false, "aucun commit ne doit être tenté");
});

test("Chemin runtime 2 — expectedChangeType dans TaskRequest.context atteint réellement le fidelity gate", async () => {
  const calls: string[] = [];
  const octokit = mockOctokitForTaskRequestFlow({ calls, existingContent: "contenu préexistant que la mission ignorait" });
  const service = new SoftwareFactoryService({ githubToken: "test-token", octokitClient: octokit });

  const req = baseTaskRequest(
    { filePath: "docs/runtime.md", instructions: "Créer le fichier", exactContent: "contenu qui écraserait l'existant", createIfMissing: true, expectedChangeType: "create" },
    "task-runtime-expected-change-type",
  );
  const events = await service.handleTaskRequest(req);
  const failed = events.find((e) => e.type === "TASK_FAILED");
  assert.ok(failed);
  assert.equal(failed?.payload.error_code, "DIFF_FIDELITY_FAILED");
  assert.equal(calls.includes("repos.createOrUpdateFileContents"), false);
});

test("Chemin runtime 3 — allowFullRewrite dans TaskRequest.context atteint réellement le fidelity gate (lève le blocage de réécriture massive)", async () => {
  const originalContent = Array.from({ length: 20 }, (_, i) => `ligne originale ${i}`).join("\n");
  const calls: string[] = [];
  const octokit = mockOctokitForTaskRequestFlow({ calls, existingContent: originalContent });
  const service = new SoftwareFactoryService({ githubToken: "test-token", octokitClient: octokit });

  // Sans allowFullRewrite, cette même réécriture échouerait (ratio de rétention < 20%).
  const reqBlocked = baseTaskRequest(
    { filePath: "docs/runtime.md", instructions: "Réécrire le document", exactContent: "contenu totalement différent, sans rapport avec l'original" },
    "task-runtime-rewrite-blocked",
  );
  const blockedEvents = await service.handleTaskRequest(reqBlocked);
  assert.equal(blockedEvents.find((e) => e.type === "TASK_FAILED")?.payload.error_code, "DIFF_FIDELITY_FAILED");

  // Avec allowFullRewrite=true transmis dans le contexte, la même réécriture doit réussir.
  const reqAllowed = baseTaskRequest(
    { filePath: "docs/runtime.md", instructions: "Réécrire le document", exactContent: "contenu totalement différent, sans rapport avec l'original", allowFullRewrite: true },
    "task-runtime-rewrite-allowed",
  );
  const allowedEvents = await service.handleTaskRequest(reqAllowed);
  const completed = allowedEvents.find((e) => e.type === "TASK_COMPLETED");
  assert.ok(completed, "allowFullRewrite=true transmis via TaskRequest.context doit réellement lever le blocage");
  assert.ok(calls.includes("repos.createOrUpdateFileContents"));
});

test("Chemin runtime 4 — expectedBaseSha dans TaskRequest.context atteint réellement STALE_BASE", async () => {
  const calls: string[] = [];
  const octokit = mockOctokitForTaskRequestFlow({ calls, baseSha: "new-head-after-someone-else-merged" });
  const service = new SoftwareFactoryService({ githubToken: "test-token", octokitClient: octokit });

  const req = baseTaskRequest(
    { filePath: "docs/runtime.md", instructions: "Créer le fichier", exactContent: "contenu", createIfMissing: true, expectedBaseSha: "stale-sha-from-when-mission-was-planned" },
    "task-runtime-stale-base",
  );
  const events = await service.handleTaskRequest(req);
  const failed = events.find((e) => e.type === "TASK_FAILED");
  assert.ok(failed);
  assert.equal(failed?.payload.error_code, "STALE_BASE");
  assert.equal(calls.includes("git.createRef"), false);
  assert.equal(calls.includes("repos.createOrUpdateFileContents"), false);
});

test("Chemin runtime 5 — une valeur invalide (expectedChangeType inconnu) est rejetée avant toute écriture GitHub", async () => {
  const calls: string[] = [];
  const octokit = mockOctokitForTaskRequestFlow({ calls });
  const service = new SoftwareFactoryService({ githubToken: "test-token", octokitClient: octokit });

  const req = baseTaskRequest(
    { filePath: "docs/runtime.md", instructions: "Créer le fichier", exactContent: "contenu", createIfMissing: true, expectedChangeType: "delete" },
    "task-runtime-invalid-change-type",
  );
  const events = await service.handleTaskRequest(req);
  const failed = events.find((e) => e.type === "TASK_FAILED");
  assert.ok(failed);
  assert.equal(failed?.payload.error_code, "EXPECTED_CHANGE_TYPE_INVALID");
  assert.equal(calls.length, 0, "aucun appel GitHub, même en lecture, ne doit avoir lieu avant la validation des champs");
});

test("Chemin runtime — validation stricte des types pour les 4 champs (rejet avant toute écriture)", async () => {
  const cases: Array<{ context: Record<string, unknown>; expectedCode: string }> = [
    { context: { expectedBaseSha: "" }, expectedCode: "EXPECTED_BASE_SHA_INVALID" },
    { context: { expectedBaseSha: 123 }, expectedCode: "EXPECTED_BASE_SHA_INVALID" },
    { context: { expectedFilePath: "" }, expectedCode: "EXPECTED_FILE_PATH_INVALID" },
    { context: { expectedFilePath: 123 }, expectedCode: "EXPECTED_FILE_PATH_INVALID" },
    { context: { expectedChangeType: "delete" }, expectedCode: "EXPECTED_CHANGE_TYPE_INVALID" },
    { context: { expectedChangeType: 1 }, expectedCode: "EXPECTED_CHANGE_TYPE_INVALID" },
    { context: { allowFullRewrite: "true" }, expectedCode: "ALLOW_FULL_REWRITE_INVALID" },
    { context: { allowFullRewrite: 1 }, expectedCode: "ALLOW_FULL_REWRITE_INVALID" },
  ];
  for (const { context, expectedCode } of cases) {
    const calls: string[] = [];
    const octokit = mockOctokitForTaskRequestFlow({ calls });
    const service = new SoftwareFactoryService({ githubToken: "test-token", octokitClient: octokit });
    const req = baseTaskRequest(
      { filePath: "docs/runtime.md", instructions: "Créer le fichier", exactContent: "contenu", createIfMissing: true, ...context },
      `task-runtime-invalid-${expectedCode}`,
    );
    const events = await service.handleTaskRequest(req);
    const failed = events.find((e) => e.type === "TASK_FAILED");
    assert.equal(failed?.payload.error_code, expectedCode, `cas ${JSON.stringify(context)}`);
    assert.equal(calls.length, 0, `aucun appel GitHub pour ${JSON.stringify(context)}`);
  }
});

test("Chemin runtime — valeurs valides (create/update, booléen correct) ne sont jamais rejetées", async () => {
  const calls: string[] = [];
  const octokit = mockOctokitForTaskRequestFlow({ calls });
  const service = new SoftwareFactoryService({ githubToken: "test-token", octokitClient: octokit });
  const req = baseTaskRequest(
    { filePath: "docs/runtime.md", instructions: "Créer le fichier", exactContent: "contenu", createIfMissing: true, expectedChangeType: "create", allowFullRewrite: false, expectedFilePath: "docs/runtime.md" },
    "task-runtime-valid-values",
  );
  const events = await service.handleTaskRequest(req);
  assert.ok(events.find((e) => e.type === "TASK_COMPLETED"), "des valeurs valides ne doivent jamais être rejetées");
});

// ---------------------------------------------------------------------------
// surgical_edit (tâche 5 du brief JARVIS-00 : gap `surgical_edit` de
// gapAnalysis.ts, probable cause de la boucle de patches répétés PR #22-#27).
// Testé via le chemin d'appel réel (TaskRequest -> handleTaskRequest ->
// extractTaskParams -> executeWorkflow), pas seulement applySurgicalEdit()
// en isolation — preuve du câblage, pas juste de l'existence du code.
// ---------------------------------------------------------------------------

test("surgical_edit — corrige un test qui échoue par édition ciblée sans jamais appeler le LLM", async () => {
  const calls: string[] = [];
  const octokit = mockOctokitForTaskRequestFlow({ calls, existingContent: "function broken() {\n  return undefined;\n}\n" });
  const service = new SoftwareFactoryService({ githubToken: "test-token", octokitClient: octokit });
  service.generateCodeUpdate = async () => { throw new Error("generateCodeUpdate ne doit PAS être appelé si surgicalEdit est présent !"); };

  const req = baseTaskRequest(
    { filePath: "docs/runtime.md", instructions: "Corrige la fonction", oldString: "return undefined;", newString: "return 42;" },
    "task-surgical-edit-basic",
  );
  const events = await service.handleTaskRequest(req);
  const completed = events.find((e) => e.type === "TASK_COMPLETED");
  assert.ok(completed, "TASK_COMPLETED doit être émis");
  assert.ok(calls.includes("repos.createOrUpdateFileContents"), "le fichier édité doit être committé");
});

test("surgical_edit — le contenu committé est le fichier entier après édition, pas un fragment (secret guard/diff fidelity restent sur le fichier entier)", async () => {
  let writtenContent = "";
  const octokit = mockOctokitForTaskRequestFlow({ existingContent: "const a = 1;\nconst target = 'old';\nconst c = 3;\n" });
  (octokit.rest.repos as unknown as { createOrUpdateFileContents: (args: { content: string }) => Promise<{ data: { commit: { sha: string } } }> }).createOrUpdateFileContents =
    async ({ content }) => { writtenContent = Buffer.from(content, "base64").toString("utf-8"); return { data: { commit: { sha: "sha-surgical" } } }; };
  const service = new SoftwareFactoryService({ githubToken: "test-token", octokitClient: octokit });

  const req = baseTaskRequest(
    { filePath: "docs/runtime.md", instructions: "Corrige la valeur", oldString: "const target = 'old';", newString: "const target = 'new';" },
    "task-surgical-edit-full-file",
  );
  await service.handleTaskRequest(req);
  assert.equal(writtenContent, "const a = 1;\nconst target = 'new';\nconst c = 3;\n", "les lignes non concernées par l'édition doivent rester intactes, contrairement à une régénération LLM du fichier entier");
});

test("surgical_edit — le secret guard bloque toujours un secret introduit par l'édition, exactement comme pour exactContent/génération LLM (invariant préservé sans adaptation)", async () => {
  const calls: string[] = [];
  const octokit = mockOctokitForTaskRequestFlow({ calls, existingContent: "const token = 'placeholder';\n" });
  const service = new SoftwareFactoryService({ githubToken: "test-token", octokitClient: octokit });

  const req = baseTaskRequest(
    { filePath: "docs/runtime.md", instructions: "Mets à jour le token", oldString: "'placeholder'", newString: "'AKIAABCDEFGHIJKLMNOP'" },
    "task-surgical-edit-secret",
  );
  const events = await service.handleTaskRequest(req);
  const failed = events.find((e) => e.type === "TASK_FAILED");
  assert.equal(failed?.payload.error_code, "SECRET_DETECTED");
  assert.equal(calls.includes("repos.createOrUpdateFileContents"), false, "aucun commit ne doit être tenté avec un secret détecté");
});

test("surgical_edit — oldString introuvable échoue avant toute écriture GitHub, de façon replannable", async () => {
  const calls: string[] = [];
  const octokit = mockOctokitForTaskRequestFlow({ calls, existingContent: "const a = 1;\n" });
  const service = new SoftwareFactoryService({ githubToken: "test-token", octokitClient: octokit });

  const req = baseTaskRequest(
    { filePath: "docs/runtime.md", instructions: "Corrige", oldString: "const zzz = 999;", newString: "const zzz = 1000;" },
    "task-surgical-edit-not-found",
  );
  const events = await service.handleTaskRequest(req);
  const failed = events.find((e) => e.type === "TASK_FAILED");
  assert.equal(failed?.payload.error_code, "SURGICAL_EDIT_OLD_STRING_NOT_FOUND");
  assert.equal(failed?.payload.replannable, true);
  assert.equal(calls.includes("git.createRef"), false, "aucune branche ne doit être créée");
  assert.equal(calls.includes("repos.createOrUpdateFileContents"), false, "aucun commit ne doit être tenté");
});

test("surgical_edit — oldString ambigu (plusieurs occurrences) échoue plutôt que d'éditer au hasard, avant toute écriture GitHub", async () => {
  const calls: string[] = [];
  const octokit = mockOctokitForTaskRequestFlow({ calls, existingContent: "x = 1;\nx = 1;\n" });
  const service = new SoftwareFactoryService({ githubToken: "test-token", octokitClient: octokit });

  const req = baseTaskRequest(
    { filePath: "docs/runtime.md", instructions: "Corrige", oldString: "x = 1;", newString: "x = 2;" },
    "task-surgical-edit-ambiguous",
  );
  const events = await service.handleTaskRequest(req);
  const failed = events.find((e) => e.type === "TASK_FAILED");
  assert.equal(failed?.payload.error_code, "SURGICAL_EDIT_OLD_STRING_NOT_UNIQUE");
  assert.equal(calls.includes("repos.createOrUpdateFileContents"), false, "aucun commit ne doit être tenté sur une édition ambiguë");
});

test("surgical_edit — exactContent reste prioritaire si les deux sont fournis (comportement historique inchangé pour les appelants existants)", () => {
  const params = extractTaskParams(
    baseTaskRequest({ filePath: "docs/runtime.md", instructions: "x", exactContent: "CONTENU_EXACT", oldString: "a", newString: "b" }, "task-priority"),
  );
  assert.equal(params.exactContent, "CONTENU_EXACT");
  assert.deepEqual(params.surgicalEdit, { oldString: "a", newString: "b" });
});

// Review Codex (P1, PR #111) : oldString sans newString (ou l'inverse) retombait
// silencieusement sur la génération LLM du fichier entier — un changement bien plus
// large que l'édition ciblée demandée par un appel de tool mal formé.
test("surgical_edit — oldString sans newString (ou l'inverse) est rejeté plutôt que de retomber silencieusement sur la génération LLM du fichier entier", () => {
  for (const context of [
    { filePath: "docs/runtime.md", instructions: "x", oldString: "a" },
    { filePath: "docs/runtime.md", instructions: "x", newString: "b" },
    { filePath: "docs/runtime.md", instructions: "x", oldString: 123, newString: "b" },
    // review Codex #112 : les DEUX invalides (hasOldString===hasNewString===false) ne doit
    // pas passer inaperçu sous prétexte que la comparaison d'égalité de booléens ne le voit pas.
    { filePath: "docs/runtime.md", instructions: "x", oldString: 123, newString: 456 },
  ]) {
    assert.throws(
      () => extractTaskParams(baseTaskRequest(context, "task-incomplete-surgical")),
      (err: unknown) => err instanceof Error && err.message.includes("SURGICAL_EDIT_INCOMPLETE_ARGS"),
      JSON.stringify(context),
    );
  }
});

test("surgical_edit — ni oldString ni newString fournis : comportement historique inchangé (pas d'erreur, génération LLM normale)", () => {
  const params = extractTaskParams(baseTaskRequest({ filePath: "docs/runtime.md", instructions: "x" }, "task-no-surgical"));
  assert.equal(params.surgicalEdit, undefined);
});

// ---------------------------------------------------------------------------
// rollback / generate_revert_pr (tâche 5, sous-priorité 2 du brief JARVIS-00) :
// annuler proprement une PR mono-fichier de la Software Factory plutôt que d'en
// empiler une nouvelle par-dessus un chantier raté. Testé via le chemin d'appel
// réel (TaskRequest -> handleTaskRequest -> executeWorkflow).
// ---------------------------------------------------------------------------

function mockOctokitForRevertFlow(overrides: {
  calls?: string[];
  targetPrFiles?: Array<{ filename: string }>;
  contentBeforeTargetPr?: string | null;
  currentContent?: string;
} = {}): Octokit {
  const calls = overrides.calls;
  const record = (c: string) => { if (calls) calls.push(c); };
  const targetPrFiles = overrides.targetPrFiles ?? [{ filename: "docs/reverted.md" }];
  const currentContent = overrides.currentContent ?? "contenu actuel (la mauvaise version)";
  return {
    rest: {
      repos: {
        get: async () => { record("repos.get"); return { data: { default_branch: "main" } }; },
        getContent: async ({ ref }: { ref: string }) => {
          record(`repos.getContent:${ref}`);
          if (ref === "sha-before-target-pr") {
            if (overrides.contentBeforeTargetPr === null) throw new Error("404 Not Found");
            return { data: { type: "file", content: Buffer.from(overrides.contentBeforeTargetPr ?? "contenu d'avant la PR annulée", "utf-8").toString("base64"), encoding: "base64", sha: "sha-old" } };
          }
          return { data: { type: "file", content: Buffer.from(currentContent, "utf-8").toString("base64"), encoding: "base64", sha: "sha-current" } };
        },
        createOrUpdateFileContents: async () => { record("repos.createOrUpdateFileContents"); return { data: { commit: { sha: "sha-after-revert" } } }; },
        compareCommits: async () => { record("repos.compareCommits"); return { data: { files: [{ filename: "docs/reverted.md", status: "modified" }] } }; },
      },
      git: {
        getRef: async ({ ref }: { ref: string }) => {
          record(`git.getRef:${ref}`);
          if (ref.startsWith("heads/jarvis/")) throw new Error("404 Not Found");
          return { data: { object: { sha: "base-sha" } } };
        },
        createRef: async () => { record("git.createRef"); return { data: {} }; },
      },
      pulls: {
        get: async ({ pull_number }: { pull_number: number }) => {
          record(`pulls.get:${pull_number}`);
          return { data: { base: { sha: "sha-before-target-pr" }, title: "PR à annuler" } };
        },
        listFiles: async ({ pull_number }: { pull_number: number }) => { record(`pulls.listFiles:${pull_number}`); return { data: targetPrFiles }; },
        list: async () => { record("pulls.list"); return { data: [] }; },
        create: async () => { record("pulls.create"); return { data: { html_url: "https://github.com/org/repo/pull/88", number: 88 } }; },
      },
    },
  } as unknown as Octokit;
}

test("rollback — annule une PR mono-fichier en restaurant le contenu d'avant cette PR, dans une nouvelle PR propre", async () => {
  const calls: string[] = [];
  const octokit = mockOctokitForRevertFlow({ calls, contentBeforeTargetPr: "contenu d'avant la PR annulée" });
  const service = new SoftwareFactoryService({ githubToken: "test-token", octokitClient: octokit });
  service.generateCodeUpdate = async () => { throw new Error("generateCodeUpdate ne doit PAS être appelé pour un rollback !"); };

  const req = baseTaskRequest(
    { filePath: "docs/reverted.md", instructions: "Annule ce chantier raté", revertPrNumber: 42 },
    "task-rollback-basic",
  );
  const events = await service.handleTaskRequest(req);
  const completed = events.find((e) => e.type === "TASK_COMPLETED");
  assert.ok(completed, "TASK_COMPLETED doit être émis");
  assert.equal(completed?.payload.pr_number, 88, "une PR distincte (propre) est ouverte pour le revert, pas un nouveau commit empilé");
  assert.ok(calls.includes("pulls.get:42"), "la PR ciblée doit être lue");
  assert.ok(calls.includes("pulls.listFiles:42"), "les fichiers de la PR ciblée doivent être listés");
  assert.ok(calls.includes("repos.getContent:sha-before-target-pr"), "le contenu doit être lu au base_sha de la PR ciblée, jamais fourni par l'appelant");
  assert.ok(calls.includes("repos.createOrUpdateFileContents"));
});

test("rollback — le contenu committé est exactement celui d'avant la PR ciblée", async () => {
  let writtenContent = "";
  const octokit = mockOctokitForRevertFlow({ contentBeforeTargetPr: "VERSION_ORIGINALE_A_RESTAURER" });
  (octokit.rest.repos as unknown as { createOrUpdateFileContents: (args: { content: string }) => Promise<{ data: { commit: { sha: string } } }> }).createOrUpdateFileContents =
    async ({ content }) => { writtenContent = Buffer.from(content, "base64").toString("utf-8"); return { data: { commit: { sha: "sha-after-revert" } } }; };
  const service = new SoftwareFactoryService({ githubToken: "test-token", octokitClient: octokit });

  const req = baseTaskRequest({ filePath: "docs/reverted.md", instructions: "Annule", revertPrNumber: 42 }, "task-rollback-content");
  await service.handleTaskRequest(req);
  assert.equal(writtenContent, "VERSION_ORIGINALE_A_RESTAURER");
});

test("rollback — refuse une PR ciblée qui modifie plusieurs fichiers, avant toute écriture GitHub", async () => {
  const calls: string[] = [];
  const octokit = mockOctokitForRevertFlow({ calls, targetPrFiles: [{ filename: "docs/a.md" }, { filename: "docs/b.md" }] });
  const service = new SoftwareFactoryService({ githubToken: "test-token", octokitClient: octokit });

  const req = baseTaskRequest({ filePath: "docs/a.md", instructions: "Annule", revertPrNumber: 42 }, "task-rollback-multifile");
  const events = await service.handleTaskRequest(req);
  const failed = events.find((e) => e.type === "TASK_FAILED");
  assert.equal(failed?.payload.error_code, "REVERT_MULTI_FILE_UNSUPPORTED");
  assert.equal(calls.includes("repos.createOrUpdateFileContents"), false);
});

test("rollback — refuse un filePath qui ne correspond pas au fichier réellement modifié par la PR ciblée", async () => {
  const calls: string[] = [];
  const octokit = mockOctokitForRevertFlow({ calls, targetPrFiles: [{ filename: "docs/autre-fichier.md" }] });
  const service = new SoftwareFactoryService({ githubToken: "test-token", octokitClient: octokit });

  const req = baseTaskRequest({ filePath: "docs/reverted.md", instructions: "Annule", revertPrNumber: 42 }, "task-rollback-mismatch");
  const events = await service.handleTaskRequest(req);
  const failed = events.find((e) => e.type === "TASK_FAILED");
  assert.equal(failed?.payload.error_code, "REVERT_FILE_MISMATCH");
  assert.equal(calls.includes("repos.createOrUpdateFileContents"), false);
});

test("rollback — refuse d'annuler une PR qui a créé le fichier (exigerait une suppression, non supportée)", async () => {
  const calls: string[] = [];
  const octokit = mockOctokitForRevertFlow({ calls, contentBeforeTargetPr: null });
  const service = new SoftwareFactoryService({ githubToken: "test-token", octokitClient: octokit });

  const req = baseTaskRequest({ filePath: "docs/reverted.md", instructions: "Annule", revertPrNumber: 42 }, "task-rollback-creation");
  const events = await service.handleTaskRequest(req);
  const failed = events.find((e) => e.type === "TASK_FAILED");
  assert.equal(failed?.payload.error_code, "REVERT_REQUIRES_DELETE");
  assert.equal(calls.includes("repos.createOrUpdateFileContents"), false);
});

test("rollback — la PR ciblée introuvable échoue proprement, de façon replannable", async () => {
  const octokit = mockOctokitForRevertFlow();
  (octokit.rest.pulls as unknown as { get: () => Promise<never> }).get = async () => { throw new Error("404 Not Found"); };
  const service = new SoftwareFactoryService({ githubToken: "test-token", octokitClient: octokit });

  const req = baseTaskRequest({ filePath: "docs/reverted.md", instructions: "Annule", revertPrNumber: 999 }, "task-rollback-not-found");
  const events = await service.handleTaskRequest(req);
  const failed = events.find((e) => e.type === "TASK_FAILED");
  assert.equal(failed?.payload.error_code, "REVERT_PR_NOT_FOUND");
  assert.equal(failed?.payload.replannable, true);
});

test("rollback — un revertPrNumber invalide est rejeté avant tout accès réseau", () => {
  for (const revertPrNumber of [0, -1, 1.5, "42"]) {
    assert.throws(
      () => extractTaskParams(baseTaskRequest({ filePath: "docs/reverted.md", instructions: "x", revertPrNumber }, "task-rollback-invalid")),
      (err: unknown) => err instanceof Error && err.message.includes("REVERT_PR_NUMBER_INVALID"),
      JSON.stringify(revertPrNumber),
    );
  }
});

test("Agent : un tool call software_development avec revertPrNumber atteint bien TaskRequest.context (schéma du skill câblé)", async () => {
  const { Agent } = await import("../core/agent.js");
  const { LocalHashingEmbeddingProvider } = await import("../llm/embeddings.js");
  const { ServiceOrchestrator } = await import("../orchestration/serviceOrchestrator.js");
  const { ServiceAdapter } = await import("../orchestration/serviceAdapter.js");
  config.db.path = ":memory:";
  // software_development est classé HIGH (impact réel sur le code source) : le plafond de
  // risque global doit couvrir HIGH pour que dispatchCapability atteigne réellement le service.
  config.autonomy.globalRiskLevel = "HIGH";
  config.autonomy.permissionMatrix = "EXECUTE";
  const { closeDb, getDb } = await import("../persistence/db.js");
  closeDb();
  getDb();

  class RecordingAdapter extends ServiceAdapter {
    readonly factoryCalls: TaskRequest[] = [];
    override async dispatchTask(value: unknown, request: TaskRequest) {
      const serviceId = typeof value === "string" ? value : (value as { id: string }).id;
      if (serviceId !== "software_factory") return super.dispatchTask(value as never, request);
      this.factoryCalls.push(request);
      return {
        success: true,
        events: [{
          schema_version: "1.0", event_id: `evt-${request.task_id}`, task_id: request.task_id, trace_id: request.trace_id,
          service: "software_factory", sequence: 1, type: "TASK_COMPLETED" as const, timestamp: Date.now(),
          payload: { status: "COMPLETED", branch: "jarvis/revert", commit_sha: "abc", pr_number: 1, pr_url: "https://github.com/org/repo/pull/1", filePath: request.context.filePath, summary: "Revert" },
        }],
        transportDurationMs: 0,
      };
    }
  }
  const adapter = new RecordingAdapter();
  const orchestrator = new ServiceOrchestrator({ adapter });
  let call = 0;
  const llm = {
    name: "revert-schema-test",
    async complete(_messages: unknown, _options: unknown) {
      call += 1;
      if (call === 1) {
        return { content: null, toolCalls: [{ id: "call-revert", type: "function", function: { name: "software_development", arguments: JSON.stringify({ objective: "Annule la PR #77", filePath: "docs/reverted.md", instructions: "Annule un chantier raté", revertPrNumber: 77 }) } }] };
      }
      return { content: "PR de revert créée" };
    },
  };
  const agent = new Agent({ llm: llm as any, embeddings: new LocalHashingEmbeddingProvider(), orchestrator });
  (agent.skillSelector as any).select = async () => [agent.skills.get("software_development")!];
  await agent.step("annule la PR #77, ce chantier a mal tourné");
  assert.equal(adapter.factoryCalls.length, 1);
  assert.equal(adapter.factoryCalls[0].context.revertPrNumber, 77);
});
