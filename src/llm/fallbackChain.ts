import { config } from "../config.js";
import { createLLMProvider } from "./providers/index.js";
import type { ChatMessage } from "../types.js";
import type { CompletionOptions, LLMCompletionResult, LLMProvider } from "./provider.js";

/**
 * Chantier 8 : chaîne de fallback modèle principal -> fallback1 -> fallback2.
 * Ne s'active QUE sur un échec réel du provider/modèle (erreur réseau, HTTP, clé
 * manquante...) — jamais sur une erreur métier ou de permission, qui ne transite pas
 * par LLMProvider.complete(). Bornée à 3 tentatives maximum : aucune boucle possible.
 * Si toute la chaîne échoue, l'erreur d'origine (modèle principal) est relancée
 * explicitement plutôt que masquée par un changement silencieux de modèle.
 */
export async function completeWithFallback(
  primary: LLMProvider,
  messages: ChatMessage[],
  options: CompletionOptions,
): Promise<LLMCompletionResult> {
  const fallbackModels = [config.llm.fallbackModel1, config.llm.fallbackModel2].filter(
    (m): m is string => typeof m === "string" && m.trim().length > 0,
  );

  try {
    return await primary.complete(messages, options);
  } catch (primaryError) {
    if (fallbackModels.length === 0) throw primaryError;

    const attemptedModels: string[] = [];
    for (const model of fallbackModels) {
      try {
        const fallbackProvider = createLLMProvider({ provider: primary.name as never, model, sanitizeReasoning: true });
        return await fallbackProvider.complete(messages, options);
      } catch {
        attemptedModels.push(model);
      }
    }

    const err = primaryError as Error;
    throw new Error(
      `LLM_FALLBACK_CHAIN_EXHAUSTED: modèle principal '${primary.name}' et fallback(s) [${attemptedModels.join(", ")}] ont tous échoué. Erreur d'origine: ${err.message}`,
    );
  }
}
