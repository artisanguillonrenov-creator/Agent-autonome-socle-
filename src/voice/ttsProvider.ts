import { config } from "../config.js";

export interface TtsChunk {
  audio: Buffer;
  isFinal: boolean;
}

/**
 * Vague 9B (pipeline TTS faible latence) : abstraction de synthèse vocale, agnostique du
 * fournisseur (Kokoro, ElevenLabs, solution locale...). `synthesize` renvoie un
 * AsyncGenerator pour permettre à un vrai fournisseur streaming de livrer des paquets audio
 * dès qu'ils sont disponibles plutôt que d'attendre la génération complète (voir
 * AudioStreamManager, qui relaie chaque chunk immédiatement sur le WebSocket). Le fournisseur
 * Webhook par défaut n'est pas nativement streaming (un seul POST -> un seul buffer complet) ;
 * il est ici re-découpé en paquets pour que le protocole côté client reste identique à un
 * fournisseur réellement streamé.
 */
export interface TtsProvider {
  synthesize(text: string): AsyncGenerator<TtsChunk>;
}

export class NoopTtsProvider implements TtsProvider {
  // eslint-disable-next-line require-yield
  async *synthesize(): AsyncGenerator<TtsChunk> {
    throw new Error("TTS_PROVIDER_NOT_CONFIGURED");
  }
}

const TTS_CHUNK_BYTES = 8 * 1024;

export class WebhookTtsProvider implements TtsProvider {
  async *synthesize(text: string): AsyncGenerator<TtsChunk> {
    if (!config.audio.ttsWebhookUrl) throw new Error("TTS_PROVIDER_NOT_CONFIGURED");
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 30_000);
    let response: Response;
    try {
      response = await fetch(config.audio.ttsWebhookUrl, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          ...(config.audio.ttsWebhookToken ? { authorization: `Bearer ${config.audio.ttsWebhookToken}` } : {}),
        },
        body: JSON.stringify({ text }),
        signal: controller.signal,
      });
    } catch (error) {
      clearTimeout(timeout);
      throw new Error((error as Error).name === "AbortError" ? "TTS_PROVIDER_TIMEOUT" : "TTS_PROVIDER_UNAVAILABLE");
    }
    clearTimeout(timeout);
    if (!response.ok) throw new Error(`TTS_PROVIDER_HTTP_${response.status}`);
    const audio = Buffer.from(await response.arrayBuffer());
    for (let offset = 0; offset < audio.length; offset += TTS_CHUNK_BYTES) {
      const end = Math.min(offset + TTS_CHUNK_BYTES, audio.length);
      yield { audio: audio.subarray(offset, end), isFinal: end >= audio.length };
    }
    if (audio.length === 0) yield { audio: Buffer.alloc(0), isFinal: true };
  }
}

export function createTtsProvider(): TtsProvider {
  return config.audio.ttsWebhookUrl ? new WebhookTtsProvider() : new NoopTtsProvider();
}
