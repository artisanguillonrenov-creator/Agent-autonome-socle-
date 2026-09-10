import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { canonicalSkillCatalog } from "./catalog.js";
import { SkillRegistry } from "./registry.js";
import { LocalHashingEmbeddingProvider } from "../llm/embeddings.js";
import { SkillSelector } from "./selector.js";
import { config } from "../config.js";
import { closeDb, getDb } from "../persistence/db.js";
import { ServiceRegistry } from "../orchestration/serviceRegistry.js";
import { ServiceOrchestrator } from "../orchestration/serviceOrchestrator.js";
import { ServiceAdapter } from "../orchestration/serviceAdapter.js";
import { Planner } from "../planning/planner.js";
import { PlanRunner } from "../planning/planRunner.js";
import { WorkflowRegistry } from "../workflows/workflowRegistry.js";
import { createRuntimeSkills } from "./runtime.js";
import type { GithubReadOnlyClient, RepoRef, TreeEntry } from "../repository/githubReadOnlyClient.js";

const TARGET: RepoRef = { owner: "artisanguillonrenov-creator", repo: "Agent-autonome-socle-" };

/** Client GitHub en lecture seule minimal pour piloter le runtime réel de Jarvis sans réseau. */
function mockRepositoryClient(): GithubReadOnlyClient {
  const tree: TreeEntry[] = [
    { path: "README.md", type: "blob" },
    { path: "src", type: "tree" },
    { path: "src/index.ts", type: "blob" },
  ];
  const files: Record<string, string> = {
    "README.md": "# Agent Autonome Socle\n\nCe dépôt contient Jarvis.",
    "src/index.ts": "export function main() { console.log('jarvis'); }",
  };
  return {
    async getDefaultBranch() {
      return "main";
    },
    async getTree() {
      return { entries: tree, truncatedByGithub: false };
    },
    async getFileContent(_target, path) {
      if (!(path in files)) throw new Error(`NOT_FOUND:${path}`);
      const content = files[path];
      return { content, encoding: "utf-8", size: content.length, sha: `sha-${path}`, isDirectory: false };
    },
    async getPullRequest() {
      return {
        number: 1,
        title: "Sample PR",
        body: "body",
        state: "open",
        draft: false,
        author: "octocat",
        baseRef: "main",
        baseSha: "base",
        headRef: "feature",
        headSha: "head",
        additions: 1,
        deletions: 0,
        changedFiles: 1,
        commits: 1,
        mergeable: true,
        createdAt: "2024-01-01T00:00:00Z",
        updatedAt: "2024-01-01T00:00:00Z",
        labels: [],
      };
    },
    async listPullRequestFiles() {
      return [{ path: "src/index.ts", status: "modified", additions: 1, deletions: 0, changes: 1, patch: "@@ -1 +1 @@" }];
    },
    async getPullRequestDiff() {
      return "diff --git a/src/index.ts b/src/index.ts\n+// change\n";
    },
    async getCommit() {
      return { sha: "deadbeef", message: "fix", author: "Ada", date: "2024-01-01T00:00:00Z", additions: 1, deletions: 0, files: [], totalFiles: 0 };
    },
    async compare() {
      return { aheadBy: 1, behindBy: 0, totalCommits: 1, files: [], totalFiles: 0 };
    },
  };
}

/** Même harnais que reusableIntelligence.test.ts, avec injection d'un client Repository Intelligence mocké. */
function harness(repositoryClient: GithubReadOnlyClient = mockRepositoryClient()) {
  config.db.path = ":memory:";
  config.workspace.root = mkdtempSync(join(tmpdir(), "knowledge-search-"));
  closeDb();
  getDb();
  const services = new ServiceRegistry("/missing.json");
  services.register({ id: "software_factory", name: "software", enabled: true, transport: "local", endpoint: "software_factory", capabilities: ["software_development"], priority: 10, riskByCapability: { software_development: "MEDIUM" }, auth: { type: "none" } });
  const adapter = new ServiceAdapter();
  const orchestrator = new ServiceOrchestrator({ registry: services, adapter });
  const planner = new Planner();
  const runner = new PlanRunner(orchestrator, planner);
  const workflows = new WorkflowRegistry();
  const skills = createRuntimeSkills(orchestrator, planner, runner, workflows, repositoryClient);
  return { services, orchestrator, planner, runner, workflows, skills, get: (id: string) => skills.find((s) => s.id === id)! };
}

