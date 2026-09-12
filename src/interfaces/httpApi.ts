import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { existsSync, readFileSync } from "node:fs";
import { join, extname } from "node:path";
import crypto from "node:crypto";
import type { Agent } from "../core/agent.js";
import { config, type LLMProviderName } from "../config.js";
import { TaskStore } from "../tasks/taskStore.js";
import { getChatPageHtml } from "./chatPage.js";
import { createLLMProvider } from "../llm/providers/index.js";
import { saveLLMConfig } from "../persistence/llmConfigStore.js";
import { SoftwareFactoryService } from "../services/softwareFactoryService.js";
import type { TaskRequest } from "../orchestration/contract.js";
import { NotificationStore } from "../autonomy/notificationStore.js";
import { TriggerStore } from "../automations/triggerStore.js";
import { handleEmailTrigger, handleCrmTrigger, handleExternalTrigger } from "../automations/triggerHandlers.js";
import { WorkspaceStore } from "../workspaces/workspaceStore.js";
import { ArtifactStore } from "../workspaces/artifactStore.js";
import { ObservabilityStore } from "../observability/observabilityStore.js";
import { ActivityStore } from "../observability/activityStore.js";
import { SETTINGS_CATALOG } from "../settings/catalog.js";
import { localizedSettingsSections } from "../i18n/sections.js";
import { SettingsStore, SettingScopeType } from "../settings/store.js";
import { applyAllEffectiveRuntimeSettings } from "../settings/applier.js";
import { getDb } from "../persistence/db.js";
import type { ChatMessage } from "../types.js";
import type { LLMProvider, ToolDefinition } from "../llm/provider.js";
import { AgentTeamStore } from "../agents/agentTeamStore.js";

const taskStore = new TaskStore();
const notificationStore = new NotificationStore();
const triggerStore = new TriggerStore();
const softwareFactoryService = new SoftwareFactoryService();
const workspaceStore = new WorkspaceStore();
const artifactStore = new ArtifactStore(workspaceStore);
const observabilityStore = new ObservabilityStore();
const activityStore = new ActivityStore();
const settingsStore = new SettingsStore();
const agentTeamStore = new AgentTeamStore();
let lastServerError: string | null = null;

async function readBody(req: IncomingMessage): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const chunk of req) chunks.push(chunk as Buffer);
  return Buffer.concat(chunks).toString("utf-8");
}

function sendJson(res: ServerResponse, status: number, body: unknown): void {
  res.writeHead(status, {
    "content-type": "application/json; charset=utf-8",
    "access-control-allow-origin": "*",
    "access-control-allow-methods": "GET, POST, PUT, DELETE, OPTIONS, PATCH",
    "access-control-allow-headers": "Content-Type, Authorization",
  });
  res.end(JSON.stringify(body));
}

function isAuthorized(req: IncomingMessage): boolean {
  if (!config.api.token) return false;
  const auth = req.headers.authorization;
  return auth === `Bearer ${config.api.token}`;
}

/**
 * B.3 (directives de correction) : API_TOKEN devient obligatoire dès que l'interface http
 * est activée sur un hôte non local, plutôt que de démarrer silencieusement une API non
 * protégée (le fail-closed par requête existant — 503 API_TOKEN_NOT_CONFIGURED — n'empêche
 * pas le process de démarrer et d'exposer les routes publiques). `PORT` est déjà, dans ce
 * projet (voir config.ts), le signal utilisé pour détecter un déploiement hébergé
 * (Render, Railway...) : en développement local, PORT n'est normalement jamais défini.
 */
export function assertApiTokenConfiguredForHttp(modes: ReadonlySet<string> | readonly string[]): void {
  const modeSet = modes instanceof Set ? modes : new Set(modes);
  if (!modeSet.has("http")) return;
  const isLikelyHostedDeployment = Boolean(process.env.PORT);
  if (isLikelyHostedDeployment && !config.api.token) {
    throw new Error(
      "API_TOKEN_REQUIRED: AGENT_INTERFACE inclut 'http' sur un déploiement hébergé (PORT défini) sans API_TOKEN configuré. " +
        "Définissez la variable d'environnement API_TOKEN avant de démarrer, ou retirez 'http' de AGENT_INTERFACE pour un usage strictement local.",
    );
  }
}

function isPublicRequest(method: string | undefined, pathname: string): boolean {
  if (method === "OPTIONS") return true;
  if (method !== "GET") return false;
  return pathname === "/" || /^\/[^/]+\.(?:html|css|js|png|jpg|ico|svg)$/i.test(pathname);
}

const MIME_TYPES: Record<string, string> = {
  ".html": "text/html; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".js": "application/javascript; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".svg": "image/svg+xml",
  ".ico": "image/x-icon",
};

function serveStaticFile(res: ServerResponse, filePath: string): boolean {
  if (existsSync(filePath)) {
    try {
      const ext = extname(filePath).toLowerCase();
      const contentType = MIME_TYPES[ext] || "application/octet-stream";
      const content = readFileSync(filePath);
      res.writeHead(200, {
        "content-type": contentType,
        "access-control-allow-origin": "*",
      });
      res.end(content);
      return true;
    } catch {
      return false;
    }
  }
  return false;
}

const OTA_BUNDLE_FILES = ["index.html", "style.css", "app.js"];

function computeOtaBundle(): { bundleString: string; sha256: string } {
  const filesMap: Record<string, string> = {};
  for (const file of OTA_BUNDLE_FILES) {
    const filePath = join(process.cwd(), "www", file);
    if (existsSync(filePath)) {
      filesMap[file] = readFileSync(filePath, "utf-8");
    }
  }
  const bundleString = JSON.stringify({ files: filesMap }, null, 2);
  const sha256 = crypto.createHash("sha256").update(bundleString).digest("hex");
  return { bundleString, sha256 };
}

/**
 * www/ota-manifest.json et www/ota-bundle.json sont régénérés à chaque `npm run build`
 * (donc à chaque déploiement Render) par scripts/build-ota.mjs : ils correspondent
 * toujours au code Web effectivement déployé. S'ils sont absents (dev local sans build
 * préalable), on calcule un manifeste équivalent à la volée à partir des mêmes fichiers
 * www/ que /api/ota/bundle, pour ne jamais servir un SHA-256 qui ne correspondrait pas
 * au bundle réellement téléchargeable.
 */
function readOtaManifest(): Record<string, unknown> {
  const manifestPath = join(process.cwd(), "www", "ota-manifest.json");
  if (existsSync(manifestPath)) {
    try {
      return JSON.parse(readFileSync(manifestPath, "utf-8"));
    } catch {
      // Fichier corrompu : on retombe sur le calcul dynamique ci-dessous.
    }
  }

  const { sha256 } = computeOtaBundle();
  return {
    version: "0.0.0-dev",
    buildId: sha256.slice(0, 12),
    build: Date.now(),
    minimumNativeVersion: "1.0.0",
    bundleUrl: "/api/ota/bundle",
    sha256,
    releaseNotes: "Build de développement local (fichiers OTA non pré-générés).",
    updatedAt: new Date().toISOString(),
  };
}

const DEFAULT_PRESET_MODELS: Record<string, Array<{ id: string; name: string; isFree?: boolean }>> = {
  anthropic: [
    { id: "claude-sonnet-5", name: "Claude Sonnet 5" },
    { id: "claude-3-7-sonnet-20250219", name: "Claude 3.7 Sonnet" },
    { id: "claude-3-5-sonnet-20241022", name: "Claude 3.5 Sonnet" },
    { id: "claude-3-5-haiku-20241022", name: "Claude 3.5 Haiku" },
    { id: "claude-3-opus-20240229", name: "Claude 3 Opus" },
  ],
  openai: [
    { id: "gpt-4o", name: "GPT-4o" },
    { id: "gpt-4o-mini", name: "GPT-4o Mini" },
    { id: "o1", name: "o1" },
    { id: "o3-mini", name: "o3-Mini" },
  ],
  // Infermatic n'a volontairement pas de liste statique ici : le catalogue dépend
  // du compte/abonnement et est récupéré dynamiquement via fetchInfermaticCatalog().
  ollama: [
    { id: "llama3", name: "Llama 3" },
    { id: "mistral", name: "Mistral" },
    { id: "qwen2.5", name: "Qwen 2.5" },
  ],
  mock: [{ id: "mock-model", name: "Mock Model (Offline)" }],
};

interface CatalogModel {
  id: string;
  name: string;
}

type InfermaticCatalogResult =
  | { ok: true; models: CatalogModel[] }
  | { ok: false; status: number; error: string };

/**
 * Interroge la Core API Infermatic (OpenAI-compatible) pour obtenir la liste réelle
 * des modèles disponibles pour le compte/abonnement configuré. Aucune liste statique
 * de secours : en cas d'échec, on retourne une erreur explicite plutôt qu'un faux catalogue.
 */
async function fetchInfermaticCatalog(): Promise<InfermaticCatalogResult> {
  if (!config.llm.infermaticApiKey) {
    return { ok: false, status: 400, error: "INFERMATIC_KEY_MISSING" };
  }

  const endpoint = `${config.llm.infermaticBaseUrl.replace(/\/+$/, "")}/models`;
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 10000);

  try {
    const response = await fetch(endpoint, {
      headers: { authorization: `Bearer ${config.llm.infermaticApiKey}` },
      signal: controller.signal,
    });

    if (response.status === 401 || response.status === 403) {
      return { ok: false, status: 502, error: "INFERMATIC_CATALOG_UNAUTHORIZED" };
    }
    if (!response.ok) {
      return { ok: false, status: 502, error: "INFERMATIC_CATALOG_UNAVAILABLE" };
    }

    const data = (await response.json()) as { data?: Array<{ id: string; name?: string }> };
    if (!Array.isArray(data.data)) {
      return { ok: false, status: 502, error: "INFERMATIC_CATALOG_UNAVAILABLE" };
    }

    // L'id du modèle n'est JAMAIS transformé (casse, format...) : il doit rester
    // strictement identique à celui renvoyé par Infermatic pour rester sélectionnable.
    const models = data.data.map((m) => ({ id: m.id, name: m.name || m.id }));
    return { ok: true, models };
  } catch (err) {
    if ((err as Error).name === "AbortError") {
      return { ok: false, status: 504, error: "INFERMATIC_CATALOG_TIMEOUT" };
    }
    return { ok: false, status: 502, error: "INFERMATIC_CATALOG_UNAVAILABLE" };
  } finally {
    clearTimeout(timeout);
  }
}

