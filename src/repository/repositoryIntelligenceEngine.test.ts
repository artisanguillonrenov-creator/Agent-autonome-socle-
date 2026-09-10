import test from "node:test";
import assert from "node:assert/strict";
import type {
  GithubReadOnlyClient,
  RepoRef,
  TreeEntry,
  PullRequestSummary,
  PullRequestFileEntry,
  CommitSummary,
  CompareResult,
} from "./githubReadOnlyClient.js";
import {
  resolveRepoTarget,
  browseTree,
  readRepositoryFile,
  readRepositoryFiles,
  searchRepositoryPath,
  searchRepositoryCode,
  readPullRequest,
  readPullRequestFiles,
  readPullRequestDiff,
  readCommit,
  readDiffBetweenVersions,
  buildRepositoryContext,
  auditRepository,
} from "./repositoryIntelligenceEngine.js";

const TARGET: RepoRef = { owner: "acme", repo: "widgets" };

interface Fixture {
  defaultBranch?: string;
  tree?: TreeEntry[];
  truncatedByGithub?: boolean;
  files?: Record<string, string>;
  pr?: PullRequestSummary;
  prFiles?: PullRequestFileEntry[];
  prDiff?: string;
  commit?: CommitSummary;
  compare?: CompareResult;
}

function mockClient(fixture: Fixture = {}) {
  const files = fixture.files ?? {};
  const fileContentCalls: string[] = [];
  const client: GithubReadOnlyClient = {
    async getDefaultBranch() {
      return fixture.defaultBranch ?? "main";
    },
    async getTree() {
      return { entries: fixture.tree ?? [], truncatedByGithub: fixture.truncatedByGithub ?? false };
    },
    async getFileContent(_target, path) {
      fileContentCalls.push(path);
      if (!(path in files)) throw new Error(`REPOSITORY_MOCK_FILE_NOT_FOUND:${path}`);
      const content = files[path];
      if (content === "__DIR__") return { content: "", encoding: "none", size: 0, sha: "", isDirectory: true };
      const buf = Buffer.from(content, "utf-8");
      return { content, encoding: "utf-8", size: buf.length, sha: `sha-${path}`, isDirectory: false };
    },
    async getPullRequest() {
      if (!fixture.pr) throw new Error("REPOSITORY_MOCK_PR_NOT_FOUND");
      return fixture.pr;
    },
    async listPullRequestFiles() {
      return fixture.prFiles ?? [];
    },
    async getPullRequestDiff() {
      return fixture.prDiff ?? "";
    },
    async getCommit() {
      if (!fixture.commit) throw new Error("REPOSITORY_MOCK_COMMIT_NOT_FOUND");
      return fixture.commit;
    },
    async compare() {
      if (!fixture.compare) throw new Error("REPOSITORY_MOCK_COMPARE_NOT_FOUND");
      return fixture.compare;
    },
  };
  return { client, fileContentCalls };
}

// ---------------------------------------------------------------------------
// resolveRepoTarget
// ---------------------------------------------------------------------------

test("resolveRepoTarget: défaut, owner/repo explicites, repoUrl, et rejets", () => {
  assert.deepEqual(resolveRepoTarget({}), { owner: "artisanguillonrenov-creator", repo: "Agent-autonome-socle-" });
  assert.deepEqual(resolveRepoTarget({ owner: "acme", repo: "widgets" }), { owner: "acme", repo: "widgets" });
  assert.deepEqual(resolveRepoTarget({ repoUrl: "https://github.com/acme/widgets" }), { owner: "acme", repo: "widgets" });
  assert.throws(() => resolveRepoTarget({ owner: "acme" }), /REPOSITORY_TARGET_INVALID/);
  assert.throws(() => resolveRepoTarget({ repoUrl: "not a repo" }), /REPOSITORY_TARGET_INVALID/);
});

// ---------------------------------------------------------------------------
// TREE — lecture d'arborescence (test obligatoire)
// ---------------------------------------------------------------------------

test("browseTree liste les entrées, filtre par préfixe et signale les troncatures", async () => {
  const tree: TreeEntry[] = [
    { path: "README.md", type: "blob" },
    { path: "src", type: "tree" },
    { path: "src/index.ts", type: "blob" },
    { path: "src/utils.ts", type: "blob" },
    { path: "docs/guide.md", type: "blob" },
  ];
  const { client } = mockClient({ tree, truncatedByGithub: true });
  const result = await browseTree(client, TARGET, "main");
  assert.equal(result.entries.length, 5);
  assert.equal(result.truncated, true);
  assert.ok(result.warnings.includes("REPOSITORY_TREE_TRUNCATED_BY_GITHUB"));

  const filtered = await browseTree(client, TARGET, "main", { prefix: "src" });
  assert.deepEqual(filtered.entries.map((e) => e.path).sort(), ["src", "src/index.ts", "src/utils.ts"]);
});

