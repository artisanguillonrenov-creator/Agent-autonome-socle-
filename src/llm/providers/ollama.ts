import { randomUUID } from "node:crypto";
import type { ChatMessage, ToolCall } from "../../types.js";
import type { CompletionOptions, LLMCompletionResult, LLMProvider } from "../provider.js";

interface OllamaOptions {
  baseUrl: string;
  model: string;
}

interface OllamaToolCall {
  id?: string;
  function?: {
    name?: string;
    arguments?: unknown;
  };
}

/** Ollama tourne localement par rapport au runtime backend. */
export class OllamaProvider implements LLMProvider {
  readonly name = "ollama";
  readonly model: string;

  constructor(private readonly opts: OllamaOptions) {
    this.model = opts.model;
  }

  supportsNativeTools(): boolean {
    // L'API Ollama sait transporter les tools. Le support du modèle précis est vérifié
    // séparément par le probe de localModelPriority avant de router Jarvis vers lui.
    return true;
  }

  async complete(messages: ChatMessage[], options: CompletionOptions = {}): Promise<LLMCompletionResult> {
    const res = await fetch(`${this.opts.baseUrl}/api/chat`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        model: this.opts.model,
        messages: messages.map((m) => ({
          role: m.role,
          content: m.content ?? "",
          ...(m.toolCalls?.length ? {
            tool_calls: m.toolCalls.map((call) => ({
              id: call.id,
              type: "function",
              function: {
                name: call.function.name,
                arguments: (() => {
                  try { return JSON.parse(call.function.arguments); } catch { return call.function.arguments; }
                })(),
              },
            })),
          } : {}),
          ...(m.role === "tool" && m.name ? { tool_name: m.name } : {}),
        })),
        stream: false,
        ...(options.tools?.length ? { tools: options.tools } : {}),
        options: {
          temperature: options.temperature,
          top_p: options.topP,
          num_predict: options.maxTokens,
          stop: options.stopSequences,
        },
      }),
    });

    if (!res.ok) {
      throw new Error(`Ollama API ${res.status}: ${await res.text()}`);
    }
    const data = (await res.json()) as {
      message?: { content?: string; tool_calls?: OllamaToolCall[] };
    };
    const toolCalls: ToolCall[] | undefined = data.message?.tool_calls?.map((call) => {
      const name = call.function?.name;
      if (!name) throw new Error("OLLAMA_TOOL_CALL_INVALID");
      const rawArgs = call.function?.arguments ?? {};
      return {
        id: call.id || `ollama_${randomUUID()}`,
        type: "function",
        function: {
          name,
          arguments: typeof rawArgs === "string" ? rawArgs : JSON.stringify(rawArgs),
        },
      };
    });

    return {
      content: data.message?.content ?? "",
      toolCalls: toolCalls?.length ? toolCalls : undefined,
    };
  }
}
