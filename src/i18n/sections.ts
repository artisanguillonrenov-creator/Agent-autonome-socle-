import { SETTINGS_SECTIONS, type SettingSection } from "../settings/catalog.js";

/**
 * Chantier 8 (settings.language) : traduction anglaise des libellés/descriptions de
 * sections de réglages, consommées par /api/settings/schema — effet réel et testable
 * de la langue sur l'IHM (au-delà de la langue de restitution du chat).
 */
const EN_SECTIONS: Record<SettingSection, { label: string; description: string }> = {
  general: { label: "General", description: "User interface, startup view, themes and navigation preferences" },
  intelligence: { label: "Intelligence", description: "LLM model providers, embeddings and hyperparameters" },
  autonomy: { label: "Autonomy & Security", description: "Risk management, permissions and execution limits" },
  connections: { label: "Connections & Services", description: "Remote service orchestration, endpoints and health checks" },
  projects_memory: { label: "Projects, Files & Memory", description: "Workspaces, storage limits and memory persistence" },
  skills_workflows: { label: "Skills, Workflows & Agents", description: "Skill catalog, business processes and specialists" },
  automations: { label: "Automations", description: "Scheduled tasks, WATCH monitoring and background execution" },
  activity_notifications: { label: "Activity & Notifications", description: "Observability logs, metrics and alert channels" },
  system_maintenance: { label: "System & Maintenance", description: "Backend status, diagnostics, exports and backups" },
};

export function localizedSettingsSections(language: "fr" | "en"): typeof SETTINGS_SECTIONS {
  if (language !== "en") return SETTINGS_SECTIONS;
  return SETTINGS_SECTIONS.map((s) => ({ id: s.id, ...EN_SECTIONS[s.id] }));
}
