import type { SkillDefinition } from "../../types.js";
import { config } from "../../config.js";
import { proposeRule } from "../../reflection/promptEvolver.js";

/**
 * Brique self-improvement : donne à un agent (typiquement le rôle SelfImprover d'une
 * AgentTeam, voir config/agent-profiles.json) la capacité de proposer explicitement une
 * règle d'or micro-instructionnelle durable, en dehors du cycle automatique de
 * ReflectionEngine (voir src/reflection/promptEvolver.ts). Même politique de
 * déduplication/plafond que l'extraction automatique.
 */
export const proposePromptRuleSkill: SkillDefinition = {
  name: "propose_prompt_rule",
  description:
    "Propose une règle d'or micro-instructionnelle durable (une phrase impérative courte, générique et réutilisable dans une future session), ajoutée à la configuration si elle n'existe pas déjà.",
  argsHint: '{"rule": string}',
  parameters: {
    type: "object",
    properties: {
      rule: { type: "string", description: "Règle d'or, courte et impérative (max 400 caractères)." },
    },
    required: ["rule"],
    additionalProperties: false,
  },
  handler: async (input) => {
    if (!config.promptEvolution.enabled) return "Évolution de prompt désactivée (config.promptEvolution.enabled=false) : règle non ajoutée.";
    const rule = String(input.rule ?? "").trim();
    if (!rule) return "Erreur: rule requis.";
    const added = proposeRule(rule);
    return added ? `Règle ajoutée: ${rule}` : "Règle déjà connue ou invalide (vide/trop longue) : non ajoutée.";
  },
};
