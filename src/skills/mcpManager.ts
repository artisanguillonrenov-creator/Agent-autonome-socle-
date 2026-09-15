/**
 * Point d'entrée unique pour l'intégration Model Context Protocol (MCP).
 *
 * L'implémentation complète (transports stdio/SSE, client JSON-RPC, registre des
 * serveurs déclarés, pont vers SkillDefinition) vit dans src/skills/mcp/ — voir
 * mcpTransport.ts, mcpClient.ts, mcpProtocol.ts, mcpServerRegistry.ts et
 * mcpSkillBridge.ts. Ce module ré-exporte cette API sous un nom unique et stable
 * (McpManager) pour que le reste du code n'ait besoin de connaître qu'un seul point
 * d'entrée : connecter des serveurs MCP externes, obtenir leurs outils traduits en
 * SkillDefinition (schéma JSON déjà conforme à SkillParameterSchema/ToolDefinition,
 * voir src/llm/provider.ts), et les fermer proprement.
 *
 * Agent (src/core/agent.ts) utilise directement connectMcpServers/closeMcpClients —
 * ce fichier existe pour tout appelant qui préfère une façade explicite (CLI de
 * diagnostic, tests, futurs intégrateurs) sans dupliquer la logique de connexion.
 */
import { McpServerRegistry, type McpServerDefinition, type McpServerTransportKind } from "./mcp/mcpServerRegistry.js";
import { connectMcpServers, closeMcpClients, type McpBridgeResult, type McpConnectionStatus } from "./mcp/mcpSkillBridge.js";
import { McpClient, flattenMcpToolResult } from "./mcp/mcpClient.js";
import type { McpToolDescriptor, McpToolCallResult } from "./mcp/mcpProtocol.js";
import { config } from "../config.js";

export type {
  McpServerDefinition,
  McpServerTransportKind,
  McpBridgeResult,
  McpConnectionStatus,
  McpToolDescriptor,
  McpToolCallResult,
};
export { McpClient, McpServerRegistry, flattenMcpToolResult };

export interface McpManagerOptions {
  configPath?: string;
  connectTimeoutMs?: number;
  requestTimeoutMs?: number;
}

/**
 * Façade de haut niveau : découvre les serveurs MCP déclarés (config/mcp-servers.json
 * par défaut), s'y connecte via stdio ou SSE selon leur définition, et renvoie leurs
 * outils déjà traduits en SkillDefinition prêtes à être enregistrées dans un
 * SkillRegistry — exactement le format que src/core/agent.ts fusionne avec les
 * compétences locales. Best-effort : un serveur en échec ne bloque jamais les autres
 * ni le démarrage de l'agent (voir McpConnectionStatus.error par serveur).
 */
export class McpManager {
  private clients = new Map<string, McpClient>();
  private statuses: McpConnectionStatus[] = [];

  constructor(private readonly options: McpManagerOptions = {}) {}

  async connect(): Promise<McpBridgeResult> {
    if (!config.mcp.enabled) return { skills: [], clients: new Map(), statuses: [] };
    const registry = new McpServerRegistry(this.options.configPath ?? config.mcp.configPath);
    const result = await connectMcpServers(registry, {
      connectTimeoutMs: this.options.connectTimeoutMs ?? config.mcp.connectTimeoutMs,
      requestTimeoutMs: this.options.requestTimeoutMs ?? config.mcp.requestTimeoutMs,
    });
    this.clients = result.clients;
    this.statuses = result.statuses;
    return result;
  }

  getStatuses(): McpConnectionStatus[] {
    return this.statuses;
  }

  getClient(serverId: string): McpClient | undefined {
    return this.clients.get(serverId);
  }

  async close(): Promise<void> {
    await closeMcpClients(this.clients);
    this.clients.clear();
  }
}
