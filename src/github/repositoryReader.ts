import { Octokit } from "@octokit/rest";
import { getGitHubToken } from "./auth.js";

export const REPOSITORY_LIMITS = Object.freeze({ maxTreeEntries: 5000, maxFilesRead: 30, maxFileBytes: 256 * 1024, maxTotalBytes: 2 * 1024 * 1024, maxSearchResults: 100, maxDepth: 20 });
export type RepositoryRef = { owner: string; repo: string };
export type SearchConfidence = "HIGH" | "MEDIUM" | "LOW";
export interface SearchMatch { path: string; source: "path" | "github-code-search" | "bounded-content"; score: number; confidence: SearchConfidence; matches?: string[]; evidence?: string; }
export interface RepositoryContext { repository: string; defaultBranch: string; ref: string; treeEntries: number; filesRead: number; bytesRead: number; truncated: boolean; }
export interface AuditFinding { severity: "BLOCKER" | "HIGH" | "MEDIUM" | "LOW" | "INFO"; title: string; files: string[]; evidence: string; impact: string; recommendation: string; }
type TreeEntry = { path: string; type: string; size?: number; sha?: string };
type DiffFile = { filename: string; status?: string; additions?: number; deletions?: number; changes?: number; patch?: string; patchTruncated?: boolean; redacted?: boolean };

const excluded = /(^|\/)(node_modules|vendor|dist|build|coverage|\.gradle|\.git)(\/|$)|(^|\/)(package-lock\.json|yarn\.lock|pnpm-lock\.yaml|.*\.lock)$/i;
const binary = /\.(?:png|jpe?g|gif|webp|ico|pdf|zip|gz|tgz|7z|rar|jar|war|apk|aab|so|dll|exe|bin|woff2?|ttf|mp[34]|mov|avi)$/i;
const secretPath = /(^|\/)(?:\.env(?:\..*)?|credentials?[^/]*|secrets?[^/]*|.*(?:private[_-]?key|id_rsa|id_ed25519).*)$/i;
// Recognized secret-bearing key *families*, matched case-insensitively with any identifier prefix
// (snake_case or camelCase) so AWS_SECRET_ACCESS_KEY, STRIPE_SECRET_KEY, JWT_SECRET, githubToken,
// clientSecret, etc. are all covered without enumerating every concrete key name. "KEY" alone is
// intentionally NOT a generic suffix (too noisy — sortKey, primaryKey, ...); only the specific
// *_SECRET_KEY / *_ACCESS_KEY / *_PRIVATE_KEY / *_API_KEY compounds are recognized, in both
// snake_case and concatenated-camelCase spelling (underscores are word characters, so a plain \b
// suffix match never bridges a snake_case boundary).
const SECRET_KEY_SUFFIXES = ["SECRET_KEY", "SECRETKEY", "ACCESS_KEY", "ACCESSKEY", "PRIVATE_KEY", "PRIVATEKEY", "API_KEY", "APIKEY", "TOKEN", "PASSWORD", "SECRET", "AUTHORIZATION"].join("|");
/** Recognized secret-bearing key names: an optional bounded identifier prefix plus one of the suffix families above. */
const SECRET_KEY_PATTERN = `(?:[A-Za-z][A-Za-z0-9_]{0,60})?(?:${SECRET_KEY_SUFFIXES})`;
const assignment = new RegExp(`(["']?\\b${SECRET_KEY_PATTERN}\\b["']?\\s*[:=]\\s*)("(?:[^"\\\\]|\\\\.)*"|'(?:[^'\\\\]|\\\\.)*'|[^\\s,;)}\\]"']+)`, "gi");
/** Bare, unquoted values that read as type/keyword tokens rather than secrets (e.g. `token?: string`). */
const SAFE_BARE_VALUES = new Set(["string", "number", "boolean", "any", "unknown", "never", "void", "null", "undefined", "object", "symbol", "bigint", "true", "false"]);
/** A dotted identifier chain (e.g. `process.env.GITHUB_TOKEN`) is a code reference, not a literal secret. */
const dottedIdentifier = /^[A-Za-z_$][\w$]*(?:\.[A-Za-z_$][\w$]*)+$/;
// Any algorithm/qualifier word(s) before "PRIVATE KEY" are accepted (RSA, EC, OPENSSH, ENCRYPTED, DSA, ...)
// so the redaction stays robust to headers this list doesn't enumerate by name.
const privateKey = /-----BEGIN (?:[A-Z0-9]+ )*PRIVATE KEY-----[\s\S]*?-----END (?:[A-Z0-9]+ )*PRIVATE KEY-----/g;
const synonyms: Record<string, string[]> = { parametres: ["settings"], settings: ["parametres"], depot: ["repository"], repository: ["depot"], fichier: ["file"], file: ["fichier"], fonction: ["function"], function: ["fonction"] };
const stopwords = new Set(["a", "au", "aux", "avec", "ce", "ces", "de", "des", "du", "et", "la", "le", "les", "pour", "sur", "the", "to", "with", "dans", "un", "une"]);
const normalize = (value: string) => value.normalize("NFD").replace(/[\u0300-\u036f]/g, "").toLowerCase();

