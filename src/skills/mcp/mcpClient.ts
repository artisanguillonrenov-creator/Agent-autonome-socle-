import { isJsonRpcResponse, MCP_PROTOCOL_VERSION } from "./mcpProtocol.js";
import type { JsonRpcMessage, McpInitializeResult, McpToolCallResult, McpToolDescriptor } from "./mcpProtocol.js";
import type { McpTransport } from "./mcpTransport.js";

interface PendingCall {
  resolve(value: unknown): void;
  reject(error: Error): void;
  timeout: NodeJS.Timeout;
}

/**
 * Client MCP générique : parle JSON-RPC à travers n'importe quel McpTransport
 * (stdio ou SSE), gère la corrélation requête/réponse par id et expose les trois
 * opérations dont l'agent a besoin pour traiter un serveur MCP distant comme une
 * bibliothèque de compétences : initialize, listTools, callTool.
 */
export class McpClient {
  private nextId = 1;
  private readonly pending = new Map<number | string, PendingCall>();
  private initialized: McpInitializeResult | null = null;
  private closedError: Error | null = null;

  constructor(private readonly transport: McpTransport, private readonly requestTimeoutMs = 60_000) {
    transport.onMessage((message) => this.handleMessage(message));
    transport.onClose((error) => this.handleClose(error));
  }

  private handleMessage(message: JsonRpcMessage): void {
    if (!isJsonRpcResponse(message)) return;
    const pending = this.pending.get(message.id);
    if (!pending) return;
    this.pending.delete(message.id);
    clearTimeout(pending.timeout);
    if ("error" in message) pending.reject(new Error(`MCP_ERROR_${message.error.code}: ${message.error.message}`));
    else pending.resolve(message.result);
  }

  private handleClose(error?: Error): void {
    this.closedError = error ?? new Error("MCP_TRANSPORT_CLOSED");
    for (const [id, pending] of this.pending) {
      clearTimeout(pending.timeout);
      pending.reject(this.closedError);
      this.pending.delete(id);
    }
  }

  private call<T>(method: string, params?: Record<string, unknown>): Promise<T> {
    if (this.closedError) return Promise.reject(this.closedError);
    const id = this.nextId++;
    return new Promise<T>((resolve, reject) => {
      const timeout = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`MCP_REQUEST_TIMEOUT: ${method}`));
      }, this.requestTimeoutMs);
      this.pending.set(id, { resolve: resolve as (value: unknown) => void, reject, timeout });
      this.transport.send({ jsonrpc: "2.0", id, method, params });
    });
  }

  private notify(method: string, params?: Record<string, unknown>): void {
    this.transport.send({ jsonrpc: "2.0", method, params });
  }

  /** Handshake MCP obligatoire avant tout autre appel. Idempotent. */
  async initialize(clientInfo: { name: string; version: string }): Promise<McpInitializeResult> {
    if (this.initialized) return this.initialized;
    const result = await this.call<McpInitializeResult>("initialize", {
      protocolVersion: MCP_PROTOCOL_VERSION,
      capabilities: {},
      clientInfo,
    });
    this.notify("notifications/initialized");
    this.initialized = result;
    return result;
  }

  async listTools(): Promise<McpToolDescriptor[]> {
    const tools: McpToolDescriptor[] = [];
    let cursor: string | undefined;
    do {
      const page = await this.call<{ tools: McpToolDescriptor[]; nextCursor?: string }>("tools/list", cursor ? { cursor } : undefined);
      tools.push(...page.tools);
      cursor = page.nextCursor;
    } while (cursor);
    return tools;
  }

  async callTool(name: string, args: Record<string, unknown>): Promise<McpToolCallResult> {
    return this.call<McpToolCallResult>("tools/call", { name, arguments: args });
  }

  async close(): Promise<void> {
    await this.transport.close();
  }
}

/** Aplati le contenu structuré d'un résultat d'outil MCP en texte exploitable par l'agent. */
export function flattenMcpToolResult(result: McpToolCallResult): string {
  const text = result.content
    .map((block) => ("text" in block && typeof block.text === "string" ? block.text : JSON.stringify(block)))
    .join("\n");
  return result.isError ? `Erreur MCP: ${text}` : text;
}
