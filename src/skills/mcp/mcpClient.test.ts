import { test } from "node:test";
import assert from "node:assert/strict";
import { fileURLToPath } from "node:url";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { McpClient, flattenMcpToolResult } from "./mcpClient.js";
import { StdioMcpTransport } from "./mcpTransport.js";
import type { JsonRpcMessage } from "./mcpProtocol.js";
import { McpServerRegistry } from "./mcpServerRegistry.js";
import { connectMcpServers, closeMcpClients } from "./mcpSkillBridge.js";

const fixturePath = fileURLToPath(new URL("./fixtures/fakeStdioServer.mjs", import.meta.url));

class FakeTransport {
  private messageHandler: (message: JsonRpcMessage) => void = () => {};
  private closeHandler: (error?: Error) => void = () => {};
  sent: JsonRpcMessage[] = [];
  respondWith(message: JsonRpcMessage) {
    this.messageHandler(message);
  }
  send(message: JsonRpcMessage) {
    this.sent.push(message);
  }
  onMessage(handler: (message: JsonRpcMessage) => void) {
    this.messageHandler = handler;
  }
  onClose(handler: (error?: Error) => void) {
    this.closeHandler = handler;
  }
  triggerClose(error?: Error) {
    this.closeHandler(error);
  }
  async close() {}
}

test("McpClient corrèle requêtes et réponses par id et résout la promesse correspondante", async () => {
  const transport = new FakeTransport();
  const client = new McpClient(transport as any, 5000);
  const promise = client.listTools();
  const request = transport.sent.find((m) => "method" in m && m.method === "tools/list");
  assert.ok(request && "id" in request);
  transport.respondWith({ jsonrpc: "2.0", id: (request as any).id, result: { tools: [{ name: "t1", inputSchema: { type: "object" } }] } });
  const tools = await promise;
  assert.equal(tools.length, 1);
  assert.equal(tools[0].name, "t1");
});

test("McpClient propage une erreur JSON-RPC comme rejet de promesse", async () => {
  const transport = new FakeTransport();
  const client = new McpClient(transport as any, 5000);
  const promise = client.listTools();
  const request = transport.sent[0] as any;
  transport.respondWith({ jsonrpc: "2.0", id: request.id, error: { code: -32000, message: "boom" } });
  await assert.rejects(promise, /MCP_ERROR_-32000/);
});

test("McpClient rejette les appels en attente quand le transport se ferme", async () => {
  const transport = new FakeTransport();
  const client = new McpClient(transport as any, 5000);
  const promise = client.listTools();
  transport.triggerClose(new Error("PIPE_BROKEN"));
  await assert.rejects(promise, /PIPE_BROKEN/);
  await assert.rejects(client.listTools(), /PIPE_BROKEN/);
});

test("McpClient rejette après le délai imparti si aucune réponse n'arrive", async () => {
  const transport = new FakeTransport();
  const client = new McpClient(transport as any, 20);
  await assert.rejects(client.listTools(), /MCP_REQUEST_TIMEOUT/);
});

test("flattenMcpToolResult concatène les blocs texte et signale une erreur serveur", () => {
  assert.equal(flattenMcpToolResult({ content: [{ type: "text", text: "hello" }] }), "hello");
  assert.match(flattenMcpToolResult({ content: [{ type: "text", text: "bad" }], isError: true }), /Erreur MCP: bad/);
});

test("StdioMcpTransport + McpClient : cycle complet initialize -> tools/list -> tools/call contre un vrai process", async () => {
  const transport = new StdioMcpTransport(process.execPath, [fixturePath]);
  const client = new McpClient(transport, 10_000);
  try {
    const init = await client.initialize({ name: "test-client", version: "1.0.0" });
    assert.equal(init.serverInfo?.name, "fake-mcp-server");

    const tools = await client.listTools();
    assert.equal(tools.length, 1);
    assert.equal(tools[0].name, "echo");

    const result = await client.callTool("echo", { text: "hi" });
    assert.equal(flattenMcpToolResult(result), "echo:hi");

    const failed = await client.callTool("echo", { text: "__FAIL__" });
    assert.match(flattenMcpToolResult(failed), /Erreur MCP: boom/);
  } finally {
    await client.close();
  }
});

test("connectMcpServers() découvre les outils d'un serveur stdio et les expose comme SkillDefinition exécutables", async () => {
  const dir = mkdtempSync(join(tmpdir(), "mcp-servers-test-"));
  const configPath = join(dir, "mcp-servers.json");
  writeFileSync(
    configPath,
    JSON.stringify([{ id: "fake", name: "Fake MCP Server", enabled: true, transport: "stdio", command: process.execPath, args: [fixturePath] }]),
  );
  try {
    const registry = new McpServerRegistry(configPath);
    const bridge = await connectMcpServers(registry, { connectTimeoutMs: 10_000, requestTimeoutMs: 10_000 });

    assert.equal(bridge.statuses.length, 1);
    assert.equal(bridge.statuses[0].connected, true);
    assert.equal(bridge.statuses[0].toolCount, 1);
    assert.equal(bridge.skills.length, 1);

    const skill = bridge.skills[0];
    assert.equal(skill.name, "mcp__fake__echo");
    assert.equal(skill.executionTarget, "MCP_TOOL");
    const result = await skill.handler!({ text: "world" }, { rememberFact: () => undefined });
    assert.equal(result, "echo:world");

    await closeMcpClients(bridge.clients);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("connectMcpServers() isole l'échec d'un serveur sans bloquer les autres", async () => {
  const dir = mkdtempSync(join(tmpdir(), "mcp-servers-test-fail-"));
  const configPath = join(dir, "mcp-servers.json");
  writeFileSync(
    configPath,
    JSON.stringify([
      { id: "broken", name: "Broken Server", enabled: true, transport: "stdio", command: process.execPath, args: ["/path/does/not/exist.mjs"] },
      { id: "fake", name: "Fake MCP Server", enabled: true, transport: "stdio", command: process.execPath, args: [fixturePath] },
    ]),
  );
  try {
    const registry = new McpServerRegistry(configPath);
    const bridge = await connectMcpServers(registry, { connectTimeoutMs: 3_000, requestTimeoutMs: 3_000 });
    const broken = bridge.statuses.find((s) => s.serverId === "broken");
    const fake = bridge.statuses.find((s) => s.serverId === "fake");
    assert.equal(broken?.connected, false);
    assert.equal(fake?.connected, true);
    await closeMcpClients(bridge.clients);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
