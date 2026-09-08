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
  exactContent?: string;
  targetBranch?: string;
  targetPr?: number;
}

export function parseRepoUrl(repoUrlStr?: string): { owner: string; repo: string } | null {
  if (!repoUrlStr || typeof repoUrlStr !== "string") return null;
  const clean = repoUrlStr.trim().replace(/\.git$/, "");
  const matchUrl = clean.match(/github\.com\/([^/]+)\/([^/]+)/i);
  if (matchUrl) return { owner: matchUrl[1], repo: matchUrl[2] };
  const parts = clean.split("/").filter(Boolean);
  if (parts.length === 2 && !clean.includes(":")) {
    return { owner: parts[0], repo: parts[1] };
  }
  return null;
}

function parseTargetMarkers(instructions: string): {
  targetBranch?: string;
  targetPr?: number;
} {
  const branchMatch = instructions.match(/(?:^|\s)TARGET_BRANCH=([^\s]+)/i);
  const prMatch = instructions.match(/(?:^|\s)TARGET_PR=([^\s]+)/i);

  const targetBranch = branchMatch?.[1]?.trim();
  const targetPrValue = prMatch?.[1]?.trim();

  if (targetBranch !== undefined && !targetBranch) {
    throw new Error("TARGET_BRANCH_INVALID: La branche cible est vide.");
  }

  let targetPr: number | undefined;
  if (targetPrValue !== undefined) {
    if (!/^\d+$/.test(targetPrValue)) {
      throw new Error("TARGET_PR_INVALID: Le numéro de Pull Request est invalide.");
    }
    targetPr = Number(targetPrValue);
    if (!Number.isSafeInteger(targetPr) || targetPr <= 0) {
      throw new Error("TARGET_PR_INVALID: Le numéro de Pull Request est invalide.");
    }
  }

  return { targetBranch, targetPr };
}

export function extractTaskParams(taskReq: TaskRequest): ParsedSoftwareTask {
  const ctx = taskReq.context || {};
  const owner = "artisanguillonrenov-creator";
  const repo = "Agent-autonome-socle-";

  let filePath = String(ctx.filePath || ctx.path || ctx.file || "").trim();
  const objectiveStr = String(taskReq.objective || "").trim();
  const instructionsStr = String(ctx.instructions || "").trim();
  const textToSearch = instructionsStr ? `${objectiveStr}\n${instructionsStr}` : objectiveStr;
  const { targetBranch, targetPr } = parseTargetMarkers(instructionsStr);

  if (!filePath) {
    const match =
      textToSearch.match(/(?:fichier|file|path)[:\s]+([a-zA-Z0-9_\-./]+\.[a-zA-Z0-9]+)/i) ||
      textToSearch.match(/([a-zA-Z0-9_\-./]+\/(?:[a-zA-Z0-9_\-./]+\.[a-zA-Z0-9]+))/i) ||
      textToSearch.match(/([a-zA-Z0-9_\-.]+\.(?:ts|js|json|md|html|css|py))/i);
    if (match) filePath = match[1].trim();
  }

  if (!filePath) {
    throw new Error("FILE_PATH_MISSING: Le chemin du fichier (filePath) est obligatoire et introuvable.");
  }

  let exactContent: string | undefined;

  if (typeof ctx.exactContent === "string") {
    exactContent = ctx.exactContent;
  } else {
    const exactDirectiveMatch = textToSearch.match(
      /(?:avec exactement ce contenu|contenu exact|écris exactement|exact content)\s*:\s*([\s\S]+)$/i,
    );

    if (exactDirectiveMatch) {
      const rest = exactDirectiveMatch[1];
      const fenceMatch =
        rest.match(/^```(?:\w+)?\r?\n([\s\S]*?)\r?\n```/i) || rest.match(/^```([\s\S]*?)```/i);

      if (fenceMatch) {
        exactContent = fenceMatch[1];
      } else {
        const lines = rest.split(/\r?\n/);
        const firstNonEmptyLineIndex = lines.findIndex((line) => line.trim() !== "");

        if (firstNonEmptyLineIndex !== -1) {
          const firstContentLine = lines[firstNonEmptyLineIndex].trim();
          const remainingLines = lines
            .slice(firstNonEmptyLineIndex + 1)
            .filter((line) => line.trim() !== "");

          if (remainingLines.length > 0) {
            const operationalIndex = remainingLines.findIndex((line) =>
              /\b(?:crée|ouvre|branche|pull request|pr|fusionne|dédiée)\b/i.test(line),
            );

            if (operationalIndex === 0) {
              exactContent = firstContentLine;
            } else if (operationalIndex > 0) {
              throw new Error(
                "EXACT_CONTENT_AMBIGUOUS: Les limites du contenu exact ne peuvent pas être déterminées de manière non ambiguë sans code fences (```) ou context.exactContent.",
              );
            } else {
              exactContent = [firstContentLine, ...remainingLines].join("\n");
            }
          } else {
            exactContent = firstContentLine;
          }
        }
      }
    }
  }

  const instructions = (
    instructionsStr ||
    objectiveStr ||
    "Mettre à jour le code selon la spécification"
  ).trim();

  return {
    owner,
    repo,
    filePath,
    instructions,
    exactContent,
    targetBranch,
    targetPr,
  };
}

