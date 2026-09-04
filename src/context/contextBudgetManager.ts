export interface ContextPiece {
  label: string;
  content: string;
  /** Plus haut = gardé en priorité si le budget est serré. */
  priority: number;
}

/**
 * Brique 7 : la pièce la plus souvent invisible et la plus décisive. Sous
 * contrainte de tokens, décide ce qui entre réellement dans le prompt final
 * et dans quel ordre — plutôt que d'empiler tout ce qui est disponible.
 * Estimation grossière (1 token ≈ 4 caractères) pour rester sans dépendance
 * à un tokenizer spécifique à un fournisseur.
 */
export class ContextBudgetManager {
  constructor(private readonly tokenBudget: number) {}

  private estimateTokens(text: string): number {
    return Math.ceil(text.length / 4);
  }

  assemble(pieces: ContextPiece[]): string {
    const sorted = [...pieces]
      .filter((p) => p.content.trim().length > 0)
      .sort((a, b) => b.priority - a.priority);

    let remaining = this.tokenBudget;
    const kept: string[] = [];

    for (const piece of sorted) {
      if (remaining <= 0) break;
      const cost = this.estimateTokens(piece.content);

      if (cost <= remaining) {
        kept.push(`## ${piece.label}\n${piece.content}`);
        remaining -= cost;
      } else if (remaining > 50) {
        const maxChars = remaining * 4;
        kept.push(`## ${piece.label} (tronqué)\n${piece.content.slice(0, maxChars)}`);
        remaining = 0;
      }
    }

    return kept.join("\n\n");
  }
}
