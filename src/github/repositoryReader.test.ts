import test from "node:test";
import assert from "node:assert/strict";
import { GitHubRepositoryReader, REPOSITORY_LIMITS, parseGitHubRepository, resolveSelfRepository } from "./repositoryReader.js";
import { getGitHubToken } from "./auth.js";
import { assertSoftwareFactoryRepositoryAllowed, SoftwareFactoryService } from "../services/softwareFactoryService.js";
import { validateArraySchemaItems } from "../llm/jsonSchema.js";
import { CANONICAL_SKILL_IDS } from "../skills/catalog.js";

type FakeOptions = { refs?: Record<string, Record<string, string>>; codeHits?: Array<string|{path:string;repository:{full_name:string}}>; diffPages?: any[][]; totalFiles?: number };
function fake(defaultFiles: Record<string, string>, options: FakeOptions = {}) {
  const refs = { main: defaultFiles, ...(options.refs ?? {}) };
  const filesAt = (ref = "main") => refs[ref] ?? {};
  const tree = (ref = "main") => Object.entries(filesAt(ref)).map(([path, content]) => ({ path, type: "blob", size: Buffer.byteLength(content), sha: path }));
  const diffResponse = (page = 1) => ({ data: { sha: "abc", commit: { message: "safe" }, files: options.diffPages?.[page - 1] ?? [], ...(options.totalFiles === undefined ? {} : { total_files: options.totalFiles }), total_commits: 1 } });
  return { rest: { repos: { get: async () => ({ data: { default_branch: "main", id: 1 } }), getContent: async ({ path, ref }: any) => { const value = filesAt(ref)[path]; if (value === undefined) throw new Error("404"); return { data: { content: Buffer.from(value).toString("base64"), sha: path } }; }, getCommit: async ({ page }: any) => diffResponse(page) , compareCommits: async ({ page }: any) => diffResponse(page) }, git: { getTree: async ({ tree_sha }: any) => ({ data: { tree: tree(tree_sha), truncated: false } }) }, search: { code: async () => ({ data: { items: (options.codeHits ?? []).map(hit => typeof hit==="string"?{path:hit,repository:{full_name:"acme/repo"}}:hit) } }) }, pulls: { get: async () => ({ data: { number: 1, title: "PR", state: "open", changed_files: options.totalFiles ?? options.diffPages?.[0]?.length ?? 0 } }), listFiles: async () => ({ data: options.diffPages?.[0] ?? [] }) } } };
}

test("repository parsing, self repository and auth authority are strict", () => {
  assert.deepEqual(parseGitHubRepository("https://github.com/acme/demo.git"), { owner: "acme", repo: "demo" });
  assert.throws(() => parseGitHubRepository("github.com/acme/demo/extra"));
  const old = process.env.JARVIS_REPOSITORY; process.env.JARVIS_REPOSITORY = "self/project";
  assert.deepEqual(resolveSelfRepository(undefined, true), { owner: "self", repo: "project" });
  if (old === undefined) delete process.env.JARVIS_REPOSITORY; else process.env.JARVIS_REPOSITORY = old;
  assert.throws(() => resolveSelfRepository(undefined, false), /REPOSITORY_REQUIRED/);
  assert.equal(getGitHubToken({ GITHUB_FACTORY_TOKEN: "factory", GITHUB_TOKEN: "general" } as any), "factory");
});

test("reader rejects secret and binary files", async () => {
  const reader = new GitHubRepositoryReader(fake({ ".env": "TOKEN=secret", "image.png": "x" }));
  await assert.rejects(reader.readFile("acme/repo", ".env"), /SECRET_FILE_BLOCKED/);
  await assert.rejects(reader.readFile("acme/repo", "image.png"), /BINARY_OR_EXCLUDED_FILE/);
});

test("secret and excluded paths are never discoverable",async()=>{const reader=new GitHubRepositoryReader(fake({".env":"env",".env.prod":"env","credentials.json":"credentials","secrets.yaml":"secret","private_key.pem":"key","src/index.ts":"safe"}));for(const query of [".env","credentials","secret","private_key"]){assert.deepEqual((await reader.searchPaths("acme/repo",query)).results,[]);const content=await new GitHubRepositoryReader(fake({".env":"env","credentials.json":"credentials","secrets.yaml":"secret","src/index.ts":"safe"})).searchContent("acme/repo",query);assert.deepEqual(content.matches,[]);assert.deepEqual(content.recommendedFiles,[]);}});

test("structured search ranks exact content and uses robust accent/synonym/word terms", async () => {
  const reader = new GitHubRepositoryReader(fake({ "src/odd.ts": "export const SERVICE_CONNECTION_IN_USE = true", "src/settings.ts": "validation service connection", "README.md": "repository file function settings" }));
  const exact = await reader.searchContent("acme/repo", "service_connection_in_use");
  assert.deepEqual(exact.recommendedFiles[0], { path: "src/odd.ts", source: "bounded-content", score: 100, confidence: "HIGH", matches: ["service_connection_in_use"], evidence: "Matched service_connection_in_use in bounded content." });
  assert.deepEqual(exact.matches, exact.recommendedFiles);
  const words = await new GitHubRepositoryReader(fake({ "src/settings.ts": "validation service connection" })).searchContent("acme/repo", "corrige validation service connection");
  assert.equal(words.recommendedFiles[0].path, "src/settings.ts");
  assert.ok(words.recommendedFiles[0].matches?.includes("validation"));
  const synonyms = await new GitHubRepositoryReader(fake({ "README.md": "repository file function settings" })).searchContent("acme/repo", "dépôt fichier fonction paramètres");
  assert.equal(synonyms.recommendedFiles[0].path, "README.md");
});

