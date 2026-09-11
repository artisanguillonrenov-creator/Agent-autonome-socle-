import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import type { IncomingMessage, Server, ServerResponse } from "node:http";

export interface ConversationWebUiRuntime {
  dispose(): void;
}

/**
 * Injects the conversation manager into the served Web UI. Fresh/OTA builds may already
 * contain the build-time bootstrap marker; in that case we must not add a second script.
 */
export function installConversationWebUiIngress(server: Server): ConversationWebUiRuntime {
  const previousListeners = server.listeners("request") as Array<(req: IncomingMessage, res: ServerResponse) => void>;
  if (previousListeners.length === 0) throw new Error("HTTP_REQUEST_LISTENER_MISSING");
  server.removeAllListeners("request");

  const listener = (req: IncomingMessage, res: ServerResponse): void => {
    const parsed = new URL(req.url || "/", "http://localhost");
    if (req.method === "GET" && parsed.pathname === "/") {
      const indexPath = join(process.cwd(), "www", "index.html");
      if (existsSync(indexPath)) {
        try {
          const html = readFileSync(indexPath, "utf-8");
          const marker = '<script src="conversationPersistence.js" data-jarvis-conversation-bootstrap="11b"></script>';
          const injected = html.includes("conversationPersistence.js")
            ? html
            : html.replace("</body>", `  ${marker}\n</body>`);
          res.writeHead(200, {
            "content-type": "text/html; charset=utf-8",
            "access-control-allow-origin": "*",
          });
          res.end(injected);
          return;
        } catch {
          // Fall through to the original static handler.
        }
      }
    }
    for (const previous of previousListeners) previous.call(server, req, res);
  };

  server.on("request", listener);
  return {
    dispose() {
      server.off("request", listener);
      for (const previous of previousListeners) server.on("request", previous);
    },
  };
}
