import { readFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import type { RiskLevel } from "./contract.js";
import { ConnectionStore } from "../connections/store.js";
import { canonicalSkillCatalog } from "../skills/catalog.js";

export type ServiceTransport = "local" | "task_http";
export type ServiceAuth = { type: "none" } | { type: "bearer_env"; envVar: string };

export interface ServiceDefinition {
  id: string;
  name: string;
  description?: string;
  enabled: boolean;
  userCreated?: boolean;
  transport: ServiceTransport;
  endpoint: string;
  healthPath?: string;
  taskPath?: string;
  capabilities: string[];
  parallelSafeCapabilities?: string[];
  priority: number;
  riskByCapability?: Record<string, RiskLevel>;
  auth: ServiceAuth;
  requestTimeoutMs?: number;
  healthTimeoutMs?: number;
  source?: "FACTORY" | "DATABASE" | "ENVIRONMENT";
}

const risks = new Set(["LOW", "MEDIUM", "HIGH", "CRITICAL"]);

export function riskForCapability(s: ServiceDefinition, c: string): RiskLevel | null {
  const r = s.riskByCapability?.[c] ?? "LOW";
  return risks.has(r) ? (r as RiskLevel) : null;
}

export function validateServiceDefinition(raw: unknown, strict = false): ServiceDefinition {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) throw new Error("service must be an object");
  const r = raw as any;
  const transport = r.transport ?? (["local", "direct", "in-process"].includes(r.endpoint) ? "local" : "task_http");
  const auth = r.auth ?? (r.id === "software_factory" ? { type: "bearer_env", envVar: "SOFTWARE_FACTORY_TOKEN" } : { type: "none" });

  if (
    typeof r.id !== "string" ||
    !r.id.trim() ||
    typeof r.name !== "string" ||
    !r.name.trim() ||
    typeof r.enabled !== "boolean" ||
    !Array.isArray(r.capabilities) ||
    !r.capabilities.length ||
    !r.capabilities.every((x: unknown) => typeof x === "string" && !!x.trim()) ||
    !Number.isFinite(r.priority) ||
    r.priority < 0 ||
    r.priority > 100 ||
    !["local", "task_http"].includes(transport)
  ) {
    throw new Error("invalid required fields");
  }

  // Validate capabilities against known catalog for user-created service connections (Requirement 19)
  if (r.userCreated) {
    const knownCapabilities = new Set(canonicalSkillCatalog.map((s) => s.serviceCapability).filter(Boolean));
    ["software_development", "code_generation", "file_management", "deep_research"].forEach((c) => knownCapabilities.add(c));
    for (const cap of r.capabilities) {
      if (!knownCapabilities.has(cap)) {
        throw new Error(`CONNECTION_CAPABILITY_UNKNOWN: ${cap}`);
      }
    }
  }

  const parallelSafeCapabilities = r.parallelSafeCapabilities ?? [];
  if (
    !Array.isArray(parallelSafeCapabilities) ||
    !parallelSafeCapabilities.every((x: unknown) => typeof x === "string" && !!x.trim() && r.capabilities.includes(x))
  ) {
    throw new Error("invalid parallel safe capabilities");
  }

  if (r.riskByCapability !== undefined && (typeof r.riskByCapability !== "object" || (strict && Object.values(r.riskByCapability).some((x) => !risks.has(x as string))))) {
    throw new Error("invalid risks");
  }

  if (transport === "local" && typeof r.endpoint !== "string") r.endpoint = r.id;

  if (transport === "task_http") {
    let u: URL;
    try {
      u = new URL(r.endpoint);
    } catch {
      throw new Error("invalid endpoint");
    }
    if (!["http:", "https:"].includes(u.protocol)) throw new Error("invalid endpoint protocol");
  }

  const healthPath = r.healthPath ?? "/health";
  const taskPath = r.taskPath ?? "/tasks";
  if (!healthPath.startsWith("/") || healthPath.includes("..") || healthPath.includes("://")) {
    throw new Error("invalid healthPath");
  }
  if (!taskPath.startsWith("/") || taskPath.includes("..") || taskPath.includes("://")) {
    throw new Error("invalid taskPath");
  }

  if (!auth || !["none", "bearer_env"].includes(auth.type) || (auth.type === "bearer_env" && (typeof auth.envVar !== "string" || !auth.envVar.trim() || !/^[A-Z][A-Z0-9_]*$/.test(auth.envVar)))) {
    throw new Error("invalid auth");
  }

  const requestTimeoutMs = r.requestTimeoutMs ?? 120000;
  const healthTimeoutMs = r.healthTimeoutMs ?? 5000;
  if (!Number.isFinite(requestTimeoutMs) || requestTimeoutMs < 1000 || requestTimeoutMs > 600000) {
    throw new Error("invalid requestTimeoutMs");
  }
  if (!Number.isFinite(healthTimeoutMs) || healthTimeoutMs < 500 || healthTimeoutMs > 60000) {
    throw new Error("invalid healthTimeoutMs");
  }

  return {
    ...r,
    id: r.id.trim(),
    name: r.name.trim(),
    description: typeof r.description === "string" ? r.description.trim() : undefined,
    userCreated: Boolean(r.userCreated),
    transport,
    healthPath,
    taskPath,
    requestTimeoutMs,
    healthTimeoutMs,
    auth,
    parallelSafeCapabilities: [...new Set(parallelSafeCapabilities)],
  };
}

