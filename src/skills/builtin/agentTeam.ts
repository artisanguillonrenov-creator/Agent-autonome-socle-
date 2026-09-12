import type { SkillDefinition } from "../../types.js";

/**
 * Brique multi-agents exposée comme compétence : permet à l'agent principal de
 * déléguer un objectif à une équipe de profils spécialisés (Chercheur, Rédacteur,
 * Réviseur par défaut, ou tout sous-ensemble de profils déclarés) plutôt que de
 * tout traiter lui-même en un seul point de vue.
 */
export const runAgentTeamSkill: SkillDefinition = {
  name: "run_agent_team",
  description:
    "Délègue un objectif complexe à une équipe d'agents spécialisés qui collaborent séquentiellement " +
    "(par défaut : Chercheur → Rédacteur → Réviseur) pour produire un résultat de meilleure qualité qu'un " +
    "agent unique. À réserver aux objectifs qui bénéficient réellement de plusieurs points de vue.",
  argsHint: '{"objective": string, "profileIds"?: string[]}',
  parameters: {
    type: "object",
    properties: {
      objective: { type: "string", description: "Objectif complet à réaliser par l'équipe." },
      profileIds: {
        type: "array",
        items: { type: "string" },
        description: 'Sous-ensemble ordonné de profils à activer (ex: ["researcher","writer"]) ; par défaut, tous les profils actifs.',
      },
    },
    required: ["objective"],
    additionalProperties: false,
  },
  handler: async (input, ctx) => {
    if (!ctx.agentTeamCoordinator) return "Erreur: coordinateur multi-agents non configuré.";
    const objective = String(input.objective ?? "").trim();
    if (!objective) return "Erreur: 'objective' est requis pour run_agent_team.";
    const profileIds = Array.isArray(input.profileIds) ? input.profileIds.map(String) : undefined;
    try {
      const result = await ctx.agentTeamCoordinator.run(objective, { profileIds, skillContext: ctx });
      return JSON.stringify({ teamRunId: result.teamRunId, finalResponse: result.finalResponse });
    } catch (error) {
      return `Erreur lors de l'exécution de l'équipe d'agents: ${(error as Error).message}`;
    }
  },
};
