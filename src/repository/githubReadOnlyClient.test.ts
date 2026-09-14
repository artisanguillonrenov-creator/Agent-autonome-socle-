import test from "node:test";
import assert from "node:assert/strict";
import type { Octokit } from "@octokit/rest";
import { createGithubReadOnlyClient, GithubCiReadError } from "./githubReadOnlyClient.js";

const TARGET = { owner: "acme", repo: "widgets" };

/** Mock minimal ne couvrant que les méthodes REST GET utilisées par le client de lecture. */
function mockOctokit(overrides: Record<string, unknown> = {}): Octokit {
  return {
    rest: {
      repos: {
        get: async () => ({ data: { default_branch: "main" } }),
        getContent: async () => ({ data: { type: "file", content: Buffer.from("hello").toString("base64"), encoding: "base64", size: 5, sha: "abc" } }),
        getCommit: async () => ({
          data: {
            sha: "deadbeef",
            commit: { message: "fix: something", author: { name: "Ada", date: "2024-01-01T00:00:00Z" } },
            author: { login: "ada" },
            stats: { additions: 3, deletions: 1 },
            files: [{ filename: "a.ts", status: "modified", additions: 3, deletions: 1, changes: 4, patch: "@@ -1 +1 @@" }],
          },
        }),
        compareCommits: async () => ({
          data: { ahead_by: 2, behind_by: 0, total_commits: 2, files: [{ filename: "b.ts", status: "modified", additions: 1, deletions: 0, changes: 1 }] },
        }),
        getCombinedStatusForRef: async () => ({ data: { state: "success", total_count: 0, statuses: [] } }),
        ...(overrides.repos as object),
      },
      checks: {
        listForRef: async () => ({ data: { total_count: 0, check_runs: [] } }),
        ...(overrides.checks as object),
      },
      git: {
        getTree: async () => ({
          data: {
            truncated: false,
            tree: [
              { path: "README.md", type: "blob", size: 10, sha: "s1" },
              { path: "src", type: "tree", sha: "s2" },
              { path: "src/index.ts", type: "blob", size: 20, sha: "s3" },
              { path: "src/index.ts.symlink", type: "commit", size: 1, sha: "s4" },
            ],
          },
        }),
        ...(overrides.git as object),
      },
      pulls: {
        get: async (params: { mediaType?: { format?: string } }) => {
          if (params.mediaType?.format === "diff") return { data: "diff --git a/a.ts b/a.ts\n+added line\n" };
          return {
            data: {
              number: 7,
              title: "Add feature",
              body: "Description",
              state: "open",
              draft: false,
              user: { login: "octocat" },
              base: { ref: "main", sha: "basesha" },
              head: { ref: "feature", sha: "headsha" },
              additions: 10,
              deletions: 2,
              changed_files: 3,
              commits: 1,
              mergeable: true,
              created_at: "2024-01-01T00:00:00Z",
              updated_at: "2024-01-02T00:00:00Z",
              labels: [{ name: "enhancement" }, "bug"],
            },
          };
        },
        listFiles: async () => ({ data: [{ filename: "a.ts", status: "modified", additions: 5, deletions: 1, changes: 6, patch: "@@ -1 +1 @@" }] }),
        ...(overrides.pulls as object),
      },
    },
  } as unknown as Octokit;
}

test("getDefaultBranch lit repos.get", async () => {
  const client = createGithubReadOnlyClient(mockOctokit());
  assert.equal(await client.getDefaultBranch(TARGET), "main");
});

test("getTree ne garde que blob/tree et remonte truncatedByGithub", async () => {
  const client = createGithubReadOnlyClient(mockOctokit());
  const { entries, truncatedByGithub } = await client.getTree(TARGET, "main");
  assert.equal(truncatedByGithub, false);
  assert.deepEqual(entries.map((e) => e.path).sort(), ["README.md", "src", "src/index.ts"]);
  assert.equal(entries.some((e) => e.path === "src/index.ts.symlink"), false);
});

test("getFileContent décode un fichier base64 et détecte un répertoire", async () => {
  const client = createGithubReadOnlyClient(mockOctokit());
  const file = await client.getFileContent(TARGET, "README.md", "main");
  assert.equal(file.content, "hello");
  assert.equal(file.isDirectory, false);

  const dirClient = createGithubReadOnlyClient(mockOctokit({ repos: { getContent: async () => ({ data: [{ name: "a.ts" }, { name: "b.ts" }] }) } }));
  const dir = await dirClient.getFileContent(TARGET, "src", "main");
  assert.equal(dir.isDirectory, true);
});

