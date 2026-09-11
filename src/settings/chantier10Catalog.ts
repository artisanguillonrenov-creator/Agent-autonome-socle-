import { SETTINGS_CATALOG, type SettingDefinition } from "./catalog.js";

let registered = false;

function enableExisting(key: string, description: string): void {
  const def = SETTINGS_CATALOG.find((entry) => entry.key === key);
  if (!def) throw new Error(`CHANTIER10_SETTING_MISSING: ${key}`);
  def.description = description;
  def.editable = true;
  def.availability = "AVAILABLE";
  def.unavailableReason = undefined;
  def.plannedChantier = 10;
}

function addIfMissing(definition: SettingDefinition): void {
  if (!SETTINGS_CATALOG.some((entry) => entry.key === definition.key)) SETTINGS_CATALOG.push(definition);
}

/**
 * Additive registry extension kept separate from the historical catalogue file so the
 * Chantier 10 feature can be loaded before SettingsStore starts serving the runtime.
 */
export function registerChantier10Settings(): void {
  if (registered) return;
  registered = true;

  enableExisting(
    "settings.automaticVoiceReading",
    "Lit automatiquement via le runtime Android natif les réponses initiées depuis le chat texte lorsque l'application native est disponible.",
  );
  enableExisting(
    "intelligence.localModelPriority",
    "Préfère un candidat LLM local sain et compatible avec le contexte et les tools ; retombe immédiatement sur le provider nominal sinon.",
  );
  enableExisting(
    "activity.androidPush",
    "Acheminement des notifications vers l'application Android active/FGS sous forme de notifications locales ; aucun push distant n'est simulé.",
  );
  enableExisting(
    "activity.smsAlerts",
    "Envoie les alertes importantes via une passerelle SMS webhook configurée ; n'utilise jamais Android SEND_SMS.",
  );
  enableExisting(
    "activity.voiceAlerts",
    "Annonce vocalement les alertes importantes via le même moteur TTS Android lorsque le runtime vocal est disponible.",
  );

  addIfMissing({
    key: "settings.voiceMode",
    section: "general",
    label: "Mode vocal",
    description: "Contrôle la couche vocale Android sans créer d'Agent séparé.",
    type: "enum",
    level: "SIMPLE",
    defaultValue: "OFF",
    editable: true,
    availability: "AVAILABLE",
    requiresRestart: false,
    validation: { enumValues: ["OFF", "PUSH_TO_TALK", "CONVERSATION", "ALWAYS_LISTENING"] },
    plannedChantier: 10,
  });

  addIfMissing({
    key: "settings.voiceResponseMode",
    section: "general",
    label: "Longueur de lecture vocale",
    description: "FULL lit le texte complet, SUMMARY lit un résumé aval, AUTO choisit selon la longueur sans altérer la réponse de l'Agent.",
    type: "enum",
    level: "SIMPLE",
    defaultValue: "AUTO",
    editable: true,
    availability: "AVAILABLE",
    requiresRestart: false,
    validation: { enumValues: ["AUTO", "FULL", "SUMMARY"] },
    plannedChantier: 10,
  });
}