export class SoftwareFactoryService {
  private octokit: Octokit;
  private openrouterApiKey: string;
  private openrouterModel: string;
  private githubToken: string;
  public readonly maxRetries: number;

  constructor(configObj: SoftwareFactoryConfig = {}) {
    this.githubToken =
      process.env.GITHUB_FACTORY_TOKEN ||
      configObj.githubToken ||
      process.env.GITHUB_TOKEN ||
      "";
    this.octokit =
      configObj.octokitClient || new Octokit({ auth: this.githubToken || undefined });
    this.openrouterApiKey =
      configObj.openrouterApiKey || process.env.OPENROUTER_API_KEY || "";
    this.openrouterModel =
      configObj.openrouterModel ||
      process.env.SOFTWARE_FACTORY_MODEL ||
      "google/gemini-2.0-flash-lite-preview-02-05:free";
    this.maxRetries = configObj.maxRetries ?? 3;
  }

  getOctokit(): Octokit {
    return this.octokit;
  }

  async getGitHubDiagnostics(): Promise<{
    configured: boolean;
    authenticated: boolean;
    repositoryAccessible: boolean;
  }> {
    const configured = Boolean(this.githubToken);
    if (!configured) {
      return {
        configured: false,
        authenticated: false,
        repositoryAccessible: false,
      };
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
      return {
        configured: true,
        authenticated: false,
        repositoryAccessible: false,
      };
    }
  }

  async generateCodeUpdate(
    existingContent: string,
    filePath: string,
    instructions: string,
  ): Promise<string> {
    if (!this.openrouterApiKey) {
      throw new Error(
        "LLM_NOT_CONFIGURED: Variable OPENROUTER_API_KEY manquante pour la Software Factory.",
      );
    }

    const freeModels = [
      this.openrouterModel,
      "google/gemini-2.0-flash-lite-preview-02-05:free",
      "meta-llama/llama-3.3-70b-instruct:free",
      "openrouter/auto",
    ].filter((value, index, values) => value && values.indexOf(value) === index);

    let lastError: Error | null = null;

    for (const model of freeModels) {
      try {
        const response = await fetch(
          "https://openrouter.ai/api/v1/chat/completions",
          {
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
          },
        );

        if (!response.ok) {
          throw new Error(`OpenRouter HTTP ${response.status}: ${await response.text()}`);
        }

        const data = (await response.json()) as {
          choices?: Array<{ message?: { content?: string } }>;
        };
        const rawOutput = data.choices?.[0]?.message?.content?.trim();

        if (!rawOutput) continue;

        let cleanCode = rawOutput;
        const codeBlockMatch = rawOutput.match(
          /```(?:[a-z0-9_-]+)?\n([\s\S]*?)\n```/i,
        );
        if (codeBlockMatch?.[1]) cleanCode = codeBlockMatch[1].trim();

        if (!cleanCode.trim()) {
          throw new Error("NO_CHANGES_GENERATED: Le code généré est vide.");
        }

        if (existingContent && existingContent.trim() === cleanCode.trim()) {
          throw new Error(
            "NO_CHANGES_GENERATED: Le code généré est identique au contenu existant.",
          );
        }

        return cleanCode;
      } catch (error: unknown) {
        lastError = error instanceof Error ? error : new Error(String(error));
      }
    }

    throw new Error(
      `CODE_GENERATION_FAILED: ${
        lastError?.message || "Échec de génération de code via OpenRouter"
      }`,
    );
  }

