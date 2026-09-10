import { randomUUID } from "node:crypto";
import { getDb } from "../persistence/db.js";
import { bureauScope } from "./bureauScope.js";

export interface MarketingStrategy {
  id: string;
  createdAt: number;
  segments: string[];
  personas: string[];
  positioning: string;
  valueProposition: string;
  messages: string[];
  launchStrategy: string;
  channels: string[];
}

export interface Campaign {
  id: string;
  createdAt: number;
  name: string;
  channel: string;
  goal: string;
}

export interface CampaignResult {
  id: string;
  createdAt: number;
  campaignId: string;
  metric: string;
  value: number;
}

export interface MarketingDecision {
  id: string;
  createdAt: number;
  description: string;
}

export interface MarketingOfficeState {
  strategy: MarketingStrategy | null;
  campaigns: Campaign[];
  results: CampaignResult[];
  decisions: MarketingDecision[];
}

const EMPTY = (): MarketingOfficeState => ({ strategy: null, campaigns: [], results: [], decisions: [] });

/** État persistant du Marketing Office, strictement scopé par projet (voir bureauScope.ts). */
export class MarketingOfficeStore {
  private read(workspaceId?: string): MarketingOfficeState {
    const row = getDb().prepare("SELECT state_json FROM marketing_office_state WHERE workspace_id=?").get(bureauScope(workspaceId)) as
      | { state_json: string }
      | undefined;
    if (!row) return EMPTY();
    try {
      const parsed = JSON.parse(row.state_json);
      return {
        strategy: parsed.strategy ?? null,
        campaigns: Array.isArray(parsed.campaigns) ? parsed.campaigns : [],
        results: Array.isArray(parsed.results) ? parsed.results : [],
        decisions: Array.isArray(parsed.decisions) ? parsed.decisions : [],
      };
    } catch {
      return EMPTY();
    }
  }

  private write(workspaceId: string | undefined, state: MarketingOfficeState): void {
    getDb()
      .prepare(
        `INSERT INTO marketing_office_state (workspace_id, state_json, updated_at) VALUES (?, ?, ?)
         ON CONFLICT(workspace_id) DO UPDATE SET state_json = excluded.state_json, updated_at = excluded.updated_at`,
      )
      .run(bureauScope(workspaceId), JSON.stringify(state), Date.now());
  }

  getState(workspaceId?: string): MarketingOfficeState {
    return this.read(workspaceId);
  }

  setStrategy(workspaceId: string | undefined, strategy: Omit<MarketingStrategy, "id" | "createdAt">): MarketingStrategy {
    const state = this.read(workspaceId);
    const full: MarketingStrategy = { ...strategy, id: randomUUID(), createdAt: Date.now() };
    state.decisions.push({
      id: randomUUID(),
      createdAt: Date.now(),
      description: state.strategy ? "Stratégie marketing révisée." : "Stratégie marketing initiale définie.",
    });
    state.strategy = full;
    this.write(workspaceId, state);
    return full;
  }

  addCampaign(workspaceId: string | undefined, campaign: Omit<Campaign, "id" | "createdAt">): Campaign {
    const state = this.read(workspaceId);
    const full: Campaign = { ...campaign, id: randomUUID(), createdAt: Date.now() };
    state.campaigns.push(full);
    this.write(workspaceId, state);
    return full;
  }

  addResult(workspaceId: string | undefined, result: Omit<CampaignResult, "id" | "createdAt">): CampaignResult {
    const state = this.read(workspaceId);
    if (!state.campaigns.some((c) => c.id === result.campaignId)) throw new Error("MARKETING_OFFICE_CAMPAIGN_NOT_FOUND");
    const full: CampaignResult = { ...result, id: randomUUID(), createdAt: Date.now() };
    state.results.push(full);
    this.write(workspaceId, state);
    return full;
  }
}
