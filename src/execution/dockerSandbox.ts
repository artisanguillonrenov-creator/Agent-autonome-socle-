import Docker from "dockerode";
import { PassThrough } from "node:stream";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { config } from "../config.js";
import type { ExecutionResult } from "./sandbox.js";

/**
 * Vague 10C (Docker-in-Docker / sandboxing Software Factory) : volume de travail cloisonné
 * dédié EXCLUSIVEMENT à l'écriture/exécution de scripts générés par l'IA — jamais un chemin du
 * dépôt applicatif Jarvis, jamais son fichier .env. Distinct de os.tmpdir() par défaut pour
 * pouvoir être monté comme volume Docker nommé isolé (voir docker-compose.yml) plutôt que de
 * partager le tmpfs générique du conteneur hôte.
 */
const SANDBOX_BASE_DIR = process.env.SANDBOX_WORKDIR || "/tmp/jarvis-sandbox";

let dockerInstance: Docker | null = null;
function getDocker(): Docker {
  if (!dockerInstance) dockerInstance = new Docker();
  return dockerInstance;
}

export async function isDockerAvailable(): Promise<boolean> {
  try {
    await getDocker().ping();
    return true;
  } catch {
    return false;
  }
}

interface RunContainerOptions {
  cmd: string[];
  /** Répertoire temporaire déjà peuplé, monté sur /workspace ; jamais un chemin du dépôt hôte. */
  hostDir: string;
  /** false autorise l'écriture dans /workspace (ex. validation Software Factory produisant des rapports). */
  readOnlyWorkspace: boolean;
  timeoutMs: number;
}

async function runContainer(opts: RunContainerOptions): Promise<ExecutionResult> {
  const docker = getDocker();
  let container: Docker.Container | undefined;
  try {
    container = await docker.createContainer({
      Image: config.execution.dockerImage,
      Cmd: opts.cmd,
      WorkingDir: "/workspace",
      Env: ["PATH=/usr/local/bin:/usr/bin:/bin"],
      // Vague 11A : étiquette dédiée, jamais posée sur un conteneur hôte arbitraire — permet au
      // watcher de cycle de vie (autonomy/watchers.ts) de filtrer strictement les événements
      // Docker aux seuls conteneurs sandbox de la Software Factory.
      Labels: { "jarvis.sandbox": "true" },
      AttachStdout: true,
      AttachStderr: true,
      Tty: false,
      HostConfig: {
        Binds: [`${opts.hostDir}:/workspace:${opts.readOnlyWorkspace ? "ro" : "rw"}`],
        NetworkMode: config.execution.dockerNetworkEnabled ? "bridge" : "none",
        Memory: config.execution.dockerMemoryMb * 1024 * 1024,
        NanoCpus: config.execution.dockerNanoCpus,
        PidsLimit: 64,
        ReadonlyRootfs: opts.readOnlyWorkspace,
        Tmpfs: { "/tmp": "rw,size=64m" },
        SecurityOpt: ["no-new-privileges"],
        CapDrop: ["ALL"],
        AutoRemove: false,
      },
    });

    let stdout = "";
    let stderr = "";
    const stdoutStream = new PassThrough();
    const stderrStream = new PassThrough();
    stdoutStream.on("data", (chunk: Buffer) => { stdout += chunk.toString("utf-8"); });
    stderrStream.on("data", (chunk: Buffer) => { stderr += chunk.toString("utf-8"); });

    const attachStream = await container.attach({ stream: true, stdout: true, stderr: true });
    docker.modem.demuxStream(attachStream, stdoutStream, stderrStream);

    await container.start();

    let timedOut = false;
    let exitCode: number | undefined;
    const waitPromise = container.wait();
    const timeoutHandle = new Promise<"timeout">((resolve) => {
      const timer = setTimeout(() => resolve("timeout"), opts.timeoutMs);
      timer.unref?.();
    });
    const outcome = await Promise.race([waitPromise.then((r) => ({ tag: "exited" as const, result: r })), timeoutHandle]);

    if (outcome === "timeout") {
      timedOut = true;
      try { await container.kill(); } catch { /* déjà arrêté */ }
      await waitPromise.catch(() => undefined);
    } else {
      exitCode = (outcome as { tag: "exited"; result: { StatusCode?: number } }).result?.StatusCode;
    }

    return { stdout, stderr, timedOut, exitCode };
  } finally {
    try { await container?.remove({ force: true }); } catch { /* nettoyage best-effort */ }
  }
}

/**
 * Isolation forte via conteneur Docker éphémère et jetable (VAGUE 3) :
 * - AUCUN accès réseau par défaut (HostConfig.NetworkMode "none") ;
 * - AUCUN montage du système hôte hormis un dossier temporaire dédié, contenant
 *   UNIQUEMENT le script généré, monté en lecture seule ("ro") — le fichier .env
 *   principal du process hôte n'existe nulle part dans ce dossier et n'est donc
 *   jamais accessible depuis le conteneur ;
 * - mémoire/CPU/PID plafonnés, rootfs en lecture seule (sauf /tmp en tmpfs) ;
 * - le conteneur est systématiquement supprimé (`remove({force:true})`) en sortie,
 *   qu'il ait réussi, échoué ou été tué pour dépassement de timeout.
 */
async function mkSandboxTempDir(): Promise<string> {
  await mkdir(SANDBOX_BASE_DIR, { recursive: true });
  return mkdtemp(join(SANDBOX_BASE_DIR, "agent-sandbox-"));
}

export async function runInDockerSandbox(code: string, timeoutMs: number): Promise<ExecutionResult> {
  const dir = await mkSandboxTempDir();
  try {
    await writeFile(join(dir, "script.mjs"), code, "utf-8");
    return await runContainer({ cmd: ["node", "/workspace/script.mjs"], hostDir: dir, readOnlyWorkspace: true, timeoutMs });
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

/**
 * Variante générique (Software Factory, VAGUE 3) : monte UNIQUEMENT `files` (jamais le
 * dépôt hôte ni le `.env` principal, qui ne sont jamais copiés dans ce dossier
 * temporaire) et exécute `command` à l'intérieur — utilisée pour valider un patch généré
 * (lint/build/test) avant tout commit GitHub, sans jamais toucher au système hôte.
 */
export async function runCommandInDockerSandbox(
  files: Record<string, string>,
  command: string[],
  timeoutMs: number,
): Promise<ExecutionResult> {
  const dir = await mkSandboxTempDir();
  try {
    for (const [relativePath, content] of Object.entries(files)) {
      if (relativePath.includes("..")) throw new Error(`UNSAFE_FILE_PATH: ${relativePath}`);
      const target = join(dir, relativePath);
      await mkdir(dirname(target), { recursive: true });
      await writeFile(target, content, "utf-8");
    }
    return await runContainer({ cmd: command, hostDir: dir, readOnlyWorkspace: false, timeoutMs });
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}
