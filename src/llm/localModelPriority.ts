import { config } from "../config.js";
import type { ChatMessage } from "../types.js";
import type { CompletionOptions, LLMCompletionResult, LLMProvider, ToolDefinition } from "./provider.js";
import { completeWithFallback } from "./fallbackChain.js";
import { createLLMProvider } from "./providers/index.js";

interface LocalProbeResult {
  healthy: boolean;
  supportsTools: boolean;
  contextWindow?: number;
  error?: string;
  expiresAt: number;
}

const probeCache = new Map<string, LocalProbeResult>();

const TOOL_PROBE: ToolDefinition = {
  type: "function",
  function: {
    name: "jarvis_local_tool_probe",
    description: "Internal compatibility probe. Call this function exactly once.",
    parameters: {
      type: "object",
      properties: { value: { type: "string" } },
      required: ["value"],
      additionalProperties: false,
    },
  },
};

function estimateInputTokens(messages: ChatMessage[], options: CompletionOptions): number {
  const chars = messages.reduce((sum, message) => sum + (message.content?.length ?? 0), 0)
    + JSON.stringify(options.tools ?? []).length;
  return Math.ceil(chars / 4) + (options.maxTokens ?? config.llm.maxOutputTokens);
}

function findContextWindow(modelInfo: Record<string, unknown> | undefined): number | undefined {
  if (!modelInfo) return undefined;
  for (const [key, value] of Object.entries(modelInfo)) {
    if (/context_length$/i.test(key) && typeof value === "number" && Number.isFinite(value) && value > 0) {
      return value;
    }
  }
  return undefined;
}

async function probeOllama(model: string, requireTools: boolean): Promise<LocalProbeResult> {
  const cacheKey = `ollama:${model}:${requireTools ? "tools" : "chat"}`;
  const cached = probeCache.get(cacheKey);
  if (cached && cached.expiresAt > Date.now()) return cached;

  const expiresAt = Date.now() + config.llm.localProbeTtlMs;
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), Math.min(config.connections.healthTimeoutMs, 10_000));
  try {
    const response = await fetch(`${config.llm.ollamaBaseUrl}/api/show`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ model }),
      signal: controller.signal,
    });
    if (!response.ok) {
      const result = { healthy: false, supportsTools: false, error: `OLLAMA_HEALTH_${response.status}`, expiresAt };
      probeCache.set(cacheKey, result);
      return result;
    }

    const payload = await response.json() as { model_info?: Record<string, unknown> };
    const contextWindow = findContextWindow(payload.model_info) || (config.llm.localContextWindow > 0 ? config.llm.localContextWindow : undefined);
    const provider = createLLMProvider({ provider: "ollama", model, sanitizeReasoning: true });
    let supportsTools = provider.supportsNativeTools?.() === true;

    if (requireTools && supportsTools) {
      try {
        const probe = await provider.complete(
          [
            { role: "system", content: "You are a compatibility probe. Follow the next instruction exactly." },
            { role: "user", content: 'Call jarvis_local_tool_probe with value exactly "OK". Do not answer in plain text.' },
          ],
          { maxTokens: 64, tools: [TOOL_PROBE] },
        );
        const call = probe.toolCalls?.find((candidate) => candidate.function.name === "jarvis_local_tool_probe");
        if (!call) {
          supportsTools = false;
        } else {
          try {
            const args = JSON.parse(call.function.arguments) as { value?: unknown };
            supportsTools = args.value === "OK";
          } catch {
            supportsTools = false;
          }
        }
      } catch {
        supportsTools = false;
      }
    }

    const result: LocalProbeResult = { healthy: true, supportsTools, contextWindow, expiresAt };
    probeCache.set(cacheKey, result);
    return result;
  } catch (error) {
    const result = {
      healthy: false,
      supportsTools: false,
      error: (error as Error).name === "AbortError" ? "LOCAL_MODEL_HEALTH_TIMEOUT" : "LOCAL_MODEL_UNREACHABLE",
      expiresAt,
    };
    probeCache.set(cacheKey, result);
    return result;
  } finally {
    clearTimeout(timeout);
  }
}

async function selectLocalProvider(
  messages: ChatMessage[],
  options: CompletionOptions,
): Promise<LLMProvider | null> {
  if (!config.llm.localModelPriority) return null;
  const model = config.llm.localModel.trim();
  if (!model) {
    console.info("[JARVIS-LOCAL] LOCAL_MODEL_NOT_CONFIGURED");
    return null;
  }
  if (config.llm.localProvider !== "ollama") {
    console.warn(`[JARVIS-LOCAL] LOCAL_PROVIDER_UNSUPPORTED_V1: ${config.llm.localProvider}`);
    return null;
  }

  const requireTools = Boolean(options.tools?.length);
  const probe = await probeOllama(model, requireTools);
  if (!probe.healthy) {
    console.warn(`[JARVIS-LOCAL] ${probe.error || "LOCAL_MODEL_UNHEALTHY"}`);
    return null;
  }
  if (requireTools && !probe.supportsTools) {
    console.warn("[JARVIS-LOCAL] LOCAL_MODEL_TOOLS_UNSUPPORTED");
    return null;
  }

  const requiredTokens = estimateInputTokens(messages, options);
  if (!probe.contextWindow) {
    console.warn("[JARVIS-LOCAL] LOCAL_MODEL_CONTEXT_UNKNOWN");
    return null;
  }
  if (requiredTokens > probe.contextWindow) {
    console.warn(`[JARVIS-LOCAL] LOCAL_MODEL_CONTEXT_TOO_SMALL required=${requiredTokens} available=${probe.contextWindow}`);
    return null;
  }

  return createLLMProvider({ provider: "ollama", model, sanitizeReasoning: true });
}

/**
 * One bounded local attempt, then the existing nominal fallback chain. There is no
 * local↔remote loop and Software Factory never calls this helper.
 */
export async function completeWithLocalPriority(
  nominalProvider: LLMProvider,
  messages: ChatMessage[],
  options: CompletionOptions,
): Promise<LLMCompletionResult> {
  const local = await selectLocalProvider(messages, options);
  if (!local) return completeWithFallback(nominalProvider, messages, options);
  try {
    console.info(`[JARVIS-LOCAL] using ${local.name}:${local.model || "unknown"}`);
    return await local.complete(messages, options);
  } catch (error) {
    console.warn(`[JARVIS-LOCAL] local attempt failed, switching once to nominal provider: ${(error as Error).message}`);
    return completeWithFallback(nominalProvider, messages, options);
  }
}

export function clearLocalModelProbeCacheForTests(): void {
  probeCache.clear();
}
