import type { GithubReadOnlyClient, RepoRef, TreeEntry, PullRequestFileEntry } from "./githubReadOnlyClient.js";
import { redactSecrets, isSensitivePath } from "./secretScanner.js";
import { REPOSITORY_INTELLIGENCE_LIMITS as LIMITS, repositoryIntelligenceError } from "./limits.js";
import { parseRepoUrl } from "../services/softwareFactoryService.js";

/** Dépôt inspecté par défaut lorsqu'aucun owner/repo/repoUrl n'est fourni. */
const DEFAULT_REPO: RepoRef = { owner: "artisanguillonrenov-creator", repo: "Agent-autonome-socle-" };

const BINARY_EXTENSIONS = new Set([
  ".png", ".jpg", ".jpeg", ".gif", ".bmp", ".ico", ".webp", ".pdf",
  ".zip", ".gz", ".tar", ".tgz", ".rar", ".7z",
  ".woff", ".woff2", ".ttf", ".eot", ".otf",
  ".mp3", ".mp4", ".mov", ".avi", ".wav",
  ".exe", ".dll", ".so", ".dylib", ".bin", ".class", ".jar", ".wasm",
  ".db", ".sqlite", ".sqlite3", ".pyc", ".o", ".a", ".keystore", ".jks",
]);

function hasBinaryExtension(path: string): boolean {
  const idx = path.lastIndexOf(".");
  if (idx === -1) return false;
  return BINARY_EXTENSIONS.has(path.slice(idx).toLowerCase());
}

/** Détection best-effort : présence d'un octet NUL dans les premiers Ko, comme fait git. */
function looksBinary(text: string): boolean {
  return text.slice(0, 8000).includes("\u0000");
}

function truncateChars(text: string, max: number): { text: string; truncated: boolean } {
  if (text.length <= max) return { text, truncated: false };
  return { text: text.slice(0, max), truncated: true };
}

function sanitizePatchEntry(f: PullRequestFileEntry, warnings: string[]): PullRequestFileEntry {
  if (isSensitivePath(f.path)) {
    warnings.push("REPOSITORY_SENSITIVE_FILE_BLOCKED");
    return { ...f, patch: undefined };
  }
  if (!f.patch) return f;
  const { text, truncated } = truncateChars(f.patch, LIMITS.PATCH_MAX_CHARS_PER_FILE);
  const { text: redacted, redactedCount } = redactSecrets(text);
  if (truncated) warnings.push("REPOSITORY_PATCH_TRUNCATED");
  if (redactedCount > 0) warnings.push("REPOSITORY_SECRETS_REDACTED");
  return { ...f, patch: redacted };
}

export function resolveRepoTarget(input: { owner?: unknown; repo?: unknown; repoUrl?: unknown }): RepoRef {
  if (typeof input.repoUrl === "string" && input.repoUrl.trim()) {
    const parsed = parseRepoUrl(input.repoUrl);
    if (!parsed) throw repositoryIntelligenceError("REPOSITORY_TARGET_INVALID");
    return parsed;
  }
  const owner = typeof input.owner === "string" ? input.owner.trim() : "";
  const repo = typeof input.repo === "string" ? input.repo.trim() : "";
  if (owner || repo) {
    if (!owner || !repo) throw repositoryIntelligenceError("REPOSITORY_TARGET_INVALID");
    return { owner, repo };
  }
  return DEFAULT_REPO;
}

export async function resolveRef(client: GithubReadOnlyClient, target: RepoRef, ref?: unknown): Promise<string> {
  if (typeof ref === "string" && ref.trim()) return ref.trim();
  return client.getDefaultBranch(target);
}

// ---------------------------------------------------------------------------
// TREE — parcourir l'arborescence d'un dépôt
// ---------------------------------------------------------------------------

export interface TreeResult {
  owner: string;
  repo: string;
  ref: string;
  entries: TreeEntry[];
  totalEntries: number;
  truncated: boolean;
  warnings: string[];
}

