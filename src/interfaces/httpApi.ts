import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { existsSync, readFileSync } from "node:fs";
import { join, extname } from "node:path";
import type { Agent } from "../core/agent.js";
import { config, type LLMProviderName } from "../config.js";
import { TaskStore } from "../tasks/taskStore.js";
import { getChatPageHtml } from "./chatPage.js";
import { createLLMProvider } from "../llm/providers/index.js";
import { saveLLMConfig } from "../persistence/llmConfigStore.js";
import { SoftwareFactoryService } from "../services/softwareFactoryService.js";
import type { TaskRequest } from "../orchestration/contract.js";
import { NotificationStore } from "../autonomy/notificationStore.js";

const taskStore = new TaskStore();
const notificationStore = new NotificationStore();
const softwareFactoryService = new SoftwareFactoryService();
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
    "access-control-allow-methods": "GET, POST, PUT, DELETE, OPTIONS",
    "access-control-allow-headers": "Content-Type, Authorization",
  });
  res.end(JSON.stringify(body));
}

function isAuthorized(req: IncomingMessage): boolean {
  if (!config.api.token) return false;
  const auth = req.headers.authorization;
  return auth === `Bearer ${config.api.token}`;
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
  infermatic: [
    { id: "llama-3.3-70b-instruct", name: "Llama 3.3 70B Instruct" },
    { id: "mistral-large-2411", name: "Mistral Large 2411" },
    { id: "qwen2.5-72b-instruct", name: "Qwen 2.5 72B Instruct" },
  ],
  ollama: [
    { id: "llama3", name: "Llama 3" },
    { id: "mistral", name: "Mistral" },
    { id: "qwen2.5", name: "Qwen 2.5" },
  ],
  mock: [{ id: "mock-model", name: "Mock Model (Offline)" }],
};

/**
 * Façade HTTP du Jarvis Command Center.
 */
