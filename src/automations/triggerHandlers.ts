import { config } from "../config.js";
import type { ServiceOrchestrator } from "../orchestration/serviceOrchestrator.js";
import { getKnownCapabilities } from "../orchestration/serviceRegistry.js";
import { TriggerStore } from "./triggerStore.js";
import { FixedWindowRateLimiter } from "./rateLimiter.js";

export interface TriggerHttpResult {
  status: number;
  body: Record<string, unknown>;
}

const externalRateLimiter = new FixedWindowRateLimiter(60, 60_000);

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === "object" && !Array.isArray(value);
}

/**
 * automations.emailTriggers : un e-mail entrant pertinent devient une mission Commercial
 * Office (INGEST_EMAIL), qui matche/crée le contact et log l'interaction. Idempotent par
 * messageId (voir TriggerStore.claim) — la même livraison rejouée ne crée jamais une
 * seconde mission.
 */
export async function handleEmailTrigger(orchestrator: ServiceOrchestrator, store: TriggerStore, body: unknown): Promise<TriggerHttpResult> {
  if (!config.automations.emailTriggers) return { status: 409, body: { error: "EMAIL_TRIGGERS_DISABLED" } };
  if (!isPlainObject(body)) return { status: 400, body: { error: "EMAIL_TRIGGER_PAYLOAD_INVALID" } };
  const messageId = typeof body.messageId === "string" ? body.messageId.trim() : "";
  const from = typeof body.from === "string" ? body.from.trim() : "";
  if (!messageId) return { status: 400, body: { error: "EMAIL_TRIGGER_MESSAGE_ID_REQUIRED" } };
  if (!from) return { status: 400, body: { error: "EMAIL_TRIGGER_FROM_REQUIRED" } };
  const workspaceId = typeof body.workspaceId === "string" && body.workspaceId.trim() ? body.workspaceId.trim() : undefined;

  const { claimed, record } = store.claim("EMAIL", messageId, body, workspaceId);
  if (!claimed) return { status: 200, body: { ok: true, duplicate: true, trigger: record } };

  const subject = typeof body.subject === "string" ? body.subject : "";
  const objective = `Traiter l'e-mail entrant de ${from}${subject ? ` : ${subject}` : ""}`;
  const orchResult = await orchestrator.dispatchCapability(
    { action: "DISPATCH_CAPABILITY", capability: "commercial_office", objective, context: { action: "INGEST_EMAIL", from, subject, body: typeof body.body === "string" ? body.body : "" } },
    { executionMode: "background", workspaceId, idempotencyKey: `trigger:email:${messageId}` },
  );
  store.attach("EMAIL", messageId, { operationTaskId: orchResult.taskId, capability: "commercial_office", objective, status: orchResult.status });
  return { status: 202, body: { ok: true, duplicate: false, taskId: orchResult.taskId, status: orchResult.status } };
}

/**
 * automations.crmTriggers : un événement CRM (interne ou externe) devient une mission
 * Commercial Office (INGEST_CRM_EVENT). Idempotent par eventId.
 */
export async function handleCrmTrigger(orchestrator: ServiceOrchestrator, store: TriggerStore, body: unknown): Promise<TriggerHttpResult> {
  if (!config.automations.crmTriggers) return { status: 409, body: { error: "CRM_TRIGGERS_DISABLED" } };
  if (!isPlainObject(body)) return { status: 400, body: { error: "CRM_TRIGGER_PAYLOAD_INVALID" } };
  const eventId = typeof body.eventId === "string" ? body.eventId.trim() : "";
  const eventType = typeof body.eventType === "string" ? body.eventType.trim() : "";
  if (!eventId) return { status: 400, body: { error: "CRM_TRIGGER_EVENT_ID_REQUIRED" } };
  if (!eventType) return { status: 400, body: { error: "CRM_TRIGGER_EVENT_TYPE_REQUIRED" } };
  const workspaceId = typeof body.workspaceId === "string" && body.workspaceId.trim() ? body.workspaceId.trim() : undefined;

  const { claimed, record } = store.claim("CRM", eventId, body, workspaceId);
  if (!claimed) return { status: 200, body: { ok: true, duplicate: true, trigger: record } };

  const objective = `Traiter l'événement CRM ${eventType}`;
  const orchResult = await orchestrator.dispatchCapability(
    { action: "DISPATCH_CAPABILITY", capability: "commercial_office", objective, context: { action: "INGEST_CRM_EVENT", eventType, data: isPlainObject(body.data) ? body.data : {} } },
    { executionMode: "background", workspaceId, idempotencyKey: `trigger:crm:${eventId}` },
  );
  store.attach("CRM", eventId, { operationTaskId: orchResult.taskId, capability: "commercial_office", objective, status: orchResult.status });
  return { status: 202, body: { ok: true, duplicate: false, taskId: orchResult.taskId, status: orchResult.status } };
}