export async function browseTree(client: GithubReadOnlyClient, target: RepoRef, ref: string, options: { prefix?: string } = {}): Promise<TreeResult> {
  const { entries, truncatedByGithub } = await client.getTree(target, ref);
  const prefix = options.prefix?.trim();
  const filtered = prefix ? entries.filter((e) => e.path === prefix || e.path.startsWith(prefix.endsWith("/") ? prefix : `${prefix}/`)) : entries;
  const bounded = filtered.slice(0, LIMITS.TREE_MAX_ENTRIES);
  const warnings: string[] = [];
  if (truncatedByGithub) warnings.push("REPOSITORY_TREE_TRUNCATED_BY_GITHUB");
  if (filtered.length > bounded.length) warnings.push("REPOSITORY_TREE_TRUNCATED_RESULT_LIMIT");
  return { owner: target.owner, repo: target.repo, ref, entries: bounded, totalEntries: filtered.length, truncated: truncatedByGithub || filtered.length > bounded.length, warnings };
}

// ---------------------------------------------------------------------------
// READ_FILE — lire un fichier précis
// ---------------------------------------------------------------------------

export interface FileReadResult {
  owner: string;
  repo: string;
  ref: string;
  path: string;
  blocked: boolean;
  binary: boolean;
  isDirectory: boolean;
  sizeBytes: number;
  text?: string;
  redactedSecrets: number;
  truncated: boolean;
  warnings: string[];
}

export async function readRepositoryFile(client: GithubReadOnlyClient, target: RepoRef, ref: string, path: string): Promise<FileReadResult> {
  if (!path || typeof path !== "string") throw repositoryIntelligenceError("REPOSITORY_PATH_REQUIRED");
  if (isSensitivePath(path)) {
    return { owner: target.owner, repo: target.repo, ref, path, blocked: true, binary: false, isDirectory: false, sizeBytes: 0, redactedSecrets: 0, truncated: false, warnings: ["REPOSITORY_SENSITIVE_FILE_BLOCKED"] };
  }
  const file = await client.getFileContent(target, path, ref);
  if (file.isDirectory) {
    return { owner: target.owner, repo: target.repo, ref, path, blocked: false, binary: false, isDirectory: true, sizeBytes: 0, redactedSecrets: 0, truncated: false, warnings: ["REPOSITORY_PATH_IS_DIRECTORY"] };
  }
  if (file.encoding === "none") throw repositoryIntelligenceError("REPOSITORY_FILE_UNAVAILABLE");
  if (looksBinary(file.content) || hasBinaryExtension(path)) {
    return { owner: target.owner, repo: target.repo, ref, path, blocked: false, binary: true, isDirectory: false, sizeBytes: file.size, redactedSecrets: 0, truncated: false, warnings: ["REPOSITORY_BINARY_FILE_SKIPPED"] };
  }
  const warnings: string[] = [];
  const { text: sized, truncated } = truncateChars(file.content, LIMITS.FILE_MAX_TEXT_CHARS);
  const { text, redactedCount } = redactSecrets(sized);
  if (truncated) warnings.push("REPOSITORY_FILE_TEXT_TRUNCATED");
  if (redactedCount > 0) warnings.push("REPOSITORY_SECRETS_REDACTED");
  return { owner: target.owner, repo: target.repo, ref, path, blocked: false, binary: false, isDirectory: false, sizeBytes: file.size, text, redactedSecrets: redactedCount, truncated, warnings };
}

// ---------------------------------------------------------------------------
// READ_MULTIPLE_FILES — lire plusieurs fichiers utiles à une même question
// ---------------------------------------------------------------------------

export interface MultiFileReadResult {
  owner: string;
  repo: string;
  ref: string;
  files: FileReadResult[];
  requested: number;
  returned: number;
  truncated: boolean;
  warnings: string[];
}

