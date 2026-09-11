import { getDb, getPgPool } from "../db.js";
import type { IConversationRepository } from "./conversationRepository.js";
import { PostgresConversationRepository } from "./postgresConversationRepository.js";
import { SqliteConversationRepository } from "./sqliteConversationRepository.js";

export function createConversationRepository(): IConversationRepository {
  const pool = getPgPool();
  return pool ? new PostgresConversationRepository(pool) : new SqliteConversationRepository(getDb());
}
