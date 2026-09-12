import { config } from "../config.js";
import { createLLMProvider } from "./providers/index.js";
import type { LLMProvider } from "./provider.js";

export type ModelRole = "coding" | "research" | "utility" | "reasoning" | "fast";

/**
 * Chantier 8 : modèles spécialisés (intelligence.codingModel/researchModel/utilityModel).
 * Phase 2 (routage dynamique) ajoute "reasoning" (modèle de raisonnement lourd — planification,
 * auto-réflexion/critique) et "fast" (modèle rapide & économique — exécution de routine).
 * Si aucun modèle spécialisé n'est configuré pour le rôle demandé, retombe sur le modèle
 * principal actif — jamais d'erreur, jamais de modèle vide envoyé au provider.
 * N'agit JAMAIS sur la Software Factory (config.softwareFactory.*), qui possède son
 * propre provider/modèle explicitement détenu et ne doit pas être écrasé silencieusement.
 */
export function resolveModelForRole(role: ModelRole): string | undefined {
  const configured = {
    coding: config.llm.codingModel,
    research: config.llm.researchModel,
    utility: config.llm.utilityModel,
    reasoning: config.llm.reasoningModel,
    fast: config.llm.fastModel,
  }[role];
  return configured && configured.trim().length > 0 ? configured.trim() : undefined;
}

/**
 * Construit un LLMProvider pour `role` sur le même provider actif que `fallbackProvider`,
 * seulement si un modèle spécialisé est réellement configuré pour ce rôle ; sinon renvoie
 * `fallbackProvider` tel quel (le modèle principal), sans instancier de nouveau provider.
 */
export function providerForRole(role: ModelRole, fallbackProvider: LLMProvider): LLMProvider {
  const model = resolveModelForRole(role);
  if (!model) return fallbackProvider;
  return createLLMProvider({ provider: fallbackProvider.name as never, model, sanitizeReasoning: true });
}
