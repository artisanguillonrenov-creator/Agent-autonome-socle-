import type Database from "better-sqlite3";
import { getDb } from "../db.js";
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
  created_at INTEGER NOT NULL,
  last_interaction_at INTEGER NOT NULL
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
  created_at INTEGER NOT NULL,
  started_at INTEGER,
  completed_at INTEGER,
  FOREIGN KEY(conversation_id) REFERENCES conversation_sessions(conversation_id) ON DELETE CASCADE,
  UNIQUE(conversation_id, turn_id),
  UNIQUE(conversation_id, client_request_id),
  UNIQUE(conversation_id, voice_command_id)
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
  created_at INTEGER NOT NULL,
  FOREIGN KEY(conversation_id) REFERENCES conversation_sessions(conversation_id) ON DELETE CASCADE,
  FOREIGN KEY(conversation_id, turn_id) REFERENCES conversation_turns(conversation_id, turn_id),
  UNIQUE(conversation_id, sequence)
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

export class SqliteConversationRepository implements IConversationRepository {
  private readonly db: Database.Database;

  constructor(db: Database.Database = getDb()) {
    this.db = db;
  }

  async initialize(): Promise<void> {
    this.db.pragma("foreign_keys = ON");
    this.db.exec(SCHEMA);
  }

  async initializeSession(conversationId: string, workspaceId: string | null): Promise<ConversationSession> {
    const now = Date.now();
    this.db.prepare(`INSERT OR IGNORE INTO conversation_sessions
      (conversation_id,workspace_id,title,status,last_message_sequence,created_at,last_interaction_at)
      VALUES (?,?,'Nouvelle conversation','ACTIVE',-1,?,?)`).run(conversationId, workspaceId, now, now);
    const row = this.db.prepare("SELECT * FROM conversation_sessions WHERE conversation_id=?").get(conversationId) as Row | undefined;
    if (!row) throw new Error("SESSION_INITIALIZATION_FAILED");
    const session = mapSession(row);
    if (session.workspaceId !== workspaceId) throw new Error("CONVERSATION_WORKSPACE_MISMATCH");
    return session;
  }

  async getSession(conversationId: string): Promise<ConversationSession | null> {
    const row = this.db.prepare("SELECT * FROM conversation_sessions WHERE conversation_id=?").get(conversationId) as Row | undefined;
    return row ? mapSession(row) : null;
  }

  async listSessions(workspaceId: string | null): Promise<ConversationSession[]> {
    const rows = workspaceId === null
      ? this.db.prepare("SELECT * FROM conversation_sessions WHERE workspace_id IS NULL AND status='ACTIVE' ORDER BY last_interaction_at DESC").all()
      : this.db.prepare("SELECT * FROM conversation_sessions WHERE workspace_id=? AND status='ACTIVE' ORDER BY last_interaction_at DESC").all(workspaceId);
    return (rows as Row[]).map(mapSession);
  }

  async updateSessionTitle(conversationId: string, title: string): Promise<void> {
    this.db.prepare("UPDATE conversation_sessions SET title=?, last_interaction_at=? WHERE conversation_id=?").run(title, Date.now(), conversationId);
  }

  async archiveSession(conversationId: string): Promise<void> {
    this.db.prepare("UPDATE conversation_sessions SET status='ARCHIVED', last_interaction_at=? WHERE conversation_id=?").run(Date.now(), conversationId);
  }

  private findByExternalKey(input: AcceptedTurnInput): Row | undefined {
    if (input.clientRequestId) {
      const row = this.db.prepare("SELECT * FROM conversation_turns WHERE conversation_id=? AND client_request_id=?").get(input.conversationId, input.clientRequestId) as Row | undefined;
      if (row) return row;
    }
    if (input.voiceCommandId) {
      return this.db.prepare("SELECT * FROM conversation_turns WHERE conversation_id=? AND voice_command_id=?").get(input.conversationId, input.voiceCommandId) as Row | undefined;
    }
    return undefined;
  }

