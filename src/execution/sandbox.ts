import { execFile } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { config } from "../config.js";

const execFileAsync = promisify(execFile);

export interface ExecutionResult {
  stdout: string;
  stderr: string;
  timedOut: boolean;
  /** Code de sortie du process/conteneur, quand connu (isolation Docker/E2B uniquement). */
  exitCode?: number;
}

/**
 * Isolation LÉGÈRE seulement : timeout, dossier temporaire jetable, variables
 * d'environnement minimales (les clés API du process parent ne sont pas
 * transmises). Ce n'est PAS une isolation de sécurité forte — pas de
 * conteneur ni de VM, le processus garde l'accès au système de fichiers et
 * au réseau de la machine hôte. À n'activer (ENABLE_CODE_EXECUTION) que dans
 * un environnement de confiance, jamais exposé à du code non fiable.
 */
export async function runJavaScript(code: string, timeoutMs: number): Promise<ExecutionResult> {
  const dir = await mkdtemp(join(tmpdir(), "agent-exec-"));
  const file = join(dir, "script.mjs");
  await writeFile(file, code, "utf-8");

  try {
    const { stdout, stderr } = await execFileAsync(process.execPath, [file], {
      cwd: dir,
      timeout: timeoutMs,
      maxBuffer: 1024 * 1024,
      env: { PATH: process.env.PATH ?? "" },
    });
    return { stdout, stderr, timedOut: false };
  } catch (err) {
    const e = err as NodeJS.ErrnoException & { stdout?: string; stderr?: string; killed?: boolean; signal?: string };
    return {
      stdout: e.stdout ?? "",
      stderr: e.stderr ?? e.message,
      timedOut: e.killed === true || e.signal === "SIGTERM",
    };
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

/**
 * Point d'entrée sandboxé unique (VAGUE 3) : isole toute exécution de code/commande
 * générée dans un conteneur Docker éphémère par défaut, ou dans la sandbox managée E2B
 * si `E2B_API_KEY` est fourni (prioritaire — utile quand aucun démon Docker n'est
 * disponible, ex. plateformes hébergées). Ni l'un ni l'autre disponible -> repli
 * explicite (et journalisé) sur l'isolation légère historique `runJavaScript`, jamais
 * bloquant pour l'appelant. Dans tous les cas, le script généré n'a jamais accès au
 * système de fichiers hôte ni au `.env` principal du process agent.
 */
export async function runInSandbox(code: string, timeoutMs: number): Promise<ExecutionResult> {
  if (config.execution.e2bApiKey) {
    try {
      const { runInE2BSandbox } = await import("./e2bSandbox.js");
      return await runInE2BSandbox(code, timeoutMs);
    } catch (error) {
      console.warn("[Sandbox] E2B indisponible, repli sur Docker/isolation légère:", (error as Error).message);
    }
  }

  if (config.execution.dockerEnabled) {
    try {
      const { isDockerAvailable, runInDockerSandbox } = await import("./dockerSandbox.js");
      if (await isDockerAvailable()) {
        return await runInDockerSandbox(code, timeoutMs);
      }
      console.warn("[Sandbox] Démon Docker indisponible, repli sur l'isolation légère (pas un vrai bac à sable).");
    } catch (error) {
      console.warn("[Sandbox] Échec de l'isolation Docker, repli sur l'isolation légère:", (error as Error).message);
    }
  }

  return runJavaScript(code, timeoutMs);
}

/**
 * Variante "commande + fichiers" (Software Factory, VAGUE 3) : uniquement Docker — pas de
 * repli sur l'isolation légère historique, qui n'a jamais été conçue pour exécuter des
 * commandes arbitraires (lint/build/test) sur un jeu de fichiers. Si aucune isolation forte
 * n'est disponible, échoue explicitement plutôt que d'exécuter la commande sans bac à sable.
 */
export async function runCommandInSandbox(
  files: Record<string, string>,
  command: string[],
  timeoutMs: number,
): Promise<ExecutionResult> {
  const { isDockerAvailable, runCommandInDockerSandbox } = await import("./dockerSandbox.js");
  if (!config.execution.dockerEnabled || !(await isDockerAvailable())) {
    throw new Error("SANDBOX_UNAVAILABLE: aucun bac à sable Docker disponible pour exécuter cette commande de manière isolée.");
  }
  return runCommandInDockerSandbox(files, command, timeoutMs);
}
