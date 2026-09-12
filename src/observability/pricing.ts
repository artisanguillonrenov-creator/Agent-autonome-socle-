/**
 * Table de prix approximative (USD pour 1M tokens) utilisée uniquement pour l'estimation
 * de coût en temps réel affichée dans l'arbre d'exécution. Volontairement non exhaustive :
 * un modèle absent retombe sur DEFAULT_RATE plutôt que de faire échouer le tracing.
 */
interface Rate { inputPer1M: number; outputPer1M: number }

const DEFAULT_RATE: Rate = { inputPer1M: 1, outputPer1M: 3 };

const RATE_TABLE: Array<{ pattern: RegExp; rate: Rate }> = [
  { pattern: /haiku/i, rate: { inputPer1M: 0.8, outputPer1M: 4 } },
  { pattern: /sonnet/i, rate: { inputPer1M: 3, outputPer1M: 15 } },
  { pattern: /opus/i, rate: { inputPer1M: 15, outputPer1M: 75 } },
  { pattern: /gpt-4o-mini/i, rate: { inputPer1M: 0.15, outputPer1M: 0.6 } },
  { pattern: /gpt-4o/i, rate: { inputPer1M: 2.5, outputPer1M: 10 } },
  { pattern: /\bo1\b/i, rate: { inputPer1M: 15, outputPer1M: 60 } },
  { pattern: /\bo3-mini\b/i, rate: { inputPer1M: 1.1, outputPer1M: 4.4 } },
  { pattern: /\bo3\b/i, rate: { inputPer1M: 10, outputPer1M: 40 } },
  { pattern: /deepseek-r1/i, rate: { inputPer1M: 0.55, outputPer1M: 2.19 } },
  { pattern: /mistral|mixtral|llama|qwen/i, rate: { inputPer1M: 0.3, outputPer1M: 0.3 } },
];

function rateFor(model: string | undefined): Rate {
  if (!model) return DEFAULT_RATE;
  return RATE_TABLE.find((entry) => entry.pattern.test(model))?.rate ?? DEFAULT_RATE;
}

export function estimateCostUsd(model: string | undefined, inputTokens: number, outputTokens: number): number {
  const rate = rateFor(model);
  return (inputTokens / 1_000_000) * rate.inputPer1M + (outputTokens / 1_000_000) * rate.outputPer1M;
}
