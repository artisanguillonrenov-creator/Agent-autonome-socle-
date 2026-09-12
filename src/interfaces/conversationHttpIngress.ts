import { createHash, randomUUID } from "node:crypto";
import type { IncomingMessage, Server, ServerResponse } from "node:http";
import { config } from "../config.js";
import { VoiceOutputFormatter } from "../voice/voiceOutputFormatter.js";
import { ConversationExecutionError, ConversationExecutionService } from "../persistence/conversations/conversationExecutionService.js";
import type { TurnExecutionResult } from "../persistence/conversations/types.js";

const MAX_BODY_BYTES = 1024 * 1024;

function sendJson(res: ServerResponse, status: number, body: unknown): void {
  if (res.headersSent || res.writableEnded) return;
  res.writeHead(status, {
    "content-type": "application/json; charset=utf-8",
    "access-control-allow-origin": "*",
    "access-control-allow-methods": "GET, POST, PATCH, DELETE, OPTIONS",
    "access-control-allow-headers": "Content-Type, Authorization",
  });
  res.end(JSON.stringify(body));
}

function authorized(req: IncomingMessage): boolean {
  return Boolean(config.api.token) && req.headers.authorization === `Bearer ${config.api.token}`;
}

async function readBody(req: IncomingMessage): Promise<string> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of req) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    size += buffer.length;
    if (size > MAX_BODY_BYTES) throw new ConversationExecutionError("PAYLOAD_TOO_LARGE", 413);
    chunks.push(buffer);
  }
  return Buffer.concat(chunks).toString("utf-8");
}

async function readJson(req: IncomingMessage): Promise<Record<string, any>> {
  try { return JSON.parse((await readBody(req)) || "{}"); }
  catch (error) {
    if (error instanceof ConversationExecutionError) throw error;
    throw new ConversationExecutionError("REQUEST_INVALID_JSON", 400);
  }
}

function legacyConversationId(workspaceId?: string): string {
  const scope = workspaceId?.trim() || "global";
  return `legacy-${createHash("sha256").update(scope).digest("hex").slice(0, 24)}`;
}

function resultStatus(result: TurnExecutionResult): number {
  if (result.result === "EXISTING_PROCESSING") return 202;
  if (result.result === "EXISTING_FAILED") return 409;
  return 200;
}

export interface ConversationHttpRuntime {
  dispose(): void;
}

/**
 * Installs durable conversation routes around the existing native node:http router and
 * the voice wrapper. Unhandled requests are delegated byte-for-byte to the previous listener.
 */
