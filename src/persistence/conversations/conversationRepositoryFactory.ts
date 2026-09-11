import { getDb, getPgPool } from "../db.js";
import type { IConversationRepository } from "./conversationRepository.js";
import { PostgresConversationRepository } from "./postgresConversationRepository.js";
import { SqliteConversationRepository } from "./sqliteConversationRepository.js";
import type { ConversationTurn } from "./types.js";

function mapTurn(row: Record<string, any>): ConversationTurn {
  return {
    turnId: row.turn_id,
    conversationId: row.conversation_id,
    clientRequestId: row.client_request_id ?? null,
    voiceCommandId: row.voice_command_id ?? null,
    requestKind: row.request_kind,
    status: row.status,
    requestFingerprint: row.request_fingerprint,
    failureReason: row.failure_reason ?? null,
    createdAt: Number(row.created_at),
    startedAt: row.started_at == null ? null : Number(row.started_at),
    completedAt: row.completed_at == null ? null : Number(row.completed_at),
  };
}

export function createConversationRepository(): IConversationRepository {
  const pool = getPgPool();
  if (pool) {
    const repository: IConversationRepository = new PostgresConversationRepository(pool);
    repository.findTurnByVoiceCommandId = async (voiceCommandId: string) => {
      const result = await pool.query("SELECT * FROM conversation_turns WHERE voice_command_id=$1 ORDER BY created_at DESC LIMIT 1", [voiceCommandId]);
      return result.rows[0] ? mapTurn(result.rows[0]) : null;
    };
    return repository;
  }

  const db = getDb();
  const repository: IConversationRepository = new SqliteConversationRepository(db);
  repository.findTurnByVoiceCommandId = async (voiceCommandId: string) => {
    const row = db.prepare("SELECT * FROM conversation_turns WHERE voice_command_id=? ORDER BY created_at DESC LIMIT 1").get(voiceCommandId) as Record<string, any> | undefined;
    return row ? mapTurn(row) : null;
  };
  return repository;
}
