import { randomUUID } from "node:crypto";
import { getDb } from "../persistence/db.js";
import type { AgentTeamMessage, AgentTeamRun, AgentTeamRunStatus } from "./types.js";

interface AgentTeamRunRow {
  id: string; objective: string; status: string; profile_ids_json: string; current_index: number;
  rounds_completed: number; max_rounds: number; workspace_id: string | null; conversation_id: string | null;
  last_error: string | null; created_at: number; updated_at: number;
}

function rowToRun(row: AgentTeamRunRow): AgentTeamRun {
  return {
    id: row.id,
    objective: row.objective,
    status: row.status as AgentTeamRunStatus,
    profileIds: JSON.parse(row.profile_ids_json),
    currentIndex: row.current_index,
    roundsCompleted: row.rounds_completed,
    maxRounds: row.max_rounds,
    workspaceId: row.workspace_id ?? undefined,
    conversationId: row.conversation_id ?? undefined,
    lastError: row.last_error ?? undefined,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

/**
 * Persistance durable des sessions multi-agents (Brique 4 appliquée à la brique
 * multi-agents) : chaque tour d'un agent de l'équipe est écrit en base dès qu'il
 * se termine, si bien qu'un crash serveur, une coupure réseau ou une interruption
 * de l'API LLM en cours de collaboration peut être repris depuis le dernier tour
 * durablement enregistré plutôt que perdu.
 */
export class AgentTeamStore {
  createRun(input: { objective: string; profileIds: string[]; maxRounds: number; workspaceId?: string; conversationId?: string }): AgentTeamRun {
    const now = Date.now();
    const run: AgentTeamRun = {
      id: randomUUID(),
      objective: input.objective,
      status: "RUNNING",
      profileIds: input.profileIds,
      currentIndex: 0,
      roundsCompleted: 0,
      maxRounds: input.maxRounds,
      workspaceId: input.workspaceId,
      conversationId: input.conversationId,
      createdAt: now,
      updatedAt: now,
    };
    getDb()
      .prepare(
        `INSERT INTO agent_team_runs(id,objective,status,profile_ids_json,current_index,rounds_completed,max_rounds,workspace_id,conversation_id,created_at,updated_at)
         VALUES(?,?,?,?,?,?,?,?,?,?,?)`,
      )
      .run(run.id, run.objective, run.status, JSON.stringify(run.profileIds), run.currentIndex, run.roundsCompleted, run.maxRounds, run.workspaceId ?? null, run.conversationId ?? null, now, now);
    return run;
  }

  get(id: string): AgentTeamRun | null {
    const row = getDb().prepare(`SELECT * FROM agent_team_runs WHERE id=?`).get(id) as AgentTeamRunRow | undefined;
    return row ? rowToRun(row) : null;
  }

  /** Sessions non terminées au redémarrage — candidates à la reprise transparente. */
  incomplete(): AgentTeamRun[] {
    return (getDb().prepare(`SELECT * FROM agent_team_runs WHERE status='RUNNING' ORDER BY created_at`).all() as AgentTeamRunRow[]).map(rowToRun);
  }

  advance(id: string, currentIndex: number, roundsCompleted: number): void {
    getDb()
      .prepare(`UPDATE agent_team_runs SET current_index=?, rounds_completed=?, updated_at=? WHERE id=?`)
      .run(currentIndex, roundsCompleted, Date.now(), id);
  }

  complete(id: string): void {
    getDb().prepare(`UPDATE agent_team_runs SET status='COMPLETED', updated_at=? WHERE id=?`).run(Date.now(), id);
  }

  fail(id: string, error: string): void {
    getDb().prepare(`UPDATE agent_team_runs SET status='FAILED', last_error=?, updated_at=? WHERE id=?`).run(error, Date.now(), id);
  }

  appendMessage(teamRunId: string, agentId: string, role: "user" | "assistant", content: string): AgentTeamMessage {
    const sequence = ((getDb().prepare(`SELECT MAX(sequence) max FROM agent_team_messages WHERE team_run_id=?`).get(teamRunId) as { max: number | null }).max ?? -1) + 1;
    const message: AgentTeamMessage = { id: randomUUID(), teamRunId, sequence, agentId, role, content, createdAt: Date.now() };
    getDb()
      .prepare(`INSERT INTO agent_team_messages(id,team_run_id,sequence,agent_id,role,content,created_at) VALUES(?,?,?,?,?,?,?)`)
      .run(message.id, message.teamRunId, message.sequence, message.agentId, message.role, message.content, message.createdAt);
    return message;
  }

  messages(teamRunId: string): AgentTeamMessage[] {
    return (getDb().prepare(`SELECT * FROM agent_team_messages WHERE team_run_id=? ORDER BY sequence`).all(teamRunId) as any[]).map((row) => ({
      id: row.id,
      teamRunId: row.team_run_id,
      sequence: row.sequence,
      agentId: row.agent_id,
      role: row.role,
      content: row.content,
      createdAt: row.created_at,
    }));
  }

  list(limit = 50): AgentTeamRun[] {
    return (getDb().prepare(`SELECT * FROM agent_team_runs ORDER BY created_at DESC LIMIT ?`).all(Math.min(Math.max(limit, 1), 200)) as AgentTeamRunRow[]).map(rowToRun);
  }
}
