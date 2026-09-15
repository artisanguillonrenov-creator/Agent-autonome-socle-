import type { ChatMessage } from "../../types.js";
import type { CompletionOptions, LLMCompletionResult, LLMProvider } from "../provider.js";
import { tracer } from "../../observability/tracer.js";
import { estimateTokens } from "../../observability/tokenEstimate.js";
import { estimateCostUsd } from "../../observability/pricing.js";

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
    async complete(messages: ChatMessage[], options?: CompletionOptions): Promise<LLMCompletionResult> {
      return tracer.withSpan(
        `llm.${provider.name}.complete`,
        { kind: "llm", inputs: { model: provider.model, provider: provider.name, prompt: promptPreview(messages).slice(0, 2000) } },
        async (span) => {
          const startedAt = Date.now();
          const result = await provider.complete(messages, options);
          const latencyMs = Date.now() - startedAt;
          const inputTokens = estimateTokens(promptPreview(messages));
          const outputTokens = estimateTokens(result.content ?? "");
          span.setUsage(inputTokens, outputTokens);
          span.setCost(estimateCostUsd(provider.model, inputTokens, outputTokens));
          span.setOutputs({
            contentPreview: (result.content ?? "").slice(0, 500),
            toolCalls: result.toolCalls?.map((call) => call.function?.name),
            latencyMs,
            model: provider.model,
          });
          return result;
        },
      );
    },
  };
  return traced;
}
