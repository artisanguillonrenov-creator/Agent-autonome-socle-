import { createServer, type IncomingMessage } from "node:http";
import { Octokit } from "@octokit/rest";
import { CONTRACT_SCHEMA_VERSION, type TaskRequest, type ServiceEvent } from "../orchestration/contract.js";

export interface SoftwareFactoryConfig {
  githubToken?: string;
  octokitClient?: Octokit;
  openrouterApiKey?: string;
  openrouterModel?: string;
  maxRetries?: number;
}

export interface ParsedSoftwareTask {
  owner: string;
  repo: string;
  filePath: string;
  instructions: string;
}

export function parseRepoUrl(repoUrlStr?: string): { owner: string; repo: string } | null {
  if (!repoUrlStr || typeof repoUrlStr !== "string") return null;
  const clean = repoUrlStr.trim().replace(/\.git$/, "");
  const matchUrl = clean.match(/github\.com\/([^/]+)\/([^/]+)/i);
  if (matchUrl) {
    return { owner: matchUrl[1], repo: matchUrl[2] };
  }
  const parts = clean.split("/").filter(Boolean);
  if (parts.length === 2 && !clean.includes(":")) {
    return { owner: parts[0], repo: parts[1] };
  }
  return null;
}

export function extractTaskParams(taskReq: TaskRequest): ParsedSoftwareTask {
  const ctx = taskReq.context || {};

  const rawRepoUrl = String(ctx.repoUrl || ctx.repository || ctx.repo || process.env.GITHUB_REPOSITORY || "");
  const parsedRepo = parseRepoUrl(rawRepoUrl);

  let owner = parsedRepo?.owner || process.env.GITHUB_OWNER;
  let repo = parsedRepo?.repo || process.env.GITHUB_REPO;

  if (!owner || !repo) {
    if (process.env.GITHUB_REPOSITORY) {
      const parts = process.env.GITHUB_REPOSITORY.split("/");
      if (parts.length === 2) {
        owner = owner || parts[0];
        repo = repo || parts[1];
      }
    }
  }

  owner = owner || "owner";
  repo = repo || "repo";

  const filePath = String(ctx.filePath || ctx.path || ctx.file || "src/index.ts").trim();
  const instructions = String(ctx.instructions || taskReq.objective || "Mettre à jour le code selon la spécification").trim();

  return { owner, repo, filePath, instructions };
}

export class SoftwareFactoryService {
  private octokit: Octokit;
  private openrouterApiKey: string;
  private openrouterModel: string;
  public readonly maxRetries: number;

  constructor(config: SoftwareFactoryConfig = {}) {
    const token = process.env.GITHUB_FACTORY_TOKEN || config.githubToken || process.env.GITHUB_TOKEN;
    this.octokit = config.octokitClient || new Octokit({ auth: process.env.GITHUB_FACTORY_TOKEN || token });
    this.openrouterApiKey = config.openrouterApiKey || process.env.OPENROUTER_API_KEY || "";
    this.openrouterModel = config.openrouterModel || process.env.SOFTWARE_FACTORY_MODEL || "google/gemini-2.0-flash-lite-preview-02-05:free";
    this.maxRetries = config.maxRetries ?? 3;
  }

  getOctokit(): Octokit {
    return this.octokit;
  }

  /**
   * Génère la mise à jour de code via OpenRouter (modèles gratuits).
   */
  async generateCodeUpdate(
    existingContent: string,
    filePath: string,
    instructions: string,
  ): Promise<string> {
    if (!this.openrouterApiKey) {
      return (
        existingContent +
        `\n/* Updated by Jarvis Software Factory V1 */\n/* Instructions: ${instructions} */\n`
      );
    }

    const freeModels = [
      this.openrouterModel,
      "google/gemini-2.0-flash-lite-preview-02-05:free",
      "meta-llama/llama-3.3-70b-instruct:free",
      "openrouter/auto",
    ].filter((v, i, a) => v && a.indexOf(v) === i);

    let lastError: Error | null = null;

    for (const model of freeModels) {
      try {
        const res = await fetch("https://openrouter.ai/api/v1/chat/completions", {
          method: "POST",
          headers: {
            "content-type": "application/json",
            authorization: `Bearer ${this.openrouterApiKey}`,
          },
          body: JSON.stringify({
            model,
            messages: [
              {
                role: "system",
                content:
                  "Vous êtes Jarvis Software Factory. Votre rôle est de modifier le code du fichier fourni selon les instructions. Renvoyez UNIQUEMENT le code complet mis à jour sans explications supplémentaires.",
              },
              {
                role: "user",
                content: `Fichier: ${filePath}\n\nContenu actuel:\n\`\`\`\n${existingContent}\n\`\`\`\n\nInstructions:\n${instructions}\n\nCode mis à jour:`,
              },
            ],
            temperature: 0.2,
          }),
        });

        if (!res.ok) {
          throw new Error(`OpenRouter HTTP ${res.status}: ${await res.text()}`);
        }

        const data = (await res.json()) as { choices?: Array<{ message?: { content?: string } }> };
        const rawOutput = data.choices?.[0]?.message?.content?.trim();

        if (rawOutput) {
          const codeBlockMatch = rawOutput.match(/```(?:[a-z0-9_-]+)?\n([\s\S]*?)\n```/i);
          if (codeBlockMatch && codeBlockMatch[1]) {
            return codeBlockMatch[1].trim();
          }
          return rawOutput;
        }
      } catch (err: unknown) {
        lastError = err instanceof Error ? err : new Error(String(err));
      }
    }

    throw lastError || new Error("Échec de génération de code via OpenRouter");
  }

