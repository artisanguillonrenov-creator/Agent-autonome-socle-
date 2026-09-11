import { randomUUID } from "node:crypto";
import type pg from "pg";
import type { IConversationRepository } from "./conversationRepository.js";
import type {
  AcceptedTurnInput,
  CompletedTurnPayload,
  ConversationMessageInput,
  ConversationPage,
  ConversationSession,
  ConversationTurn,
  StoredConversationMessage,
  TurnAcceptance,
} from "./types.js";

const SCHEMA = `
CREATE TABLE IF NOT EXISTS conversation_sessions (
  conversation_id TEXT PRIMARY KEY,
  workspace_id TEXT,
  title TEXT NOT NULL DEFAULT 'Nouvelle conversation',
  status TEXT NOT NULL DEFAULT 'ACTIVE' CHECK(status IN ('ACTIVE','ARCHIVED')),
  last_message_sequence INTEGER NOT NULL DEFAULT -1,
  created_at BIGINT NOT NULL,
  last_interaction_at BIGINT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_conversation_sessions_workspace ON conversation_sessions(workspace_id);
CREATE TABLE IF NOT EXISTS conversation_turns (
  turn_id TEXT PRIMARY KEY,
  conversation_id TEXT NOT NULL,
  client_request_id TEXT,
  voice_command_id TEXT,
  request_kind TEXT NOT NULL CHECK(request_kind IN ('MESSAGE','REGENERATE')),
  status TEXT NOT NULL DEFAULT 'ACCEPTED' CHECK(status IN ('ACCEPTED','RUNNING','COMPLETED','FAILED')),
  request_fingerprint TEXT NOT NULL,
  failure_reason TEXT,
  result_json TEXT,
  created_at BIGINT NOT NULL,
  started_at BIGINT,
  completed_at BIGINT,
  CONSTRAINT fk_conversation_turn_session FOREIGN KEY(conversation_id) REFERENCES conversation_sessions(conversation_id) ON DELETE CASCADE,
  CONSTRAINT unq_conversation_turn_pair UNIQUE(conversation_id, turn_id),
  CONSTRAINT unq_conversation_client_request UNIQUE(conversation_id, client_request_id),
  CONSTRAINT unq_conversation_voice_command UNIQUE(conversation_id, voice_command_id)
);
CREATE INDEX IF NOT EXISTS idx_conversation_turns_status ON conversation_turns(conversation_id,status);
CREATE TABLE IF NOT EXISTS conversation_messages (
  message_id TEXT PRIMARY KEY,
  conversation_id TEXT NOT NULL,
  turn_id TEXT,
  sequence INTEGER NOT NULL,
  role TEXT NOT NULL CHECK(role IN ('system','user','assistant','tool')),
  content TEXT,
  name TEXT,
  tool_call_id TEXT,
  tool_calls TEXT,
  status TEXT NOT NULL DEFAULT 'ACTIVE' CHECK(status IN ('ACTIVE','SUPERSEDED')),
  revision_of_id TEXT,
  created_at BIGINT NOT NULL,
  CONSTRAINT fk_conversation_message_session FOREIGN KEY(conversation_id) REFERENCES conversation_sessions(conversation_id) ON DELETE CASCADE,
  CONSTRAINT fk_conversation_message_turn FOREIGN KEY(conversation_id, turn_id) REFERENCES conversation_turns(conversation_id, turn_id),
  CONSTRAINT unq_conversation_message_sequence UNIQUE(conversation_id, sequence)
);
CREATE INDEX IF NOT EXISTS idx_conversation_messages_cursor ON conversation_messages(conversation_id,status,sequence DESC);
CREATE INDEX IF NOT EXISTS idx_conversation_messages_turn ON conversation_messages(turn_id);
`;

type Row = Record<string, any>;

