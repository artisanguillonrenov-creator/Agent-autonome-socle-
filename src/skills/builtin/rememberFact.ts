import type { SkillDefinition } from "../../types.js";

export const rememberFactSkill: SkillDefinition = {
  name: "remember_fact",
  description: "Mémorise un fait structuré (entité, attribut, valeur) pour s'en souvenir durablement.",
  argsHint: '{"entity": string, "attribute": string, "value": string}',
  handler: async (input, ctx) => {
    const entity = String(input.entity ?? "").trim();
    const attribute = String(input.attribute ?? "").trim();
    const value = String(input.value ?? "").trim();
    if (!entity || !attribute || !value) {
      return "Erreur: entity, attribute et value sont requis.";
    }
    ctx.rememberFact(entity, attribute, value);
    return `Retenu : ${entity}.${attribute} = ${value}`;
  },
};
