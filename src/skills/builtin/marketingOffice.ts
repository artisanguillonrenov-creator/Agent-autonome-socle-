import type { SkillDefinition } from "../../types.js";
import { formatBureauResult, extractBureauContext } from "./bureauSkillHelpers.js";

export const marketingOfficeSkill: SkillDefinition = {
  name: "marketing_office",
  displayName: "Marketing Office",
  description:
    "Acquisition, positionnement et performance marketing : analyse de marché, segmentation, personas, proposition de valeur, stratégie de lancement, campagnes et suivi de résultats. Exploite les briefs du Product Studio et du Creative Studio quand ils sont fournis.",
  category: "Contrôle",
  kind: "SKILL",
  risk: "LOW",
  executionTarget: "SERVICE_CAPABILITY",
  serviceCapability: "marketing_office",
  requiresWorkspace: false,
  tags: ["marketing", "acquisition", "positionnement"],
  argsHint: '{"action": string, "objective"?: string, "workspaceId"?: string, ...}',
  parameters: {
    type: "object",
    properties: {
      action: { type: "string", enum: ["ANALYZE_MARKET", "DEFINE_STRATEGY", "PLAN_CAMPAIGN", "RECORD_RESULT", "GET_STATE"] },
      objective: { type: "string", description: "Objectif de la mission" },
      workspaceId: { type: "string", description: "Projet/workspace concerné" },
      queries: { type: "array", items: { type: "string" }, description: "Requêtes de recherche marché (action ANALYZE_MARKET)" },
      productBrief: { type: "object", description: "Brief structuré du Product Studio (action DEFINE_STRATEGY)" },
      creativeBrief: { type: "object", description: "Brief structuré du Creative Studio (action DEFINE_STRATEGY)" },
      marketSources: { type: "array", items: { type: "string" }, description: "Sources marché déjà collectées (action DEFINE_STRATEGY)" },
      name: { type: "string", description: "Nom de la campagne (action PLAN_CAMPAIGN)" },
      channel: { type: "string", description: "Canal de la campagne (action PLAN_CAMPAIGN)" },
      goal: { type: "string", description: "Objectif de la campagne (action PLAN_CAMPAIGN)" },
      campaignId: { type: "string", description: "Identifiant de la campagne (action RECORD_RESULT)" },
      metric: { type: "string", description: "Métrique observée (action RECORD_RESULT)" },
      value: { type: "number", description: "Valeur de la métrique (action RECORD_RESULT)" },
    },
    required: ["action"],
    additionalProperties: false,
  },
  handler: async (input, ctx) => {
    if (!ctx.serviceOrchestrator) return "Erreur: ServiceOrchestrator non configuré.";
    const { workspaceId, objective, context } = extractBureauContext(input);
    const orchResult = await ctx.serviceOrchestrator.dispatchCapability(
      { action: "DISPATCH_CAPABILITY", capability: "marketing_office", objective, context },
      { workspaceId },
    );
    return formatBureauResult("Marketing Office", orchResult);
  },
};
