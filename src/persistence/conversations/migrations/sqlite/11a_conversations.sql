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
CREATE INDEX IF NOT EXISTS idx_conversation_messages_cursor
  ON conversation_messages(conversation_id,status,sequence DESC);
CREATE INDEX IF NOT EXISTS idx_conversation_messages_turn
  ON conversation_messages(turn_id);
