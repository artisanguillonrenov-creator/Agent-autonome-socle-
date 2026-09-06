import type { ChatMessage } from "../../types.js";
import type { CompletionOptions, LLMProvider } from "../provider.js";

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

    const data = (await res.json()) as {
      choices?: Array<{ message?: { content?: string } }>;
      error?: { message?: string; code?: number } | string;
    };

    if (data.error) {
      const errMsg = typeof data.error === "object" ? data.error.message || JSON.stringify(data.error) : String(data.error);
      throw new Error(`OpenRouter API error: ${errMsg}`);
    }

    if (!Array.isArray(data.choices) || data.choices.length === 0) {
      throw new Error("OpenRouter API a renvoyé une réponse sans choix ('choices' manquant ou vide).");
    }

    const content = data.choices[0]?.message?.content;
    if (typeof content !== "string") {
      throw new Error("OpenRouter API a renvoyé un contenu de message invalide.");
    }

    return content;
  }
}
