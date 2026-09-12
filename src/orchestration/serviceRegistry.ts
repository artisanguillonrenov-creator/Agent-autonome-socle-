import { readFileSync, existsSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { RiskLevel } from "./contract.js";
import { ConnectionStore, hasConfigOverride } from "../connections/store.js";
import { canonicalSkillCatalog } from "../skills/catalog.js";
import { config, type LLMProviderName } from "../config.js";

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
  /** Chantier 8 (autonomy.permissionMatrix) : permission explicite par capacité — sinon dérivée du risque (voir riskPolicy.ts). */
  permissionByCapability?: Record<string, string>;
  auth: ServiceAuth;
  requestTimeoutMs?: number;
  healthTimeoutMs?: number;
  source?: "FACTORY" | "DATABASE" | "ENVIRONMENT";
  /**
   * Bureaux métier (product_studio/creative_studio/commercial_office/marketing_office) :
   * fournisseur/modèle LLM dédiés à ce service, stockés directement dans config/services.json.
   * Absents = le bureau retombe sur le provider/modèle global actif de Jarvis (config.llm.*),
   * qui partage déjà les mêmes clés d'API/connecteurs globales — voir bureauContract.officeLlm.
   */
  provider?: LLMProviderName;
  model?: string;
}

const risks = new Set(["LOW", "MEDIUM", "HIGH", "CRITICAL"]);
const permissions = new Set(["READ", "WRITE", "DELETE", "EXECUTE", "SEND", "PURCHASE", "COMPUTER_CONTROL"]);
const llmProviderNames = new Set<string>(["anthropic", "openai", "openrouter", "ollama", "infermatic", "mock"]);

/** Les seuls services pour lesquels un provider/modèle LLM par bureau a du sens (Chantier "Bureaux métier"). */
export const BUREAU_SERVICE_IDS = ["product_studio", "creative_studio", "commercial_office", "marketing_office"] as const;
export type BureauServiceId = (typeof BUREAU_SERVICE_IDS)[number];

export function riskForCapability(s: ServiceDefinition, c: string): RiskLevel | null {
  const r = s.riskByCapability?.[c] ?? "LOW";
  return risks.has(r) ? (r as RiskLevel) : null;
}

export function getKnownCapabilities(): Set<string> {
  const set = new Set<string>();
  canonicalSkillCatalog.forEach((s) => {
    if (s.serviceCapability) set.add(s.serviceCapability);
  });
  [
    "software_development",
    "code_generation",
    "file_management",
    "deep_research",
    "product_studio",
    "creative_studio",
    "commercial_office",
    "commercial_office_send",
    "marketing_office",
  ].forEach((c) => set.add(c));
  return set;
}

