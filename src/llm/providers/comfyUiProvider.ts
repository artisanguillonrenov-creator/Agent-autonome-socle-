import { readFileSync } from "node:fs";
import { randomUUID, randomInt } from "node:crypto";
import WebSocket from "ws";
import { config } from "../../config.js";
import type { ImageGenerationOptions, ImageProvider } from "../interfaces/imageProvider.js";

interface ComfyUiNode {
  class_type: string;
  inputs: Record<string, unknown>;
}
type ComfyUiWorkflow = Record<string, ComfyUiNode>;

interface ComfyUiHistoryImage {
  filename: string;
  subfolder: string;
  type: string;
}

interface ComfyUiProviderOptions {
  baseUrl?: string;
  workflowTemplatePath?: string;
  checkpoint?: string;
}

/**
 * Vague 12A : adaptateur local ComfyUI. Interagit directement avec l'API HTTP/WebSocket
 * exposée par une instance ComfyUI déjà en cours d'exécution (aucun lancement de process,
 * aucune installation gérée ici) : POST /prompt pour soumettre le graphe de génération
 * (workflow FLUX/SDXL), puis écoute du WebSocket temps réel de ComfyUI pour détecter la fin
 * de l'exécution avant de récupérer l'image produite via GET /view.
 *
 * Le prompt reçu est écrit tel quel dans le nœud CLIPTextEncode positif du workflow — aucune
 * réécriture, troncature ou filtrage n'est appliqué ici.
 */
export class ComfyUiProvider implements ImageProvider {
  readonly name = "comfyui";
  private readonly baseUrl: string;
  private readonly workflowTemplatePath: string;
  private readonly checkpoint: string;

  constructor(opts: ComfyUiProviderOptions = {}) {
    this.baseUrl = opts.baseUrl ?? config.image.comfyUi.baseUrl;
    this.workflowTemplatePath = opts.workflowTemplatePath ?? config.image.comfyUi.workflowTemplatePath;
    this.checkpoint = opts.checkpoint ?? config.image.comfyUi.checkpoint;
  }

  private loadWorkflow(): ComfyUiWorkflow {
    const raw = readFileSync(this.workflowTemplatePath, "utf-8");
    return JSON.parse(raw) as ComfyUiWorkflow;
  }

  private buildWorkflow(prompt: string, options: ImageGenerationOptions | undefined): ComfyUiWorkflow {
    const workflow = this.loadWorkflow();

    const sampler = workflow["3"];
    const checkpointLoader = workflow["4"];
    const emptyLatent = workflow["5"];
    const positivePrompt = workflow["6"];
    const negativePrompt = workflow["7"];

    if (!sampler || !checkpointLoader || !emptyLatent || !positivePrompt || !negativePrompt) {
      throw new Error("COMFYUI_WORKFLOW_TEMPLATE_INVALID: nœuds attendus (3,4,5,6,7) manquants.");
    }

    // Injection directe du prompt exact fourni par l'agent — jamais de nettoyage sémantique
    // ni d'ajout de mots-clés de sécurité.
    positivePrompt.inputs.text = prompt;
    negativePrompt.inputs.text = options?.negativePrompt ?? "";
    checkpointLoader.inputs.ckpt_name = options?.model ?? this.checkpoint;
    emptyLatent.inputs.width = options?.width ?? config.image.defaultWidth;
    emptyLatent.inputs.height = options?.height ?? config.image.defaultHeight;
    sampler.inputs.steps = options?.steps ?? config.image.defaultSteps;
    sampler.inputs.seed = options?.seed ?? randomInt(0, 2 ** 31 - 1);

    return workflow;
  }

  private wsUrl(clientId: string): string {
    return `${this.baseUrl.replace(/^http/, "ws")}/ws?clientId=${encodeURIComponent(clientId)}`;
  }

