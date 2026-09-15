import { config } from "../../config.js";
import type { ImageGenerationOptions, ImageProvider } from "../interfaces/imageProvider.js";

interface TogetherImageProviderOptions {
  apiKey?: string;
  baseUrl?: string;
  model?: string;
}

interface TogetherImageResponseItem {
  b64_json?: string;
  url?: string;
}
interface TogetherImageResponse {
  data?: TogetherImageResponseItem[];
  error?: { message?: string };
}

/**
 * Vague 12A : adaptateur cloud pour la génération d'images via l'API Together AI, ciblant
 * par défaut le modèle FLUX.1-dev. Le prompt exact fourni par l'appelant est transmis tel
 * quel dans le corps de la requête — aucun nettoyage sémantique ni filtrage préalable.
 */
export class TogetherImageProvider implements ImageProvider {
  readonly name = "together";
  private readonly apiKey: string;
  private readonly baseUrl: string;
  private readonly model: string;

  constructor(opts: TogetherImageProviderOptions = {}) {
    this.apiKey = opts.apiKey ?? config.image.together.apiKey;
    this.baseUrl = opts.baseUrl ?? config.image.together.baseUrl;
    this.model = opts.model ?? config.image.together.model;
  }

  async generateImage(prompt: string, options?: ImageGenerationOptions): Promise<string> {
    if (!prompt.trim()) throw new Error("TOGETHER_IMAGE_PROMPT_REQUIRED");
    if (!this.apiKey) throw new Error("TOGETHER_API_KEY_MISSING");

    const controller = new AbortController();
    const timeoutMs = options?.timeoutMs ?? config.image.timeoutMs;
    const timer = setTimeout(() => controller.abort(), timeoutMs);

    try {
      const res = await fetch(`${this.baseUrl}/v1/images/generations`, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          authorization: `Bearer ${this.apiKey}`,
        },
        body: JSON.stringify({
          model: options?.model ?? this.model,
          prompt,
          width: options?.width ?? config.image.defaultWidth,
          height: options?.height ?? config.image.defaultHeight,
          steps: options?.steps ?? config.image.defaultSteps,
          seed: options?.seed,
          n: 1,
          response_format: "base64",
        }),
        signal: controller.signal,
      });

      const body = (await res.json().catch(() => ({}))) as TogetherImageResponse;
      if (!res.ok) {
        throw new Error(`TOGETHER_IMAGE_REQUEST_FAILED: HTTP ${res.status} ${body.error?.message ?? ""}`.trim());
      }

      const item = body.data?.[0];
      if (item?.b64_json) return item.b64_json;
      if (item?.url) {
        const imageRes = await fetch(item.url, { signal: controller.signal });
        if (!imageRes.ok) throw new Error(`TOGETHER_IMAGE_DOWNLOAD_FAILED: HTTP ${imageRes.status}`);
        return Buffer.from(await imageRes.arrayBuffer()).toString("base64");
      }
      throw new Error("TOGETHER_IMAGE_NO_OUTPUT");
    } catch (error) {
      if ((error as Error).name === "AbortError") throw new Error("TOGETHER_IMAGE_TIMEOUT");
      throw error;
    } finally {
      clearTimeout(timer);
    }
  }
}
