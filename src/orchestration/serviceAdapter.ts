import type { TaskRequest, ServiceEvent } from "./contract.js";
import { SoftwareFactoryService } from "../services/softwareFactoryService.js";
import { config } from "../config.js";

export type ServiceAdapterResponse =
  | { success: true; events: ServiceEvent[] }
  | { success: false; transportError: true; message: string };

export class ServiceAdapter {
  private localSoftwareFactory = new SoftwareFactoryService();

  private getAuthHeaders(): Record<string, string> {
    const token = config.softwareFactory.token || config.api.token;
    const headers: Record<string, string> = {
      "content-type": "application/json",
    };
    if (token) {
      headers["authorization"] = `Bearer ${token}`;
    }
    return headers;
  }

  async checkHealth(endpoint: string, timeoutMs = 5000): Promise<{ reachable: boolean; status: number | string; authenticated?: boolean }> {
    const isLocalDirect = endpoint === "in-process" || endpoint === "local" || endpoint === "direct";
    if (isLocalDirect) {
      const diag = await this.localSoftwareFactory.getGitHubDiagnostics();
      return { reachable: true, status: 200, authenticated: diag.authenticated };
    }

    const healthUrl = `${endpoint.replace(/\/+$/, "")}/health`;
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);

    try {
      const res = await fetch(healthUrl, {
        method: "GET",
        headers: this.getAuthHeaders(),
        signal: controller.signal,
      });
      clearTimeout(timer);
      return { reachable: res.ok, status: res.status, authenticated: res.status !== 401 };
    } catch (err: unknown) {
      clearTimeout(timer);
      return { reachable: false, status: "unreachable" };
    }
  }

  async dispatchTask(endpoint: string, request: TaskRequest, timeoutMs = 5000): Promise<ServiceAdapterResponse> {
    const isLocalDirect = endpoint === "in-process" || endpoint === "local" || endpoint === "direct";

    if (isLocalDirect && request.capability === "software_development") {
      try {
        const events = await this.localSoftwareFactory.handleTaskRequest(request);
        return { success: true, events };
      } catch (err: unknown) {
        return {
          success: false,
          transportError: true,
          message: `Direct execution error: ${(err as Error).message}`,
        };
      }
    }

    const targetUrl = `${endpoint.replace(/\/+$/, "")}/tasks`;

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);

    try {
      const res = await fetch(targetUrl, {
        method: "POST",
        headers: this.getAuthHeaders(),
        body: JSON.stringify(request),
        signal: controller.signal,
      });

      clearTimeout(timer);

      if (!res.ok) {
        return {
          success: false,
          transportError: true,
          message: `HTTP error ${res.status}: ${await res.text().catch(() => "")}`,
        };
      }

      const data = (await res.json()) as { events?: ServiceEvent[] } | ServiceEvent[];
      const events: ServiceEvent[] = Array.isArray(data) ? data : data.events || [];

      return {
        success: true,
        events,
      };
    } catch (err: unknown) {
      clearTimeout(timer);
      const isAbort = err instanceof Error && err.name === "AbortError";
      const errMsg = (err as Error).message || String(err);

      return {
        success: false,
        transportError: true,
        message: isAbort ? `Network timeout after ${timeoutMs}ms` : `Transport error: ${errMsg}`,
      };
    }
  }
}
