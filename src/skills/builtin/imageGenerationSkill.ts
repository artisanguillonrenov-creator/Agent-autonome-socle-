import { readFile } from "node:fs/promises";
import type { SkillDefinition } from "../../types.js";
import { config } from "../../config.js";
import { createImageProvider } from "../../llm/providers/imageProviderFactory.js";
import { createLLMProvider, resolveLLMSelection } from "../../llm/providers/index.js";
import { ArtifactStore } from "../../workspaces/artifactStore.js";
import { writeGeneratedImage, isWithinImageWorkbench } from "../../workbench/imageWorkbench.js";
import { searchWebImages } from "../../web/imageSearch.js";

const artifactStore = new ArtifactStore();

/**
 * Vague 12B : compétence de génération d'images. Transmet le prompt exact fourni par l'agent
 * au provider actif (ComfyUI local ou provider cloud FLUX, voir config.image.provider) sans
 * aucune étape intermédiaire de reformulation ou de modération interne au niveau de cette
 * compétence — l'éventuelle modération appliquée reste celle, native, du backend choisi.
 *
 * L'image reçue (toujours normalisée en base64 par l'ImageProvider) est écrite brute sur
 * disque : comme artefact de workspace si `workspaceId` est fourni (traçable, réutilisable
 * par le reste de la Software Factory), sinon dans le dossier d'outils dédié du Document
 * Workbench (src/workbench/imageWorkbench.ts). Le chemin local exact (ou l'artifactId) est
 * retourné à l'agent.
 */
export const generateImageSkill: SkillDefinition = {
  name: "generate_image",
  description:
    "Génère une image à partir d'un prompt texte via le backend de génération d'images actif (ComfyUI local ou provider cloud FLUX). " +
    "Le prompt est transmis exactement tel quel au backend. Retourne un champ 'url' (chemin servi par ce serveur, à afficher directement en " +
    "Markdown via ![alt](url) dans la réponse) ainsi que le chemin local du fichier créé (ou l'artifactId si workspaceId est fourni). " +
    "En cas d'échec du backend, retourne à la place des suggestions d'images web existantes sur le même sujet.",
  argsHint: '{"prompt": string, "negativePrompt"?: string, "width"?: number, "height"?: number, "steps"?: number, "seed"?: number, "workspaceId"?: string}',
  category: "Technique",
  parameters: {
    type: "object",
    properties: {
      prompt: { type: "string", description: "Prompt exact à transmettre au backend de génération d'images." },
      negativePrompt: { type: "string", description: "Prompt négatif optionnel." },
      width: { type: "number", description: "Largeur en pixels (défaut: config IMAGE_DEFAULT_WIDTH)." },
      height: { type: "number", description: "Hauteur en pixels (défaut: config IMAGE_DEFAULT_HEIGHT)." },
      steps: { type: "number", description: "Nombre d'étapes de diffusion (défaut: config IMAGE_DEFAULT_STEPS)." },
      seed: { type: "number", description: "Graine aléatoire (optionnel, pour reproductibilité)." },
      format: { type: "string", enum: ["png", "jpeg"], description: "Format de sortie (défaut: png)." },
      workspaceId: { type: "string", description: "Workspace où enregistrer l'image comme artefact (optionnel)." },
    },
    required: ["prompt"],
    additionalProperties: false,
  },
  handler: async (input) => {
    const prompt = String(input.prompt ?? "").trim();
    if (!prompt) return "Erreur generate_image : le paramètre prompt est obligatoire.";

    const format = input.format === "jpeg" ? "jpeg" : "png";
    const provider = createImageProvider();

    let base64: string;
    try {
      base64 = await provider.generateImage(prompt, {
        negativePrompt: typeof input.negativePrompt === "string" ? input.negativePrompt : undefined,
        width: typeof input.width === "number" ? input.width : undefined,
        height: typeof input.height === "number" ? input.height : undefined,
        steps: typeof input.steps === "number" ? input.steps : undefined,
        seed: typeof input.seed === "number" ? input.seed : undefined,
        format,
      });
    } catch (error) {
      // Le backend de génération (ComfyUI/FLUX) est indisponible ou en erreur : plutôt que de
      // renvoyer une simple erreur que l'agent répercuterait telle quelle à l'utilisateur, on
      // propose immédiatement des images web existantes sur le même sujet (voir
      // search_web_image) pour que la conversation reste utile.
      const fallback = await searchWebImages(prompt, 3).catch(() => []);
      return JSON.stringify({
        error: `génération échouée (${(error as Error).message})`,
        fallbackSuggestion:
          fallback.length > 0
            ? "Backend de génération indisponible : voici des images existantes trouvées sur le web à proposer à la place, en citant leur source."
            : "Backend de génération indisponible et aucune image de secours trouvée sur le web.",
        results: fallback,
      });
    }

    const bytes = Buffer.from(base64, "base64");
    const workspaceId = typeof input.workspaceId === "string" ? input.workspaceId.trim() : "";

    if (workspaceId) {
      try {
        const artifact = artifactStore.createFileArtifact({
          workspaceId,
          name: `generated-${Date.now()}.${format === "jpeg" ? "jpg" : "png"}`,
          mimeType: format === "jpeg" ? "image/jpeg" : "image/png",
          content: bytes,
        });
        return JSON.stringify({
          artifactId: artifact.id,
          workspaceId,
          sizeBytes: artifact.sizeBytes,
          provider: provider.name,
          url: `/api/artifacts/${encodeURIComponent(artifact.id)}?inline=1`,
        });
      } catch (error) {
        return `Erreur generate_image : enregistrement artefact échoué (${(error as Error).message}).`;
      }
    }

    try {
      const filePath = await writeGeneratedImage(bytes, format);
      return JSON.stringify({
        path: filePath,
        sizeBytes: bytes.length,
        provider: provider.name,
        url: `/api/workbench/images?path=${encodeURIComponent(filePath)}`,
      });
    } catch (error) {
      return `Erreur generate_image : écriture disque échouée (${(error as Error).message}).`;
    }
  },
};

