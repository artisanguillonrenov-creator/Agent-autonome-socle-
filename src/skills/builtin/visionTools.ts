import { randomUUID } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { SkillDefinition } from "../../types.js";
import { config } from "../../config.js";
import { ArtifactStore } from "../../workspaces/artifactStore.js";
import { createLLMProvider, resolveLLMSelection } from "../../llm/providers/index.js";

const artifactStore = new ArtifactStore();
/** Dossier dédié, hors workspace : jamais le dépôt Jarvis ni un fichier utilisateur arbitraire. */
const SCREENSHOT_TMP_DIR = join(tmpdir(), "jarvis-screenshots");

async function launchAndScreenshot(url: string, timeoutMs: number): Promise<Buffer> {
  // puppeteer-core : ne télécharge jamais son propre Chromium (léger, prévisible en CI/Docker).
  // PUPPETEER_EXECUTABLE_PATH doit pointer vers un binaire Chromium/Chrome déjà installé.
  const puppeteerModule = await import("puppeteer-core").catch(() => {
    throw new Error("puppeteer-core n'est pas installé (dépendance optionnelle) — voir package.json.");
  });
  const puppeteer = puppeteerModule.default ?? puppeteerModule;
  const executablePath = process.env.PUPPETEER_EXECUTABLE_PATH || "";
  if (!executablePath) {
    throw new Error("PUPPETEER_EXECUTABLE_PATH non configuré : chemin vers un binaire Chromium/Chrome requis.");
  }
  const browser = await puppeteer.launch({
    headless: true,
    executablePath,
    args: ["--no-sandbox", "--disable-setuid-sandbox", "--disable-dev-shm-usage"],
  });
  try {
    const page = await browser.newPage();
    await page.setViewport({ width: 1280, height: 800 });
    await page.goto(url, { waitUntil: "networkidle2", timeout: timeoutMs });
    const png = await page.screenshot({ type: "png", fullPage: true });
    return Buffer.isBuffer(png) ? png : Buffer.from(png);
  } finally {
    await browser.close().catch(() => undefined);
  }
}

/**
 * Vague 8B (ingestion visuelle) : capture d'écran automatique d'une application/site en cours
 * de test (ex. preview local généré par la Software Factory). Le résultat est soit enregistré
 * comme artefact de workspace (si `workspaceId` est fourni — traçable, réutilisable), soit
 * écrit dans un dossier temporaire dédié hors de tout dépôt applicatif. La capture elle-même
 * ne fait jamais l'objet d'une analyse : voir 'analyze_screenshot' pour l'étape vision.
 */
export const captureScreenshotSkill: SkillDefinition = {
  name: "capture_screenshot",
  description:
    "Capture une capture d'écran PNG d'une URL http(s) (ex: preview local d'une app générée par la Software Factory) " +
    "afin de valider visuellement une mise en page ou une interface. Enchaîne ensuite avec 'analyze_screenshot'.",
  argsHint: '{"url": string, "workspaceId"?: string}',
  category: "Technique",
  parameters: {
    type: "object",
    properties: {
      url: { type: "string", description: "URL http(s) à capturer, ex: http://localhost:3000" },
      workspaceId: { type: "string", description: "Workspace où enregistrer la capture comme artefact (optionnel)" },
    },
    required: ["url"],
    additionalProperties: false,
  },
  handler: async (input) => {
    const url = String(input.url ?? "").trim();
    if (!url) return "Erreur capture_screenshot : le paramètre url est obligatoire.";
    let parsed: URL;
    try {
      parsed = new URL(url);
    } catch {
      return "Erreur capture_screenshot : url invalide.";
    }
    if (!["http:", "https:"].includes(parsed.protocol)) {
      return "Erreur capture_screenshot : seuls les protocoles http/https sont autorisés.";
    }

    let png: Buffer;
    try {
      png = await launchAndScreenshot(url, config.vision.screenshotTimeoutMs);
    } catch (error) {
      return `Erreur capture_screenshot : capture échouée (${(error as Error).message}).`;
    }

    const workspaceId = typeof input.workspaceId === "string" ? input.workspaceId.trim() : "";
    if (workspaceId) {
      try {
        const artifact = artifactStore.createFileArtifact({
          workspaceId,
          name: `screenshot-${Date.now()}.png`,
          mimeType: "image/png",
          content: png,
        });
        return JSON.stringify({ artifactId: artifact.id, workspaceId, sizeBytes: artifact.sizeBytes });
      } catch (error) {
        return `Erreur capture_screenshot : enregistrement artefact échoué (${(error as Error).message}).`;
      }
    }

    await mkdir(SCREENSHOT_TMP_DIR, { recursive: true });
    const filePath = join(SCREENSHOT_TMP_DIR, `${randomUUID()}.png`);
    await writeFile(filePath, png);
    return JSON.stringify({ path: filePath, sizeBytes: png.length });
  },
};