  /**
   * Soumet le workflow puis attend, via le WebSocket temps réel de ComfyUI, le message
   * `executing` signalant la fin d'exécution de CE prompt précis (node === null). Le
   * WebSocket est la source de vérité du "quand" ; l'image elle-même est ensuite récupérée
   * via /history + /view (HTTP), jamais transmise en frame binaire par ComfyUI lui-même.
   */
  private async waitForCompletion(promptId: string, clientId: string, timeoutMs: number): Promise<void> {
    return new Promise((resolve, reject) => {
      const ws = new WebSocket(this.wsUrl(clientId));
      const timer = setTimeout(() => {
        ws.terminate();
        reject(new Error("COMFYUI_GENERATION_TIMEOUT"));
      }, timeoutMs);

      const cleanup = () => {
        clearTimeout(timer);
        ws.removeAllListeners();
        ws.close();
      };

      ws.on("message", (data, isBinary) => {
        if (isBinary) return; // Frames binaires = previews JPEG intermédiaires, ignorées ici.
        let parsed: any;
        try {
          parsed = JSON.parse(data.toString("utf-8"));
        } catch {
          return;
        }
        if (parsed.type === "executing" && parsed.data?.prompt_id === promptId && parsed.data?.node === null) {
          cleanup();
          resolve();
        }
        if (parsed.type === "execution_error" && parsed.data?.prompt_id === promptId) {
          cleanup();
          reject(new Error(`COMFYUI_EXECUTION_ERROR: ${JSON.stringify(parsed.data).slice(0, 500)}`));
        }
      });
      ws.on("error", (err) => {
        cleanup();
        reject(new Error(`COMFYUI_WS_ERROR: ${(err as Error).message}`));
      });
    });
  }

  private async fetchHistoryImage(promptId: string): Promise<ComfyUiHistoryImage> {
    const res = await fetch(`${this.baseUrl}/history/${encodeURIComponent(promptId)}`);
    if (!res.ok) throw new Error(`COMFYUI_HISTORY_UNAVAILABLE: HTTP ${res.status}`);
    const history = (await res.json()) as Record<string, { outputs?: Record<string, { images?: ComfyUiHistoryImage[] }> }>;
    const entry = history[promptId];
    const outputs = entry?.outputs ?? {};
    for (const nodeOutput of Object.values(outputs)) {
      const image = nodeOutput.images?.[0];
      if (image) return image;
    }
    throw new Error("COMFYUI_NO_IMAGE_IN_HISTORY");
  }

  private async fetchImageBytes(image: ComfyUiHistoryImage): Promise<Buffer> {
    const params = new URLSearchParams({ filename: image.filename, subfolder: image.subfolder, type: image.type });
    const res = await fetch(`${this.baseUrl}/view?${params.toString()}`);
    if (!res.ok) throw new Error(`COMFYUI_VIEW_UNAVAILABLE: HTTP ${res.status}`);
    return Buffer.from(await res.arrayBuffer());
  }

  async generateImage(prompt: string, options?: ImageGenerationOptions): Promise<string> {
    if (!prompt.trim()) throw new Error("COMFYUI_PROMPT_REQUIRED");
    const clientId = randomUUID();
    const workflow = this.buildWorkflow(prompt, options);
    const timeoutMs = options?.timeoutMs ?? config.image.timeoutMs;

    const submitRes = await fetch(`${this.baseUrl}/prompt`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ prompt: workflow, client_id: clientId }),
    });
    if (!submitRes.ok) {
      const text = await submitRes.text().catch(() => "");
      throw new Error(`COMFYUI_SUBMIT_FAILED: HTTP ${submitRes.status} ${text.slice(0, 300)}`);
    }
    const submitBody = (await submitRes.json()) as { prompt_id?: string; error?: unknown };
    if (!submitBody.prompt_id) {
      throw new Error(`COMFYUI_SUBMIT_INVALID_RESPONSE: ${JSON.stringify(submitBody).slice(0, 300)}`);
    }

    await this.waitForCompletion(submitBody.prompt_id, clientId, timeoutMs);
    const image = await this.fetchHistoryImage(submitBody.prompt_id);
    const bytes = await this.fetchImageBytes(image);
    return bytes.toString("base64");
  }
}