/**
 * automations.externalEventTriggers : webhook générique. `capability` doit appartenir à
 * la liste des capacités connues (getKnownCapabilities) — jamais une chaîne arbitraire.
 * `objective`/`context` restent des DONNÉES transmises telles quelles à dispatchCapability :
 * le risque/la permission de la capacité ciblée s'appliquent exactement comme pour un appel
 * interne (aucun contournement possible depuis un payload externe). Idempotent par eventId,
 * et limité en débit (FixedWindowRateLimiter) contre les abus.
 */
export async function handleExternalTrigger(orchestrator: ServiceOrchestrator, store: TriggerStore, body: unknown): Promise<TriggerHttpResult> {
  if (!config.automations.externalEventTriggers) return { status: 409, body: { error: "EXTERNAL_EVENT_TRIGGERS_DISABLED" } };
  if (!externalRateLimiter.allow()) return { status: 429, body: { error: "EXTERNAL_EVENT_TRIGGER_RATE_LIMITED" } };
  if (!isPlainObject(body)) return { status: 400, body: { error: "EXTERNAL_TRIGGER_PAYLOAD_INVALID" } };

  const eventId = typeof body.eventId === "string" ? body.eventId.trim() : "";
  const type = typeof body.type === "string" ? body.type.trim() : "";
  const capability = typeof body.capability === "string" ? body.capability.trim() : "";
  const objective = typeof body.objective === "string" ? body.objective.trim() : "";
  if (!eventId) return { status: 400, body: { error: "EXTERNAL_TRIGGER_EVENT_ID_REQUIRED" } };
  if (!type) return { status: 400, body: { error: "EXTERNAL_TRIGGER_TYPE_REQUIRED" } };
  if (!capability || !getKnownCapabilities().has(capability)) return { status: 400, body: { error: "EXTERNAL_TRIGGER_CAPABILITY_UNKNOWN" } };
  if (!objective) return { status: 400, body: { error: "EXTERNAL_TRIGGER_OBJECTIVE_REQUIRED" } };
  if (body.context !== undefined && !isPlainObject(body.context)) return { status: 400, body: { error: "EXTERNAL_TRIGGER_CONTEXT_INVALID" } };
  const workspaceId = typeof body.workspaceId === "string" && body.workspaceId.trim() ? body.workspaceId.trim() : undefined;

  const { claimed, record } = store.claim("EXTERNAL", eventId, body, workspaceId);
  if (!claimed) return { status: 200, body: { ok: true, duplicate: true, trigger: record } };

  const orchResult = await orchestrator.dispatchCapability(
    { action: "DISPATCH_CAPABILITY", capability, objective, context: isPlainObject(body.context) ? body.context : {} },
    { executionMode: "background", workspaceId, idempotencyKey: `trigger:external:${eventId}` },
  );
  store.attach("EXTERNAL", eventId, { operationTaskId: orchResult.taskId, capability, objective, status: orchResult.status });
  return { status: 202, body: { ok: true, duplicate: false, taskId: orchResult.taskId, status: orchResult.status } };
}
