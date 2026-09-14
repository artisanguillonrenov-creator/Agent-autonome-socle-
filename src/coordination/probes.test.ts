import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { closeDb, getDb } from "../persistence/db.js";
import { config } from "../config.js";
import { WorkspaceStore } from "../workspaces/workspaceStore.js";
import type { GithubReadOnlyClient, RepoRef, FileContentResult, CiStatusResult, MainProtectionResult } from "../repository/githubReadOnlyClient.js";
import { runProbe, createDocumentReadProbe, createDatabaseQueryProbe, createRepositoryReadProbe, createCiStatusProbe, createMainProtectionProbe, createWebSearchProbe } from "./probes.js";
import Database from "better-sqlite3";

function setupWorkspace() {
  config.db.path = ":memory:";
  closeDb();
  getDb();
  const workspaces = new WorkspaceStore(mkdtempSync(join(tmpdir(), "probes-")), 40 * 1024 * 1024, 500 * 1024 * 1024);
  const workspaceId = workspaces.create({ name: "probes", ownerType: "ADHOC", ownerId: randomUUID() }).id;
  return { workspaces, workspaceId };
}

function notImplemented(name: string) {
  return async () => {
    throw new Error(`NOT_IMPLEMENTED:${name}`);
  };
}

function fakeGithubClient(overrides: Partial<GithubReadOnlyClient> = {}): GithubReadOnlyClient {
  return {
    getDefaultBranch: notImplemented("getDefaultBranch"),
    getTree: notImplemented("getTree"),
    getFileContent: notImplemented("getFileContent"),
    getPullRequest: notImplemented("getPullRequest"),
    listPullRequestFiles: notImplemented("listPullRequestFiles"),
    getPullRequestDiff: notImplemented("getPullRequestDiff"),
    getCommit: notImplemented("getCommit"),
    compare: notImplemented("compare"),
    getCiStatus: notImplemented("getCiStatus"),
    getMainProtectionStatus: notImplemented("getMainProtectionStatus"),
    ...overrides,
  };
}

// --- document_read → document fixture (§PHASE 6) ---
test("createDocumentReadProbe lit réellement un fichier fixture d'un workspace", async () => {
  const { workspaces, workspaceId } = setupWorkspace();
  workspaces.writeFile(workspaceId, "notes.md", "# Probe fixture\ncontenu réel.");
  const result = await runProbe(createDocumentReadProbe({ probeId: "p1", serviceId: "workbench", skillId: "document_work", workspaces, workspaceId, path: "notes.md" }));
  assert.equal(result.success, true);
  assert.equal(result.capabilityId, "document_work");
  assert.match(result.evidenceRef, /notes\.md/);
});

test("createDocumentReadProbe échoue proprement sur un fichier inexistant (jamais d'exception qui remonte)", async () => {
  const { workspaces, workspaceId } = setupWorkspace();
  const result = await runProbe(createDocumentReadProbe({ probeId: "p1", serviceId: "workbench", skillId: "document_work", workspaces, workspaceId, path: "absent.md" }));
  assert.equal(result.success, false);
  assert.ok(result.errorCode);
});

// --- database_query → SELECT contrôlé (§PHASE 6) ---
test("createDatabaseQueryProbe exécute réellement un SELECT contrôlé sur une base SQLite du workspace", async () => {
  const { workspaces, workspaceId } = setupWorkspace();
  const relPath = "probe.sqlite";
  const sqliteDb = new Database(join(workspaces.root, workspaceId, relPath));
  sqliteDb.exec("CREATE TABLE t (x INTEGER);");
  sqliteDb.close();
  const result = await runProbe(createDatabaseQueryProbe({ probeId: "p2", serviceId: "workbench", skillId: "database_query", workspaces, workspaceId, path: relPath }));
  assert.equal(result.success, true);
  assert.equal(result.capabilityId, "database_query");
});

