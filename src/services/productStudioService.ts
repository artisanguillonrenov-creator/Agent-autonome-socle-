import type { TaskRequest, ServiceEvent } from "../orchestration/contract.js";
import type { WebSearchProvider, SearchResult } from "../web/searchProvider.js";
import { createWebSearchProvider } from "../web/searchFactory.js";
import { ProductStudioStore } from "./productStudioStore.js";
import { buildBureauResult, completedEvent, failedEvent, officeLlm, parseJsonObject, asStringArray } from "./bureauContract.js";
import type { ChatMessage } from "../types.js";
import type { LLMProvider } from "../llm/provider.js";
import type { ModelRole } from "../llm/modelRouter.js";

const SYSTEM_PROMPT = [
  "Tu es le Product Studio de Jarvis : le bureau de conception, d'analyse et d'amélioration produit.",
  "Tu analyses un projet (application, logiciel, service, produit numérique ou concept en préparation) : son objectif, ses utilisateurs cibles, ses forces/faiblesses, ses opportunités.",
  "Tu proposes des améliorations priorisées (valeur/effort), les fonctionnalités manquantes, une roadmap et des spécifications fonctionnelles exploitables par d'autres bureaux.",
  "Tu ne modifies JAMAIS de code toi-même : tu produis des recommandations que Jarvis pourra transmettre à la Software Factory.",
  'Réponds UNIQUEMENT avec un objet JSON strict de la forme : {"summary":string,"targetUsers":string,"strengths":string[],"weaknesses":string[],"opportunities":string[],"recommendedImprovements":[{"title":string,"value":"LOW"|"MEDIUM"|"HIGH","effort":"LOW"|"MEDIUM"|"HIGH","priority":number}],"missingFeatures":string[],"roadmap":[{"title":string,"priority":number}],"specs":string}',
].join(" ");

function asImprovements(value: unknown) {
  if (!Array.isArray(value)) return [];
  const levels = new Set(["LOW", "MEDIUM", "HIGH"]);
  return value
    .filter((x): x is Record<string, unknown> => !!x && typeof x === "object")
    .map((x) => ({
      title: typeof x.title === "string" ? x.title : "",
      value: levels.has(x.value as string) ? (x.value as "LOW" | "MEDIUM" | "HIGH") : "MEDIUM",
      effort: levels.has(x.effort as string) ? (x.effort as "LOW" | "MEDIUM" | "HIGH") : "MEDIUM",
      priority: Number.isFinite(x.priority) ? Number(x.priority) : 0,
    }))
    .filter((x) => x.title);
}

function asRoadmap(value: unknown) {
  if (!Array.isArray(value)) return [];
  return value
    .filter((x): x is Record<string, unknown> => !!x && typeof x === "object")
    .map((x) => ({ title: typeof x.title === "string" ? x.title : "", priority: Number.isFinite(x.priority) ? Number(x.priority) : 0 }))
    .filter((x) => x.title);
}

export class ProductStudioService {
  constructor(
    private readonly store = new ProductStudioStore(),
    private readonly searchProvider: WebSearchProvider = createWebSearchProvider(),
    /** Injectable pour les tests ; en production, résout toujours le modèle Jarvis actif/spécialisé (ou l'override propre à ce bureau) courant. */
    private readonly llm: (role?: ModelRole) => LLMProvider = (role) => officeLlm("product_studio", role),
  ) {}

  async handleTaskRequest(r: TaskRequest): Promise<ServiceEvent[]> {
    const action = String(r.context.action ?? "ANALYZE");
    const workspaceId = typeof (r.context.workspace as any)?.id === "string" ? (r.context.workspace as any).id : undefined;
    try {
      switch (action) {
        case "ANALYZE":
          return await this.analyze(r, workspaceId);
        case "RESEARCH_MARKET":
          return await this.researchMarket(r, workspaceId);
        case "RECORD_DECISION":
          return this.recordDecision(r, workspaceId);
        case "GET_STATE":
          return this.getState(r, workspaceId);
        case "BRIEF_FOR_OFFICE":
          return this.briefForOffice(r, workspaceId);
        default:
          throw new Error(`PRODUCT_STUDIO_ACTION_INVALID: ${action}`);
      }
    } catch (e) {
      return failedEvent(r, "product_studio", (e as Error).message, true);
    }
  }