  async executeWorkflow(
    params: ParsedSoftwareTask,
    taskId: string,
    onStep?: (stage: string, detail?: Record<string, unknown>) => void,
  ): Promise<{
    branch: string;
    commitSha: string;
    prUrl: string;
    prNumber: number;
    summary: string;
  }> {
    const { owner, repo, filePath, instructions } = params;
    const cleanTaskId = taskId.replace(/^task-/, "");
    const generatedBranch = `jarvis/task-${cleanTaskId}`;

    if (
      !this.githubToken &&
      !process.env.GITHUB_FACTORY_TOKEN &&
      !process.env.GITHUB_TOKEN
    ) {
      throw new Error(
        "GITHUB_TOKEN_MISSING: Aucun jeton GitHub (GITHUB_FACTORY_TOKEN) n'est configuré.",
      );
    }

    onStep?.("GITHUB_AUTHENTICATING", { owner, repo });
    const repoInfo = await this.octokit.rest.repos.get({ owner, repo });
    const defaultBranch = repoInfo.data.default_branch || "main";
    onStep?.("GITHUB_AUTHENTICATED", { owner, repo, defaultBranch });

    let targetPrData:
      | {
          number: number;
          html_url: string;
          head: { ref: string; repo?: { full_name?: string | null } | null };
          base: { ref: string };
          state: string;
        }
      | undefined;

    if (params.targetPr !== undefined) {
      onStep?.("GITHUB_VALIDATING_TARGET_PR", {
        prNumber: params.targetPr,
      });

      let pullRequest;
      try {
        pullRequest = await this.octokit.rest.pulls.get({
          owner,
          repo,
          pull_number: params.targetPr,
        });
      } catch (error: unknown) {
        const message = error instanceof Error ? error.message : String(error);
        throw new Error(
          `TARGET_PR_INVALID: Impossible de récupérer la Pull Request #${params.targetPr}: ${message}`,
        );
      }

      const pr = pullRequest.data;
      if (pr.state !== "open") {
        throw new Error(
          `TARGET_PR_INVALID: La Pull Request #${params.targetPr} n'est pas ouverte.`,
        );
      }

      if (!pr.head?.ref) {
        throw new Error(
          `TARGET_PR_INVALID: La Pull Request #${params.targetPr} ne possède pas de branche source valide.`,
        );
      }

      const headRepository = pr.head.repo?.full_name;
      const expectedRepository = `${owner}/${repo}`;
      if (headRepository && headRepository !== expectedRepository) {
        throw new Error(
          `TARGET_PR_INVALID: La Pull Request #${params.targetPr} ne cible pas le dépôt ${expectedRepository}.`,
        );
      }

      if (params.targetBranch && pr.head.ref !== params.targetBranch) {
        throw new Error(
          `TARGET_PR_INVALID: La PR #${params.targetPr} a pour branche source '${pr.head.ref}', mais TARGET_BRANCH=${params.targetBranch}.`,
        );
      }

      targetPrData = {
        number: pr.number,
        html_url: pr.html_url,
        head: {
          ref: pr.head.ref,
          repo: pr.head.repo
            ? { full_name: pr.head.repo.full_name }
            : null,
        },
        base: { ref: pr.base.ref },
        state: pr.state,
      };
    }

    const branchName = targetPrData?.head.ref || params.targetBranch || generatedBranch;
    const isTargetBranch = Boolean(params.targetBranch || params.targetPr);

    if (isTargetBranch) {
      onStep?.("GITHUB_VALIDATING_TARGET_BRANCH", { branch: branchName });
      try {
        await this.octokit.rest.git.getRef({
          owner,
          repo,
          ref: `heads/${branchName}`,
        });
      } catch {
        throw new Error(
          `TARGET_BRANCH_INVALID: La branche '${branchName}' n'existe pas dans ${owner}/${repo}.`,
        );
      }
    }

    const baseRef = await this.octokit.rest.git.getRef({
      owner,
      repo,
      ref: `heads/${defaultBranch}`,
    });
    const baseSha = baseRef.data.object.sha;

    let existingContent = "";
    let existingSha: string | undefined;

    try {
      const fileRes = await this.octokit.rest.repos.getContent({
        owner,
        repo,
        path: filePath,
        ref: branchName,
      });

      if ("content" in fileRes.data && typeof fileRes.data.content === "string") {
        existingContent = Buffer.from(fileRes.data.content, "base64").toString("utf-8");
        existingSha = fileRes.data.sha;
      }
    } catch {
      if (isTargetBranch) {
        throw new Error(
          `TARGET_BRANCH_INVALID: Impossible de lire le fichier '${filePath}' sur la branche cible '${branchName}'.`,
        );
      }

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
        existingContent = "";
        existingSha = undefined;
      }
    }

    let updatedCode: string;
    if (typeof params.exactContent === "string") {
      onStep?.("USING_EXACT_CONTENT", { filePath });
      updatedCode = params.exactContent;
    } else {
      onStep?.("GENERATING_CODE_UPDATE", { filePath });
      updatedCode = await this.generateCodeUpdate(existingContent, filePath, instructions);
    }

