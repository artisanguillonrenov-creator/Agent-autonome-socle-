import type { ChatMessage } from "../../types.js";
import type { CompletionOptions, LLMCompletionResult, LLMProvider } from "../provider.js";

interface AnthropicOptions {
  apiKey: string;
  model: string;
}

/** Appel HTTP direct (pas de SDK) pour rester léger et sans dépendance propriétaire. */
export class AnthropicProvider implements LLMProvider {
  readonly name = "anthropic";
  readonly model: string;

  constructor(private readonly opts: AnthropicOptions) {
    this.model = opts.model;
  }

  /** Vague 8B : les modèles Claude 3+ acceptent tous des blocs image en entrée. */
  supportsVision(): boolean {
    return !/claude-[12](\D|$)/i.test(this.model);
  }

  async complete(messages: ChatMessage[], options: CompletionOptions = {}): Promise<LLMCompletionResult> {
    if (!this.opts.apiKey) {
      throw new Error("ANTHROPIC_API_KEY manquant : impossible d'appeler le fournisseur anthropic.");
    }

    const system = messages
      .filter((m) => m.role === "system")
      .map((m) => m.content ?? "")
      .join("\n\n");
    const rest = messages
      .filter((m) => m.role !== "system")
      .map((m) => ({
        role: m.role === "assistant" ? "assistant" : "user",
        content:
          m.images && m.images.length > 0
            ? [
                ...(m.content ? [{ type: "text", text: m.content }] : []),
                ...m.images.map((image) => ({
                  type: "image",
                  source: { type: "base64", media_type: image.mimeType, data: image.base64 },
                })),
              ]
            : m.content ?? "",
      }));

    const res = await fetch("https://api.anthropic.com/v1/messages", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-api-key": this.opts.apiKey,
        "anthropic-version": "2023-06-01",
      },
      body: JSON.stringify({
        model: this.opts.model,
        system: system || undefined,
        messages: rest,
        max_tokens: options.maxTokens ?? 1024,
        temperature: options.temperature,
        top_p: options.topP,
        stop_sequences: options.stopSequences,
      }),
    });

    if (!res.ok) {
      throw new Error(`Anthropic API ${res.status}: ${await res.text()}`);
    }
    const data = (await res.json()) as { content: Array<{ type: string; text?: string }> };
    const content = data.content
      .filter((block) => block.type === "text")
      .map((block) => block.text ?? "")
      .join("");

    return { content, toolCalls: undefined };
  }
}
