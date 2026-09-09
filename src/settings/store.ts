import crypto from "node:crypto";
import { getDb } from "../persistence/db.js";
import { config } from "../config.js";
import {
  SETTINGS_CATALOG,
  SettingDefinition,
  SettingLevel,
  SettingSection,
} from "./catalog.js";

export type SettingScopeType = "GLOBAL" | "SERVICE" | "PROJECT" | "TASK";
export type SettingSource = "DEFAULT" | "DATABASE" | "ENVIRONMENT" | "SYSTEM";

export interface EffectiveSetting {
  definition: SettingDefinition;
  value: unknown;
  effectiveValue: unknown;
  source: SettingSource;
  scopeType: SettingScopeType;
  scopeId: string;
}

export interface SettingsAuditRecord {
  id: string;
  timestamp: number;
  scopeType: SettingScopeType;
  scopeId: string;
  settingKey: string;
  oldValueJson: string | null;
  newValueJson: string;
}

export class SettingsStore {
  getDefinition(key: string): SettingDefinition | undefined {
    return SETTINGS_CATALOG.find((s) => s.key === key);
  }

  listDefinitions(level?: SettingLevel, section?: SettingSection): SettingDefinition[] {
    return SETTINGS_CATALOG.filter((s) => {
      if (section && s.section !== section) return false;
      if (level === "SIMPLE" && s.level !== "SIMPLE") return false;
      if (level === "ADVANCED" && s.level === "EXPERT") return false;
      return true;
    });
  }

  getEffectiveSetting(
    key: string,
    scopeType: SettingScopeType = "GLOBAL",
    scopeId: string = "global",
  ): EffectiveSetting {
    const def = this.getDefinition(key);
    if (!def) {
      throw new Error(`SETTINGS_KEY_UNKNOWN: ${key}`);
    }

    // SYSTEM LOCKED
    if (def.availability === "SYSTEM_LOCKED") {
      if (key === "autonomy.autoMergePr") {
        return {
          definition: def,
          value: false,
          effectiveValue: false,
          source: "SYSTEM",
          scopeType,
          scopeId,
        };
      }
      if (key === "intelligence.activeProvider") {
        return {
          definition: def,
          value: config.llm.provider,
          effectiveValue: config.llm.provider,
          source: process.env.LLM_PROVIDER ? "ENVIRONMENT" : "SYSTEM",
          scopeType,
          scopeId,
        };
      }
      if (key === "intelligence.activeModel") {
        return {
          definition: def,
          value: config.llm.model,
          effectiveValue: config.llm.model,
          source: process.env.LLM_MODEL ? "ENVIRONMENT" : "SYSTEM",
          scopeType,
          scopeId,
        };
      }
      if (key === "system.apiPort") {
        const envPort = process.env.PORT || process.env.API_PORT;
        return {
          definition: def,
          value: envPort ? Number(envPort) : def.defaultValue,
          effectiveValue: envPort ? Number(envPort) : def.defaultValue,
          source: envPort ? "ENVIRONMENT" : "SYSTEM",
          scopeType,
          scopeId,
        };
      }
    }

    // ENVIRONMENT OVERRIDES
    const envValue = this.resolveEnvOverride(key);
    let dbValue: unknown = undefined;

    const db = getDb();
    const row = db
      .prepare(
        "SELECT value_json FROM app_settings WHERE scope_type = ? AND scope_id = ? AND setting_key = ?",
      )
      .get(scopeType, scopeId, key) as { value_json: string } | undefined;

    if (row) {
      try {
        dbValue = JSON.parse(row.value_json);
      } catch {
        dbValue = undefined;
      }
    }

    if (envValue !== undefined) {
      return {
        definition: def,
        value: dbValue !== undefined ? dbValue : def.defaultValue,
        effectiveValue: envValue,
        source: "ENVIRONMENT",
        scopeType,
        scopeId,
      };
    }

    if (dbValue !== undefined) {
      return {
        definition: def,
        value: dbValue,
        effectiveValue: dbValue,
        source: "DATABASE",
        scopeType,
        scopeId,
      };
    }

    return {
      definition: def,
      value: def.defaultValue,
      effectiveValue: def.defaultValue,
      source: "DEFAULT",
      scopeType,
      scopeId,
    };
  }

