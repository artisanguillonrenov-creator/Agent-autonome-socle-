import type { ChatMessage } from "../../types.js";
import type { CompletionOptions, LLMCompletionResult, LLMProvider } from "../provider.js";

interface OpenAIOptions {
  apiKey: string;
  model: string;
}

export class OpenAIProvider implements LLMProvider {
  readonly name = "openai";

  constructor(private readonly opts: OpenAIOptions) {}

  async complete(messages: ChatMessage[], options: CompletionOptions = {}): Promise<LLMCompletionResult> {
    if (!this.opts.apiKey) {
      throw new Error("OPENAI_API_KEY manquant : impossible d'appeler le fournisseur openai.");
    }

    const res = await fetch("https://api.openai.com/v1/chat/completions", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        authorization: `Bearer ${this.opts.apiKey}`,
      },
      body: JSON.stringify({
        model: this.opts.model,
        messages: messages.map((m) => ({
          role: m.role,
          content: m.content ?? "",
        })),
        max_tokens: options.maxTokens ?? 1024,
        temperature: options.temperature,
        stop: options.stopSequences,
      }),
    });

    if (!res.ok) {
      throw new Error(`OpenAI API ${res.status}: ${await res.text()}`);
    }
    const data = (await res.json()) as { choices: Array<{ message: { content: string } }> };
    return {
      content: data.choices[0]?.message.content ?? "",
      toolCalls: undefined,
    };
  }
}