export function resolveServiceEndpoint(s: ServiceDefinition): ServiceDefinition {
  let endpoint = s.endpoint;
  let source: "FACTORY" | "DATABASE" | "ENVIRONMENT" = s.source ?? "FACTORY";

  if (s.id === "software_factory") {
    if (process.env.SOFTWARE_FACTORY_URL) {
      endpoint = process.env.SOFTWARE_FACTORY_URL;
      source = "ENVIRONMENT";
    } else if (endpoint === "http://localhost:4000" && (process.env.PORT || process.env.API_PORT)) {
      endpoint = `http://localhost:${process.env.PORT || process.env.API_PORT}`;
    }
  }

  if (process.env.PORT) endpoint = endpoint.replace("${PORT}", process.env.PORT);
  const transport = s.id === "software_factory" && ["local", "direct", "in-process"].includes(endpoint) ? "local" : s.transport;

  return { ...s, endpoint, transport, source };
}

export class ServiceRegistry {
  private factoryServices: ServiceDefinition[] = [];
  readonly connectionStore: ConnectionStore;
  readonly diagnostics: string[] = [];

  constructor(path?: string, customConnectionStore?: ConnectionStore) {
    const defaultPath = join(process.cwd(), "config/services.json");
    const p = path || defaultPath;
    const isCustomPath = Boolean(path && path !== defaultPath);

    this.connectionStore = customConnectionStore || new ConnectionStore(isCustomPath);

    if (existsSync(p)) {
      try {
        const parsed = JSON.parse(readFileSync(p, "utf8"));
        if (!Array.isArray(parsed)) throw new Error("root must be array");
        for (const raw of parsed) {
          try {
            const def = validateServiceDefinition(raw, true);
            def.source = "FACTORY";
            this.factoryServices.push(def);
          } catch (e) {
            this.diagnostics.push(`Invalid service ${(raw as any)?.id ?? "unknown"}: ${(e as Error).message}`);
          }
        }
      } catch (e) {
        this.diagnostics.push(`Invalid registry: ${(e as Error).message}`);
      }
    }
  }

  register(raw: ServiceDefinition): void {
    const s = validateServiceDefinition(raw);
    const existing = this.getServiceById(s.id);

    if (existing) {
      // Check if immutable connection fields changed
      const endpointChanged = existing.endpoint !== s.endpoint;
      const transportChanged = existing.transport !== s.transport;
      const priorityChanged = existing.priority !== s.priority;
      const authChanged = JSON.stringify(existing.auth) !== JSON.stringify(s.auth);
      const capsChanged = JSON.stringify(existing.capabilities) !== JSON.stringify(s.capabilities);
      const risksChanged = JSON.stringify(existing.riskByCapability ?? {}) !== JSON.stringify(s.riskByCapability ?? {});

      if (endpointChanged || transportChanged || priorityChanged || authChanged || capsChanged || risksChanged) {
        const activeOps = this.connectionStore.checkActiveOperations(s.id);
        if (activeOps.length > 0) {
          const err = new Error("SERVICE_CONNECTION_IN_USE");
          (err as any).taskIds = activeOps;
          throw err;
        }
      }
    }

    const existingFactory = this.factoryServices.find((x) => x.id === s.id);

    this.connectionStore.saveOverride({
      serviceId: s.id,
      name: s.name,
      userCreated: !existingFactory,
      enabledOverride: s.enabled,
      transportOverride: s.transport,
      endpointOverride: s.endpoint,
      healthPath: s.healthPath,
      taskPath: s.taskPath,
      authTypeOverride: s.auth.type,
      authEnvVar: s.auth.type === "bearer_env" ? s.auth.envVar : undefined,
      priorityOverride: s.priority,
      requestTimeoutMs: s.requestTimeoutMs,
      healthTimeoutMs: s.healthTimeoutMs,
      capabilitiesJson: JSON.stringify(s.capabilities),
      parallelSafeCapabilitiesJson: JSON.stringify(s.parallelSafeCapabilities ?? []),
      riskByCapabilityJson: JSON.stringify(s.riskByCapability ?? {}),
      updatedAt: Date.now(),
    });
  }

