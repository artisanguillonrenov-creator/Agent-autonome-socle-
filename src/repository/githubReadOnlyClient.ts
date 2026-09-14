import { Octokit } from "@octokit/rest";

/**
 * Frontière stricte de Repository Intelligence : ce type n'expose que des
 * opérations de lecture GitHub. Aucune méthode d'écriture (création de
 * fichier, de branche, de commit, de PR, fusion...) n'existe sur cette
 * interface — les écritures GitHub restent exclusivement portées par
 * `SoftwareFactoryService` (src/services/softwareFactoryService.ts).
 */
export interface RepoRef {
  owner: string;
  repo: string;
}

export interface TreeEntry {
  path: string;
  type: "blob" | "tree";
  size?: number;
  sha?: string;
}

export interface FileContentResult {
  content: string;
  encoding: "utf-8" | "none";
  size: number;
  sha: string;
  isDirectory: boolean;
}

export interface PullRequestSummary {
  number: number;
  title: string;
  body: string | null;
  state: string;
  draft: boolean;
  author: string;
  baseRef: string;
  baseSha: string;
  headRef: string;
  headSha: string;
  additions: number;
  deletions: number;
  changedFiles: number;
  commits: number;
  mergeable: boolean | null;
  createdAt: string;
  updatedAt: string;
  labels: string[];
}

export interface PullRequestFileEntry {
  path: string;
  status: string;
  additions: number;
  deletions: number;
  changes: number;
  patch?: string;
  previousPath?: string;
}

export interface CommitSummary {
  sha: string;
  message: string;
  author: string;
  date: string;
  additions: number;
  deletions: number;
  files: PullRequestFileEntry[];
  totalFiles: number;
}

export interface CompareResult {
  aheadBy: number;
  behindBy: number;
  totalCommits: number;
  files: PullRequestFileEntry[];
  totalFiles: number;
}

/**
 * État normalisé d'un check individuel (GitHub Checks API) ou d'un statut de
 * commit (Commit Status API, historique/CI tierces). `pending` couvre à la
 * fois "queued"/"in_progress"/"waiting"/"requested" côté Checks API et
 * "pending" côté Status API — le détail brut GitHub n'est pas nécessaire pour
 * la décision GO/NO-GO consommée par JARVIS-00.
 */
export type CiCheckState =
  | "success"
  | "failure"
  | "neutral"
  | "cancelled"
  | "skipped"
  | "timed_out"
  | "action_required"
  | "stale"
  | "pending";

/** État agrégé sur l'ensemble des checks/statuses trouvés pour un SHA. */
export type CiOverallState = "success" | "failure" | "pending" | "no_ci";

export interface CiCheckEntry {
  name: string;
  /** Distingue un check run (GitHub Actions/Checks API) d'un statut de commit (Status API). */
  source: "check_run" | "status";
  state: CiCheckState;
  url: string | null;
  startedAt: string | null;
  completedAt: string | null;
}

export interface CiStatusResult {
  sha: string;
  overallState: CiOverallState;
  totalCount: number;
  checks: CiCheckEntry[];
}

/**
 * Erreur structurée levée par `getCiStatus` en cas d'échec d'appel GitHub
 * (réseau, permission, SHA inconnu...). Ne masque jamais un échec en le
 * transformant en résultat "no_ci" — un statut CI qu'on n'a pas pu lire n'est
 * pas équivalent à une absence de CI.
 */
export class GithubCiReadError extends Error {
  readonly status?: number;

  constructor(message: string, status?: number) {
    super(message);
    this.name = "GithubCiReadError";
    this.status = status;
  }
}

export interface GithubReadOnlyClient {
  getDefaultBranch(ref: RepoRef): Promise<string>;
  getTree(ref: RepoRef, treeish: string): Promise<{ entries: TreeEntry[]; truncatedByGithub: boolean }>;
  getFileContent(ref: RepoRef, path: string, treeish: string): Promise<FileContentResult>;
  getPullRequest(ref: RepoRef, pullNumber: number): Promise<PullRequestSummary>;
  listPullRequestFiles(ref: RepoRef, pullNumber: number, perPage: number): Promise<PullRequestFileEntry[]>;
  getPullRequestDiff(ref: RepoRef, pullNumber: number): Promise<string>;
  getCommit(ref: RepoRef, sha: string): Promise<CommitSummary>;
  compare(ref: RepoRef, base: string, head: string): Promise<CompareResult>;
  /**
   * État CI réel d'un commit (Checks API + Commit Status API combinées).
   * Pour la CI d'une PR, résoudre d'abord son `headSha` via `getPullRequest`
   * puis appeler `getCiStatus` avec ce SHA — la CI d'une PR est celle de son
   * commit de tête, il n'y a pas de notion distincte à modéliser.
   *
   * Pagine intégralement les deux APIs avant de calculer `overallState` —
   * un check/status situé sur une page suivante ne peut donc jamais être
   * ignoré. En cas d'erreur sur une page (y compris une page intermédiaire),
   * la promesse est rejetée avec `GithubCiReadError` : aucun résultat
   * partiel n'est jamais renvoyé.
   */
  getCiStatus(ref: RepoRef, sha: string): Promise<CiStatusResult>;
}

