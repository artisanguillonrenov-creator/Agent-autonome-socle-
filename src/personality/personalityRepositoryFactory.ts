import { getDb, getPgPool } from "../persistence/db.js";
import type { IPersonalityRepository } from "./domain/personalityRepository.js";
import { PostgresPersonalityRepository } from "./postgresPersonalityRepository.js";
import { SqlitePersonalityRepository } from "./sqlitePersonalityRepository.js";

export function createPersonalityRepository(): IPersonalityRepository {
  const pool = getPgPool();
  if (pool) return new PostgresPersonalityRepository(pool);
  return new SqlitePersonalityRepository(getDb());
}
