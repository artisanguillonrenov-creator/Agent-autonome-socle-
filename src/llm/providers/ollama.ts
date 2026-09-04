import type { ChatMessage } from "../../types.js";
import type { CompletionOptions, LLMProvider } from "../provider.js";

interface OllamaOptions {
  baseUrl: string;
  model: string;
}

/** Ollama tourne en local (http://localhost:11434) : pas de dépendance à un service externe. */
export class OllamaProvider implements LLMProvider {
  readonly name = "ollama";

  constructor(private readonly opts: OllamaOptions) {}

  async complete(messages: ChatMessage[], options: CompletionOptions = {}): Promise<string> {
    const res = await fetch(`${this.opts.baseUrl}/api/chat`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        model: this.opts.model,
        messages: messages.map((m) => ({
          role: m.role === "tool" ? "user" : m.role,
          content: m.role === "tool" ? `[Résultat de compétence: ${m.name ?? "?"}]\n${m.content}` : m.content,
        })),
        stream: false,
        options: {
          temperature: options.temperature,
          num_predict: options.maxTokens,
          stop: options.stopSequences,
        },
      }),
    });

    if (!res.ok) {
      throw new Error(`Ollama API ${res.status}: ${await res.text()}`);
    }
    const data = (await res.json()) as { message: { content: string } };
    return data.message.content;
  }
}
