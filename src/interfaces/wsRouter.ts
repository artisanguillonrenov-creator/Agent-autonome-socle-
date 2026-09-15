import type { Server, IncomingMessage } from "node:http";
import type { Socket } from "node:net";
import { WebSocketServer } from "ws";

/**
 * Vague 13A : plusieurs canaux WebSocket (audio legacy, /ws/audio, /ws/logs) doivent
 * coexister sur le même http.Server. La bibliothèque `ws` gère nativement un seul chemin par
 * instance construite avec `{ server, path }` : chaque instance installe son PROPRE listener
 * `upgrade` sur le serveur partagé, et `handleUpgrade` avorte la connexion (HTTP 400) dès que
 * le chemin ne correspond pas — donc la première instance non concernée par une requête
 * détruit le socket avant même que la bonne instance ait pu réagir. Un seul listener
 * `upgrade`, routant explicitement par pathname vers l'instance `noServer: true` concernée,
 * évite ce piège (c'est le pattern documenté par `ws` pour le multi-chemin).
 */
export class WsUpgradeRouter {
  private readonly routes = new Map<string, WebSocketServer>();
  private attached = false;

  attach(server: Server): void {
    if (this.attached) return;
    this.attached = true;
    server.on("upgrade", (req: IncomingMessage, socket: Socket, head: Buffer) => {
      const pathname = new URL(req.url || "/", "http://localhost").pathname;
      const wss = this.routes.get(pathname);
      if (!wss) {
        socket.destroy();
        return;
      }
      wss.handleUpgrade(req, socket, head, (ws) => wss.emit("connection", ws, req));
    });
  }

  /** Crée (ou renvoie) le WebSocketServer `noServer` associé à ce chemin exact. */
  register(path: string): WebSocketServer {
    const existing = this.routes.get(path);
    if (existing) return existing;
    const wss = new WebSocketServer({ noServer: true });
    this.routes.set(path, wss);
    return wss;
  }

  dispose(): void {
    for (const wss of this.routes.values()) wss.close();
    this.routes.clear();
  }
}