test("browseTree tronque au-delà de la limite d'entrées et le signale", async () => {
  const tree: TreeEntry[] = Array.from({ length: 2_050 }, (_, i) => ({ path: `file-${i}.ts`, type: "blob" as const }));
  const { client } = mockClient({ tree });
  const result = await browseTree(client, TARGET, "main");
  assert.equal(result.entries.length, 2_000);
  assert.equal(result.totalEntries, 2_050);
  assert.equal(result.truncated, true);
  assert.ok(result.warnings.includes("REPOSITORY_TREE_TRUNCATED_RESULT_LIMIT"));
});

// ---------------------------------------------------------------------------
// READ_FILE — lecture de fichier (test obligatoire)
// ---------------------------------------------------------------------------

test("readRepositoryFile lit un fichier texte normal", async () => {
  const { client } = mockClient({ files: { "README.md": "# Widgets\n\nBienvenue." } });
  const result = await readRepositoryFile(client, TARGET, "main", "README.md");
  assert.equal(result.blocked, false);
  assert.equal(result.binary, false);
  assert.equal(result.text, "# Widgets\n\nBienvenue.");
  assert.equal(result.truncated, false);
});

test("readRepositoryFile bloque les fichiers sensibles sans jamais les lire", async () => {
  const { client, fileContentCalls } = mockClient({ files: { ".env": "SECRET=abcdef" } });
  const result = await readRepositoryFile(client, TARGET, "main", ".env");
  assert.equal(result.blocked, true);
  assert.equal(result.text, undefined);
  assert.deepEqual(fileContentCalls, []);
  assert.ok(result.warnings.includes("REPOSITORY_SENSITIVE_FILE_BLOCKED"));
});

test("readRepositoryFile détecte les fichiers binaires (extension ou octet NUL) sans exposer leur contenu", async () => {
  const { client } = mockClient({ files: { "assets/logo.png": "binarydata", "bin/blob.dat": "abc\u0000def" } });
  const byExt = await readRepositoryFile(client, TARGET, "main", "assets/logo.png");
  assert.equal(byExt.binary, true);
  assert.equal(byExt.text, undefined);

  const byNul = await readRepositoryFile(client, TARGET, "main", "bin/blob.dat");
  assert.equal(byNul.binary, true);
  assert.equal(byNul.text, undefined);
});

test("readRepositoryFile détecte un répertoire et rejette un chemin vide", async () => {
  const { client } = mockClient({ files: { src: "__DIR__" } });
  const dir = await readRepositoryFile(client, TARGET, "main", "src");
  assert.equal(dir.isDirectory, true);
  await assert.rejects(() => readRepositoryFile(client, TARGET, "main", ""), /REPOSITORY_PATH_REQUIRED/);
});

test("readRepositoryFile tronque un texte volumineux et le signale", async () => {
  const big = "x".repeat(70_000);
  const { client } = mockClient({ files: { "big.txt": big } });
  const result = await readRepositoryFile(client, TARGET, "main", "big.txt");
  assert.equal(result.truncated, true);
  assert.equal(result.text!.length, 60_000);
  assert.ok(result.warnings.includes("REPOSITORY_FILE_TEXT_TRUNCATED"));
});

test("readRepositoryFile masque les secrets détectés dans le contenu retourné", async () => {
  const withSecret = "const password = \"hunter2ExtremelySecretValue\";\ntoken=ghp_1234567890abcdefghij1234567890\n";
  const { client } = mockClient({ files: { "config.ts": withSecret } });
  const result = await readRepositoryFile(client, TARGET, "main", "config.ts");
  assert.equal(result.truncated, false);
  assert.ok(result.warnings.includes("REPOSITORY_SECRETS_REDACTED"));
  assert.equal(result.text!.includes("ghp_1234567890"), false);
  assert.equal(result.text!.includes("hunter2ExtremelySecretValue"), false);
  assert.ok(result.redactedSecrets > 0);
});

// ---------------------------------------------------------------------------
// SEARCH_PATH — recherche par chemin (test obligatoire)
// ---------------------------------------------------------------------------

