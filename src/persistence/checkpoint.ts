import { randomUUID } from "node:crypto";
import { getDb } from "./db.js";
import type { ChatMessage, PlanNode } from "../types.js";

export interface CheckpointState {
  workingMemory: ChatMessage[];
  planNodes: PlanNode[];
  stepCount: number;
}

export interface CheckpointSummary {
  id: string;
  label: string;
  createdAt: number;
}

/**
 * Brique 9 : l'état complet (mémoire de travail, plan en cours, position) est
 * sauvegardé à la demande. Restaurer un checkpoint remet l'agent exactement
 * où il en était — y compris pour bifurquer vers une autre branche d'exploration
 * sans perdre l'état courant (le checkpoint d'origine reste intact).
 */
export function saveCheckpoint(label: string, state: CheckpointState): string {
  const db = getDb();
  const id = randomUUID();
  db.prepare(
    `INSERT INTO checkpoints (id, label, created_at, state) VALUES (?, ?, ?, ?)`,
  ).run(id, label, Date.now(), JSON.stringify(state));
  return id;
}

export function loadCheckpoint(id: string): CheckpointState | null {
  const db = getDb();
  const row = db.prepare(`SELECT state FROM checkpoints WHERE id = ?`).get(id) as
    | { state: string }
    | undefined;
  return row ? (JSON.parse(row.state) as CheckpointState) : null;
}

export function listCheckpoints(): CheckpointSummary[] {
  const db = getDb();
  return db
    .prepare(`SELECT id, label, created_at as createdAt FROM checkpoints ORDER BY created_at DESC`)
    .all() as CheckpointSummary[];
}
