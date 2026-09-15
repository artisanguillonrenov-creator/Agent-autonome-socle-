import { statSync, watch } from "node:fs";
import Docker from "dockerode";
import { config } from "../config.js";
import { autonomyEventBus } from "./eventBus.js";

export interface WatchersHandle {
  dispose(): void;
}

/** De nombreux éditeurs/synchros déclenchent plusieurs événements fs pour une seule écriture logique. */
function debounce<Args extends unknown[]>(fn: (...args: Args) => void, ms: number): (...args: Args) => void {
  let timer: NodeJS.Timeout | undefined;
  return (...args: Args) => {
    if (timer) clearTimeout(timer);
    timer = setTimeout(() => fn(...args), ms);
  };
}

/**
 * Observateur du Document Workbench : WorkspaceStore (src/workspaces/workspaceStore.ts)
 * publie déjà WORKBENCH_DOCUMENT_CHANGED pour toute écriture passée par l'application
 * elle-même. Ce watcher couvre le cas complémentaire — un fichier déposé ou modifié
 * directement sur disque (synchronisation externe, édition manuelle hors IHM) — pour que les
 * routines lourdes d'arrière-plan réagissent aussi à ce changement d'état factuel.
 */
function startWorkbenchWatcher(): (() => void) | undefined {
  const root = config.workspace.root;
  try {
    statSync(root);
  } catch {
    return undefined; // Répertoire pas encore créé : rien à observer pour l'instant, jamais bloquant.
  }

  const publish = debounce((eventType: string, filename: string | null) => {
    autonomyEventBus.publish({
      type: "WORKBENCH_DOCUMENT_CHANGED",
      source: "workbench_fs_watcher",
      payload: { eventType, path: filename ?? undefined, severity: "info" },
    });
  }, 500);

  try {
    const watcher = watch(root, { recursive: true }, (eventType, filename) => {
      publish(eventType, filename ? filename.toString() : null);
    });
    watcher.on("error", (error) => console.warn("[Watchers] Document Workbench watcher error (best-effort):", (error as Error).message));
    return () => watcher.close();
  } catch (error) {
    console.warn("[Watchers] Document Workbench fs.watch indisponible (best-effort):", (error as Error).message);
    return undefined;
  }
}

/**
 * Observateur du cycle de vie des conteneurs sandbox (Vague 10C : conteneurs étiquetés
 * `jarvis.sandbox=true` par execution/dockerSandbox.ts). Une sortie anormale (die avec code
 * non nul, oom, kill) publie un événement CRITICAL sur le bus d'autonomie — sans jamais
 * scruter les conteneurs de l'hôte hors de ce label, et sans jamais bloquer le démarrage si
 * Docker est indisponible ou le socket non monté.
 */
function startSandboxContainerWatcher(): (() => void) | undefined {
  if (!config.execution.dockerEnabled) return undefined;

  let disposed = false;
  let stream: NodeJS.ReadableStream | undefined;
  const docker = new Docker();

  docker
    .getEvents({ filters: JSON.stringify({ type: ["container"], label: ["jarvis.sandbox=true"] }) })
    .then((eventStream) => {
      if (disposed) {
        (eventStream as NodeJS.ReadableStream & { destroy?: () => void }).destroy?.();
        return;
      }
      stream = eventStream;
      eventStream.on("data", (chunk: Buffer) => {
        for (const line of chunk.toString("utf-8").split("\n")) {
          if (!line.trim()) continue;
          let parsed: { Action?: string; Actor?: { ID?: string; Attributes?: Record<string, string> } };
          try {
            parsed = JSON.parse(line);
          } catch {
            continue;
          }
          const action = parsed.Action;
          if (!action || !["die", "oom", "kill"].includes(action)) continue;
          const exitCode = parsed.Actor?.Attributes?.exitCode;
          const isAbnormal = action === "oom" || (exitCode !== undefined && exitCode !== "0");
          autonomyEventBus.publish({
            type: "SANDBOX_CONTAINER_EVENT",
            source: "sandbox_docker_watcher",
            payload: {
              action,
              containerId: parsed.Actor?.ID,
              exitCode: exitCode ?? null,
              severity: isAbnormal ? "error" : "info",
              message: `Sandbox container ${action}${exitCode !== undefined ? ` (exit ${exitCode})` : ""}`,
            },
          });
        }
      });
      eventStream.on("error", (error) => console.warn("[Watchers] Docker events stream error (best-effort):", (error as Error).message));
    })
    .catch((error) => {
      console.warn("[Watchers] Docker events indisponibles (best-effort):", (error as Error).message);
    });

  return () => {
    disposed = true;
    (stream as (NodeJS.ReadableStream & { destroy?: () => void }) | undefined)?.destroy?.();
  };
}

/**
 * Vague 11A (cron événementiel et watchers d'état) : remplace/enrichit l'éveil temporel strict
 * pour les routines lourdes d'arrière-plan — celles-ci ne doivent s'éveiller que si un
 * changement d'état factuel a réellement été notifié (voir autonomy/planner.ts,
 * WATCHED_EVENT_TYPES), plutôt que sur un scrutin aveugle.
 */
export function startAutonomyWatchers(): WatchersHandle {
  const disposeWorkbench = startWorkbenchWatcher();
  const disposeSandbox = startSandboxContainerWatcher();
  return {
    dispose() {
      disposeWorkbench?.();
      disposeSandbox?.();
    },
  };
}
