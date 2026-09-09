import { getDb } from "../persistence/db.js";
import type { RiskLevel } from "../orchestration/contract.js";
import type { ServiceAuth, ServiceTransport } from "../orchestration/serviceRegistry.js";

export interface ServiceConnectionRecord {
  serviceId: string;
  name: string;
  userCreated: boolean;
  enabledOverride?: boolean;
  transportOverride?: ServiceTransport;
  endpointOverride?: string;
  healthPath?: string;
  taskPath?: string;
  authTypeOverride?: "none" | "bearer_env";
  authEnvVar?: string;
  priorityOverride?: number;
  requestTimeoutMs?: number;
  healthTimeoutMs?: number;
  capabilitiesJson?: string;
  parallelSafeCapabilitiesJson?: string;
  riskByCapabilityJson?: string;
  lastTestAt?: number;
  lastSuccessAt?: number;
  lastLatencyMs?: number;
  lastError?: string;
  updatedAt: number;
}

export function hasConfigOverride(rec: ServiceConnectionRecord): boolean {
  return (
    rec.enabledOverride !== undefined ||
    rec.transportOverride !== undefined ||
    rec.endpointOverride !== undefined ||
    rec.healthPath !== undefined ||
    rec.taskPath !== undefined ||
    rec.authTypeOverride !== undefined ||
    rec.authEnvVar !== undefined ||
    rec.priorityOverride !== undefined ||
    rec.requestTimeoutMs !== undefined ||
    rec.healthTimeoutMs !== undefined ||
    rec.capabilitiesJson !== undefined ||
    rec.parallelSafeCapabilitiesJson !== undefined ||
    rec.riskByCapabilityJson !== undefined
  );
}

export class ConnectionStore {
  private inMemoryRecords = new Map<string, ServiceConnectionRecord>();

  constructor(private readonly inMemory = false) {}

  listOverrides(): ServiceConnectionRecord[] {
    if (this.inMemory) {
      return Array.from(this.inMemoryRecords.values());
    }
    const db = getDb();
    const rows = db.prepare("SELECT * FROM service_connections").all() as any[];
    return rows.map(this.rowToRecord);
  }

  getOverride(serviceId: string): ServiceConnectionRecord | null {
    if (this.inMemory) {
      return this.inMemoryRecords.get(serviceId) ?? null;
    }
    const db = getDb();
    const row = db.prepare("SELECT * FROM service_connections WHERE service_id = ?").get(serviceId) as any;
    return row ? this.rowToRecord(row) : null;
  }

  saveOverride(record: Partial<ServiceConnectionRecord> & { serviceId: string; updatedAt: number }): void {
    const existing = this.getOverride(record.serviceId);

    const merged: ServiceConnectionRecord = {
      serviceId: record.serviceId,
      name: record.name ?? existing?.name ?? record.serviceId,
      userCreated: record.userCreated !== undefined ? Boolean(record.userCreated) : existing?.userCreated ?? false,
      enabledOverride: record.enabledOverride !== undefined ? Boolean(record.enabledOverride) : existing?.enabledOverride,
      transportOverride: record.transportOverride ?? existing?.transportOverride,
      endpointOverride: record.endpointOverride ?? existing?.endpointOverride,
      healthPath: record.healthPath ?? existing?.healthPath,
      taskPath: record.taskPath ?? existing?.taskPath,
      authTypeOverride: record.authTypeOverride ?? existing?.authTypeOverride,
      authEnvVar: record.authEnvVar ?? existing?.authEnvVar,
      priorityOverride: record.priorityOverride !== undefined ? record.priorityOverride : existing?.priorityOverride,
      requestTimeoutMs: record.requestTimeoutMs !== undefined ? record.requestTimeoutMs : existing?.requestTimeoutMs,
      healthTimeoutMs: record.healthTimeoutMs !== undefined ? record.healthTimeoutMs : existing?.healthTimeoutMs,
      capabilitiesJson: record.capabilitiesJson ?? existing?.capabilitiesJson,
      parallelSafeCapabilitiesJson: record.parallelSafeCapabilitiesJson ?? existing?.parallelSafeCapabilitiesJson,
      riskByCapabilityJson: record.riskByCapabilityJson ?? existing?.riskByCapabilityJson,
      lastTestAt: record.lastTestAt !== undefined ? record.lastTestAt : existing?.lastTestAt,
      lastSuccessAt: record.lastSuccessAt !== undefined ? record.lastSuccessAt : existing?.lastSuccessAt,
      lastLatencyMs: record.lastLatencyMs !== undefined ? record.lastLatencyMs : existing?.lastLatencyMs,
      lastError: record.lastError !== undefined ? record.lastError : existing?.lastError,
      updatedAt: record.updatedAt,
    };

    if (this.inMemory) {
      this.inMemoryRecords.set(record.serviceId, merged);
      return;
    }

    const db = getDb();
    db.prepare(`
      INSERT INTO service_connections (
        service_id, name, user_created, enabled_override, transport_override, endpoint_override,
        health_path, task_path, auth_type_override, auth_env_var, priority_override,
        request_timeout_ms, health_timeout_ms, capabilities_json, parallel_safe_capabilities_json,
        risk_by_capability_json, last_test_at, last_success_at, last_latency_ms, last_error, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(service_id) DO UPDATE SET
        name = excluded.name,
        user_created = excluded.user_created,
        enabled_override = excluded.enabled_override,
        transport_override = excluded.transport_override,
        endpoint_override = excluded.endpoint_override,
        health_path = excluded.health_path,
        task_path = excluded.task_path,
        auth_type_override = excluded.auth_type_override,
        auth_env_var = excluded.auth_env_var,
        priority_override = excluded.priority_override,
        request_timeout_ms = excluded.request_timeout_ms,
        health_timeout_ms = excluded.health_timeout_ms,
        capabilities_json = excluded.capabilities_json,
        parallel_safe_capabilities_json = excluded.parallel_safe_capabilities_json,
        risk_by_capability_json = excluded.risk_by_capability_json,
        last_test_at = excluded.last_test_at,
        last_success_at = excluded.last_success_at,
        last_latency_ms = excluded.last_latency_ms,
        last_error = excluded.last_error,
        updated_at = excluded.updated_at
    `).run(
      merged.serviceId,
      merged.name,
      merged.userCreated ? 1 : 0,
      merged.enabledOverride !== undefined ? (merged.enabledOverride ? 1 : 0) : null,
      merged.transportOverride ?? null,
      merged.endpointOverride ?? null,
      merged.healthPath ?? null,
      merged.taskPath ?? null,
      merged.authTypeOverride ?? null,
      merged.authEnvVar ?? null,
      merged.priorityOverride ?? null,
      merged.requestTimeoutMs ?? null,
      merged.healthTimeoutMs ?? null,
      merged.capabilitiesJson ?? null,
      merged.parallelSafeCapabilitiesJson ?? null,
      merged.riskByCapabilityJson ?? null,
      merged.lastTestAt ?? null,
      merged.lastSuccessAt ?? null,
      merged.lastLatencyMs ?? null,
      merged.lastError ?? null,
      merged.updatedAt,
    );
  }

