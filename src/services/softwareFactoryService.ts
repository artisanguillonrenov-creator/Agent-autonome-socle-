import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { Octokit } from "@octokit/rest";
import { CONTRACT_SCHEMA_VERSION, type TaskRequest, type ServiceEvent } from "../orchestration/contract.js";
import { config } from "../config.js";

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

  // Chaînes exactes de notre dépôt sur GitHub (avec le tiret final obligatoire)
  const owner = "artisanguillonrenov-creator";
  const repo = "Agent-autonome-socle-";

  let filePath = String(ctx.filePath || ctx.path || ctx.file || "").trim();

  if (!filePath) {
    const textToSearch = `${taskReq.objective || ""} ${ctx.instructions || ""}`;
    const match =
      textToSearch.match(/(?:fichier|file|path)[:\s]+([a-zA-Z0-9_\-./]+\.[a-zA-Z0-9]+)/i) ||
      textToSearch.match(/([a-zA-Z0-9_\-./]+\/(?:[a-zA-Z0-9_\-./]+\.[a-zA-Z0-9]+))/i) ||
      textToSearch.match(/([a-zA-Z0-9_\-.]+\.(?:ts|js|json|md|html|css|py))/i);
    if (match) {
      filePath = match[1].trim();
    }
  }

  if (!filePath) {
    throw new Error("FILE_PATH_MISSING: Le chemin du fichier (filePath) est obligatoire et introuvable.");
  }

  const instructions = String(ctx.instructions || taskReq.objective || "Mettre à jour le code selon la spécification").trim();

  return { owner, repo, filePath, instructions };
}

export class SoftwareFactoryService {
  private octokit: Octokit;
  private openrouterApiKey: string;
  private openrouterModel: string;
  private githubToken: string;
  public readonly maxRetries: number;

  constructor(configObj: SoftwareFactoryConfig = {}) {
    this.githubToken = process.env.GITHUB_FACTORY_TOKEN || configObj.githubToken || process.env.GITHUB_TOKEN || "";
    this.octokit = configObj.octokitClient || new Octokit({ auth: this.githubToken || undefined });
    this.openrouterApiKey = configObj.openrouterApiKey || process.env.OPENROUTER_API_KEY || "";
    this.openrouterModel = configObj.openrouterModel || process.env.SOFTWARE_FACTORY_MODEL || "google/gemini-2.0-flash-lite-preview-02-05:free";
    this.maxRetries = configObj.maxRetries ?? 3;
  }

  getOctokit(): Octokit {
    return this.octokit;
  }

  /**
   * Diagnostic de l'accès GitHub
   */
  async getGitHubDiagnostics(): Promise<{
    configured: boolean;
    authenticated: boolean;
    repositoryAccessible: boolean;
  }> {
    const configured = Boolean(this.githubToken);
    if (!configured) {
      return { configured: false, authenticated: false, repositoryAccessible: false };
    }

    try {
      const userRes = await this.octokit.rest.users.getAuthenticated();
      const authenticated = Boolean(userRes.data?.login);

      let repositoryAccessible = false;
      try {
        const repoRes = await this.octokit.rest.repos.get({
          owner: "artisanguillonrenov-creator",
          repo: "Agent-autonome-socle-",
        });
        repositoryAccessible = Boolean(repoRes.data?.id);
      } catch {
        repositoryAccessible = false;
      }

      return { configured: true, authenticated, repositoryAccessible };
    } catch {
      return { configured: true, authenticated: false, repositoryAccessible: false };
    }
  }

