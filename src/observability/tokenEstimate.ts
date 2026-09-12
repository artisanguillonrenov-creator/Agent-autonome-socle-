/**
 * Estimation approximative des tokens consommés, faute d'un champ `usage` exposé par
 * l'ensemble des providers LLMProvider (aucun ne remonte input_tokens/output_tokens
 * aujourd'hui). Heuristique standard ~4 caractères/token, suffisante pour un ordre de
 * grandeur d'observabilité — jamais présentée comme une facturation exacte.
 */
export function estimateTokens(text: string | null | undefined): number {
  if (!text) return 0;
  return Math.ceil(text.length / 4);
}
