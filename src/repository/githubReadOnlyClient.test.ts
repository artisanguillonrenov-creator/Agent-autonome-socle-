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
        getBranchProtection: async () => {
          const err = new Error("Branch not protected") as Error & { status: number };
          err.status = 404;
          throw err;
        },
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

// --- Pagination CI : `getCiStatus` doit récupérer TOUTES les pages avant de
// calculer `overallState`, pour Checks API et Commit Status API. Les tests
// ci-dessous utilisent délibérément le même per_page que l'implémentation
// réelle (`CI_PAGE_SIZE = 100`, cf. githubReadOnlyClient.ts) plutôt qu'un
// seuil arbitraire, pour exercer le vrai découpage en pages tel qu'il sera
// négocié avec GitHub.

function makeCheckRun(name: string, conclusion: string | null): { name: string; conclusion: string | null; html_url: string | null; details_url: string | null; started_at: string | null; completed_at: string | null } {
  return { name, conclusion, html_url: null, details_url: null, started_at: "2024-01-01T00:00:00Z", completed_at: conclusion === null ? null : "2024-01-01T00:05:00Z" };
}

function makeCommitStatus(context: string, state: string): { context: string; state: string; target_url: string | null; created_at: string; updated_at: string } {
  return { context, state, target_url: null, created_at: "2024-01-01T00:00:00Z", updated_at: "2024-01-01T00:05:00Z" };
}

test("getCiStatus : plus de 100 check runs avec un failure sur la page suivante → overallState = failure", async () => {
  const page1 = Array.from({ length: 100 }, (_, i) => makeCheckRun(`check-${i}`, "success"));
  const page2 = [makeCheckRun("check-100-late", "failure")];
  const pagesRequested: number[] = [];
  const client = createGithubReadOnlyClient(
    mockOctokit({
      checks: {
        listForRef: async (params: { page?: number }) => {
          const page = params.page ?? 1;
          pagesRequested.push(page);
          if (page === 1) return { data: { total_count: 101, check_runs: page1 } };
          if (page === 2) return { data: { total_count: 101, check_runs: page2 } };
          return { data: { total_count: 101, check_runs: [] } };
        },
      },
    }),
  );
  const result = await client.getCiStatus(TARGET, "deadbeef");
  assert.deepEqual(pagesRequested, [1, 2]);
  assert.equal(result.totalCount, 101);
  assert.equal(result.overallState, "failure");
  assert.ok(result.checks.some((c) => c.name === "check-100-late" && c.state === "failure"));
});

test("getCiStatus : plus de 100 commit statuses avec un failure sur la page suivante → overallState = failure", async () => {
  const page1 = Array.from({ length: 100 }, (_, i) => makeCommitStatus(`ctx-${i}`, "success"));
  const page2 = [makeCommitStatus("ctx-late-failure", "failure")];
  const pagesRequested: number[] = [];
  const client = createGithubReadOnlyClient(
    mockOctokit({
      repos: {
        getCombinedStatusForRef: async (params: { page?: number }) => {
          const page = params.page ?? 1;
          pagesRequested.push(page);
          if (page === 1) return { data: { state: "success", total_count: 101, statuses: page1 } };
          if (page === 2) return { data: { state: "failure", total_count: 101, statuses: page2 } };
          return { data: { state: "failure", total_count: 101, statuses: [] } };
        },
      },
    }),
  );
  const result = await client.getCiStatus(TARGET, "deadbeef");
  assert.deepEqual(pagesRequested, [1, 2]);
  assert.equal(result.totalCount, 101);
  assert.equal(result.overallState, "failure");
  assert.ok(result.checks.some((c) => c.name === "ctx-late-failure" && c.state === "failure" && c.source === "status"));
});

