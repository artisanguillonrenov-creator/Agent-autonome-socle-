import type { SkillDefinition } from "../../types.js";

export const dispatchCapabilitySkill: SkillDefinition = {
  name: "dispatch_capability",
  description: "Délègue une tâche ou une capacité à un service externe spécialisé (ex: développement de logiciel).",
  argsHint: '{"capability": string, "objective": string, "context"?: object, "constraints"?: string[]}',
  parameters: {
    type: "object",
    properties: {
      capability: {
        type: "string",
        description: "Nom de la capacité externe demandée (ex: software_development)",
      },
      objective: {
        type: "string",
        description: "Description claire de ce qui doit être réalisé par le service externe",
      },
      context: {
        type: "object",
        description: "Données de contexte additionnelles sous forme d'objet",
      },
      constraints: {
        type: "array",
        items: { type: "string" },
        description: "Contraintes spécifiques à respecter",
      },
    },
    required: ["capability", "objective"],
    additionalProperties: false,
  },
  handler: async (input, ctx) => {
    if (!ctx.serviceOrchestrator) {
      return "Erreur: ServiceOrchestrator non configuré.";
    }

    const capability = String(input.capability ?? "").trim();
    const objective = String(input.objective ?? "").trim();
    if (!capability || !objective) {
      return "Erreur: 'capability' et 'objective' sont requis pour dispatch_capability.";
    }

    const context = typeof input.context === "object" && input.context !== null ? (input.context as Record<string, unknown>) : {};
    const constraints = Array.isArray(input.constraints) ? input.constraints.map(String) : [];

    const orchResult = await ctx.serviceOrchestrator.dispatchCapability({
      action: "DISPATCH_CAPABILITY",
      capability,
      objective,
      context,
      constraints,
    });

    if (orchResult.status === "COMPLETED") {
      return `[Service ${orchResult.selectedService}] Résultat de '${capability}': ${orchResult.result ?? "Tâche terminée avec succès."}`;
    } else if (orchResult.status === "FAILED") {
      return `[Service ${orchResult.selectedService}] Échec de '${capability}': ${orchResult.error ?? "Erreur inconnue"}`;
    } else if (orchResult.status === "REJECTED") {
      return `[Service ${orchResult.selectedService}] Capacité '${capability}' rejetée: ${orchResult.error ?? "Rejeté par le service."}`;
    } else {
      return `[Service ${orchResult.selectedService}] Capacité '${capability}' status=${orchResult.status}: ${orchResult.result || orchResult.error || "En cours"}`;
    }
  },
};
