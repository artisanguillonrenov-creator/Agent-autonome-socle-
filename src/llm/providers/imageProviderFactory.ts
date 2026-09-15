import { config } from "../../config.js";
import type { ImageProvider } from "../interfaces/imageProvider.js";
import { ComfyUiProvider } from "./comfyUiProvider.js";
import { TogetherImageProvider } from "./togetherImageProvider.js";

/** Vague 12A : sélectionne l'ImageProvider actif selon IMAGE_PROVIDER ("comfyui" par défaut, "together" pour le cloud FLUX). */
export function createImageProvider(): ImageProvider {
  switch (config.image.provider) {
    case "together":
      return new TogetherImageProvider();
    case "comfyui":
      return new ComfyUiProvider();
    default:
      throw new Error(`IMAGE_PROVIDER_UNKNOWN: ${config.image.provider}`);
  }
}
