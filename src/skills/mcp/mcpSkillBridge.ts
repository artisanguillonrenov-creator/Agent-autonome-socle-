import { ActivityStore } from "../../observability/activityStore.js";
import type { SkillDefinition, SkillParameterSchema } from "../../types.js";
import { McpClient, flattenMcpToolResult } from "./mcpClient.js";
import type { McpServerDefinition, McpServerRegistry } from "./mcpServerRegistry.js";
import { SseMcpTransport, StdioMcpTransport, type McpTransport } from "./mcpTransport.js";

export interface McpConnectionStatus {
  serverId: string;
  name: string;
  connected: boolean;
  toolCount: number;
  error?: string;
}

export interface McpBridgeResult {
  skills: SkillDefinition[];
  clients: Map<string, McpClient>;
  statuses: McpConnectionStatus[];
}

function buildTransport(server: McpServerDefinition): McpTransport {
  if (server.transport === "stdio") {
    if (!server.command) throw new Error("MCP_STDIO_COMMAND_REQUIRED");
    return new StdioMcpTransport(server.command, server.args ?? [], server.env);
  }
  if (!server.url) throw new Error("MCP_SSE_URL_REQUIRED");
  return new SseMcpTransport(server.url, server.headers ?? {});
}

function withTimeout<T>(promise: Promise<T>, ms: number, label: string): Promise<T> {
  return Promise.race([
    promise,
    new Promise<T>((_, reject) => setTimeout(() => reject(new Error(`${label}_TIMEOUT`)), ms)),
  ]);
}

function toSkillName(serverId: string, toolName: string): string {
  return `mcp__${serverId}__${toolName}`;
}

/**
 * Standardisation MCP : se connecte à chaque serveur MCP externe activé, découvre
 * dynamiquement ses outils (tools/list) et les expose comme des SkillDefinition
 * normales — exécutables par l'agent exactement comme une compétence locale
 * (accès GitHub, exécution de code, Google Drive, ou tout autre serveur MCP tiers).
 * Une connexion en échec pour un serveur donné est journalisée et ignorée : elle
 * ne doit jamais empêcher le démarrage de l'agent ni la disponibilité des autres
 * serveurs/compétences.
 */
export async function connectMcpServers(registry: McpServerRegistry, options: { connectTimeoutMs: number; requestTimeoutMs: number }): Promise<McpBridgeResult> {
  const activity = new ActivityStore();
  const skills: SkillDefinition[] = [];
  const clients = new Map<string, McpClient>();
  const statuses: McpConnectionStatus[] = [];

  for (const server of registry.enabled()) {
    try {
      const transport = buildTransport(server);
      const client = new McpClient(transport, options.requestTimeoutMs);
      await withTimeout(client.initialize({ name: "agent-autonome-socle", version: "0.1.0" }), options.connectTimeoutMs, "MCP_INITIALIZE");
      const tools = await withTimeout(client.listTools(), options.connectTimeoutMs, "MCP_LIST_TOOLS");
      clients.set(server.id, client);

      for (const tool of tools) {
        const skillName = toSkillName(server.id, tool.name);
        const parameters: SkillParameterSchema = {
          type: "object",
          properties: tool.inputSchema.properties ?? {},
          required: tool.inputSchema.required,
        };
        skills.push({
          name: skillName,
          displayName: `${server.name}: ${tool.name}`,
          description: tool.description || `Outil distant '${tool.name}' fourni par le serveur MCP '${server.name}'.`,
          category: "Technique",
          kind: "SKILL",
          availability: "AVAILABLE",
          exposure: "DYNAMIC",
          risk: "MEDIUM",
          executionTarget: "MCP_TOOL",
          tags: ["mcp", server.id],
          argsHint: JSON.stringify(tool.inputSchema),
          parameters,
          handler: async (input) => flattenMcpToolResult(await client.callTool(tool.name, input)),
        });
        activity.append({ eventType: "MCP_TOOL_DISCOVERED", message: `MCP tool discovered: ${skillName}`, metadata: { serverId: server.id, tool: tool.name } });
      }

      statuses.push({ serverId: server.id, name: server.name, connected: true, toolCount: tools.length });
      activity.append({ eventType: "MCP_SERVER_CONNECTED", message: `MCP server connected: ${server.name}`, metadata: { serverId: server.id, toolCount: tools.length } });
    } catch (error) {
      const message = (error as Error).message;
      statuses.push({ serverId: server.id, name: server.name, connected: false, toolCount: 0, error: message });
      activity.append({ eventType: "MCP_SERVER_FAILED", level: "error", message: `MCP server connection failed: ${server.name} (${message})`, metadata: { serverId: server.id } });
    }
  }

  return { skills, clients, statuses };
}

export async function closeMcpClients(clients: Map<string, McpClient>): Promise<void> {
  await Promise.all([...clients.values()].map((client) => client.close().catch(() => undefined)));
}