  patchOverride(serviceId: string, patch: Partial<ServiceConnectionRecord>): void {
    const existing = this.getOverride(serviceId);
    const now = Date.now();

    const merged: ServiceConnectionRecord = {
      serviceId,
      name: patch.name !== undefined ? patch.name : existing?.name ?? serviceId,
      userCreated: existing?.userCreated ?? false,
      enabledOverride: patch.enabledOverride !== undefined ? patch.enabledOverride : existing?.enabledOverride,
      transportOverride: patch.transportOverride !== undefined ? patch.transportOverride : existing?.transportOverride,
      endpointOverride: patch.endpointOverride !== undefined ? patch.endpointOverride : existing?.endpointOverride,
      healthPath: patch.healthPath !== undefined ? patch.healthPath : existing?.healthPath,
      taskPath: patch.taskPath !== undefined ? patch.taskPath : existing?.taskPath,
      authTypeOverride: patch.authTypeOverride !== undefined ? patch.authTypeOverride : existing?.authTypeOverride,
      authEnvVar: patch.authEnvVar !== undefined ? patch.authEnvVar : existing?.authEnvVar,
      priorityOverride: patch.priorityOverride !== undefined ? patch.priorityOverride : existing?.priorityOverride,
      requestTimeoutMs: patch.requestTimeoutMs !== undefined ? patch.requestTimeoutMs : existing?.requestTimeoutMs,
      healthTimeoutMs: patch.healthTimeoutMs !== undefined ? patch.healthTimeoutMs : existing?.healthTimeoutMs,
      capabilitiesJson: patch.capabilitiesJson !== undefined ? patch.capabilitiesJson : existing?.capabilitiesJson,
      parallelSafeCapabilitiesJson: patch.parallelSafeCapabilitiesJson !== undefined ? patch.parallelSafeCapabilitiesJson : existing?.parallelSafeCapabilitiesJson,
      riskByCapabilityJson: patch.riskByCapabilityJson !== undefined ? patch.riskByCapabilityJson : existing?.riskByCapabilityJson,
      lastTestAt: existing?.lastTestAt,
      lastSuccessAt: existing?.lastSuccessAt,
      lastLatencyMs: existing?.lastLatencyMs,
      lastError: existing?.lastError,
      updatedAt: now,
    };

    if (this.inMemory) {
      this.inMemoryRecords.set(serviceId, merged);
      return;
    }

    const db = getDb();
    db.prepare(`
      INSERT INTO service_connections (
        service_id, name, user_created, enabled_override, transport_override, endpoint_override,
        health_path, task_path, auth_type_override, auth_env_var, priority_override,
        request_timeout_ms, health_timeout_ms, capabilities_json, parallel_safe_capabilities_json,
        risk_by_capability_json, last_test_at, last_success_at, last_latency_ms, last_error, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(service_id) DO UPDATE SET
        name = excluded.name,
        user_created = excluded.user_created,
        enabled_override = excluded.enabled_override,
        transport_override = excluded.transport_override,
        endpoint_override = excluded.endpoint_override,
        health_path = excluded.health_path,
        task_path = excluded.task_path,
        auth_type_override = excluded.auth_type_override,
        auth_env_var = excluded.auth_env_var,
        priority_override = excluded.priority_override,
        request_timeout_ms = excluded.request_timeout_ms,
        health_timeout_ms = excluded.health_timeout_ms,
        capabilities_json = excluded.capabilities_json,
        parallel_safe_capabilities_json = excluded.parallel_safe_capabilities_json,
        risk_by_capability_json = excluded.risk_by_capability_json,
        updated_at = excluded.updated_at
    `).run(
      merged.serviceId,
      merged.name,
      merged.userCreated ? 1 : 0,
      merged.enabledOverride !== undefined ? (merged.enabledOverride ? 1 : 0) : null,
      merged.transportOverride ?? null,
      merged.endpointOverride ?? null,
      merged.healthPath ?? null,
      merged.taskPath ?? null,
      merged.authTypeOverride ?? null,
      merged.authEnvVar ?? null,
      merged.priorityOverride ?? null,
      merged.requestTimeoutMs ?? null,
      merged.healthTimeoutMs ?? null,
      merged.capabilitiesJson ?? null,
      merged.parallelSafeCapabilitiesJson ?? null,
      merged.riskByCapabilityJson ?? null,
      merged.lastTestAt ?? null,
      merged.lastSuccessAt ?? null,
      merged.lastLatencyMs ?? null,
      merged.lastError ?? null,
      merged.updatedAt,
    );
  }