    if (!isTargetBranch) {
      onStep?.("GITHUB_CREATING_BRANCH", { branch: branchName });
      try {
        await this.octokit.rest.git.getRef({
          owner,
          repo,
          ref: `heads/${branchName}`,
        });
      } catch {
        await this.octokit.rest.git.createRef({
          owner,
          repo,
          ref: `refs/heads/${branchName}`,
          sha: baseSha,
        });
      }
      onStep?.("GITHUB_BRANCH_CREATED", { branch: branchName });
    } else {
      onStep?.("GITHUB_USING_TARGET_BRANCH", { branch: branchName });
    }

    let targetBranchFileSha = existingSha;
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
      if (isTargetBranch && existingContent) {
        throw new Error(
          `TARGET_BRANCH_INVALID: Impossible de déterminer le SHA du fichier '${filePath}' sur '${branchName}'.`,
        );
      }
    }

    onStep?.("GITHUB_UPDATING_FILE", {
      path: filePath,
      branch: branchName,
    });

    const updateRes = await this.octokit.rest.repos.createOrUpdateFileContents({
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

    onStep?.("GITHUB_FILE_UPDATED", {
      path: filePath,
      branch: branchName,
    });

    let commitSha = (updateRes.data as { commit?: { sha?: string } }).commit?.sha;

    if (!commitSha) {
      const refRes = await this.octokit.rest.git.getRef({
        owner,
        repo,
        ref: `heads/${branchName}`,
      });
      commitSha = refRes.data.object?.sha;
    }

    if (!commitSha) {
      throw new Error(
        "GITHUB_COMMIT_SHA_MISSING: Impossible de déterminer le véritable SHA du commit GitHub.",
      );
    }

    const comparisonBase = targetPrData?.base.ref || defaultBranch;
    onStep?.("GITHUB_CHECKING_DIFF", {
      head: branchName,
      base: comparisonBase,
    });

    const compareRes = await this.octokit.rest.repos.compareCommits({
      owner,
      repo,
      base: comparisonBase,
      head: branchName,
    });

    if (!compareRes.data.files || compareRes.data.files.length === 0) {
      throw new Error(
        "NO_GITHUB_DIFF: Aucun diff détecté sur GitHub par rapport à la branche de base.",
      );
    }

    onStep?.("GITHUB_DIFF_VERIFIED", {
      filesCount: compareRes.data.files.length,
    });

    onStep?.("GITHUB_CREATING_PR", {
      head: branchName,
      base: comparisonBase,
    });

    let prUrl = targetPrData?.html_url || "";
    let prNumber = targetPrData?.number || 0;

    if (!targetPrData) {
      const existingPrs = await this.octokit.rest.pulls.list({
        owner,
        repo,
        head: `${owner}:${branchName}`,
        base: defaultBranch,
        state: "open",
      });

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
          body: `## Modifications apportées par Jarvis Software Factory\n\n- **Tâche**: \`${taskId}\`\n- **Fichier**: \`${filePath}\`\n- **Branche**: \`${branchName}\`\n- **Instructions**: ${instructions}\n\n*Généré automatiquement par Jarvis Software Factory.*`,
        });
        prUrl = prRes.data.html_url;
        prNumber = prRes.data.number;
      }
    }

    onStep?.("GITHUB_PR_CREATED", {
      prUrl,
      prNumber,
      branch: branchName,
      reused: Boolean(targetPrData),
    });

    return {
      branch: branchName,
      commitSha,
      prUrl,
      prNumber,
      summary: targetPrData
        ? `Patch appliqué sur la branche cible '${branchName}' et Pull Request #${prNumber} mise à jour (${prUrl}).`
        : `Patch appliqué sur la branche '${branchName}' et Pull Request #${prNumber} ouverte (${prUrl}).`,
    };
  }

  async handleTaskRequest(taskReq: TaskRequest): Promise<ServiceEvent[]> {
    const serviceName = "software_factory";
    const events: ServiceEvent[] = [];
    let sequence = 1;

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
    } catch (error: unknown) {
      const errorMsg = error instanceof Error ? error.message : String(error);
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
        payload: { error: errorMsg, error_code: errorCode },
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
        const result = await this.executeWorkflow(
          params,
          taskReq.task_id,
          (stage, detail) => {
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
          },
        );

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
            status: "COMPLETED",
            task_id: taskReq.task_id,
            trace_id: taskReq.trace_id,
            branch: result.branch,
            commit_sha: result.commitSha,
            pr_number: result.prNumber,
            pr_url: result.prUrl,
            filePath: params.filePath,
            summary: result.summary,
          },
        });

        return events;
      } catch (error: unknown) {
        lastErrorMsg = error instanceof Error ? error.message : String(error);
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
  return req.headers.authorization === `Bearer ${token}`;
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

      this.server.listen(this.port, () => resolve());
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