import type { TaskRequest, ServiceEvent } from "../orchestration/contract.js";
import type { WebSearchProvider, SearchResult } from "../web/searchProvider.js";
import { createWebSearchProvider } from "../web/searchFactory.js";
import { MarketingOfficeStore } from "./marketingOfficeStore.js";
import { buildBureauResult, completedEvent, failedEvent, officeLlm, parseJsonObject, asStringArray, asMarketSourceLines } from "./bureauContract.js";
import type { ChatMessage } from "../types.js";
import type { LLMProvider } from "../llm/provider.js";
import type { ModelRole } from "../llm/modelRouter.js";

const STRATEGY_SYSTEM_PROMPT = [
  "Tu es le Marketing Office de Jarvis : acquisition, positionnement et performance marketing.",
  "Tu t'appuies sur les briefs éventuels du Product Studio (proposition de valeur) et du Creative Studio (identité) pour construire une stratégie cohérente.",
  'Réponds UNIQUEMENT avec un objet JSON strict de la forme : {"segments":string[],"personas":string[],"positioning":string,"valueProposition":string,"messages":string[],"launchStrategy":string,"channels":string[]}',
].join(" ");

export class MarketingOfficeService {
  constructor(
    private readonly store = new MarketingOfficeStore(),
    private readonly searchProvider: WebSearchProvider = createWebSearchProvider(),
    private readonly llm: (role?: ModelRole) => LLMProvider = officeLlm,
  ) {}

  async handleTaskRequest(r: TaskRequest): Promise<ServiceEvent[]> {
    const action = String(r.context.action ?? "GET_STATE");
    const workspaceId = typeof (r.context.workspace as any)?.id === "string" ? (r.context.workspace as any).id : undefined;
    try {
      switch (action) {
        case "ANALYZE_MARKET":
          return await this.analyzeMarket(r, workspaceId);
        case "DEFINE_STRATEGY":
          return await this.defineStrategy(r, workspaceId);
        case "PLAN_CAMPAIGN":
          return this.planCampaign(r, workspaceId);
        case "RECORD_RESULT":
          return this.recordResult(r, workspaceId);
        case "GET_STATE":
          return this.getState(r, workspaceId);
        default:
          throw new Error(`MARKETING_OFFICE_ACTION_INVALID: ${action}`);
      }
    } catch (e) {
      return failedEvent(r, "marketing_office", (e as Error).message, true);
    }
  }

  private async analyzeMarket(r: TaskRequest, workspaceId?: string): Promise<ServiceEvent[]> {
    const queries = asStringArray(r.context.queries).slice(0, 5);
    if (!queries.length) throw new Error("MARKETING_OFFICE_QUERIES_REQUIRED");
    const unique = new Map<string, SearchResult>();
    for (const q of queries) {
      for (const s of await this.searchProvider.search(q, 5)) {
        if (typeof s.title === "string" && typeof s.url === "string" && typeof s.snippet === "string") unique.set(s.url, s);
      }
    }
    const sources = [...unique.values()];
    const result = buildBureauResult({
      office: "marketing_office",
      workspaceId: workspaceId ?? "__global__",
      action: "ANALYZE_MARKET",
      mission: r.objective,
      summary: `${sources.length} source(s) tendances/concurrence collectée(s).`,
      result: { queries, sources },
      nextSteps: ["Injecter ces sources dans DEFINE_STRATEGY via context.marketSources"],
      taskId: r.task_id,
    });
    return completedEvent(r, "marketing_office", { ...result });
  }

