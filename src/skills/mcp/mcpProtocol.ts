/**
 * Sous-ensemble typé du protocole JSON-RPC 2.0 utilisé par MCP (Model Context
 * Protocol). On ne modélise que ce dont le client a besoin : l'établissement
 * de session (`initialize`), la découverte d'outils (`tools/list`) et leur
 * exécution (`tools/call`) — le strict nécessaire pour brancher des serveurs
 * MCP externes comme s'ils étaient des compétences locales.
 */
export interface JsonRpcRequest {
  jsonrpc: "2.0";
  id: number | string;
  method: string;
  params?: Record<string, unknown>;
}

export interface JsonRpcNotification {
  jsonrpc: "2.0";
  method: string;
  params?: Record<string, unknown>;
}

export interface JsonRpcSuccess {
  jsonrpc: "2.0";
  id: number | string;
  result: unknown;
}

export interface JsonRpcFailure {
  jsonrpc: "2.0";
  id: number | string;
  error: { code: number; message: string; data?: unknown };
}

export type JsonRpcResponse = JsonRpcSuccess | JsonRpcFailure;
export type JsonRpcMessage = JsonRpcRequest | JsonRpcNotification | JsonRpcResponse;

export function isJsonRpcResponse(message: JsonRpcMessage): message is JsonRpcResponse {
  return "id" in message && ("result" in message || "error" in message);
}

export interface McpToolDescriptor {
  name: string;
  description?: string;
  inputSchema: {
    type: "object";
    properties?: Record<string, unknown>;
    required?: string[];
  };
}

export interface McpToolsListResult {
  tools: McpToolDescriptor[];
  nextCursor?: string;
}

export interface McpToolCallResult {
  content: Array<{ type: "text"; text: string } | { type: string; [key: string]: unknown }>;
  isError?: boolean;
}

export interface McpInitializeResult {
  protocolVersion: string;
  serverInfo?: { name: string; version?: string };
  capabilities?: Record<string, unknown>;
}

export const MCP_PROTOCOL_VERSION = "2024-11-05";
