import { loadDynamicRules } from "../reflection/promptEvolver.js";

/**
 * Vague 8C : injection, au début de CHAQUE session (chaque appel à Agent.buildInstructions),
 * des règles d'or apprises lors de cycles de réflexion précédents (potentiellement d'une
 * session process antérieure — config/dynamic_rules.json est un fichier local persistant,
 * pas un état en mémoire). Best-effort : un fichier absent/corrompu retombe simplement sur
 * aucune règle, jamais une erreur qui empêcherait la construction du prompt système.
 */
export function composeDynamicRulesSection(): string {
  const rules = loadDynamicRules();
  if (rules.length === 0) return "";
  return [
    "RÈGLES D'OR APPRISES (extraites automatiquement de corrections passées, Vague 8C) :",
    ...rules.map((rule) => `- ${rule}`),
  ].join("\n");
}