  recordDiagnostic(
    serviceId: string,
    result: { reachable: boolean; latencyMs?: number; error?: string },
  ): void {
    const now = Date.now();
    const existing = this.getOverride(serviceId);
    this.saveOverride({
      serviceId,
      name: existing?.name ?? serviceId,
      userCreated: existing?.userCreated ?? false,
      lastTestAt: now,
      lastSuccessAt: result.reachable ? now : existing?.lastSuccessAt,
      lastLatencyMs: result.reachable ? result.latencyMs ?? 0 : existing?.lastLatencyMs,
      lastError: result.reachable ? null as any : result.error ?? "HEALTH_CHECK_FAILED",
      updatedAt: now,
    });
  }

  deleteOverride(serviceId: string): void {
    if (this.inMemory) {
      this.inMemoryRecords.delete(serviceId);
      return;
    }
    const db = getDb();
    db.prepare("DELETE FROM service_connections WHERE service_id = ?").run(serviceId);
  }

  checkActiveOperations(serviceId: string): string[] {
    if (this.inMemory) {
      return [];
    }
    const db = getDb();
    const activeStatuses = [
      "QUEUED",
      "DISPATCHING",
      "RUNNING",
      "WAITING_INPUT",
      "WAITING_PERMISSION",
    ];
    try {
      const rows = db
        .prepare(
          `SELECT task_id FROM service_operations WHERE selected_service = ? AND status IN (${activeStatuses.map(() => "?").join(",")})`,
        )
        .all(serviceId, ...activeStatuses) as Array<{ task_id: string }>;

      return rows.map((r) => r.task_id);
    } catch {
      return [];
    }
  }

  private rowToRecord(row: any): ServiceConnectionRecord {
    return {
      serviceId: row.service_id,
      name: row.name,
      userCreated: Boolean(row.user_created),
      enabledOverride: row.enabled_override !== null ? Boolean(row.enabled_override) : undefined,
      transportOverride: row.transport_override || undefined,
      endpointOverride: row.endpoint_override || undefined,
      healthPath: row.health_path || undefined,
      taskPath: row.task_path || undefined,
      authTypeOverride: row.auth_type_override || undefined,
      authEnvVar: row.auth_env_var || undefined,
      priorityOverride: row.priority_override !== null ? Number(row.priority_override) : undefined,
      requestTimeoutMs: row.request_timeout_ms !== null ? Number(row.request_timeout_ms) : undefined,
      healthTimeoutMs: row.health_timeout_ms !== null ? Number(row.health_timeout_ms) : undefined,
      capabilitiesJson: row.capabilities_json || undefined,
      parallelSafeCapabilitiesJson: row.parallel_safe_capabilities_json || undefined,
      riskByCapabilityJson: row.risk_by_capability_json || undefined,
      lastTestAt: row.last_test_at !== null ? Number(row.last_test_at) : undefined,
      lastSuccessAt: row.last_success_at !== null ? Number(row.last_success_at) : undefined,
      lastLatencyMs: row.last_latency_ms !== null ? Number(row.last_latency_ms) : undefined,
      lastError: row.last_error || undefined,
      updatedAt: Number(row.updated_at),
    };
  }
}
