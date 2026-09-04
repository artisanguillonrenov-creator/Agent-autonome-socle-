import { config } from "../../config.js";
import { runJavaScript } from "../../execution/sandbox.js";
import type { SkillDefinition } from "../../types.js";

export const executeCodeSkill: SkillDefinition = {
  name: "execute_code",
  description: config.codeExecution.enabled
    ? "Exécute du code JavaScript (Node.js) et renvoie stdout/stderr. Isolation légère seulement " +
      "(pas un vrai bac à sable) : réservé à du code de confiance."
    : "Exécution de code — désactivée. Active ENABLE_CODE_EXECUTION=true dans .env pour l'utiliser " +
      "(capacité sensible en sécurité).",
  argsHint: '{"code": string}',
  handler: async (input) => {
    if (!config.codeExecution.enabled) {
      return "Exécution de code désactivée. Active ENABLE_CODE_EXECUTION=true dans .env pour l'utiliser.";
    }

    const code = String(input.code ?? "");
    if (!code.trim()) return "Erreur: le champ code est requis.";

    const result = await runJavaScript(code, config.codeExecution.timeoutMs);
    if (result.timedOut) {
      return `Exécution interrompue après ${config.codeExecution.timeoutMs}ms (timeout).`;
    }

    const parts: string[] = [];
    if (result.stdout.trim()) parts.push(`stdout:\n${result.stdout.trim()}`);
    if (result.stderr.trim()) parts.push(`stderr:\n${result.stderr.trim()}`);
    return parts.length ? parts.join("\n\n") : "(aucune sortie)";
  },
};