test("searchRepositoryPath trouve par sous-chaîne et par motif glob, borné", async () => {
  const tree: TreeEntry[] = [
    { path: "src/index.ts", type: "blob" },
    { path: "src/index.test.ts", type: "blob" },
    { path: "src/utils.ts", type: "blob" },
    { path: "README.md", type: "blob" },
  ];
  const { client } = mockClient({ tree });
  const substring = await searchRepositoryPath(client, TARGET, "main", "index");
  assert.deepEqual(substring.matches.map((m) => m.path).sort(), ["src/index.test.ts", "src/index.ts"]);

  const glob = await searchRepositoryPath(client, TARGET, "main", "src/*.ts");
  assert.deepEqual(glob.matches.map((m) => m.path).sort(), ["src/index.test.ts", "src/index.ts", "src/utils.ts"]);

  const bounded = await searchRepositoryPath(client, TARGET, "main", "src", { maxResults: 1 });
  assert.equal(bounded.matches.length, 1);
  assert.equal(bounded.truncated, true);
});

test("searchRepositoryPath exige une query non vide", async () => {
  const { client } = mockClient({ tree: [] });
  await assert.rejects(() => searchRepositoryPath(client, TARGET, "main", ""), /REPOSITORY_QUERY_REQUIRED/);
});

// ---------------------------------------------------------------------------
// SEARCH_CODE — recherche dans le contenu (test obligatoire)
// ---------------------------------------------------------------------------

test("searchRepositoryCode trouve du texte, ignore binaires/sensibles et masque les secrets du contexte", async () => {
  const tree: TreeEntry[] = [
    { path: "src/index.ts", type: "blob" },
    { path: "src/utils.ts", type: "blob" },
    { path: "assets/logo.png", type: "blob" },
    { path: ".env", type: "blob" },
  ];
  const files = {
    "src/index.ts": "export function widget() {\n  return TODO_MARKER;\n}\n",
    "src/utils.ts": "// nothing interesting here\n",
    "assets/logo.png": "binary",
    ".env": "TODO_MARKER should never be scanned here",
  };
  const { client, fileContentCalls } = mockClient({ tree, files });
  const result = await searchRepositoryCode(client, TARGET, "main", "TODO_MARKER");
  assert.equal(result.matches.length, 1);
  assert.equal(result.matches[0].path, "src/index.ts");
  assert.equal(result.matches[0].line, 2);
  assert.equal(fileContentCalls.includes(".env"), false);
  assert.equal(fileContentCalls.includes("assets/logo.png"), false);
});

test("searchRepositoryCode masque un secret présent dans le contexte retourné", async () => {
  const tree: TreeEntry[] = [{ path: "config.ts", type: "blob" }];
  const files = { "config.ts": 'export const token = "ghp_1234567890abcdefghij1234567890";\n' };
  const { client } = mockClient({ tree, files });
  const result = await searchRepositoryCode(client, TARGET, "main", "token");
  assert.equal(result.matches.length, 1);
  assert.equal(result.matches[0].context.includes("ghp_1234567890"), false);
  assert.ok(result.matches[0].context.includes("[REDACTED_SECRET]"));
});

test("searchRepositoryCode borne le nombre de fichiers scannés et le signale", async () => {
  const tree: TreeEntry[] = Array.from({ length: 61 }, (_, i) => ({ path: `f${i}.ts`, type: "blob" as const }));
  const files: Record<string, string> = {};
  for (let i = 0; i < 61; i++) files[`f${i}.ts`] = "needle present here";
  const { client } = mockClient({ tree, files });
  const result = await searchRepositoryCode(client, TARGET, "main", "needle", { maxResults: 100 });
  assert.equal(result.filesScanned, 60);
  assert.equal(result.truncated, true);
  assert.ok(result.warnings.includes("REPOSITORY_SEARCH_SCAN_BUDGET_EXCEEDED"));
});

// ---------------------------------------------------------------------------
// READ_MULTIPLE_FILES — lecture multi-fichiers (test obligatoire)
// ---------------------------------------------------------------------------

test("readRepositoryFiles lit plusieurs fichiers utiles à une même question", async () => {
  const files = { "a.ts": "content a", "b.ts": "content b" };
  const { client } = mockClient({ files });
  const result = await readRepositoryFiles(client, TARGET, "main", ["a.ts", "b.ts"]);
  assert.equal(result.files.length, 2);
  assert.equal(result.files[0].text, "content a");
  assert.equal(result.truncated, false);
});

test("readRepositoryFiles borne le nombre de fichiers demandés", async () => {
  const paths = Array.from({ length: 15 }, (_, i) => `f${i}.ts`);
  const files: Record<string, string> = {};
  for (const p of paths) files[p] = "x";
  const { client } = mockClient({ files });
  const result = await readRepositoryFiles(client, TARGET, "main", paths);
  assert.equal(result.returned, 10);
  assert.equal(result.truncated, true);
  assert.ok(result.warnings.includes("REPOSITORY_MULTI_FILE_COUNT_TRUNCATED"));
});

