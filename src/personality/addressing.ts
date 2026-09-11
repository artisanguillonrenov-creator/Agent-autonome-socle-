export interface VocativeAnalysis {
  count: number;
  sentenceIndexes: number[];
  sentenceCount: number;
}

function escapeRegex(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

export function stripCodeForStyleChecks(text: string): string {
  return text
    .replace(/```[\s\S]*?```/g, (block) => " ".repeat(block.length))
    .replace(/`[^`\n]*`/g, (block) => " ".repeat(block.length));
}

export function splitStyleSentences(text: string): string[] {
  const safe = stripCodeForStyleChecks(text);
  return (safe.match(/[^.!?]+(?:[.!?]+|$)/g) ?? [])
    .map((sentence) => sentence.trim())
    .filter(Boolean);
}

function countVocativesInSentence(sentence: string, name: string): number {
  const escaped = escapeRegex(name);
  const core = sentence.replace(/[.!?]+\s*$/, "").trim();
  let count = 0;

  const leading = new RegExp(`^\\s*${escaped}\\s*[,;:]`, "i");
  const trailing = new RegExp(`[,;:]\\s*${escaped}\\s*$`, "i");
  const greeting = new RegExp(`^\\s*(?:bonjour|bonsoir)\\s+${escaped}(?:\\s*[,;:]|\\s*$)`, "i");

  if (leading.test(core)) count += 1;
  if (trailing.test(core)) count += 1;
  if (!leading.test(core) && greeting.test(core)) count += 1;
  return count;
}

export function analyzeVocative(text: string, name: string): VocativeAnalysis {
  const sentences = splitStyleSentences(text);
  const sentenceIndexes: number[] = [];
  let count = 0;

  sentences.forEach((sentence, index) => {
    const occurrences = countVocativesInSentence(sentence, name);
    count += occurrences;
    for (let i = 0; i < occurrences; i += 1) sentenceIndexes.push(index);
  });

  return { count, sentenceIndexes, sentenceCount: sentences.length };
}

export function hasMonsieurVocative(text: string): boolean {
  return analyzeVocative(text, "monsieur").count > 0;
}

export function hasWilliamVocative(text: string): boolean {
  return analyzeVocative(text, "William").count > 0;
}

export function removeVocative(text: string, name: string): string {
  const escaped = escapeRegex(name);
  return text
    .replace(new RegExp(`(^|[.!?]\\s*)${escaped}\\s*[,;:]\\s*`, "gi"), "$1")
    .replace(new RegExp(`[,;:]\\s*${escaped}(?=\\s*[.!?](?:\\s|$)|\\s*$)`, "gi"), "")
    .replace(new RegExp(`(^|[.!?]\\s*)(bonjour|bonsoir)\\s+${escaped}\\s*[,;:]?\\s*`, "gi"), "$1$2, ");
}