export function validateServiceDefinition(
  raw: unknown,
  strict = false,
  factoryServiceIds?: Set<string>,
  isUserConnection = false,
): ServiceDefinition {
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

  // Server-side userCreated determination
  const isFactory = factoryServiceIds ? factoryServiceIds.has(r.id.trim()) : false;
  const userCreated = isUserConnection || (Boolean(r.userCreated) && !isFactory);

  // Validate capabilities against known catalog for user connections
  if (isUserConnection || userCreated) {
    const known = getKnownCapabilities();
    for (const cap of r.capabilities) {
      if (!known.has(cap)) {
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

  if (
    r.riskByCapability !== undefined &&
    (typeof r.riskByCapability !== "object" ||
      ((strict || isUserConnection || userCreated) && Object.values(r.riskByCapability).some((val) => !risks.has(val as string))) ||
      ((isUserConnection || userCreated) && Object.keys(r.riskByCapability).some((c) => !r.capabilities.includes(c))))
  ) {
    throw new Error("invalid riskByCapability");
  }

  if (
    r.permissionByCapability !== undefined &&
    (typeof r.permissionByCapability !== "object" ||
      ((strict || isUserConnection || userCreated) && Object.values(r.permissionByCapability).some((val) => !permissions.has(val as string))) ||
      ((isUserConnection || userCreated) && Object.keys(r.permissionByCapability).some((c) => !r.capabilities.includes(c))))
  ) {
    throw new Error("invalid permissionByCapability");
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

  // Chantier 8 (connections.requestTimeoutMs/healthTimeoutMs) : ne jamais figer un
  // défaut littéral ici — un service sans valeur explicite reste `undefined` et retombe
  // dynamiquement sur config.connections.* au point d'usage (ServiceAdapter), pour que le
  // réglage global reste réellement effectif y compris à chaud, sans dépendre de l'ordre
  // entre la construction du ServiceRegistry et l'application des settings au démarrage.
  const requestTimeoutMs = r.requestTimeoutMs;
  const healthTimeoutMs = r.healthTimeoutMs;
  if (requestTimeoutMs !== undefined && (!Number.isFinite(requestTimeoutMs) || requestTimeoutMs < 1000 || requestTimeoutMs > 600000)) {
    throw new Error("invalid requestTimeoutMs");
  }
  if (healthTimeoutMs !== undefined && (!Number.isFinite(healthTimeoutMs) || healthTimeoutMs < 500 || healthTimeoutMs > 60000)) {
    throw new Error("invalid healthTimeoutMs");
  }

  if (r.provider !== undefined && (typeof r.provider !== "string" || !llmProviderNames.has(r.provider))) {
    throw new Error("invalid provider");
  }
  if (r.model !== undefined && (typeof r.model !== "string" || !r.model.trim())) {
    throw new Error("invalid model");
  }

  return {
    ...r,
    id: r.id.trim(),
    name: r.name.trim(),
    description: typeof r.description === "string" ? r.description.trim() : undefined,
      userCreated,
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

  if (s.id === "software_factory" && process.env.SOFTWARE_FACTORY_URL) {
    endpoint = process.env.SOFTWARE_FACTORY_URL;
    source = "ENVIRONMENT";
  }

  if (process.env.PORT) endpoint = endpoint.replace("${PORT}", process.env.PORT);

  // Software Factory runs in-process by default (the existing SoftwareFactoryService
  // instance registered locally on the ServiceAdapter). It only switches to task_http
  // when explicitly pointed at a real URL (SOFTWARE_FACTORY_URL or an endpoint override).
  const isLocalMarker = ["local", "direct", "in-process"].includes(endpoint) || endpoint === s.id;
  const transport = s.id === "software_factory" ? (isLocalMarker ? "local" : "task_http") : s.transport;

  return { ...s, endpoint, transport, source };
}

const defaultServicesConfigPath = () => join(process.cwd(), "config/services.json");

function readServicesConfigRaw(path: string): Record<string, unknown>[] {
  if (!existsSync(path)) return [];
  try {
    const parsed = JSON.parse(readFileSync(path, "utf8"));
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

export interface BureauLlmConfig {
  provider?: LLMProviderName;
  model?: string;
}

/**
 * Lit à la volée (jamais mis en cache) le provider/modèle LLM configuré pour un bureau
 * métier dans config/services.json. Absents = le bureau doit retomber sur le provider/modèle
 * global actif de Jarvis — voir bureauContract.officeLlm, seul appelant prévu.
 */
export function getBureauLlmConfig(id: BureauServiceId, path: string = defaultServicesConfigPath()): BureauLlmConfig {
  const raw = readServicesConfigRaw(path).find((s) => s && s.id === id);
  if (!raw) return {};
  const result: BureauLlmConfig = {};
  if (typeof raw.provider === "string" && llmProviderNames.has(raw.provider)) result.provider = raw.provider as LLMProviderName;
  if (typeof raw.model === "string" && raw.model.trim()) result.model = raw.model.trim();
  return result;
}

/**
 * Met à jour (ou efface, avec `null`/chaîne vide) le provider/modèle LLM d'un bureau métier
 * directement dans config/services.json, en ne touchant à rien d'autre dans le fichier.
 * Utilisé par POST /api/settings/services.
 */
export function setBureauLlmConfig(
  id: BureauServiceId,
  patch: { provider?: string | null; model?: string | null },
  path: string = defaultServicesConfigPath(),
): BureauLlmConfig {
  if (!(BUREAU_SERVICE_IDS as readonly string[]).includes(id)) {
    throw new Error(`UNKNOWN_BUREAU_SERVICE: ${id}`);
  }
  if (patch.provider !== undefined && patch.provider !== null && patch.provider !== "" && !llmProviderNames.has(patch.provider)) {
    throw new Error(`INVALID_LLM_PROVIDER: ${patch.provider}`);
  }
  if (patch.model !== undefined && patch.model !== null && patch.model.trim() === "" && patch.model !== "") {
    throw new Error("INVALID_LLM_MODEL");
  }

  const list = readServicesConfigRaw(path);
  const entry = list.find((s) => s && s.id === id);
  if (!entry) throw new Error(`SERVICE_NOT_FOUND: ${id}`);

  if (patch.provider !== undefined) {
    if (!patch.provider) delete entry.provider;
    else entry.provider = patch.provider;
  }
  if (patch.model !== undefined) {
    const trimmed = patch.model?.trim();
    if (!trimmed) delete entry.model;
    else entry.model = trimmed;
  }

  writeFileSync(path, `${JSON.stringify(list, null, 2)}\n`, "utf8");
  return getBureauLlmConfig(id, path);
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
    const factorySet = new Set(this.factoryServices.map((x) => x.id));
    const s = validateServiceDefinition(raw, false, factorySet);
    const existing = this.getServiceById(s.id);

    if (existing) {
      // Check if immutable connection fields changed
      const endpointChanged = existing.endpoint !== s.endpoint;
      const transportChanged = existing.transport !== s.transport;
      const priorityChanged = existing.priority !== s.priority;
      const authChanged = JSON.stringify(existing.auth) !== JSON.stringify(s.auth);
      const capsChanged = JSON.stringify(existing.capabilities) !== JSON.stringify(s.capabilities);
      const risksChanged = JSON.stringify(existing.riskByCapability ?? {}) !== JSON.stringify(s.riskByCapability ?? {});
      const permissionsChanged = JSON.stringify(existing.permissionByCapability ?? {}) !== JSON.stringify(s.permissionByCapability ?? {});

      if (endpointChanged || transportChanged || priorityChanged || authChanged || capsChanged || risksChanged || permissionsChanged) {
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
      permissionByCapabilityJson: JSON.stringify(s.permissionByCapability ?? {}),
      updatedAt: Date.now(),
    });
  }

  patchService(id: string, patch: Partial<ServiceDefinition>): void {
    const existing = this.getServiceById(id);
    if (!existing) {
      throw new Error(`SERVICE_NOT_FOUND: ${id}`);
    }

    const isFactory = this.factoryServices.some((x) => x.id === id);

    // Validate patch input fields
    if (patch.endpoint !== undefined) {
      const transport = patch.transport ?? existing.transport;
      if (transport === "task_http") {
        let u: URL;
        try {
          u = new URL(patch.endpoint);
        } catch {
          throw new Error("invalid endpoint");
        }
        if (!["http:", "https:"].includes(u.protocol)) throw new Error("invalid endpoint protocol");
      }
    }

    if (patch.transport !== undefined) {
      if (!["local", "task_http"].includes(patch.transport)) {
        throw new Error("invalid transport");
      }
      if (!isFactory && patch.transport !== "task_http") {
        throw new Error("INVALID_TRANSPORT: user services must use task_http");
      }
    }

    if (patch.healthPath !== undefined) {
      if (typeof patch.healthPath !== "string" || !patch.healthPath.startsWith("/") || patch.healthPath.includes("..") || patch.healthPath.includes("://")) {
        throw new Error("invalid healthPath");
      }
    }

    if (patch.taskPath !== undefined) {
      if (typeof patch.taskPath !== "string" || !patch.taskPath.startsWith("/") || patch.taskPath.includes("..") || patch.taskPath.includes("://")) {
        throw new Error("invalid taskPath");
      }
    }

    if (patch.priority !== undefined) {
      if (!Number.isFinite(patch.priority) || patch.priority < 0 || patch.priority > 100) {
        throw new Error("invalid priority");
      }
    }

    if (patch.requestTimeoutMs !== undefined) {
      if (!Number.isFinite(patch.requestTimeoutMs) || patch.requestTimeoutMs < 1000 || patch.requestTimeoutMs > 600000) {
        throw new Error("invalid requestTimeoutMs");
      }
    }

    if (patch.healthTimeoutMs !== undefined) {
      if (!Number.isFinite(patch.healthTimeoutMs) || patch.healthTimeoutMs < 500 || patch.healthTimeoutMs > 60000) {
        throw new Error("invalid healthTimeoutMs");
      }
    }

    if (patch.auth !== undefined) {
      if (
        !patch.auth ||
        !["none", "bearer_env"].includes(patch.auth.type) ||
        (patch.auth.type === "bearer_env" && (typeof patch.auth.envVar !== "string" || !patch.auth.envVar.trim() || !/^[A-Z][A-Z0-9_]*$/.test(patch.auth.envVar)))
      ) {
        throw new Error("invalid auth");
      }
    }

    if (patch.capabilities !== undefined) {
      if (!Array.isArray(patch.capabilities) || !patch.capabilities.length || !patch.capabilities.every((x) => typeof x === "string" && !!x.trim())) {
        throw new Error("invalid capabilities");
      }
      if (!isFactory) {
        const known = getKnownCapabilities();
        for (const cap of patch.capabilities) {
          if (!known.has(cap)) {
            throw new Error(`CONNECTION_CAPABILITY_UNKNOWN: ${cap}`);
          }
        }
      }
    }

    if (patch.parallelSafeCapabilities !== undefined) {
      const targetCaps = patch.capabilities ?? existing.capabilities;
      if (
        !Array.isArray(patch.parallelSafeCapabilities) ||
        !patch.parallelSafeCapabilities.every((x) => typeof x === "string" && !!x.trim() && targetCaps.includes(x))
      ) {
        throw new Error("invalid parallel safe capabilities");
      }
    }

    if (patch.riskByCapability !== undefined) {
      const targetCaps = patch.capabilities ?? existing.capabilities;
      if (
        typeof patch.riskByCapability !== "object" ||
        Object.entries(patch.riskByCapability).some(([cap, val]) => !risks.has(val as string) || !targetCaps.includes(cap))
      ) {
        throw new Error("invalid riskByCapability");
      }
    }

    if (patch.permissionByCapability !== undefined) {
      const targetCaps = patch.capabilities ?? existing.capabilities;
      if (
        typeof patch.permissionByCapability !== "object" ||
        Object.entries(patch.permissionByCapability).some(([cap, val]) => !permissions.has(val as string) || !targetCaps.includes(cap))
      ) {
        throw new Error("invalid permissionByCapability");
      }
    }

    const endpointChanged = patch.endpoint !== undefined && patch.endpoint !== existing.endpoint;
    const transportChanged = patch.transport !== undefined && patch.transport !== existing.transport;
    const priorityChanged = patch.priority !== undefined && patch.priority !== existing.priority;
    const authChanged = patch.auth !== undefined && JSON.stringify(patch.auth) !== JSON.stringify(existing.auth);
    const capsChanged = patch.capabilities !== undefined && JSON.stringify(patch.capabilities) !== JSON.stringify(existing.capabilities);
    const risksChanged = patch.riskByCapability !== undefined && JSON.stringify(patch.riskByCapability) !== JSON.stringify(existing.riskByCapability);
    const permissionsChanged = patch.permissionByCapability !== undefined && JSON.stringify(patch.permissionByCapability) !== JSON.stringify(existing.permissionByCapability);

    if (endpointChanged || transportChanged || priorityChanged || authChanged || capsChanged || risksChanged || permissionsChanged) {
      const activeOps = this.connectionStore.checkActiveOperations(id);
      if (activeOps.length > 0) {
        const err = new Error("SERVICE_CONNECTION_IN_USE");
        (err as any).taskIds = activeOps;
        throw err;
      }
    }

    const patchRecord: any = {};
    if (patch.name !== undefined) {
      if (isFactory) patchRecord.nameOverride = patch.name;
      else patchRecord.name = patch.name;
    }
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
    if (patch.permissionByCapability !== undefined) patchRecord.permissionByCapabilityJson = JSON.stringify(patch.permissionByCapability);

    this.connectionStore.patchOverride(id, patchRecord);
  }

  isFactoryService(id: string): boolean {
    return this.factoryServices.some((x) => x.id === id);
  }

  deleteService(id: string): void {
    if (this.isFactoryService(id)) {
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
        const hasDbOverride = hasConfigOverride(ov);
        const merged: ServiceDefinition = {
          ...factoryDef,
          name: ov.nameOverride || factoryDef.name,
          enabled: ov.enabledOverride !== undefined ? ov.enabledOverride : factoryDef.enabled,
          transport: ov.transportOverride || factoryDef.transport,
          endpoint: ov.endpointOverride || factoryDef.endpoint,
          healthPath: ov.healthPath || factoryDef.healthPath || "/health",
          taskPath: ov.taskPath || factoryDef.taskPath || "/tasks",
          priority: ov.priorityOverride !== undefined ? ov.priorityOverride : factoryDef.priority,
          requestTimeoutMs: ov.requestTimeoutMs ?? factoryDef.requestTimeoutMs ?? config.connections.requestTimeoutMs,
          healthTimeoutMs: ov.healthTimeoutMs ?? factoryDef.healthTimeoutMs ?? config.connections.healthTimeoutMs,
          auth:
            ov.authTypeOverride === "bearer_env"
              ? { type: "bearer_env", envVar: ov.authEnvVar || (factoryDef.auth.type === "bearer_env" ? factoryDef.auth.envVar : "API_TOKEN") }
              : ov.authTypeOverride === "none"
              ? { type: "none" }
              : factoryDef.auth,
          capabilities: ov.capabilitiesJson ? JSON.parse(ov.capabilitiesJson) : factoryDef.capabilities,
          parallelSafeCapabilities: ov.parallelSafeCapabilitiesJson ? JSON.parse(ov.parallelSafeCapabilitiesJson) : factoryDef.parallelSafeCapabilities,
          riskByCapability: ov.riskByCapabilityJson ? JSON.parse(ov.riskByCapabilityJson) : factoryDef.riskByCapability,
          permissionByCapability: ov.permissionByCapabilityJson ? JSON.parse(ov.permissionByCapabilityJson) : factoryDef.permissionByCapability,
          source: hasDbOverride ? "DATABASE" : factoryDef.source ?? "FACTORY",
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
        requestTimeoutMs: ov.requestTimeoutMs ?? config.connections.requestTimeoutMs,
        healthTimeoutMs: ov.healthTimeoutMs ?? config.connections.healthTimeoutMs,
        auth: ov.authTypeOverride === "bearer_env" ? { type: "bearer_env", envVar: ov.authEnvVar || "API_TOKEN" } : { type: "none" },
        capabilities: ov.capabilitiesJson ? JSON.parse(ov.capabilitiesJson) : [],
        parallelSafeCapabilities: ov.parallelSafeCapabilitiesJson ? JSON.parse(ov.parallelSafeCapabilitiesJson) : [],
        riskByCapability: ov.riskByCapabilityJson ? JSON.parse(ov.riskByCapabilityJson) : {},
        permissionByCapability: ov.permissionByCapabilityJson ? JSON.parse(ov.permissionByCapabilityJson) : {},
        source: "DATABASE",
      };
      result.push(resolveServiceEndpoint(userDef));
    }

    return result;
  }
}
