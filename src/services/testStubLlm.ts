import type { ChatMessage } from "../types.js";
import type { CompletionOptions, LLMCompletionResult, LLMProvider } from "../llm/provider.js";
import type { ModelRole } from "../llm/modelRouter.js";

/** Fournisseur LLM contrôlable pour les tests des bureaux métier (Chantier 9). */
export class StubLLMProvider implements LLMProvider {
  readonly name = "stub";
  public calls: ChatMessage[][] = [];
  constructor(private readonly responder: (messages: ChatMessage[]) => string) {}
  async complete(messages: ChatMessage[], _options?: CompletionOptions): Promise<LLMCompletionResult> {
    this.calls.push(messages);
    return { content: this.responder(messages) };
  }
}

export function jsonLlmFactory(json: Record<string, unknown>): (role?: ModelRole) => LLMProvider {
  return () => new StubLLMProvider(() => JSON.stringify(json));
}

export function textLlmFactory(text: string): (role?: ModelRole) => LLMProvider {
  return () => new StubLLMProvider(() => text);
}