/**
 * Vague 12C : pipeline de rétroaction visuelle — soumet une image déjà générée par
 * generate_image au modèle de vision configuré (config.vision, brique Vague 8B) pour une
 * analyse strictement technique : lisibilité/orthographe d'un éventuel texte incrusté,
 * respect des dimensions demandées, netteté et cohérence esthétique générale. N'émet aucun
 * jugement de conformité éditoriale — seul un modèle vision correctement configuré répond,
 * cette compétence ne fait que transmettre la question et restituer sa réponse brute.
 */
export const validateGeneratedImageSkill: SkillDefinition = {
  name: "validate_generated_image",
  description:
    "Analyse la qualité technique d'une image déjà produite par 'generate_image' (par artifactId ou chemin local) : " +
    "texte lisible/bien orthographié le cas échéant, dimensions attendues, netteté et qualité esthétique générale.",
  argsHint: '{"artifactId"?: string, "path"?: string, "expectedWidth"?: number, "expectedHeight"?: number}',
  category: "Technique",
  parameters: {
    type: "object",
    properties: {
      artifactId: { type: "string", description: "Identifiant d'artefact produit par generate_image" },
      path: { type: "string", description: "Chemin local produit par generate_image (dossier workbench-images)" },
      expectedWidth: { type: "number", description: "Largeur attendue, pour vérification dimensionnelle (optionnel)" },
      expectedHeight: { type: "number", description: "Hauteur attendue, pour vérification dimensionnelle (optionnel)" },
    },
    required: [],
    additionalProperties: false,
  },
  handler: async (input) => {
    if (!config.vision.enabled) return "Erreur validate_generated_image : vision désactivée (VISION_ENABLED=false).";

    const artifactId = typeof input.artifactId === "string" ? input.artifactId.trim() : "";
    const rawPath = typeof input.path === "string" ? input.path.trim() : "";
    if (!artifactId && !rawPath) return "Erreur validate_generated_image : fournir artifactId ou path.";

    let bytes: Buffer;
    let mimeType = "image/png";
    try {
      if (artifactId) {
        const artifact = artifactStore.get(artifactId);
        if (!artifact || !artifact.relativePath) return "Erreur validate_generated_image : artefact introuvable.";
        bytes = artifactStore.files.readFile(artifact.workspaceId, artifact.relativePath);
        mimeType = artifact.mimeType || mimeType;
      } else {
        if (!isWithinImageWorkbench(rawPath)) {
          return "Erreur validate_generated_image : chemin non autorisé (doit provenir de generate_image).";
        }
        bytes = await readFile(rawPath);
        mimeType = rawPath.toLowerCase().endsWith(".jpg") || rawPath.toLowerCase().endsWith(".jpeg") ? "image/jpeg" : "image/png";
      }
    } catch (error) {
      return `Erreur validate_generated_image : lecture de l'image échouée (${(error as Error).message}).`;
    }

    const selection = resolveLLMSelection(config.vision.model ? { model: config.vision.model } : undefined);
    const provider = createLLMProvider(selection);
    if (!provider.supportsVision?.()) {
      return (
        `Erreur validate_generated_image : le modèle actif (${provider.model ?? provider.name}) ne supporte pas la vision. ` +
        "Configure VISION_MODEL avec un modèle multimodal."
      );
    }

    const dimensionHint =
      typeof input.expectedWidth === "number" && typeof input.expectedHeight === "number"
        ? ` Dimensions attendues : ${input.expectedWidth}x${input.expectedHeight}px — signale tout écart visible.`
        : "";

    try {
      const result = await provider.complete(
        [
          {
            role: "system",
            content:
              "Tu évalues la QUALITÉ TECHNIQUE d'une image générée par IA : texte incrusté lisible et bien orthographié le cas échéant, " +
              "netteté, absence d'artefacts de génération (mains/visages déformés, incohérences structurelles), et respect des dimensions " +
              "demandées. Réponds de façon factuelle et concise, uniquement sur ces critères techniques.",
          },
          {
            role: "user",
            content: `Évalue cette image générée sur les critères techniques ci-dessus.${dimensionHint}`,
            images: [{ base64: bytes.toString("base64"), mimeType }],
          },
        ],
        { maxTokens: 600, temperature: 0.2 },
      );
      return result.content?.trim() || "(analyse vide)";
    } catch (error) {
      return `Erreur validate_generated_image : appel modèle vision échoué (${(error as Error).message}).`;
    }
  },
};