export async function readRepositoryFiles(client: GithubReadOnlyClient, target: RepoRef, ref: string, paths: string[]): Promise<MultiFileReadResult> {
  if (!Array.isArray(paths) || paths.length === 0) throw repositoryIntelligenceError("REPOSITORY_PATHS_REQUIRED");
  const warnings: string[] = [];
  const boundedPaths = paths.slice(0, LIMITS.MULTI_FILE_MAX_FILES);
  let truncated = paths.length > boundedPaths.length;
  if (truncated) warnings.push("REPOSITORY_MULTI_FILE_COUNT_TRUNCATED");

  const files: FileReadResult[] = [];
  let budget = LIMITS.MULTI_FILE_MAX_TOTAL_CHARS;
  for (const p of boundedPaths) {
    if (budget <= 0) {
      files.push({ owner: target.owner, repo: target.repo, ref, path: p, blocked: false, binary: false, isDirectory: false, sizeBytes: 0, redactedSecrets: 0, truncated: true, warnings: ["REPOSITORY_MULTI_FILE_BUDGET_EXCEEDED"] });
      truncated = true;
      continue;
    }
    const result = await readRepositoryFile(client, target, ref, p);
    if (result.text && result.text.length > budget) {
      result.text = result.text.slice(0, budget);
      result.truncated = true;
      result.warnings.push("REPOSITORY_MULTI_FILE_BUDGET_EXCEEDED");
    }
    budget -= result.text?.length ?? 0;
    if (result.truncated) truncated = true;
    files.push(result);
  }
  return { owner: target.owner, repo: target.repo, ref, files, requested: paths.length, returned: files.length, truncated, warnings };
}

// ---------------------------------------------------------------------------
// SEARCH_PATH — rechercher des fichiers par nom ou chemin
// ---------------------------------------------------------------------------

export interface PathSearchResult {
  owner: string;
  repo: string;
  ref: string;
  query: string;
  matches: TreeEntry[];
  totalMatches: number;
  truncated: boolean;
  warnings: string[];
}