test("getFileContent signale l'indisponibilité quand le contenu base64 est absent (fichier trop volumineux)", async () => {
  const client = createGithubReadOnlyClient(mockOctokit({ repos: { getContent: async () => ({ data: { type: "file", size: 5_000_000, sha: "big" } }) } }));
  const file = await client.getFileContent(TARGET, "huge.bin", "main");
  assert.equal(file.encoding, "none");
  assert.equal(file.isDirectory, false);
});

test("getPullRequest mappe les champs attendus, y compris des labels mixtes", async () => {
  const client = createGithubReadOnlyClient(mockOctokit());
  const pr = await client.getPullRequest(TARGET, 7);
  assert.equal(pr.number, 7);
  assert.equal(pr.author, "octocat");
  assert.equal(pr.baseRef, "main");
  assert.equal(pr.headSha, "headsha");
  assert.deepEqual(pr.labels, ["enhancement", "bug"]);
});

test("listPullRequestFiles et getPullRequestDiff exposent les données lecture seule", async () => {
  const client = createGithubReadOnlyClient(mockOctokit());
  const files = await client.listPullRequestFiles(TARGET, 7, 100);
  assert.equal(files[0].path, "a.ts");
  const diff = await client.getPullRequestDiff(TARGET, 7);
  assert.match(diff, /^diff --git/);
});

test("getCommit et compare mappent stats et fichiers", async () => {
  const client = createGithubReadOnlyClient(mockOctokit());
  const commit = await client.getCommit(TARGET, "deadbeef");
  assert.equal(commit.sha, "deadbeef");
  assert.equal(commit.author, "Ada");
  assert.equal(commit.additions, 3);
  assert.equal(commit.files.length, 1);

  const cmp = await client.compare(TARGET, "main", "feature");
  assert.equal(cmp.aheadBy, 2);
  assert.equal(cmp.files[0].path, "b.ts");
});

test("l'interface client n'expose aucune méthode d'écriture", async () => {
  const client = createGithubReadOnlyClient(mockOctokit());
  const writeLikeNames = ["createOrUpdateFileContents", "createRef", "createPullRequest", "merge", "deleteFile", "push", "commit", "write"];
  for (const name of writeLikeNames) {
    assert.equal(Object.prototype.hasOwnProperty.call(client, name), false, `client ne doit pas exposer ${name}`);
  }
});

test("getCiStatus : tous les check runs et statuses réussissent → success", async () => {
  const client = createGithubReadOnlyClient(
    mockOctokit({
      checks: {
        listForRef: async () => ({
          data: {
            total_count: 2,
            check_runs: [
              { name: "build", conclusion: "success", html_url: "https://gh/checks/1", details_url: null, started_at: "2024-01-01T00:00:00Z", completed_at: "2024-01-01T00:05:00Z" },
              { name: "unit-tests", conclusion: "success", html_url: "https://gh/checks/2", details_url: null, started_at: "2024-01-01T00:00:00Z", completed_at: "2024-01-01T00:06:00Z" },
            ],
          },
        }),
      },
      repos: {
        getCombinedStatusForRef: async () => ({
          data: { state: "success", total_count: 1, statuses: [{ context: "vercel/deploy", state: "success", target_url: "https://vercel.example", created_at: "2024-01-01T00:00:00Z", updated_at: "2024-01-01T00:01:00Z" }] },
        }),
      },
    }),
  );
  const result = await client.getCiStatus(TARGET, "deadbeef");
  assert.equal(result.sha, "deadbeef");
  assert.equal(result.overallState, "success");
  assert.equal(result.totalCount, 3);
  assert.ok(result.checks.every((c) => c.state === "success"));
});

test("getCiStatus : un check échoue → failure, même si d'autres réussissent", async () => {
  const client = createGithubReadOnlyClient(
    mockOctokit({
      checks: {
        listForRef: async () => ({
          data: {
            total_count: 2,
            check_runs: [
              { name: "build", conclusion: "success", html_url: null, details_url: null, started_at: "2024-01-01T00:00:00Z", completed_at: "2024-01-01T00:05:00Z" },
              { name: "unit-tests", conclusion: "failure", html_url: "https://gh/checks/2", details_url: null, started_at: "2024-01-01T00:00:00Z", completed_at: "2024-01-01T00:06:00Z" },
            ],
          },
        }),
      },
    }),
  );
  const result = await client.getCiStatus(TARGET, "deadbeef");
  assert.equal(result.overallState, "failure");
  const failing = result.checks.find((c) => c.name === "unit-tests");
  assert.equal(failing?.state, "failure");
  assert.equal(failing?.url, "https://gh/checks/2");
});

