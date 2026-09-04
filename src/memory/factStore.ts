import { getDb } from "../persistence/db.js";
import type { Fact } from "../types.js";

interface FactRow {
  entity: string;
  attribute: string;
  value: string;
  updated_at: number;
}

/**
 * Brique 2c : base structurée de faits/entités — "ce qu'on sait", pas juste
 * ce qui a été dit. Clé (entité, attribut) -> valeur, écrasée à la dernière mise à jour.
 */
export class FactStore {
  set(entity: string, attribute: string, value: string): void {
    getDb()
      .prepare(
        `INSERT INTO facts (entity, attribute, value, updated_at) VALUES (?, ?, ?, ?)
         ON CONFLICT(entity, attribute) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at`,
      )
      .run(entity, attribute, value, Date.now());
  }

  get(entity: string, attribute: string): string | null {
    const row = getDb()
      .prepare(`SELECT value FROM facts WHERE entity = ? AND attribute = ?`)
      .get(entity, attribute) as { value: string } | undefined;
    return row?.value ?? null;
  }

  forEntity(entity: string): Fact[] {
    const rows = getDb().prepare(`SELECT * FROM facts WHERE entity = ?`).all(entity) as FactRow[];
    return rows.map((r) => ({ entity: r.entity, attribute: r.attribute, value: r.value, updatedAt: r.updated_at }));
  }

  all(): Fact[] {
    const rows = getDb().prepare(`SELECT * FROM facts`).all() as FactRow[];
    return rows.map((r) => ({ entity: r.entity, attribute: r.attribute, value: r.value, updatedAt: r.updated_at }));
  }
}
