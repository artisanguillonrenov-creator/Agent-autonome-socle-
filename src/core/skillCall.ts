export interface SkillCall {
  name: string;
  input: Record<string, unknown>;
}

/**
 * Convention textuelle volontairement simple (plutôt que le tool-calling natif
 * de tel ou tel fournisseur, différent d'une API à l'autre) : ça permet à la
 * boucle agent de rester strictement agnostique du fournisseur LLM utilisé.
 */
const SKILL_CALL_PATTERN = /<<SKILL\s+name="([^"]+)">([\s\S]*?)<\/SKILL>>/;

export function parseSkillCall(text: string): SkillCall | null {
  const match = text.match(SKILL_CALL_PATTERN);
  if (!match) return null;

  const [, name, jsonBlob] = match;
  let input: Record<string, unknown> = {};
  try {
    input = jsonBlob.trim() ? (JSON.parse(jsonBlob.trim()) as Record<string, unknown>) : {};
  } catch {
    input = {};
  }
  return { name, input };
}
