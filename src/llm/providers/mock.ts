import type { ChatMessage } from "../../types.js";
import type { CompletionOptions, LLMProvider } from "../provider.js";

/**
 * Fournisseur sans réseau ni clé API : permet de faire tourner tout le socle
 * (boucle, mémoire, planification...) hors-ligne, pour développer et tester.
 * Répond simplement en reprenant le dernier message utilisateur.
 */
export class MockProvider implements LLMProvider {
  readonly name = "mock";

  async complete(messages: ChatMessage[], _options: CompletionOptions = {}): Promise<string> {
    const lastUser = [...messages].reverse().find((m) => m.role === "user");
    const content = lastUser?.content ?? "";
    return `[mock] J'ai bien reçu : "${content.slice(0, 200)}"`;
  }
}
