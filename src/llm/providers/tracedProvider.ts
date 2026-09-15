import type { ChatMessage } from "../../types.js";
import type { CompletionOptions, LLMCompletionResult, LLMProvider } from "../provider.js";
import { tracer } from "../../observability/tracer.js";
import { estimateTokens } from "../../observability/tokenEstimate.js";
import { estimateCostUsd } from "../../observability/pricing.js";
import { financialCircuitBreaker } from "../../context/financialCircuitBreaker.js";

function promptPreview(messages: ChatMessage[]): string {
  return messages.map((m) => `${m.role}: ${typeof m.content === "string" ? m.content : ""}`).join("\n");
}

/**
 * Décore un LLMProvider pour que CHAQUE appel `complete()` — quel que soit le point
 * d'appel (boucle agent, planification, réflexion, guardrail, multi-agents, Software
 * Factory...) — produise un span Tracer kind "llm" avec modèle, prompt, latence et
 * tokens in/out, exporté vers Langfuse quand configuré (src/observability/tracer.ts).
 * Purement additif : ne change ni la signature ni le comportement du provider décoré.
 */
export function withTracing(provider: LLMProvider): LLMProvider {
  const traced: LLMProvider = {
    name: provider.name,
    model: provider.model,
    supportsNativeTools: provider.supportsNativeTools?.bind(provider),
    supportsVision: provider.supportsVision?.bind(provider),
    async complete(messages: ChatMessage[], options?: CompletionOptions): Promise<LLMCompletionResult> {
      // Vague 8A (disjoncteur financier) : point de contrôle unique, avant tout appel réel au
      // fournisseur — un disjoncteur déjà déclenché bloque cet appel immédiatement (aucune
      // requête réseau, aucun coût supplémentaire), qu'il vienne de la boucle agent, d'une
      // réflexion, d'une planification ou de la Software Factory.
      financialCircuitBreaker.assertWithinBudget();
      return tracer.withSpan(
        `llm.${provider.name}.complete`,
        { kind: "llm", inputs: { model: provider.model, provider: provider.name, prompt: promptPreview(messages).slice(0, 2000) } },
        async (span) => {
          const startedAt = Date.now();
          const result = await provider.complete(messages, options);
          const latencyMs = Date.now() - startedAt;
          const inputTokens = estimateTokens(promptPreview(messages));
          const outputTokens = estimateTokens(result.content ?? "");
          const costUsd = estimateCostUsd(provider.model, inputTokens, outputTokens);
          span.setUsage(inputTokens, outputTokens);
          span.setCost(costUsd);
          span.setOutputs({
            contentPreview: (result.content ?? "").slice(0, 500),
            toolCalls: result.toolCalls?.map((call) => call.function?.name),
            latencyMs,
            model: provider.model,
          });
          financialCircuitBreaker.record(costUsd, provider.model, provider.name);
          // Ce même appel a pu faire franchir le seuil : on l'a laissé aboutir (déjà facturé,
          // irréversible), mais on déclenche immédiatement le gel pour tous les appels suivants.
          financialCircuitBreaker.assertWithinBudget();
          return result;
        },
      );
    },
  };
  return traced;
}
