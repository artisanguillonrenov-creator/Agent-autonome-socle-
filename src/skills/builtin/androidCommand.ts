import type { SkillDefinition } from "../../types.js";
import { androidCommandBus, type AndroidIntentType } from "../../autonomy/androidCommandBus.js";

const ALLOWED_TYPES: AndroidIntentType[] = ["OPEN_NAVIGATION_APP", "TRIGGER_SOUND_ALERT", "UPDATE_WIDGET", "OPEN_URL", "CUSTOM"];

/**
 * Vague 9D : permet à l'agent d'envoyer une commande en arrière-plan vers l'application
 * Android (ouvrir la navigation, déclencher une alerte sonore système, rafraîchir le widget
 * Jarvis, ouvrir une URL). Livrée via FCM si configuré, sinon consultable par polling
 * (GET /api/android/commands) — voir androidCommandBus.ts.
 */
export const sendAndroidCommandSkill: SkillDefinition = {
  name: "send_android_command",
  description:
    "Envoie une commande en arrière-plan au smartphone Android (ouvrir la navigation, déclencher une alerte sonore " +
    "système, rafraîchir le widget Jarvis, ouvrir une URL).",
  argsHint: '{"type": "OPEN_NAVIGATION_APP"|"TRIGGER_SOUND_ALERT"|"UPDATE_WIDGET"|"OPEN_URL"|"CUSTOM", "payload"?: object}',
  category: "Technique",
  parameters: {
    type: "object",
    properties: {
      type: { type: "string", enum: ALLOWED_TYPES, description: "Type d'intent Android ciblé" },
      payload: { type: "object", description: "Données additionnelles (ex: {\"url\":\"...\"}, {\"destination\":\"...\"})" },
    },
    required: ["type"],
    additionalProperties: false,
  },
  handler: async (input) => {
    const type = String(input.type ?? "");
    if (!ALLOWED_TYPES.includes(type as AndroidIntentType)) {
      return `Erreur send_android_command : type invalide (attendu: ${ALLOWED_TYPES.join(", ")}).`;
    }
    const payload =
      input.payload && typeof input.payload === "object" && !Array.isArray(input.payload)
        ? (input.payload as Record<string, unknown>)
        : {};
    const command = await androidCommandBus.send(type as AndroidIntentType, payload);
    return JSON.stringify({ commandId: command.id, delivered: Boolean(command.deliveredAt) });
  },
};