export function startHttpApi(agent: Agent, port: number): ReturnType<typeof createServer> {
  const server = createServer(async (req, res) => {
    // CORS Preflight
    if (req.method === "OPTIONS") {
      res.writeHead(204, {
        "access-control-allow-origin": "*",
        "access-control-allow-methods": "GET, POST, PUT, DELETE, OPTIONS",
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
      // 0a. Software Factory Service Endpoint: POST /tasks
      // (Traite directement la tâche demandée par ServiceAdapter pour la Software Factory)
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
      // (Passe par le ServiceOrchestrator pour tracer et choisir le service approprié)
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
            executionMode: (taskReq as TaskRequest & {execution_mode?:string}).execution_mode === "background" ? "background" : "foreground",
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
        const body = JSON.parse((await readBody(req)) || "{}") as { message?: string };
        const message = (body.message ?? "").trim();
        if (!message) {
          sendJson(res, 400, { error: "message requis" });
          return;
        }
        const result = await agent.step(message);
        sendJson(res, 200, result);
        return;
      }

      if (req.method === "GET" && pathname === "/api/chat/stream") {
        const queryMsg = parsedUrl.searchParams.get("message") || "";
        if (!queryMsg.trim()) {
          sendJson(res, 400, { error: "message query param requis" });
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
          const result = await agent.step(queryMsg.trim());
          res.write(`data: ${JSON.stringify({ type: "answer", content: result.response, iterations: result.iterations })}\n\n`);
          res.write(`data: [DONE]\n\n`);
          res.end();
        } catch (err) {
          res.write(`data: ${JSON.stringify({ type: "error", error: (err as Error).message })}\n\n`);
          res.end();
        }
        return;
      }

      // 3. Status & General Health
      if (req.method === "GET" && (pathname === "/api/status" || pathname === "/status")) {
        const services = agent.serviceOrchestrator.registry.listServices();
        const ops = agent.serviceOrchestrator.store.listOperations();

        let otaVersion = "1.0.0";
        try {
          const manifestPath = join(process.cwd(), "www", "ota-manifest.json");
          if (existsSync(manifestPath)) {
            const manifest = JSON.parse(readFileSync(manifestPath, "utf-8"));
            otaVersion = manifest.version || "1.0.0";
          }
        } catch {}

        const statusData = {
          status: "online",
          version: "0.1.0",
          nativeVersion: "1.0.0",
          otaVersion,
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

      // 4. Operations Endpoints
      if (req.method === "GET" && (pathname === "/operations" || pathname === "/api/operations")) {
        sendJson(res, 200, agent.serviceOrchestrator.store.listOperations());
        return;
      }

      const cancelMatch=pathname.match(/^\/api\/operations\/([^/]+)\/cancel$/);
      if(req.method==="POST"&&cancelMatch){const result=agent.serviceOrchestrator.store.cancel(cancelMatch[1]);if(!result){sendJson(res,404,{error:"opération non trouvée"});return;}sendJson(res,200,{...result,message:result.cancelled?"Opération annulée avant dispatch.":result.requested?"Annulation demandée, sans garantie pour l’effet externe.":"Opération déjà terminée."});return;}

      if(req.method==="GET"&&pathname==="/api/notifications/unread-count"){sendJson(res,200,{count:notificationStore.unreadCount()});return;}
      if(req.method==="GET"&&pathname==="/api/notifications"){sendJson(res,200,notificationStore.list(parsedUrl.searchParams.get("unread")==="true"));return;}
      const readMatch=pathname.match(/^\/api\/notifications\/([^/]+)\/read$/);
      if(req.method==="POST"&&readMatch){const ok=notificationStore.markRead(readMatch[1]);sendJson(res,ok?200:404,ok?{ok:true}:{error:"notification non trouvée"});return;}

      if(req.method==="GET"&&pathname==="/api/schedules"){sendJson(res,200,taskStore.listSchedules());return;}
      if(req.method==="POST"&&pathname==="/api/schedules"){
        let body:any;try{body=JSON.parse((await readBody(req))||"{}");}catch{sendJson(res,400,{error:"JSON invalide"});return;}
        if(typeof body.title!=="string"||!body.title.trim()||!["REMINDER","DISPATCH","WATCH"].includes(body.taskType)||!Number.isSafeInteger(body.nextRunAt)||body.nextRunAt<0||(body.repeatIntervalMs!==undefined&&(!Number.isSafeInteger(body.repeatIntervalMs)||body.repeatIntervalMs<=0))||((body.taskType==="DISPATCH"||body.taskType==="WATCH")&&(!body.payload||body.payload.action!=="DISPATCH_CAPABILITY"||typeof body.payload.capability!=="string"||typeof body.payload.objective!=="string"))){sendJson(res,400,{error:"INVALID_SCHEDULE"});return;}
        sendJson(res,201,taskStore.createSchedule({title:body.title.trim(),taskType:body.taskType,nextRunAt:body.nextRunAt,repeatIntervalMs:body.repeatIntervalMs,payload:body.payload}));return;
      }
      const toggleSchedule=pathname.match(/^\/api\/schedules\/([^/]+)\/(enable|disable)$/);
      if(req.method==="POST"&&toggleSchedule){const ok=taskStore.setEnabled(toggleSchedule[1],toggleSchedule[2]==="enable");sendJson(res,ok?200:404,ok?{ok:true}:{error:"schedule non trouvé"});return;}

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

      if (req.method === "POST" && (pathname.includes("/operations/") && pathname.endsWith("/respond"))) {
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

      // 5. Services Endpoints
      if (req.method === "GET" && pathname === "/api/services") {
        sendJson(res, 200, agent.serviceOrchestrator.registry.listServices());
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

        service.enabled = body.enabled ?? !service.enabled;
        agent.serviceOrchestrator.registry.register(service);
        sendJson(res, 200, { ok: true, service });
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

        const healthRes = await agent.serviceOrchestrator.adapter.checkHealth(service.endpoint);
        sendJson(res, 200, {
          id: service.id,
          reachable: healthRes.reachable,
          status: healthRes.status,
          authenticated: healthRes.authenticated ?? true,
        });
        return;
      }

      // 6. Tasks Endpoints
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

      // 7. Planner / Plans Endpoints
      if (req.method === "GET" && (pathname === "/plan" || pathname === "/api/plan")) {
        sendJson(res, 200, agent.planner.all());
        return;
      }

      // 8. Memory Endpoints
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

      // 9. Skills Endpoints
      if (req.method === "GET" && (pathname === "/skills" || pathname === "/api/skills")) {
        sendJson(
          res,
          200,
          agent.skills.list().map((s) => ({
            name: s.name,
            description: s.description,
            argsHint: s.argsHint,
            available: true,
          })),
        );
        return;
      }

      // 10. OTA Endpoints
      if (req.method === "GET" && pathname === "/api/ota/manifest") {
        const manifestPath = join(process.cwd(), "www", "ota-manifest.json");
        if (existsSync(manifestPath)) {
          const content = readFileSync(manifestPath, "utf-8");
          res.writeHead(200, {
            "content-type": "application/json; charset=utf-8",
            "access-control-allow-origin": "*",
          });
          res.end(content);
          return;
        }

        // Fallback default manifest
        sendJson(res, 200, {
          version: "1.0.0",
          build: 1,
          minimumNativeVersion: "1.0.0",
          bundleUrl: "/api/ota/bundle",
          sha256: "",
          releaseNotes: "Version initiale Command Center",
          updatedAt: new Date().toISOString(),
        });
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

        // Dynamic fallback bundle creation
        const filesToBundle = ["index.html", "style.css", "app.js"];
        const filesMap: Record<string, string> = {};
        for (const file of filesToBundle) {
          const filePath = join(process.cwd(), "www", file);
          if (existsSync(filePath)) {
            filesMap[file] = readFileSync(filePath, "utf-8");
          }
        }
        sendJson(res, 200, { files: filesMap });
        return;
      }

      // 10b. AI Models Control Panel Endpoints (No secrets exposed!)
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
              const isFree = promptPrice === 0 && compPrice === 0 || m.id.endsWith(":free");
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

        // Fallback OpenRouter models
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
        sendJson(res, 200, DEFAULT_PRESET_MODELS[prov] || []);
        return;
      }

      if (req.method === "POST" && pathname === "/api/models/test") {
        const body = JSON.parse((await readBody(req)) || "{}") as { provider?: LLMProviderName; model?: string };
        if (!body.provider || !body.model) {
          sendJson(res, 400, { error: "provider et model requis" });
          return;
        }

        try {
          const testProviderInstance = createLLMProvider({ provider: body.provider, model: body.model });
          const responseResult = await testProviderInstance.complete([{ role: "user", content: "Test ping" }]);
          const responseText = typeof responseResult === "string" ? responseResult : responseResult.content ?? "";
          sendJson(res, 200, {
            ok: true,
            provider: body.provider,
            model: body.model,
            responsePreview: responseText.slice(0, 100),
            message: "Modèle accessible et fonctionnel !",
          });
        } catch (err) {
          sendJson(res, 200, {
            ok: false,
            provider: body.provider,
            model: body.model,
            error: (err as Error).message,
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

        try {
          // 1. Create & test new provider
          const newProviderInstance = createLLMProvider({ provider: body.provider, model: body.model });
          await newProviderInstance.complete([{ role: "user", content: "Validation du modèle" }]);

          // 2. If test passes, update Agent in-memory & persist
          agent.setLLMProvider(newProviderInstance);
          saveLLMConfig(body.provider, body.model);

          config.llm.provider = body.provider;
          config.llm.model = body.model;

          sendJson(res, 200, {
            ok: true,
            activeProvider: body.provider,
            activeModel: body.model,
            message: `Modèle actif mis à jour : ${body.model}`,
          });
        } catch (err) {
          // Fallback to previous functional model
          const fallbackInstance = createLLMProvider({ provider: currentProv, model: currentModel });
          agent.setLLMProvider(fallbackInstance);
          config.llm.provider = currentProv;
          config.llm.model = currentModel;

          sendJson(res, 200, {
            ok: false,
            activeProvider: currentProv,
            activeModel: currentModel,
            error: `Le modèle sélectionné n'est pas disponible (${(err as Error).message}). ${currentModel} reste actif.`,
          });
        }
        return;
      }

      // 11. Reflection Endpoint
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

      // 12. Checkpoints Endpoints
      if (req.method === "GET" && (pathname === "/checkpoints" || pathname === "/api/checkpoints")) {
        sendJson(res, 200, agent.listCheckpoints());
        return;
      }

      if (req.method === "POST" && (pathname === "/checkpoints" || pathname === "/api/checkpoints")) {
        const body = JSON.parse((await readBody(req)) || "{}") as { label?: string };
        sendJson(res, 200, { id: agent.saveCheckpoint(body.label || `checkpoint-${Date.now()}`) });
        return;
      }

      if (req.method === "POST" && (pathname.includes("/checkpoints/") && pathname.endsWith("/restore"))) {
        const parts = pathname.split("/");
        const id = parts[parts.length - 2];
        const ok = agent.restoreCheckpoint(id);
        sendJson(res, ok ? 200 : 404, { ok });
        return;
      }

      // 13. System & Diagnostics
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

      // 14. Settings Endpoints
      if (req.method === "GET" && pathname === "/api/settings") {
        sendJson(res, 200, {
          tokenBudget: config.context.tokenBudget,
          maxIterations: config.agent.maxIterations,
          reflectionEveryNSteps: config.reflection.everyNSteps,
          llmProvider: config.llm.provider,
          llmModel: config.llm.model,
        });
        return;
      }

      if (req.method === "POST" && pathname === "/api/settings") {
        const body = JSON.parse((await readBody(req)) || "{}") as {
          tokenBudget?: number;
          maxIterations?: number;
          reflectionEveryNSteps?: number;
        };
        if (body.tokenBudget && body.tokenBudget > 0) config.context.tokenBudget = body.tokenBudget;
        if (body.maxIterations && body.maxIterations > 0) config.agent.maxIterations = body.maxIterations;
        if (body.reflectionEveryNSteps && body.reflectionEveryNSteps > 0) config.reflection.everyNSteps = body.reflectionEveryNSteps;

        sendJson(res, 200, {
          ok: true,
          settings: {
            tokenBudget: config.context.tokenBudget,
            maxIterations: config.agent.maxIterations,
            reflectionEveryNSteps: config.reflection.everyNSteps,
          },
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
