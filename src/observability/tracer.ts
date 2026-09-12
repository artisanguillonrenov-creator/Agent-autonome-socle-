import { AsyncLocalStorage } from "node:async_hooks";
import { randomUUID } from "node:crypto";

export type SpanStatus = "running" | "success" | "error";
export type SpanKind = "planning" | "specialist" | "skill" | "llm" | "other";

export interface TraceSpan {
  id: string;
  traceId: string;
  parentId: string | null;
  name: string;
  kind: SpanKind;
  timestampDeb: number;
  timestampFin: number | null;
  tokensConsommes: number;
  costUsd: number;
  inputs: unknown;
  outputs: unknown;
  status: SpanStatus;
  error?: string;
}

export interface SpanHandle {
  setTokens(n: number): void;
  addTokens(n: number): void;
  setCost(usd: number): void;
  setOutputs(outputs: unknown): void;
}

interface SpanContext {
  traceId: string;
  spanId: string;
}

const asyncLocalStorage = new AsyncLocalStorage<SpanContext>();

/** Nombre maximal de traces racines conservées en mémoire (LRU par insertion). */
const MAX_TRACES = 200;
const MAX_SPANS_PER_TRACE = 500;
const MAX_SERIALIZED_LENGTH = 4000;

const traces = new Map<string, TraceSpan[]>();
const traceOrder: string[] = [];
const NOOP_SPAN: SpanHandle = { setTokens() {}, addTokens() {}, setCost() {}, setOutputs() {} };

function safeSerialize(value: unknown): unknown {
  try {
    if (value === undefined) return null;
    const json = JSON.stringify(value);
    if (json === undefined) return null;
    return json.length > MAX_SERIALIZED_LENGTH ? `${json.slice(0, MAX_SERIALIZED_LENGTH)}…(truncated)` : value;
  } catch {
    return "[unserializable]";
  }
}

function registerSpan(span: TraceSpan): void {
  let list = traces.get(span.traceId);
  if (!list) {
    list = [];
    traces.set(span.traceId, list);
    traceOrder.push(span.traceId);
    while (traceOrder.length > MAX_TRACES) {
      const oldest = traceOrder.shift();
      if (oldest) traces.delete(oldest);
    }
  }
  if (list.length < MAX_SPANS_PER_TRACE) list.push(span);
}

export interface StartSpanOptions {
  kind?: SpanKind;
  inputs?: unknown;
  /** Force un traceId précis (racine explicite) plutôt que d'hériter du contexte courant. */
  traceId?: string;
}

/**
 * Tracer d'observabilité fondé sur AsyncLocalStorage : chaque span hérite automatiquement
 * du span parent actif dans la pile d'appels asynchrone courante, sans avoir à faire
 * transiter un contexte explicite à travers Planification -> Agent spécialiste -> Compétence.
 * Contrat de tolérance aux pannes : AUCUNE méthode ne doit jamais lever ni bloquer la boucle
 * appelante — toute erreur interne au tracer est absorbée silencieusement (best-effort).
 */
export class Tracer {
  async withSpan<T>(
    name: string,
    opts: StartSpanOptions,
    fn: (span: SpanHandle) => Promise<T>,
  ): Promise<T> {
    let span: TraceSpan | null = null;
    let context: SpanContext | null = null;
    try {
      const parent = asyncLocalStorage.getStore();
      const traceId = opts.traceId ?? parent?.traceId ?? randomUUID();
      const spanId = randomUUID();
      span = {
        id: spanId,
        traceId,
        parentId: parent?.spanId ?? null,
        name,
        kind: opts.kind ?? "other",
        timestampDeb: Date.now(),
        timestampFin: null,
        tokensConsommes: 0,
        costUsd: 0,
        inputs: safeSerialize(opts.inputs),
        outputs: null,
        status: "running",
      };
      registerSpan(span);
      context = { traceId, spanId };
    } catch {
      // Le tracer ne doit jamais empêcher l'exécution réelle.
    }

    const handle: SpanHandle = span
      ? {
          setTokens: (n) => { try { span!.tokensConsommes = n; } catch { /* noop */ } },
          addTokens: (n) => { try { span!.tokensConsommes += n; } catch { /* noop */ } },
          setCost: (usd) => { try { span!.costUsd += usd; } catch { /* noop */ } },
          setOutputs: (outputs) => { try { span!.outputs = safeSerialize(outputs); } catch { /* noop */ } },
        }
      : NOOP_SPAN;

    const run = async (): Promise<T> => {
      try {
        const result = await fn(handle);
        try {
          if (span) {
            span.status = "success";
            span.timestampFin = Date.now();
            if (span.outputs === null) span.outputs = safeSerialize(result);
          }
        } catch { /* noop */ }
        return result;
      } catch (err) {
        try {
          if (span) {
            span.status = "error";
            span.timestampFin = Date.now();
            span.error = (err as Error).message;
          }
        } catch { /* noop */ }
        throw err;
      }
    };

    return context ? asyncLocalStorage.run(context, run) : run();
  }

  /** Identifiant du trace courant (celui du span actif), s'il existe. */
  currentTraceId(): string | undefined {
    try { return asyncLocalStorage.getStore()?.traceId; } catch { return undefined; }
  }

  getTrace(traceId: string): TraceSpan[] {
    return traces.get(traceId) ?? [];
  }

  listTraces(limit = 20): Array<{ traceId: string; spans: TraceSpan[]; startedAt: number; costUsd: number }> {
    return traceOrder
      .slice(-Math.max(1, Math.min(limit, MAX_TRACES)))
      .reverse()
      .map((traceId) => {
        const spans = traces.get(traceId) ?? [];
        return {
          traceId,
          spans,
          startedAt: spans[0]?.timestampDeb ?? 0,
          costUsd: spans.reduce((sum, s) => sum + (s.costUsd || 0), 0),
        };
      });
  }

  estimatedCostUsd(traceId: string): number {
    return (traces.get(traceId) ?? []).reduce((sum, s) => sum + (s.costUsd || 0), 0);
  }
}

export const tracer = new Tracer();