test("getCiStatus : pagination multi-page avec succès partout → success, aucun élément perdu", async () => {
  const checksPage1 = Array.from({ length: 100 }, (_, i) => makeCheckRun(`check-${i}`, "success"));
  const checksPage2 = [makeCheckRun("check-100", "success")];
  const statusesPage1 = Array.from({ length: 100 }, (_, i) => makeCommitStatus(`ctx-${i}`, "success"));
  const statusesPage2 = [makeCommitStatus("ctx-100", "success")];
  const client = createGithubReadOnlyClient(
    mockOctokit({
      checks: {
        listForRef: async (params: { page?: number }) => {
          const page = params.page ?? 1;
          return { data: { total_count: 101, check_runs: page === 1 ? checksPage1 : page === 2 ? checksPage2 : [] } };
        },
      },
      repos: {
        getCombinedStatusForRef: async (params: { page?: number }) => {
          const page = params.page ?? 1;
          return { data: { state: "success", total_count: 101, statuses: page === 1 ? statusesPage1 : page === 2 ? statusesPage2 : [] } };
        },
      },
    }),
  );
  const result = await client.getCiStatus(TARGET, "deadbeef");
  // 101 check runs + 101 statuses, tous récupérés malgré la pagination sur 2 pages chacun.
  assert.equal(result.totalCount, 202);
  assert.equal(result.overallState, "success");
  assert.ok(result.checks.some((c) => c.name === "check-100"), "le check de la 2e page ne doit pas être perdu");
  assert.ok(result.checks.some((c) => c.name === "ctx-100"), "le status de la 2e page ne doit pas être perdu");
});

test("getCiStatus : erreur GitHub sur une page intermédiaire (page 2) → GithubCiReadError, jamais de résultat partiel", async () => {
  const checksPage1 = Array.from({ length: 100 }, (_, i) => makeCheckRun(`check-${i}`, "success"));
  let page2Called = false;
  const client = createGithubReadOnlyClient(
    mockOctokit({
      checks: {
        listForRef: async (params: { page?: number }) => {
          const page = params.page ?? 1;
          if (page === 1) return { data: { total_count: 150, check_runs: checksPage1 } };
          page2Called = true;
          const err = new Error("Service Unavailable") as Error & { status: number };
          err.status = 503;
          throw err;
        },
      },
    }),
  );
  await assert.rejects(
    () => client.getCiStatus(TARGET, "deadbeef"),
    (err: unknown) => {
      assert.ok(err instanceof GithubCiReadError);
      assert.equal(err.status, 503);
      return true;
    },
  );
  assert.equal(page2Called, true, "le test doit réellement exercer une erreur sur la 2e page, pas seulement la 1re");
});

test("getCiStatus : la pagination s'arrête correctement après la dernière page, y compris quand le total est un multiple exact de CI_PAGE_SIZE", async () => {
  // Cas limite le plus piégeux : la page 1 renvoie exactement 100 éléments
  // (== CI_PAGE_SIZE), ce qui ne suffit PAS à distinguer "il y a peut-être
  // une page 2" de "il y en a exactement 100 au total". Une implémentation
  // correcte doit donc toujours requêter une page 3 après une page 2 vide,
  // et s'arrêter là — sans jamais boucler indéfiniment ni sur-requêter.
  const checksPage1 = Array.from({ length: 100 }, (_, i) => makeCheckRun(`check-${i}`, "success"));
  const checksPagesRequested: number[] = [];
  const statusesPage1 = Array.from({ length: 100 }, (_, i) => makeCommitStatus(`ctx-${i}`, "success"));
  const statusesPagesRequested: number[] = [];
  const client = createGithubReadOnlyClient(
    mockOctokit({
      checks: {
        listForRef: async (params: { page?: number }) => {
          const page = params.page ?? 1;
          checksPagesRequested.push(page);
          return { data: { total_count: 100, check_runs: page === 1 ? checksPage1 : [] } };
        },
      },
      repos: {
        getCombinedStatusForRef: async (params: { page?: number }) => {
          const page = params.page ?? 1;
          statusesPagesRequested.push(page);
          return { data: { state: "success", total_count: 100, statuses: page === 1 ? statusesPage1 : [] } };
        },
      },
    }),
  );
  const result = await client.getCiStatus(TARGET, "deadbeef");
  assert.deepEqual(checksPagesRequested, [1, 2], "doit requêter la page 2 (vide) pour confirmer la fin, puis s'arrêter — pas de page 3");
  assert.deepEqual(statusesPagesRequested, [1, 2], "idem pour la Commit Status API");
  assert.equal(result.totalCount, 200);
  assert.equal(result.overallState, "success");
});