interface RawGithubFile {
  filename: string;
  status: string;
  additions?: number;
  deletions?: number;
  changes?: number;
  patch?: string;
  previous_filename?: string;
}

function mapFile(f: RawGithubFile): PullRequestFileEntry {
  return {
    path: f.filename,
    status: f.status,
    additions: f.additions ?? 0,
    deletions: f.deletions ?? 0,
    changes: f.changes ?? 0,
    patch: typeof f.patch === "string" ? f.patch : undefined,
    previousPath: f.previous_filename,
  };
}

const FAILURE_STATES = new Set<CiCheckState>(["failure", "timed_out", "cancelled", "action_required", "stale"]);

/** `conclusion === null` signifie que le check run n'est pas terminé (status queued/in_progress/waiting/requested). */
function mapCheckRunConclusion(conclusion: string | null): CiCheckState {
  if (conclusion === null) return "pending";
  switch (conclusion) {
    case "success":
    case "failure":
    case "neutral":
    case "cancelled":
    case "skipped":
    case "timed_out":
    case "action_required":
    case "stale":
      return conclusion;
    default:
      // Valeur de conclusion inconnue/future de l'API GitHub : traitée comme
      // un échec potentiel plutôt qu'ignorée silencieusement.
      return "failure";
  }
}

function mapCommitStatusState(state: string): CiCheckState {
  switch (state) {
    case "success":
      return "success";
    case "pending":
      return "pending";
    case "failure":
    case "error":
      return "failure";
    default:
      return "failure";
  }
}

function aggregateOverallState(checks: CiCheckEntry[]): CiOverallState {
  if (checks.length === 0) return "no_ci";
  if (checks.some((c) => FAILURE_STATES.has(c.state))) return "failure";
  if (checks.some((c) => c.state === "pending")) return "pending";
  return "success";
}

function toGithubCiReadError(err: unknown, context: string): GithubCiReadError {
  const status = typeof err === "object" && err !== null && "status" in err ? (err as { status?: unknown }).status : undefined;
  const detail = err instanceof Error ? err.message : String(err);
  return new GithubCiReadError(`${context}: ${detail}`, typeof status === "number" ? status : undefined);
}

/** Taille de page utilisée pour paginer Checks API et Commit Status API — max autorisé par GitHub. */
const CI_PAGE_SIZE = 100;

/**
 * Récupère explicitement toutes les pages d'une collection paginée GitHub
 * (page/per_page), plutôt que de se fier à une seule page. Une page renvoyant
 * moins de `CI_PAGE_SIZE` éléments marque la fin ; une page pleine déclenche
 * toujours une requête supplémentaire (y compris quand le total est un
 * multiple exact de `CI_PAGE_SIZE`), pour ne jamais tronquer silencieusement
 * le résultat. Toute erreur sur une page — y compris une page intermédiaire —
 * interrompt immédiatement l'agrégation : aucun résultat partiel n'est
 * jamais renvoyé par cette fonction, l'appelant reçoit l'erreur brute.
 */
async function fetchAllPages<T>(fetchPage: (page: number) => Promise<T[]>): Promise<T[]> {
  const all: T[] = [];
  let page = 1;
  for (;;) {
    const items = await fetchPage(page);
    all.push(...items);
    if (items.length < CI_PAGE_SIZE) return all;
    page += 1;
  }
}

function defaultOctokit(): Octokit {
  const token = process.env.GITHUB_FACTORY_TOKEN || process.env.GITHUB_TOKEN || undefined;
  return new Octokit({ auth: token });
}

/**
 * Construit le client Repository Intelligence à partir d'une instance Octokit
 * (injectable pour les tests). Seules des méthodes GET du REST API GitHub
 * sont appelées ici : repos.get, git.getTree, repos.getContent, pulls.get,
 * pulls.listFiles, repos.getCommit, repos.compareCommits, checks.listForRef,
 * repos.getCombinedStatusForRef.
 */
