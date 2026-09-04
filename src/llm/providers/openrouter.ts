import type { ChatMessage } from "../../types.js";
import type { CompletionOptions, LLMProvider } from "../provider.js";

interface OpenRouterOptions {
  apiKey: string;
  model: string;
}

/**
 * OpenRouter expose une API compatible OpenAI mais route vers des dizaines de
 * modèles (Claude, GPT, Llama, Mistral...) avec une seule clé. Les noms de
 * modèle sont préfixés par le fournisseur, ex: "anthropic/claude-sonnet-5",
 * "openai/gpt-4o" — voir https://openrouter.ai/models.
 */
export class OpenRouterProvider implements LLMProvider {
  readonly name = "openrouter";

  constructor(private readonly opts: OpenRouterOptions) {}

  async complete(messages: ChatMessage[], options: CompletionOptions = {}): Promise<string> {
    if (!this.opts.apiKey) {
      throw new Error("OPENROUTER_API_KEY manquant : impossible d'appeler le fournisseur openrouter.");
    }

    const res = await fetch("https://openrouter.ai/api/v1/chat/completions", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        authorization: `Bearer ${this.opts.apiKey}`,
      },
      body: JSON.stringify({
        model: this.opts.model,
        messages: messages.map((m) => ({
          role: m.role === "tool" ? "user" : m.role,
          content: m.role === "tool" ? `[Résultat de compétence: ${m.name ?? "?"}]\n${m.content}` : m.content,
        })),
        max_tokens: options.maxTokens ?? 1024,
        temperature: options.temperature,
        stop: options.stopSequences,
      }),
    });

    if (!res.ok) {
      throw new Error(`OpenRouter API ${res.status}: ${await res.text()}`);
    }
    const data = (await res.json()) as { choices: Array<{ message: { content: string } }> };
    return data.choices[0]?.message.content ?? "";
  }
}