  patchService(id: string, patch: Partial<ServiceDefinition>): void {
    const existing = this.getServiceById(id);
    if (!existing) {
      throw new Error(`SERVICE_NOT_FOUND: ${id}`);
    }

    const endpointChanged = patch.endpoint !== undefined && patch.endpoint !== existing.endpoint;
    const transportChanged = patch.transport !== undefined && patch.transport !== existing.transport;
    const priorityChanged = patch.priority !== undefined && patch.priority !== existing.priority;
    const authChanged = patch.auth !== undefined && JSON.stringify(patch.auth) !== JSON.stringify(existing.auth);
    const capsChanged = patch.capabilities !== undefined && JSON.stringify(patch.capabilities) !== JSON.stringify(existing.capabilities);
    const risksChanged = patch.riskByCapability !== undefined && JSON.stringify(patch.riskByCapability) !== JSON.stringify(existing.riskByCapability);

    if (endpointChanged || transportChanged || priorityChanged || authChanged || capsChanged || risksChanged) {
      const activeOps = this.connectionStore.checkActiveOperations(id);
      if (activeOps.length > 0) {
        const err = new Error("SERVICE_CONNECTION_IN_USE");
        (err as any).taskIds = activeOps;
        throw err;
      }
    }

    const patchRecord: any = {};
    if (patch.name !== undefined) patchRecord.name = patch.name;
    if (patch.enabled !== undefined) patchRecord.enabledOverride = patch.enabled;
    if (patch.transport !== undefined) patchRecord.transportOverride = patch.transport;
    if (patch.endpoint !== undefined) patchRecord.endpointOverride = patch.endpoint;
    if (patch.healthPath !== undefined) patchRecord.healthPath = patch.healthPath;
    if (patch.taskPath !== undefined) patchRecord.taskPath = patch.taskPath;
    if (patch.priority !== undefined) patchRecord.priorityOverride = patch.priority;
    if (patch.requestTimeoutMs !== undefined) patchRecord.requestTimeoutMs = patch.requestTimeoutMs;
    if (patch.healthTimeoutMs !== undefined) patchRecord.healthTimeoutMs = patch.healthTimeoutMs;
    if (patch.auth !== undefined) {
      patchRecord.authTypeOverride = patch.auth.type;
      patchRecord.authEnvVar = patch.auth.type === "bearer_env" ? patch.auth.envVar : undefined;
    }
    if (patch.capabilities !== undefined) patchRecord.capabilitiesJson = JSON.stringify(patch.capabilities);
    if (patch.parallelSafeCapabilities !== undefined) patchRecord.parallelSafeCapabilitiesJson = JSON.stringify(patch.parallelSafeCapabilities);
    if (patch.riskByCapability !== undefined) patchRecord.riskByCapabilityJson = JSON.stringify(patch.riskByCapability);

    this.connectionStore.patchOverride(id, patchRecord);
  }

  deleteService(id: string): void {
    const isFactory = this.factoryServices.some((x) => x.id === id);
    if (isFactory) {
      const err = new Error("FACTORY_SERVICE_CANNOT_BE_DELETED");
      (err as any).status = 405;
      throw err;
    }

    const activeOps = this.connectionStore.checkActiveOperations(id);
    if (activeOps.length > 0) {
      const err = new Error("SERVICE_CONNECTION_IN_USE");
      (err as any).taskIds = activeOps;
      throw err;
    }

    this.connectionStore.deleteOverride(id);
  }

