import { config } from "../config.js";

/**
 * Fenêtres de contexte connues (approximatives, en tokens) pour quelques familles de
 * modèles courantes. Recherche par sous-chaîne insensible à la casse sur l'id du modèle
 * — volontairement grossier : le but n'est pas un registre exhaustif mais d'éviter de
 * retomber sur `contextWindowOverride` quand une métadonnée fiable et évidente existe.
 */
const KNOWN_MODEL_CONTEXT_WINDOWS: Array<{ pattern: RegExp; tokens: number }> = [
  { pattern: /claude-3-5|claude-3\.5/i, tokens: 200000 },
  { pattern: /claude-3/i, tokens: 200000 },
  { pattern: /claude/i, tokens: 200000 },
  { pattern: /gpt-4o|gpt-4\.1/i, tokens: 128000 },
  { pattern: /gpt-4-turbo/i, tokens: 128000 },
  { pattern: /gpt-4/i, tokens: 8192 },
  { pattern: /gpt-3\.5-turbo-16k/i, tokens: 16385 },
  { pattern: /gpt-3\.5/i, tokens: 16385 },
  { pattern: /gemini-1\.5|gemini-2/i, tokens: 1000000 },
  { pattern: /llama-3\.1|llama-3\.2|llama-3\.3/i, tokens: 128000 },
  { pattern: /mixtral-8x22b/i, tokens: 65536 },
  { pattern: /mixtral/i, tokens: 32768 },
  { pattern: /qwen.*(72b|110b|235b)/i, tokens: 32768 },
  { pattern: /qwen/i, tokens: 32768 },
];

/**
 * Fenêtre de contexte (en tokens) à utiliser pour `provider`/`model`. Si aucune
 * métadonnée fiable n'est trouvée pour ce modèle, retombe sur
 * `intelligence.contextWindowOverride` (settings, propagé via config.llm.contextWindowOverride).
 */
export function resolveContextWindowTokens(model: string | undefined): number {
  if (model) {
    for (const entry of KNOWN_MODEL_CONTEXT_WINDOWS) {
      if (entry.pattern.test(model)) return entry.tokens;
    }
  }
  return config.llm.contextWindowOverride;
}

/**
 * Budget d'entrée (contexte) effectif à assembler, en tokens : le budget configuré
 * (`system.tokenBudget`) plafonné pour que entrée + sortie ne dépasse jamais la fenêtre
 * de contexte réelle du modèle — avec une marge de sécurité pour les messages système
 * incompressibles (rôle, historique récent) qui ne passent pas par ContextBudgetManager.
 */
export function resolveEffectiveInputBudget(model: string | undefined, requestedBudget: number, maxOutputTokens: number): number {
  const contextWindow = resolveContextWindowTokens(model);
  const safetyMarginTokens = 500;
  const maxAllowedInput = Math.max(200, contextWindow - maxOutputTokens - safetyMarginTokens);
  return Math.min(requestedBudget, maxAllowedInput);
}
