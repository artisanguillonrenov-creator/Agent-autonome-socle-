import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { createInterface } from "node:readline";
import { request as httpRequest } from "node:http";
import { request as httpsRequest } from "node:https";
import { URL } from "node:url";
import type { JsonRpcMessage } from "./mcpProtocol.js";

/**
 * Transport-agnostique : le McpClient ne connaît que cette interface, jamais les
 * détails de stdio ou SSE — ce qui permet d'ajouter d'autres transports MCP futurs
 * sans toucher au client.
 */
export interface McpTransport {
  send(message: JsonRpcMessage): void;
  onMessage(handler: (message: JsonRpcMessage) => void): void;
  onClose(handler: (error?: Error) => void): void;
  close(): Promise<void>;
}

/**
 * Transport stdio : un process serveur MCP local, un message JSON-RPC par ligne
 * sur stdin/stdout (spécification MCP — pas de framing Content-Length comme LSP).
 */
export class StdioMcpTransport implements McpTransport {
  private readonly child: ChildProcessWithoutNullStreams;
  private messageHandler: (message: JsonRpcMessage) => void = () => {};
  private closeHandler: (error?: Error) => void = () => {};
  private closed = false;

  constructor(command: string, args: string[] = [], env?: Record<string, string>) {
    this.child = spawn(command, args, { env: { ...process.env, ...env }, stdio: ["pipe", "pipe", "pipe"] });
    const rl = createInterface({ input: this.child.stdout });
    rl.on("line", (line) => {
      const trimmed = line.trim();
      if (!trimmed) return;
      try {
        this.messageHandler(JSON.parse(trimmed) as JsonRpcMessage);
      } catch {
        // Ligne non-JSON (log serveur égaré sur stdout) : ignorée plutôt que fatale.
      }
    });
    this.child.stderr.on("data", () => {
      // Les logs serveur sur stderr ne sont pas du protocole ; on ne les propage pas.
    });
    this.child.on("error", (error) => this.emitClose(error));
    this.child.on("exit", (code) => this.emitClose(code && code !== 0 ? new Error(`MCP_SERVER_EXITED_${code}`) : undefined));
  }

  private emitClose(error?: Error): void {
    if (this.closed) return;
    this.closed = true;
    this.closeHandler(error);
  }

  send(message: JsonRpcMessage): void {
    this.child.stdin.write(`${JSON.stringify(message)}\n`);
  }

  onMessage(handler: (message: JsonRpcMessage) => void): void {
    this.messageHandler = handler;
  }

  onClose(handler: (error?: Error) => void): void {
    this.closeHandler = handler;
  }

  async close(): Promise<void> {
    if (this.closed) return;
    this.closed = true;
    this.child.stdin.end();
    this.child.kill();
  }
}

/**
 * Transport HTTP+SSE : le client POSTe ses requêtes JSON-RPC sur l'endpoint annoncé
 * par le serveur, et reçoit réponses/notifications via un flux SSE persistant ouvert
 * en GET sur l'URL du serveur. Implémentation volontairement minimale (pas de
 * dépendance externe) : suffisante pour les serveurs MCP conformes au transport
 * HTTP+SSE de référence.
 */
export class SseMcpTransport implements McpTransport {
  private messageHandler: (message: JsonRpcMessage) => void = () => {};
  private closeHandler: (error?: Error) => void = () => {};
  private postEndpoint: string | null = null;
  private readonly pendingBeforeEndpoint: JsonRpcMessage[] = [];
  private closed = false;

  constructor(private readonly baseUrl: string, private readonly headers: Record<string, string> = {}) {
    this.connectStream();
  }

  private client(url: string) {
    return url.startsWith("https:") ? httpsRequest : httpRequest;
  }

  private connectStream(): void {
    const url = new URL(this.baseUrl);
    const req = this.client(this.baseUrl)(url, { method: "GET", headers: { accept: "text/event-stream", ...this.headers } }, (res) => {
      let buffer = "";
      res.setEncoding("utf8");
      res.on("data", (chunk: string) => {
        buffer += chunk;
        let boundary: number;
        while ((boundary = buffer.indexOf("\n\n")) !== -1) {
          const frame = buffer.slice(0, boundary);
          buffer = buffer.slice(boundary + 2);
          this.handleFrame(frame);
        }
      });
      res.on("end", () => this.emitClose());
      res.on("error", (error) => this.emitClose(error));
    });
    req.on("error", (error) => this.emitClose(error));
    req.end();
  }

  private handleFrame(frame: string): void {
    let eventName = "message";
    const dataLines: string[] = [];
    for (const line of frame.split("\n")) {
      if (line.startsWith("event:")) eventName = line.slice(6).trim();
      else if (line.startsWith("data:")) dataLines.push(line.slice(5).trim());
    }
    const data = dataLines.join("\n");
    if (eventName === "endpoint") {
      this.postEndpoint = new URL(data, this.baseUrl).toString();
      for (const pending of this.pendingBeforeEndpoint.splice(0)) this.send(pending);
      return;
    }
    if (!data) return;
    try {
      this.messageHandler(JSON.parse(data) as JsonRpcMessage);
    } catch {
      // Frame SSE non-JSON-RPC (commentaire keep-alive...) : ignorée.
    }
  }

  private emitClose(error?: Error): void {
    if (this.closed) return;
    this.closed = true;
    this.closeHandler(error);
  }

  send(message: JsonRpcMessage): void {
    if (!this.postEndpoint) {
      this.pendingBeforeEndpoint.push(message);
      return;
    }
    const url = new URL(this.postEndpoint);
    const body = JSON.stringify(message);
    const req = this.client(this.postEndpoint)(
      url,
      { method: "POST", headers: { "content-type": "application/json", "content-length": Buffer.byteLength(body).toString(), ...this.headers } },
      (res) => res.resume(),
    );
    req.on("error", (error) => this.emitClose(error));
    req.end(body);
  }

  onMessage(handler: (message: JsonRpcMessage) => void): void {
    this.messageHandler = handler;
  }

  onClose(handler: (error?: Error) => void): void {
    this.closeHandler = handler;
  }

  async close(): Promise<void> {
    this.closed = true;
  }
}
