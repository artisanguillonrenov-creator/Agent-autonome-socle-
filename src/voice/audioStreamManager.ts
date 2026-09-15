import { WebSocketServer, type WebSocket, type RawData } from "ws";
import type { Server, IncomingMessage } from "node:http";
import { randomUUID } from "node:crypto";
import type { Agent } from "../core/agent.js";
import { config } from "../config.js";
import { createSttProvider, type SttProvider } from "./sttProvider.js";
import { createTtsProvider, type TtsProvider } from "./ttsProvider.js";
import { AudioSessionStore } from "./audioSessionStore.js";
import { VoiceOutputFormatter } from "./voiceOutputFormatter.js";
import { autonomyEventBus } from "../autonomy/eventBus.js";

interface PendingUtterance {
  chunks: Buffer[];
  bytes: number;
  silenceMs: number;
  lastChunkAt: number;
}

interface AudioSession {
  sessionId: string;
  ws: WebSocket | null;
  workspaceId?: string;
  sampleRateHz: number;
  utterance: PendingUtterance;
  processing: boolean;
  disconnectTimer?: NodeJS.Timeout;
  turnSequence: number;
}

const BYTES_PER_SAMPLE = 2; // PCM16LE

function toBuffer(data: RawData): Buffer {
  if (Buffer.isBuffer(data)) return data;
  if (Array.isArray(data)) return Buffer.concat(data);
  return Buffer.from(data);
}

/** VAD énergie légère (RMS sur l'échantillon PCM16) — suffisant pour distinguer silence/parole sans dépendance native. */
function frameRms(frame: Buffer): number {
  const sampleCount = Math.floor(frame.length / BYTES_PER_SAMPLE);
  if (sampleCount === 0) return 0;
  let sumSquares = 0;
  for (let i = 0; i < sampleCount; i += 1) {
    const sample = frame.readInt16LE(i * BYTES_PER_SAMPLE);
    sumSquares += sample * sample;
  }
  return Math.sqrt(sumSquares / sampleCount);
}

/**
 * Vague 9A/9B/9C (streaming audio bidirectionnel, pipeline STT/TTS faible latence, idempotence
 * avancée) : gestionnaire WebSocket recevant des chunks audio PCM16 bruts envoyés en continu
 * par l'application Android, sans attendre une déconnexion pour savoir que l'utilisateur a
 * fini de parler.
 *
 * Protocole :
 * - Connexion : `wss://host{config.audio.wsPath}?token=<API_TOKEN>&sessionId=<uuid?>&workspaceId=<?>&sampleRateHz=<16000?>`.
 *   `sessionId` absent -> une nouvelle session est créée et renvoyée dans le premier message de contrôle.
 * - Frames binaires entrantes : PCM16LE mono, un chunk par message WebSocket.
 * - Frames texte (JSON) entrantes : `{"type":"config","sampleRateHz":number}` et
 *   `{"type":"end_of_stream"}` (fin de parole forcée par le client, sans attendre le VAD).
 * - Frames sortantes : contrôle JSON (`session`, `session_resumed`, `transcript`, `response_text`,
 *   `turn_complete`, `error`) et frames binaires (chunks audio TTS synthétisés, livrés dès qu'ils
 *   sont disponibles plutôt qu'en un seul bloc final).
 *
 * VAD (Vague 9A) : un silence cumulé >= config.audio.vadSilenceMs (500ms par défaut) après le
 * dernier chunk contenant de l'énergie déclare la fin de parole immédiatement — la latence de
 * bout en bout ne dépend donc jamais de la fermeture du socket.
 *
 * Idempotence (Vague 9C) : chaque pipeline (STT -> Agent.step -> TTS) tourne dans un objet
 * AudioSession indexé par sessionId, indépendant du WebSocket physique. Une déconnexion met
 * seulement `session.ws` à null pendant au plus config.audio.sessionGraceMs (30s) : le pipeline
 * en cours continue de tourner. Une reconnexion avec le même sessionId dans cette fenêtre
 * réattache le nouveau socket — si la réponse LLM était déjà calculée, elle est immédiatement
 * rejouée (`response_text`) et la synthèse TTS reprend sans jamais régénérer de jetons LLM.
 */
