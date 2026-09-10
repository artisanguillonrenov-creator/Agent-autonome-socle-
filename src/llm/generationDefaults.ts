import { config } from "../config.js";
import type { CompletionOptions } from "./provider.js";

/**
 * Chantier 8 : temperature / topP / maxOutputTokens sont configurables depuis les
 * réglages (settings.intelligence.*) et doivent réellement atteindre les appels LLM.
 * Cette fonction complète UNIQUEMENT les champs absents d'un appel donné — un appel
 * qui impose volontairement sa propre limite technique (probe de compatibilité,
 * replanning déterministe, Software Factory) garde toujours la priorité.
 */
export function withGenerationDefaults(options: CompletionOptions = {}): CompletionOptions {
  return {
    ...options,
    temperature: options.temperature ?? config.llm.temperature,
    topP: options.topP ?? config.llm.topP,
    maxTokens: options.maxTokens ?? config.llm.maxOutputTokens,
  };
}
