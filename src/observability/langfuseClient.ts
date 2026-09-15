import { config } from "../config.js";

type IngestionEventType =
  | "trace-create"
  | "span-create"
  | "span-update"
  | "generation-create"
  | "generation-update";

interface IngestionEvent {
  id: string;
  type: IngestionEventType;
  timestamp: string;
  body: Record<string, unknown>;
}

/**
 * Client HTTP minimal vers l'API d'ingestion Langfuse (https://api.reference.langfuse.com,
 * endpoint POST /api/public/ingestion). Volontairement sans dépendance SDK : un simple
 * batching + fetch() natif suffit pour le sous-ensemble dont le Tracer a besoin
 * (trace/span/generation create+update). Contrat de tolérance aux pannes identique à
 * Tracer : AUCUNE méthode ne doit jamais lever ni ralentir la boucle appelante — tout échec
 * réseau/config est absorbé silencieusement (best-effort, fire-and-forget).
 */
class LangfuseClient {
  private queue: IngestionEvent[] = [];
  private flushTimer: NodeJS.Timeout | null = null;
  private flushing = false;

  private get enabled(): boolean {
    return config.langfuse.enabled;
  }

  private enqueue(event: IngestionEvent): void {
    if (!this.enabled) return;
    try {
      this.queue.push(event);
      if (this.queue.length >= config.langfuse.maxBatchSize) {
        void this.flush();
        return;
      }
      if (!this.flushTimer) {
        this.flushTimer = setTimeout(() => { void this.flush(); }, config.langfuse.flushIntervalMs);
        this.flushTimer.unref?.();
      }
    } catch {
      // Le tracing ne doit jamais impacter la boucle agent.
    }
  }

  async flush(): Promise<void> {
    if (this.flushing || this.queue.length === 0) return;
    if (this.flushTimer) { clearTimeout(this.flushTimer); this.flushTimer = null; }
    this.flushing = true;
    const batch = this.queue.splice(0, this.queue.length);
    try {
      const auth = Buffer.from(`${config.langfuse.publicKey}:${config.langfuse.secretKey}`).toString("base64");
      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), 10_000);
      try {
        await fetch(`${config.langfuse.baseUrl}/api/public/ingestion`, {
          method: "POST",
          headers: { "content-type": "application/json", authorization: `Basic ${auth}` },
          body: JSON.stringify({ batch }),
          signal: controller.signal,
        });
      } finally {
        clearTimeout(timeout);
      }
    } catch (error) {
      console.warn("[Langfuse] Export best-effort échoué (ignoré):", (error as Error).message);
    } finally {
      this.flushing = false;
    }
  }

  traceCreate(opts: { id: string; name: string; input?: unknown; metadata?: Record<string, unknown> }): void {
    this.enqueue({
      id: `${opts.id}-trace-create`,
      type: "trace-create",
      timestamp: new Date().toISOString(),
      body: { id: opts.id, name: opts.name, input: opts.input, metadata: opts.metadata, timestamp: new Date().toISOString() },
    });
  }

  spanCreate(opts: { id: string; traceId: string; parentObservationId?: string | null; name: string; input?: unknown; startTime: number }): void {
    this.enqueue({
      id: `${opts.id}-span-create`,
      type: "span-create",
      timestamp: new Date().toISOString(),
      body: {
        id: opts.id,
        traceId: opts.traceId,
        parentObservationId: opts.parentObservationId ?? undefined,
        name: opts.name,
        input: opts.input,
        startTime: new Date(opts.startTime).toISOString(),
      },
    });
  }

  spanUpdate(opts: { id: string; output?: unknown; endTime: number; level?: "DEFAULT" | "ERROR"; statusMessage?: string }): void {
    this.enqueue({
      id: `${opts.id}-span-update`,
      type: "span-update",
      timestamp: new Date().toISOString(),
      body: {
        id: opts.id,
        output: opts.output,
        endTime: new Date(opts.endTime).toISOString(),
        level: opts.level ?? "DEFAULT",
        statusMessage: opts.statusMessage,
      },
    });
  }

  generationCreate(opts: {
    id: string;
    traceId: string;
    parentObservationId?: string | null;
    name: string;
    model?: string;
    input?: unknown;
    startTime: number;
  }): void {
    this.enqueue({
      id: `${opts.id}-generation-create`,
      type: "generation-create",
      timestamp: new Date().toISOString(),
      body: {
        id: opts.id,
        traceId: opts.traceId,
        parentObservationId: opts.parentObservationId ?? undefined,
        name: opts.name,
        model: opts.model,
        input: opts.input,
        startTime: new Date(opts.startTime).toISOString(),
      },
    });
  }

  generationUpdate(opts: {
    id: string;
    output?: unknown;
    endTime: number;
    usage?: { input: number; output: number; total: number };
    costUsd?: number;
    level?: "DEFAULT" | "ERROR";
    statusMessage?: string;
  }): void {
    this.enqueue({
      id: `${opts.id}-generation-update`,
      type: "generation-update",
      timestamp: new Date().toISOString(),
      body: {
        id: opts.id,
        output: opts.output,
        endTime: new Date(opts.endTime).toISOString(),
        usage: opts.usage ? { input: opts.usage.input, output: opts.usage.output, total: opts.usage.total, unit: "TOKENS" } : undefined,
        totalCost: opts.costUsd,
        level: opts.level ?? "DEFAULT",
        statusMessage: opts.statusMessage,
      },
    });
  }
}

export const langfuse = new LangfuseClient();