// --- read_repository → lire réellement un fichier connu (§PHASE 6) ---
test("createRepositoryReadProbe lit réellement un fichier connu via GithubReadOnlyClient", async () => {
  const target: RepoRef = { owner: "acme", repo: "demo" };
  const client = fakeGithubClient({
    getDefaultBranch: async () => "main",
    getFileContent: async (): Promise<FileContentResult> => ({ content: "hello", encoding: "utf-8", size: 5, sha: "abc", isDirectory: false }),
  });
  const result = await runProbe(createRepositoryReadProbe({ probeId: "p3", serviceId: "software_factory", skillId: "knowledge_search", client, target, knownPath: "README.md" }));
  assert.equal(result.success, true);
  assert.equal(result.capabilityId, "knowledge_search");
  assert.match(result.evidenceRef, /README\.md/);
});

test("createRepositoryReadProbe échoue proprement si le fichier est un répertoire", async () => {
  const target: RepoRef = { owner: "acme", repo: "demo" };
  const client = fakeGithubClient({
    getDefaultBranch: async () => "main",
    getFileContent: async (): Promise<FileContentResult> => ({ content: "", encoding: "utf-8", size: 0, sha: "abc", isDirectory: true }),
  });
  const result = await runProbe(createRepositoryReadProbe({ probeId: "p3", serviceId: "software_factory", skillId: "knowledge_search", client, target, knownPath: "src" }));
  assert.equal(result.success, false);
});

// --- read_ci_status : capacité réelle, jamais encore câblée à un skill (voir gap analysis) ---
test("createCiStatusProbe lit réellement le statut CI d'un SHA connu", async () => {
  const target: RepoRef = { owner: "acme", repo: "demo" };
  const client = fakeGithubClient({
    getCiStatus: async (): Promise<CiStatusResult> => ({ sha: "deadbeef", overallState: "success", totalCount: 1, checks: [] }),
  });
  const result = await runProbe(createCiStatusProbe({ probeId: "p4", serviceId: "software_factory", skillId: "read_ci_status", client, target, sha: "deadbeef" }));
  assert.equal(result.success, true);
  assert.match(result.evidenceRef, /deadbeef/);
});

test("createMainProtectionProbe lit réellement la protection de branche, jamais destructif", async () => {
  const target: RepoRef = { owner: "acme", repo: "demo" };
  const client = fakeGithubClient({
    getMainProtectionStatus: async (): Promise<MainProtectionResult> => ({
      status: "MAIN_PROTECTION_VERIFIED",
      branch: "main",
      pullRequestRequired: true,
      requiredChecksConfigured: true,
      forcePushBlocked: true,
      adminsEnforced: true,
      reason: "ok",
    }),
  });
  const result = await runProbe(createMainProtectionProbe({ probeId: "p5", serviceId: "software_factory", skillId: "read_main_protection", client, target, branch: "main" }));
  assert.equal(result.success, true);
});

// --- web_search → requête contrôlée (§PHASE 6) ---
test("createWebSearchProbe exécute une requête contrôlée", async () => {
  const result = await runProbe(createWebSearchProbe({ probeId: "p6", serviceId: "web_search", skillId: "web_search", search: async () => [{ title: "x" }], query: "jarvis probe test" }));
  assert.equal(result.success, true);
  assert.match(result.evidenceRef, /jarvis probe test/);
});

// --- runProbe : jamais d'exception qui remonte ---
test("runProbe capture une exception levée par run() et la transforme en échec structuré", async () => {
  const result = await runProbe({
    probeId: "p7",
    serviceId: "x",
    capabilityId: "x",
    skillId: "x",
    run: async () => {
      throw new Error("BOOM");
    },
  });
  assert.equal(result.success, false);
  assert.equal(result.errorCode, "BOOM");
});

// --- O/P. Aucune méthode d'écriture/fusion GitHub, aucune action destructive dans ce module ---
test("O/P — aucune méthode d'écriture/fusion GitHub dans probes.ts (probes strictement non destructifs)", () => {
  const path = fileURLToPath(new URL("./probes.ts", import.meta.url));
  const source = readFileSync(path, "utf-8");
  assert.doesNotMatch(source, /octokit|\.merge\(|createOrUpdateFileContents|createRef\(|deleteFile\(|writeFile\(/i);
});
