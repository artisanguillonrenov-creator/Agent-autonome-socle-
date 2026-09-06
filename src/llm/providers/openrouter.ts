import type { ChatMessage, ToolCall } from "../../types.js";
import type { CompletionOptions, LLMCompletionResult, LLMProvider } from "../provider.js";

interface OpenRouterOptions {
  apiKey: string;
  model: string;
}

/**
 * OpenRouter expose une API compatible OpenAI mais route vers des dizaines de
 * modèles (Claude, GPT, Llama, Mistral...) avec une seule clé.
 */

export class OpenRouterProvider implements LLMProvider {
  readonly name = "openrouter";

  constructor(private readonly opts: OpenRouterOptions) {}

  supportsNativeTools(): boolean {
    return true;
  }

  async complete(messages: ChatMessage[], options: CompletionOptions = {}): Promise<LLMCompletionResult> {
    if (!this.opts.apiKey) {
      throw new Error("OPENROUTER_API_KEY manquant : impossible d'appeler le fournisseur openrouter.");
    }

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
      body.parallel_tool_calls = false;
    }

    const res = await fetch("https://openrouter.ai/api/v1/chat/completions", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        authorization: `Bearer ${this.opts.apiKey}`,
      },
      body: JSON.stringify(body),
    });

    if (!res.ok) {
      throw new Error(`OpenRouter API ${res.status}: ${await res.text()}`);
    }

    const data = (await res.json()) as {
      choices?: Array<{
        message?: {
          content?: string | null;
          tool_calls?: ToolCall[];
        };
      }>;
      error?: { message?: string; code?: number } | string;
    };

    if (data.error) {
      const errMsg = typeof data.error === "object" ? data.error.message || JSON.stringify(data.error) : String(data.error);
      throw new Error(`OpenRouter API error: ${errMsg}`);
    }

    if (!Array.isArray(data.choices) || data.choices.length === 0) {
      throw new Error("OpenRouter API a renvoyé une réponse sans choix ('choices' manquant ou vide).");
    }

    const message = data.choices[0]?.message;
    const content = message?.content ?? null;
    const toolCalls = Array.isArray(message?.tool_calls) && message.tool_calls.length > 0 ? message.tool_calls : undefined;

    if (typeof content !== "string" && !toolCalls) {
      throw new Error("OpenRouter API a renvoyé un contenu de message et des tool_calls invalides.");
    }

    return {
      content,
      toolCalls,
    };
  }
}
