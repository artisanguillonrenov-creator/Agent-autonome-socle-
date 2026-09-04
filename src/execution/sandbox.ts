import { execFile } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

export interface ExecutionResult {
  stdout: string;
  stderr: string;
  timedOut: boolean;
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
