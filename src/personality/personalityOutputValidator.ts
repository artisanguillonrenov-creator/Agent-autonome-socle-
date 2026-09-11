import { analyzeVocative, removeVocative, stripCodeForStyleChecks } from "./addressing.js";
import type { PersonalityTurnPolicy, PersonalityValidationResult } from "./domain/types.js";

const EMOJI_REGEX = /\p{Extended_Pictographic}/u;

function transformOutsideCode(text: string, transform: (segment: string) => string): string {
  const codeRegex = /```[\s\S]*?```|`[^`\n]*`/g;
  let result = "";
  let cursor = 0;
  for (const match of text.matchAll(codeRegex)) {
    const index = match.index ?? 0;
    result += transform(text.slice(cursor, index));
    result += match[0];
    cursor = index + match[0].length;
  }
  result += transform(text.slice(cursor));
  return result;
}

export class PersonalityOutputValidator {
  validate(response: string, policy: PersonalityTurnPolicy): PersonalityValidationResult {
    const text = response.trim();
    const violations: string[] = [];
    const styleText = stripCodeForStyleChecks(text);
    const monsieur = analyzeVocative(text, "monsieur");
    const william = analyzeVocative(text, "William");

    if (EMOJI_REGEX.test(styleText)) violations.push("EMOJI_FORBIDDEN");
    if (styleText.includes("!")) violations.push("EXCLAMATION_FORBIDDEN");

    if (!policy.allowMonsieur && monsieur.count > 0) {
      violations.push("MONSIEUR_FORBIDDEN");
    }
    if (monsieur.count > 1) {
      violations.push("MONSIEUR_MAX_ONE");
    }
    if (monsieur.count === 1) {
      const index = monsieur.sentenceIndexes[0] ?? -1;
      const last = monsieur.sentenceCount - 1;
      if (index !== 0 && index !== last) violations.push("MONSIEUR_POSITION_INVALID");
    }

    if (!policy.allowWilliam && william.count > 0) {
      violations.push("WILLIAM_FORBIDDEN");
    }
    if (william.count > 1) {
      violations.push("WILLIAM_MAX_ONE");
    }
    if (william.count > 0 && monsieur.count > 0) {
      violations.push("ADDRESS_MIXED");
    }

    if (policy.gravity === "CRITIQUE") {
      const required = ["FAIT:", "CONSÉQUENCE:", "RECOMMANDATION:", "ACTION:"];
      for (const label of required) {
        if (!text.toLocaleUpperCase("fr-FR").includes(label)) {
          violations.push(`CRITICAL_STRUCTURE_${label.replace(/[:É]/g, "").toUpperCase()}_MISSING`);
        }
      }
    }

    return {
      isValid: violations.length === 0,
      text,
      violations,
      usedMonsieurVocative: monsieur.count > 0,
      usedWilliamVocative: william.count > 0,
    };
  }

  correctionInstruction(violations: string[], policy: PersonalityTurnPolicy): string {
    return [
      "Reformule uniquement la réponse précédente. Ne change aucun fait, aucune conclusion et n'ajoute aucune information.",
      `Violations à corriger : ${violations.join(", ") || "STYLE"}.`,
      policy.gravity === "CRITIQUE"
        ? "La réponse doit contenir exactement les sections logiques FAIT:, CONSÉQUENCE:, RECOMMANDATION:, ACTION:."
        : "Respecte strictement la personnalité et les règles d'adresse déjà présentes dans le message système.",
      "N'appelle aucun outil.",
    ].join("\n");
  }

  sanitizeStyleOnly(response: string, policy: PersonalityTurnPolicy): string {
    let text = transformOutsideCode(response, (segment) => (
      segment
        .replace(/\p{Extended_Pictographic}/gu, "")
        .replace(/!/g, ".")
    ));

    const monsieur = analyzeVocative(text, "monsieur");
    const william = analyzeVocative(text, "William");

    if (!policy.allowWilliam && william.count > 0) {
      text = removeVocative(text, "William");
    }

    const refreshedMonsieur = analyzeVocative(text, "monsieur");
    if (!policy.allowMonsieur || refreshedMonsieur.count > 1) {
      text = removeVocative(text, "monsieur");
    } else if (refreshedMonsieur.count === 1) {
      const index = refreshedMonsieur.sentenceIndexes[0] ?? -1;
      const last = refreshedMonsieur.sentenceCount - 1;
      if (index !== 0 && index !== last) text = removeVocative(text, "monsieur");
    }

    if (policy.allowWilliam && william.count > 0 && monsieur.count > 0) {
      text = removeVocative(text, "monsieur");
    }

    return text.replace(/[ \t]+([.,;:?])/g, "$1").replace(/[ \t]{2,}/g, " ").trim();
  }
}
