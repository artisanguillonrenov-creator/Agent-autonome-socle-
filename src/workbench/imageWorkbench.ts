import { randomUUID } from "node:crypto";
import { mkdir, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";

/**
 * Vague 12B : dossier d'outils du Document Workbench dédié aux images générées (ComfyUI /
 * providers cloud). Toujours sous la racine du projet — jamais dans le dépôt applicatif d'un
 * utilisateur ni dans un workspace arbitraire tant qu'aucun `workspaceId` n'est fourni à la
 * compétence appelante (voir imageGenerationSkill.ts, qui privilégie l'ArtifactStore quand un
 * workspace est précisé).
 */
export const IMAGE_WORKBENCH_DIR = resolve(process.cwd(), "data", "workbench-images");

/** Écrit les octets bruts (jamais retravaillés) d'une image générée et retourne son chemin local exact. */
export async function writeGeneratedImage(bytes: Buffer, format: "png" | "jpeg" = "png"): Promise<string> {
  await mkdir(IMAGE_WORKBENCH_DIR, { recursive: true });
  const ext = format === "jpeg" ? "jpg" : "png";
  const filePath = join(IMAGE_WORKBENCH_DIR, `${randomUUID()}.${ext}`);
  await writeFile(filePath, bytes);
  return filePath;
}

/** Un chemin n'est servable par le dashboard que s'il provient bien de ce dossier dédié. */
export function isWithinImageWorkbench(path: string): boolean {
  return resolve(path).startsWith(IMAGE_WORKBENCH_DIR);
}