  /**
   * Exécute le workflow GitHub : lire fichier, générer code, brancher patch-jarvis-v1, commit et PR.
   */
  async executeWorkflow(params: ParsedSoftwareTask): Promise<{
    branch: string;
    prUrl: string;
    prNumber: number;
    summary: string;
  }> {
    const { owner, repo, filePath, instructions } = params;
    const branchName = "patch-jarvis-v1";

    const repoInfo = await this.octokit.rest.repos.get({ owner, repo });
    const defaultBranch = repoInfo.data.default_branch || "main";

    const baseRef = await this.octokit.rest.git.getRef({
      owner,
      repo,
      ref: `heads/${defaultBranch}`,
    });
    const baseSha = baseRef.data.object.sha;

    let existingContent = "";
    let existingSha: string | undefined = undefined;

    try {
      const fileRes = await this.octokit.rest.repos.getContent({
        owner,
        repo,
        path: filePath,
        ref: defaultBranch,
      });

      if ("content" in fileRes.data && typeof fileRes.data.content === "string") {
        existingContent = Buffer.from(fileRes.data.content, "base64").toString("utf-8");
        existingSha = fileRes.data.sha;
      }
    } catch {
      // Le fichier peut être nouveau
    }

    const updatedCode = await this.generateCodeUpdate(existingContent, filePath, instructions);

    try {
      await this.octokit.rest.git.getRef({ owner, repo, ref: `heads/${branchName}` });
    } catch {
      await this.octokit.rest.git.createRef({
        owner,
        repo,
        ref: `refs/heads/${branchName}`,
        sha: baseSha,
      });
    }

    let targetBranchFileSha: string | undefined = existingSha;
    try {
      const targetFileRes = await this.octokit.rest.repos.getContent({
        owner,
        repo,
        path: filePath,
        ref: branchName,
      });
      if ("sha" in targetFileRes.data) {
        targetBranchFileSha = targetFileRes.data.sha;
      }
    } catch {
      // Ignorer si pas encore présent sur la branche
    }

    await this.octokit.rest.repos.createOrUpdateFileContents({
      owner,
      repo,
      path: filePath,
      message: `feat(jarvis): update ${filePath} - ${instructions.slice(0, 50)}`,
      content: Buffer.from(updatedCode, "utf-8").toString("base64"),
      branch: branchName,
      sha: targetBranchFileSha,
    });

    const existingPrs = await this.octokit.rest.pulls.list({
      owner,
      repo,
      head: `${owner}:${branchName}`,
      base: defaultBranch,
      state: "open",
    });

    let prUrl = "";
    let prNumber = 0;

    if (existingPrs.data.length > 0) {
      prUrl = existingPrs.data[0].html_url;
      prNumber = existingPrs.data[0].number;
    } else {
      const prRes = await this.octokit.rest.pulls.create({
        owner,
        repo,
        title: `[Jarvis Software Factory] Patch for ${filePath}`,
        head: branchName,
        base: defaultBranch,
        body: `## Modifications apportées par Jarvis Software Factory V1\n\n- **Fichier**: \`${filePath}\`\n- **Instructions**: ${instructions}\n\n*Généré automatiquement par Jarvis Software Factory.*`,
      });
      prUrl = prRes.data.html_url;
      prNumber = prRes.data.number;
    }

    return {
      branch: branchName,
      prUrl,
      prNumber,
      summary: `Patch appliqué sur la branche '${branchName}' et Pull Request #${prNumber} créée (${prUrl}).`,
    };
  }