  async acceptTurnIdempotently(input: AcceptedTurnInput): Promise<TurnAcceptance> {
    const existing = this.findByExternalKey(input);
    if (existing) {
      const turn = mapTurn(existing);
      return turn.requestFingerprint === input.requestFingerprint ? { kind: "EXISTING", turn } : { kind: "MISMATCH", turn };
    }
    const now = Date.now();
    try {
      this.db.prepare(`INSERT INTO conversation_turns
        (turn_id,conversation_id,client_request_id,voice_command_id,request_kind,status,request_fingerprint,failure_reason,result_json,created_at,started_at,completed_at)
        VALUES (?,?,?,?,?,'ACCEPTED',?,NULL,NULL,?,NULL,NULL)`)
        .run(input.turnId, input.conversationId, input.clientRequestId, input.voiceCommandId, input.requestKind, input.requestFingerprint, now);
    } catch (error) {
      const collided = this.findByExternalKey(input);
      if (!collided) throw error;
      const turn = mapTurn(collided);
      return turn.requestFingerprint === input.requestFingerprint ? { kind: "EXISTING", turn } : { kind: "MISMATCH", turn };
    }
    const row = this.db.prepare("SELECT * FROM conversation_turns WHERE turn_id=?").get(input.turnId) as Row;
    return { kind: "NEW", turn: mapTurn(row) };
  }

  async markTurnRunning(turnId: string): Promise<void> {
    const changed = this.db.prepare("UPDATE conversation_turns SET status='RUNNING', started_at=? WHERE turn_id=? AND status='ACCEPTED'").run(Date.now(), turnId).changes;
    if (changed !== 1) throw new Error("TURN_NOT_ACCEPTED");
  }

  async failTurn(turnId: string, reason: string): Promise<void> {
    this.db.prepare("UPDATE conversation_turns SET status='FAILED', failure_reason=?, completed_at=? WHERE turn_id=? AND status IN ('ACCEPTED','RUNNING')")
      .run(reason.slice(0, 500), Date.now(), turnId);
  }

  private insertMessage(
    conversationId: string,
    turnId: string | null,
    message: ConversationMessageInput,
    messageId: string,
    status: "ACTIVE" | "SUPERSEDED" = "ACTIVE",
    revisionOfId: string | null = null,
  ): StoredConversationMessage {
    let stored!: StoredConversationMessage;
    const tx = this.db.transaction(() => {
      const session = this.db.prepare("SELECT last_message_sequence FROM conversation_sessions WHERE conversation_id=?").get(conversationId) as Row | undefined;
      if (!session) throw new Error("SESSION_NOT_FOUND");
      const sequence = Number(session.last_message_sequence) + 1;
      const now = Date.now();
      this.db.prepare("UPDATE conversation_sessions SET last_message_sequence=?, last_interaction_at=? WHERE conversation_id=?")
        .run(sequence, now, conversationId);
      this.db.prepare(`INSERT INTO conversation_messages
        (message_id,conversation_id,turn_id,sequence,role,content,name,tool_call_id,tool_calls,status,revision_of_id,created_at)
        VALUES (?,?,?,?,?,?,?,?,?,?,?,?)`).run(
          messageId, conversationId, turnId, sequence, message.role, message.content,
          message.name ?? null, message.toolCallId ?? null, message.toolCalls ? JSON.stringify(message.toolCalls) : null,
          status, revisionOfId, now,
        );
      const row = this.db.prepare("SELECT * FROM conversation_messages WHERE message_id=?").get(messageId) as Row;
      stored = mapMessage(row);
    });
    tx.immediate();
    return stored;
  }

  async appendMessage(conversationId: string, turnId: string | null, message: ConversationMessageInput, messageId: string): Promise<StoredConversationMessage> {
    return this.insertMessage(conversationId, turnId, message, messageId);
  }