function toPathMatcher(query: string, caseSensitive: boolean): (p: string) => boolean {
  if (query.includes("*")) {
    const escaped = query.split("*").map((s) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")).join(".*");
    const re = new RegExp(`^${escaped}$`, caseSensitive ? "" : "i");
    return (p) => re.test(p);
  }
  const needle = caseSensitive ? query : query.toLowerCase();
  return (p) => (caseSensitive ? p : p.toLowerCase()).includes(needle);
}

export async function searchRepositoryPath(
  client: GithubReadOnlyClient,
  target: RepoRef,
  ref: string,
  query: string,
  options: { caseSensitive?: boolean; maxResults?: number } = {},
): Promise<PathSearchResult> {
  if (!query || typeof query !== "string") throw repositoryIntelligenceError("REPOSITORY_QUERY_REQUIRED");
  const { entries, truncatedByGithub } = await client.getTree(target, ref);
  const matcher = toPathMatcher(query, options.caseSensitive === true);
  const all = entries.filter((e) => matcher(e.path));
  const maxResults = Math.min(Math.max(1, options.maxResults ?? LIMITS.PATH_SEARCH_MAX_RESULTS), LIMITS.PATH_SEARCH_MAX_RESULTS);
  const matches = all.slice(0, maxResults);
  const warnings: string[] = [];
  if (truncatedByGithub) warnings.push("REPOSITORY_TREE_TRUNCATED_BY_GITHUB");
  if (all.length > matches.length) warnings.push("REPOSITORY_SEARCH_RESULTS_TRUNCATED");
  return { owner: target.owner, repo: target.repo, ref, query, matches, totalMatches: all.length, truncated: truncatedByGithub || all.length > matches.length, warnings };
}

// ---------------------------------------------------------------------------
// SEARCH_CODE — rechercher du texte dans le code
// ---------------------------------------------------------------------------

export interface CodeSearchMatch {
  path: string;
  line: number;
  context: string;
}

export interface CodeSearchResult {
  owner: string;
  repo: string;
  ref: string;
  query: string;
  matches: CodeSearchMatch[];
  totalMatches: number;
  filesScanned: number;
  truncated: boolean;
  warnings: string[];
}

export async function searchRepositoryCode(
  client: GithubReadOnlyClient,
  target: RepoRef,
  ref: string,
  query: string,
  options: { caseSensitive?: boolean; maxResults?: number; extensions?: string[] } = {},
): Promise<CodeSearchResult> {
  if (!query || typeof query !== "string") throw repositoryIntelligenceError("REPOSITORY_QUERY_REQUIRED");
  const { entries } = await client.getTree(target, ref);
  const extFilter = options.extensions?.length
    ? new Set(options.extensions.map((e) => (e.startsWith(".") ? e.toLowerCase() : `.${e.toLowerCase()}`)))
    : undefined;
  const candidates = entries.filter((e) => {
    if (e.type !== "blob" || isSensitivePath(e.path) || hasBinaryExtension(e.path)) return false;
    if (!extFilter) return true;
    const idx = e.path.lastIndexOf(".");
    return idx !== -1 && extFilter.has(e.path.slice(idx).toLowerCase());
  });

  const caseSensitive = options.caseSensitive === true;
  const needle = caseSensitive ? query : query.toLowerCase();
  const maxResults = Math.min(Math.max(1, options.maxResults ?? LIMITS.CODE_SEARCH_MAX_RESULTS), LIMITS.CODE_SEARCH_MAX_RESULTS);

  const matches: CodeSearchMatch[] = [];
  const warnings: string[] = [];
  let totalMatches = 0, filesScanned = 0, bytesScanned = 0, truncated = false;

  for (const entry of candidates) {
    if (filesScanned >= LIMITS.CODE_SEARCH_MAX_FILES_SCANNED || bytesScanned >= LIMITS.CODE_SEARCH_MAX_BYTES_SCANNED) {
      truncated = true;
      warnings.push("REPOSITORY_SEARCH_SCAN_BUDGET_EXCEEDED");
      break;
    }
    let file;
    try {
      file = await client.getFileContent(target, entry.path, ref);
    } catch {
      continue;
    }
    if (file.isDirectory || file.encoding === "none") continue;
    filesScanned++;
    bytesScanned += file.size;
    if (file.size > LIMITS.CODE_SEARCH_PER_FILE_MAX_BYTES || looksBinary(file.content)) continue;

    const haystack = caseSensitive ? file.content : file.content.toLowerCase();
    const lines = file.content.split("\n");
    let searchFrom = 0;
    while (true) {
      const idx = haystack.indexOf(needle, searchFrom);
      if (idx === -1) break;
      totalMatches++;
      if (matches.length < maxResults) {
        const lineNumber = haystack.slice(0, idx).split("\n").length;
        const lineText = lines[lineNumber - 1] ?? "";
        const capped = lineText.length > LIMITS.CODE_SEARCH_CONTEXT_CHARS ? lineText.slice(0, LIMITS.CODE_SEARCH_CONTEXT_CHARS) : lineText;
        const { text: context } = redactSecrets(capped);
        matches.push({ path: entry.path, line: lineNumber, context });
      }
      searchFrom = idx + Math.max(needle.length, 1);
    }
  }

  if (totalMatches > matches.length) {
    truncated = true;
    warnings.push("REPOSITORY_SEARCH_RESULTS_TRUNCATED");
  }
  return { owner: target.owner, repo: target.repo, ref, query, matches, totalMatches, filesScanned, truncated, warnings };
}

// ---------------------------------------------------------------------------
// PULL REQUESTS
// ---------------------------------------------------------------------------

export interface PullRequestReadResult {
  owner: string;
  repo: string;
  number: number;
  title: string;
  body: string;
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
  truncated: boolean;
  warnings: string[];
}

function assertValidPrNumber(number: unknown): asserts number is number {
  if (!Number.isInteger(number) || (number as number) <= 0) throw repositoryIntelligenceError("REPOSITORY_PR_NUMBER_INVALID");
}

export async function readPullRequest(client: GithubReadOnlyClient, target: RepoRef, number: unknown): Promise<PullRequestReadResult> {
  assertValidPrNumber(number);
  const pr = await client.getPullRequest(target, number);
  const warnings: string[] = [];
  const { text: sizedBody, truncated: bodyTruncated } = truncateChars(pr.body ?? "", LIMITS.PR_BODY_MAX_CHARS);
  const { text: body, redactedCount } = redactSecrets(sizedBody);
  if (bodyTruncated) warnings.push("REPOSITORY_PR_BODY_TRUNCATED");
  if (redactedCount > 0) warnings.push("REPOSITORY_SECRETS_REDACTED");
  return { owner: target.owner, repo: target.repo, ...pr, body, truncated: bodyTruncated, warnings };
}

export interface PullRequestFilesResult {
  owner: string;
  repo: string;
  number: number;
  files: PullRequestFileEntry[];
  totalFiles: number;
  truncated: boolean;
  warnings: string[];
}

export async function readPullRequestFiles(client: GithubReadOnlyClient, target: RepoRef, number: unknown): Promise<PullRequestFilesResult> {
  assertValidPrNumber(number);
  const pr = await client.getPullRequest(target, number);
  const rawFiles = await client.listPullRequestFiles(target, number, LIMITS.PR_MAX_FILES);
  const warnings: string[] = [];
  const files = rawFiles.map((f) => sanitizePatchEntry(f, warnings));
  const truncated = pr.changedFiles > files.length;
  if (truncated) warnings.push("REPOSITORY_PR_FILES_TRUNCATED");
  return { owner: target.owner, repo: target.repo, number, files, totalFiles: pr.changedFiles, truncated, warnings };
}

export interface PullRequestDiffResult {
  owner: string;
  repo: string;
  number: number;
  diff: string;
  sizeChars: number;
  redactedSecrets: number;
  truncated: boolean;
  warnings: string[];
}

export async function readPullRequestDiff(client: GithubReadOnlyClient, target: RepoRef, number: unknown): Promise<PullRequestDiffResult> {
  assertValidPrNumber(number);
  const raw = await client.getPullRequestDiff(target, number);
  const { text: sized, truncated } = truncateChars(raw, LIMITS.DIFF_MAX_CHARS);
  const { text: diff, redactedCount } = redactSecrets(sized);
  const warnings: string[] = [];
  if (truncated) warnings.push("REPOSITORY_DIFF_TRUNCATED");
  if (redactedCount > 0) warnings.push("REPOSITORY_SECRETS_REDACTED");
  return { owner: target.owner, repo: target.repo, number, diff, sizeChars: diff.length, redactedSecrets: redactedCount, truncated, warnings };
}

// ---------------------------------------------------------------------------
// COMMIT
// ---------------------------------------------------------------------------

export interface CommitReadResult {
  owner: string;
  repo: string;
  sha: string;
  message: string;
  author: string;
  date: string;
  additions: number;
  deletions: number;
  files: PullRequestFileEntry[];
  totalFiles: number;
  truncated: boolean;
  warnings: string[];
}

export async function readCommit(client: GithubReadOnlyClient, target: RepoRef, sha: string): Promise<CommitReadResult> {
  if (!sha || typeof sha !== "string") throw repositoryIntelligenceError("REPOSITORY_SHA_REQUIRED");
  const commit = await client.getCommit(target, sha);
  const warnings: string[] = [];
  const boundedFiles = commit.files.slice(0, LIMITS.COMMIT_MAX_FILES).map((f) => sanitizePatchEntry(f, warnings));
  const truncated = commit.totalFiles > boundedFiles.length;
  if (truncated) warnings.push("REPOSITORY_COMMIT_FILES_TRUNCATED");
  return {
    owner: target.owner,
    repo: target.repo,
    sha: commit.sha,
    message: commit.message,
    author: commit.author,
    date: commit.date,
    additions: commit.additions,
    deletions: commit.deletions,
    files: boundedFiles,
    totalFiles: commit.totalFiles,
    truncated,
    warnings,
  };
}

// ---------------------------------------------------------------------------
// READ_DIFF — diff entre deux versions (branches, tags, SHA)
// ---------------------------------------------------------------------------

export interface DiffReadResult {
  owner: string;
  repo: string;
  base: string;
  head: string;
  aheadBy: number;
  behindBy: number;
  totalCommits: number;
  files: PullRequestFileEntry[];
  totalFiles: number;
  truncated: boolean;
  warnings: string[];
}

export async function readDiffBetweenVersions(client: GithubReadOnlyClient, target: RepoRef, base: string, head: string): Promise<DiffReadResult> {
  if (!base || !head || typeof base !== "string" || typeof head !== "string") throw repositoryIntelligenceError("REPOSITORY_DIFF_RANGE_REQUIRED");
  const compare = await client.compare(target, base, head);
  const warnings: string[] = [];
  const boundedFiles = compare.files.slice(0, LIMITS.COMMIT_MAX_FILES).map((f) => sanitizePatchEntry(f, warnings));
  const truncated = compare.totalFiles > boundedFiles.length;
  if (truncated) warnings.push("REPOSITORY_DIFF_FILES_TRUNCATED");
  return {
    owner: target.owner,
    repo: target.repo,
    base,
    head,
    aheadBy: compare.aheadBy,
    behindBy: compare.behindBy,
    totalCommits: compare.totalCommits,
    files: boundedFiles,
    totalFiles: compare.totalFiles,
    truncated,
    warnings,
  };
}

// ---------------------------------------------------------------------------
// BUILD_CONTEXT — construire automatiquement un contexte pertinent
// ---------------------------------------------------------------------------

export interface ContextSnippet {
  path: string;
  snippet: string;
  matchedBy: "path" | "code";
}

export interface ContextBuildResult {
  owner: string;
  repo: string;
  ref: string;
  query: string;
  snippets: ContextSnippet[];
  truncated: boolean;
  warnings: string[];
}

export async function buildRepositoryContext(client: GithubReadOnlyClient, target: RepoRef, ref: string, query: string): Promise<ContextBuildResult> {
  if (!query || typeof query !== "string") throw repositoryIntelligenceError("REPOSITORY_QUERY_REQUIRED");
  const warnings: string[] = [];
  const pathResult = await searchRepositoryPath(client, target, ref, query, { maxResults: LIMITS.CONTEXT_MAX_SNIPPETS });
  const codeResult = await searchRepositoryCode(client, target, ref, query, { maxResults: LIMITS.CONTEXT_MAX_SNIPPETS * 3 });
  let truncated = pathResult.truncated || codeResult.truncated;
  if (truncated) warnings.push("REPOSITORY_CONTEXT_SOURCE_TRUNCATED");

  const ranked = new Map<string, "path" | "code">();
  for (const m of pathResult.matches) if (m.type === "blob") ranked.set(m.path, "path");
  for (const m of codeResult.matches) if (!ranked.has(m.path)) ranked.set(m.path, "code");

  const snippets: ContextSnippet[] = [];
  let totalChars = 0;
  for (const [path, matchedBy] of ranked) {
    if (snippets.length >= LIMITS.CONTEXT_MAX_SNIPPETS || totalChars >= LIMITS.CONTEXT_TOTAL_MAX_CHARS) {
      truncated = true;
      break;
    }
    const file = await readRepositoryFile(client, target, ref, path);
    if (file.blocked || file.binary || file.isDirectory || !file.text) continue;
    const remaining = LIMITS.CONTEXT_TOTAL_MAX_CHARS - totalChars;
    const cap = Math.min(LIMITS.CONTEXT_SNIPPET_MAX_CHARS, remaining);
    const snippet = file.text.slice(0, cap);
    if (snippet.length < file.text.length) truncated = true;
    totalChars += snippet.length;
    snippets.push({ path, snippet, matchedBy });
  }
  if (truncated && !warnings.includes("REPOSITORY_CONTEXT_TRUNCATED")) warnings.push("REPOSITORY_CONTEXT_TRUNCATED");
  return { owner: target.owner, repo: target.repo, ref, query, snippets, truncated, warnings };
}

// ---------------------------------------------------------------------------
// AUDIT — audit borné d'un dépôt ou d'une PR
// ---------------------------------------------------------------------------

export interface AuditFinding {
  severity: "INFO" | "WARNING" | "CRITICAL";
  code: string;
  path?: string;
  message: string;
}

export interface AuditResult {
  owner: string;
  repo: string;
  scope: "REPOSITORY" | "PULL_REQUEST";
  ref?: string;
  prNumber?: number;
  findings: AuditFinding[];
  filesScanned: number;
  truncated: boolean;
  warnings: string[];
}

export async function auditRepository(client: GithubReadOnlyClient, target: RepoRef, options: { ref?: string; prNumber?: number }): Promise<AuditResult> {
  const findings: AuditFinding[] = [];
  let filesScanned = 0, truncated = false;
  const warnings: string[] = [];

  if (options.prNumber !== undefined) {
    assertValidPrNumber(options.prNumber);
    // Inspection sur les patches bruts (avant sanitization) : readPullRequestFiles() masquerait
    // déjà les secrets, ce qui empêcherait précisément l'audit de les détecter.
    const pr = await client.getPullRequest(target, options.prNumber);
    const rawFiles = await client.listPullRequestFiles(target, options.prNumber, LIMITS.PR_MAX_FILES);
    if (pr.changedFiles > rawFiles.length) truncated = true;
    for (const f of rawFiles) {
      filesScanned++;
      if (isSensitivePath(f.path)) {
        findings.push({ severity: "WARNING", code: "SENSITIVE_FILE_TOUCHED", path: f.path, message: `Fichier sensible modifié : ${f.path}` });
      } else if (f.patch) {
        const scan = redactSecrets(f.patch);
        if (scan.redactedCount > 0) findings.push({ severity: "CRITICAL", code: "POTENTIAL_SECRET_IN_DIFF", path: f.path, message: `Motif ressemblant à un secret détecté dans le diff de ${f.path}` });
      } else if (f.additions > 0 || f.deletions > 0) {
        findings.push({ severity: "INFO", code: "BINARY_OR_LARGE_FILE_CHANGED", path: f.path, message: `Fichier binaire ou volumineux modifié : ${f.path}` });
      }
      if (findings.length >= LIMITS.AUDIT_MAX_FINDINGS) {
        truncated = true;
        warnings.push("REPOSITORY_AUDIT_FINDINGS_TRUNCATED");
        break;
      }
    }
    return { owner: target.owner, repo: target.repo, scope: "PULL_REQUEST", prNumber: options.prNumber, findings, filesScanned, truncated, warnings };
  }

  const ref = await resolveRef(client, target, options.ref);
  const tree = await browseTree(client, target, ref);
  if (tree.truncated) truncated = true;
  const blobs = tree.entries.filter((e) => e.type === "blob");
  const candidates = blobs.slice(0, LIMITS.AUDIT_MAX_FILES);
  if (blobs.length > candidates.length) truncated = true;

  for (const entry of candidates) {
    filesScanned++;
    if (isSensitivePath(entry.path)) {
      findings.push({ severity: "WARNING", code: "SENSITIVE_FILE_PRESENT", path: entry.path, message: `Fichier potentiellement sensible présent : ${entry.path}` });
      continue;
    }
    if (hasBinaryExtension(entry.path)) continue;
    let file;
    try {
      file = await client.getFileContent(target, entry.path, ref);
    } catch {
      continue;
    }
    if (file.isDirectory || file.encoding === "none" || looksBinary(file.content)) continue;
    const scan = redactSecrets(file.content.slice(0, LIMITS.CODE_SEARCH_PER_FILE_MAX_BYTES));
    if (scan.redactedCount > 0) findings.push({ severity: "CRITICAL", code: "POTENTIAL_SECRET_IN_FILE", path: entry.path, message: `Motif ressemblant à un secret détecté dans ${entry.path}` });
    if (findings.length >= LIMITS.AUDIT_MAX_FINDINGS) {
      truncated = true;
      warnings.push("REPOSITORY_AUDIT_FINDINGS_TRUNCATED");
      break;
    }
  }
  return { owner: target.owner, repo: target.repo, scope: "REPOSITORY", ref, findings, filesScanned, truncated, warnings };
}
