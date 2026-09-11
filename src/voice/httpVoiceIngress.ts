import type { IncomingMessage, Server, ServerResponse } from "node:http";
import type { Agent } from "../core/agent.js";
import { config } from "../config.js";
import { VoiceIngressStore, hashVoiceRequest, normalizeVoiceRequest } from "./voiceIngressStore.js";
import { VoiceOutputFormatter } from "./voiceOutputFormatter.js";
import { AlertRouter } from "./alertRouter.js";

const MAX_VOICE_BODY_BYTES = 64 * 1024;
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

function sendJson(res: ServerResponse, status: number, body: unknown): void {
  if (res.headersSent || res.writableEnded) return;
  res.writeHead(status, {
    "content-type": "application/json; charset=utf-8",
    "access-control-allow-origin": "*",
    "access-control-allow-methods": "GET, POST, OPTIONS",
    "access-control-allow-headers": "Content-Type, Authorization",
  });
  res.end(JSON.stringify(body));
}

async function readBodyBounded(req: IncomingMessage): Promise<string> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of req) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    size += buffer.length;
    if (size > MAX_VOICE_BODY_BYTES) throw new Error("VOICE_PAYLOAD_TOO_LARGE");
    chunks.push(buffer);
  }
  return Buffer.concat(chunks).toString("utf-8");
}

function authorized(req: IncomingMessage): boolean {
  return Boolean(config.api.token) && req.headers.authorization === `Bearer ${config.api.token}`;
}

function requireAuth(req: IncomingMessage, res: ServerResponse): boolean {
  if (!config.api.token) {
    sendJson(res, 503, { error: "API_TOKEN_NOT_CONFIGURED" });
    return false;
  }
  if (!authorized(req)) {
    sendJson(res, 401, { error: "unauthorized" });
    return false;
  }
  return true;
}

export interface VoiceHttpIngressRuntime {
  store: VoiceIngressStore;
  alertRouter: AlertRouter;
  dispose(): void;
}

/**
 * Adds the native voice-only routes without duplicating the existing HTTP API router.
 * All non-voice requests are delegated byte-for-byte to the original request listener.
 */
