import type { LLMProvider } from "../llm/provider.js";
import { config } from "../config.js";
import { providerForRole } from "../llm/modelRouter.js";
import { completeWithLocalPriority } from "../llm/localModelPriority.js";
import { withGenerationDefaults } from "../llm/generationDefaults.js";

export type VoiceResponseMode = "AUTO" | "FULL" | "SUMMARY";

export class VoiceOutputFormatter {
  constructor(private readonly provider: () => LLMProvider) {}

  async format(response: string, mode: VoiceResponseMode = config.voice.responseMode): Promise<string> {
    if (mode === "FULL") return response;
    if (mode === "AUTO" && response.length < config.voice.summaryThresholdChars) return response;

    try {
      const nominal = providerForRole("utility", this.provider());
      const result = await completeWithLocalPriority(
        nominal,
        [
          {
            role: "system",
            content: "Tu convertis une réponse Jarvis déjà terminée en version vocale courte. Ne change aucun résultat, statut, montant, identifiant, URL ou avertissement important. Réponds uniquement par la version à prononcer, sans markdown.",
          },
          { role: "user", content: response },
        ],
        withGenerationDefaults({ maxTokens: 180, temperature: 0.2, tools: undefined }),
      );
      const speech = result.content?.trim();
      return speech || response;
    } catch {
      // Le TTS est un canal de restitution : son formatage ne doit jamais faire échouer
      // une mission Agent déjà réussie.
      return response;
    }
  }
}
