import { randomUUID } from "node:crypto";
import { getDb } from "../persistence/db.js";
import { bureauScope } from "./bureauScope.js";

export interface VisualIdentity {
  id: string;
  createdAt: number;
  palette: string[];
  typography: string;
  styleKeywords: string[];
  mood: string;
  iconography: string;
  principles: string[];
  references: string[];
  assets: string[];
}

export type CreativeDecisionStatus = "DEFINED" | "ACCEPTED" | "REJECTED" | "REPLACED";

export interface CreativeDecision {
  id: string;
  createdAt: number;
  status: CreativeDecisionStatus;
  description: string;
  note?: string;
}

export interface CreativeStudioState {
  identity: VisualIdentity | null;
  decisions: CreativeDecision[];
}

const EMPTY = (): CreativeStudioState => ({ identity: null, decisions: [] });

/** Mémoire artistique persistante par projet — voir bureauScope.ts pour l'isolation. */
export class CreativeStudioStore {
  private read(workspaceId?: string): CreativeStudioState {
    const row = getDb()
      .prepare("SELECT state_json FROM creative_studio_state WHERE workspace_id=?")
      .get(bureauScope(workspaceId)) as { state_json: string } | undefined;
    if (!row) return EMPTY();
    try {
      const parsed = JSON.parse(row.state_json);
      return { identity: parsed.identity ?? null, decisions: Array.isArray(parsed.decisions) ? parsed.decisions : [] };
    } catch {
      return EMPTY();
    }
  }

  private write(workspaceId: string | undefined, state: CreativeStudioState): void {
    getDb()
      .prepare(
        `INSERT INTO creative_studio_state (workspace_id, state_json, updated_at) VALUES (?, ?, ?)
         ON CONFLICT(workspace_id) DO UPDATE SET state_json = excluded.state_json, updated_at = excluded.updated_at`,
      )
      .run(bureauScope(workspaceId), JSON.stringify(state), Date.now());
  }

  getState(workspaceId?: string): CreativeStudioState {
    return this.read(workspaceId);
  }

  /**
   * Définit/remplace l'identité visuelle du projet. Si une identité existait déjà, elle
   * est archivée comme décision REPLACED (jamais effacée silencieusement) — un changement
   * majeur de direction artistique reste identifiable comme une décision explicite.
   */
  setIdentity(workspaceId: string | undefined, identity: Omit<VisualIdentity, "id" | "createdAt">, changeNote?: string): VisualIdentity {
    const state = this.read(workspaceId);
    const full: VisualIdentity = { ...identity, id: randomUUID(), createdAt: Date.now() };
    if (state.identity) {
      state.decisions.push({
        id: randomUUID(),
        createdAt: Date.now(),
        status: "REPLACED",
        description: `Direction artistique remplacée (précédente: ${state.identity.styleKeywords.join(", ") || state.identity.id})`,
        note: changeNote,
      });
    } else {
      state.decisions.push({ id: randomUUID(), createdAt: Date.now(), status: "DEFINED", description: "Direction artistique initiale définie." });
    }
    state.identity = full;
    this.write(workspaceId, state);
    return full;
  }

  addDecision(workspaceId: string | undefined, status: CreativeDecisionStatus, description: string, note?: string): CreativeDecision {
    const state = this.read(workspaceId);
    const full: CreativeDecision = { id: randomUUID(), createdAt: Date.now(), status, description, note };
    state.decisions.push(full);
    this.write(workspaceId, state);
    return full;
  }
}