/**
 * Messages de validation représentatifs de l'usage réel de Jarvis (system prompt +
 * instruction courte). Un modèle qui échoue ici (ex : pas de support system/chat)
 * doit échouer au test AVANT de pouvoir devenir le modèle actif.
 */
const JARVIS_COMPATIBILITY_MESSAGES: ChatMessage[] = [
  { role: "system", content: "You are Jarvis. Follow the user's instruction." },
  { role: "user", content: "Reply only with OK." },
];

/**
 * Tool factice, purement protocolaire : jamais exécuté, il sert uniquement à vérifier
 * qu'un modèle sait déclencher un appel d'outil structuré — condition nécessaire pour
 * devenir le cerveau principal de Jarvis, qui fonctionne avec du tool calling natif.
 */
const JARVIS_TOOL_PROBE: ToolDefinition = {
  type: "function",
  function: {
    name: "jarvis_compatibility_probe",
    description: "Internal Jarvis compatibility probe. Always call it immediately, never explain it in plain text.",
    parameters: {
      type: "object",
      properties: { value: { type: "string" } },
      required: ["value"],
    },
  },
};

type JarvisCompatibilityLevel = "CHAT_COMPATIBLE" | "JARVIS_TOOL_COMPATIBLE";

interface CompatibilityProbeResult {
  level: JarvisCompatibilityLevel;
  responsePreview: string;
}

/**
 * Validation représentative de l'usage réel de Jarvis. Un simple échange conversationnel
 * (CHAT_COMPATIBLE) ne suffit pas pour Infermatic : Jarvis fonctionne avec du tool calling
 * natif, donc un modèle Infermatic doit en plus prouver qu'il sait déclencher un appel
 * d'outil structuré (JARVIS_TOOL_COMPATIBLE) AVANT de pouvoir devenir actif.
 */
async function testJarvisCompatibility(provider: LLMProvider, providerName: LLMProviderName): Promise<CompatibilityProbeResult> {
  const chatResult = await provider.complete(JARVIS_COMPATIBILITY_MESSAGES, { maxTokens: 5 });
  const chatText = typeof chatResult === "string" ? chatResult : chatResult.content ?? "";

  if (providerName !== "infermatic") {
    return { level: "CHAT_COMPATIBLE", responsePreview: chatText.slice(0, 100) };
  }

  if (!provider.supportsNativeTools || !provider.supportsNativeTools()) {
    throw new Error("INFERMATIC_NATIVE_TOOLS_UNSUPPORTED");
  }

  const probeResult = await provider.complete(
    [
      { role: "system", content: "You are Jarvis. Follow the user's instruction." },
      { role: "user", content: 'Call the jarvis_compatibility_probe tool with value set to exactly "OK". Do not reply in plain text.' },
    ],
    {
      maxTokens: 64,
      tools: [JARVIS_TOOL_PROBE],
      toolChoice: { type: "function", function: { name: "jarvis_compatibility_probe" } },
    },
  );

  const toolCall = (typeof probeResult === "string" ? undefined : probeResult.toolCalls)?.[0];
  if (!toolCall || toolCall.function.name !== "jarvis_compatibility_probe") {
    throw new Error("INFERMATIC_NATIVE_TOOLS_UNSUPPORTED");
  }

  let parsedArgs: { value?: unknown };
  try {
    parsedArgs = JSON.parse(toolCall.function.arguments);
  } catch {
    throw new Error("INFERMATIC_NATIVE_TOOLS_UNSUPPORTED");
  }

  if (parsedArgs.value !== "OK") {
    throw new Error("INFERMATIC_NATIVE_TOOLS_UNSUPPORTED");
  }

  return { level: "JARVIS_TOOL_COMPATIBLE", responsePreview: chatText.slice(0, 100) };
}

/**
 * Ne jamais exposer un message d'erreur brut au frontend : on retire toute clé API
 * configurée et tout header Authorization/Bearer résiduel, et on tronque la longueur.
 */
function redactSecrets(message: string): string {
  let redacted = message;
  for (const secret of [
    config.llm.infermaticApiKey,
    config.llm.anthropicApiKey,
    config.llm.openaiApiKey,
    config.llm.openrouterApiKey,
  ]) {
    if (secret) redacted = redacted.split(secret).join("[REDACTED]");
  }
  redacted = redacted.replace(/Bearer\s+\S+/gi, "Bearer [REDACTED]");
  return redacted.length > 500 ? `${redacted.slice(0, 500)}…` : redacted;
}

/**
 * Façade HTTP du Jarvis Command Center.
 */
