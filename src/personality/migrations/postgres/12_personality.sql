CREATE TABLE IF NOT EXISTS jarvis_personality_state (
  conversation_id TEXT PRIMARY KEY,
  monsieur_cooldown_remaining INTEGER NOT NULL DEFAULT 0,
  updated_at BIGINT NOT NULL,
  CONSTRAINT fk_personality_conversation FOREIGN KEY(conversation_id)
    REFERENCES conversation_sessions(conversation_id) ON DELETE CASCADE
);