  async appendFinalMessageAndCompleteTurn(
    conversationId: string,
    turnId: string,
    message: ConversationMessageInput,
    messageId: string,
    completed: CompletedTurnPayload,
  ): Promise<StoredConversationMessage> {
    let stored!: StoredConversationMessage;
    const tx = this.db.transaction(() => {
      const turn = this.db.prepare("SELECT status FROM conversation_turns WHERE turn_id=? AND conversation_id=?").get(turnId, conversationId) as Row | undefined;
      if (!turn || turn.status !== "RUNNING") throw new Error("TURN_NOT_RUNNING");
      const session = this.db.prepare("SELECT last_message_sequence FROM conversation_sessions WHERE conversation_id=?").get(conversationId) as Row | undefined;
      if (!session) throw new Error("SESSION_NOT_FOUND");
      const sequence = Number(session.last_message_sequence) + 1;
      const now = Date.now();
      this.db.prepare("UPDATE conversation_sessions SET last_message_sequence=?, last_interaction_at=? WHERE conversation_id=?").run(sequence, now, conversationId);
      this.db.prepare(`INSERT INTO conversation_messages
        (message_id,conversation_id,turn_id,sequence,role,content,name,tool_call_id,tool_calls,status,revision_of_id,created_at)
        VALUES (?,?,?,?,?,?,?,?,?,'ACTIVE',NULL,?)`).run(
          messageId, conversationId, turnId, sequence, message.role, message.content,
          message.name ?? null, message.toolCallId ?? null, message.toolCalls ? JSON.stringify(message.toolCalls) : null, now,
        );
      const changed = this.db.prepare("UPDATE conversation_turns SET status='COMPLETED', result_json=?, completed_at=? WHERE turn_id=? AND conversation_id=? AND status='RUNNING'")
        .run(JSON.stringify(completed), now, turnId, conversationId).changes;
      if (changed !== 1) throw new Error("TURN_COMPLETION_RACE");
      stored = mapMessage(this.db.prepare("SELECT * FROM conversation_messages WHERE message_id=?").get(messageId) as Row);
    });
    tx.immediate();
    return stored;
  }

  async appendRevisionAndCompleteTurn(
    conversationId: string,
    turnId: string,
    oldMessageId: string,
    message: ConversationMessageInput,
    messageId: string,
    completed: CompletedTurnPayload,
  ): Promise<StoredConversationMessage> {
    let stored!: StoredConversationMessage;
    const tx = this.db.transaction(() => {
      const turn = this.db.prepare("SELECT status FROM conversation_turns WHERE turn_id=? AND conversation_id=?").get(turnId, conversationId) as Row | undefined;
      if (!turn || turn.status !== "RUNNING") throw new Error("TURN_NOT_RUNNING");
      const old = this.db.prepare("SELECT * FROM conversation_messages WHERE message_id=? AND conversation_id=?").get(oldMessageId, conversationId) as Row | undefined;
      if (!old || old.status !== "ACTIVE" || old.role !== "assistant" || old.tool_calls) throw new Error("TARGET_MESSAGE_NOT_REGENERABLE");
      const session = this.db.prepare("SELECT last_message_sequence FROM conversation_sessions WHERE conversation_id=?").get(conversationId) as Row | undefined;
      if (!session) throw new Error("SESSION_NOT_FOUND");
      const sequence = Number(session.last_message_sequence) + 1;
      const now = Date.now();
      this.db.prepare("UPDATE conversation_sessions SET last_message_sequence=?, last_interaction_at=? WHERE conversation_id=?").run(sequence, now, conversationId);
      this.db.prepare(`INSERT INTO conversation_messages
        (message_id,conversation_id,turn_id,sequence,role,content,name,tool_call_id,tool_calls,status,revision_of_id,created_at)
        VALUES (?,?,?,?,?,?,?,?,?,'ACTIVE',?,?)`).run(
          messageId, conversationId, turnId, sequence, message.role, message.content,
          message.name ?? null, message.toolCallId ?? null, message.toolCalls ? JSON.stringify(message.toolCalls) : null,
          oldMessageId, now,
        );
      const superseded = this.db.prepare("UPDATE conversation_messages SET status='SUPERSEDED' WHERE message_id=? AND conversation_id=? AND status='ACTIVE'")
        .run(oldMessageId, conversationId).changes;
      if (superseded !== 1) throw new Error("TARGET_MESSAGE_REVISION_RACE");
      const changed = this.db.prepare("UPDATE conversation_turns SET status='COMPLETED', result_json=?, completed_at=? WHERE turn_id=? AND conversation_id=? AND status='RUNNING'")
        .run(JSON.stringify(completed), now, turnId, conversationId).changes;
      if (changed !== 1) throw new Error("TURN_COMPLETION_RACE");
      stored = mapMessage(this.db.prepare("SELECT * FROM conversation_messages WHERE message_id=?").get(messageId) as Row);
    });
    tx.immediate();
    return stored;
  }

