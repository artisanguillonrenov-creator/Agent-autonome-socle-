import type { TaskRequest, ServiceEvent } from "./contract.js";

export type ServiceAdapterResponse =
  | { success: true; events: ServiceEvent[] }
  | { success: false; transportError: true; message: string };

export class ServiceAdapter {
  async dispatchTask(endpoint: string, request: TaskRequest, timeoutMs = 5000): Promise<ServiceAdapterResponse> {
    const targetUrl = `${endpoint.replace(/\/+$/, "")}/tasks`;

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);

    try {
      const res = await fetch(targetUrl, {
        method: "POST",
        headers: {
          "content-type": "application/json",
        },
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
      return {
        success: false,
        transportError: true,
        message: isAbort ? `Network timeout after ${timeoutMs}ms` : `Transport error: ${(err as Error).message}`,
      };
    }
  }
}
