import type { Agent } from "../core/agent.js";
import { config } from "../config.js";
import { SettingsStore } from "./store.js";

/**
 * Point d'application UNIQUE des réglages effectifs vers le runtime (config.*), appelé
 * à la fois au démarrage et après toute modification à chaud (PATCH/reset/import) —
 * afin de ne jamais avoir deux implémentations divergentes de la prise en compte des
 * réglages entre le démarrage et la modification en cours de fonctionnement.
 */
export function applyAllEffectiveRuntimeSettings(agent: Agent, settingsStore = new SettingsStore()): void {
  const settings = settingsStore.getAllEffectiveSettings("GLOBAL", "global");

  for (const s of settings) {
    const key = s.definition.key;
    const val = s.effectiveValue;

    if (key === "system.tokenBudget" && typeof val === "number") {
      config.context.tokenBudget = val;
    } else if (key === "autonomy.maxIterations" && typeof val === "number") {
      config.agent.maxIterations = val;
    } else if (key === "skills.reflectionEveryNSteps" && typeof val === "number") {
      config.reflection.everyNSteps = val;
    } else if (key === "intelligence.skillSelectorMax" && typeof val === "number") {
      config.skills.selectorMax = val;
      if (agent.skillSelector) {
        (agent.skillSelector as any).maxSkills = val;
      }
    } else if (key === "automations.backgroundMaxConcurrent" && typeof val === "number") {
      config.background.maxConcurrent = val;
    } else if (key === "projects.workspaceMaxFileBytes" && typeof val === "number") {
      config.workspace.maxFileBytes = val;
    } else if (key === "projects.workspaceMaxTotalBytes" && typeof val === "number") {
      config.workspace.maxTotalBytes = val;
    } else if (key === "settings.language" && typeof val === "string") {
      config.locale.language = val as "fr" | "en";
    } else if (key === "settings.responseLength" && typeof val === "string") {
      config.locale.responseLength = val as "SHORT" | "NORMAL" | "DETAILED";
    } else if (key === "settings.automaticVoiceReading" && typeof val === "boolean") {
      config.voice.automaticVoiceReading = val;
    } else if (key === "settings.voiceMode" && typeof val === "string") {
      config.voice.mode = val as typeof config.voice.mode;
    } else if (key === "settings.voiceResponseMode" && typeof val === "string") {
      config.voice.responseMode = val as typeof config.voice.responseMode;
    } else if (key === "intelligence.temperature" && typeof val === "number") {
      config.llm.temperature = val;
    } else if (key === "intelligence.topP" && typeof val === "number") {
      config.llm.topP = val;
    } else if (key === "intelligence.maxOutputTokens" && typeof val === "number") {
      config.llm.maxOutputTokens = val;
    } else if (key === "intelligence.contextWindowOverride" && typeof val === "number") {
      config.llm.contextWindowOverride = val;
    } else if (key === "intelligence.fallbackModel1" && typeof val === "string") {
      config.llm.fallbackModel1 = val;
    } else if (key === "intelligence.fallbackModel2" && typeof val === "string") {
      config.llm.fallbackModel2 = val;
    } else if (key === "intelligence.codingModel" && typeof val === "string") {
      config.llm.codingModel = val;
    } else if (key === "intelligence.researchModel" && typeof val === "string") {
      config.llm.researchModel = val;
    } else if (key === "intelligence.utilityModel" && typeof val === "string") {
      config.llm.utilityModel = val;
    } else if (key === "intelligence.localModelPriority" && typeof val === "boolean") {
      config.llm.localModelPriority = val;
    } else if (key === "autonomy.globalRiskLevel" && typeof val === "string") {
      config.autonomy.globalRiskLevel = val as typeof config.autonomy.globalRiskLevel;
    } else if (key === "autonomy.permissionMatrix" && typeof val === "string") {
      config.autonomy.permissionMatrix = val as typeof config.autonomy.permissionMatrix;
    } else if (key === "connections.autoTestOnStartup" && typeof val === "boolean") {
      config.connections.autoTestOnStartup = val;
    } else if (key === "connections.healthTimeoutMs" && typeof val === "number") {
      config.connections.healthTimeoutMs = val;
    } else if (key === "connections.requestTimeoutMs" && typeof val === "number") {
      config.connections.requestTimeoutMs = val;
    } else if (key === "projects.projectIsolation" && typeof val === "boolean") {
      config.projects.projectIsolation = val;
    } else if (key === "projects.knowledgeRag" && typeof val === "boolean") {
      config.projects.knowledgeRag = val;
    } else if (key === "projects.autoIndexing" && typeof val === "boolean") {
      config.projects.autoIndexing = val;
    } else if (key === "projects.memoryRetentionDays" && typeof val === "number") {
      config.projects.memoryRetentionDays = val;
    } else if (key === "activity.logLevel" && typeof val === "string") {
      config.activity.logLevel = val as typeof config.activity.logLevel;
    } else if (key === "activity.emailAlerts" && typeof val === "boolean") {
      config.activity.emailAlerts = val;
    } else if (key === "activity.androidPush" && typeof val === "boolean") {
      config.activity.androidPush = val;
    } else if (key === "activity.smsAlerts" && typeof val === "boolean") {
      config.activity.smsAlerts = val;
    } else if (key === "activity.voiceAlerts" && typeof val === "boolean") {
      config.activity.voiceAlerts = val;
    } else if (key === "automations.emailTriggers" && typeof val === "boolean") {
      config.automations.emailTriggers = val;
    } else if (key === "automations.crmTriggers" && typeof val === "boolean") {
      config.automations.crmTriggers = val;
    } else if (key === "automations.externalEventTriggers" && typeof val === "boolean") {
      config.automations.externalEventTriggers = val;
    } else if (key === "skills.studioProduct" && typeof val === "boolean") {
      config.skills.studioProduct = val;
      setBureauServiceEnabled(agent, "product_studio", val);
    } else if (key === "skills.studioCreative" && typeof val === "boolean") {
      config.skills.studioCreative = val;
      setBureauServiceEnabled(agent, "creative_studio", val);
    } else if (key === "skills.officeCommercial" && typeof val === "boolean") {
      config.skills.officeCommercial = val;
      setBureauServiceEnabled(agent, "commercial_office", val);
    } else if (key === "skills.officeMarketing" && typeof val === "boolean") {
      config.skills.officeMarketing = val;
      setBureauServiceEnabled(agent, "marketing_office", val);
    }
  }

  if (agent.skills && agent.serviceOrchestrator?.registry) {
    agent.skills.refreshServiceAvailability(agent.serviceOrchestrator.registry);
  }
}

/**
 * skills.studioProduct/studioCreative/officeCommercial/officeMarketing : le bureau
 * correspondant n'est réellement AVAILABLE (skill + capacité dispatchable) que si son
 * réglage est activé ET le service local est enabled=true dans le ServiceRegistry —
 * seul le champ `enabled` est patché (jamais endpoint/transport/capabilities), donc
 * ceci ne peut jamais entrer en conflit avec une opération déjà en cours.
 */
function setBureauServiceEnabled(agent: Agent, serviceId: string, enabled: boolean): void {
  try {
    if (agent.serviceOrchestrator?.registry?.getServiceById(serviceId)) {
      agent.serviceOrchestrator.registry.patchService(serviceId, { enabled });
    }
  } catch {
    // SERVICE_CONNECTION_IN_USE ou absence du service factory (ex. tests isolés) : le
    // réglage reste persisté en base et sera réappliqué au prochain appel de cette fonction.
  }
}
