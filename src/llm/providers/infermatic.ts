import type { ChatMessage } from "../../types.js";
import type { CompletionOptions, LLMCompletionResult, LLMProvider } from "../provider.js";

interface InfermaticOptions {
  apiKey: string;
  baseUrl: string;
  model: string;
}

export class InfermaticProvider implements LLMProvider {
  readonly name = "infermatic";

  constructor(private readonly opts: InfermaticOptions) {}

  async complete(messages: ChatMessage[], options: CompletionOptions = {}): Promise<LLMCompletionResult> {
    if (!this.opts.apiKey) {
      throw new Error("INFERMATIC_API_KEY manquant : impossible d'appeler le fournisseur infermatic.");
    }

    const endpoint = `${this.opts.baseUrl.replace(/\/+$/, "")}/chat/completions`;

    const res = await fetch(endpoint, {
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
    const data = (await res.json()) as { choices?: Array<{ message: { content: string } }> };
    if (!data.choices || data.choices.length === 0) {
      throw new Error("Infermatic API : réponse sans choix (modèle possiblement incompatible avec /chat/completions).");
    }
    return {
      content: data.choices[0]?.message.content ?? "",
      toolCalls: undefined,
    };
  }
}
