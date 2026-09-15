import { config } from "../../config.js";
import { runInSandbox } from "../../execution/sandbox.js";
import type { SkillDefinition } from "../../types.js";

export const executeCodeSkill: SkillDefinition = {
  name: "execute_code",
  description: config.codeExecution.enabled
    ? "Exécute du code JavaScript (Node.js) et renvoie stdout/stderr, isolé dans un conteneur " +
      "Docker éphémère (ou la sandbox managée E2B si configurée) : sans accès réseau ni au " +
      "système hôte par défaut."
    : "Exécution de code — désactivée. Active ENABLE_CODE_EXECUTION=true dans .env pour l'utiliser " +
      "(capacité sensible en sécurité).",
  argsHint: '{"code": string}',
  parameters: {
    type: "object",
    properties: {
      code: { type: "string", description: "Code JavaScript Node.js à exécuter" },
    },
    required: ["code"],
    additionalProperties: false,
  },
  handler: async (input) => {
    if (!config.codeExecution.enabled) {
      return "Exécution de code désactivée. Active ENABLE_CODE_EXECUTION=true dans .env pour l'utiliser.";
    }

    const code = String(input.code ?? "");
    if (!code.trim()) return "Erreur: le champ code est requis.";

    const result = await runInSandbox(code, config.codeExecution.timeoutMs);
    if (result.timedOut) {
      return `Exécution interrompue après ${config.codeExecution.timeoutMs}ms (timeout).`;
    }

    const parts: string[] = [];
    if (result.stdout.trim()) parts.push(`stdout:\n${result.stdout.trim()}`);
    if (result.stderr.trim()) parts.push(`stderr:\n${result.stderr.trim()}`);
    return parts.length ? parts.join("\n\n") : "(aucune sortie)";
  },
};
