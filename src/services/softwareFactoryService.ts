import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { Octokit } from "@octokit/rest";
import { CONTRACT_SCHEMA_VERSION, type TaskRequest, type ServiceEvent } from "../orchestration/contract.js";
import { config, type LLMProviderName } from "../config.js";
import { createLLMProvider } from "../llm/providers/index.js";
import type { LLMProvider } from "../llm/provider.js";
import type { ChatMessage } from "../types.js";
import { isForbiddenRepositoryPath, parseGitHubRepository } from "../github/repositoryReader.js";

export interface SoftwareFactoryConfig {
  githubToken?: string;
  octokitClient?: Octokit;
  /** Fournisseur LLM déjà instancié (essentiellement pour les tests). */
  llmProvider?: LLMProvider;
  /** Provider/modèle explicites de la Software Factory, indépendants de Jarvis (config.llm.*). */
  softwareFactoryProvider?: LLMProviderName;
  softwareFactoryModel?: string;
  softwareFactoryMaxTokens?: number;
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

/**
 * Delegates to the single canonical GitHub repository parser (`parseGitHubRepository`) so the Software
 * Factory never validates repository references against a more permissive rule set than RepositoryReader
 * or the software_development skill. Returns null (rather than throwing) for callers that treat "no
 * repository" and "invalid repository" the same way; extractTaskParams below does not use this shortcut
 * because it must fail closed on an explicitly-provided but invalid repository.
 */
export function parseRepoUrl(repoUrlStr?: string): { owner: string; repo: string } | null {
  if (!repoUrlStr || typeof repoUrlStr !== "string") return null;
  try {
    return parseGitHubRepository(repoUrlStr);
  } catch {
    return null;
  }
}

export function softwareFactoryAllowedRepositories(env: NodeJS.ProcessEnv = process.env): Set<string> {
  return new Set((env.SOFTWARE_FACTORY_ALLOWED_REPOS || "artisanguillonrenov-creator/Agent-autonome-socle-").split(",").map(v=>v.trim().replace(/^https?:\/\/github\.com\//i,"").replace(/\.git$/i,"").toLowerCase()).filter(Boolean));
}
export function assertSoftwareFactoryRepositoryAllowed(owner:string,repo:string,env:NodeJS.ProcessEnv=process.env):void {
  if(!softwareFactoryAllowedRepositories(env).has(`${owner}/${repo}`.toLowerCase()))throw new Error("SOFTWARE_FACTORY_REPOSITORY_NOT_ALLOWED");
}

export function extractTaskParams(taskReq: TaskRequest): ParsedSoftwareTask {
  const ctx = taskReq.context || {};

  // ctx.repository ABSENT keeps the historical Jarvis self-repository fallback below.
  // ctx.repository EXPLICITLY PROVIDED but invalid (including an explicit empty string) must never
  // silently fall back to the default repository: it fails closed with REPOSITORY_INVALID instead.
  const repositoryProvided = typeof ctx.repository === "string";
  let owner: string;
  let repo: string;
  if (repositoryProvided) {
    const rawRepository = (ctx.repository as string).trim();
    if (!rawRepository) {
      throw new Error("REPOSITORY_INVALID: Le dépôt fourni est vide.");
    }
    try {
      const parsed = parseGitHubRepository(rawRepository);
      owner = parsed.owner;
      repo = parsed.repo;
    } catch {
      throw new Error("REPOSITORY_INVALID: Le dépôt fourni est invalide.");
    }
  } else {
    owner = "artisanguillonrenov-creator";
    repo = "Agent-autonome-socle-";
  }

  let filePath = String(ctx.filePath || ctx.path || ctx.file || "").trim();
  const objectiveStr = String(taskReq.objective || "").trim();
  const instructionsStr = String(ctx.instructions || "").trim();
  const targetBranchMatch = instructionsStr.match(/^\s*TARGET_BRANCH\s*=\s*(.*?)\s*$/im);
  const targetPrMatch = instructionsStr.match(/^\s*TARGET_PR\s*=\s*(.*?)\s*$/im);
  const targetBranch = targetBranchMatch?.[1]?.trim();
  let targetPr: number | undefined;

  if (targetPrMatch) {
    const rawTargetPr = targetPrMatch[1].trim();
    if (!/^[1-9]\d*$/.test(rawTargetPr)) {
      throw new Error("TARGET_PR_INVALID: TARGET_PR doit être un entier positif valide.");
    }
    targetPr = Number(rawTargetPr);
    if (!Number.isSafeInteger(targetPr)) {
      throw new Error("TARGET_PR_INVALID: TARGET_PR doit être un entier positif valide.");
    }
  }

  if (targetBranchMatch && !targetBranch) {
    throw new Error("TARGET_BRANCH_INVALID: TARGET_BRANCH ne peut pas être vide.");
  }
  const textToSearch = instructionsStr ? `${objectiveStr}\n${instructionsStr}` : objectiveStr;

  if (!filePath) {
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

  let exactContent: string | undefined = undefined;

  if (typeof ctx.exactContent === "string") {
    exactContent = ctx.exactContent;
  } else {
    const exactDirectiveMatch = textToSearch.match(/(?:avec exactement ce contenu|contenu exact|écris exactement|exact content)\s*:\s*([\s\S]+)$/i);

    if (exactDirectiveMatch) {
      const rest = exactDirectiveMatch[1];
      const fenceMatch = rest.match(/^```(?:\w+)?\r?\n([\s\S]*?)\r?\n```/i) || rest.match(/^```([\s\S]*?)```/i);

      if (fenceMatch) {
        exactContent = fenceMatch[1];
      } else {
        const lines = rest.split(/\r?\n/);
        const firstNonEmptyLineIndex = lines.findIndex((l) => l.trim() !== "");
        if (firstNonEmptyLineIndex !== -1) {
          const firstContentLine = lines[firstNonEmptyLineIndex].trim();
          const remainingLines = lines.slice(firstNonEmptyLineIndex + 1).filter((l) => l.trim() !== "");

          if (remainingLines.length > 0) {
            const operationalIndex = remainingLines.findIndex((l) =>
              /\b(?:crée|ouvre|branche|pull request|pr|fusionne|dédiée)\b/i.test(l),
            );
            if (operationalIndex === 0) {
              // Operational instructions start right on the second line
              exactContent = firstContentLine;
            } else if (operationalIndex > 0) {
              // Ambiguous mixture of lines and operational instructions without code fences
              throw new Error("EXACT_CONTENT_AMBIGUOUS: Les limites du contenu exact ne peuvent pas être déterminées de manière non ambiguë sans code fences (```) ou context.exactContent.");
            } else {
              // No operational instructions found in remaining lines: the multiline block is the exact content
              exactContent = [firstContentLine, ...remainingLines].join("\n");
            }
          } else {
            exactContent = firstContentLine;
          }
        }
      }
    }
  }

  const instructions = (instructionsStr || objectiveStr || "Mettre à jour le code selon la spécification").trim();

  return { owner, repo, filePath, instructions, exactContent, targetBranch, targetPr };
}

/**
 * Nettoie la sortie brute d'un LLM avant commit : retire les balises de raisonnement
 * <think>...</think> (modèles "thinking") puis les éventuels blocs de code Markdown ```.
 */
export function cleanLLMCodeOutput(rawOutput: string): string {
  let cleaned = rawOutput.replace(/<think>[\s\S]*?<\/think>/gi, "").trim();

  const codeBlockMatch = cleaned.match(/```(?:[a-z0-9_-]+)?\r?\n([\s\S]*?)\r?\n```/i);
  if (codeBlockMatch && codeBlockMatch[1]) {
    cleaned = codeBlockMatch[1].trim();
  }

  return cleaned.trim();
}

export class SoftwareFactoryService {
  private octokit: Octokit;
  private githubToken: string;
  private llmProvider: LLMProvider;
  private softwareFactoryMaxTokens: number;
  public readonly maxRetries: number;

  constructor(configObj: SoftwareFactoryConfig = {}) {
    this.githubToken = process.env.GITHUB_FACTORY_TOKEN || configObj.githubToken || process.env.GITHUB_TOKEN || "";
    this.octokit = configObj.octokitClient || new Octokit({ auth: this.githubToken || undefined });

    // Provider/modèle explicitement résolus ici : jamais laissés vides, donc createLLMProvider
    // ne retombe jamais sur le provider actif de Jarvis ni sur la sélection persistée
    // (llm_active_model). La Software Factory reste ainsi strictement indépendante.
    const softwareFactoryProvider = configObj.softwareFactoryProvider || config.softwareFactory.provider;
    const softwareFactoryModel = configObj.softwareFactoryModel || config.softwareFactory.model;
    this.softwareFactoryMaxTokens = configObj.softwareFactoryMaxTokens ?? config.softwareFactory.maxTokens;
    this.llmProvider =
      configObj.llmProvider || createLLMProvider({ provider: softwareFactoryProvider, model: softwareFactoryModel });

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
   * Génère la mise à jour de code via le provider LLM de la Software Factory
   * (Infermatic par défaut, config.softwareFactory.*), indépendant du LLM de Jarvis.
   * Échoue explicitement si l'accès au LLM n'est pas disponible ou si la génération
   * échoue, sans jamais retomber silencieusement sur un autre fournisseur.
   */
  async generateCodeUpdate(
    existingContent: string,
    filePath: string,
    instructions: string,
  ): Promise<string> {
    const messages: ChatMessage[] = [
      {
        role: "system",
        content:
          "You are Jarvis Software Factory. Modify the provided file according to the instructions. Return only the complete updated file content, without explanation.",
      },
      {
        role: "user",
        content: `File: ${filePath}\n\nCurrent content:\n\`\`\`\n${existingContent}\n\`\`\`\n\nInstructions:\n${instructions}\n\nUpdated code:`,
      },
    ];

    let rawOutput: string | null;
    try {
      const result = await this.llmProvider.complete(messages, {
        temperature: 0.2,
        maxTokens: this.softwareFactoryMaxTokens,
      });
      rawOutput = result.content?.trim() ?? null;
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : String(err);
      throw new Error(`CODE_GENERATION_FAILED: ${message}`);
    }

    if (!rawOutput) {
      throw new Error("NO_CHANGES_GENERATED: Le code généré est vide.");
    }

    const cleanCode = cleanLLMCodeOutput(rawOutput);

    if (!cleanCode) {
      throw new Error("NO_CHANGES_GENERATED: Le code généré est vide.");
    }

    if (existingContent && existingContent.trim() === cleanCode.trim()) {
      throw new Error("NO_CHANGES_GENERATED: Le code généré est identique au contenu existant.");
    }

    return cleanCode;
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
    commitSha: string;
    prUrl: string;
    prNumber: number;
    summary: string;
  }> {
    const { owner, repo, filePath, instructions, targetBranch, targetPr } = params;
    // Direct-call guard: no GitHub read or write happens before these checks. This is defense in depth,
    // independent of the same guard applied upstream by the software_development skill: even a caller that
    // bypasses the skill (a direct executeWorkflow call, or a future entry point) can never reach repos.get,
    // git.getRef, repos.getContent, createRef, createOrUpdateFileContents or pulls.create for a forbidden path.
    assertSoftwareFactoryRepositoryAllowed(owner,repo);
    if (isForbiddenRepositoryPath(filePath)) throw new Error("SOFTWARE_DEVELOPMENT_TARGET_FORBIDDEN: Le chemin cible est secret, exclu, binaire ou dépasse la profondeur autorisée.");
    const cleanTaskId = taskId.replace(/^task-/, "");
    let branchName = `jarvis/task-${cleanTaskId}`;

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
    const usesExistingTarget = targetPr !== undefined || targetBranch !== undefined;
    let targetBranchHeadBeforeUpdate: string | undefined;

    let targetPullRequest: { number: number; html_url: string } | undefined;
    if (targetPr !== undefined) {
      let pullRequest;
      try {
        pullRequest = await this.octokit.rest.pulls.get({ owner, repo, pull_number: targetPr });
      } catch {
        throw new Error(`TARGET_PR_INVALID: La Pull Request #${targetPr} est introuvable.`);
      }

      const pull = pullRequest.data;
      const expectedFullName = `${owner}/${repo}`.toLowerCase();
      if (
        pull.state !== "open" ||
        !pull.head?.ref ||
        pull.head.repo?.full_name?.toLowerCase() !== expectedFullName ||
        (targetBranch !== undefined && targetBranch !== pull.head.ref)
      ) {
        throw new Error(`TARGET_PR_INVALID: La Pull Request #${targetPr} n'est pas une cible valide pour ce dépôt.`);
      }
      branchName = pull.head.ref;
      targetPullRequest = { number: pull.number, html_url: pull.html_url };
    } else if (targetBranch !== undefined) {
      branchName = targetBranch;
    }

    if (usesExistingTarget && branchName === defaultBranch) {
      throw new Error("TARGET_BRANCH_INVALID: La branche cible ne peut pas être la branche par défaut.");
    }

    if (usesExistingTarget) {
      try {
        const targetBranchRef = await this.octokit.rest.git.getRef({ owner, repo, ref: `heads/${branchName}` });
        targetBranchHeadBeforeUpdate = targetBranchRef.data.object.sha;
      } catch {
        const code = targetPr !== undefined ? "TARGET_PR_INVALID" : "TARGET_BRANCH_INVALID";
        throw new Error(`${code}: La branche cible '${branchName}' est introuvable.`);
      }
    }

    // 3. Lire le fichier courant sur la branche qui sera modifiée.
    let existingContent = "";
    let existingSha: string | undefined = undefined;

    try {
      const fileRes = await this.octokit.rest.repos.getContent({
        owner,
        repo,
        path: filePath,
        ref: usesExistingTarget ? branchName : defaultBranch,
      });

      if ("content" in fileRes.data && typeof fileRes.data.content === "string") {
        existingContent = Buffer.from(fileRes.data.content, "base64").toString("utf-8");
        existingSha = fileRes.data.sha;
      }
    } catch {
      // Fichier nouveau
    }

    // 4. Générer ou utiliser le code exact
    let updatedCode: string;
    if (typeof params.exactContent === "string") {
      onStep?.("USING_EXACT_CONTENT", { filePath });
      updatedCode = params.exactContent;
    } else {
      onStep?.("GENERATING_CODE_UPDATE", { filePath });
      updatedCode = await this.generateCodeUpdate(existingContent, filePath, instructions);
    }

    // 5. Une branche explicitement ciblée doit déjà exister; le mode historique
    // conserve la création de la branche unique par tâche.
    if (!usesExistingTarget) {
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
    }

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
    onStep?.("GITHUB_FILE_UPDATED", { path: filePath, branch: branchName });

    let commitSha = (updateRes.data as { commit?: { sha?: string } }).commit?.sha;

    if (!commitSha) {
      try {
        const refRes = await this.octokit.rest.git.getRef({
          owner,
          repo,
          ref: `heads/${branchName}`,
        });
        const refSha = refRes.data.object?.sha;
        const hasNewTargetHead = Boolean(targetBranchHeadBeforeUpdate) && refSha !== targetBranchHeadBeforeUpdate;
        if (refSha && (usesExistingTarget ? hasNewTargetHead : refSha !== baseSha)) {
          commitSha = refSha;
        }
      } catch {
        // ignore
      }
    }

    if (!commitSha || commitSha === baseSha) {
      throw new Error("GITHUB_COMMIT_SHA_MISSING: Impossible de déterminer le véritable SHA du commit GitHub.");
    }

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
    let prUrl: string;
    let prNumber: number;

    if (targetPullRequest) {
      prUrl = targetPullRequest.html_url;
      prNumber = targetPullRequest.number;
    } else {
      onStep?.("GITHUB_CREATING_PR", { head: branchName, base: defaultBranch });
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
          body: `## Modifications apportées par Jarvis Software Factory\n\n- **Tâche**: \`${taskId}\`\n- **Fichier**: \`${filePath}\`\n- **Instructions**: ${instructions}\n\n*Généré automatiquement par Jarvis Software Factory.*`,
        });
        prUrl = prRes.data.html_url;
        prNumber = prRes.data.number;
      }
    }
    onStep?.("GITHUB_PR_CREATED", { prUrl, prNumber, branch: branchName });

    return {
      branch: branchName,
      commitSha,
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
      // Service entry-point guards, independently repeated by executeWorkflow for fail-fast behaviour.
      assertSoftwareFactoryRepositoryAllowed(params.owner,params.repo);
      if (isForbiddenRepositoryPath(params.filePath)) throw new Error("SOFTWARE_DEVELOPMENT_TARGET_FORBIDDEN: Le chemin cible est secret, exclu, binaire ou dépasse la profondeur autorisée.");
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
  if (!token) return false;
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
        const isPublicHealthcheck = req.method === "GET" && req.url === "/health";
        const serverToken = config.softwareFactory.token || config.api.token;

        if (!isPublicHealthcheck && !serverToken) {
          res.writeHead(503, { "content-type": "application/json" });
          res.end(JSON.stringify({ error: "TOKEN_NOT_CONFIGURED" }));
          return;
        }

        if (!isPublicHealthcheck && !checkServerAuth(req)) {
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
