import type { ChatMessage, ToolCall } from "../../types.js";
import type { CompletionOptions, LLMCompletionResult, LLMProvider } from "../provider.js";

interface InfermaticOptions {
  apiKey: string;
  baseUrl: string;
  model: string;
}

/**
 * Infermatic (Core API) expose une API OpenAI-compatible : https://api.totalgpt.ai/v1.
 * Le protocole de tool calling natif suit le même format que OpenRouter/OpenAI (voir
 * openrouter.ts) : seules l'URL de base et l'absence de `parallel_tool_calls` (non
 * validé côté Infermatic, donc jamais imposé) diffèrent.
 */
export class InfermaticProvider implements LLMProvider {
  readonly name = "infermatic";

  constructor(private readonly opts: InfermaticOptions) {}

  supportsNativeTools(): boolean {
    return true;
  }

  async complete(messages: ChatMessage[], options: CompletionOptions = {}): Promise<LLMCompletionResult> {
    if (!this.opts.apiKey) {
      throw new Error("INFERMATIC_API_KEY manquant : impossible d'appeler le fournisseur infermatic.");
    }

    const endpoint = `${this.opts.baseUrl.replace(/\/+$/, "")}/chat/completions`;

    const formattedMessages = messages.map((m) => {
      if (m.role === "tool") {
        return {
          role: "tool",
          tool_call_id: m.toolCallId || "call_unknown",
          name: m.name,
          content: m.content ?? "",
        };
      }

      if (m.role === "assistant") {
        const msgObj: Record<string, unknown> = {
          role: "assistant",
          content: m.content ?? null,
        };
        if (m.toolCalls && m.toolCalls.length > 0) {
          msgObj.tool_calls = m.toolCalls;
        }
        return msgObj;
      }

      return {
        role: m.role,
        content: m.content ?? "",
      };
    });

    const body: Record<string, unknown> = {
      model: this.opts.model,
      messages: formattedMessages,
      max_tokens: options.maxTokens ?? 1024,
      temperature: options.temperature,
      stop: options.stopSequences,
    };

    if (options.tools && options.tools.length > 0) {
      body.tools = options.tools;
      body.tool_choice = options.toolChoice || "auto";
    }

    const res = await fetch(endpoint, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        authorization: `Bearer ${this.opts.apiKey}`,
      },
      body: JSON.stringify(body),
    });

    if (!res.ok) {
      const rawBody = await res.text().catch(() => "");
      let detail = rawBody.slice(0, 300);
      try {
        const parsed = JSON.parse(rawBody) as { error?: { message?: string } | string };
        detail = (typeof parsed.error === "string" ? parsed.error : parsed.error?.message) || detail;
      } catch {
        // rawBody n'est pas du JSON exploitable, on garde l'extrait brut tronqué.
      }
      throw new Error(`Infermatic API ${res.status}: ${detail || "erreur inconnue"}`);
    }

    const data = (await res.json()) as {
      choices?: Array<{ message?: { content?: string | null; tool_calls?: ToolCall[] } }>;
    };
    if (!Array.isArray(data.choices) || data.choices.length === 0) {
      throw new Error("Infermatic API : réponse sans choix (modèle possiblement incompatible avec /chat/completions).");
    }

    const message = data.choices[0]?.message;
    const content = message?.content ?? null;
    const toolCalls = Array.isArray(message?.tool_calls) && message.tool_calls.length > 0 ? message.tool_calls : undefined;

    return { content, toolCalls };
  }
}