export function installVoiceHttpIngress(
  server: Server,
  agent: Agent,
  store = new VoiceIngressStore(),
  alertRouter = new AlertRouter(),
): VoiceHttpIngressRuntime {
  const formatter = new VoiceOutputFormatter(() => agent.getLLMProvider());
  const previousListeners = server.listeners("request") as Array<(req: IncomingMessage, res: ServerResponse) => void>;
  if (previousListeners.length === 0) throw new Error("HTTP_REQUEST_LISTENER_MISSING");
  server.removeAllListeners("request");

  const listener = async (req: IncomingMessage, res: ServerResponse): Promise<void> => {
    const parsedUrl = new URL(req.url || "/", "http://localhost");
    const pathname = parsedUrl.pathname;
    const isVoicePath = pathname === "/api/voice/command"
      || pathname.startsWith("/api/voice/commands/")
      || pathname === "/api/voice/alerts"
      || /^\/api\/voice\/alerts\/[^/]+\/ack$/.test(pathname);

    if (!isVoicePath) {
      for (const original of previousListeners) original.call(server, req, res);
      return;
    }

    if (req.method === "OPTIONS") {
      res.writeHead(204, {
        "access-control-allow-origin": "*",
        "access-control-allow-methods": "GET, POST, OPTIONS",
        "access-control-allow-headers": "Content-Type, Authorization",
      });
      res.end();
      return;
    }
    if (!requireAuth(req, res)) return;

    try {
      if (req.method === "POST" && pathname === "/api/voice/command") {
        let body: any;
        try {
          body = JSON.parse((await readBodyBounded(req)) || "{}");
        } catch (error) {
          const code = (error as Error).message;
          sendJson(res, code === "VOICE_PAYLOAD_TOO_LARGE" ? 413 : 400, { error: code === "VOICE_PAYLOAD_TOO_LARGE" ? code : "VOICE_REQUEST_INVALID_JSON" });
          return;
        }

        const voiceCommandId = typeof body.voiceCommandId === "string" ? body.voiceCommandId.trim() : "";
        const rawMessage = typeof body.message === "string" ? body.message : "";
        const rawWorkspaceId = typeof body.workspaceId === "string" ? body.workspaceId : undefined;
        if (!UUID_RE.test(voiceCommandId)) {
          sendJson(res, 400, { error: "VOICE_COMMAND_ID_INVALID" });
          return;
        }
        const normalized = normalizeVoiceRequest(rawMessage, rawWorkspaceId);
        if (!normalized.message) {
          sendJson(res, 400, { error: "VOICE_MESSAGE_REQUIRED" });
          return;
        }
        if (normalized.message.length > 20_000 || (normalized.workspaceId?.length ?? 0) > 512) {
          sendJson(res, 413, { error: "VOICE_PAYLOAD_TOO_LARGE" });
          return;
        }

        store.cleanupDone(config.voice.ingressTtlMs);
        const requestHash = hashVoiceRequest(normalized.message, normalized.workspaceId ?? undefined);
        const begin = store.begin(voiceCommandId, requestHash, normalized.workspaceId ?? undefined);
        if (begin.kind === "MISMATCH") {
          sendJson(res, 409, { error: "VOICE_COMMAND_ID_REUSE_MISMATCH", voiceCommandId });
          return;
        }
        if (begin.kind === "EXISTING") {
          if (begin.record.state === "DONE") {
            const stored = store.parseStoredResponse(begin.record);
            if (stored !== undefined) {
              sendJson(res, 200, stored);
              return;
            }
            sendJson(res, 500, { error: "VOICE_STORED_RESPONSE_INVALID", voiceCommandId });
            return;
          }
          if (begin.record.state === "RUNNING") {
            sendJson(res, 202, { voiceCommandId, status: "PROCESSING" });
            return;
          }
          sendJson(res, 409, { error: "VOICE_COMMAND_RECOVERY_REQUIRED", voiceCommandId, status: "RECOVERY_REQUIRED" });
          return;
        }

        try {
          const result = await agent.step(normalized.message, normalized.workspaceId ?? undefined);
          const speechText = await formatter.format(result.response, config.voice.responseMode);
          const response = { voiceCommandId, ...result, speechText };
          store.complete(voiceCommandId, response);
          sendJson(res, 200, response);
        } catch (error) {
          const message = (error as Error).message || "VOICE_AGENT_FAILED";
          store.markRecoveryRequired(voiceCommandId, message);
          sendJson(res, 500, { error: "VOICE_COMMAND_RECOVERY_REQUIRED", voiceCommandId });
        }
        return;
      }

      const commandMatch = pathname.match(/^\/api\/voice\/commands\/([^/]+)$/);
      if (req.method === "GET" && commandMatch) {
        const voiceCommandId = decodeURIComponent(commandMatch[1]);
        const record = store.get(voiceCommandId);
        if (!record) {
          sendJson(res, 404, { error: "VOICE_COMMAND_NOT_FOUND" });
          return;
        }
        const response = store.parseStoredResponse(record);
        sendJson(res, 200, {
          voiceCommandId,
          status: record.state,
          ...(record.state === "DONE" && response && typeof response === "object" ? response as Record<string, unknown> : {}),
          ...(record.state === "RECOVERY_REQUIRED" ? { error: "VOICE_COMMAND_RECOVERY_REQUIRED" } : {}),
        });
        return;
      }

      if (req.method === "GET" && pathname === "/api/voice/alerts") {
        sendJson(res, 200, { items: alertRouter.pendingNative() });
        return;
      }

      const ackMatch = pathname.match(/^\/api\/voice\/alerts\/([^/]+)\/ack$/);
      if (req.method === "POST" && ackMatch) {
        const ok = alertRouter.acknowledgeNative(decodeURIComponent(ackMatch[1]));
        sendJson(res, ok ? 200 : 404, ok ? { ok: true } : { error: "NATIVE_ALERT_NOT_FOUND" });
        return;
      }

      sendJson(res, 405, { error: "METHOD_NOT_ALLOWED" });
    } catch (error) {
      sendJson(res, 500, { error: "VOICE_INGRESS_FAILED", detail: (error as Error).message.slice(0, 200) });
    }
  };

  server.on("request", listener);
  return {
    store,
    alertRouter,
    dispose() {
      server.off("request", listener);
      for (const original of previousListeners) server.on("request", original);
    },
  };
}