  /**
   * Traite une demande de tâche selon le contrat Service avec boucle anti-boucle (Max Retries = 3).
   */
  async handleTaskRequest(taskReq: TaskRequest): Promise<ServiceEvent[]> {
    const serviceName = "software_factory";
    const events: ServiceEvent[] = [];

    events.push({
      schema_version: CONTRACT_SCHEMA_VERSION,
      event_id: `evt-${taskReq.task_id}-accepted`,
      task_id: taskReq.task_id,
      trace_id: taskReq.trace_id,
      service: serviceName,
      sequence: 1,
      type: "TASK_ACCEPTED",
      timestamp: Date.now(),
      payload: { message: "Tâche acceptée par Jarvis Software Factory V1" },
    });

    const params = extractTaskParams(taskReq);
    let sequence = 2;
    let lastErrorMsg = "";

    for (let attempt = 1; attempt <= this.maxRetries; attempt++) {
      events.push({
        schema_version: CONTRACT_SCHEMA_VERSION,
        event_id: `evt-${taskReq.task_id}-progress-${attempt}`,
        task_id: taskReq.task_id,
        trace_id: taskReq.trace_id,
        service: serviceName,
        sequence: sequence++,
        type: "TASK_PROGRESS",
        timestamp: Date.now(),
        payload: {
          progress: Math.round((attempt / this.maxRetries) * 80),
          attempt,
          maxRetries: this.maxRetries,
          message: `Tentative ${attempt}/${this.maxRetries} : génération et déploiement du patch pour ${params.filePath}`,
        },
      });

      try {
        const result = await this.executeWorkflow(params);

        events.push({
          schema_version: CONTRACT_SCHEMA_VERSION,
          event_id: `evt-${taskReq.task_id}-completed`,
          task_id: taskReq.task_id,
          trace_id: taskReq.trace_id,
          service: serviceName,
          sequence: sequence++,
          type: "TASK_COMPLETED",
          timestamp: Date.now(),
          payload: {
            status: "ready",
            branch: result.branch,
            pr_url: result.prUrl,
            pr_number: result.prNumber,
            summary: result.summary,
            filePath: params.filePath,
          },
        });

        return events;
      } catch (err: unknown) {
        lastErrorMsg = err instanceof Error ? err.message : String(err);
        events.push({
          schema_version: CONTRACT_SCHEMA_VERSION,
          event_id: `evt-${taskReq.task_id}-retry-${attempt}`,
          task_id: taskReq.task_id,
          trace_id: taskReq.trace_id,
          service: serviceName,
          sequence: sequence++,
          type: "TASK_PROGRESS",
          timestamp: Date.now(),
          payload: {
            attempt,
            maxRetries: this.maxRetries,
            error: `Échec tentative ${attempt}: ${lastErrorMsg}`,
          },
        });
      }
    }

    events.push({
      schema_version: CONTRACT_SCHEMA_VERSION,
      event_id: `evt-${taskReq.task_id}-failed`,
      task_id: taskReq.task_id,
      trace_id: taskReq.trace_id,
      service: serviceName,
      sequence: sequence++,
      type: "TASK_FAILED",
      timestamp: Date.now(),
      payload: {
        error: `Échec définitif après ${this.maxRetries} tentatives : ${lastErrorMsg}`,
        maxRetries: this.maxRetries,
      },
    });

    return events;
  }
}

export class SoftwareFactoryServer {
  private server: ReturnType<typeof createServer> | null = null;
  private processedKeys = new Map<string, ServiceEvent[]>();

  constructor(
    public readonly port: number = 4000,
    public readonly service: SoftwareFactoryService = new SoftwareFactoryService(),
  ) {}

  start(): Promise<void> {
    return new Promise((resolve) => {
      this.server = createServer(async (req, res) => {
        if (req.method === "POST" && req.url === "/tasks") {
          const bodyStr = await this.readBody(req);
          let taskReq: TaskRequest;
          try {
            taskReq = JSON.parse(bodyStr);
          } catch {
            res.writeHead(400, { "content-type": "application/json" });
            res.end(JSON.stringify({ error: "Invalid JSON" }));
            return;
          }

          if (this.processedKeys.has(taskReq.idempotency_key)) {
            const cachedEvents = this.processedKeys.get(taskReq.idempotency_key)!;
            res.writeHead(200, { "content-type": "application/json" });
            res.end(JSON.stringify({ events: cachedEvents }));
            return;
          }

          const events = await this.service.handleTaskRequest(taskReq);
          this.processedKeys.set(taskReq.idempotency_key, events);

          res.writeHead(200, { "content-type": "application/json" });
          res.end(JSON.stringify({ events }));
          return;
        }

        if (req.method === "GET" && req.url === "/health") {
          res.writeHead(200, { "content-type": "application/json" });
          res.end(JSON.stringify({ status: "ok", service: "software_factory" }));
          return;
        }

        res.writeHead(404, { "content-type": "application/json" });
        res.end(JSON.stringify({ error: "Not found" }));
      });

      this.server.listen(this.port, () => {
        resolve();
      });
    });
  }

  stop(): Promise<void> {
    return new Promise((resolve) => {
      if (this.server) {
        this.server.close(() => resolve());
      } else {
        resolve();
      }
    });
  }

  private async readBody(req: IncomingMessage): Promise<string> {
    const chunks: Buffer[] = [];
    for await (const chunk of req) chunks.push(chunk as Buffer);
    return Buffer.concat(chunks).toString("utf-8");
  }
}