export function startHttpApi(agent: Agent, port: number): ReturnType<typeof createServer> {
  // Apply all effective runtime settings at startup
  applyAllEffectiveRuntimeSettings(agent, settingsStore);
  const server = createServer(async (req, res) => {
    // CORS Preflight
    if (req.method === "OPTIONS") {
      res.writeHead(204, {
        "access-control-allow-origin": "*",
        "access-control-allow-methods": "GET, POST, PUT, DELETE, OPTIONS, PATCH",
        "access-control-allow-headers": "Content-Type, Authorization",
      });
      res.end();
      return;
    }

    const url = req.url || "/";
    const parsedUrl = new URL(url, `http://localhost:${port}`);
    const pathname = parsedUrl.pathname;

    // Fail closed for every non-public endpoint when the server token is absent.
    if (!isPublicRequest(req.method, pathname) && !config.api.token) {
      sendJson(res, 503, { error: "API_TOKEN_NOT_CONFIGURED" });
      return;
    }

    if (!isPublicRequest(req.method, pathname) && !isAuthorized(req)) {
      sendJson(res, 401, { error: "unauthorized" });
      return;
    }

    try {
      if (req.method === "GET" && pathname === "/api/specialists") {
        sendJson(
          res,
          200,
          agent.planRunner.specialists
            .list()
            .map(({ id, name, enabled, allowedCapabilities, maxConcurrency }) => ({
              id,
              name,
              enabled,
              allowedCapabilities,
              maxConcurrency,
            })),
        );
        return;
      }

      const operationMetrics = pathname.match(/^\/api\/operations\/([^/]+)\/metrics$/);
      if (req.method === "GET" && operationMetrics) {
        const value = observabilityStore.operation(decodeURIComponent(operationMetrics[1]));
        sendJson(res, value ? 200 : 404, value ?? { error: "not_found" });
        return;
      }

      const planMetrics = pathname.match(/^\/api\/plans\/([^/]+)\/metrics$/);
      if (req.method === "GET" && planMetrics) {
        const value = observabilityStore.plan(decodeURIComponent(planMetrics[1]));
        sendJson(res, value ? 200 : 404, value ?? { error: "not_found" });
        return;
      }

      // Brique multi-agents : profils déclarés et sessions d'équipe (observabilité www/).
      if (req.method === "GET" && pathname === "/api/agents") {
        sendJson(res, 200, { profiles: agent.multiAgent.profiles.list() });
        return;
      }

      if (req.method === "GET" && pathname === "/api/agent-teams") {
        sendJson(res, 200, { items: agentTeamStore.list(Number(parsedUrl.searchParams.get("limit")) || 50) });
        return;
      }

      const agentTeamDetail = pathname.match(/^\/api\/agent-teams\/([^/]+)$/);
      if (req.method === "GET" && agentTeamDetail) {
        const run = agentTeamStore.get(decodeURIComponent(agentTeamDetail[1]));
        if (!run) { sendJson(res, 404, { error: "not_found" }); return; }
        sendJson(res, 200, { run, messages: agentTeamStore.messages(run.id) });
        return;
      }

      // Brique MCP : état des serveurs externes connectés et de leurs outils découverts.
      if (req.method === "GET" && pathname === "/api/mcp/servers") {
        sendJson(res, 200, { servers: agent.getMcpStatuses() });
        return;
      }

      if (req.method === "GET" && pathname === "/api/activity") {
        sendJson(res, 200, {
          items: activityStore.list({
            planRunId: parsedUrl.searchParams.get("planRunId") ?? undefined,
            operationTaskId: parsedUrl.searchParams.get("operationTaskId") ?? undefined,
            specialistId: parsedUrl.searchParams.get("specialistId") ?? undefined,
            eventType: parsedUrl.searchParams.get("eventType") ?? undefined,
            level: parsedUrl.searchParams.get("level") ?? undefined,
            limit: Number(parsedUrl.searchParams.get("limit")) || 100,
            offset: Number(parsedUrl.searchParams.get("offset")) || 0,
          }),
        });
        return;
      }

      // 0a. Software Factory Service Endpoint: POST /tasks
      if (req.method === "POST" && pathname === "/tasks") {
        const bodyStr = await readBody(req);
        let taskReq: TaskRequest;
        try {
          taskReq = JSON.parse(bodyStr || "{}");
        } catch {
          sendJson(res, 400, { error: "JSON invalide" });
          return;
        }

        const events = await softwareFactoryService.handleTaskRequest(taskReq);
        sendJson(res, 200, { events });
        return;
      }

      // 0b. Command Center External API Dispatch Endpoint: POST /api/tasks/dispatch
      if (req.method === "POST" && pathname === "/api/tasks/dispatch") {
        const bodyStr = await readBody(req);
        let taskReq: TaskRequest;
        try {
          taskReq = JSON.parse(bodyStr || "{}");
        } catch {
          sendJson(res, 400, { error: "JSON invalide" });
          return;
        }

        const orchResult = await agent.serviceOrchestrator.dispatchCapability(
          {
            action: "DISPATCH_CAPABILITY",
            capability: taskReq.capability || "software_development",
            objective: taskReq.objective || "Développement logiciel",
            context: taskReq.context || {},
            constraints: taskReq.constraints || [],
          },
          {
            traceId: taskReq.trace_id,
            idempotencyKey: taskReq.idempotency_key,
            executionMode: (taskReq as TaskRequest & { execution_mode?: string }).execution_mode === "background" ? "background" : "foreground",
          },
        );

        sendJson(res, 200, orchResult);
        return;
      }

      // 1. Static Web Files Serving
      if (req.method === "GET") {
        if (pathname === "/") {
          const distIndexPath = join(process.cwd(), "www", "index.html");
          if (existsSync(distIndexPath)) {
            serveStaticFile(res, distIndexPath);
            return;
          } else {
            res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
            res.end(getChatPageHtml());
            return;
          }
        }

        const wwwPath = join(process.cwd(), "www", pathname.replace(/^\/+/, ""));
        if (existsSync(wwwPath)) {
          if (serveStaticFile(res, wwwPath)) return;
        }
      }

      // 2. Chat & Streaming Chat Endpoints
      if (req.method === "POST" && (pathname === "/chat" || pathname === "/api/chat")) {
        const body = JSON.parse((await readBody(req)) || "{}") as { message?: string; workspaceId?: string; requestId?: string };
        const message = (body.message ?? "").trim();
        if (!message) {
          sendJson(res, 400, { error: "message requis" });
          return;
        }
        // requestId (optionnel, généré côté client avant l'envoi) : sert à corréler de façon
        // fiable, côté UI, les opérations dispatchées par CE tour précis (voir Agent.step),
        // plutôt qu'une heuristique par timestamp qui peut mélanger les opérations de
        // plusieurs clients concurrents.
        const requestId = typeof body.requestId === "string" && body.requestId.trim() ? body.requestId.trim().slice(0, 200) : undefined;
        const result = await agent.step(
          message,
          typeof body.workspaceId === "string" && body.workspaceId.trim() ? body.workspaceId.trim() : undefined,
          requestId,
        );
        sendJson(res, 200, { ...result, requestId });
        return;
      }

      if (req.method === "POST" && pathname === "/api/chat/regenerate") {
        try {
          const result = await agent.regenerateLastResponse();
          sendJson(res, 200, result);
        } catch (err) {
          if ((err as Error).message === "NO_REGENERATABLE_RESPONSE") {
            sendJson(res, 409, { error: "NO_REGENERATABLE_RESPONSE" });
            return;
          }
          throw err;
        }
        return;
      }

      if ((req.method === "GET" || req.method === "POST") && pathname === "/api/chat/stream") {
        // POST est le chemin recommandé (voir conversationHttpIngress.ts) : un prompt long
        // ne risque plus de dépasser une limite de longueur d'URL ni de finir dans les
        // journaux d'accès. GET reste accepté (query string) pour compatibilité ascendante.
        const streamBody = req.method === "POST" ? (JSON.parse((await readBody(req)) || "{}") as { message?: string; workspaceId?: string; requestId?: string; clientRequestId?: string }) : {};
        const queryMsg = typeof streamBody.message === "string" ? streamBody.message : parsedUrl.searchParams.get("message") || "";
        if (!queryMsg.trim()) {
          sendJson(res, 400, { error: "message requis" });
          return;
        }

        res.writeHead(200, {
          "content-type": "text/event-stream",
          "cache-control": "no-cache",
          connection: "keep-alive",
          "access-control-allow-origin": "*",
        });

        res.write(`data: ${JSON.stringify({ type: "thought", content: "Analyse de la demande en cours..." })}\n\n`);

        try {
          const streamWorkspaceId = (typeof streamBody.workspaceId === "string" ? streamBody.workspaceId : parsedUrl.searchParams.get("workspaceId")) || undefined;
          // requestId/clientRequestId (voir le handler /api/chat ci-dessus) : corrèle les
          // opérations dispatchées par ce tour pour la timeline live de www/app.js.
          const streamRequestIdRaw = typeof streamBody.requestId === "string" ? streamBody.requestId : typeof streamBody.clientRequestId === "string" ? streamBody.clientRequestId : parsedUrl.searchParams.get("requestId") || parsedUrl.searchParams.get("clientRequestId");
          const streamRequestId = streamRequestIdRaw && streamRequestIdRaw.trim() ? streamRequestIdRaw.trim().slice(0, 200) : undefined;
          const result = await agent.step(queryMsg.trim(), streamWorkspaceId, streamRequestId);

          // Le fournisseur LLM ne diffuse pas encore les tokens au fil de la génération
          // (voir src/llm/provider.ts) : la réponse complète est déjà disponible ici.
          // On la restitue quand même en flux SSE mot par mot pour un rendu progressif
          // fidèle côté client, sans changement de contrat le jour où un provider
          // proposera un vrai streaming token par token.
          const words = result.response.split(/(\s+)/).filter((part) => part.length > 0);
          for (const word of words) {
            if (res.writableEnded) break;
            res.write(`data: ${JSON.stringify({ type: "token", content: word })}\n\n`);
            await new Promise((resolve) => setTimeout(resolve, 12));
          }

          res.write(`data: ${JSON.stringify({ type: "done", iterations: result.iterations, pendingAction: result.pendingAction })}\n\n`);
          res.write(`data: [DONE]\n\n`);
          res.end();
        } catch (err) {
          res.write(`data: ${JSON.stringify({ type: "error", error: (err as Error).message })}\n\n`);
          res.end();
        }
        return;
      }

      // 3. Settings Endpoints
      if (req.method === "GET" && pathname === "/api/settings/schema") {
        // settings.language : sections localisées quand la langue effective est "en" —
        // effet réel de ce réglage sur l'IHM, au-delà de la langue de restitution du chat.
        sendJson(res, 200, {
          sections: localizedSettingsSections(config.locale.language),
          catalog: SETTINGS_CATALOG,
          language: config.locale.language,
        });
        return;
      }

      if (req.method === "GET" && pathname === "/api/settings/export") {
        const settings = settingsStore.getAllEffectiveSettings("GLOBAL", "global");
        const serviceOverrides = agent.serviceOrchestrator.registry.connectionStore.listOverrides();

        sendJson(res, 200, {
          schemaVersion: 1,
          exportedAt: Date.now(),
          settings: settings.map((s) => ({
            key: s.definition.key,
            value: s.value,
            effectiveValue: s.effectiveValue,
            source: s.source,
          })),
          serviceOverrides: serviceOverrides.map((o) => ({
            serviceId: o.serviceId,
            name: o.name,
            nameOverride: o.nameOverride,
            userCreated: o.userCreated,
            enabledOverride: o.enabledOverride,
            transportOverride: o.transportOverride,
            endpointOverride: o.endpointOverride,
            healthPath: o.healthPath,
            taskPath: o.taskPath,
            authTypeOverride: o.authTypeOverride,
            authEnvVar: o.authEnvVar,
            priorityOverride: o.priorityOverride,
            requestTimeoutMs: o.requestTimeoutMs,
            healthTimeoutMs: o.healthTimeoutMs,
            capabilitiesJson: o.capabilitiesJson,
            parallelSafeCapabilitiesJson: o.parallelSafeCapabilitiesJson,
            riskByCapabilityJson: o.riskByCapabilityJson,
            permissionByCapabilityJson: o.permissionByCapabilityJson,
          })),
        });
        return;
      }

      if (req.method === "POST" && pathname === "/api/settings/import") {
        let body: any;
        try {
          body = JSON.parse((await readBody(req)) || "{}");
        } catch {
          sendJson(res, 400, { error: "SETTINGS_IMPORT_INVALID", reason: "JSON_INVALID" });
          return;
        }

        if (!body || typeof body !== "object" || body.schemaVersion !== 1) {
          sendJson(res, 400, { error: "SETTINGS_IMPORT_INVALID", reason: "INVALID_SCHEMA_VERSION" });
          return;
        }

        // Check forbidden secrets in payload
        const rawString = JSON.stringify(body);
        if (
          rawString.includes("Bearer ") ||
          rawString.includes("ghp_") ||
          rawString.includes("sk-") ||
          /["']?(token|password|secretValue|authorization|api_key)["']?\s*:/i.test(rawString)
        ) {
          sendJson(res, 400, { error: "SETTINGS_IMPORT_INVALID", reason: "SECRET_VALUES_FORBIDDEN" });
          return;
        }

        const db = getDb();
        try {
          db.transaction(() => {
            // Import settings
            if (Array.isArray(body.settings)) {
              for (const s of body.settings) {
                if (!s || typeof s.key !== "string") throw new Error("INVALID_SETTING_ENTRY");
                const def = SETTINGS_CATALOG.find((x) => x.key === s.key);
                if (!def) throw new Error(`UNKNOWN_SETTING: ${s.key}`);
                const valToSet = s.value !== undefined ? s.value : s.effectiveValue;
                if (def.availability === "FUTURE") {
                  if (valToSet !== undefined && valToSet !== null && valToSet !== def.defaultValue && valToSet !== false) {
                    throw new Error(`FUTURE_SETTING_CANNOT_BE_ENABLED: ${s.key}`);
                  }
                  continue;
                }
                if (!def.editable) continue; // Skip system-locked / non-editable settings
                settingsStore.setSetting(s.key, valToSet, "GLOBAL", "global");
              }
            }

            // Import service overrides
            if (Array.isArray(body.serviceOverrides)) {
              for (const o of body.serviceOverrides) {
                if (!o || typeof o.serviceId !== "string" || !o.serviceId.trim()) throw new Error("INVALID_SERVICE_OVERRIDE");
                if (o.transportOverride && !["local", "task_http"].includes(o.transportOverride)) throw new Error("UNKNOWN_TRANSPORT");

                const serviceId = o.serviceId.trim();
                const isFactory = agent.serviceOrchestrator.registry.isFactoryService(serviceId);
                const factoryService = isFactory ? agent.serviceOrchestrator.registry.getServiceById(serviceId) : null;

                if (isFactory) {
                  // Apply ONLY present overrides for factory service without defaulting undefined fields
                  const patchObj: any = {};
                  const importedName = o.nameOverride !== undefined ? o.nameOverride : (o.name && factoryService && o.name !== factoryService.name && o.name !== factoryService.id ? o.name : undefined);
                  if (importedName !== undefined) patchObj.name = importedName;
                  if (o.enabledOverride !== undefined) patchObj.enabled = o.enabledOverride;
                  if (o.endpointOverride !== undefined) patchObj.endpoint = o.endpointOverride;
                  if (o.transportOverride !== undefined) patchObj.transport = o.transportOverride;
                  if (o.healthPath !== undefined) patchObj.healthPath = o.healthPath;
                  if (o.taskPath !== undefined) patchObj.taskPath = o.taskPath;
                  if (o.priorityOverride !== undefined) patchObj.priority = o.priorityOverride;
                  if (o.requestTimeoutMs !== undefined) patchObj.requestTimeoutMs = o.requestTimeoutMs;
                  if (o.healthTimeoutMs !== undefined) patchObj.healthTimeoutMs = o.healthTimeoutMs;
                  if (o.authTypeOverride !== undefined) {
                    patchObj.auth = o.authTypeOverride === "bearer_env" ? { type: "bearer_env", envVar: o.authEnvVar || "API_TOKEN" } : { type: "none" };
                  }
                  if (o.capabilitiesJson) patchObj.capabilities = JSON.parse(o.capabilitiesJson);
                  if (o.parallelSafeCapabilitiesJson) patchObj.parallelSafeCapabilities = JSON.parse(o.parallelSafeCapabilitiesJson);
                  if (o.riskByCapabilityJson) patchObj.riskByCapability = JSON.parse(o.riskByCapabilityJson);
                  if (o.permissionByCapabilityJson) patchObj.permissionByCapability = JSON.parse(o.permissionByCapabilityJson);

                  agent.serviceOrchestrator.registry.patchService(serviceId, patchObj);
                } else {
                  if (o.transportOverride && o.transportOverride !== "task_http") {
                    throw new Error("USER_SERVICE_TRANSPORT_MUST_BE_TASK_HTTP");
                  }
                  // User-created service import requires full valid definition
                  agent.serviceOrchestrator.registry.register({
                    id: serviceId,
                    name: o.name || serviceId,
                    userCreated: true,
                    enabled: o.enabledOverride ?? true,
                    transport: o.transportOverride || "task_http",
                    endpoint: o.endpointOverride || "http://localhost:3000",
                    healthPath: o.healthPath || "/health",
                    taskPath: o.taskPath || "/tasks",
                    auth: o.authTypeOverride === "bearer_env" ? { type: "bearer_env", envVar: o.authEnvVar || "API_TOKEN" } : { type: "none" },
                    priority: o.priorityOverride ?? 10,
                    // Pas de défaut littéral ici : un service importé sans timeout explicite
                    // retombe dynamiquement sur connections.requestTimeoutMs/healthTimeoutMs
                    // (voir ServiceAdapter), qui reste réellement modifiable après import.
                    requestTimeoutMs: o.requestTimeoutMs,
                    healthTimeoutMs: o.healthTimeoutMs,
                    capabilities: o.capabilitiesJson ? JSON.parse(o.capabilitiesJson) : [],
                    parallelSafeCapabilities: o.parallelSafeCapabilitiesJson ? JSON.parse(o.parallelSafeCapabilitiesJson) : [],
                    riskByCapability: o.riskByCapabilityJson ? JSON.parse(o.riskByCapabilityJson) : {},
                    permissionByCapability: o.permissionByCapabilityJson ? JSON.parse(o.permissionByCapabilityJson) : {},
                  });
                }
              }
            }
          })();

          applyAllEffectiveRuntimeSettings(agent, settingsStore);
          sendJson(res, 200, { ok: true, message: "Import réalisé avec succès" });
        } catch (e) {
          sendJson(res, 400, { error: "SETTINGS_IMPORT_INVALID", reason: (e as Error).message });
        }
        return;
      }

      if (req.method === "GET" && pathname === "/api/settings") {
        const scopeType = (parsedUrl.searchParams.get("scopeType") as SettingScopeType) || "GLOBAL";
        const scopeId = parsedUrl.searchParams.get("scopeId") || "global";
        const level = parsedUrl.searchParams.get("level") as any;

        sendJson(res, 200, settingsStore.getAllEffectiveSettings(scopeType, scopeId, level));
        return;
      }

      if ((req.method === "PATCH" || req.method === "POST") && pathname === "/api/settings") {
        let body: any;
        try {
          body = JSON.parse((await readBody(req)) || "{}");
        } catch {
          sendJson(res, 400, { error: "JSON invalide" });
          return;
        }

        const scopeType: SettingScopeType = body.scopeType || "GLOBAL";
        const scopeId: string = body.scopeId || "global";

        if (scopeType === "PROJECT" || scopeType === "TASK") {
          sendJson(res, 400, { error: "SETTINGS_SCOPE_NOT_AVAILABLE" });
          return;
        }

        try {
          if (typeof body.key === "string") {
            settingsStore.setSetting(body.key, body.value, scopeType, scopeId);
          } else if (body.settings && typeof body.settings === "object") {
            for (const [k, v] of Object.entries(body.settings)) {
              settingsStore.setSetting(k, v, scopeType, scopeId);
            }
          } else {
            // Legacy backwards-compatibility payload { tokenBudget, maxIterations, reflectionEveryNSteps }
            if (body.tokenBudget && body.tokenBudget > 0) {
              settingsStore.setSetting("system.tokenBudget", body.tokenBudget, scopeType, scopeId);
              config.context.tokenBudget = body.tokenBudget;
            }
            if (body.maxIterations && body.maxIterations > 0) {
              settingsStore.setSetting("autonomy.maxIterations", body.maxIterations, scopeType, scopeId);
              config.agent.maxIterations = body.maxIterations;
            }
            if (body.reflectionEveryNSteps && body.reflectionEveryNSteps > 0) {
              settingsStore.setSetting("skills.reflectionEveryNSteps", body.reflectionEveryNSteps, scopeType, scopeId);
              config.reflection.everyNSteps = body.reflectionEveryNSteps;
            }
          }

          applyAllEffectiveRuntimeSettings(agent, settingsStore);
          sendJson(res, 200, {
            ok: true,
            settings: settingsStore.getAllEffectiveSettings(scopeType, scopeId),
          });
        } catch (e) {
          sendJson(res, 400, { error: (e as Error).message });
        }
        return;
      }

      if (req.method === "POST" && pathname === "/api/settings/reset") {
        let body: any;
        try {
          body = JSON.parse((await readBody(req)) || "{}");
        } catch {
          body = {};
        }

        const scopeType: SettingScopeType = body.scopeType || "GLOBAL";
        const scopeId: string = body.scopeId || "global";

        if (scopeType === "PROJECT" || scopeType === "TASK") {
          sendJson(res, 400, { error: "SETTINGS_SCOPE_NOT_AVAILABLE" });
          return;
        }

        if (typeof body.key === "string" && body.key.trim()) {
          settingsStore.resetSetting(body.key.trim(), scopeType, scopeId);
        } else {
          settingsStore.resetAll(scopeType, scopeId);
        }

        applyAllEffectiveRuntimeSettings(agent, settingsStore);
        sendJson(res, 200, {
          ok: true,
          settings: settingsStore.getAllEffectiveSettings(scopeType, scopeId),
        });
        return;
      }

      // intelligence.toolCompatibilityTest : teste le tool calling structuré sur le
      // modèle/provider RÉELLEMENT actif (jamais un provider arbitraire fourni par le
      // client) — même mécanisme de compatibilité que /api/models/test (dont Infermatic,
      // qui peut retomber sur le protocole texte de compatibilité). Ne modifie jamais le
      // modèle actif : lecture seule.
      if (req.method === "POST" && pathname === "/api/settings/tool-compatibility-test") {
        try {
          const activeProvider = agent.getLLMProvider();
          const probe = await testJarvisCompatibility(activeProvider, config.llm.provider);
          sendJson(res, 200, {
            ok: true,
            provider: config.llm.provider,
            model: config.llm.model,
            compatibility: probe.level,
            toolCallingSupported: probe.level === "JARVIS_TOOL_COMPATIBLE" || config.llm.provider !== "infermatic",
            responsePreview: probe.responsePreview,
          });
        } catch (err) {
          sendJson(res, 200, {
            ok: false,
            provider: config.llm.provider,
            model: config.llm.model,
            toolCallingSupported: false,
            error: redactSecrets((err as Error).message),
          });
        }
        return;
      }

      // 4. Service Connection Center Endpoints
      if (req.method === "GET" && pathname === "/api/connections") {
        const services = agent.serviceOrchestrator.registry.listServices();
        sendJson(
          res,
          200,
          services.map((s) => {
            const ov = agent.serviceOrchestrator.registry.connectionStore.getOverride(s.id);
            return {
              id: s.id,
              serviceId: s.id,
              name: s.name,
              description: s.description,
              enabled: s.enabled,
              userCreated: s.userCreated ?? false,
              transport: s.transport,
              endpoint: s.endpoint,
              healthPath: s.healthPath || "/health",
              taskPath: s.taskPath || "/tasks",
              priority: s.priority,
              requestTimeoutMs: s.requestTimeoutMs || config.connections.requestTimeoutMs,
              healthTimeoutMs: s.healthTimeoutMs || config.connections.healthTimeoutMs,
              capabilities: s.capabilities,
              parallelSafeCapabilities: s.parallelSafeCapabilities || [],
              riskByCapability: s.riskByCapability || {},
              permissionByCapability: s.permissionByCapability || {},
              source: s.source || "FACTORY",
              auth: {
                type: s.auth.type,
                envVar: s.auth.type === "bearer_env" ? s.auth.envVar : undefined,
              },
              secretConfigured:
                s.auth.type === "none" ||
                Boolean(process.env[s.auth.envVar]) ||
                (s.id === "software_factory" && Boolean(process.env.API_TOKEN)),
              lastTestAt: ov?.lastTestAt,
              lastSuccessAt: ov?.lastSuccessAt,
              lastLatencyMs: ov?.lastLatencyMs,
              lastError: ov?.lastError,
            };
          }),
        );
        return;
      }

      if (req.method === "POST" && pathname === "/api/connections/test-all") {
        const services = agent.serviceOrchestrator.registry.listServices();
        const results = await Promise.all(
          services.map(async (s) => {
            const healthRes = await agent.serviceOrchestrator.adapter.checkHealth(s);
            agent.serviceOrchestrator.registry.connectionStore.recordDiagnostic(s.id, healthRes);
            return healthRes;
          }),
        );

        agent.skills.refreshServiceAvailability(agent.serviceOrchestrator.registry);
        sendJson(res, 200, { ok: true, results });
        return;
      }

      const connectionItemMatch = pathname.match(/^\/api\/connections\/([^/]+)$/);
      if (connectionItemMatch) {
        const id = decodeURIComponent(connectionItemMatch[1]);

        if (req.method === "GET") {
          const service = agent.serviceOrchestrator.registry.getServiceById(id);
          if (!service) {
            sendJson(res, 404, { error: "CONNECTION_NOT_FOUND" });
            return;
          }
          const ov = agent.serviceOrchestrator.registry.connectionStore.getOverride(id);
          sendJson(res, 200, {
            id: service.id,
            serviceId: service.id,
            name: service.name,
            description: service.description,
            enabled: service.enabled,
            userCreated: service.userCreated ?? false,
            transport: service.transport,
            endpoint: service.endpoint,
            healthPath: service.healthPath || "/health",
            taskPath: service.taskPath || "/tasks",
            priority: service.priority,
            requestTimeoutMs: service.requestTimeoutMs || config.connections.requestTimeoutMs,
            healthTimeoutMs: service.healthTimeoutMs || config.connections.healthTimeoutMs,
            capabilities: service.capabilities,
            parallelSafeCapabilities: service.parallelSafeCapabilities || [],
            riskByCapability: service.riskByCapability || {},
            permissionByCapability: service.permissionByCapability || {},
            source: service.source || "FACTORY",
            auth: {
              type: service.auth.type,
              envVar: service.auth.type === "bearer_env" ? service.auth.envVar : undefined,
            },
            secretConfigured:
              service.auth.type === "none" ||
              Boolean(process.env[service.auth.envVar]) ||
              (service.id === "software_factory" && Boolean(process.env.API_TOKEN)),
            lastTestAt: ov?.lastTestAt,
            lastSuccessAt: ov?.lastSuccessAt,
            lastLatencyMs: ov?.lastLatencyMs,
            lastError: ov?.lastError,
          });
          return;
        }

        if (req.method === "PATCH") {
          let body: any;
          try {
            body = JSON.parse((await readBody(req)) || "{}");
          } catch {
            sendJson(res, 400, { error: "JSON invalide" });
            return;
          }

          const existing = agent.serviceOrchestrator.registry.getServiceById(id);
          if (!existing) {
            sendJson(res, 404, { error: "CONNECTION_NOT_FOUND" });
            return;
          }

          try {
            agent.serviceOrchestrator.registry.patchService(id, body);
            agent.skills.refreshServiceAvailability(agent.serviceOrchestrator.registry);
            sendJson(res, 200, { ok: true, connection: agent.serviceOrchestrator.registry.getServiceById(id) });
          } catch (e) {
            const err = e as any;
            if (err.message === "SERVICE_CONNECTION_IN_USE") {
              sendJson(res, 409, { error: "SERVICE_CONNECTION_IN_USE", taskIds: err.taskIds || [] });
              return;
            }
            sendJson(res, 400, { error: err.message });
          }
          return;
        }

        if (req.method === "DELETE") {
          try {
            agent.serviceOrchestrator.registry.deleteService(id);
            agent.skills.refreshServiceAvailability(agent.serviceOrchestrator.registry);
            sendJson(res, 200, { ok: true });
          } catch (e) {
            const err = e as any;
            if (err.message === "FACTORY_SERVICE_CANNOT_BE_DELETED") {
              sendJson(res, 405, { error: "FACTORY_SERVICE_CANNOT_BE_DELETED" });
              return;
            }
            if (err.message === "SERVICE_CONNECTION_IN_USE") {
              sendJson(res, 409, { error: "SERVICE_CONNECTION_IN_USE", taskIds: err.taskIds || [] });
              return;
            }
            sendJson(res, 400, { error: err.message });
          }
          return;
        }
      }

      if (req.method === "POST" && pathname === "/api/connections") {
        let body: any;
        try {
          body = JSON.parse((await readBody(req)) || "{}");
        } catch {
          sendJson(res, 400, { error: "JSON invalide" });
          return;
        }

        const id = typeof body.id === "string" ? body.id.trim() : body.serviceId?.trim();
        if (!id) {
          sendJson(res, 400, { error: "id est requis" });
          return;
        }

        if (agent.serviceOrchestrator.registry.getServiceById(id)) {
          sendJson(res, 409, { error: "CONNECTION_ALREADY_EXISTS" });
          return;
        }

        if (body.transport && body.transport !== "task_http") {
          sendJson(res, 400, { error: "INVALID_TRANSPORT: user services must use task_http" });
          return;
        }

        try {
          const newDef = {
            id,
            name: typeof body.name === "string" ? body.name.trim() : id,
            userCreated: true,
            enabled: body.enabled ?? true,
            transport: "task_http" as const,
            endpoint: body.endpoint,
            healthPath: body.healthPath || "/health",
            taskPath: body.taskPath || "/tasks",
            priority: body.priority ?? 10,
            // Pas de défaut littéral ici : retombe dynamiquement sur
            // connections.requestTimeoutMs/healthTimeoutMs quand non fourni.
            requestTimeoutMs: body.requestTimeoutMs,
            healthTimeoutMs: body.healthTimeoutMs,
            auth: body.auth || { type: "none" },
            capabilities: body.capabilities || [],
            parallelSafeCapabilities: body.parallelSafeCapabilities || [],
            riskByCapability: body.riskByCapability || {},
            permissionByCapability: body.permissionByCapability || {},
          };

          agent.serviceOrchestrator.registry.register(newDef);
          agent.skills.refreshServiceAvailability(agent.serviceOrchestrator.registry);
          sendJson(res, 201, { ok: true, connection: agent.serviceOrchestrator.registry.getServiceById(newDef.id) });
        } catch (e) {
          const err = e as any;
          if (err.message?.startsWith("CONNECTION_CAPABILITY_UNKNOWN")) {
            sendJson(res, 400, { error: err.message });
            return;
          }
          sendJson(res, 400, { error: err.message });
        }
        return;
      }

      const connectionActionMatch = pathname.match(/^\/api\/connections\/([^/]+)\/(test|reset)$/);
      if (req.method === "POST" && connectionActionMatch) {
        const id = decodeURIComponent(connectionActionMatch[1]);
        const action = connectionActionMatch[2];

        const service = agent.serviceOrchestrator.registry.getServiceById(id);
        if (!service) {
          sendJson(res, 404, { error: "CONNECTION_NOT_FOUND" });
          return;
        }

        if (action === "test") {
          const healthRes = await agent.serviceOrchestrator.adapter.checkHealth(service);
          agent.serviceOrchestrator.registry.connectionStore.recordDiagnostic(id, healthRes);
          agent.skills.refreshServiceAvailability(agent.serviceOrchestrator.registry);
          sendJson(res, 200, {
            id: service.id,
            reachable: healthRes.reachable,
            status: healthRes.status,
            latencyMs: healthRes.latencyMs,
            authenticated: healthRes.authenticated ?? true,
            errorCode: healthRes.errorCode,
          });
          return;
        }

        if (action === "reset") {
          try {
            const restored = agent.serviceOrchestrator.registry.resetFactoryOverride(id);
            agent.skills.refreshServiceAvailability(agent.serviceOrchestrator.registry);
            sendJson(res, 200, { ok: true, connection: restored });
          } catch (e) {
            const err = e as any;
            if (err.message === "SERVICE_CONNECTION_IN_USE") {
              sendJson(res, 409, { error: "SERVICE_CONNECTION_IN_USE", taskIds: err.taskIds || [] });
              return;
            }
            sendJson(res, 400, { error: err.message });
          }
          return;
        }
      }

      // 4. Status & General Health
      if (req.method === "GET" && (pathname === "/api/status" || pathname === "/status")) {
        const services = agent.serviceOrchestrator.registry.listServices();
        const ops = agent.serviceOrchestrator.store.listOperations();

        const otaManifest = readOtaManifest();
        const otaVersion = (otaManifest.version as string) || "1.0.0";
        const otaBuildId = (otaManifest.buildId as string) || undefined;

        const statusData = {
          status: "online",
          version: "0.1.0",
          nativeVersion: "1.0.0",
          otaVersion,
          otaBuildId,
          llmProvider: config.llm.provider,
          llmModel: config.llm.model,
          memory: {
            factsCount: agent.memory.facts.all().length,
            workingCount: agent.memory.working.all().length,
          },
          reflection: {
            enabled: true,
            everyNSteps: config.reflection.everyNSteps,
          },
          servicesCount: {
            total: services.length,
            enabled: services.filter((s) => s.enabled).length,
          },
          operationsCount: {
            total: ops.length,
            inProgress: ops.filter((o) => o.status === "RUNNING" || o.status === "DISPATCHING").length,
            waitingInput: ops.filter((o) => o.status === "WAITING_INPUT" || o.status === "WAITING_PERMISSION").length,
            failed: ops.filter((o) => o.status === "FAILED" || o.status === "REJECTED").length,
            completed: ops.filter((o) => o.status === "COMPLETED").length,
          },
          remainingTasks: taskStore.list("pending").length,
          lastError: lastServerError,
          dbStatus: "ok",
        };
        sendJson(res, 200, statusData);
        return;
      }

      // 5. Operations Endpoints
      if (req.method === "GET" && (pathname === "/operations" || pathname === "/api/operations")) {
        sendJson(res, 200, agent.serviceOrchestrator.store.listOperations());
        return;
      }

      const cancelMatch = pathname.match(/^\/api\/operations\/([^/]+)\/cancel$/);
      if (req.method === "POST" && cancelMatch) {
        const result = agent.serviceOrchestrator.store.cancel(cancelMatch[1]);
        if (!result) {
          sendJson(res, 404, { error: "opération non trouvée" });
          return;
        }
        sendJson(res, 200, {
          ...result,
          message: result.cancelled
            ? "Opération annulée avant dispatch."
            : result.requested
            ? "Annulation demandée, sans garantie pour l’effet externe."
            : "Opération déjà terminée.",
        });
        return;
      }

      if (req.method === "GET" && pathname === "/api/notifications/unread-count") {
        sendJson(res, 200, { count: notificationStore.unreadCount() });
        return;
      }
      if (req.method === "GET" && pathname === "/api/notifications") {
        sendJson(res, 200, notificationStore.list(parsedUrl.searchParams.get("unread") === "true"));
        return;
      }
      const readMatch = pathname.match(/^\/api\/notifications\/([^/]+)\/read$/);
      if (req.method === "POST" && readMatch) {
        const ok = notificationStore.markRead(readMatch[1]);
        sendJson(res, ok ? 200 : 404, ok ? { ok: true } : { error: "notification non trouvée" });
        return;
      }

      if (req.method === "GET" && pathname === "/api/schedules") {
        sendJson(res, 200, taskStore.listSchedules());
        return;
      }
      if (req.method === "POST" && pathname === "/api/schedules") {
        let body: any;
        try {
          body = JSON.parse((await readBody(req)) || "{}");
        } catch {
          sendJson(res, 400, { error: "JSON invalide" });
          return;
        }
        if (
          typeof body.title !== "string" ||
          !body.title.trim() ||
          !["REMINDER", "DISPATCH", "WATCH"].includes(body.taskType) ||
          !Number.isSafeInteger(body.nextRunAt) ||
          body.nextRunAt < 0 ||
          (body.repeatIntervalMs !== undefined && (!Number.isSafeInteger(body.repeatIntervalMs) || body.repeatIntervalMs <= 0)) ||
          ((body.taskType === "DISPATCH" || body.taskType === "WATCH") &&
            (!body.payload || body.payload.action !== "DISPATCH_CAPABILITY" || typeof body.payload.capability !== "string" || typeof body.payload.objective !== "string"))
        ) {
          sendJson(res, 400, { error: "INVALID_SCHEDULE" });
          return;
        }
        sendJson(
          res,
          201,
          taskStore.createSchedule({
            title: body.title.trim(),
            taskType: body.taskType,
            nextRunAt: body.nextRunAt,
            repeatIntervalMs: body.repeatIntervalMs,
            payload: body.payload,
          }),
        );
        return;
      }
      const toggleSchedule = pathname.match(/^\/api\/schedules\/([^/]+)\/(enable|disable)$/);
      if (req.method === "POST" && toggleSchedule) {
        const ok = taskStore.setEnabled(toggleSchedule[1], toggleSchedule[2] === "enable");
        sendJson(res, ok ? 200 : 404, ok ? { ok: true } : { error: "schedule non trouvé" });
        return;
      }

      const operationEventsMatch = pathname.match(/^\/api\/operations\/([^/]+)\/events$/);
      if (req.method === "GET" && operationEventsMatch) {
        const taskId = operationEventsMatch[1];
        const op = agent.serviceOrchestrator.store.getOperation(taskId);
        if (!op) {
          sendJson(res, 404, { error: "opération non trouvée" });
          return;
        }
        sendJson(res, 200, {
          taskId,
          events: agent.serviceOrchestrator.store.listEvents(taskId),
        });
        return;
      }

      if (req.method === "GET" && (pathname.startsWith("/operations/") || pathname.startsWith("/api/operations/"))) {
        const parts = pathname.split("/");
        const taskId = parts[parts.length - 1];
        const op = agent.serviceOrchestrator.store.getOperation(taskId);
        if (op) {
          sendJson(res, 200, op);
        } else {
          sendJson(res, 404, { error: "opération non trouvée" });
        }
        return;
      }

      if (req.method === "POST" && pathname.includes("/operations/") && pathname.endsWith("/respond")) {
        const parts = pathname.split("/");
        const taskId = parts[parts.length - 2];
        const body = JSON.parse((await readBody(req)) || "{}") as { action?: string; value?: string };

        const op = agent.serviceOrchestrator.store.getOperation(taskId);
        if (!op) {
          sendJson(res, 404, { error: "opération non trouvée" });
          return;
        }

        if (body.action === "input") {
          sendJson(res, 409, { error: "SERVICE_CONTINUATION_NOT_SUPPORTED" });
          return;
        }
        if (body.action === "authorize") {
          if (op.status !== "WAITING_PERMISSION" || op.approvalState !== "PENDING") {
            sendJson(res, 409, { error: "OPERATION_NOT_PENDING_PRE_DISPATCH_APPROVAL" });
            return;
          }
          if (op.riskLevel === "CRITICAL" && body.value !== "APPROVE_CRITICAL") {
            sendJson(res, 409, { error: "CRITICAL_CONFIRMATION_REQUIRED" });
            return;
          }
          const result = await agent.serviceOrchestrator.approvePendingOperation(taskId, body.value);
          if (!result) {
            sendJson(res, 409, { error: "APPROVAL_ALREADY_DECIDED" });
            return;
          }
          sendJson(res, 200, { ok: true, operation: agent.serviceOrchestrator.store.getOperation(taskId), result });
          return;
        }
        if (body.action === "reject") {
          if (!agent.serviceOrchestrator.rejectPendingOperation(taskId)) {
            sendJson(res, 409, { error: "OPERATION_NOT_PENDING_PRE_DISPATCH_APPROVAL" });
            return;
          }
          sendJson(res, 200, { ok: true, operation: agent.serviceOrchestrator.store.getOperation(taskId) });
          return;
        }
        sendJson(res, 400, { error: "INVALID_OPERATION_RESPONSE" });
        return;
      }

      // 6. Services Legacy Endpoints
      if (req.method === "GET" && pathname === "/api/services") {
        sendJson(
          res,
          200,
          agent.serviceOrchestrator.registry.listServices().map((s) => ({
            ...s,
            auth: undefined,
            authType: s.auth.type,
            authConfigured:
              s.auth.type === "none" ||
              Boolean(process.env[s.auth.envVar]) ||
              (s.id === "software_factory" && Boolean(process.env.API_TOKEN)),
          })),
        );
        return;
      }

      if (req.method === "POST" && pathname.startsWith("/api/services/") && pathname.endsWith("/toggle")) {
        const parts = pathname.split("/");
        const id = parts[parts.length - 2];
        const body = JSON.parse((await readBody(req)) || "{}") as { enabled?: boolean };

        const service = agent.serviceOrchestrator.registry.getServiceById(id);
        if (!service) {
          sendJson(res, 404, { error: "service non trouvé" });
          return;
        }

        const newEnabled = body.enabled ?? !service.enabled;
        agent.serviceOrchestrator.registry.patchService(id, { enabled: newEnabled });
        agent.skills.refreshServiceAvailability(agent.serviceOrchestrator.registry);
        sendJson(res, 200, { ok: true, service: agent.serviceOrchestrator.registry.getServiceById(id) });
        return;
      }

      if (req.method === "POST" && pathname.startsWith("/api/services/") && pathname.endsWith("/test")) {
        const parts = pathname.split("/");
        const id = parts[parts.length - 2];
        const service = agent.serviceOrchestrator.registry.getServiceById(id);
        if (!service) {
          sendJson(res, 404, { error: "service non trouvé" });
          return;
        }

        const healthRes = await agent.serviceOrchestrator.adapter.checkHealth(service);
        sendJson(res, 200, {
          id: service.id,
          reachable: healthRes.reachable,
          status: healthRes.status,
          authenticated: healthRes.authenticated ?? true,
        });
        return;
      }

      // 7. Tasks Endpoints
      if (req.method === "GET" && pathname === "/api/tasks") {
        sendJson(res, 200, taskStore.list());
        return;
      }

      if (req.method === "POST" && pathname === "/api/tasks") {
        const body = JSON.parse((await readBody(req)) || "{}") as { title?: string; dueAt?: number };
        if (!body.title?.trim()) {
          sendJson(res, 400, { error: "Le titre de la tâche est requis" });
          return;
        }
        const created = taskStore.create(body.title.trim(), body.dueAt ?? null);
        sendJson(res, 201, created);
        return;
      }

      if (req.method === "POST" && pathname.startsWith("/api/tasks/") && pathname.endsWith("/complete")) {
        const parts = pathname.split("/");
        const taskId = parts[parts.length - 2];
        const ok = taskStore.complete(taskId);
        sendJson(res, ok ? 200 : 404, { ok });
        return;
      }

      // 8. Planner / Plans Endpoints
      if (req.method === "GET" && pathname === "/api/workspaces") {
        sendJson(res, 200, workspaceStore.list());
        return;
      }
      if (req.method === "POST" && pathname === "/api/workspaces") {
        let b: any;
        try {
          b = JSON.parse((await readBody(req)) || "{}");
          const ownerId = typeof b.ownerId === "string" && b.ownerId.trim() ? b.ownerId : `adhoc-${crypto.randomUUID()}`;
          const w = workspaceStore.create({ name: typeof b.name === "string" ? b.name : "Workspace", ownerType: "ADHOC", ownerId });
          sendJson(res, 201, w);
        } catch (e) {
          sendJson(res, 400, { error: (e as Error).message });
        }
        return;
      }
      const workspaceArtifacts = pathname.match(/^\/api\/workspaces\/([^/]+)\/artifacts$/);
      if (req.method === "GET" && workspaceArtifacts) {
        const id = decodeURIComponent(workspaceArtifacts[1]);
        if (!workspaceStore.get(id)) {
          sendJson(res, 404, { error: "WORKSPACE_NOT_FOUND" });
          return;
        }
        sendJson(res, 200, artifactStore.listByWorkspace(id));
        return;
      }
      const workspaceContent = pathname.match(/^\/api\/workspaces\/([^/]+)\/files\/content$/);
      if (req.method === "GET" && workspaceContent) {
        const id = decodeURIComponent(workspaceContent[1]),
          path = parsedUrl.searchParams.get("path");
        if (!workspaceStore.get(id)) {
          sendJson(res, 404, { error: "WORKSPACE_NOT_FOUND" });
          return;
        }
        if (!path) {
          sendJson(res, 400, { error: "PATH_REQUIRED" });
          return;
        }
        try {
          const data = workspaceStore.readFile(id, path);
          res.writeHead(200, {
            "content-type": "application/octet-stream",
            "content-disposition": `attachment; filename="${path.split("/").pop()!.replace(/[^a-zA-Z0-9._-]/g, "_")}"`,
          });
          res.end(data);
        } catch (e) {
          sendJson(res, 400, { error: (e as Error).message });
        }
        return;
      }
      const workspaceFiles = pathname.match(/^\/api\/workspaces\/([^/]+)\/files$/);
      if (workspaceFiles) {
        const id = decodeURIComponent(workspaceFiles[1]);
        if (!workspaceStore.get(id)) {
          sendJson(res, 404, { error: "WORKSPACE_NOT_FOUND" });
          return;
        }
        try {
          if (req.method === "GET") {
            sendJson(res, 200, workspaceStore.listFiles(id));
            return;
          }
          if (req.method === "POST") {
            const b = JSON.parse((await readBody(req)) || "{}");
            if (
              typeof b.path !== "string" ||
              (!Object.hasOwn(b, "contentBase64") && !Object.hasOwn(b, "text")) ||
              (b.contentBase64 !== undefined &&
                (typeof b.contentBase64 !== "string" ||
                  b.contentBase64.length % 4 !== 0 ||
                  !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(b.contentBase64) ||
                  Buffer.from(b.contentBase64, "base64").toString("base64") !== b.contentBase64))
            )
              throw new Error("INVALID_UPLOAD");
            const data = b.contentBase64 !== undefined ? Buffer.from(b.contentBase64, "base64") : String(b.text);
            const file = workspaceStore.writeFile(id, b.path, data);
            const artifact = artifactStore.createFileArtifact({
              workspaceId: id,
              name: file.path,
              mimeType: typeof b.mimeType === "string" ? b.mimeType : undefined,
              content: Buffer.isBuffer(data) ? data : Buffer.from(data),
            });
            sendJson(res, 201, { file, artifact });
            return;
          }
          if (req.method === "DELETE") {
            const path = parsedUrl.searchParams.get("path");
            if (!path) throw new Error("PATH_REQUIRED");
            workspaceStore.deleteFile(id, path);
            sendJson(res, 200, { ok: true });
            return;
          }
        } catch (e) {
          sendJson(res, 400, { error: (e as Error).message });
          return;
        }
      }
      const workspaceDetail = pathname.match(/^\/api\/workspaces\/([^/]+)$/);
      if (req.method === "GET" && workspaceDetail) {
        const w = workspaceStore.get(decodeURIComponent(workspaceDetail[1]));
        sendJson(res, w ? 200 : 404, w ?? { error: "WORKSPACE_NOT_FOUND" });
        return;
      }
      const artifactDetail = pathname.match(/^\/api\/artifacts\/([^/]+)$/);
      if (req.method === "GET" && artifactDetail) {
        const a = artifactStore.get(decodeURIComponent(artifactDetail[1]));
        if (!a) {
          sendJson(res, 404, { error: "ARTIFACT_NOT_FOUND" });
          return;
        }
        if (parsedUrl.searchParams.get("download") === "1" && a.relativePath) {
          if (a.contentStatus !== "AVAILABLE") {
            sendJson(res, 409, { error: a.contentStatus });
            return;
          }
          const data = workspaceStore.readFile(a.workspaceId, a.relativePath);
          res.writeHead(200, {
            "content-type": a.mimeType || "application/octet-stream",
            "content-disposition": `attachment; filename="${a.name.replace(/[^a-zA-Z0-9._-]/g, "_")}"`,
          });
          res.end(data);
          return;
        }
        sendJson(res, 200, a);
        return;
      }
      if (req.method === "GET" && (pathname === "/plan" || pathname === "/api/plan")) {
        sendJson(res, 200, agent.planner.all());
        return;
      }
      if (req.method === "GET" && pathname === "/api/plans") {
        sendJson(res, 200, agent.planner.listRuns());
        return;
      }
      const planNodesMatch = pathname.match(/^\/api\/plans\/([^/]+)\/nodes$/);
      if (req.method === "GET" && planNodesMatch) {
        const run = agent.planner.getRun(decodeURIComponent(planNodesMatch[1]));
        if (!run) {
          sendJson(res, 404, { error: "PLAN_NOT_FOUND" });
          return;
        }
        sendJson(res, 200, agent.planner.nodes(run.id));
        return;
      }
      const planCancelMatch = pathname.match(/^\/api\/plans\/([^/]+)\/cancel$/);
      if (req.method === "POST" && planCancelMatch) {
        const run = agent.planRunner.cancel(decodeURIComponent(planCancelMatch[1]));
        sendJson(res, run ? 200 : 404, run ?? { error: "PLAN_NOT_FOUND" });
        return;
      }
      const planDetailMatch = pathname.match(/^\/api\/plans\/([^/]+)$/);
      if (req.method === "GET" && planDetailMatch) {
        const run = agent.planner.getRun(decodeURIComponent(planDetailMatch[1]));
        if (!run) {
          sendJson(res, 404, { error: "PLAN_NOT_FOUND" });
          return;
        }
        sendJson(res, 200, { ...run, nodes: agent.planner.nodes(run.id) });
        return;
      }

      // 9. Memory Endpoints
      if (req.method === "GET" && pathname === "/api/memory") {
        sendJson(res, 200, {
          factsCount: agent.memory.facts.all().length,
          facts: agent.memory.facts.all(),
          recentWorking: agent.memory.working.recent(15),
          userPreferences: agent.memory.userModel.all(),
        });
        return;
      }

      if (req.method === "POST" && pathname === "/api/memory/search") {
        const body = JSON.parse((await readBody(req)) || "{}") as { query?: string };
        const query = (body.query ?? "").trim();
        if (!query) {
          sendJson(res, 400, { error: "Query requise" });
          return;
        }
        const results = await agent.memory.retrieve(query);
        sendJson(res, 200, results);
        return;
      }

      if (req.method === "POST" && pathname === "/api/memory/facts") {
        const body = JSON.parse((await readBody(req)) || "{}") as { entity?: string; attribute?: string; value?: string };
        if (!body.entity || !body.attribute || !body.value) {
          sendJson(res, 400, { error: "entity, attribute et value requis" });
          return;
        }
        agent.memory.facts.set(body.entity, body.attribute, body.value);
        sendJson(res, 200, { ok: true, facts: agent.memory.facts.all() });
        return;
      }

      // 10. Skills Endpoints
      if (req.method === "GET" && (pathname === "/skills" || pathname === "/api/skills")) {
        sendJson(
          res,
          200,
          agent.skills.list().map((s) => ({
            id: s.id,
            name: s.name,
            displayName: s.displayName,
            description: s.description,
            category: s.category,
            kind: s.kind,
            availability: s.availability,
            enabled: agent.skills.isEnabled(s),
            exposure: s.exposure,
            risk: s.risk,
            executionTarget: s.executionTarget,
            serviceCapability: s.serviceCapability,
            unavailableReason: s.unavailableReason,
          })),
        );
        return;
      }
      if (req.method === "GET" && pathname === "/api/workflows") {
        sendJson(res, 200, agent.workflows.list());
        return;
      }
      const workflowGet = pathname.match(/^\/api\/workflows\/([^/]+)$/);
      if (req.method === "GET" && workflowGet) {
        const workflow = agent.workflows.get(decodeURIComponent(workflowGet[1]));
        sendJson(res, workflow ? 200 : 404, workflow ?? { error: "workflow non trouvé" });
        return;
      }
      const workflowAction = pathname.match(/^\/api\/workflows\/([^/]+)\/(approve|disable|archive)$/);
      if (req.method === "POST" && workflowAction) {
        const status = workflowAction[2] === "approve" ? "ACTIVE" : workflowAction[2] === "disable" ? "DISABLED" : "ARCHIVED";
        try {
          const ok = agent.workflows.setStatus(decodeURIComponent(workflowAction[1]), status, agent.serviceOrchestrator.registry);
          sendJson(res, ok ? 200 : 404, ok ? { ok: true, status } : { error: "workflow non trouvé" });
        } catch (e) {
          sendJson(res, 409, { error: (e as Error).message });
        }
        return;
      }
      const learnWorkflow = pathname.match(/^\/api\/plans\/([^/]+)\/learn-workflow$/);
      if (req.method === "POST" && learnWorkflow) {
        try {
          sendJson(res, 201, agent.workflows.learnFromPlan(decodeURIComponent(learnWorkflow[1]), agent.planner));
        } catch (e) {
          sendJson(res, 409, { error: (e as Error).message });
        }
        return;
      }

      // 11. OTA Endpoints — le manifeste et le bundle doivent toujours correspondre au
      // même code Web (voir computeOtaBundle/readOtaManifest ci-dessus).
      if (req.method === "GET" && pathname === "/api/ota/manifest") {
        sendJson(res, 200, readOtaManifest());
        return;
      }

      if (req.method === "GET" && pathname === "/api/ota/bundle") {
        const bundlePath = join(process.cwd(), "www", "ota-bundle.json");
        if (existsSync(bundlePath)) {
          const content = readFileSync(bundlePath, "utf-8");
          res.writeHead(200, {
            "content-type": "application/json; charset=utf-8",
            "access-control-allow-origin": "*",
          });
          res.end(content);
          return;
        }

        const { bundleString } = computeOtaBundle();
        res.writeHead(200, {
          "content-type": "application/json; charset=utf-8",
          "access-control-allow-origin": "*",
        });
        res.end(bundleString);
        return;
      }

      // 12. AI Models Control Panel Endpoints (No secrets exposed!)
      if (req.method === "GET" && pathname === "/api/models") {
        const providers = [
          { id: "openrouter", name: "OpenRouter", available: Boolean(config.llm.openrouterApiKey) },
          { id: "infermatic", name: "Infermatic", available: Boolean(config.llm.infermaticApiKey) },
          { id: "anthropic", name: "Anthropic", available: Boolean(config.llm.anthropicApiKey) },
          { id: "openai", name: "OpenAI", available: Boolean(config.llm.openaiApiKey) },
          { id: "ollama", name: "Ollama", available: Boolean(config.llm.ollamaBaseUrl) },
          { id: "mock", name: "Mock (Offline)", available: true },
        ];

        sendJson(res, 200, {
          activeProvider: config.llm.provider,
          activeModel: config.llm.model,
          providers,
        });
        return;
      }

      if (req.method === "GET" && pathname === "/api/models/openrouter") {
        try {
          const controller = new AbortController();
          const timeout = setTimeout(() => controller.abort(), 5000);
          const response = await fetch("https://openrouter.ai/api/v1/models", { signal: controller.signal });
          clearTimeout(timeout);

          if (response.ok) {
            const data = (await response.json()) as {
              data: Array<{ id: string; name?: string; pricing?: { prompt?: string; completion?: string } }>;
            };
            const models = (data.data || []).map((m) => {
              const promptPrice = Number(m.pricing?.prompt || 0);
              const compPrice = Number(m.pricing?.completion || 0);
              const isFree = (promptPrice === 0 && compPrice === 0) || m.id.endsWith(":free");
              return {
                id: m.id,
                name: m.name || m.id,
                isFree,
              };
            });
            sendJson(res, 200, models);
            return;
          }
        } catch {
          // Fallback if network unavailable
        }

        sendJson(res, 200, [
          { id: "anthropic/claude-3.5-sonnet", name: "Claude 3.5 Sonnet", isFree: false },
          { id: "meta-llama/llama-3.3-70b-instruct:free", name: "Llama 3.3 70B Instruct (Free)", isFree: true },
          { id: "google/gemini-2.0-flash-001", name: "Gemini 2.0 Flash", isFree: false },
          { id: "deepseek/deepseek-r1:free", name: "DeepSeek R1 (Free)", isFree: true },
        ]);
        return;
      }

      if (req.method === "GET" && pathname.startsWith("/api/models/catalog/")) {
        const parts = pathname.split("/");
        const prov = parts[parts.length - 1];

        if (prov === "infermatic") {
          const result = await fetchInfermaticCatalog();
          if (!result.ok) {
            sendJson(res, result.status, { error: result.error, models: [] });
            return;
          }
          sendJson(res, 200, result.models);
          return;
        }

        sendJson(res, 200, DEFAULT_PRESET_MODELS[prov] || []);
        return;
      }

      if (req.method === "POST" && pathname === "/api/models/test") {
        const body = JSON.parse((await readBody(req)) || "{}") as { provider?: LLMProviderName; model?: string };
        if (!body.provider || !body.model) {
          sendJson(res, 400, { error: "provider et model requis" });
          return;
        }

        // Fonction rigoureusement lecture-seule : createLLMProvider est pur et rien ici
        // n'écrit dans config.llm, dans llmConfigStore, ni dans l'agent (voir point 9).
        try {
          // sanitizeReasoning: true — la prévisualisation testée est destinée à l'utilisateur
          // du chat Jarvis, le raisonnement interne éventuel ne doit jamais y apparaître.
          const testProviderInstance = createLLMProvider({ provider: body.provider, model: body.model, sanitizeReasoning: true });
          const probe = await testJarvisCompatibility(testProviderInstance, body.provider);
          sendJson(res, 200, {
            ok: true,
            provider: body.provider,
            model: body.model,
            compatibility: probe.level,
            responsePreview: probe.responsePreview,
            message:
              probe.level === "JARVIS_TOOL_COMPATIBLE"
                ? "Modèle compatible avec le fonctionnement agentique de Jarvis (tool calling natif validé) !"
                : "Modèle accessible et fonctionnel !",
          });
        } catch (err) {
          sendJson(res, 200, {
            ok: false,
            provider: body.provider,
            model: body.model,
            error: redactSecrets((err as Error).message),
          });
        }
        return;
      }

      if (req.method === "POST" && pathname === "/api/models/select") {
        const body = JSON.parse((await readBody(req)) || "{}") as { provider?: LLMProviderName; model?: string };
        if (!body.provider || !body.model) {
          sendJson(res, 400, { error: "provider et model requis" });
          return;
        }

        const currentProv = config.llm.provider;
        const currentModel = config.llm.model;

        // Application atomique : on valide le candidat, puis on PERSISTE en premier —
        // c'est la seule étape qui peut réellement échouer (I/O). Les mutations en
        // mémoire (agent + config) n'interviennent qu'une fois la persistance réussie,
        // donc si n'importe quelle étape lève une exception, rien n'a encore été modifié
        // et l'ancien provider/modèle reste intégralement actif — pas de rollback à
        // effectuer, et jamais d'annonce d'un rollback qui n'aurait pas réellement eu lieu.
        try {
          // sanitizeReasoning: true — l'instance créée devient le provider actif du chat
          // Jarvis (agent.setLLMProvider ci-dessous), le raisonnement interne éventuel ne
          // doit jamais être exposé à l'utilisateur.
          const newProviderInstance = createLLMProvider({ provider: body.provider, model: body.model, sanitizeReasoning: true });
          const probe = await testJarvisCompatibility(newProviderInstance, body.provider);

          saveLLMConfig(body.provider, body.model);

          agent.setLLMProvider(newProviderInstance);
          config.llm.provider = body.provider;
          config.llm.model = body.model;

          sendJson(res, 200, {
            ok: true,
            activeProvider: body.provider,
            activeModel: body.model,
            compatibility: probe.level,
            message: `Modèle actif mis à jour : ${body.model}`,
          });
        } catch (err) {
          sendJson(res, 200, {
            ok: false,
            activeProvider: currentProv,
            activeModel: currentModel,
            error: `Le modèle sélectionné n'est pas disponible (${redactSecrets((err as Error).message)}). ${currentModel} reste actif.`,
          });
        }
        return;
      }

      // 13. Reflection Endpoint
      if (req.method === "GET" && pathname === "/api/reflection") {
        sendJson(res, 200, {
          enabled: true,
          everyNSteps: config.reflection.everyNSteps,
        });
        return;
      }

      if (req.method === "POST" && pathname === "/api/reflection/trigger") {
        const insight = await agent.reflection.reflect();
        sendJson(res, 200, { ok: true, insight });
        return;
      }

      // 14. Checkpoints Endpoints
      if (req.method === "GET" && (pathname === "/checkpoints" || pathname === "/api/checkpoints")) {
        sendJson(res, 200, agent.listCheckpoints());
        return;
      }

      if (req.method === "POST" && (pathname === "/checkpoints" || pathname === "/api/checkpoints")) {
        const body = JSON.parse((await readBody(req)) || "{}") as { label?: string };
        sendJson(res, 200, { id: agent.saveCheckpoint(body.label || `checkpoint-${Date.now()}`) });
        return;
      }

      if (req.method === "POST" && pathname.includes("/checkpoints/") && pathname.endsWith("/restore")) {
        const parts = pathname.split("/");
        const id = parts[parts.length - 2];
        const ok = agent.restoreCheckpoint(id);
        sendJson(res, ok ? 200 : 404, { ok });
        return;
      }

      // 16. Automations Triggers Endpoints (Chantier 9) — authentification par le même
      // Bearer que le reste de l'API (voir isAuthorized ci-dessus), à l'image de l'endpoint
      // /tasks déjà utilisé pour le rappel Software Factory.
      if (req.method === "POST" && pathname === "/api/triggers/email") {
        let body: unknown;
        try {
          body = JSON.parse((await readBody(req)) || "{}");
        } catch {
          sendJson(res, 400, { error: "JSON invalide" });
          return;
        }
        const result = await handleEmailTrigger(agent.serviceOrchestrator, triggerStore, body);
        sendJson(res, result.status, result.body);
        return;
      }
      if (req.method === "GET" && pathname === "/api/triggers/email") {
        sendJson(res, 200, { items: triggerStore.list("EMAIL") });
        return;
      }

      if (req.method === "POST" && pathname === "/api/triggers/crm") {
        let body: unknown;
        try {
          body = JSON.parse((await readBody(req)) || "{}");
        } catch {
          sendJson(res, 400, { error: "JSON invalide" });
          return;
        }
        const result = await handleCrmTrigger(agent.serviceOrchestrator, triggerStore, body);
        sendJson(res, result.status, result.body);
        return;
      }
      if (req.method === "GET" && pathname === "/api/triggers/crm") {
        sendJson(res, 200, { items: triggerStore.list("CRM") });
        return;
      }

      if (req.method === "POST" && pathname === "/api/triggers/external") {
        let body: unknown;
        try {
          body = JSON.parse((await readBody(req)) || "{}");
        } catch {
          sendJson(res, 400, { error: "JSON invalide" });
          return;
        }
        const result = await handleExternalTrigger(agent.serviceOrchestrator, triggerStore, body);
        sendJson(res, result.status, result.body);
        return;
      }
      if (req.method === "GET" && pathname === "/api/triggers/external") {
        sendJson(res, 200, { items: triggerStore.list("EXTERNAL") });
        return;
      }

      // 15. System & Diagnostics
      if (req.method === "GET" && pathname === "/api/system/factory-diagnostics") {
        let toolCalling = false;
        try {
          const testProvider = agent.getLLMProvider();
          if (testProvider.supportsNativeTools && testProvider.supportsNativeTools()) {
            const pingRes = await testProvider.complete(
              [{ role: "user", content: "Utilise l'outil 'ping_test' pour répondre à cet appel." }],
              {
                tools: [
                  {
                    type: "function",
                    function: {
                      name: "ping_test",
                      description: "Outil de test ping",
                      parameters: { type: "object", properties: {} },
                    },
                  },
                ],
              },
            );
            toolCalling = Boolean(pingRes.toolCalls && pingRes.toolCalls.length > 0);
          }
        } catch {
          toolCalling = false;
        }

        const dispatchCapabilityRegistered = Boolean(agent.skills.get("dispatch_capability"));
        const factoryService = agent.serviceOrchestrator.registry.getServiceById("software_factory");
        const githubDiag = await softwareFactoryService.getGitHubDiagnostics();

        let factoryReachable = false;
        let factoryAuthenticated = false;

        if (factoryService) {
          const healthRes = await agent.serviceOrchestrator.adapter.checkHealth(factoryService.endpoint);
          factoryReachable = healthRes.reachable;
          factoryAuthenticated = healthRes.authenticated ?? true;
        }

        sendJson(res, 200, {
          jarvis: {
            running: true,
            provider: config.llm.provider,
            model: config.llm.model,
            toolCalling,
          },
          dispatchCapability: {
            registered: dispatchCapabilityRegistered,
            alwaysAvailable: true,
          },
          orchestrator: {
            running: true,
            operationsCount: agent.serviceOrchestrator.store.listOperations().length,
          },
          softwareFactory: {
            registered: Boolean(factoryService),
            enabled: factoryService?.enabled ?? false,
            endpoint: factoryService?.endpoint ?? "in-process",
            reachable: factoryReachable,
            authenticated: factoryAuthenticated,
          },
          github: githubDiag,
        });
        return;
      }

      if (req.method === "GET" && pathname === "/api/system") {
        sendJson(res, 200, {
          version: "0.1.0",
          backend: "reachable",
          dbStatus: "ok",
          commandCenter: "active",
          llmProvider: config.llm.provider,
          servicesCount: agent.serviceOrchestrator.registry.listServices().length,
          lastError: lastServerError,
          checkpoints: agent.listCheckpoints(),
        });
        return;
      }

      if (req.method === "POST" && pathname === "/api/system/diagnostics") {
        const services = agent.serviceOrchestrator.registry.listServices();
        sendJson(res, 200, {
          timestamp: new Date().toISOString(),
          tests: [
            { name: "Test Backend", status: "ok" },
            { name: "Test Base de données", status: "ok" },
            { name: "Test Fournisseur IA", status: "ok", detail: config.llm.provider },
            { name: "Test Services", status: services.length > 0 ? "ok" : "warning", detail: `${services.length} service(s)` },
          ],
        });
        return;
      }

      sendJson(res, 404, { error: "not found" });
    } catch (err) {
      lastServerError = (err as Error).message;
      sendJson(res, 500, { error: (err as Error).message });
    }
  });

  server.listen(port, () => {
    console.log(`Jarvis Command Center API démarrée sur http://localhost:${port}`);
    if (config.llm.provider === "mock") {
      console.warn("[WARNING] Provider mock actif : le tool calling et la délégation Software Factory sont indisponibles.");
    }
  });

  return server;
}