  resetFactoryOverride(id: string): ServiceDefinition {
    const factoryDef = this.factoryServices.find((x) => x.id === id);
    if (!factoryDef) {
      throw new Error(`FACTORY_SERVICE_NOT_FOUND: ${id}`);
    }

    const activeOps = this.connectionStore.checkActiveOperations(id);
    if (activeOps.length > 0) {
      const err = new Error("SERVICE_CONNECTION_IN_USE");
      (err as any).taskIds = activeOps;
      throw err;
    }

    this.connectionStore.deleteOverride(id);
    return resolveServiceEndpoint(factoryDef);
  }

  findServiceForCapability(c: string): ServiceDefinition | null {
    return (
      this.listServices()
        .filter((s) => s.enabled && s.capabilities.includes(c))
        .sort((a, b) => b.priority - a.priority)[0] ?? null
    );
  }

  getServiceById(id: string): ServiceDefinition | null {
    return this.listServices().find((x) => x.id === id) ?? null;
  }

  listServices(): ServiceDefinition[] {
    const overrides = this.connectionStore.listOverrides();
    const result: ServiceDefinition[] = [];

    // Process Factory Services with Overrides
    for (const factoryDef of this.factoryServices) {
      const ov = overrides.find((o) => o.serviceId === factoryDef.id);
      if (!ov) {
        result.push(resolveServiceEndpoint(factoryDef));
      } else {
        const merged: ServiceDefinition = {
          ...factoryDef,
          name: ov.name || factoryDef.name,
          enabled: ov.enabledOverride !== undefined ? ov.enabledOverride : factoryDef.enabled,
          transport: ov.transportOverride || factoryDef.transport,
          endpoint: ov.endpointOverride || factoryDef.endpoint,
          healthPath: ov.healthPath || factoryDef.healthPath || "/health",
          taskPath: ov.taskPath || factoryDef.taskPath || "/tasks",
          priority: ov.priorityOverride !== undefined ? ov.priorityOverride : factoryDef.priority,
          requestTimeoutMs: ov.requestTimeoutMs ?? factoryDef.requestTimeoutMs ?? 120000,
          healthTimeoutMs: ov.healthTimeoutMs ?? factoryDef.healthTimeoutMs ?? 5000,
          auth:
            ov.authTypeOverride === "bearer_env"
              ? { type: "bearer_env", envVar: ov.authEnvVar || (factoryDef.auth.type === "bearer_env" ? factoryDef.auth.envVar : "API_TOKEN") }
              : ov.authTypeOverride === "none"
              ? { type: "none" }
              : factoryDef.auth,
          capabilities: ov.capabilitiesJson ? JSON.parse(ov.capabilitiesJson) : factoryDef.capabilities,
          parallelSafeCapabilities: ov.parallelSafeCapabilitiesJson ? JSON.parse(ov.parallelSafeCapabilitiesJson) : factoryDef.parallelSafeCapabilities,
          riskByCapability: ov.riskByCapabilityJson ? JSON.parse(ov.riskByCapabilityJson) : factoryDef.riskByCapability,
          source: "DATABASE",
        };
        result.push(resolveServiceEndpoint(merged));
      }
    }

    // Process User-Created Services
    for (const ov of overrides) {
      if (this.factoryServices.some((x) => x.id === ov.serviceId)) continue;
      const userDef: ServiceDefinition = {
        id: ov.serviceId,
        name: ov.name,
        userCreated: true,
        enabled: ov.enabledOverride ?? true,
        transport: ov.transportOverride ?? "task_http",
        endpoint: ov.endpointOverride ?? "http://localhost:3000",
        healthPath: ov.healthPath ?? "/health",
        taskPath: ov.taskPath ?? "/tasks",
        priority: ov.priorityOverride ?? 10,
        requestTimeoutMs: ov.requestTimeoutMs ?? 120000,
        healthTimeoutMs: ov.healthTimeoutMs ?? 5000,
        auth: ov.authTypeOverride === "bearer_env" ? { type: "bearer_env", envVar: ov.authEnvVar || "API_TOKEN" } : { type: "none" },
        capabilities: ov.capabilitiesJson ? JSON.parse(ov.capabilitiesJson) : [],
        parallelSafeCapabilities: ov.parallelSafeCapabilitiesJson ? JSON.parse(ov.parallelSafeCapabilitiesJson) : [],
        riskByCapability: ov.riskByCapabilityJson ? JSON.parse(ov.riskByCapabilityJson) : {},
        source: "DATABASE",
      };
      result.push(resolveServiceEndpoint(userDef));
    }

    return result;
  }
}