/**
 * Vague 8B : étape d'analyse vision proprement dite — envoie l'image (base64) à un modèle
 * multimodal (config.vision.model si configuré, sinon le modèle actif s'il supporte la
 * vision) et renvoie l'analyse textuelle. Jamais bloquant pour le reste de l'agent : une
 * absence de modèle vision configuré renvoie une erreur explicite plutôt qu'un résultat
 * halluciné.
 */
export const analyzeScreenshotSkill: SkillDefinition = {
  name: "analyze_screenshot",
  description:
    "Analyse une capture d'écran déjà produite par 'capture_screenshot' (par artifactId ou chemin temporaire) " +
    "via un modèle multimodal, pour valider une mise en page, détecter un défaut visuel ou décrire une interface.",
  argsHint: '{"artifactId"?: string, "path"?: string, "question"?: string}',
  category: "Technique",
  parameters: {
    type: "object",
    properties: {
      artifactId: { type: "string", description: "Identifiant d'artefact produit par capture_screenshot" },
      path: { type: "string", description: "Chemin temporaire produit par capture_screenshot (si aucun workspaceId n'a été fourni)" },
      question: { type: "string", description: "Question précise à poser sur l'image (optionnel)" },
    },
    required: [],
    additionalProperties: false,
  },
  handler: async (input) => {
    if (!config.vision.enabled) return "Erreur analyze_screenshot : vision désactivée (VISION_ENABLED=false).";

    const artifactId = typeof input.artifactId === "string" ? input.artifactId.trim() : "";
    const rawPath = typeof input.path === "string" ? input.path.trim() : "";
    if (!artifactId && !rawPath) return "Erreur analyze_screenshot : fournir artifactId ou path.";

    let bytes: Buffer;
    try {
      if (artifactId) {
        const artifact = artifactStore.get(artifactId);
        if (!artifact || !artifact.relativePath) return "Erreur analyze_screenshot : artefact introuvable.";
        bytes = artifactStore.files.readFile(artifact.workspaceId, artifact.relativePath);
      } else {
        if (!rawPath.startsWith(SCREENSHOT_TMP_DIR)) {
          return "Erreur analyze_screenshot : chemin non autorisé (doit provenir de capture_screenshot).";
        }
        bytes = await readFile(rawPath);
      }
    } catch (error) {
      return `Erreur analyze_screenshot : lecture de l'image échouée (${(error as Error).message}).`;
    }

    const selection = resolveLLMSelection(config.vision.model ? { model: config.vision.model } : undefined);
    const provider = createLLMProvider(selection);
    if (!provider.supportsVision?.()) {
      return (
        `Erreur analyze_screenshot : le modèle actif (${provider.model ?? provider.name}) ne supporte pas la vision. ` +
        "Configure VISION_MODEL avec un modèle multimodal (ex: Qwen-VL, gpt-4o, claude-3-*)."
      );
    }

    const question =
      typeof input.question === "string" && input.question.trim()
        ? input.question.trim()
        : "Décris cette capture d'écran et signale tout défaut visuel évident (mise en page cassée, texte tronqué, élément manquant).";

    try {
      const result = await provider.complete(
        [
          { role: "system", content: "Tu analyses une capture d'écran d'interface logicielle. Réponds de façon factuelle et concise." },
          { role: "user", content: question, images: [{ base64: bytes.toString("base64"), mimeType: "image/png" }] },
        ],
        { maxTokens: 800, temperature: 0.2 },
      );
      return result.content?.trim() || "(analyse vide)";
    } catch (error) {
      return `Erreur analyze_screenshot : appel modèle vision échoué (${(error as Error).message}).`;
    }
  },
};