export class AudioStreamManager {
  private readonly sessions = new Map<string, AudioSession>();
  private readonly store = new AudioSessionStore();
  private wss?: WebSocketServer;
  private readonly formatter: VoiceOutputFormatter;

  constructor(
    private readonly agent: Agent,
    private readonly sttProvider: SttProvider = createSttProvider(),
    private readonly ttsProvider: TtsProvider = createTtsProvider(),
  ) {
    this.formatter = new VoiceOutputFormatter(() => agent.getLLMProvider());
  }

  attach(server: Server): void {
    this.wss = new WebSocketServer({ server, path: config.audio.wsPath });
    this.wss.on("connection", (ws, req) => this.onConnection(ws, req));
  }

  dispose(): void {
    this.wss?.close();
    for (const session of this.sessions.values()) {
      if (session.disconnectTimer) clearTimeout(session.disconnectTimer);
    }
    this.sessions.clear();
  }

  private onConnection(ws: WebSocket, req: IncomingMessage): void {
    const url = new URL(req.url || "/", "http://localhost");
    if (config.api.token && url.searchParams.get("token") !== config.api.token) {
      ws.close(4401, "unauthorized");
      return;
    }

    const requestedSessionId = url.searchParams.get("sessionId") || undefined;
    const workspaceId = url.searchParams.get("workspaceId") || undefined;
    const sampleRateHz = Number(url.searchParams.get("sampleRateHz")) || 16000;

    const existing = requestedSessionId ? this.sessions.get(requestedSessionId) : undefined;
    let session: AudioSession;
    if (existing) {
      if (existing.disconnectTimer) {
        clearTimeout(existing.disconnectTimer);
        existing.disconnectTimer = undefined;
      }
      existing.ws = ws;
      session = existing;
      this.sendControl(session, { type: "session_resumed", sessionId: session.sessionId, turnSequence: session.turnSequence });
      const persisted = this.store.get(session.sessionId);
      if (persisted?.responseText && persisted.state !== "LISTENING") {
        this.sendControl(session, { type: "response_text", text: persisted.responseText, turnSequence: session.turnSequence });
      }
    } else {
      const sessionId = requestedSessionId || randomUUID();
      session = {
        sessionId,
        ws,
        workspaceId,
        sampleRateHz,
        utterance: { chunks: [], bytes: 0, silenceMs: 0, lastChunkAt: Date.now() },
        processing: false,
        turnSequence: 0,
      };
      this.sessions.set(sessionId, session);
      this.store.getOrCreate(sessionId, workspaceId);
      this.sendControl(session, { type: "session", sessionId });
    }

    const activeSession = session;
    ws.on("message", (data: RawData, isBinary: boolean) => this.onMessage(activeSession, data, isBinary));
    ws.on("close", () => this.onClose(activeSession));
  }

  private sendControl(session: AudioSession, message: Record<string, unknown>): void {
    try {
      session.ws?.send(JSON.stringify(message));
    } catch {
      // Best-effort : le client peut être déconnecté au moment de l'envoi (Vague 9C).
    }
  }

  private onMessage(session: AudioSession, data: RawData, isBinary: boolean): void {
    if (!isBinary) {
      let parsed: unknown;
      try {
        parsed = JSON.parse(toBuffer(data).toString("utf-8"));
      } catch {
        return;
      }
      if (!parsed || typeof parsed !== "object") return;
      const message = parsed as Record<string, unknown>;
      if (message.type === "config" && Number.isFinite(message.sampleRateHz)) {
        session.sampleRateHz = Number(message.sampleRateHz);
      }
      if (message.type === "end_of_stream") void this.finalizeUtterance(session);
      return;
    }
    this.ingestChunk(session, toBuffer(data));
  }

