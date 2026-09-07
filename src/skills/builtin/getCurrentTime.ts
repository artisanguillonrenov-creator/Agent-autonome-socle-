import type { SkillDefinition } from "../../types.js";

export const getCurrentTimeSkill: SkillDefinition = {
  name: "get_current_time",
  description: "Renvoie la date et l'heure actuelles (UTC, format ISO).",
  argsHint: "Aucun argument requis.",
  parameters: {
    type: "object",
    properties: {},
    required: [],
    additionalProperties: false,
  },
  handler: async () => new Date().toISOString(),
};
