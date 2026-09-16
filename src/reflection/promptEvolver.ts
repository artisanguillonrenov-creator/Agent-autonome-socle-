import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import type { LLMProvider } from "../llm/provider.js";
import { config } from "../config.js";
import { withGenerationDefaults } from "../llm/generationDefaults.js";

/** Signature d'une correction de self-healing (Vague 11C, voir core/agent.ts) dans le transcript. */
const SELF_HEALING_PATTERN = /Erreur outil /i;

function readRules(): string[] {
  try {
    const raw = readFileSync(config.promptEvolution.rulesPath, "utf-8");
    const parsed: unknown = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed.filter((r): r is string => typeof r === "string") : [];
  } catch {
    return [];
  }
}

function writeRules(rules: string[]): void {
  mkdirSync(dirname(config.promptEvolution.rulesPath), { recursive: true });
  writeFileSync(config.promptEvolution.rulesPath, `${JSON.stringify(rules, null, 2)}\n`, "utf-8");
}

function normalize(rule: string): string {
  return rule.trim().replace(/\s+/g, " ").toLowerCase();
}

/** Lecture publique — utilisée par src/personality/dynamicRules.ts pour l'injection au démarrage de session. */
export function loadDynamicRules(): string[] {
  return readRules();
}

/**
 * Écriture publique directe — utilisée par le skill propose_prompt_rule (rôle SelfImprover
 * de l'AgentTeam) pour qu'un agent puisse proposer explicitement une règle d'or durable,
 * en dehors du cycle automatique de ReflectionEngine. Même politique de déduplication
 * insensible à la casse et de plafond (config.promptEvolution.maxRules, éviction FIFO) que
 * l'extraction automatique, pour ne jamais dupliquer ni faire croître le fichier sans borne.
 */
export function proposeRule(rule: string): boolean {
  if (!config.promptEvolution.enabled) return false;
  const trimmed = rule.trim();
  if (!trimmed || trimmed.length > 400) return false;

  const rules = readRules();
  const normalizedExisting = new Set(rules.map(normalize));
  if (normalizedExisting.has(normalize(trimmed))) return false;

  rules.push(trimmed);
  while (rules.length > config.promptEvolution.maxRules) rules.shift();
  writeRules(rules);
  return true;
}

export interface EvolutionTrigger {
  /**
   * Force l'extraction même en l'absence de correction de self-healing détectée par
   * pattern — utilisé par ReflectionEngine quand son auto-critique structurée juge la
   * trajectoire récente insatisfaisante (score bas ou problèmes listés), un signal que
   * la seule regex SELF_HEALING_PATTERN ne peut pas capturer.
   */
  force?: boolean;
  /** Contexte additionnel (ex: issues d'auto-critique) injecté dans le transcript envoyé au modèle d'extraction. */
  extraContext?: string;
}

/**
 * Vague 8C (apprentissage par renforcement local / évolution dynamique du prompt) : appelée à
 * la fin de chaque cycle de réflexion périodique (voir ReflectionEngine.createInsight). Se
 * déclenche si la fenêtre de transcript récente contient au moins une correction de
 * self-healing (Vague 11C — un message outil "Erreur outil ..." suivi de la poursuite du
 * cycle), OU si `trigger.force` est vrai (auto-critique insatisfaisante, voir EvolutionTrigger).
 * Demande au modèle de raisonnement d'extraire UNE règle d'or micro-instructionnelle générique
 * et l'ajoute à config/dynamic_rules.json (déduplication insensible à la casse, plafond
 * config.promptEvolution.maxRules avec éviction FIFO). Best-effort strict : une erreur ici ne
 * doit jamais dégrader le résultat de la réflexion elle-même.
 */
export async function maybeEvolvePrompt(
  recent: Array<{ role: string; content: string | null }>,
  provider: LLMProvider,
  trigger: EvolutionTrigger = {},
): Promise<string | null> {
  if (!config.promptEvolution.enabled) return null;
  const hadSelfHealingCorrection = recent.some(
    (m) => m.role === "tool" && typeof m.content === "string" && SELF_HEALING_PATTERN.test(m.content),
  );
  if (!hadSelfHealingCorrection && !trigger.force) return null;

  const transcript =
    recent
      .map((m) => `${m.role}: ${m.content ?? ""}`)
      .join("\n")
      .slice(0, 6000) + (trigger.extraContext ? `\n\n${trigger.extraContext}` : "");

  let rule: string;
  try {
    const result = await provider.complete(
      [
        {
          role: "system",
          content:
            "Tu extrais UNE seule règle d'or micro-instructionnelle (une phrase impérative courte, générique et " +
            "réutilisable dans une future session) à partir de cet extrait de transcript — qu'il s'agisse d'une " +
            "correction d'erreur d'outil ou d'un problème signalé par une auto-critique. Réponds uniquement par la " +
            "règle elle-même, sans guillemets, sans numérotation, sans explication additionnelle.",
        },
        { role: "user", content: transcript },
      ],
      withGenerationDefaults({ maxTokens: 120, temperature: 0.2, tools: undefined }),
    );
    rule = (result.content ?? "").trim();
  } catch (error) {
    console.warn("[PromptEvolver] Extraction de règle d'or échouée (best-effort):", (error as Error).message);
    return null;
  }
  if (!rule || rule.length > 400) return null;

  const rules = readRules();
  const normalizedExisting = new Set(rules.map(normalize));
  if (normalizedExisting.has(normalize(rule))) return null;

  rules.push(rule);
  while (rules.length > config.promptEvolution.maxRules) rules.shift();

  try {
    writeRules(rules);
  } catch (error) {
    console.warn("[PromptEvolver] Écriture de config/dynamic_rules.json échouée:", (error as Error).message);
    return null;
  }
  return rule;
}
