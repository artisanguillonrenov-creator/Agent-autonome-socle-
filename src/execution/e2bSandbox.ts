import { config } from "../config.js";
import type { ExecutionResult } from "./sandbox.js";

/**
 * Sandbox managée E2B (https://e2b.dev) : alternative à Docker quand E2B_API_KEY est
 * fourni (VAGUE 3) — utile en environnement hébergé sans accès à un démon Docker local.
 * L'exécution a lieu dans une microVM jetable entièrement gérée par E2B, jamais sur la
 * machine hôte de l'agent ; le script généré n'a par construction aucun accès au
 * système de fichiers hôte ni au .env principal du process agent.
 */
export async function runInE2BSandbox(code: string, timeoutMs: number): Promise<ExecutionResult> {
  if (!config.execution.e2bApiKey) {
    throw new Error("E2B_API_KEY_MISSING");
  }
  const { Sandbox } = await import("@e2b/code-interpreter");
  const sandbox = await Sandbox.create({ apiKey: config.execution.e2bApiKey, timeoutMs });
  try {
    const execution = await sandbox.runCode(code, { language: "javascript" });
    const stdout = (execution.logs?.stdout ?? []).join("\n");
    const errorLines = execution.error ? [`${execution.error.name}: ${execution.error.value}`] : [];
    const stderr = [...(execution.logs?.stderr ?? []), ...errorLines].join("\n");
    return { stdout, stderr, timedOut: false };
  } finally {
    try { await sandbox.kill(); } catch { /* nettoyage best-effort */ }
  }
}