  private async analyze(r: TaskRequest, workspaceId?: string): Promise<ServiceEvent[]> {
    const projectSummary = String(r.context.projectSummary ?? r.objective ?? "").trim();
    if (!projectSummary) throw new Error("PRODUCT_STUDIO_PROJECT_SUMMARY_REQUIRED");
    const targetUsersHint = typeof r.context.targetUsers === "string" ? r.context.targetUsers : undefined;
    const marketSources = asStringArray(r.context.marketSources);

    const messages: ChatMessage[] = [
      { role: "system", content: SYSTEM_PROMPT },
      {
        role: "user",
        content: [
          `Objectif de la mission : ${r.objective}`,
          `Description du projet : ${projectSummary}`,
          targetUsersHint ? `Indice sur les utilisateurs cibles : ${targetUsersHint}` : "",
          marketSources.length ? `Sources marché déjà collectées :\n${marketSources.join("\n")}` : "",
        ]
          .filter(Boolean)
          .join("\n\n"),
      },
    ];

    const raw = await this.llm("research").complete(messages, { temperature: 0.3 });
    const parsed = parseJsonObject(raw.content ?? "");

    const analysis = this.store.addAnalysis(workspaceId, {
      objective: r.objective,
      summary: String(parsed.summary ?? ""),
      targetUsers: String(parsed.targetUsers ?? ""),
      strengths: asStringArray(parsed.strengths),
      weaknesses: asStringArray(parsed.weaknesses),
      opportunities: asStringArray(parsed.opportunities),
      recommendedImprovements: asImprovements(parsed.recommendedImprovements),
      missingFeatures: asStringArray(parsed.missingFeatures),
      roadmap: asRoadmap(parsed.roadmap),
      specs: String(parsed.specs ?? ""),
    });

    const result = buildBureauResult({
      office: "product_studio",
      workspaceId: workspaceId ?? "__global__",
      action: "ANALYZE",
      mission: r.objective,
      summary: analysis.summary,
      result: { analysis },
      recommendations: analysis.recommendedImprovements.map((i) => `${i.title} (valeur ${i.value}/effort ${i.effort})`),
      proposedActions: analysis.missingFeatures.map((f) => `Spécifier : ${f}`),
      nextSteps: ["Faire valider la roadmap par l'utilisateur", "Transmettre les évolutions retenues à la Software Factory via Jarvis"],
      taskId: r.task_id,
    });
    return completedEvent(r, "product_studio", { ...result });
  }

  private async researchMarket(r: TaskRequest, workspaceId?: string): Promise<ServiceEvent[]> {
    const queries = asStringArray(r.context.queries).slice(0, 5);
    if (!queries.length) throw new Error("PRODUCT_STUDIO_QUERIES_REQUIRED");
    const unique = new Map<string, SearchResult>();
    for (const q of queries) {
      for (const s of await this.searchProvider.search(q, 5)) {
        if (typeof s.title === "string" && typeof s.url === "string" && typeof s.snippet === "string") unique.set(s.url, s);
      }
    }
    const sources = [...unique.values()];
    const result = buildBureauResult({
      office: "product_studio",
      workspaceId: workspaceId ?? "__global__",
      action: "RESEARCH_MARKET",
      mission: r.objective,
      summary: `${sources.length} source(s) marché/concurrence collectée(s).`,
      result: { queries, sources },
      nextSteps: ["Injecter ces sources dans une prochaine ANALYZE via context.marketSources"],
      taskId: r.task_id,
    });
    return completedEvent(r, "product_studio", { ...result });
  }

  private recordDecision(r: TaskRequest, workspaceId?: string): ServiceEvent[] {
    const decision = String(r.context.decision ?? "").trim();
    if (!decision) throw new Error("PRODUCT_STUDIO_DECISION_REQUIRED");
    const rationale = typeof r.context.rationale === "string" ? r.context.rationale : undefined;
    const recorded = this.store.addDecision(workspaceId, decision, rationale);
    const result = buildBureauResult({
      office: "product_studio",
      workspaceId: workspaceId ?? "__global__",
      action: "RECORD_DECISION",
      mission: r.objective,
      summary: `Décision produit enregistrée : ${decision}`,
      result: { decision: recorded },
      taskId: r.task_id,
    });
    return completedEvent(r, "product_studio", { ...result });
  }

  private getState(r: TaskRequest, workspaceId?: string): ServiceEvent[] {
    const state = this.store.getState(workspaceId);
    const result = buildBureauResult({
      office: "product_studio",
      workspaceId: workspaceId ?? "__global__",
      action: "GET_STATE",
      mission: r.objective,
      summary: `${state.analyses.length} analyse(s), ${state.decisions.length} décision(s) enregistrée(s).`,
      result: { state },
      taskId: r.task_id,
    });
    return completedEvent(r, "product_studio", { ...result });
  }

  private briefForOffice(r: TaskRequest, workspaceId?: string): ServiceEvent[] {
    const targetOffice = String(r.context.targetOffice ?? "").trim();
    const state = this.store.getState(workspaceId);
    const latest = state.analyses[state.analyses.length - 1];
    if (!latest) throw new Error("PRODUCT_STUDIO_NO_ANALYSIS_YET");
    const brief = {
      targetOffice,
      valueProposition: latest.summary,
      targetUsers: latest.targetUsers,
      priorities: latest.recommendedImprovements.slice(0, 5),
      decisions: state.decisions.map((d) => d.decision),
    };
    const result = buildBureauResult({
      office: "product_studio",
      workspaceId: workspaceId ?? "__global__",
      action: "BRIEF_FOR_OFFICE",
      mission: r.objective,
      summary: `Brief produit préparé pour ${targetOffice || "un autre bureau"}.`,
      result: { brief },
      dependencies: targetOffice ? [targetOffice] : [],
      taskId: r.task_id,
    });
    return completedEvent(r, "product_studio", { ...result });
  }
}
