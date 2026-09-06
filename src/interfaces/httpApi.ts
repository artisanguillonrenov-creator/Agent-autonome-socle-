import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import type { Agent } from "../core/agent.js";
import { config } from "../config.js";
import { getChatPageHtml } from "./chatPage.js";

async function readBody(req: IncomingMessage): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const chunk of req) chunks.push(chunk as Buffer);
  return Buffer.concat(chunks).toString("utf-8");
}

function sendJson(res: ServerResponse, status: number, body: unknown): void {
  res.writeHead(status, { "content-type": "application/json; charset=utf-8" });
  res.end(JSON.stringify(body));
}

function isAuthorized(req: IncomingMessage): boolean {
  if (!config.api.token) return true;
  return req.headers.authorization === `Bearer ${config.api.token}`;
}

/**
 * Brique 8 : une façade HTTP sur le même cœur Agent que la CLI — un futur
 * client web/mobile ou vocal peut parler au même agent sans dupliquer sa
 * logique. Serveur minimal (module http natif de Node, aucune dépendance).
 *
 * Aucune authentification si API_TOKEN n'est pas défini : à ne réserver qu'à
 * localhost/réseau de confiance tant que ce n'est pas configuré.
 */
export function startHttpApi(agent: Agent, port: number): void {
  const server = createServer(async (req, res) => {
    if (req.method === "GET" && req.url === "/") {
      res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
      res.end(getChatPageHtml());
      return;
    }

    if (!isAuthorized(req)) {
      sendJson(res, 401, { error: "unauthorized" });
      return;
    }

    try {
      if (req.method === "POST" && req.url === "/chat") {
        const body = JSON.parse((await readBody(req)) || "{}") as { message?: string };
        const message = (body.message ?? "").trim();
        if (!message) {
          sendJson(res, 400, { error: "message requis" });
          return;
        }
        sendJson(res, 200, await agent.step(message));
        return;
      }

      if (req.method === "GET" && req.url === "/skills") {
        sendJson(
          res,
          200,
          agent.skills.list().map((s) => ({ name: s.name, description: s.description, argsHint: s.argsHint })),
        );
        return;
      }

      if (req.method === "GET" && req.url === "/plan") {
        sendJson(res, 200, agent.planner.all());
        return;
      }

      if (req.method === "GET" && req.url === "/operations") {
        sendJson(res, 200, agent.serviceOrchestrator.store.listOperations());
        return;
      }

      if (req.method === "GET" && req.url?.startsWith("/operations/")) {
        const taskId = req.url.split("/")[2];
        const op = agent.serviceOrchestrator.store.getOperation(taskId);
        if (op) {
          sendJson(res, 200, op);
        } else {
          sendJson(res, 404, { error: "opération non trouvée" });
        }
        return;
      }

      if (req.method === "GET" && req.url === "/checkpoints") {
        sendJson(res, 200, agent.listCheckpoints());
        return;
      }

      if (req.method === "POST" && req.url === "/checkpoints") {
        const body = JSON.parse((await readBody(req)) || "{}") as { label?: string };
        sendJson(res, 200, { id: agent.saveCheckpoint(body.label || `checkpoint-${Date.now()}`) });
        return;
      }

      if (req.method === "POST" && req.url?.startsWith("/checkpoints/") && req.url.endsWith("/restore")) {
        const id = req.url.split("/")[2];
        const ok = agent.restoreCheckpoint(id);
        sendJson(res, ok ? 200 : 404, { ok });
        return;
      }

      sendJson(res, 404, { error: "not found" });
    } catch (err) {
      sendJson(res, 500, { error: (err as Error).message });
    }
  });

  server.listen(port, () => {
    console.log(`API HTTP démarrée sur http://localhost:${port}`);
  });
}