test("readRepositoryFiles applique un budget de caractères cumulé entre fichiers", async () => {
  const files = { "a.ts": "x".repeat(60_000), "b.ts": "y".repeat(60_000), "c.ts": "z".repeat(60_000) };
  const { client } = mockClient({ files });
  const result = await readRepositoryFiles(client, TARGET, "main", ["a.ts", "b.ts", "c.ts"]);
  assert.equal(result.files[0].text!.length, 60_000);
  assert.equal(result.files[1].text!.length, 60_000);
  assert.equal(result.files[2].text!.length, 30_000);
  assert.equal(result.files[2].truncated, true);
  assert.equal(result.truncated, true);
});

test("readRepositoryFiles exige une liste de chemins non vide", async () => {
  const { client } = mockClient({});
  await assert.rejects(() => readRepositoryFiles(client, TARGET, "main", []), /REPOSITORY_PATHS_REQUIRED/);
});

// ---------------------------------------------------------------------------
// PULL REQUESTS — lecture de PR, fichiers modifiés, diff (tests obligatoires)
// ---------------------------------------------------------------------------

const SAMPLE_PR: PullRequestSummary = {
  number: 42,
  title: "Add feature",
  body: "token=ghp_1234567890abcdefghij1234567890",
  state: "open",
  draft: false,
  author: "octocat",
  baseRef: "main",
  baseSha: "base",
  headRef: "feature",
  headSha: "head",
  additions: 12,
  deletions: 3,
  changedFiles: 2,
  commits: 1,
  mergeable: true,
  createdAt: "2024-01-01T00:00:00Z",
  updatedAt: "2024-01-02T00:00:00Z",
  labels: ["enhancement"],
};

test("readPullRequest lit la PR et masque les secrets du corps", async () => {
  const { client } = mockClient({ pr: SAMPLE_PR });
  const result = await readPullRequest(client, TARGET, 42);
  assert.equal(result.number, 42);
  assert.equal(result.title, "Add feature");
  assert.equal(result.body.includes("ghp_1234567890"), false);
  assert.ok(result.warnings.includes("REPOSITORY_SECRETS_REDACTED"));
});

test("readPullRequest rejette un numéro invalide", async () => {
  const { client } = mockClient({ pr: SAMPLE_PR });
  await assert.rejects(() => readPullRequest(client, TARGET, 0), /REPOSITORY_PR_NUMBER_INVALID/);
  await assert.rejects(() => readPullRequest(client, TARGET, undefined), /REPOSITORY_PR_NUMBER_INVALID/);
});

test("readPullRequestFiles liste les fichiers modifiés, bloque les sensibles et signale la troncature", async () => {
  const prFiles: PullRequestFileEntry[] = [
    { path: "src/index.ts", status: "modified", additions: 5, deletions: 1, changes: 6, patch: "@@ -1 +1 @@\n-old\n+new" },
    { path: ".env", status: "modified", additions: 1, deletions: 0, changes: 1, patch: "+SECRET=abc" },
  ];
  const { client } = mockClient({ pr: { ...SAMPLE_PR, changedFiles: 3 }, prFiles });
  const result = await readPullRequestFiles(client, TARGET, 42);
  assert.equal(result.files.length, 2);
  const envFile = result.files.find((f) => f.path === ".env")!;
  assert.equal(envFile.patch, undefined);
  assert.equal(result.truncated, true);
  assert.ok(result.warnings.includes("REPOSITORY_PR_FILES_TRUNCATED"));
});

test("readPullRequestDiff tronque un diff volumineux et le signale", async () => {
  const diff = "x".repeat(120_000);
  const { client } = mockClient({ prDiff: diff });
  const result = await readPullRequestDiff(client, TARGET, 42);
  assert.equal(result.truncated, true);
  assert.equal(result.diff.length, 100_000);
  assert.ok(result.warnings.includes("REPOSITORY_DIFF_TRUNCATED"));
});

test("readPullRequestDiff masque les secrets présents dans le diff", async () => {
  const diff = "diff --git a/config.ts b/config.ts\n+token=ghp_1234567890abcdefghij1234567890\n";
  const { client } = mockClient({ prDiff: diff });
  const result = await readPullRequestDiff(client, TARGET, 42);
  assert.equal(result.truncated, false);
  assert.equal(result.diff.includes("ghp_1234567890"), false);
  assert.ok(result.redactedSecrets > 0);
});

// ---------------------------------------------------------------------------
// COMMIT — lecture d'un commit (test obligatoire)
// ---------------------------------------------------------------------------