export function installConversationHttpIngress(
  server: Server,
  service: ConversationExecutionService,
): ConversationHttpRuntime {
  const previousListeners = server.listeners("request") as Array<(req: IncomingMessage, res: ServerResponse) => void>;
  if (previousListeners.length === 0) throw new Error("HTTP_REQUEST_LISTENER_MISSING");
  server.removeAllListeners("request");
  const formatter = new VoiceOutputFormatter(() => service.agent.getLLMProvider());

  const delegate = (req: IncomingMessage, res: ServerResponse): void => {
    for (const previous of previousListeners) previous.call(server, req, res);
  };

  const ensureSession = async (conversationId: string | undefined, workspaceId?: string) => {
    const normalized = conversationId?.trim();
    if (normalized) {
      const existing = await service.getSession(normalized);
      if (!existing) throw new ConversationExecutionError("SESSION_NOT_FOUND", 404);
      if (existing.status !== "ACTIVE") throw new ConversationExecutionError("CONVERSATION_ARCHIVED", 409);
      return existing;
    }
    const fallbackId = legacyConversationId(workspaceId);
    const existing = await service.getSession(fallbackId);
    if (existing) {
      if (existing.status !== "ACTIVE") throw new ConversationExecutionError("CONVERSATION_ARCHIVED", 409);
      return existing;
    }
    return service.repository.initializeSession(fallbackId, workspaceId?.trim() || null);
  };

  const listener = async (req: IncomingMessage, res: ServerResponse): Promise<void> => {
    const parsed = new URL(req.url || "/", "http://localhost");
    const pathname = parsed.pathname;
    const conversationPath = pathname === "/api/conversations"
      || /^\/api\/conversations\/[^/]+$/.test(pathname)
      || /^\/api\/conversations\/[^/]+\/messages$/.test(pathname)
      || /^\/api\/conversations\/[^/]+\/regenerate$/.test(pathname)
      || pathname === "/api/chat"
      || pathname === "/chat"
      || pathname === "/api/chat/regenerate"
      || pathname === "/api/chat/stream"
      || pathname === "/api/voice/command"
      || /^\/api\/voice\/commands\/[^/]+$/.test(pathname);

    if (!conversationPath) {
      delegate(req, res);
      return;
    }

    if (req.method === "OPTIONS") {
      res.writeHead(204, {
        "access-control-allow-origin": "*",
        "access-control-allow-methods": "GET, POST, PATCH, DELETE, OPTIONS",
        "access-control-allow-headers": "Content-Type, Authorization",
      });
      res.end();
      return;
    }
    if (!config.api.token) { sendJson(res, 503, { error: "API_TOKEN_NOT_CONFIGURED" }); return; }
    if (!authorized(req)) { sendJson(res, 401, { error: "unauthorized" }); return; }

    try {
      if (req.method === "POST" && pathname === "/api/conversations") {
        const body = await readJson(req);
        const workspaceId = typeof body.workspaceId === "string" && body.workspaceId.trim() ? body.workspaceId.trim() : null;
        const session = await service.createSession(workspaceId);
        sendJson(res, 201, session);
        return;
      }

      if (req.method === "GET" && pathname === "/api/conversations") {
        const workspaceParam = parsed.searchParams.get("workspaceId");
        const sessions = await service.listSessions(workspaceParam && workspaceParam.trim() ? workspaceParam.trim() : null);
        sendJson(res, 200, { items: sessions });
        return;
      }

      const sessionMatch = pathname.match(/^\/api\/conversations\/([^/]+)$/);
      if (sessionMatch) {
        const conversationId = decodeURIComponent(sessionMatch[1]);
        const session = await service.getSession(conversationId);
        if (!session) throw new ConversationExecutionError("SESSION_NOT_FOUND", 404);

        if (req.method === "GET") {
          sendJson(res, 200, session);
          return;
        }

        if (req.method === "PATCH") {
          if (session.status !== "ACTIVE") throw new ConversationExecutionError("CONVERSATION_ARCHIVED", 409);
          const body = await readJson(req);
          const title = typeof body.title === "string" ? body.title.replace(/\s+/g, " ").trim() : "";
          if (!title) throw new ConversationExecutionError("CONVERSATION_TITLE_REQUIRED", 400);
          if (title.length > 120) throw new ConversationExecutionError("CONVERSATION_TITLE_TOO_LONG", 400);
          await service.repository.updateSessionTitle(conversationId, title);
          const updated = await service.getSession(conversationId);
          sendJson(res, 200, updated);
          return;
        }

        if (req.method === "DELETE") {
          if (session.status !== "ACTIVE") {
            sendJson(res, 200, { conversationId, status: session.status });
            return;
          }
          await service.repository.archiveSession(conversationId);
          sendJson(res, 200, { conversationId, status: "ARCHIVED" });
          return;
        }
      }

      const messagesMatch = pathname.match(/^\/api\/conversations\/([^/]+)\/messages$/);
      if (req.method === "GET" && messagesMatch) {
        const conversationId = decodeURIComponent(messagesMatch[1]);
        const limit = Number(parsed.searchParams.get("limit") || "30");
        const beforeRaw = parsed.searchParams.get("beforeSequence");
        const before = beforeRaw == null ? undefined : Number(beforeRaw);
        const page = await service.getMessages(conversationId, Number.isFinite(limit) ? limit : 30, before != null && Number.isFinite(before) ? before : undefined);
        sendJson(res, 200, page);
        return;
      }

      if (req.method === "POST" && (pathname === "/api/chat" || pathname === "/chat")) {
        const body = await readJson(req);
        const workspaceId = typeof body.workspaceId === "string" && body.workspaceId.trim() ? body.workspaceId.trim() : undefined;
        const session = await ensureSession(typeof body.conversationId === "string" ? body.conversationId : undefined, workspaceId);
        const result = await service.handleTurn({
          requestKind: "MESSAGE",
          conversationId: session.conversationId,
          clientRequestId: typeof body.clientRequestId === "string" && body.clientRequestId.trim() ? body.clientRequestId.trim() : randomUUID(),
          payload: { message: typeof body.message === "string" ? body.message : "", ...(workspaceId ? { workspaceId } : {}) },
        });
        sendJson(res, resultStatus(result), { ...result, conversationId: session.conversationId, ...(result.result === "EXISTING_PROCESSING" ? { status: "PROCESSING" } : {}) });
        return;
      }

      const regenerateMatch = pathname.match(/^\/api\/conversations\/([^/]+)\/regenerate$/);
      if (req.method === "POST" && (pathname === "/api/chat/regenerate" || regenerateMatch)) {
        const body = await readJson(req);
        const requestedConversationId = regenerateMatch ? decodeURIComponent(regenerateMatch[1]) : (typeof body.conversationId === "string" ? body.conversationId : undefined);
        const session = await ensureSession(requestedConversationId);
        let targetMessageId = typeof body.targetMessageId === "string" ? body.targetMessageId.trim() : "";
        if (!targetMessageId) {
          const page = await service.getMessages(session.conversationId, 100);
          const lastAssistant = [...page.items].reverse().find((item) => item.message.role === "assistant" && !(item.message.toolCalls?.length));
          targetMessageId = lastAssistant?.messageId || "";
        }
        if (!targetMessageId) throw new ConversationExecutionError("NO_REGENERATABLE_RESPONSE", 409);
        const result = await service.handleTurn({
          requestKind: "REGENERATE",
          conversationId: session.conversationId,
          clientRequestId: typeof body.clientRequestId === "string" && body.clientRequestId.trim() ? body.clientRequestId.trim() : randomUUID(),
          payload: { targetMessageId },
        });
        sendJson(res, resultStatus(result), result);
        return;
      }

      if ((req.method === "GET" || req.method === "POST") && pathname === "/api/chat/stream") {
        // POST est le chemin recommandé : un prompt long ou collé (document, code) ne
        // risque plus de dépasser une limite de longueur d'URL et n'atterrit plus dans
        // les journaux d'accès HTTP. GET reste accepté (query string) pour compatibilité
        // ascendante avec d'éventuels appelants existants.
        const body = req.method === "POST" ? await readJson(req) : {};
        const message = (typeof body.message === "string" ? body.message : parsed.searchParams.get("message") || "").trim();
        if (!message) throw new ConversationExecutionError("MESSAGE_REQUIRED", 400);
        const workspaceId = (typeof body.workspaceId === "string" ? body.workspaceId : parsed.searchParams.get("workspaceId") || "").trim() || undefined;
        const conversationIdParam = typeof body.conversationId === "string" ? body.conversationId : parsed.searchParams.get("conversationId") || undefined;
        const session = await ensureSession(conversationIdParam, workspaceId);
        const clientRequestId = (typeof body.clientRequestId === "string" ? body.clientRequestId : parsed.searchParams.get("clientRequestId") || "").trim() || randomUUID();
        res.writeHead(200, {
          "content-type": "text/event-stream",
          "cache-control": "no-cache",
          connection: "keep-alive",
          "access-control-allow-origin": "*",
        });
        res.write(`data: ${JSON.stringify({ type: "thought", content: "Analyse de la demande en cours...", conversationId: session.conversationId })}\n\n`);
        try {
          const result = await service.handleTurn({
            requestKind: "MESSAGE",
            conversationId: session.conversationId,
            clientRequestId,
            payload: { message, ...(workspaceId ? { workspaceId } : {}) },
          });
          if (result.result === "EXISTING_PROCESSING") {
            res.write(`data: ${JSON.stringify({ type: "processing", conversationId: session.conversationId })}\n\n`);
          } else if (result.result === "EXISTING_FAILED") {
            res.write(`data: ${JSON.stringify({ type: "error", error: result.failureReason })}\n\n`);
          } else {
            // Le fournisseur LLM ne diffuse pas encore les tokens au fil de la génération
            // (voir src/llm/provider.ts) : la réponse complète est déjà disponible ici.
            // On la restitue quand même en flux SSE mot par mot pour un rendu progressif
            // fidèle côté client, sans changement de contrat le jour où un provider
            // proposera un vrai streaming token par token.
            const words = result.response.split(/(\s+)/).filter((part) => part.length > 0);
            for (const word of words) {
              if (res.writableEnded) break;
              res.write(`data: ${JSON.stringify({ type: "token", content: word, conversationId: session.conversationId })}\n\n`);
              await new Promise((resolve) => setTimeout(resolve, 12));
            }
            res.write(`data: ${JSON.stringify({ type: "done", iterations: result.iterations, pendingAction: result.pendingAction, conversationId: session.conversationId })}\n\n`);
          }
          res.write("data: [DONE]\n\n");
          res.end();
        } catch (error) {
          res.write(`data: ${JSON.stringify({ type: "error", error: error instanceof Error ? error.message : "CHAT_STREAM_FAILED" })}\n\n`);
          res.end();
        }
        return;
      }

      if (req.method === "POST" && pathname === "/api/voice/command") {
        const body = await readJson(req);
        const voiceCommandId = typeof body.voiceCommandId === "string" ? body.voiceCommandId.trim() : "";
        const message = typeof body.message === "string" ? body.message.trim() : "";
        const workspaceId = typeof body.workspaceId === "string" && body.workspaceId.trim() ? body.workspaceId.trim() : undefined;
        if (!voiceCommandId) throw new ConversationExecutionError("VOICE_COMMAND_ID_INVALID", 400);
        if (!message) throw new ConversationExecutionError("VOICE_MESSAGE_REQUIRED", 400);
        const session = await ensureSession(typeof body.conversationId === "string" ? body.conversationId : undefined, workspaceId);
        const result = await service.handleTurn({
          requestKind: "MESSAGE",
          conversationId: session.conversationId,
          voiceCommandId,
          payload: { message, ...(workspaceId ? { workspaceId } : {}) },
        });
        if (result.result === "EXISTING_PROCESSING") {
          sendJson(res, 202, { voiceCommandId, conversationId: session.conversationId, status: "PROCESSING" });
          return;
        }
        if (result.result === "EXISTING_FAILED") {
          sendJson(res, 409, { error: "VOICE_COMMAND_RECOVERY_REQUIRED", voiceCommandId, conversationId: session.conversationId, status: "RECOVERY_REQUIRED" });
          return;
        }
        const speechText = await formatter.format(result.response, config.voice.responseMode);
        sendJson(res, 200, { voiceCommandId, conversationId: session.conversationId, response: result.response, iterations: result.iterations, ...(result.pendingAction ? { pendingAction: result.pendingAction } : {}), speechText });
        return;
      }

      const commandMatch = pathname.match(/^\/api\/voice\/commands\/([^/]+)$/);
      if (req.method === "GET" && commandMatch) {
        const voiceCommandId = decodeURIComponent(commandMatch[1]);
        const lookup = service.repository.findTurnByVoiceCommandId;
        const turn = lookup ? await lookup(voiceCommandId) : null;
        if (!turn) {
          delegate(req, res); // Legacy Chantier-10 row compatibility.
          return;
        }
        if (turn.status === "ACCEPTED" || turn.status === "RUNNING") {
          sendJson(res, 200, { voiceCommandId, conversationId: turn.conversationId, status: "RUNNING" });
          return;
        }
        if (turn.status === "FAILED") {
          sendJson(res, 200, { voiceCommandId, conversationId: turn.conversationId, status: "RECOVERY_REQUIRED", error: "VOICE_COMMAND_RECOVERY_REQUIRED" });
          return;
        }
        const completed = await service.repository.getCompletedTurnResult(turn.turnId);
        if (!completed) throw new ConversationExecutionError("COMPLETED_TURN_RESULT_MISSING", 500);
        const speechText = await formatter.format(completed.response, config.voice.responseMode);
        sendJson(res, 200, { voiceCommandId, conversationId: turn.conversationId, status: "DONE", ...completed, speechText });
        return;
      }

      delegate(req, res);
    } catch (error) {
      if (error instanceof ConversationExecutionError) {
        sendJson(res, error.httpStatus, { error: error.code });
        return;
      }
      const message = error instanceof Error ? error.message : "CONVERSATION_REQUEST_FAILED";
      const status = message === "CONVERSATION_WORKSPACE_MISMATCH" || message === "IDEMPOTENCY_KEY_REUSE_MISMATCH" ? 409 : 500;
      sendJson(res, status, { error: message.slice(0, 200) });
    }
  };

  server.on("request", listener);
  return {
    dispose() {
      server.off("request", listener);
      for (const previous of previousListeners) server.on("request", previous);
    },
  };
}