  async getMessage(messageId: string): Promise<StoredConversationMessage | null> {
    const row = this.db.prepare("SELECT * FROM conversation_messages WHERE message_id=?").get(messageId) as Row | undefined;
    return row ? mapMessage(row) : null;
  }

  async getCompletedTurnResult(turnId: string): Promise<CompletedTurnPayload | null> {
    const row = this.db.prepare("SELECT status,result_json FROM conversation_turns WHERE turn_id=?").get(turnId) as Row | undefined;
    if (!row || row.status !== "COMPLETED" || !row.result_json) return null;
    try { return JSON.parse(row.result_json) as CompletedTurnPayload; } catch { return null; }
  }

  async getLastActiveMessages(conversationId: string, limit: number): Promise<StoredConversationMessage[]> {
    const safeLimit = Math.max(1, Math.min(100, Math.trunc(limit)));
    const rows = this.db.prepare("SELECT * FROM conversation_messages WHERE conversation_id=? AND status='ACTIVE' ORDER BY sequence DESC LIMIT ?")
      .all(conversationId, safeLimit) as Row[];
    return rows.reverse().map(mapMessage);
  }

  async getMessagesPage(conversationId: string, limit: number, beforeSequence?: number): Promise<ConversationPage> {
    const safeLimit = Math.max(1, Math.min(100, Math.trunc(limit || 30)));
    const rows = beforeSequence == null
      ? this.db.prepare("SELECT * FROM conversation_messages WHERE conversation_id=? AND status='ACTIVE' ORDER BY sequence DESC LIMIT ?").all(conversationId, safeLimit) as Row[]
      : this.db.prepare("SELECT * FROM conversation_messages WHERE conversation_id=? AND status='ACTIVE' AND sequence<? ORDER BY sequence DESC LIMIT ?").all(conversationId, beforeSequence, safeLimit) as Row[];
    const items = rows.reverse().map(mapMessage);
    return { items, nextBeforeSequence: items.length === safeLimit ? items[0]?.sequence ?? null : null };
  }

  async recoverInterruptedTurns(): Promise<number> {
    return this.db.prepare("UPDATE conversation_turns SET status='FAILED', failure_reason='PROCESS_RESTART', completed_at=? WHERE status IN ('ACCEPTED','RUNNING')")
      .run(Date.now()).changes;
  }

  async importHistoricalMessages(conversationId: string, messages: ConversationMessageInput[]): Promise<StoredConversationMessage[]> {
    const stored: StoredConversationMessage[] = [];
    const tx = this.db.transaction(() => {
      for (const message of messages) {
        const session = this.db.prepare("SELECT last_message_sequence FROM conversation_sessions WHERE conversation_id=?").get(conversationId) as Row | undefined;
        if (!session) throw new Error("SESSION_NOT_FOUND");
        const sequence = Number(session.last_message_sequence) + 1;
        const now = Date.now();
        const messageId = crypto.randomUUID();
        this.db.prepare("UPDATE conversation_sessions SET last_message_sequence=?, last_interaction_at=? WHERE conversation_id=?").run(sequence, now, conversationId);
        this.db.prepare(`INSERT INTO conversation_messages
          (message_id,conversation_id,turn_id,sequence,role,content,name,tool_call_id,tool_calls,status,revision_of_id,created_at)
          VALUES (?,?,NULL,?,?,?,?,?,?, 'ACTIVE',NULL,?)`).run(
            messageId, conversationId, sequence, message.role, message.content,
            message.name ?? null, message.toolCallId ?? null, message.toolCalls ? JSON.stringify(message.toolCalls) : null, now,
          );
        stored.push(mapMessage(this.db.prepare("SELECT * FROM conversation_messages WHERE message_id=?").get(messageId) as Row));
      }
    });
    tx.immediate();
    return stored;
  }
}
