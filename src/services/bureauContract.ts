import { randomUUID } from "node:crypto";
import { CONTRACT_SCHEMA_VERSION, type ServiceEvent, type TaskRequest } from "../orchestration/contract.js";
import { config } from "../config.js";
import { createLLMProvider } from "../llm/providers/index.js";
import { resolveModelForRole, type ModelRole } from "../llm/modelRouter.js";
import type { LLMProvider } from "../llm/provider.js";

export type BureauId = "product_studio" | "creative_studio" | "commercial_office" | "marketing_office";

/**
 * Sortie structurée commune aux quatre bureaux : machine-exploitable (Jarvis peut
 * consolider/enchaîner sans reparser du texte libre), en plus d'un résumé lisible.
 * Réutilise task_id/trace_id du contrat Service existant plutôt que d'inventer un
 * second identifiant d'exécution.
 */
export interface BureauResult {
  office: BureauId;
  workspaceId: string;
  action: string;
  mission: string;
  status: "COMPLETED";
  summary: string;
  result: Record<string, unknown>;
  recommendations: string[];
  proposedActions: string[];
  dependencies: string[];
  nextSteps: string[];
  artifactRefs: string[];
  taskId: string;
  executedAt: number;
}

export function buildBureauResult(input: {
  office: BureauId;
  workspaceId: string;
  action: string;
  mission: string;
  summary: string;
  result: Record<string, unknown>;
  recommendations?: string[];
  proposedActions?: string[];
  dependencies?: string[];
  nextSteps?: string[];
  artifactRefs?: string[];
  taskId: string;
}): BureauResult {
  return {
    office: input.office,
    workspaceId: input.workspaceId,
    action: input.action,
    mission: input.mission,
    status: "COMPLETED",
    summary: input.summary,
    result: input.result,
    recommendations: input.recommendations ?? [],
    proposedActions: input.proposedActions ?? [],
    dependencies: input.dependencies ?? [],
    nextSteps: input.nextSteps ?? [],
    artifactRefs: input.artifactRefs ?? [],
    taskId: input.taskId,
    executedAt: Date.now(),
  };
}

export function completedEvent(r: TaskRequest, service: string, payload: Record<string, unknown>): ServiceEvent[] {
  return [
    {
      schema_version: r.schema_version || CONTRACT_SCHEMA_VERSION,
      event_id: randomUUID(),
      task_id: r.task_id,
      trace_id: r.trace_id,
      service,
      sequence: 1,
      type: "TASK_COMPLETED",
      timestamp: Date.now(),
      payload,
    },
  ];
}

export function failedEvent(r: TaskRequest, service: string, error: string, replannable = false): ServiceEvent[] {
  return [
    {
      schema_version: r.schema_version || CONTRACT_SCHEMA_VERSION,
      event_id: randomUUID(),
      task_id: r.task_id,
      trace_id: r.trace_id,
      service,
      sequence: 1,
      type: "TASK_FAILED",
      timestamp: Date.now(),
      payload: { error, replannable, side_effect_state: "none" },
    },
  ];
}

/**
 * Modèle spécialisé (Chantier 8, intelligence.researchModel/utilityModel/codingModel)
 * si configuré pour `role`, sinon le modèle principal Jarvis actif — construit à chaque
 * appel (jamais mis en cache) pour refléter un changement de modèle/provider fait depuis
 * le panneau Modèles IA sans nécessiter de reconstruire le bureau. Jamais d'échec faute
 * de modèle spécialisé configuré.
 */
export function officeLlm(role?: ModelRole): LLMProvider {
  const model = (role ? resolveModelForRole(role) : undefined) ?? config.llm.model;
  return createLLMProvider({ provider: config.llm.provider, model, sanitizeReasoning: true });
}

/**
 * Extrait un objet JSON depuis une sortie LLM libre (retire un éventuel `<think>`,
 * un bloc de code Markdown ```json, ou du texte d'accompagnement autour de l'objet).
 * Échoue explicitement plutôt que de deviner un contenu partiel.
 */
export function parseJsonObject(raw: string): Record<string, unknown> {
  const cleaned = raw.replace(/<think>[\s\S]*?<\/think>/gi, "").trim();
  const fence = cleaned.match(/```(?:json)?\r?\n([\s\S]*?)\r?\n```/i);
  const candidate = fence ? fence[1] : cleaned;
  const start = candidate.indexOf("{");
  const end = candidate.lastIndexOf("}");
  if (start === -1 || end === -1 || end < start) throw new Error("LLM_OUTPUT_NOT_JSON");
  const parsed = JSON.parse(candidate.slice(start, end + 1));
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) throw new Error("LLM_OUTPUT_NOT_JSON");
  return parsed as Record<string, unknown>;
}

export function asStringArray(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((x): x is string => typeof x === "string" && x.trim().length > 0) : [];
}

/**
 * Les actions RESEARCH_MARKET/ANALYZE_MARKET renvoient `sources` comme des objets
 * `{title,url,snippet}` (SearchResult), et documentent leur réinjection dans une action
 * suivante via context.marketSources. Accepte donc aussi bien des chaînes que ces objets
 * de source — jamais un simple filtre par typeof qui perdrait silencieusement les preuves
 * collectées quand l'appelant enchaîne fidèlement les deux actions.
 */
export function asMarketSourceLines(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return value
    .map((item) => {
      if (typeof item === "string") return item.trim();
      if (item && typeof item === "object" && !Array.isArray(item)) {
        const o = item as Record<string, unknown>;
        const title = typeof o.title === "string" ? o.title : undefined;
        const url = typeof o.url === "string" ? o.url : undefined;
        const snippet = typeof o.snippet === "string" ? o.snippet : undefined;
        return [title, url, snippet].filter((x): x is string => !!x && x.trim().length > 0).join(" — ");
      }
      return "";
    })
    .filter((line) => line.trim().length > 0);
}
