// Serveur MCP minimal (stdio) utilisé uniquement par les tests : implémente juste
// assez du protocole (initialize, tools/list, tools/call) pour valider le transport
// stdio du client MCP de bout en bout, sans dépendance externe ni réseau.
import { createInterface } from "node:readline";

const rl = createInterface({ input: process.stdin });

function send(message) {
  process.stdout.write(`${JSON.stringify(message)}\n`);
}

rl.on("line", (line) => {
  const trimmed = line.trim();
  if (!trimmed) return;
  let message;
  try {
    message = JSON.parse(trimmed);
  } catch {
    return;
  }

  if (message.method === "initialize") {
    send({ jsonrpc: "2.0", id: message.id, result: { protocolVersion: "2024-11-05", serverInfo: { name: "fake-mcp-server", version: "1.0.0" }, capabilities: {} } });
    return;
  }
  if (message.method === "notifications/initialized") return;
  if (message.method === "tools/list") {
    send({
      jsonrpc: "2.0",
      id: message.id,
      result: {
        tools: [
          {
            name: "echo",
            description: "Echoes the provided text back.",
            inputSchema: { type: "object", properties: { text: { type: "string" } }, required: ["text"] },
          },
        ],
      },
    });
    return;
  }
  if (message.method === "tools/call") {
    const args = message.params?.arguments ?? {};
    if (args.text === "__FAIL__") {
      send({ jsonrpc: "2.0", id: message.id, result: { isError: true, content: [{ type: "text", text: "boom" }] } });
      return;
    }
    send({ jsonrpc: "2.0", id: message.id, result: { content: [{ type: "text", text: `echo:${args.text}` }] } });
    return;
  }
  if (message.id !== undefined) {
    send({ jsonrpc: "2.0", id: message.id, error: { code: -32601, message: "Method not found" } });
  }
});