test("readCommit lit un commit et sanitize ses patches", async () => {
  const commit: CommitSummary = {
    sha: "deadbeef",
    message: "fix: bug",
    author: "Ada Lovelace",
    date: "2024-01-01T00:00:00Z",
    additions: 4,
    deletions: 2,
    files: [{ path: "a.ts", status: "modified", additions: 4, deletions: 2, changes: 6, patch: "@@ -1 +1 @@" }],
    totalFiles: 1,
  };
  const { client } = mockClient({ commit });
  const result = await readCommit(client, TARGET, "deadbeef");
  assert.equal(result.sha, "deadbeef");
  assert.equal(result.files.length, 1);
  assert.equal(result.truncated, false);
});

test("readCommit exige un sha", async () => {
  const { client } = mockClient({});
  await assert.rejects(() => readCommit(client, TARGET, ""), /REPOSITORY_SHA_REQUIRED/);
});

// ---------------------------------------------------------------------------
// READ_DIFF — diff entre deux versions (test obligatoire)
// ---------------------------------------------------------------------------

test("readDiffBetweenVersions compare deux références et borne les fichiers", async () => {
  const compare: CompareResult = {
    aheadBy: 3,
    behindBy: 0,
    totalCommits: 3,
    files: [{ path: "a.ts", status: "modified", additions: 1, deletions: 0, changes: 1 }],
    totalFiles: 1,
  };
  const { client } = mockClient({ compare });
  const result = await readDiffBetweenVersions(client, TARGET, "main", "feature");
  assert.equal(result.aheadBy, 3);
  assert.equal(result.files.length, 1);
});

test("readDiffBetweenVersions exige base et head", async () => {
  const { client } = mockClient({});
  await assert.rejects(() => readDiffBetweenVersions(client, TARGET, "", "feature"), /REPOSITORY_DIFF_RANGE_REQUIRED/);
});

// ---------------------------------------------------------------------------
// BUILD_CONTEXT — construction automatique de contexte
// ---------------------------------------------------------------------------

test("buildRepositoryContext assemble des extraits pertinents à partir du chemin et du code", async () => {
  const tree: TreeEntry[] = [
    { path: "src/widget.ts", type: "blob" },
    { path: "src/other.ts", type: "blob" },
  ];
  const files = {
    "src/widget.ts": "export function widget() { return 'widget'; }",
    "src/other.ts": "export const widget_ref = 'see widget.ts';",
  };
  const { client } = mockClient({ tree, files });
  const result = await buildRepositoryContext(client, TARGET, "main", "widget");
  assert.ok(result.snippets.length > 0);
  assert.ok(result.snippets.some((s) => s.path === "src/widget.ts"));
});

// ---------------------------------------------------------------------------
// AUDIT — audit borné d'un dépôt ou d'une PR
// ---------------------------------------------------------------------------

test("auditRepository (PR) détecte un secret potentiel dans le diff et un fichier sensible touché", async () => {
  const prFiles: PullRequestFileEntry[] = [
    { path: "config.ts", status: "modified", additions: 1, deletions: 0, changes: 1, patch: "+token=ghp_1234567890abcdefghij1234567890" },
    { path: ".env", status: "modified", additions: 1, deletions: 0, changes: 1, patch: "+SECRET=1" },
  ];
  const { client } = mockClient({ pr: { ...SAMPLE_PR, changedFiles: 2 }, prFiles });
  const result = await auditRepository(client, TARGET, { prNumber: 42 });
  assert.equal(result.scope, "PULL_REQUEST");
  assert.ok(result.findings.some((f) => f.code === "SENSITIVE_FILE_TOUCHED"));
  assert.ok(result.findings.some((f) => f.code === "POTENTIAL_SECRET_IN_DIFF"));
});

test("auditRepository (dépôt) détecte un secret potentiel et un fichier sensible présent", async () => {
  const tree: TreeEntry[] = [
    { path: "config.ts", type: "blob" },
    { path: ".env", type: "blob" },
  ];
  const files = { "config.ts": "token=ghp_1234567890abcdefghij1234567890", ".env": "SECRET=abc" };
  const { client } = mockClient({ tree, files, defaultBranch: "main" });
  const result = await auditRepository(client, TARGET, {});
  assert.equal(result.scope, "REPOSITORY");
  assert.ok(result.findings.some((f) => f.code === "SENSITIVE_FILE_PRESENT" && f.path === ".env"));
  assert.ok(result.findings.some((f) => f.code === "POTENTIAL_SECRET_IN_FILE" && f.path === "config.ts"));
});
