import { randomUUID } from "node:crypto";
import { getDb } from "../persistence/db.js";
import { bureauScope } from "./bureauScope.js";

export interface ProductImprovement {
  title: string;
  value: "LOW" | "MEDIUM" | "HIGH";
  effort: "LOW" | "MEDIUM" | "HIGH";
  priority: number;
}

export interface ProductAnalysis {
  id: string;
  createdAt: number;
  objective: string;
  summary: string;
  targetUsers: string;
  strengths: string[];
  weaknesses: string[];
  opportunities: string[];
  recommendedImprovements: ProductImprovement[];
  missingFeatures: string[];
  roadmap: Array<{ title: string; priority: number }>;
  specs: string;
}

export interface ProductDecision {
  id: string;
  createdAt: number;
  decision: string;
  rationale?: string;
}

export interface ProductStudioState {
  analyses: ProductAnalysis[];
  decisions: ProductDecision[];
}

const EMPTY = (): ProductStudioState => ({ analyses: [], decisions: [] });

/** État persistant du Product Studio, strictement scopé par projet (voir bureauScope.ts). */
export class ProductStudioStore {
  private read(workspaceId?: string): ProductStudioState {
    const row = getDb()
      .prepare("SELECT state_json FROM product_studio_state WHERE workspace_id=?")
      .get(bureauScope(workspaceId)) as { state_json: string } | undefined;
    if (!row) return EMPTY();
    try {
      const parsed = JSON.parse(row.state_json);
      return {
        analyses: Array.isArray(parsed.analyses) ? parsed.analyses : [],
        decisions: Array.isArray(parsed.decisions) ? parsed.decisions : [],
      };
    } catch {
      return EMPTY();
    }
  }

  private write(workspaceId: string | undefined, state: ProductStudioState): void {
    const now = Date.now();
    getDb()
      .prepare(
        `INSERT INTO product_studio_state (workspace_id, state_json, updated_at) VALUES (?, ?, ?)
         ON CONFLICT(workspace_id) DO UPDATE SET state_json = excluded.state_json, updated_at = excluded.updated_at`,
      )
      .run(bureauScope(workspaceId), JSON.stringify(state), now);
  }

  getState(workspaceId?: string): ProductStudioState {
    return this.read(workspaceId);
  }

  addAnalysis(workspaceId: string | undefined, analysis: Omit<ProductAnalysis, "id" | "createdAt">): ProductAnalysis {
    const state = this.read(workspaceId);
    const full: ProductAnalysis = { ...analysis, id: randomUUID(), createdAt: Date.now() };
    state.analyses.push(full);
    this.write(workspaceId, state);
    return full;
  }

  addDecision(workspaceId: string | undefined, decision: string, rationale?: string): ProductDecision {
    const state = this.read(workspaceId);
    const full: ProductDecision = { id: randomUUID(), createdAt: Date.now(), decision, rationale };
    state.decisions.push(full);
    this.write(workspaceId, state);
    return full;
  }
}
