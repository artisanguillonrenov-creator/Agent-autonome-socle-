import { randomUUID } from "node:crypto";
import { getDb } from "../persistence/db.js";

export interface HumanEditInput {
  workspaceId: string;
  content: string;
  artifactId?: string;
  planRunId?: string;
  note?: string;
}

export interface HumanEdit {
  id: string;
  workspaceId: string;
  artifactId?: string;
  planRunId?: string;
  content: string;
  note?: string;
  createdAt: number;
  consumedAt?: number;
}

function rowToEdit(row: any): HumanEdit {
  return {
    id: row.id,
    workspaceId: row.workspace_id,
    artifactId: row.artifact_id ?? undefined,
    planRunId: row.plan_run_id ?? undefined,
    content: row.content,
    note: row.note ?? undefined,
    createdAt: row.created_at,
    consumedAt: row.consumed_at ?? undefined,
  };
}

/**
 * File d'attente des éditions humaines directes (Human-in-the-Loop avancé) : quand
 * l'utilisateur modifie un artefact généré depuis l'IHM Web, le serveur enregistre ici
 * l'événement plutôt que de l'appliquer silencieusement. L'agent (Agent.step) ou le
 * PlanRunner (mission active) consomment ensuite ces éditions au prochain cycle utile,
 * jamais en plein milieu d'une opération déjà dispatchée.
 */
export class HumanEditStore {
  record(input: HumanEditInput): HumanEdit {
    if (!input.workspaceId.trim() || !input.content.trim()) throw new Error("INVALID_HUMAN_EDIT");
    const id = randomUUID();
    const createdAt = Date.now();
    getDb()
      .prepare(
        `INSERT INTO human_edits(id,workspace_id,artifact_id,plan_run_id,content,note,created_at) VALUES(?,?,?,?,?,?,?)`,
      )
      .run(id, input.workspaceId, input.artifactId ?? null, input.planRunId ?? null, input.content, input.note ?? null, createdAt);
    return { id, workspaceId: input.workspaceId, artifactId: input.artifactId, planRunId: input.planRunId, content: input.content, note: input.note, createdAt };
  }

  /** Éditions en attente hors de tout plan de mission (conversation directe). */
  pendingForWorkspace(workspaceId: string): HumanEdit[] {
    return (
      getDb()
        .prepare(`SELECT * FROM human_edits WHERE workspace_id=? AND plan_run_id IS NULL AND consumed_at IS NULL ORDER BY created_at`)
        .all(workspaceId) as any[]
    ).map(rowToEdit);
  }

  /** Éditions en attente rattachées à une mission (plan run) active. */
  pendingForPlanRun(planRunId: string): HumanEdit[] {
    return (
      getDb()
        .prepare(`SELECT * FROM human_edits WHERE plan_run_id=? AND consumed_at IS NULL ORDER BY created_at`)
        .all(planRunId) as any[]
    ).map(rowToEdit);
  }

  consume(id: string): void {
    getDb().prepare(`UPDATE human_edits SET consumed_at=? WHERE id=? AND consumed_at IS NULL`).run(Date.now(), id);
  }

  consumePendingForWorkspace(workspaceId: string): HumanEdit[] {
    const pending = this.pendingForWorkspace(workspaceId);
    for (const edit of pending) this.consume(edit.id);
    return pending;
  }

  consumePendingForPlanRun(planRunId: string): HumanEdit[] {
    const pending = this.pendingForPlanRun(planRunId);
    for (const edit of pending) this.consume(edit.id);
    return pending;
  }
}
