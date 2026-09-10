import type { SkillDefinition } from "../../types.js";
import { formatBureauResult, extractBureauContext } from "./bureauSkillHelpers.js";

export const productStudioSkill: SkillDefinition = {
  name: "product_studio",
  displayName: "Product Studio",
  description:
    "Bureau de conception et d'analyse produit : diagnostic d'un projet, opportunités, priorisation valeur/effort, roadmap et spécifications fonctionnelles. Ne modifie jamais le code lui-même.",
  category: "Contrôle",
  kind: "SKILL",
  risk: "LOW",
  executionTarget: "SERVICE_CAPABILITY",
  serviceCapability: "product_studio",
  requiresWorkspace: false,
  tags: ["product", "studio", "roadmap"],
  argsHint: '{"action": string, "objective"?: string, "workspaceId"?: string, ...}',
  parameters: {
    type: "object",
    properties: {
      action: { type: "string", enum: ["ANALYZE", "RESEARCH_MARKET", "RECORD_DECISION", "GET_STATE", "BRIEF_FOR_OFFICE"] },
      objective: { type: "string", description: "Objectif de la mission" },
      workspaceId: { type: "string", description: "Projet/workspace concerné" },
      projectSummary: { type: "string", description: "Description du projet à analyser (action ANALYZE)" },
      targetUsers: { type: "string", description: "Indice sur les utilisateurs cibles (action ANALYZE)" },
      marketSources: { type: "array", items: { type: "string" }, description: "Sources marché déjà collectées (action ANALYZE)" },
      queries: { type: "array", items: { type: "string" }, description: "Requêtes de recherche marché (action RESEARCH_MARKET)" },
      decision: { type: "string", description: "Décision produit à enregistrer (action RECORD_DECISION)" },
      rationale: { type: "string", description: "Justification de la décision (action RECORD_DECISION)" },
      targetOffice: { type: "string", description: "Bureau destinataire du brief (action BRIEF_FOR_OFFICE)" },
    },
    required: ["action"],
    additionalProperties: false,
  },
  handler: async (input, ctx) => {
    if (!ctx.serviceOrchestrator) return "Erreur: ServiceOrchestrator non configuré.";
    const { workspaceId, objective, context } = extractBureauContext(input);
    const orchResult = await ctx.serviceOrchestrator.dispatchCapability(
      { action: "DISPATCH_CAPABILITY", capability: "product_studio", objective, context },
      { workspaceId },
    );
    return formatBureauResult("Product Studio", orchResult);
  },
};