  private ingestChunk(session: AudioSession, chunk: Buffer): void {
    if (session.processing) return; // Un énoncé est déjà en cours de traitement pour ce tour.
    const now = Date.now();
    const elapsedMs = now - session.utterance.lastChunkAt;
    session.utterance.lastChunkAt = now;
    session.utterance.chunks.push(chunk);
    session.utterance.bytes += chunk.length;

    const rms = frameRms(chunk);
    session.utterance.silenceMs = rms < config.audio.vadEnergyThreshold ? session.utterance.silenceMs + Math.max(elapsedMs, 0) : 0;

    if (session.utterance.silenceMs >= config.audio.vadSilenceMs && session.utterance.bytes > 0) {
      void this.finalizeUtterance(session);
    }
  }

  private async finalizeUtterance(session: AudioSession): Promise<void> {
    if (session.processing || session.utterance.bytes === 0) return;
    session.processing = true;
    const pcm = Buffer.concat(session.utterance.chunks);
    session.utterance = { chunks: [], bytes: 0, silenceMs: 0, lastChunkAt: Date.now() };
    const sampleRateHz = session.sampleRateHz;
    session.turnSequence += 1;
    const turnSequence = session.turnSequence;

    try {
      this.store.update(session.sessionId, { state: "TRANSCRIBING", turnSequence });
      const stt = await this.sttProvider.transcribe(pcm, sampleRateHz);
      if (!stt.ok || !stt.text?.trim()) {
        this.sendControl(session, { type: "error", error: stt.error ?? "STT_EMPTY_RESULT", turnSequence });
        this.store.update(session.sessionId, { state: "LISTENING", turnSequence });
        return;
      }

      const transcript = stt.text.trim();
      this.sendControl(session, { type: "transcript", text: transcript, turnSequence });
      this.store.update(session.sessionId, { state: "THINKING", transcript, turnSequence });

      // Vague 7B : changement d'état factuel notifié sur le bus d'autonomie, comme pour l'ingress HTTP.
      autonomyEventBus.publish({
        type: "VOICE_COMMAND_RECEIVED",
        source: "audio_stream",
        payload: { sessionId: session.sessionId, workspaceId: session.workspaceId ?? null },
      });

      const result = await this.agent.step(transcript, session.workspaceId, `audio-${session.sessionId}-${turnSequence}`);
      const speechText = await this.formatter.format(result.response, config.voice.responseMode);
      this.sendControl(session, { type: "response_text", text: result.response, turnSequence });
      this.store.update(session.sessionId, { state: "SPEAKING", responseText: result.response, ttsBytesSent: 0, turnSequence });

      await this.streamTts(session, speechText, turnSequence);
      this.store.update(session.sessionId, { state: "DONE", turnSequence });
      this.sendControl(session, { type: "turn_complete", turnSequence });
    } catch (error) {
      this.sendControl(session, { type: "error", error: (error as Error).message.slice(0, 300), turnSequence });
      this.store.update(session.sessionId, { state: "LISTENING", turnSequence });
    } finally {
      session.processing = false;
    }
  }

  /** Livre chaque chunk TTS dès qu'il est disponible (Vague 9B) — jamais après génération complète du texte. */
  private async streamTts(session: AudioSession, text: string, turnSequence: number): Promise<void> {
    let bytesSent = 0;
    try {
      for await (const chunk of this.ttsProvider.synthesize(text)) {
        if (session.turnSequence !== turnSequence) return; // Un nouveau tour a démarré entre-temps.
        try {
          session.ws?.send(chunk.audio);
        } catch {
          // Le client peut être temporairement déconnecté (Vague 9C) : le pipeline continue quand même,
          // le curseur ttsBytesSent permet de reprendre après reconnexion.
        }
        bytesSent += chunk.audio.length;
        this.store.update(session.sessionId, { ttsBytesSent: bytesSent, turnSequence });
      }
    } catch (error) {
      this.sendControl(session, { type: "error", error: `TTS_FAILED: ${(error as Error).message}`, turnSequence });
    }
  }

  private onClose(session: AudioSession): void {
    session.ws = null;
    this.store.update(session.sessionId, { state: "DISCONNECTED", turnSequence: session.turnSequence });
    // Vague 9C : fenêtre de grâce avant expiration définitive — un pipeline en cours continue de tourner.
    session.disconnectTimer = setTimeout(() => {
      this.sessions.delete(session.sessionId);
    }, config.audio.sessionGraceMs);
    session.disconnectTimer.unref?.();
  }
}
