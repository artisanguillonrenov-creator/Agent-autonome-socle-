import type { SkillDefinition } from "../../types.js";
import { formatBureauResult, extractBureauContext } from "./bureauSkillHelpers.js";

export const creativeStudioSkill: SkillDefinition = {
  name: "creative_studio",
  displayName: "Creative Studio",
  description:
    "Direction artistique complète d'un projet : identité visuelle, design d'application, UX/UI visuelle et briefs d'assets. Mémorise l'identité par projet et respecte la continuité artistique entre missions. Ne génère pas les images elle-même (transmet un brief à Jarvis -> media_generation).",
  category: "Contrôle",
  kind: "SKILL",
  risk: "LOW",
  executionTarget: "SERVICE_CAPABILITY",
  serviceCapability: "creative_studio",
  requiresWorkspace: false,
  tags: ["creative", "studio", "identité", "design"],
  argsHint: '{"action": string, "objective"?: string, "workspaceId"?: string, ...}',
  parameters: {
    type: "object",
    properties: {
      action: { type: "string", enum: ["DEFINE_IDENTITY", "GET_IDENTITY", "PROPOSE_SCREEN_CONCEPT", "RECORD_DECISION", "REQUEST_ASSET_BRIEF"] },
      objective: { type: "string", description: "Objectif de la mission" },
      workspaceId: { type: "string", description: "Projet/workspace concerné" },
      brief: { type: "string", description: "Brief de direction artistique (action DEFINE_IDENTITY)" },
      screenDescription: { type: "string", description: "Écran/application à concevoir (action PROPOSE_SCREEN_CONCEPT)" },
      decision: { type: "string", description: "Décision artistique à enregistrer (action RECORD_DECISION)" },
      status: { type: "string", enum: ["ACCEPTED", "REJECTED", "REPLACED"], description: "Statut de la décision (action RECORD_DECISION)" },
      note: { type: "string", description: "Note complémentaire (action RECORD_DECISION)" },
      assetType: { type: "string", description: "Type d'asset visuel demandé (action REQUEST_ASSET_BRIEF)" },
      description: { type: "string", description: "Description de l'asset demandé (action REQUEST_ASSET_BRIEF)" },
    },
    required: ["action"],
    additionalProperties: false,
  },
  handler: async (input, ctx) => {
    if (!ctx.serviceOrchestrator) return "Erreur: ServiceOrchestrator non configuré.";
    const { workspaceId, objective, context } = extractBureauContext(input);
    const orchResult = await ctx.serviceOrchestrator.dispatchCapability(
      { action: "DISPATCH_CAPABILITY", capability: "creative_studio", objective, context },
      { workspaceId },
    );
    return formatBureauResult("Creative Studio", orchResult);
  },
};