  private async defineStrategy(r: TaskRequest, workspaceId?: string): Promise<ServiceEvent[]> {
    const productBrief = r.context.productBrief && typeof r.context.productBrief === "object" ? JSON.stringify(r.context.productBrief) : undefined;
    const creativeBrief = r.context.creativeBrief && typeof r.context.creativeBrief === "object" ? JSON.stringify(r.context.creativeBrief) : undefined;
    const marketSources = asMarketSourceLines(r.context.marketSources);
    if (!productBrief && !creativeBrief && !marketSources.length && !r.objective.trim()) throw new Error("MARKETING_OFFICE_STRATEGY_INPUT_REQUIRED");

    const messages: ChatMessage[] = [
      { role: "system", content: STRATEGY_SYSTEM_PROMPT },
      {
        role: "user",
        content: [
          `Objectif de la mission : ${r.objective}`,
          productBrief ? `Brief Product Studio : ${productBrief}` : "",
          creativeBrief ? `Brief Creative Studio : ${creativeBrief}` : "",
          marketSources.length ? `Sources marché :\n${marketSources.join("\n")}` : "",
        ]
          .filter(Boolean)
          .join("\n\n"),
      },
    ];
    const raw = await this.llm("research").complete(messages, { temperature: 0.4 });
    const parsed = parseJsonObject(raw.content ?? "");
    const strategy = this.store.setStrategy(workspaceId, {
      segments: asStringArray(parsed.segments),
      personas: asStringArray(parsed.personas),
      positioning: String(parsed.positioning ?? ""),
      valueProposition: String(parsed.valueProposition ?? ""),
      messages: asStringArray(parsed.messages),
      launchStrategy: String(parsed.launchStrategy ?? ""),
      channels: asStringArray(parsed.channels),
    });

    const result = buildBureauResult({
      office: "marketing_office",
      workspaceId: workspaceId ?? "__global__",
      action: "DEFINE_STRATEGY",
      mission: r.objective,
      summary: strategy.positioning || "Stratégie marketing définie.",
      result: { strategy },
      recommendations: strategy.channels.map((c) => `Canal recommandé : ${c}`),
      dependencies: ["product_studio", "creative_studio"],
      nextSteps: ["Planifier des campagnes via PLAN_CAMPAIGN"],
      taskId: r.task_id,
    });
    return completedEvent(r, "marketing_office", { ...result });
  }

  private planCampaign(r: TaskRequest, workspaceId?: string): ServiceEvent[] {
    const name = String(r.context.name ?? "").trim();
    const channel = String(r.context.channel ?? "").trim();
    if (!name || !channel) throw new Error("MARKETING_OFFICE_CAMPAIGN_INPUT_REQUIRED");
    const campaign = this.store.addCampaign(workspaceId, { name, channel, goal: String(r.context.goal ?? "").trim() });
    const result = buildBureauResult({
      office: "marketing_office",
      workspaceId: workspaceId ?? "__global__",
      action: "PLAN_CAMPAIGN",
      mission: r.objective,
      summary: `Campagne planifiée : ${campaign.name} (${campaign.channel})`,
      result: { campaign },
      taskId: r.task_id,
    });
    return completedEvent(r, "marketing_office", { ...result });
  }

  private recordResult(r: TaskRequest, workspaceId?: string): ServiceEvent[] {
    const metric = String(r.context.metric ?? "").trim();
    const value = Number(r.context.value);
    if (!metric || !Number.isFinite(value)) throw new Error("MARKETING_OFFICE_RESULT_INPUT_REQUIRED");
    const campaignResult = this.store.addResult(workspaceId, { campaignId: String(r.context.campaignId ?? ""), metric, value });
    const result = buildBureauResult({
      office: "marketing_office",
      workspaceId: workspaceId ?? "__global__",
      action: "RECORD_RESULT",
      mission: r.objective,
      summary: `Résultat enregistré : ${campaignResult.metric} = ${campaignResult.value}`,
      result: { campaignResult },
      taskId: r.task_id,
    });
    return completedEvent(r, "marketing_office", { ...result });
  }

  private getState(r: TaskRequest, workspaceId?: string): ServiceEvent[] {
    const state = this.store.getState(workspaceId);
    const result = buildBureauResult({
      office: "marketing_office",
      workspaceId: workspaceId ?? "__global__",
      action: "GET_STATE",
      mission: r.objective,
      summary: state.strategy ? state.strategy.positioning : "Aucune stratégie marketing définie pour ce projet.",
      result: { state },
      taskId: r.task_id,
    });
    return completedEvent(r, "marketing_office", { ...result });
  }
}
