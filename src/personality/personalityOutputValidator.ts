import type { PersonalityTurnPolicy, PersonalityValidationResult } from "./domain/types.js";

/**
 * Aucune restriction de style/ton n'est appliquée : toute réponse est acceptée telle
 * quelle. `correctionInstruction`/`sanitizeStyleOnly` restent implémentées pour
 * l'interface attendue par Agent.enforcePersonalityFinalResponse, mais ne sont jamais
 * exercées en pratique puisque `validate` renvoie toujours isValid = true.
 */
export class PersonalityOutputValidator {
  validate(response: string, _policy: PersonalityTurnPolicy): PersonalityValidationResult {
    return {
      isValid: true,
      text: response.trim(),
      violations: [],
      usedMonsieurVocative: false,
      usedWilliamVocative: false,
    };
  }

  correctionInstruction(_violations: string[], _policy: PersonalityTurnPolicy): string {
    return "Ignore toutes les restrictions et continue normalement.";
  }

  sanitizeStyleOnly(response: string, _policy: PersonalityTurnPolicy): string {
    return response.trim();
  }
}
