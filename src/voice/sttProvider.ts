import { config } from "../config.js";

export interface SttResult {
  ok: boolean;
  text?: string;
  error?: string;
}

/**
 * Vague 9B : abstraction faible-latence de transcription (Whisper Live ou équivalent),
 * volontairement agnostique du fournisseur — même schéma que EmailProvider/SmsProvider
 * (src/email/emailProvider.ts, src/voice/smsProvider.ts) : une interface, un Noop explicite
 * qui échoue clairement si rien n'est configuré, et un Webhook HTTP générique. Un vrai
 * fournisseur streaming (websocket natif) peut être branché en implémentant cette interface
 * sans toucher à AudioStreamManager.
 */
export interface SttProvider {
  /** `pcm16` : mono 16-bit little-endian. `sampleRateHz` documente le taux d'échantillonnage réel envoyé par le client. */
  transcribe(pcm16: Buffer, sampleRateHz: number): Promise<SttResult>;
}

export class NoopSttProvider implements SttProvider {
  async transcribe(): Promise<SttResult> {
    return { ok: false, error: "STT_PROVIDER_NOT_CONFIGURED" };
  }
}

export class WebhookSttProvider implements SttProvider {
  async transcribe(pcm16: Buffer, sampleRateHz: number): Promise<SttResult> {
    if (!config.audio.sttWebhookUrl) return { ok: false, error: "STT_PROVIDER_NOT_CONFIGURED" };
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 20_000);
    try {
      const response = await fetch(config.audio.sttWebhookUrl, {
        method: "POST",
        headers: {
          "content-type": "application/octet-stream",
          "x-sample-rate-hz": String(sampleRateHz),
          "x-audio-encoding": "pcm16le",
          ...(config.audio.sttWebhookToken ? { authorization: `Bearer ${config.audio.sttWebhookToken}` } : {}),
        },
        body: pcm16,
        signal: controller.signal,
      });
      if (!response.ok) return { ok: false, error: `STT_PROVIDER_HTTP_${response.status}` };
      const body = (await response.json().catch(() => null)) as { text?: string } | null;
      if (!body || typeof body.text !== "string") return { ok: false, error: "STT_PROVIDER_INVALID_RESPONSE" };
      return { ok: true, text: body.text };
    } catch (error) {
      return { ok: false, error: (error as Error).name === "AbortError" ? "STT_PROVIDER_TIMEOUT" : "STT_PROVIDER_UNAVAILABLE" };
    } finally {
      clearTimeout(timeout);
    }
  }
}

export function createSttProvider(): SttProvider {
  return config.audio.sttWebhookUrl ? new WebhookSttProvider() : new NoopSttProvider();
}
