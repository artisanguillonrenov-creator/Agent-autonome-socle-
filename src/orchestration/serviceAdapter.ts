import type { TaskRequest, ServiceEvent } from "./contract.js";
import type { ServiceDefinition } from "./serviceRegistry.js";
import { SoftwareFactoryService } from "../services/softwareFactoryService.js";
import { config } from "../config.js";

export interface LocalTaskService {
  handleTaskRequest(r: TaskRequest): Promise<ServiceEvent[]>;
  health?(): Promise<Record<string, unknown>> | Record<string, unknown>;
}

export type ServiceAdapterResponse = (
  | { success: true; events: ServiceEvent[] }
  | { success: false; transportError: true; message: string }
) & { transportDurationMs: number };

export class ServiceAdapter {
  private localSoftwareFactory: LocalTaskService = new SoftwareFactoryService();
  private local = new Map<string, LocalTaskService>();

  constructor() {
    this.registerLocal("software_factory", this.localSoftwareFactory);
  }

  registerLocal(id: string, s: LocalTaskService) {
    this.local.set(id, s);
  }

  private definition(value: ServiceDefinition | string): ServiceDefinition {
    if (typeof value === "string") {
      const isHttp = value.startsWith("http://") || value.startsWith("https://");
      const isSoftwareFactory = isHttp || ["software_factory", "in-process", "direct"].includes(value);
      return {
        id: isSoftwareFactory ? "software_factory" : value,
        name: value,
        enabled: true,
        transport: isHttp ? "task_http" : "local",
        endpoint: value,
        healthPath: "/health",
        taskPath: "/tasks",
        capabilities: ["software_development"],
        priority: 0,
        riskByCapability: { software_development: "MEDIUM" },
        auth: { type: isSoftwareFactory ? "bearer_env" : "none", envVar: "SOFTWARE_FACTORY_TOKEN" },
      };
    }
    return value;
  }

  private headers(s: ServiceDefinition): Record<string, string> {
    const h: Record<string, string> = { "content-type": "application/json" };
    if (s.auth.type === "bearer_env") {
      const token = process.env[s.auth.envVar] || (s.id === "software_factory" ? process.env.API_TOKEN : undefined);
      if (!token) throw new Error(`AUTH_ENV_MISSING: ${s.auth.envVar}`);
      h.authorization = `Bearer ${token}`;
    }
    return h;
  }

  async checkHealth(value: ServiceDefinition | string, timeoutMsOverride?: number) {
    const s = this.definition(value);
    const timeoutMs = timeoutMsOverride ?? s.healthTimeoutMs ?? config.connections.healthTimeoutMs;
    const startedAt = Date.now();

    if (s.transport === "local") {
      const registered = this.local.has(s.id);
      return {
        serviceId: s.id,
        reachable: registered,
        status: registered ? 200 : 404,
        latencyMs: Date.now() - startedAt,
        checkedAt: Date.now(),
        errorCode: registered ? undefined : "LOCAL_SERVICE_NOT_REGISTERED",
      };
    }

    try {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), timeoutMs);
      const healthPath = s.healthPath ?? "/health";
      const fullUrl = `${s.endpoint.replace(/\/+$/, "")}${healthPath.startsWith("/") ? healthPath : "/" + healthPath}`;

      const res = await fetch(fullUrl, {
        headers: this.headers(s),
        signal: controller.signal,
      });
      clearTimeout(timer);

      const latencyMs = Date.now() - startedAt;
      return {
        serviceId: s.id,
        reachable: res.ok,
        status: res.status,
        authenticated: res.status !== 401,
        latencyMs,
        checkedAt: Date.now(),
        errorCode: res.ok ? undefined : `HTTP_${res.status}`,
      };
    } catch (e) {
      const err = e as Error;
      return {
        serviceId: s.id,
        reachable: false,
        status: 500,
        authenticated: false,
        latencyMs: Date.now() - startedAt,
        checkedAt: Date.now(),
        errorCode: err.name === "AbortError" ? "TIMEOUT" : err.message,
      };
    }
  }

  async dispatchTask(
    value: ServiceDefinition | string,
    r: TaskRequest,
    timeoutMsOverride?: number,
  ): Promise<ServiceAdapterResponse> {
    const started = Date.now();
    const s = this.definition(value);
    const timeoutMs = timeoutMsOverride ?? s.requestTimeoutMs ?? config.connections.requestTimeoutMs;

    if (s.transport === "local") {
      const target = s.id === "software_factory" ? this.localSoftwareFactory : this.local.get(s.id);
      if (!target) {
        return {
          success: false,
          transportError: true,
          message: `LOCAL_SERVICE_NOT_REGISTERED: ${s.id}`,
          transportDurationMs: Date.now() - started,
        };
      }
      try {
        if (s.id === "software_factory") {
          console.log(`[JARVIS-FLOW] SERVICE=software_factory taskId=${r.task_id} traceId=${r.trace_id}`);
          console.log(`[JARVIS-FLOW] TRANSPORT=local taskId=${r.task_id} traceId=${r.trace_id}`);
          console.log(`[JARVIS-FLOW] FACTORY_RECEIVED taskId=${r.task_id} traceId=${r.trace_id}`);
        }
        const events = await target.handleTaskRequest(r);
        if (s.id === "software_factory" && events.some((event) => event.type === "TASK_COMPLETED")) {
          console.log(`[JARVIS-FLOW] PR_CREATED taskId=${r.task_id} traceId=${r.trace_id}`);
        }
        return {
          success: true,
          events,
          transportDurationMs: Date.now() - started,
        };
      } catch (e) {
        return {
          success: false,
          transportError: true,
          message: (e as Error).message,
          transportDurationMs: Date.now() - started,
        };
      }
    }

    try {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), timeoutMs);
      const taskPath = s.taskPath ?? "/tasks";
      const fullUrl = `${s.endpoint.replace(/\/+$/, "")}${taskPath.startsWith("/") ? taskPath : "/" + taskPath}`;

      const res = await fetch(fullUrl, {
        method: "POST",
        headers: this.headers(s),
        body: JSON.stringify(r),
        signal: controller.signal,
      });
      clearTimeout(timer);

      if (!res.ok) {
        return {
          success: false,
          transportError: true,
          message: `HTTP error ${res.status}`,
          transportDurationMs: Date.now() - started,
        };
      }

      const d = (await res.json()) as any;
      return {
        success: true,
        events: Array.isArray(d) ? d : d.events ?? [],
        transportDurationMs: Date.now() - started,
      };
    } catch (e) {
      const error = e as Error;
      return {
        success: false,
        transportError: true,
        message: error.name === "AbortError" ? `Network timeout after ${timeoutMs}ms` : `Transport error: ${error.message}`,
        transportDurationMs: Date.now() - started,
      };
    }
  }
}
