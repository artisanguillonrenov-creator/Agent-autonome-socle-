import { config } from "../config.js";
import { createLLMProvider } from "../llm/providers/index.js";
import type { AutonomyEvent } from "./eventBus.js";

export type PreAttentionVerdict = "IGNORE" | "CRITICAL" | "REQUIRES_REFLEXION";

export interface PreAttentionResult {
  verdict: PreAttentionVerdict;
  reason: string;
  /** true si le verdict vient réellement du modèle léger ; false = filtre heuristique de repli. */
  viaLocalModel: boolean;
}

const CRITICAL_PATTERN = /\b(prod(?:uction)?[ -]?down|incident|urgence|panne|crash|s[ée]curit[ée]|breach|corruption|data[ -]?loss|perte de donn[ée]es)\b/i;
const NOTABLE_PATTERN = /\b(échec|failed|error|erreur|conflict|conflit|reject|refus[ée]|timeout|expir[ée])\b/i;

function extractText(event: AutonomyEvent): string {
  const payload = event.payload ?? {};
  const parts = [payload.message, payload.title, payload.summary, payload.status, payload.action]
    .filter((v): v is string => typeof v === "string");
  return parts.length ? parts.join(" — ") : JSON.stringify(payload).slice(0, 500);
}

/**
 * Vague 7C (filtrage sensoriel avant-plan / SLM routing) : router de pré-attention. Une
 * notification ou un événement d'arrière-plan ne doit pas systématiquement réveiller le LLM
 * nominal (coûteux, lent) — un filtre ultra-léger (modèle Ollama local minimal, sans
 * historique) ou, à défaut, une heuristique instantanée décide s'il s'agit d'un simple bruit
 * (IGNORE), d'un signal méritant réflexion (REQUIRES_REFLEXION) ou d'une urgence (CRITICAL).
 * Seuls ces deux derniers cas remontent jusqu'à la brique 1 (boucle agent).
 */
export class PreAttentionRouter {
  constructor(private readonly timeoutMs = 4000) {}

  async classify(event: AutonomyEvent): Promise<PreAttentionResult> {
    const text = extractText(event);
    const local = await this.tryLocalModel(text, event.type);
    if (local) return local;
    return this.heuristic(text, event);
  }

  private heuristic(text: string, event: AutonomyEvent): PreAttentionResult {
    const severity = typeof event.payload.severity === "string" ? event.payload.severity : undefined;
    if (severity === "error" || CRITICAL_PATTERN.test(text)) {
      return { verdict: "CRITICAL", reason: "Motif critique détecté (heuristique)", viaLocalModel: false };
    }
    if (severity === "warning" || NOTABLE_PATTERN.test(text) || event.type === "SOFTWARE_FACTORY_PR_EVENT") {
      return { verdict: "REQUIRES_REFLEXION", reason: "Signal notable détecté (heuristique)", viaLocalModel: false };
    }
    return { verdict: "IGNORE", reason: "Aucun signal notable (heuristique)", viaLocalModel: false };
  }

  /** Best-effort : jamais bloquant, jamais d'exception propagée — un échec retombe sur l'heuristique. */
  private async tryLocalModel(text: string, eventType: string): Promise<PreAttentionResult | null> {
    if (config.llm.localProvider !== "ollama" || !config.llm.localModel.trim()) return null;
    try {
      const provider = createLLMProvider({ provider: "ollama", model: config.llm.localModel, sanitizeReasoning: true });
      const timeout = new Promise<never>((_, reject) => setTimeout(() => reject(new Error("PRE_ATTENTION_TIMEOUT")), this.timeoutMs));
      const completion = await Promise.race([
        provider.complete(
          [
            {
              role: "system",
              content: "You are a fast triage filter. No memory, no tools, no explanations. Reply with EXACTLY one word: IGNORE, CRITICAL, or REQUIRES_REFLEXION.",
            },
            { role: "user", content: `Event type: ${eventType}\nContent: ${text.slice(0, 800)}` },
          ],
          { maxTokens: 8, temperature: 0 },
        ),
        timeout,
      ]);
      const word = (completion.content ?? "").trim().toUpperCase().match(/IGNORE|CRITICAL|REQUIRES_REFLEXION/)?.[0];
      if (!word) return null;
      return { verdict: word as PreAttentionVerdict, reason: "Triage modèle léger local", viaLocalModel: true };
    } catch {
      return null;
    }
  }
}