test("getCiStatus : checks encore en cours (conclusion null) → pending", async () => {
  const client = createGithubReadOnlyClient(
    mockOctokit({
      checks: {
        listForRef: async () => ({
          data: {
            total_count: 1,
            check_runs: [{ name: "build", conclusion: null, html_url: null, details_url: "https://gh/details/1", started_at: "2024-01-01T00:00:00Z", completed_at: null }],
          },
        }),
      },
    }),
  );
  const result = await client.getCiStatus(TARGET, "deadbeef");
  assert.equal(result.overallState, "pending");
  assert.equal(result.checks[0].state, "pending");
  assert.equal(result.checks[0].completedAt, null);
  assert.equal(result.checks[0].url, "https://gh/details/1");
});

test("getCiStatus : aucun check ni status disponible → no_ci (distinct de pending)", async () => {
  const client = createGithubReadOnlyClient(mockOctokit());
  const result = await client.getCiStatus(TARGET, "deadbeef");
  assert.equal(result.overallState, "no_ci");
  assert.equal(result.totalCount, 0);
  assert.deepEqual(result.checks, []);
});

test("getCiStatus : erreur GitHub structurée sur les check runs", async () => {
  const client = createGithubReadOnlyClient(
    mockOctokit({
      checks: {
        listForRef: async () => {
          const err = new Error("Not Found") as Error & { status: number };
          err.status = 404;
          throw err;
        },
      },
    }),
  );
  await assert.rejects(
    () => client.getCiStatus(TARGET, "unknown-sha"),
    (err: unknown) => {
      assert.ok(err instanceof GithubCiReadError);
      assert.equal(err.status, 404);
      assert.match(err.message, /unknown-sha/);
      return true;
    },
  );
});

test("getCiStatus : plusieurs checks et statuses hétérogènes sont correctement agrégés", async () => {
  const client = createGithubReadOnlyClient(
    mockOctokit({
      checks: {
        listForRef: async () => ({
          data: {
            total_count: 3,
            check_runs: [
              { name: "lint", conclusion: "success", html_url: null, details_url: null, started_at: null, completed_at: "2024-01-01T00:01:00Z" },
              { name: "e2e", conclusion: "skipped", html_url: null, details_url: null, started_at: null, completed_at: "2024-01-01T00:02:00Z" },
              { name: "build", conclusion: null, html_url: null, details_url: null, started_at: "2024-01-01T00:00:00Z", completed_at: null },
            ],
          },
        }),
      },
      repos: {
        getCombinedStatusForRef: async () => ({
          data: { state: "success", total_count: 1, statuses: [{ context: "codecov", state: "success", target_url: null, created_at: "2024-01-01T00:00:00Z", updated_at: "2024-01-01T00:01:00Z" }] },
        }),
      },
    }),
  );
  const result = await client.getCiStatus(TARGET, "deadbeef");
  assert.equal(result.totalCount, 4);
  // aucun échec, mais un check ("build") encore en cours → overall = pending, pas success
  assert.equal(result.overallState, "pending");
  assert.equal(result.checks.find((c) => c.name === "e2e")?.state, "skipped");
  assert.equal(result.checks.find((c) => c.name === "codecov")?.source, "status");
});

test("getCiStatus n'effectue aucune opération d'écriture GitHub (mock strictement lecture)", async () => {
  // Le mock ne définit que des méthodes GET (checks.listForRef, repos.getCombinedStatusForRef) ;
  // si l'implémentation appelait la moindre méthode d'écriture non stubbée ici, l'appel échouerait
  // avec un TypeError avant même d'atteindre les assertions ci-dessous.
  const client = createGithubReadOnlyClient(mockOctokit());
  const result = await client.getCiStatus(TARGET, "deadbeef");
  assert.equal(result.overallState, "no_ci");
  const writeLikeNames = ["createOrUpdateFileContents", "createRef", "createPullRequest", "merge", "deleteFile", "push", "commit", "write"];
  for (const name of writeLikeNames) {
    assert.equal(Object.prototype.hasOwnProperty.call(client, name), false, `client ne doit pas exposer ${name}`);
  }
});