// --- PR-B : lecteur de protection de branche (lecture seule) ---

test("getMainProtectionStatus : ruleset lisible et protecteur → MAIN_PROTECTION_VERIFIED", async () => {
  const client = createGithubReadOnlyClient(
    mockOctokit({
      repos: {
        getBranchProtection: async () => ({
          data: {
            required_pull_request_reviews: { required_approving_review_count: 1 },
            required_status_checks: { contexts: ["ci/build"], checks: [{ context: "ci/build", app_id: null }] },
            enforce_admins: { enabled: true },
            allow_force_pushes: { enabled: false },
          },
        }),
      },
    }),
  );
  const result = await client.getMainProtectionStatus(TARGET, "main");
  assert.equal(result.status, "MAIN_PROTECTION_VERIFIED");
  assert.equal(result.pullRequestRequired, true);
  assert.equal(result.forcePushBlocked, true);
  assert.equal(result.requiredChecksConfigured, true);
  assert.equal(result.adminsEnforced, true);
  assert.equal(result.branch, "main");
});

test("getMainProtectionStatus : protection absente (404) → MAIN_PROTECTION_FAILED, jamais VERIFIED", async () => {
  const client = createGithubReadOnlyClient(mockOctokit()); // default : getBranchProtection lève 404
  const result = await client.getMainProtectionStatus(TARGET, "main");
  assert.equal(result.status, "MAIN_PROTECTION_FAILED");
  assert.equal(result.pullRequestRequired, false);
  assert.equal(result.forcePushBlocked, false);
});

test("getMainProtectionStatus : protection lue mais insuffisante (force-push autorisé) → MAIN_PROTECTION_FAILED", async () => {
  const client = createGithubReadOnlyClient(
    mockOctokit({
      repos: {
        getBranchProtection: async () => ({
          data: {
            required_pull_request_reviews: { required_approving_review_count: 1 },
            required_status_checks: null,
            enforce_admins: { enabled: false },
            allow_force_pushes: { enabled: true }, // force-push AUTORISÉ : insuffisant malgré la revue obligatoire
          },
        }),
      },
    }),
  );
  const result = await client.getMainProtectionStatus(TARGET, "main");
  assert.equal(result.status, "MAIN_PROTECTION_FAILED");
  assert.equal(result.pullRequestRequired, true);
  assert.equal(result.forcePushBlocked, false);
});

test("getMainProtectionStatus : permission GitHub insuffisante (403) → MAIN_PROTECTION_UNVERIFIED, jamais VERIFIED ni FAILED", async () => {
  const client = createGithubReadOnlyClient(
    mockOctokit({
      repos: {
        getBranchProtection: async () => {
          const err = new Error("Resource not accessible by integration") as Error & { status: number };
          err.status = 403;
          throw err;
        },
      },
    }),
  );
  const result = await client.getMainProtectionStatus(TARGET, "main");
  assert.equal(result.status, "MAIN_PROTECTION_UNVERIFIED");
  assert.equal(result.pullRequestRequired, null);
  assert.equal(result.forcePushBlocked, null);
  assert.match(result.reason, /permission/i);
});

test("getMainProtectionStatus : erreur technique indéterminée (ni 403 ni 404) → MAIN_PROTECTION_UNVERIFIED, jamais une preuve de protection", async () => {
  const client = createGithubReadOnlyClient(
    mockOctokit({
      repos: {
        getBranchProtection: async () => {
          throw new Error("socket hang up");
        },
      },
    }),
  );
  const result = await client.getMainProtectionStatus(TARGET, "main");
  assert.equal(result.status, "MAIN_PROTECTION_UNVERIFIED");
});

test("getMainProtectionStatus n'effectue aucune opération d'écriture GitHub", async () => {
  const client = createGithubReadOnlyClient(mockOctokit());
  await client.getMainProtectionStatus(TARGET, "main");
  const writeLikeNames = ["createOrUpdateFileContents", "createRef", "createPullRequest", "merge", "deleteFile", "push", "commit", "write", "updateBranchProtection"];
  for (const name of writeLikeNames) {
    assert.equal(Object.prototype.hasOwnProperty.call(client, name), false, `client ne doit pas exposer ${name}`);
  }
});
