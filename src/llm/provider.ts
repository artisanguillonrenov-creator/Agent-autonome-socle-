import type { ChatMessage } from "../types.js";

export interface CompletionOptions {
  maxTokens?: number;
  temperature?: number;
  stopSequences?: string[];
}

/**
 * Interface agnostique : chaque fournisseur (Anthropic, OpenAI, Ollama, mock...)
 * n'a qu'à savoir transformer ChatMessage[] en texte. La boucle agent ne connaît
 * jamais le format propriétaire d'un fournisseur donné.
 */
export interface LLMProvider {
  readonly name: string;
  complete(messages: ChatMessage[], options?: CompletionOptions): Promise<string>;
}
