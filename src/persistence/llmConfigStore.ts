import { getDb } from "./db.js";
import type { LLMProviderName } from "../config.js";

export interface StoredLLMConfig {
  provider: LLMProviderName;
  model: string;
}

export function saveLLMConfig(provider: LLMProviderName, model: string): void {
  const db = getDb();
  const now = Date.now();
  db.prepare(`
    INSERT INTO user_preferences (key, value, updated_at)
    VALUES ('llm_active_provider', ?, ?)
    ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at
  `).run(provider, now);

  db.prepare(`
    INSERT INTO user_preferences (key, value, updated_at)
    VALUES ('llm_active_model', ?, ?)
    ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at
  `).run(model, now);
}

export function loadLLMConfig(): StoredLLMConfig | null {
  try {
    const db = getDb();
    const rowProv = db.prepare("SELECT value FROM user_preferences WHERE key = 'llm_active_provider'").get() as { value: string } | undefined;
    const rowModel = db.prepare("SELECT value FROM user_preferences WHERE key = 'llm_active_model'").get() as { value: string } | undefined;

    if (rowProv?.value && rowModel?.value) {
      return {
        provider: rowProv.value as LLMProviderName,
        model: rowModel.value,
      };
    }
  } catch {
    // If db not ready
  }
  return null;
}
