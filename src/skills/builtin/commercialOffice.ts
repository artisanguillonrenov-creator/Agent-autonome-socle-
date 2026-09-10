import type { SkillDefinition } from "../../types.js";
import { formatBureauResult, extractBureauContext } from "./bureauSkillHelpers.js";
import { CONTACT_STATUSES } from "../../services/commercialOfficeStore.js";

const SEND_ACTION = "SEND_MESSAGE";

export const commercialOfficeSkill: SkillDefinition = {
  name: "commercial_office",
  displayName: "Commercial Office",
  description:
    "Bureau commercial : prospects, clients, opportunités, interactions, prochaines actions et brouillons de messages. PREPARE_MESSAGE ne fait que rédiger un brouillon ; SEND_MESSAGE envoie réellement un e-mail et est soumis à la permission SEND (autonomy.permissionMatrix) — jamais de contournement.",
  category: "Contrôle",
  kind: "SKILL",
  risk: "MEDIUM",
  executionTarget: "SERVICE_CAPABILITY",
  serviceCapability: "commercial_office",
  requiresWorkspace: false,
  tags: ["commercial", "crm", "prospection"],
  argsHint: '{"action": string, "objective"?: string, "workspaceId"?: string, ...}',
  parameters: {
    type: "object",
    properties: {
      action: {
        type: "string",
        enum: [
          "CREATE_PROSPECT",
          "UPDATE_STATUS",
          "CREATE_OPPORTUNITY",
          "UPDATE_OPPORTUNITY_STATUS",
          "LOG_INTERACTION",
          "PREPARE_MESSAGE",
          "CREATE_NEXT_ACTION",
          "COMPLETE_NEXT_ACTION",
          "LIST_STATE",
          SEND_ACTION,
        ],
      },
      objective: { type: "string", description: "Objectif de la mission" },
      workspaceId: { type: "string", description: "Projet/workspace concerné" },
      name: { type: "string", description: "Nom du prospect (action CREATE_PROSPECT)" },
      email: { type: "string", description: "E-mail du contact" },
      company: { type: "string", description: "Société du contact" },
      contactId: { type: "string", description: "Identifiant du contact" },
      status: { type: "string", enum: [...CONTACT_STATUSES], description: "Statut du contact/opportunité" },
      title: { type: "string", description: "Titre de l'opportunité ou de la prochaine action" },
      value: { type: "number", description: "Valeur de l'opportunité" },
      currency: { type: "string", description: "Devise de l'opportunité" },
      opportunityId: { type: "string", description: "Identifiant de l'opportunité" },
      type: { type: "string", description: "Type d'interaction (action LOG_INTERACTION)" },
      note: { type: "string", description: "Note libre" },
      occurredAt: { type: "integer", description: "Horodatage de l'interaction (epoch ms)" },
      kind: { type: "string", enum: ["PROSPECTING", "FOLLOWUP", "PROPOSAL"], description: "Type de message à préparer" },
      context: { type: "string", description: "Contexte libre pour la rédaction du message (action PREPARE_MESSAGE)" },
      dueAt: { type: "integer", description: "Échéance de la prochaine action (epoch ms)" },
      actionId: { type: "string", description: "Identifiant de la prochaine action à compléter" },
      subject: { type: "string", description: "Sujet de l'e-mail (action SEND_MESSAGE)" },
      text: { type: "string", description: "Corps de l'e-mail (action SEND_MESSAGE)" },
    },
    required: ["action"],
    additionalProperties: false,
  },
  handler: async (input, ctx) => {
    if (!ctx.serviceOrchestrator) return "Erreur: ServiceOrchestrator non configuré.";
    const { workspaceId, objective, context } = extractBureauContext(input);
    // SEND_MESSAGE cible la capacité distincte commercial_office_send (permission SEND) —
    // jamais la même capacité que la préparation de brouillon (commercial_office).
    const capability = input.action === SEND_ACTION ? "commercial_office_send" : "commercial_office";
    const orchResult = await ctx.serviceOrchestrator.dispatchCapability({ action: "DISPATCH_CAPABILITY", capability, objective, context }, { workspaceId });
    return formatBureauResult("Commercial Office", orchResult);
  },
};