  /**
   * Génère la mise à jour de code via OpenRouter (modèles gratuits).
   * Échoue explicitement si l'accès au LLM n'est pas disponible sans fabriquer de faux commentaires.
   */
  async generateCodeUpdate(
    existingContent: string,
    filePath: string,
    instructions: string,
  ): Promise<string> {
    if (!this.openrouterApiKey) {
      throw new Error("LLM_NOT_CONFIGURED: Variable OPENROUTER_API_KEY manquante pour la Software Factory.");
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
              "Vous êtes Jarvis Software Factory. Votre rôle est de modifier le code du fichier fourni ou de créer un nouveau fichier selon les instructions. Renvoyez UNIQUEMENT le code complet sans explications supplémentaires.",
              },
              {
                role: "user",
            content: existingContent
              ? `Fichier: ${filePath}\n\nContenu actuel:\n\`\`\`\n${existingContent}\n\`\`\`\n\nInstructions:\n${instructions}\n\nCode mis à jour:`
              : `Nouveau fichier à créer: ${filePath}\n\nInstructions:\n${instructions}\n\nCode du nouveau fichier:`,
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
      let cleanCode = rawOutput;
          const codeBlockMatch = rawOutput.match(/```(?:[a-z0-9_-]+)?\n([\s\S]*?)\n```/i);
          if (codeBlockMatch && codeBlockMatch[1]) {
        cleanCode = codeBlockMatch[1].trim();
          }

      if (!cleanCode.trim()) {
        throw new Error("NO_CHANGES_GENERATED: Le code généré est vide.");
      }

      if (existingContent && existingContent.trim() === cleanCode.trim()) {
        throw new Error("NO_CHANGES_GENERATED: Le code généré est identique au contenu existant.");
      }

      return cleanCode;
        }
      } catch (err: unknown) {
        lastError = err instanceof Error ? err : new Error(String(err));
      }
    }

    throw new Error(`CODE_GENERATION_FAILED: ${lastError?.message || "Échec de génération de code via OpenRouter"}`);
  }

  /**
   * Exécute le workflow GitHub avec branche unique par tâche (`jarvis/task-<task_id>`).
   */
  async executeWorkflow(
    params: ParsedSoftwareTask,
    taskId: string,
    onStep?: (stage: string, detail?: Record<string, unknown>) => void,
  ): Promise<{
    branch: string;
    prUrl: string;
    prNumber: number;
    summary: string;
  }> {
    const { owner, repo, filePath, instructions } = params;
    const cleanTaskId = taskId.replace(/^task-/, "");
    const branchName = `jarvis/task-${cleanTaskId}`;

    if (!this.githubToken && !process.env.GITHUB_FACTORY_TOKEN && !process.env.GITHUB_TOKEN) {
      throw new Error("GITHUB_TOKEN_MISSING: Aucun jeton GitHub (GITHUB_FACTORY_TOKEN) n'est configuré.");
    }

    // 1. Authentification / Vérification du dépôt
    onStep?.("GITHUB_AUTHENTICATING", { owner, repo });
    const repoInfo = await this.octokit.rest.repos.get({ owner, repo });
    const defaultBranch = repoInfo.data.default_branch || "main";
    onStep?.("GITHUB_AUTHENTICATED", { owner, repo, defaultBranch });

    // 2. Récupérer la ref de base
    const baseRef = await this.octokit.rest.git.getRef({
      owner,
      repo,
      ref: `heads/${defaultBranch}`,
    });
    const baseSha = baseRef.data.object.sha;

    // 3. Lire le fichier courant sur la branche par défaut
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
      // Fichier nouveau
    }

    // 4. Générer le code
    onStep?.("GENERATING_CODE_UPDATE", { filePath });
    const updatedCode = await this.generateCodeUpdate(existingContent, filePath, instructions);

    // 5. Créer la branche unique pour cette tâche (vérifier existence d'abord)
    onStep?.("GITHUB_CREATING_BRANCH", { branch: branchName });
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
    onStep?.("GITHUB_BRANCH_CREATED", { branch: branchName });

    // 6. Commiter et pousser le fichier modifié (vérifier SHA existant sur la branche)
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
      // Pas encore présent sur cette branche
    }

    onStep?.("GITHUB_UPDATING_FILE", { path: filePath, branch: branchName });
    await this.octokit.rest.repos.createOrUpdateFileContents({
      owner,
      repo,
      path: filePath,
      message: existingContent
        ? `feat(jarvis): update ${filePath} - ${instructions.slice(0, 50)}`
        : `feat(jarvis): create ${filePath} - ${instructions.slice(0, 50)}`,
      content: Buffer.from(updatedCode, "utf-8").toString("base64"),
      branch: branchName,
      sha: targetBranchFileSha,
    });
    onStep?.("GITHUB_FILE_UPDATED", { path: filePath, branch: branchName });

    // 6b. Vérifier qu'il y a un réel diff sur GitHub avant d'ouvrir la PR
    onStep?.("GITHUB_CHECKING_DIFF", { head: branchName, base: defaultBranch });
    const compareRes = await this.octokit.rest.repos.compareCommits({
      owner,
      repo,
      base: defaultBranch,
      head: branchName,
    });

    if (!compareRes.data.files || compareRes.data.files.length === 0) {
      throw new Error("NO_GITHUB_DIFF: Aucun diff détecté sur GitHub par rapport à la branche de base.");
    }
    onStep?.("GITHUB_DIFF_VERIFIED", { filesCount: compareRes.data.files.length });

    // 7. Créer ou récupérer la PR (vérifier PR existante d'abord)
    onStep?.("GITHUB_CREATING_PR", { head: branchName, base: defaultBranch });
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
        title: `[Jarvis Software Factory] Patch for ${filePath} (${cleanTaskId})`,
        head: branchName,
        base: defaultBranch,
        body: `## Modifications apportées par Jarvis Software Factory\n\n- **Tâche**: \`${taskId}\`\n- **Fichier**: \`${filePath}\`\n- **Instructions**: ${instructions}\n\n*Généré automatiquement par Jarvis Software Factory.*`,
      });
      prUrl = prRes.data.html_url;
      prNumber = prRes.data.number;
    }
    onStep?.("GITHUB_PR_CREATED", { prUrl, prNumber, branch: branchName });

    return {
      branch: branchName,
      prUrl,
      prNumber,
      summary: `Patch appliqué sur la branche unique '${branchName}' et Pull Request #${prNumber} ouverte (${prUrl}).`,
    };
  }

  /**
   * Traite une demande de tâche selon le contrat Service avec événements granulaires et max 3 tentatives.
   */
  async handleTaskRequest(taskReq: TaskRequest): Promise<ServiceEvent[]> {
    const serviceName = "software_factory";
    const events: ServiceEvent[] = [];
    let sequence = 1;

    // 1. TASK_ACCEPTED
    events.push({
      schema_version: CONTRACT_SCHEMA_VERSION,
      event_id: `evt-${taskReq.task_id}-accepted`,
      task_id: taskReq.task_id,
      trace_id: taskReq.trace_id,
      service: serviceName,
      sequence: sequence++,
      type: "TASK_ACCEPTED",
      timestamp: Date.now(),
      payload: { message: "Tâche acceptée par Jarvis Software Factory V1" },
    });

    let params: ParsedSoftwareTask;
    try {
      params = extractTaskParams(taskReq);
    } catch (err: unknown) {
      const errorMsg = err instanceof Error ? err.message : String(err);
      const errorCode = errorMsg.split(":")[0] || "FILE_PATH_MISSING";
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
          error: errorMsg,
          error_code: errorCode,
        },
      });
      return events;
    }

    let lastErrorMsg = "";
    let lastErrorCode = "";

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
          message: `Tentative ${attempt}/${this.maxRetries} : exécution du patch pour ${params.filePath}`,
        },
      });

      try {
        const result = await this.executeWorkflow(params, taskReq.task_id, (stage, detail) => {
          events.push({
            schema_version: CONTRACT_SCHEMA_VERSION,
            event_id: `evt-${taskReq.task_id}-step-${sequence}`,
            task_id: taskReq.task_id,
            trace_id: taskReq.trace_id,
            service: serviceName,
            sequence: sequence++,
            type: "TASK_PROGRESS",
            timestamp: Date.now(),
            payload: { stage, ...(detail || {}) },
          });
        });

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
        lastErrorCode = lastErrorMsg.split(":")[0] || "WORKFLOW_ERROR";

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
            error_code: lastErrorCode,
            error_message: lastErrorMsg,
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
        error_code: lastErrorCode,
        maxRetries: this.maxRetries,
      },
    });

    return events;
  }
}

function checkServerAuth(req: IncomingMessage): boolean {
  const token = config.softwareFactory.token || config.api.token;
  if (!token) return true;
  const auth = req.headers.authorization;
  return auth === `Bearer ${token}`;
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
        if (!checkServerAuth(req) && req.url !== "/health") {
          res.writeHead(401, { "content-type": "application/json" });
          res.end(JSON.stringify({ error: "unauthorized" }));
          return;
        }

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
          const diag = await this.service.getGitHubDiagnostics();
          res.writeHead(200, { "content-type": "application/json" });
          res.end(
            JSON.stringify({
              status: "ok",
              service: "software_factory",
              authenticated: checkServerAuth(req),
              github: diag,
            }),
          );
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
