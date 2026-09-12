import type { LLMProvider } from "../llm/provider.js";
import { withGenerationDefaults } from "../llm/generationDefaults.js";
import { providerForRole } from "../llm/modelRouter.js";

export interface GuardrailVerdict {
  valid: boolean;
  issues: string[];
}

function parseVerdict(rawText: string): GuardrailVerdict {
  const match = rawText.match(/\{[\s\S]*\}/);
  if (!match) return { valid: true, issues: [] };
  try {
    const parsed = JSON.parse(match[0]) as { valid?: unknown; issues?: unknown };
    if (typeof parsed.valid !== "boolean") return { valid: true, issues: [] };
    const issues = Array.isArray(parsed.issues) ? parsed.issues.filter((issue): issue is string => typeof issue === "string") : [];
    return { valid: parsed.valid, issues };
  } catch {
    return { valid: true, issues: [] };
  }
}

/**
 * Brique auto-réflexion / guardrail : après l'exécution d'une compétence ou la
 * complétion d'un plan, valide le résultat obtenu par rapport à l'objectif de
 * départ ("LLM-as-judge"). Une évaluation qui échoue à produire un verdict
 * exploitable (erreur réseau, JSON non parsable...) est considérée VALIDE par
 * défaut ("fail-open") : le guardrail ne doit jamais transformer une panne du
 * juge en blocage systématique de l'agent.
 */
export class GuardrailEngine {
  constructor(private llm: LLMProvider) {}

  setLLMProvider(llm: LLMProvider): void {
    this.llm = llm;
  }

  async evaluate(objective: string, result: string): Promise<GuardrailVerdict> {
    try {
      const completion = await providerForRole("utility", this.llm).complete(
        [
          {
            role: "system",
            content: [
              "Tu es le module de garde-fou (guardrail) d'un agent autonome.",
              "Compare le RÉSULTAT produit à l'OBJECTIF initial et détermine s'il le satisfait réellement",
              "(pas d'hallucination, pas d'étape manquante, pas de hors-sujet).",
              'Réponds STRICTEMENT avec un objet JSON de la forme {"valid": boolean, "issues": string[]}, sans texte autour.',
              "issues doit lister, en 1 phrase chacune, les problèmes concrets à corriger si valid=false ; sinon un tableau vide.",
            ].join("\n"),
          },
          { role: "user", content: `OBJECTIF:\n${objective}\n\nRÉSULTAT:\n${result}` },
        ],
        withGenerationDefaults({ maxTokens: 512 }),
      );
      const text = typeof completion === "string" ? completion : completion.content ?? "";
      return parseVerdict(text);
    } catch {
      return { valid: true, issues: [] };
    }
  }
}
