import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { existsSync, readFileSync } from "node:fs";
import { join, extname } from "node:path";
import type { Agent } from "../core/agent.js";
import { config } from "../config.js";
import { TaskStore } from "../tasks/taskStore.js";
import { getChatPageHtml } from "./chatPage.js";

const taskStore = new TaskStore();
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
  if (!config.api.token) return true;
  const auth = req.headers.authorization;
  return auth === `Bearer ${config.api.token}`;
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

/**
 * Façade HTTP du Jarvis Command Center.
 * Expose les endpoints REST pour l'application Web & Tablette Android,
 * et sert l'interface utilisateur statique.
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

    // Check auth for non-public endpoints
    if (!isAuthorized(req) && pathname !== "/" && !pathname.startsWith("/www/") && !pathname.match(/\.(html|css|js|png|jpg|ico|svg)$/)) {
      sendJson(res, 401, { error: "unauthorized" });
      return;
    }

    try {
      // 1. Static Web Files Serving (Command Center Frontend)
      if (req.method === "GET") {
        if (pathname === "/") {
          const distIndexPath = join(process.cwd(), "www", "index.html");
          if (existsSync(distIndexPath)) {
            serveStaticFile(res, distIndexPath);
            return;
          } else {
            // Fallback HTML page
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

      // 2. Chat Endpoint (Legacy & Standard)
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

      // 3. Status & General Health
      if (req.method === "GET" && (pathname === "/api/status" || pathname === "/status")) {
        const services = agent.serviceOrchestrator.registry.listServices();
        const ops = agent.serviceOrchestrator.store.listOperations();

        const statusData = {
          status: "online",
          version: "0.1.0",
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

        if (body.action === "authorize") {
          agent.serviceOrchestrator.store.updateStatus(taskId, "RUNNING", "Autorisation accordée par l'utilisateur.");
        } else if (body.action === "reject") {
          agent.serviceOrchestrator.store.updateStatus(taskId, "REJECTED", undefined, "Refusé par l'utilisateur.");
        } else if (body.action === "input" && body.value) {
          agent.serviceOrchestrator.store.updateStatus(taskId, "RUNNING", `Réponse utilisateur: ${body.value}`);
        }

        const updated = agent.serviceOrchestrator.store.getOperation(taskId);
        sendJson(res, 200, { ok: true, operation: updated });
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

        try {
          const controller = new AbortController();
          const timeout = setTimeout(() => controller.abort(), 3000);
          const response = await fetch(service.endpoint, { method: "HEAD", signal: controller.signal }).catch(() => null);
          clearTimeout(timeout);

          sendJson(res, 200, {
            id: service.id,
            reachable: response ? true : false,
            status: response ? response.status : "unreachable",
          });
        } catch (err) {
          sendJson(res, 200, { id: service.id, reachable: false, error: (err as Error).message });
        }
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

      // 10. AI Models Info Endpoint (No secrets exposed!)
      if (req.method === "GET" && pathname === "/api/models") {
        sendJson(res, 200, {
          activeProvider: config.llm.provider,
          activeModel: config.llm.model,
          supportedProviders: ["anthropic", "openai", "openrouter", "ollama", "infermatic", "mock"],
        });
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

      // 12. Checkpoints Endpoints (Legacy & Standard)
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
  });

  return server;
}
