import { getDb } from "../persistence/db.js";

export type AudioSessionState = "LISTENING" | "TRANSCRIBING" | "THINKING" | "SPEAKING" | "DONE" | "DISCONNECTED";

export interface AudioSessionRecord {
  sessionId: string;
  workspaceId?: string;
  state: AudioSessionState;
  turnSequence: number;
  transcript?: string;
  responseText?: string;
  /** Nombre d'octets audio TTS déjà livrés au client pour ce tour — permet de reprendre un flux coupé sans le régénérer. */
  ttsBytesSent: number;
  createdAt: number;
  updatedAt: number;
}

function map(row: any): AudioSessionRecord {
  return {
    sessionId: row.session_id,
    workspaceId: row.workspace_id ?? undefined,
    state: row.state,
    turnSequence: row.turn_sequence,
    transcript: row.transcript ?? undefined,
    responseText: row.response_text ?? undefined,
    ttsBytesSent: row.tts_bytes_sent,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

/**
 * Vague 9C (idempotence avancée / coupures réseau mobile) : persiste l'état exact d'une
 * session audio (audio_session_id) — au-delà du seul état en mémoire tenu par
 * AudioStreamManager (qui reste la source de vérité pour la reprise immédiate d'un pipeline
 * en cours, cf. audioStreamManager.ts) — pour diagnostiquer/objectiver une coupure prolongée
 * et pour qu'un redémarrage de process ne laisse jamais une session android orpheline sans
 * trace côté serveur.
 */
export class AudioSessionStore {
  constructor() {
    getDb().exec(`
      CREATE TABLE IF NOT EXISTS audio_sessions (
        session_id TEXT PRIMARY KEY,
        workspace_id TEXT,
        state TEXT NOT NULL,
        turn_sequence INTEGER NOT NULL DEFAULT 0,
        transcript TEXT,
        response_text TEXT,
        tts_bytes_sent INTEGER NOT NULL DEFAULT 0,
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_audio_sessions_updated ON audio_sessions(updated_at);
    `);
  }

  getOrCreate(sessionId: string, workspaceId?: string): AudioSessionRecord {
    const db = getDb();
    const now = Date.now();
    db.prepare(`
      INSERT OR IGNORE INTO audio_sessions(session_id, workspace_id, state, turn_sequence, tts_bytes_sent, created_at, updated_at)
      VALUES (?, ?, 'LISTENING', 0, 0, ?, ?)
    `).run(sessionId, workspaceId ?? null, now, now);
    return this.get(sessionId)!;
  }

  get(sessionId: string): AudioSessionRecord | null {
    const row = getDb().prepare(`SELECT * FROM audio_sessions WHERE session_id=?`).get(sessionId);
    return row ? map(row) : null;
  }

  update(sessionId: string, patch: Partial<Pick<AudioSessionRecord, "state" | "transcript" | "responseText" | "ttsBytesSent" | "turnSequence">>): void {
    const current = this.get(sessionId);
    if (!current) return;
    const next = { ...current, ...patch };
    getDb()
      .prepare(`
        UPDATE audio_sessions
        SET state=?, transcript=?, response_text=?, tts_bytes_sent=?, turn_sequence=?, updated_at=?
        WHERE session_id=?
      `)
      .run(next.state, next.transcript ?? null, next.responseText ?? null, next.ttsBytesSent, next.turnSequence, Date.now(), sessionId);
  }

  /** Purge des sessions closes/expirées bien au-delà de la fenêtre de reconnexion — jamais LISTENING/THINKING/SPEAKING en cours. */
  cleanupStale(maxAgeMs: number, now = Date.now()): number {
    return getDb()
      .prepare(`DELETE FROM audio_sessions WHERE state IN ('DONE','DISCONNECTED') AND updated_at < ?`)
      .run(now - maxAgeMs).changes;
  }
}
