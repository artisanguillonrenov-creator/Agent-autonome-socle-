import { getDb } from "../persistence/db.js";
import type { UserPreference } from "../types.js";

interface PrefRow {
  key: string;
  value: string;
  updated_at: number;
}

/** Brique 2d : préférences/habitudes de l'utilisateur, affinées dans la durée. */
export class UserModel {
  set(key: string, value: string): void {
    getDb()
      .prepare(
        `INSERT INTO user_preferences (key, value, updated_at) VALUES (?, ?, ?)
         ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at`,
      )
      .run(key, value, Date.now());
  }

  get(key: string): string | null {
    const row = getDb().prepare(`SELECT value FROM user_preferences WHERE key = ?`).get(key) as
      | { value: string }
      | undefined;
    return row?.value ?? null;
  }

  all(): UserPreference[] {
    const rows = getDb().prepare(`SELECT * FROM user_preferences`).all() as PrefRow[];
    return rows.map((r) => ({ key: r.key, value: r.value, updatedAt: r.updated_at }));
  }
}