test("knowledge_search est déclaré AVAILABLE dans le catalogue canonique (toujours 40 skills)", () => {
  assert.equal(canonicalSkillCatalog.length, 40);
  const skill = canonicalSkillCatalog.find((s) => s.id === "knowledge_search")!;
  assert.ok(skill);
  assert.equal(skill.kind, "SKILL");
  assert.equal(skill.availability, "AVAILABLE");
  assert.equal(skill.risk, "LOW");
});

test("knowledge_search est sélectionnable et boosté par des requêtes de type dépôt/PR/commit", async () => {
  const h = harness();
  const registry = new SkillRegistry(new LocalHashingEmbeddingProvider());
  for (const skill of h.skills) registry.register(skill);
  const selector = new SkillSelector(registry, 8);
  assert.ok((await selector.select("regarde le dépôt et dis-moi où se trouve la config")).some((s) => s.name === "knowledge_search"));
  assert.ok((await selector.select("analyse cette pull request")).some((s) => s.name === "knowledge_search"));
  assert.ok((await selector.select("lis le commit deadbeef")).some((s) => s.name === "knowledge_search"));
});

test("knowledge_search TREE parcourt l'arborescence via le runtime réel", async () => {
  const h = harness();
  const skill = h.get("knowledge_search");
  const result = JSON.parse(await skill.handler!({ action: "TREE" }, {} as any));
  assert.equal(result.owner, TARGET.owner);
  assert.equal(result.ref, "main");
  assert.ok(result.entries.some((e: any) => e.path === "src/index.ts"));
  assert.equal(result.truncated, false);
});

test("knowledge_search READ_FILE lit un fichier réel du dépôt", async () => {
  const h = harness();
  const skill = h.get("knowledge_search");
  const result = JSON.parse(await skill.handler!({ action: "READ_FILE", path: "README.md" }, {} as any));
  assert.ok(result.text.includes("Jarvis"));
  assert.equal(result.blocked, false);
});

test("knowledge_search READ_FILE bloque un fichier sensible même demandé explicitement", async () => {
  const h = harness();
  const skill = h.get("knowledge_search");
  const result = JSON.parse(await skill.handler!({ action: "READ_FILE", path: ".env" }, {} as any));
  assert.equal(result.blocked, true);
  assert.equal(result.text, undefined);
});

test("knowledge_search READ_PR / READ_PR_DIFF fonctionnent via le runtime réel", async () => {
  const h = harness();
  const skill = h.get("knowledge_search");
  const pr = JSON.parse(await skill.handler!({ action: "READ_PR", prNumber: 1 }, {} as any));
  assert.equal(pr.number, 1);
  const diff = JSON.parse(await skill.handler!({ action: "READ_PR_DIFF", prNumber: 1 }, {} as any));
  assert.match(diff.diff, /^diff --git/);
});

test("knowledge_search refuse toute action d'écriture via le SkillRegistry réel (contrat de schéma)", async () => {
  const h = harness();
  const registry = new SkillRegistry(new LocalHashingEmbeddingProvider());
  for (const skill of h.skills) registry.register(skill);
  for (const action of ["WRITE_FILE", "CREATE_COMMIT", "CREATE_PR", "MERGE_PR", "PUSH_BRANCH", "DELETE_FILE"]) {
    const output = await registry.execute("knowledge_search", { action }, {} as any);
    assert.match(output, /Erreur/);
    assert.match(output, /INVALID_SKILL_INPUT/);
  }
  // additionalProperties:false — aucun champ d'écriture (ex: content à committer) n'est accepté.
  const withUnknownField = await registry.execute("knowledge_search", { action: "TREE", content: "malicious write attempt" }, {} as any);
  assert.match(withUnknownField, /INVALID_SKILL_INPUT/);
});