  getAllEffectiveSettings(
    scopeType: SettingScopeType = "GLOBAL",
    scopeId: string = "global",
    level?: SettingLevel,
  ): EffectiveSetting[] {
    const defs = this.listDefinitions(level);
    return defs.map((d) => this.getEffectiveSetting(d.key, scopeType, scopeId));
  }

  setSetting(
    key: string,
    value: unknown,
    scopeType: SettingScopeType = "GLOBAL",
    scopeId: string = "global",
  ): EffectiveSetting {
    if (scopeType === "PROJECT" || scopeType === "TASK") {
      throw new Error("SETTINGS_SCOPE_NOT_AVAILABLE");
    }

    const def = this.getDefinition(key);
    if (!def) {
      throw new Error(`SETTINGS_KEY_UNKNOWN: ${key}`);
    }

    if (!def.editable || def.availability !== "AVAILABLE") {
      throw new Error(`SETTING_NOT_EDITABLE: ${key}`);
    }

    this.validateValue(def, value);

    const db = getDb();
    const current = db
      .prepare(
        "SELECT value_json FROM app_settings WHERE scope_type = ? AND scope_id = ? AND setting_key = ?",
      )
      .get(scopeType, scopeId, key) as { value_json: string } | undefined;

    const oldValueJson = current ? current.value_json : null;
    const newValueJson = JSON.stringify(value);

    db.transaction(() => {
      db.prepare(
        `INSERT INTO app_settings (scope_type, scope_id, setting_key, value_json, updated_at)
         VALUES (?, ?, ?, ?, ?)
         ON CONFLICT(scope_type, scope_id, setting_key) DO UPDATE SET
           value_json = excluded.value_json,
           updated_at = excluded.updated_at`,
      ).run(scopeType, scopeId, key, newValueJson, Date.now());

      db.prepare(
        `INSERT INTO settings_audit (id, timestamp, scope_type, scope_id, setting_key, old_value_json, new_value_json)
         VALUES (?, ?, ?, ?, ?, ?, ?)`,
      ).run(
        crypto.randomUUID(),
        Date.now(),
        scopeType,
        scopeId,
        key,
        oldValueJson,
        newValueJson,
      );
    })();

    return this.getEffectiveSetting(key, scopeType, scopeId);
  }

  resetSetting(
    key: string,
    scopeType: SettingScopeType = "GLOBAL",
    scopeId: string = "global",
  ): EffectiveSetting {
    if (scopeType === "PROJECT" || scopeType === "TASK") {
      throw new Error("SETTINGS_SCOPE_NOT_AVAILABLE");
    }

    const def = this.getDefinition(key);
    if (!def) {
      throw new Error(`SETTINGS_KEY_UNKNOWN: ${key}`);
    }

    const db = getDb();
    const current = db
      .prepare(
        "SELECT value_json FROM app_settings WHERE scope_type = ? AND scope_id = ? AND setting_key = ?",
      )
      .get(scopeType, scopeId, key) as { value_json: string } | undefined;

    if (current) {
      db.transaction(() => {
        db.prepare(
          "DELETE FROM app_settings WHERE scope_type = ? AND scope_id = ? AND setting_key = ?",
        ).run(scopeType, scopeId, key);

        db.prepare(
          `INSERT INTO settings_audit (id, timestamp, scope_type, scope_id, setting_key, old_value_json, new_value_json)
           VALUES (?, ?, ?, ?, ?, ?, ?)`,
        ).run(
          crypto.randomUUID(),
          Date.now(),
          scopeType,
          scopeId,
          key,
          current.value_json,
          JSON.stringify(def.defaultValue),
        );
      })();
    }

    return this.getEffectiveSetting(key, scopeType, scopeId);
  }

