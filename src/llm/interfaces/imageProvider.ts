/**
 * Vague 12A : abstraction générique de génération d'images, indépendante du backend
 * effectivement utilisé (ComfyUI local ou API cloud type Together/FLUX). Le contrat est
 * volontairement minimal — un provider reçoit le prompt exact fourni par l'appelant et le
 * transmet tel quel au backend, sans réécriture, nettoyage sémantique ni injection de mots-clés.
 */
export interface ImageGenerationOptions {
  /** Largeur en pixels — le provider applique son propre défaut si absent. */
  width?: number;
  /** Hauteur en pixels — le provider applique son propre défaut si absent. */
  height?: number;
  /** Nombre d'étapes de diffusion (steps). */
  steps?: number;
  /** Graine aléatoire, pour une régénération reproductible. */
  seed?: number;
  /** Prompt négatif optionnel — transmis tel quel, jamais complété automatiquement. */
  negativePrompt?: string;
  /** Identifiant de modèle/checkpoint côté backend (ex: nom du checkpoint ComfyUI, ou ID de modèle cloud). */
  model?: string;
  /** Format de sortie souhaité. */
  format?: "png" | "jpeg";
  /** Délai maximal (ms) avant abandon. */
  timeoutMs?: number;
}

export interface ImageProvider {
  readonly name: string;

  /**
   * Génère une image à partir du prompt exact fourni par l'agent, sans altération ni
   * injection forcée de mots-clés. Retourne les octets de l'image encodés en base64 brut
   * (sans préfixe `data:`), quel que soit le format effectivement reçu du backend (buffer
   * binaire local ou base64/URL distant) — le contrat de sortie est donc uniforme pour
   * tous les providers.
   */
  generateImage(prompt: string, options?: ImageGenerationOptions): Promise<string>;
}