test("knowledge_search n'a pas de dépendance à un ServiceOrchestrator/service capability (LOCAL_HANDLER, lecture seule locale à Jarvis)", () => {
  const skill = canonicalSkillCatalog.find((s) => s.id === "knowledge_search")!;
  assert.equal(skill.executionTarget, "LOCAL_HANDLER");
  assert.equal(skill.serviceCapability, undefined);
});

// ---------------------------------------------------------------------------
// Intégration via le runtime réel de l'Agent (boucle Tool Calling complète)
// ---------------------------------------------------------------------------

test("intégration Agent réelle : un tool call knowledge_search est exécuté de bout en bout", async () => {
  const { Agent } = await import("../core/agent.js");
  config.db.path = ":memory:";
  config.workspace.root = mkdtempSync(join(tmpdir(), "knowledge-search-agent-"));
  closeDb();
  let calls = 0;
  let toolResult = "";
  const llm = {
    name: "gate",
    supportsNativeTools: true,
    async complete(messages: any[], options: any) {
      calls++;
      if (calls === 1) {
        assert.ok((options.tools ?? []).some((t: any) => t.function.name === "knowledge_search"), "knowledge_search doit être proposé au LLM");
        return { content: null, toolCalls: [{ id: "call-1", type: "function", function: { name: "knowledge_search", arguments: JSON.stringify({ action: "READ_FILE", path: "README.md" }) } }] };
      }
      toolResult = messages.find((m) => m.role === "tool" && m.toolCallId === "call-1")?.content ?? "";
      return { content: "done" };
    },
  };
  const agent = new Agent({ llm: llm as any, embeddings: new LocalHashingEmbeddingProvider(), repositoryClient: mockRepositoryClient() });
  (agent.skillSelector as any).select = async () => [agent.skills.get("knowledge_search")!];
  await agent.step("regarde le dépôt et dis-moi ce que contient le README");
  assert.equal(calls, 2);
  assert.match(toolResult, /Résultat de l'outil 'knowledge_search'/);
  const parsed = JSON.parse(toolResult.replace(/^\[Résultat de l'outil '[^']+'\]:\s*/, ""));
  assert.ok(parsed.text.includes("Jarvis"));
});

test("intégration Agent réelle : refuse un tool call knowledge_search forgé hors sélection (exposure gate)", async () => {
  const { Agent } = await import("../core/agent.js");
  config.db.path = ":memory:";
  config.workspace.root = mkdtempSync(join(tmpdir(), "knowledge-search-gate-"));
  closeDb();
  let calls = 0;
  let secondMessages: any[] = [];
  const llm = {
    name: "gate",
    supportsNativeTools: true,
    async complete(messages: any[], options: any) {
      calls++;
      assert.equal((options.tools ?? []).some((t: any) => t.function.name === "knowledge_search"), false);
      if (calls === 1) return { content: null, toolCalls: [{ id: "forged", type: "function", function: { name: "knowledge_search", arguments: JSON.stringify({ action: "TREE" }) } }] };
      secondMessages = messages;
      return { content: "done" };
    },
  };
  const agent = new Agent({ llm: llm as any, embeddings: new LocalHashingEmbeddingProvider(), repositoryClient: mockRepositoryClient() });
  (agent.skillSelector as any).select = async () => [];
  await agent.step("bonjour");
  const tool = secondMessages.find((m) => m.role === "tool" && m.toolCallId === "forged");
  assert.equal(tool?.content, "TOOL_NOT_AVAILABLE_THIS_TURN");
  assert.equal(calls, 2);
});
