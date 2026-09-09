import type { Agent } from "../core/agent.js";
import { config } from "../config.js";
import { SettingsStore } from "./store.js";

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
    }
  }

  if (agent.skills && agent.serviceOrchestrator?.registry) {
    agent.skills.refreshServiceAvailability(agent.serviceOrchestrator.registry);
  }
}
