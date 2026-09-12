import { existsSync, readFileSync } from "node:fs";

export type McpServerTransportKind = "stdio" | "sse";

export interface McpServerDefinition {
  id: string;
  name: string;
  enabled: boolean;
  transport: McpServerTransportKind;
  /** transport stdio */
  command?: string;
  args?: string[];
  env?: Record<string, string>;
  /** transport sse */
  url?: string;
  headers?: Record<string, string>;
}

function isValidServer(value: unknown): value is McpServerDefinition {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const raw = value as Record<string, unknown>;
  if (typeof raw.id !== "string" || !raw.id.trim()) return false;
  if (typeof raw.name !== "string" || !raw.name.trim()) return false;
  if (typeof raw.enabled !== "boolean") return false;
  if (raw.transport === "stdio") return typeof raw.command === "string" && !!raw.command.trim();
  if (raw.transport === "sse") return typeof raw.url === "string" && !!raw.url.trim();
  return false;
}

/**
 * Registre des serveurs MCP externes déclarés par l'opérateur (config.mcp.configPath,
 * `config/mcp-servers.json` par défaut) — même tolérance aux erreurs que
 * SpecialistRegistry : une entrée invalide est ignorée et journalisée, jamais fatale.
 */
export class McpServerRegistry {
  private readonly servers: McpServerDefinition[] = [];
  readonly diagnostics: string[] = [];

  constructor(configPath?: string) {
    if (!configPath || !existsSync(configPath)) return;
    try {
      const values: unknown = JSON.parse(readFileSync(configPath, "utf8"));
      if (!Array.isArray(values)) throw new Error("root must be an array");
      const ids = new Set<string>();
      for (const raw of values) {
        if (!isValidServer(raw)) {
          this.diagnostics.push(`Invalid MCP server ignored: ${JSON.stringify(raw)}`);
          continue;
        }
        if (ids.has(raw.id)) {
          this.diagnostics.push(`Duplicate MCP server id ignored: ${raw.id}`);
          continue;
        }
        ids.add(raw.id);
        this.servers.push(raw);
      }
    } catch (error) {
      this.diagnostics.push(`Invalid MCP server registry: ${(error as Error).message}`);
    }
  }

  list(): McpServerDefinition[] {
    return [...this.servers];
  }

  enabled(): McpServerDefinition[] {
    return this.servers.filter((server) => server.enabled);
  }
}