test("explicit non-default ref excludes default-branch Code Search hits", async () => {
  const reader = new GitHubRepositoryReader(fake({ "src/old.ts": "UNIQUE_SYMBOL" }, { refs: { feature: { "src/new.ts": "other" } }, codeHits: ["src/old.ts"] }));
  const result = await reader.searchContent("acme/repo", "UNIQUE_SYMBOL", "feature");
  assert.equal(result.matches.some(match => match.path === "src/old.ts"), false);
});

test("Code Search rejects a hit attributed to another repository",async()=>{const result=await new GitHubRepositoryReader(fake({"src/index.ts":"safe"},{codeHits:[{path:"src/index.ts",repository:{full_name:"evil/other"}}]})).searchContent("acme/repo","unmatched-symbol");assert.equal(result.matches.some(match=>match.source==="github-code-search"),false);});

test("Software Factory token precedence keeps explicit token between factory and general",()=>{const oldFactory=process.env.GITHUB_FACTORY_TOKEN,oldGeneral=process.env.GITHUB_TOKEN;delete process.env.GITHUB_FACTORY_TOKEN;process.env.GITHUB_TOKEN="general";assert.equal((new SoftwareFactoryService({githubToken:"explicit"}) as any).githubToken,"explicit");process.env.GITHUB_FACTORY_TOKEN="factory";assert.equal((new SoftwareFactoryService({githubToken:"explicit"}) as any).githubToken,"factory");if(oldFactory===undefined)delete process.env.GITHUB_FACTORY_TOKEN;else process.env.GITHUB_FACTORY_TOKEN=oldFactory;if(oldGeneral===undefined)delete process.env.GITHUB_TOKEN;else process.env.GITHUB_TOKEN=oldGeneral;});

test("bounded real audit reports observed dangerous config, missing tests and manifest inconsistency", async () => {
  const files = { "package.json": JSON.stringify({ main: "src/missing.ts" }), "src/index.ts": "start()", "src/config.ts": "safe=true", "src/services/payment.ts": "export const pay=()=>1", "src/orchestration/router.ts": "export const route=()=>1", "src/persistence/db.ts": "export const db={}", "src/skills/run.ts": "export const run=()=>1", "src/security/auth.ts": "export const auth = false", "src/unrelated.test.ts": "test('x',()=>{})", ".github/workflows/ci.yml": "on: push" };
  const audit = await new GitHubRepositoryReader(fake(files)).audit("acme/repo");
  assert.equal(audit.inspectionSufficient, true);
  assert.ok(audit.inspectionCoverage.categoriesInspected.includes("ci"));
  assert.ok(audit.findings.some(finding => finding.title === "Dangerous security configuration is enabled" && finding.files.includes("src/security/auth.ts")));
  assert.ok(audit.findings.some(finding => finding.title === "No associated test found for an inspected critical module"));
  assert.ok(audit.findings.some(finding => finding.title === "Package main target is missing"));
  for (const finding of audit.findings) for (const key of ["severity", "title", "files", "evidence", "impact", "recommendation"]) assert.ok(key in finding);
});

test("audit explains insufficient coverage instead of using a two-file threshold", async () => {
  const audit = await new GitHubRepositoryReader(fake({ "README.md": "architecture", "package.json": "{}" })).audit("acme/repo");
  assert.equal(audit.inspectionSufficient, false);
  assert.deepEqual(audit.limitsReached, { tree: false, files: false, bytes: false });
});

test("commit/diff pagination is globally truthful and secret-safe", async () => {
  const first = Array.from({ length: REPOSITORY_LIMITS.maxSearchResults }, (_, i) => ({ filename: `src/${i}.ts`, patch: i === 0 ? "+ GITHUB_TOKEN=secret" : "+ let TOKEN: string;" }));
  const second = [{ filename: "src/100.ts", patch: "+ safe" }];
  const reader = new GitHubRepositoryReader(fake({}, { diffPages: [first, second] }));
  for (const result of [await reader.readCommit("acme/repo", "abc"), await reader.readDiff("acme/repo", "a", "b")]) {
    assert.equal(result.truncated, true); assert.equal(result.totalFiles, 101); assert.equal(result.returnedFiles, 100); assert.match(result.files[0].patch!, /REDACTED/);
  }
});

test("recursive schemas, public catalog and factory write allowlist remain protected", async () => {
  validateArraySchemaItems({ type: "object", properties: { nested: { type: "array", items: { type: "string" } } } });
  assert.throws(() => validateArraySchemaItems({ type: "object", properties: { bad: { type: "array" } } }));
  assert.equal(CANONICAL_SKILL_IDS.length, 40);
  assert.throws(() => assertSoftwareFactoryRepositoryAllowed("evil", "repo", { SOFTWARE_FACTORY_ALLOWED_REPOS: "safe/repo" } as any));
  const old = process.env.SOFTWARE_FACTORY_ALLOWED_REPOS; process.env.SOFTWARE_FACTORY_ALLOWED_REPOS = "safe/repo"; let calls = 0;
  const service = new SoftwareFactoryService({ githubToken: "x", octokitClient: { rest: { repos: { get: async () => { calls++; } } } } as any });
  await assert.rejects(service.executeWorkflow({ owner: "evil", repo: "repo", filePath: "x.ts", instructions: "x" }, "task"), /SOFTWARE_FACTORY_REPOSITORY_NOT_ALLOWED/); assert.equal(calls, 0);
  if (old === undefined) delete process.env.SOFTWARE_FACTORY_ALLOWED_REPOS; else process.env.SOFTWARE_FACTORY_ALLOWED_REPOS = old;
});
