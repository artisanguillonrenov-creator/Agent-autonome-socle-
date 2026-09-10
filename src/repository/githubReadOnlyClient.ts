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

export interface GithubReadOnlyClient {
  getDefaultBranch(ref: RepoRef): Promise<string>;
  getTree(ref: RepoRef, treeish: string): Promise<{ entries: TreeEntry[]; truncatedByGithub: boolean }>;
  getFileContent(ref: RepoRef, path: string, treeish: string): Promise<FileContentResult>;
  getPullRequest(ref: RepoRef, pullNumber: number): Promise<PullRequestSummary>;
  listPullRequestFiles(ref: RepoRef, pullNumber: number, perPage: number): Promise<PullRequestFileEntry[]>;
  getPullRequestDiff(ref: RepoRef, pullNumber: number): Promise<string>;
  getCommit(ref: RepoRef, sha: string): Promise<CommitSummary>;
  compare(ref: RepoRef, base: string, head: string): Promise<CompareResult>;
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

function defaultOctokit(): Octokit {
  const token = process.env.GITHUB_FACTORY_TOKEN || process.env.GITHUB_TOKEN || undefined;
  return new Octokit({ auth: token });
}

/**
 * Construit le client Repository Intelligence à partir d'une instance Octokit
 * (injectable pour les tests). Seules des méthodes GET du REST API GitHub
 * sont appelées ici : repos.get, git.getTree, repos.getContent, pulls.get,
 * pulls.listFiles, repos.getCommit, repos.compareCommits.
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
  };
}