function parseToolCalls(raw: unknown) {
  if (typeof raw !== "string" || !raw) return undefined;
  try { return JSON.parse(raw); } catch { return undefined; }
}
function mapSession(row: Row): ConversationSession {
  return {
    conversationId: row.conversation_id,
    workspaceId: row.workspace_id ?? null,
    title: row.title,
    status: row.status,
    lastMessageSequence: Number(row.last_message_sequence),
    createdAt: Number(row.created_at),
    lastInteractionAt: Number(row.last_interaction_at),
  };
}
function mapTurn(row: Row): ConversationTurn {
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
function mapMessage(row: Row): StoredConversationMessage {
  return {
    messageId: row.message_id,
    conversationId: row.conversation_id,
    turnId: row.turn_id ?? null,
    sequence: Number(row.sequence),
    status: row.status,
    revisionOfId: row.revision_of_id ?? null,
    createdAt: Number(row.created_at),
    message: {
      role: row.role,
      content: row.content ?? null,
      ...(row.name ? { name: row.name } : {}),
      ...(row.tool_call_id ? { toolCallId: row.tool_call_id } : {}),
      ...(row.tool_calls ? { toolCalls: parseToolCalls(row.tool_calls) } : {}),
    },
  };
}

export class PostgresConversationRepository implements IConversationRepository {
  constructor(private readonly pool: pg.Pool) {}

  async initialize(): Promise<void> {
    const client = await this.pool.connect();
    try {
      await client.query("BEGIN");
      await client.query(SCHEMA);
      await client.query("COMMIT");
    } catch (error) {
      await client.query("ROLLBACK");
      throw error;
    } finally {
      client.release();
    }
  }

  async initializeSession(conversationId: string, workspaceId: string | null): Promise<ConversationSession> {
    const now = Date.now();
    await this.pool.query(`INSERT INTO conversation_sessions
      (conversation_id,workspace_id,title,status,last_message_sequence,created_at,last_interaction_at)
      VALUES ($1,$2,'Nouvelle conversation','ACTIVE',-1,$3,$3)
      ON CONFLICT (conversation_id) DO NOTHING`, [conversationId, workspaceId, now]);
    const session = await this.getSession(conversationId);
    if (!session) throw new Error("SESSION_INITIALIZATION_FAILED");
    if (session.workspaceId !== workspaceId) throw new Error("CONVERSATION_WORKSPACE_MISMATCH");
    return session;
  }

  async getSession(conversationId: string): Promise<ConversationSession | null> {
    const result = await this.pool.query("SELECT * FROM conversation_sessions WHERE conversation_id=$1", [conversationId]);
    return result.rows[0] ? mapSession(result.rows[0]) : null;
  }

  async listSessions(workspaceId: string | null): Promise<ConversationSession[]> {
    const result = workspaceId === null
      ? await this.pool.query("SELECT * FROM conversation_sessions WHERE workspace_id IS NULL AND status='ACTIVE' ORDER BY last_interaction_at DESC")
      : await this.pool.query("SELECT * FROM conversation_sessions WHERE workspace_id=$1 AND status='ACTIVE' ORDER BY last_interaction_at DESC", [workspaceId]);
    return result.rows.map(mapSession);
  }

  async updateSessionTitle(conversationId: string, title: string): Promise<void> {
    await this.pool.query("UPDATE conversation_sessions SET title=$1,last_interaction_at=$2 WHERE conversation_id=$3", [title, Date.now(), conversationId]);
  }

  async archiveSession(conversationId: string): Promise<void> {
    await this.pool.query("UPDATE conversation_sessions SET status='ARCHIVED',last_interaction_at=$1 WHERE conversation_id=$2", [Date.now(), conversationId]);
  }

  private async findByExternalKey(input: AcceptedTurnInput): Promise<ConversationTurn | null> {
    if (input.clientRequestId) {
      const byClient = await this.pool.query("SELECT * FROM conversation_turns WHERE conversation_id=$1 AND client_request_id=$2", [input.conversationId, input.clientRequestId]);
      if (byClient.rows[0]) return mapTurn(byClient.rows[0]);
    }
    if (input.voiceCommandId) {
      const byVoice = await this.pool.query("SELECT * FROM conversation_turns WHERE conversation_id=$1 AND voice_command_id=$2", [input.conversationId, input.voiceCommandId]);
      if (byVoice.rows[0]) return mapTurn(byVoice.rows[0]);
    }
    return null;
  }

  async acceptTurnIdempotently(input: AcceptedTurnInput): Promise<TurnAcceptance> {
    const existing = await this.findByExternalKey(input);
    if (existing) return existing.requestFingerprint === input.requestFingerprint ? { kind: "EXISTING", turn: existing } : { kind: "MISMATCH", turn: existing };
    const now = Date.now();
    try {
      const inserted = await this.pool.query(`INSERT INTO conversation_turns
        (turn_id,conversation_id,client_request_id,voice_command_id,request_kind,status,request_fingerprint,failure_reason,result_json,created_at,started_at,completed_at)
        VALUES ($1,$2,$3,$4,$5,'ACCEPTED',$6,NULL,NULL,$7,NULL,NULL)
        RETURNING *`, [input.turnId, input.conversationId, input.clientRequestId, input.voiceCommandId, input.requestKind, input.requestFingerprint, now]);
      return { kind: "NEW", turn: mapTurn(inserted.rows[0]) };
    } catch (error: any) {
      if (error?.code !== "23505") throw error;
      const collided = await this.findByExternalKey(input);
      if (!collided) throw error;
      return collided.requestFingerprint === input.requestFingerprint ? { kind: "EXISTING", turn: collided } : { kind: "MISMATCH", turn: collided };
    }
  }

  async markTurnRunning(turnId: string): Promise<void> {
    const result = await this.pool.query("UPDATE conversation_turns SET status='RUNNING',started_at=$1 WHERE turn_id=$2 AND status='ACCEPTED'", [Date.now(), turnId]);
    if (result.rowCount !== 1) throw new Error("TURN_NOT_ACCEPTED");
  }

  async failTurn(turnId: string, reason: string): Promise<void> {
    await this.pool.query("UPDATE conversation_turns SET status='FAILED',failure_reason=$1,completed_at=$2 WHERE turn_id=$3 AND status IN ('ACCEPTED','RUNNING')", [reason.slice(0, 500), Date.now(), turnId]);
  }

  async appendMessage(conversationId: string, turnId: string | null, message: ConversationMessageInput, messageId: string): Promise<StoredConversationMessage> {
    const client = await this.pool.connect();
    try {
      await client.query("BEGIN");
      const session = await client.query("SELECT last_message_sequence FROM conversation_sessions WHERE conversation_id=$1 FOR UPDATE", [conversationId]);
      if (!session.rows[0]) throw new Error("SESSION_NOT_FOUND");
      const sequence = Number(session.rows[0].last_message_sequence) + 1;
      const now = Date.now();
      await client.query("UPDATE conversation_sessions SET last_message_sequence=$1,last_interaction_at=$2 WHERE conversation_id=$3", [sequence, now, conversationId]);
      const inserted = await client.query(`INSERT INTO conversation_messages
        (message_id,conversation_id,turn_id,sequence,role,content,name,tool_call_id,tool_calls,status,revision_of_id,created_at)
        VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,'ACTIVE',NULL,$10) RETURNING *`, [
          messageId, conversationId, turnId, sequence, message.role, message.content,
          message.name ?? null, message.toolCallId ?? null, message.toolCalls ? JSON.stringify(message.toolCalls) : null, now,
        ]);
      await client.query("COMMIT");
      return mapMessage(inserted.rows[0]);
    } catch (error) {
      await client.query("ROLLBACK");
      throw error;
    } finally { client.release(); }
  }

  async appendFinalMessageAndCompleteTurn(conversationId: string, turnId: string, message: ConversationMessageInput, messageId: string, completed: CompletedTurnPayload): Promise<StoredConversationMessage> {
    const client = await this.pool.connect();
    try {
      await client.query("BEGIN");
      const turn = await client.query("SELECT status FROM conversation_turns WHERE conversation_id=$1 AND turn_id=$2 FOR UPDATE", [conversationId, turnId]);
      if (!turn.rows[0] || turn.rows[0].status !== "RUNNING") throw new Error("TURN_NOT_RUNNING");
      const session = await client.query("SELECT last_message_sequence FROM conversation_sessions WHERE conversation_id=$1 FOR UPDATE", [conversationId]);
      if (!session.rows[0]) throw new Error("SESSION_NOT_FOUND");
      const sequence = Number(session.rows[0].last_message_sequence) + 1;
      const now = Date.now();
      await client.query("UPDATE conversation_sessions SET last_message_sequence=$1,last_interaction_at=$2 WHERE conversation_id=$3", [sequence, now, conversationId]);
      const inserted = await client.query(`INSERT INTO conversation_messages
        (message_id,conversation_id,turn_id,sequence,role,content,name,tool_call_id,tool_calls,status,revision_of_id,created_at)
        VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,'ACTIVE',NULL,$10) RETURNING *`, [messageId, conversationId, turnId, sequence, message.role, message.content, message.name ?? null, message.toolCallId ?? null, message.toolCalls ? JSON.stringify(message.toolCalls) : null, now]);
      const done = await client.query("UPDATE conversation_turns SET status='COMPLETED',result_json=$1,completed_at=$2 WHERE conversation_id=$3 AND turn_id=$4 AND status='RUNNING'", [JSON.stringify(completed), now, conversationId, turnId]);
      if (done.rowCount !== 1) throw new Error("TURN_COMPLETION_RACE");
      await client.query("COMMIT");
      return mapMessage(inserted.rows[0]);
    } catch (error) { await client.query("ROLLBACK"); throw error; } finally { client.release(); }
  }

  async appendRevisionAndCompleteTurn(conversationId: string, turnId: string, oldMessageId: string, message: ConversationMessageInput, messageId: string, completed: CompletedTurnPayload): Promise<StoredConversationMessage> {
    const client = await this.pool.connect();
    try {
      await client.query("BEGIN");
      const turn = await client.query("SELECT status FROM conversation_turns WHERE conversation_id=$1 AND turn_id=$2 FOR UPDATE", [conversationId, turnId]);
      if (!turn.rows[0] || turn.rows[0].status !== "RUNNING") throw new Error("TURN_NOT_RUNNING");
      const old = await client.query("SELECT * FROM conversation_messages WHERE conversation_id=$1 AND message_id=$2 FOR UPDATE", [conversationId, oldMessageId]);
      if (!old.rows[0] || old.rows[0].status !== "ACTIVE" || old.rows[0].role !== "assistant" || old.rows[0].tool_calls) throw new Error("TARGET_MESSAGE_NOT_REGENERABLE");
      const session = await client.query("SELECT last_message_sequence FROM conversation_sessions WHERE conversation_id=$1 FOR UPDATE", [conversationId]);
      if (!session.rows[0]) throw new Error("SESSION_NOT_FOUND");
      const sequence = Number(session.rows[0].last_message_sequence) + 1;
      const now = Date.now();
      await client.query("UPDATE conversation_sessions SET last_message_sequence=$1,last_interaction_at=$2 WHERE conversation_id=$3", [sequence, now, conversationId]);
      const inserted = await client.query(`INSERT INTO conversation_messages
        (message_id,conversation_id,turn_id,sequence,role,content,name,tool_call_id,tool_calls,status,revision_of_id,created_at)
        VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,'ACTIVE',$10,$11) RETURNING *`, [messageId, conversationId, turnId, sequence, message.role, message.content, message.name ?? null, message.toolCallId ?? null, message.toolCalls ? JSON.stringify(message.toolCalls) : null, oldMessageId, now]);
      const superseded = await client.query("UPDATE conversation_messages SET status='SUPERSEDED' WHERE conversation_id=$1 AND message_id=$2 AND status='ACTIVE'", [conversationId, oldMessageId]);
      if (superseded.rowCount !== 1) throw new Error("TARGET_MESSAGE_REVISION_RACE");
      const done = await client.query("UPDATE conversation_turns SET status='COMPLETED',result_json=$1,completed_at=$2 WHERE conversation_id=$3 AND turn_id=$4 AND status='RUNNING'", [JSON.stringify(completed), now, conversationId, turnId]);
      if (done.rowCount !== 1) throw new Error("TURN_COMPLETION_RACE");
      await client.query("COMMIT");
      return mapMessage(inserted.rows[0]);
    } catch (error) { await client.query("ROLLBACK"); throw error; } finally { client.release(); }
  }

  async getMessage(messageId: string): Promise<StoredConversationMessage | null> {
    const result = await this.pool.query("SELECT * FROM conversation_messages WHERE message_id=$1", [messageId]);
    return result.rows[0] ? mapMessage(result.rows[0]) : null;
  }

  async getCompletedTurnResult(turnId: string): Promise<CompletedTurnPayload | null> {
    const result = await this.pool.query("SELECT status,result_json FROM conversation_turns WHERE turn_id=$1", [turnId]);
    const row = result.rows[0];
    if (!row || row.status !== "COMPLETED" || !row.result_json) return null;
    try { return JSON.parse(row.result_json) as CompletedTurnPayload; } catch { return null; }
  }

  async getLastActiveMessages(conversationId: string, limit: number): Promise<StoredConversationMessage[]> {
    const safeLimit = Math.max(1, Math.min(100, Math.trunc(limit)));
    const result = await this.pool.query("SELECT * FROM conversation_messages WHERE conversation_id=$1 AND status='ACTIVE' ORDER BY sequence DESC LIMIT $2", [conversationId, safeLimit]);
    return result.rows.reverse().map(mapMessage);
  }

  async getMessagesPage(conversationId: string, limit: number, beforeSequence?: number): Promise<ConversationPage> {
    const safeLimit = Math.max(1, Math.min(100, Math.trunc(limit || 30)));
    const result = beforeSequence == null
      ? await this.pool.query("SELECT * FROM conversation_messages WHERE conversation_id=$1 AND status='ACTIVE' ORDER BY sequence DESC LIMIT $2", [conversationId, safeLimit])
      : await this.pool.query("SELECT * FROM conversation_messages WHERE conversation_id=$1 AND status='ACTIVE' AND sequence<$2 ORDER BY sequence DESC LIMIT $3", [conversationId, beforeSequence, safeLimit]);
    const items = result.rows.reverse().map(mapMessage);
    return { items, nextBeforeSequence: items.length === safeLimit ? items[0]?.sequence ?? null : null };
  }

  async recoverInterruptedTurns(): Promise<number> {
    const result = await this.pool.query("UPDATE conversation_turns SET status='FAILED',failure_reason='PROCESS_RESTART',completed_at=$1 WHERE status IN ('ACCEPTED','RUNNING')", [Date.now()]);
    return result.rowCount ?? 0;
  }

  async importHistoricalMessages(conversationId: string, messages: ConversationMessageInput[]): Promise<StoredConversationMessage[]> {
    const client = await this.pool.connect();
    try {
      await client.query("BEGIN");
      const session = await client.query("SELECT last_message_sequence FROM conversation_sessions WHERE conversation_id=$1 FOR UPDATE", [conversationId]);
      if (!session.rows[0]) throw new Error("SESSION_NOT_FOUND");
      let sequence = Number(session.rows[0].last_message_sequence);
      const stored: StoredConversationMessage[] = [];
      for (const message of messages) {
        sequence += 1;
        const now = Date.now();
        const messageId = randomUUID();
        const inserted = await client.query(`INSERT INTO conversation_messages
          (message_id,conversation_id,turn_id,sequence,role,content,name,tool_call_id,tool_calls,status,revision_of_id,created_at)
          VALUES ($1,$2,NULL,$3,$4,$5,$6,$7,$8,'ACTIVE',NULL,$9) RETURNING *`, [messageId, conversationId, sequence, message.role, message.content, message.name ?? null, message.toolCallId ?? null, message.toolCalls ? JSON.stringify(message.toolCalls) : null, now]);
        stored.push(mapMessage(inserted.rows[0]));
      }
      await client.query("UPDATE conversation_sessions SET last_message_sequence=$1,last_interaction_at=$2 WHERE conversation_id=$3", [sequence, Date.now(), conversationId]);
      await client.query("COMMIT");
      return stored;
    } catch (error) { await client.query("ROLLBACK"); throw error; } finally { client.release(); }
  }
}