export function createGithubReadOnlyClient(octokit: Octokit = defaultOctokit()): GithubReadOnlyClient {
  return {
    async getDefaultBranch({ owner, repo }) {
      const res = await octokit.rest.repos.get({ owner, repo });
      return res.data.default_branch || "main";
    },

    async getTree({ owner, repo }, treeish) {
      const res = await octokit.rest.git.getTree({ owner, repo, tree_sha: treeish, recursive: "1" });
      const entries: TreeEntry[] = (res.data.tree || [])
        .filter((e): e is typeof e & { path: string; type: "blob" | "tree" } => (e.type === "blob" || e.type === "tree") && typeof e.path === "string")
        .map((e) => ({ path: e.path, type: e.type, size: e.size, sha: e.sha }));
      return { entries, truncatedByGithub: Boolean(res.data.truncated) };
    },

    async getFileContent({ owner, repo }, path, treeish) {
      const res = await octokit.rest.repos.getContent({ owner, repo, path, ref: treeish });
      const data = res.data as unknown;
      if (Array.isArray(data)) return { content: "", encoding: "none", size: 0, sha: "", isDirectory: true };
      const file = data as { type?: string; content?: string; encoding?: string; size?: number; sha?: string };
      if (file.type !== "file" || typeof file.content !== "string") {
        return { content: "", encoding: "none", size: file.size ?? 0, sha: file.sha ?? "", isDirectory: false };
      }
      const buffer = Buffer.from(file.content, (file.encoding as BufferEncoding) || "base64");
      return { content: buffer.toString("utf-8"), encoding: "utf-8", size: file.size ?? buffer.length, sha: file.sha ?? "", isDirectory: false };
    },

    async getPullRequest({ owner, repo }, pullNumber) {
      const res = await octokit.rest.pulls.get({ owner, repo, pull_number: pullNumber });
      const d = res.data;
      return {
        number: d.number,
        title: d.title,
        body: d.body ?? null,
        state: d.state,
        draft: Boolean(d.draft),
        author: d.user?.login ?? "unknown",
        baseRef: d.base.ref,
        baseSha: d.base.sha,
        headRef: d.head.ref,
        headSha: d.head.sha,
        additions: d.additions ?? 0,
        deletions: d.deletions ?? 0,
        changedFiles: d.changed_files ?? 0,
        commits: d.commits ?? 0,
        mergeable: d.mergeable ?? null,
        createdAt: d.created_at,
        updatedAt: d.updated_at,
        labels: (d.labels || []).map((l) => (typeof l === "string" ? l : l.name)).filter((n): n is string => Boolean(n)),
      };
    },

    async listPullRequestFiles({ owner, repo }, pullNumber, perPage) {
      const res = await octokit.rest.pulls.listFiles({ owner, repo, pull_number: pullNumber, per_page: perPage });
      return res.data.map(mapFile);
    },

    async getPullRequestDiff({ owner, repo }, pullNumber) {
      const res = await octokit.rest.pulls.get({ owner, repo, pull_number: pullNumber, mediaType: { format: "diff" } });
      return typeof res.data === "string" ? res.data : String(res.data);
    },

    async getCommit({ owner, repo }, ref) {
      const res = await octokit.rest.repos.getCommit({ owner, repo, ref });
      const d = res.data;
      const files = (d.files || []).map(mapFile);
      return {
        sha: d.sha,
        message: d.commit.message,
        author: d.commit.author?.name ?? d.author?.login ?? "unknown",
        date: d.commit.author?.date ?? "",
        additions: d.stats?.additions ?? 0,
        deletions: d.stats?.deletions ?? 0,
        files,
        totalFiles: files.length,
      };
    },

    async compare({ owner, repo }, base, head) {
      const res = await octokit.rest.repos.compareCommits({ owner, repo, base, head });
      const d = res.data;
      const files = (d.files || []).map(mapFile);
      return { aheadBy: d.ahead_by, behindBy: d.behind_by, totalCommits: d.total_commits, files, totalFiles: files.length };
    },

    async getCiStatus({ owner, repo }, sha) {
      let checkRuns: Array<{ name: string; conclusion: string | null; html_url: string | null; details_url: string | null; started_at: string | null; completed_at: string | null }>;
      try {
        checkRuns = await fetchAllPages(async (page) => {
          const res = await octokit.rest.checks.listForRef({ owner, repo, ref: sha, per_page: CI_PAGE_SIZE, page });
          return res.data.check_runs;
        });
      } catch (err) {
        throw toGithubCiReadError(err, `Échec de lecture des check runs GitHub pour ${sha}`);
      }

      let statuses: Array<{ context: string; state: string; target_url: string | null; created_at: string; updated_at: string }>;
      try {
        statuses = await fetchAllPages(async (page) => {
          const res = await octokit.rest.repos.getCombinedStatusForRef({ owner, repo, ref: sha, per_page: CI_PAGE_SIZE, page });
          return res.data.statuses;
        });
      } catch (err) {
        throw toGithubCiReadError(err, `Échec de lecture des commit statuses GitHub pour ${sha}`);
      }

      const checkEntries: CiCheckEntry[] = checkRuns.map((c) => ({
        name: c.name,
        source: "check_run",
        state: mapCheckRunConclusion(c.conclusion),
        url: c.html_url ?? c.details_url ?? null,
        startedAt: c.started_at ?? null,
        completedAt: c.completed_at ?? null,
      }));

      const statusEntries: CiCheckEntry[] = statuses.map((s) => ({
        name: s.context,
        source: "status",
        state: mapCommitStatusState(s.state),
        url: s.target_url ?? null,
        startedAt: s.created_at ?? null,
        completedAt: s.updated_at ?? null,
      }));

      const checks = [...checkEntries, ...statusEntries];
      return { sha, overallState: aggregateOverallState(checks), totalCount: checks.length, checks };
    },
  };
}