/** Single canonical GitHub repository reference parser, shared by RepositoryReader, the software_development skill and SoftwareFactoryService. */
export function parseGitHubRepository(value: string): RepositoryRef {
  const clean = String(value ?? "").trim().replace(/^git@github\.com:/i, "").replace(/^https?:\/\/(?:www\.)?github\.com\//i, "").replace(/\.git$/i, "").replace(/^\/+|\/+$/g, "");
  const parts = clean.split("/");
  if (parts.length !== 2 || !parts.every(part => /^[A-Za-z0-9_.-]+$/.test(part)) || !parts[0] || !parts[1]) throw new Error("REPOSITORY_INVALID");
  return { owner: parts[0], repo: parts[1] };
}
export function resolveSelfRepository(requested?: string, selfReferential = false): RepositoryRef {
  if (requested) return parseGitHubRepository(requested);
  if (!selfReferential) throw new Error("REPOSITORY_REQUIRED");
  return parseGitHubRepository(process.env.JARVIS_REPOSITORY || "artisanguillonrenov-creator/Agent-autonome-socle-");
}
export function isSecretPath(path: string) { return secretPath.test(path); }
export function isForbiddenRepositoryPath(path: string) { return excluded.test(path) || binary.test(path) || isSecretPath(path) || path.split("/").length > REPOSITORY_LIMITS.maxDepth; }
function redact(text: string) {
  let redacted = false;
  let value = text.replace(privateKey, () => { redacted = true; return "[REDACTED: PRIVATE KEY]"; });
  value = value.replace(assignment, (all: string, prefix: string, raw: string) => {
    const quote = raw[0] === '"' || raw[0] === "'" ? raw[0] : "";
    const inner = quote ? raw.slice(1, -1) : raw;
    if (!inner.trim()) return all;
    if (!quote && (SAFE_BARE_VALUES.has(inner.toLowerCase()) || dottedIdentifier.test(inner))) return all;
    redacted = true;
    return `${prefix}${quote}[REDACTED]${quote}`;
  });
  return { text: value, redacted };
}
function safePatch(file: any): DiffFile { const out: DiffFile = { filename: String(file.filename ?? file.path ?? ""), status: file.status, additions: file.additions, deletions: file.deletions, changes: file.changes }; if (isSecretPath(out.filename)) { out.patch = "[REDACTED: SECRET FILE]"; out.redacted = true; return out; } if (typeof file.patch === "string") { const bytes = Buffer.from(file.patch); const clipped = bytes.length > REPOSITORY_LIMITS.maxFileBytes ? bytes.subarray(0, REPOSITORY_LIMITS.maxFileBytes).toString("utf8") : file.patch; const filtered = redact(clipped); out.patch = filtered.text; out.redacted = filtered.redacted; if (clipped !== file.patch) out.patchTruncated = true; } return out; }
function confidence(score: number): SearchConfidence { return score >= 80 ? "HIGH" : score >= 50 ? "MEDIUM" : "LOW"; }

/** Errors readFile throws for expected, policy-driven skips — never a sign of an incomplete inspection by themselves. */
const EXPECTED_READ_SKIPS = new Set(["SECRET_FILE_BLOCKED", "BINARY_OR_EXCLUDED_FILE", "REPOSITORY_READ_LIMIT_EXCEEDED", "MAX_FILES_READ_EXCEEDED", "NOT_A_TEXT_FILE", "BINARY_FILE_REJECTED"]);
export interface ReadError { path: string; error: string; }

export class GitHubRepositoryReader {
  private readonly octokit: any;
  private filesRead = 0;
  private bytesRead = 0;
  /** Truthful record of which bounds actually stopped inspection, independent of exact counter values. */
  private limitState = { tree: false, files: false, bytes: false };
  /** Real GitHub read failures (403/404/rate-limit/network/...) hit while inspecting a candidate — never a policy skip. */
  private readErrors: ReadError[] = [];
  constructor(client?: any) { this.octokit = client ?? new Octokit({ auth: getGitHubToken() || undefined }); }
  /**
   * Classifies a failure caught while reading a candidate file: an expected policy skip
   * (SECRET_FILE_BLOCKED, a limit, ...) is not recorded, but any other failure (GitHub API error,
   * network error, ...) is recorded so callers never report a complete inspection when one wasn't
   * possible. Only a generic classification is kept — never the raw error text — so nothing from a
   * GitHub API error body (which could in principle echo request details) is ever exposed.
   */
  private recordReadFailure(path: string, err: unknown) {
    const message = err instanceof Error ? err.message : String(err);
    if (!EXPECTED_READ_SKIPS.has(message)) this.readErrors.push({ path, error: "GITHUB_READ_ERROR" });
  }
  private eligible(path: string, size = 0) { return !isForbiddenRepositoryPath(path) && size <= REPOSITORY_LIMITS.maxFileBytes; }
  private terms(query: string) { const phrase = normalize(query).trim(); const words = [...new Set(phrase.split(/[^a-z0-9_.-]+/).filter(word => word.length > 1 && !stopwords.has(word)))]; const synonymTerms = words.flatMap(word => synonyms[word] ?? []); return { phrase, words, synonyms: [...new Set(synonymTerms)] }; }
  async inspect(repository: string, ref?: string) { const { owner, repo } = parseGitHubRepository(repository); const response = await this.octokit.rest.repos.get({ owner, repo }); const defaultBranch = response.data.default_branch || "main"; return { owner, repo, repository: `${owner}/${repo}`, defaultBranch, ref: ref || defaultBranch }; }
  async inspectRepository(repository: string, ref?: string) { return this.inspect(repository, ref); }
  async getDefaultBranch(repository: string) { return (await this.inspect(repository)).defaultBranch; }
  async tree(repository: string, ref?: string) { const ctx = await this.inspect(repository, ref); const response = await this.octokit.rest.git.getTree({ owner: ctx.owner, repo: ctx.repo, tree_sha: ctx.ref, recursive: "true" }); const all = (response.data.tree ?? []) as TreeEntry[]; const boundedDepth = all.filter(entry => entry.path && entry.path.split("/").length <= REPOSITORY_LIMITS.maxDepth); const entries = boundedDepth.slice(0, REPOSITORY_LIMITS.maxTreeEntries); const truncated = Boolean(response.data.truncated) || boundedDepth.length > entries.length; if (truncated) this.limitState.tree = true; return { ...ctx, entries, truncated, totalEntries: all.length }; }
  async readTree(repository: string, ref?: string) { return this.tree(repository, ref); }
  async readFile(repository: string, path: string, ref?: string) {
    if (!this.eligible(path)) throw new Error(isSecretPath(path) ? "SECRET_FILE_BLOCKED" : "BINARY_OR_EXCLUDED_FILE");
    if (this.filesRead >= REPOSITORY_LIMITS.maxFilesRead) { this.limitState.files = true; throw new Error("MAX_FILES_READ_EXCEEDED"); }
    const ctx = await this.inspect(repository, ref);
    const response = await this.octokit.rest.repos.getContent({ owner: ctx.owner, repo: ctx.repo, path, ref: ctx.ref });
    if (Array.isArray(response.data) || typeof response.data.content !== "string") throw new Error("NOT_A_TEXT_FILE");
    const raw = Buffer.from(response.data.content, "base64");
    if (raw.length > REPOSITORY_LIMITS.maxFileBytes) throw new Error("REPOSITORY_READ_LIMIT_EXCEEDED");
    // The remaining byte budget can run out before bytesRead ever equals maxTotalBytes exactly, so this check
    // (not a `bytesRead >= maxTotalBytes` comparison) is the truthful source for limitState.bytes.
    if (this.bytesRead + raw.length > REPOSITORY_LIMITS.maxTotalBytes) { this.limitState.bytes = true; throw new Error("REPOSITORY_READ_LIMIT_EXCEEDED"); }
    if (raw.includes(0)) throw new Error("BINARY_FILE_REJECTED");
    this.filesRead++; this.bytesRead += raw.length;
    const value = redact(raw.toString("utf8"));
    return { path, content: value.text, redacted: value.redacted, bytes: raw.length, sha: response.data.sha };
  }

  private pathScore(path: string, query: ReturnType<GitHubRepositoryReader["terms"]>) { const normalized = normalize(path); if (normalized === query.phrase) return 95; if (query.phrase && normalized.includes(query.phrase)) return 85; const wordHits = query.words.filter(word => normalized.includes(word)); if (wordHits.length) return Math.min(75, 50 + wordHits.length * 8); return query.synonyms.some(term => normalized.includes(term)) ? 35 : 0; }
  async searchPaths(repository: string, query: string, ref?: string) { const tree = await this.tree(repository, ref), terms = this.terms(query); const scored = tree.entries.filter(entry => entry.type === "blob" && this.eligible(entry.path, entry.size)).map(entry => ({ entry, score: this.pathScore(entry.path, terms) })).filter(value => value.score > 0).sort((a, b) => b.score - a.score || a.entry.path.localeCompare(b.entry.path)); const results = scored.slice(0, REPOSITORY_LIMITS.maxSearchResults).map(value => ({ ...value.entry, score: value.score, confidence: confidence(value.score) })); return { results, truncated: tree.truncated || scored.length > results.length, totalCandidates: tree.totalEntries }; }
  async searchContent(repository: string, query: string, ref?: string) {
    const ctx = await this.inspect(repository, ref), terms = this.terms(query), tree = await this.tree(repository, ref), found = new Map<string, SearchMatch>();
    for (const entry of tree.entries.filter(entry => entry.type === "blob" && this.eligible(entry.path, entry.size))) { const score = this.pathScore(entry.path, terms); if (score) found.set(entry.path, { path: entry.path, source: "path", score, confidence: confidence(score), matches: terms.words.filter(word => normalize(entry.path).includes(word)), evidence: `Path matches query: ${entry.path}` }); }
    // GitHub Code Search is default-branch-only. Explicit non-default refs use the ref-specific tree/content fallback.
    if (ctx.ref === ctx.defaultBranch) try { const response = await this.octokit.rest.search.code({ q: `${query} repo:${ctx.repository}`, per_page: REPOSITORY_LIMITS.maxSearchResults }); for (const item of response.data.items ?? []) if (normalize(String(item.repository?.full_name ?? "")) === normalize(ctx.repository) && this.eligible(item.path) && tree.entries.some(entry => entry.type === "blob" && entry.path === item.path)) { const score = Math.max(found.get(item.path)?.score ?? 0, 75); found.set(item.path, { path: item.path, source: "github-code-search", score, confidence: confidence(score), evidence: "GitHub Code Search matched this file on the default branch." }); } } catch { /* Optional read-only endpoint. */ }
    const structural = /^(?:README|package\.json|tsconfig|src\/index|src\/main|app\/|lib\/|src\/)/i;
    const candidates = tree.entries.filter(entry => entry.type === "blob" && this.eligible(entry.path, entry.size) && (structural.test(entry.path) || /\.(?:ts|tsx|js|jsx|py|java|kt|go|rs|rb|php|cs|json|ya?ml|md|html|css)$/i.test(entry.path)));
    for (const entry of candidates) { if (this.filesRead >= REPOSITORY_LIMITS.maxFilesRead) { this.limitState.files = true; break; } try { const file = await this.readFile(repository, entry.path, ctx.ref), content = normalize(file.content); let score = 0; const matched: string[] = []; if (terms.phrase && content.includes(terms.phrase)) { score = /[_.$-]/.test(terms.phrase) ? 100 : 92; matched.push(terms.phrase); } else { const words = terms.words.filter(word => content.includes(word)); const synonymHits = terms.synonyms.filter(term => content.includes(term)); matched.push(...words, ...synonymHits); if (words.length) score = Math.min(79, 48 + words.length * 9); else if (synonymHits.length) score = 40; } if (score > 0) { const previous = found.get(entry.path); const best = Math.max(previous?.score ?? 0, score); found.set(entry.path, { path: entry.path, source: score >= (previous?.score ?? 0) ? "bounded-content" : previous!.source, score: best, confidence: confidence(best), matches: [...new Set([...(previous?.matches ?? []), ...matched])], evidence: `Matched ${matched.slice(0, 5).join(", ")} in bounded content.` }); } } catch (err) { this.recordReadFailure(entry.path, err); /* A skipped file remains outside the bounded result set; limitState/readErrors already recorded why. */ } }
    const matches = [...found.values()].sort((a, b) => b.score - a.score || a.path.localeCompare(b.path)).slice(0, REPOSITORY_LIMITS.maxSearchResults);
    // Truthful truncation: any bound that actually prevented inspection of relevant candidates, a real read
    // error that skipped a candidate, or more results than were returned. A real error must never be swallowed
    // into a false "complete" result.
    const truncated = this.limitState.tree || this.limitState.files || this.limitState.bytes || this.readErrors.length > 0 || found.size > matches.length;
    return { matches, recommendedFiles: matches, truncated, readErrors: [...this.readErrors], filesRead: this.filesRead, bytesRead: this.bytesRead };
  }

  private diff(files: any[] | undefined, total?: number, totalFilesUnknown = false) { const all = files ?? [], returned = all.slice(0, REPOSITORY_LIMITS.maxSearchResults).map(safePatch), totalFiles = total ?? all.length; return { files: returned, truncated: totalFilesUnknown || totalFiles > returned.length || all.length > returned.length, totalFiles, returnedFiles: returned.length, ...(totalFilesUnknown ? { totalFilesUnknown: true } : {}) }; }
  private async paginatedFiles(call: (page: number) => Promise<any>, first: any[], exactTotal?: number) { if (exactTotal !== undefined || first.length < REPOSITORY_LIMITS.maxSearchResults) return { files: first, total: exactTotal ?? first.length, unknown: false }; const files = [...first]; let page = 2; while (files.length <= REPOSITORY_LIMITS.maxSearchResults) { const response = await call(page++), next = response.data.files ?? []; files.push(...next); if (next.length < REPOSITORY_LIMITS.maxSearchResults) return { files, total: files.length, unknown: false }; } return { files, total: files.length, unknown: true }; }
  async readPullRequest(repository: string, pullNumber: number) { const ctx = await this.inspect(repository), pull = await this.octokit.rest.pulls.get({ owner: ctx.owner, repo: ctx.repo, pull_number: pullNumber }), files = await this.octokit.rest.pulls.listFiles({ owner: ctx.owner, repo: ctx.repo, pull_number: pullNumber, per_page: REPOSITORY_LIMITS.maxSearchResults }); return { number: pull.data.number, title: pull.data.title, state: pull.data.state, ...this.diff(files.data, pull.data.changed_files) }; }
  async readCommit(repository: string, sha: string) { const ctx = await this.inspect(repository), first = await this.octokit.rest.repos.getCommit({ owner: ctx.owner, repo: ctx.repo, ref: sha, per_page: REPOSITORY_LIMITS.maxSearchResults, page: 1 }), pages = await this.paginatedFiles(page => this.octokit.rest.repos.getCommit({ owner: ctx.owner, repo: ctx.repo, ref: sha, per_page: REPOSITORY_LIMITS.maxSearchResults, page }), first.data.files ?? [], first.data.total_files); return { sha: first.data.sha, message: redact(first.data.commit?.message ?? "").text, ...this.diff(pages.files, pages.total, pages.unknown) }; }
  async readDiff(repository: string, base: string, head: string) { const ctx = await this.inspect(repository), first = await this.octokit.rest.repos.compareCommits({ owner: ctx.owner, repo: ctx.repo, base, head, per_page: REPOSITORY_LIMITS.maxSearchResults, page: 1 }), pages = await this.paginatedFiles(page => this.octokit.rest.repos.compareCommits({ owner: ctx.owner, repo: ctx.repo, base, head, per_page: REPOSITORY_LIMITS.maxSearchResults, page }), first.data.files ?? [], first.data.total_files); return { base, head, ...this.diff(pages.files, pages.total, pages.unknown) }; }
  async context(repository: string, ref?: string): Promise<RepositoryContext> {
    const tree = await this.tree(repository, ref);
    // Reflects every bound that has actually made inspection partial on this reader so far (tree truncation,
    // the files/bytes budgets, and any real read error), not just this call's own tree() result.
    const truncated = tree.truncated || this.limitState.tree || this.limitState.files || this.limitState.bytes || this.readErrors.length > 0;
    return { repository: tree.repository, defaultBranch: tree.defaultBranch, ref: tree.ref, treeEntries: tree.entries.length, filesRead: this.filesRead, bytesRead: this.bytesRead, truncated };
  }

  async audit(repository: string, ref?: string) {
    const tree = await this.tree(repository, ref), categories = new Set<string>(), inspectedFiles: string[] = [], contents = new Map<string, string>();
    const classify = (path: string) => /^package\.json$/.test(path) ? "package" : /(^|\/)(?:index|main|app)\.[^.]+$/.test(path) ? "entry-points" : /(^|\/)(?:config|settings)(\/|\.|$)/i.test(path) ? "config" : /services?\//i.test(path) ? "services" : /orchestration\//i.test(path) ? "orchestration" : /persistence\//i.test(path) ? "persistence" : /skills?\//i.test(path) ? "skills" : /(?:auth|security|secret|permission)/i.test(path) ? "security" : /(?:\.test\.|\.spec\.|\/tests?\/)/i.test(path) ? "tests" : /^\.github\/workflows\//i.test(path) ? "ci" : "";
    const candidates = tree.entries.filter(entry => entry.type === "blob" && this.eligible(entry.path, entry.size) && classify(entry.path)).sort((a, b) => { const priority = (path: string) => path === "package.json" ? 0 : /^\.github\/workflows/.test(path) ? 1 : 2; return priority(a.path) - priority(b.path) || a.path.localeCompare(b.path); });
    for (const entry of candidates) { if (this.filesRead >= REPOSITORY_LIMITS.maxFilesRead) { this.limitState.files = true; break; } try { const file = await this.readFile(repository, entry.path, tree.ref); inspectedFiles.push(entry.path); contents.set(entry.path, file.content); categories.add(classify(entry.path)); } catch (err) { this.recordReadFailure(entry.path, err); /* Coverage reports inaccessible files rather than fabricating findings; limitState/readErrors already recorded why. */ } }
    const findings: AuditFinding[] = [];
    // Requires an unambiguous bypass signal on a specific auth/TLS toggle. A bare `auth = false` (or `auth:
    // false`) is deliberately excluded: "auth" alone is too generic a name to prove a real bypass — see the
    // requireAuth/authenticationEnabled/disableAuth forms below for the unambiguous equivalents that DO count.
    for (const [path, content] of contents) { const dangerous = content.split(/\r?\n/).find(line => /(?:rejectUnauthorized\s*[:=]\s*false|NODE_TLS_REJECT_UNAUTHORIZED\s*=\s*["']?0|(?:disable|skip|bypass)[_-]?auth(?:entication)?\s*[:=]\s*true|require[_-]?auth(?:entication)?\s*[:=]\s*false|authentication[_-]?enabled\s*[:=]\s*false)/i.test(line)); if (dangerous) findings.push({ severity: "HIGH", title: "Dangerous security configuration is enabled", files: [path], evidence: dangerous.trim().slice(0, 240), impact: "Authentication or TLS verification can be bypassed in this configuration.", recommendation: "Remove the bypass and require secure authentication/TLS verification in every environment." }); }
    const packageText = contents.get("package.json"); if (packageText) try { const manifest = JSON.parse(packageText); for (const [field, target] of [["main", manifest.main], ["bin", typeof manifest.bin === "string" ? manifest.bin : undefined]] as const) if (typeof target === "string" && !excluded.test(target) && !tree.entries.some(entry => entry.path === target)) findings.push({ severity: "MEDIUM", title: `Package ${field} target is missing`, files: ["package.json", target], evidence: `package.json declares ${field}=${target}, but that path is absent from the inspected ref tree.`, impact: "Consumers may be unable to start the package from the declared entry point.", recommendation: "Add the target to the ref or update the manifest to an existing generated/source entry point." }); } catch { findings.push({ severity: "HIGH", title: "package.json is not valid JSON", files: ["package.json"], evidence: "JSON.parse failed for the repository package manifest.", impact: "Package tooling and builds cannot reliably read the manifest.", recommendation: "Correct the JSON syntax and validate it in CI." }); }
    const testPaths = tree.entries.filter(entry => /(?:\.test\.|\.spec\.|\/tests?\/)/i.test(entry.path)).map(entry => normalize(entry.path));
    for (const path of inspectedFiles.filter(value => /(?:services?|orchestration|security)\//i.test(value) && !/(?:\.test\.|\.spec\.)/i.test(value))) { const stem = normalize(path).replace(/\.[^.]+$/, "").split("/").at(-1)!; if (!testPaths.some(test => test.includes(stem))) findings.push({ severity: "LOW", title: "No associated test found for an inspected critical module", files: [path], evidence: `No test/spec path containing '${stem}' exists in the bounded ref tree.`, impact: "Regressions in this service, orchestration, or security module may be harder to detect.", recommendation: "Add a focused test for the module or document where its behavior is covered." }); }
    // Truthful limits: `files`/`bytes` reflect what actually stopped inspection (limitState), not a same-value
    // coincidence between counters and their caps, which can under-report when the budget runs out early.
    const limitsReached = { tree: tree.truncated || this.limitState.tree, files: this.limitState.files && candidates.length > inspectedFiles.length, bytes: this.limitState.bytes };
    const inspectionCoverage: { categoriesAvailable: string[]; categoriesInspected: string[]; candidateFiles: number; inspectedFileCount: number } = { categoriesAvailable: [...new Set(candidates.map(entry => classify(entry.path)))], categoriesInspected: [...categories], candidateFiles: candidates.length, inspectedFileCount: inspectedFiles.length };
    const required = ["package", "entry-points", "config", "services", "orchestration", "persistence", "skills", "security", "tests", "ci"].filter(category => inspectionCoverage.categoriesAvailable.includes(category));
    // A real read error must never be silently absorbed into an apparently-complete audit: it forces
    // inspectionSufficient=false exactly like a hit budget/tree limit would.
    const inspectionSufficient = !limitsReached.tree && !limitsReached.files && !limitsReached.bytes && this.readErrors.length === 0 && inspectedFiles.length >= Math.min(6, candidates.length) && required.every(category => categories.has(category)) && required.length >= 4;
    return { repository: tree.repository, ref: tree.ref, findings, inspectionCoverage, inspectedFiles, inaccessibleFiles: this.readErrors.map(e => e.path), readErrors: [...this.readErrors], limitsReached, inspectionSufficient };
  }
}