  resetAll(scopeType: SettingScopeType = "GLOBAL", scopeId: string = "global"): void {
    if (scopeType === "PROJECT" || scopeType === "TASK") {
      throw new Error("SETTINGS_SCOPE_NOT_AVAILABLE");
    }

    const db = getDb();
    db.transaction(() => {
      db.prepare("DELETE FROM app_settings WHERE scope_type = ? AND scope_id = ?").run(
        scopeType,
        scopeId,
      );
      db.prepare(
        `INSERT INTO settings_audit (id, timestamp, scope_type, scope_id, setting_key, old_value_json, new_value_json)
         VALUES (?, ?, ?, ?, ?, ?, ?)`,
      ).run(
        crypto.randomUUID(),
        Date.now(),
        scopeType,
        scopeId,
        "*",
        null,
        JSON.stringify("RESET_ALL"),
      );
    })();
  }

  listAuditLogs(limit = 100): SettingsAuditRecord[] {
    const db = getDb();
    const rows = db
      .prepare(
        "SELECT id, timestamp, scope_type, scope_id, setting_key, old_value_json, new_value_json FROM settings_audit ORDER BY timestamp DESC LIMIT ?",
      )
      .all(limit) as Array<{
      id: string;
      timestamp: number;
      scope_type: string;
      scope_id: string;
      setting_key: string;
      old_value_json: string | null;
      new_value_json: string;
    }>;

    return rows.map((r) => ({
      id: r.id,
      timestamp: r.timestamp,
      scopeType: r.scope_type as SettingScopeType,
      scopeId: r.scope_id,
      settingKey: r.setting_key,
      oldValueJson: r.old_value_json,
      newValueJson: r.new_value_json,
    }));
  }

  private validateValue(def: SettingDefinition, value: unknown): void {
    if (def.type === "boolean") {
      if (typeof value !== "boolean") throw new Error(`INVALID_SETTING_TYPE: expected boolean for ${def.key}`);
    } else if (def.type === "number") {
      if (typeof value !== "number" || !Number.isFinite(value))
        throw new Error(`INVALID_SETTING_TYPE: expected number for ${def.key}`);
      if (def.validation?.min !== undefined && value < def.validation.min)
        throw new Error(`SETTING_OUT_OF_RANGE: ${def.key} min is ${def.validation.min}`);
      if (def.validation?.max !== undefined && value > def.validation.max)
        throw new Error(`SETTING_OUT_OF_RANGE: ${def.key} max is ${def.validation.max}`);
    } else if (def.type === "string") {
      if (typeof value !== "string") throw new Error(`INVALID_SETTING_TYPE: expected string for ${def.key}`);
    } else if (def.type === "enum") {
      if (typeof value !== "string" || (def.validation?.enumValues && !def.validation.enumValues.includes(value))) {
        throw new Error(`INVALID_SETTING_ENUM: ${def.key} allowed values are ${def.validation?.enumValues?.join(", ")}`);
      }
    }
  }

  private resolveEnvOverride(key: string): unknown {
    switch (key) {
      case "intelligence.activeProvider":
        return process.env.LLM_PROVIDER || undefined;
      case "intelligence.activeModel":
        return process.env.LLM_MODEL || undefined;
      case "intelligence.skillSelectorMax":
        return process.env.SKILL_SELECTOR_MAX
          ? Number(process.env.SKILL_SELECTOR_MAX)
          : undefined;
      case "autonomy.maxIterations":
        return process.env.AGENT_MAX_ITERATIONS
          ? Number(process.env.AGENT_MAX_ITERATIONS)
          : undefined;
      case "skills.reflectionEveryNSteps":
        return process.env.REFLECTION_EVERY_N_STEPS
          ? Number(process.env.REFLECTION_EVERY_N_STEPS)
          : undefined;
      case "automations.backgroundMaxConcurrent":
        return process.env.BACKGROUND_MAX_CONCURRENT
          ? Number(process.env.BACKGROUND_MAX_CONCURRENT)
          : undefined;
      case "system.tokenBudget":
        return process.env.CONTEXT_TOKEN_BUDGET
          ? Number(process.env.CONTEXT_TOKEN_BUDGET)
          : undefined;
      default:
        return undefined;
    }
  }
}
