/**
 * Transport sécurisé des callbacks asynchrones entre n8n/JARVIS-00 et Jarvis.
 *
 * Le même transport HMAC sert aussi au bootstrap contrôlé d'une mission via
 * l'événement de contrôle MISSION_SYNC. Cela évite de créer un second protocole
 * d'authentification : canonicalisation, anti-rejeu, secret et comparaison en
 * temps constant restent strictement ceux de PR-F.
 */

import { createHmac, timingSafeEqual } from "node:crypto";
import { config } from "../config.js";
import { MISSION_STATUSES, MissionNotFoundError, type MissionStatus } from "./types.js";
import { MissionStore } from "./missionStore.js";
import { assertSupportedContractVersion } from "./contracts.js";

/** Fenêtre anti-rejeu : ±5 minutes autour de l'heure serveur. */
export const CALLBACK_TIMESTAMP_WINDOW_MS = 5 * 60 * 1000;

/** Limite stricte du corps HTTP accepté par l'endpoint de callback. */
export const CALLBACK_MAX_BODY_BYTES = 256 * 1024;

/** Événements métier journalisés sur une mission existante. */
export const CALLBACK_EVENT_TYPES = [
  "HUMAN_GATE_DECISION",
  "BUILD_RESULT",
  "CI_STATUS_UPDATE",
  "MISSION_STATUS_UPDATE",
] as const;

/** Événements de contrôle du transport, non journalisés comme événements métier. */
export const CALLBACK_CONTROL_EVENT_TYPES = ["MISSION_SYNC"] as const;

export type CallbackEventType =
  | (typeof CALLBACK_EVENT_TYPES)[number]
  | (typeof CALLBACK_CONTROL_EVENT_TYPES)[number];

export interface CallbackEnvelope {
  eventId: string;
  missionId: string;
  traceId: string;
  eventType: CallbackEventType;
  timestamp: number;
  schemaVersion: number;
  payload: Record<string, unknown>;
}

export class CallbackAuthNotConfiguredError extends Error {
  readonly code = "CALLBACK_AUTH_NOT_CONFIGURED" as const;
  constructor() {
    super("CALLBACK_AUTH_NOT_CONFIGURED : aucun secret HMAC de callback n'est configuré (JARVIS_CALLBACK_HMAC_SECRET).");
    this.name = "CallbackAuthNotConfiguredError";
  }
}

export class CallbackPayloadInvalidError extends Error {
  readonly code = "CALLBACK_PAYLOAD_INVALID" as const;
  constructor(message: string) {
    super(`CALLBACK_PAYLOAD_INVALID : ${message}`);
    this.name = "CallbackPayloadInvalidError";
  }
}

export class CallbackSignatureMissingError extends Error {
  readonly code = "CALLBACK_SIGNATURE_MISSING" as const;
  constructor() {
    super("CALLBACK_SIGNATURE_MISSING : le champ signature est obligatoire et doit être une chaîne non vide.");
    this.name = "CallbackSignatureMissingError";
  }
}

export class CallbackSignatureInvalidError extends Error {
  readonly code = "CALLBACK_SIGNATURE_INVALID" as const;
  constructor() {
    super("CALLBACK_SIGNATURE_INVALID : la signature HMAC fournie ne correspond pas au corps canonique attendu.");
    this.name = "CallbackSignatureInvalidError";
  }
}

export class CallbackPayloadTooLargeError extends Error {
  readonly code = "CALLBACK_PAYLOAD_TOO_LARGE" as const;
  constructor(limitBytes: number) {
    super(`CALLBACK_PAYLOAD_TOO_LARGE : le corps du callback dépasse la limite autorisée (${limitBytes} octets).`);
    this.name = "CallbackPayloadTooLargeError";
  }
}

export class CallbackTimestampInvalidError extends Error {
  readonly code = "CALLBACK_TIMESTAMP_INVALID" as const;
  constructor(message: string) {
    super(`CALLBACK_TIMESTAMP_INVALID : ${message}`);
    this.name = "CallbackTimestampInvalidError";
  }
}

export class CallbackCorrelationFailedError extends Error {
  readonly code = "CALLBACK_CORRELATION_FAILED" as const;
  constructor(message: string) {
    super(`CALLBACK_CORRELATION_FAILED : ${message}`);
    this.name = "CallbackCorrelationFailedError";
  }
}

function stableForSigning(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(stableForSigning);
  if (value && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>)
        .sort(([a], [b]) => a.localeCompare(b))
        .map(([key, nested]) => [key, stableForSigning(nested)]),
    );
  }
  return value;
}

/** Corps canonique signé ; la signature elle-même n'en fait jamais partie. */
export function canonicalizeCallbackBody(envelope: CallbackEnvelope): string {
  return JSON.stringify(
    stableForSigning({
      event_id: envelope.eventId,
      mission_id: envelope.missionId,
      trace_id: envelope.traceId,
      event_type: envelope.eventType,
      timestamp: envelope.timestamp,
      schema_version: envelope.schemaVersion,
      payload: envelope.payload,
    }),
  );
}

/** HMAC_SHA256(secret, timestamp + "." + canonical_body). */
export function computeCallbackSignature(secret: string, timestamp: number, canonicalBody: string): string {
  return createHmac("sha256", secret).update(`${timestamp}.${canonicalBody}`).digest("hex");
}

function signaturesMatch(expectedHex: string, providedHex: string): boolean {
  const expected = Buffer.from(expectedHex, "hex");
  const provided = Buffer.from(providedHex, "hex");
  if (expected.length === 0 || provided.length !== expected.length) return false;
  return timingSafeEqual(expected, provided);
}

function getCallbackSecret(): string {
  const secret = config.callback.hmacSecret;
  if (!secret || !secret.trim()) throw new CallbackAuthNotConfiguredError();
  return secret;
}

export function assertTimestampWithinWindow(timestamp: number, now: number = Date.now()): void {
  if (!Number.isFinite(timestamp)) {
    throw new CallbackTimestampInvalidError(`timestamp doit être un nombre fini (epoch millisecondes), reçu ${JSON.stringify(timestamp)}.`);
  }
  const delta = Math.abs(now - timestamp);
  if (delta > CALLBACK_TIMESTAMP_WINDOW_MS) {
    throw new CallbackTimestampInvalidError(
      `timestamp hors fenêtre anti-rejeu autorisée (±${CALLBACK_TIMESTAMP_WINDOW_MS}ms) : écart observé ${delta}ms.`,
    );
  }
}

export function verifyCallbackAuthentication(envelope: CallbackEnvelope, signature: string, now: number = Date.now()): void {
  const secret = getCallbackSecret();
  assertTimestampWithinWindow(envelope.timestamp, now);
  const canonicalBody = canonicalizeCallbackBody(envelope);
  const expected = computeCallbackSignature(secret, envelope.timestamp, canonicalBody);
  if (!signaturesMatch(expected, signature)) throw new CallbackSignatureInvalidError();
}

function requireNonEmptyString(value: unknown, field: string): string {
  if (typeof value !== "string" || value.trim() === "") {
    throw new CallbackPayloadInvalidError(`${field} est obligatoire et doit être une chaîne non vide.`);
  }
  return value.trim();
}

export function parseCallbackRequestBody(body: unknown): { envelope: CallbackEnvelope; signature: string } {
  if (!body || typeof body !== "object" || Array.isArray(body)) {
    throw new CallbackPayloadInvalidError("le corps de la requête doit être un objet JSON.");
  }
  const raw = body as Record<string, unknown>;

  const eventId = requireNonEmptyString(raw.event_id, "event_id");
  const missionId = requireNonEmptyString(raw.mission_id, "mission_id");
  const traceId = requireNonEmptyString(raw.trace_id, "trace_id");
  const eventTypeRaw = requireNonEmptyString(raw.event_type, "event_type");
  const allowedEventTypes: readonly string[] = [...CALLBACK_EVENT_TYPES, ...CALLBACK_CONTROL_EVENT_TYPES];
  if (!allowedEventTypes.includes(eventTypeRaw)) {
    throw new CallbackPayloadInvalidError(
      `event_type inconnu : ${JSON.stringify(eventTypeRaw)} (attendu l'un de : ${allowedEventTypes.join(", ")}).`,
    );
  }
  if (typeof raw.timestamp !== "number" || !Number.isFinite(raw.timestamp)) {
    throw new CallbackPayloadInvalidError("timestamp est obligatoire et doit être un nombre (epoch millisecondes).");
  }
  if (typeof raw.schema_version !== "number" || !Number.isFinite(raw.schema_version)) {
    throw new CallbackPayloadInvalidError("schema_version est obligatoire et doit être un nombre.");
  }
  if (!raw.payload || typeof raw.payload !== "object" || Array.isArray(raw.payload)) {
    throw new CallbackPayloadInvalidError("payload est obligatoire et doit être un objet.");
  }
  if (typeof raw.signature !== "string" || raw.signature.trim() === "") {
    throw new CallbackSignatureMissingError();
  }

  return {
    envelope: {
      eventId,
      missionId,
      traceId,
      eventType: eventTypeRaw as CallbackEventType,
      timestamp: raw.timestamp,
      schemaVersion: raw.schema_version,
      payload: raw.payload as Record<string, unknown>,
    },
    signature: raw.signature,
  };
}

interface MissionSyncPayload {
  projectId: string;
  status: MissionStatus;
}

function parseMissionSyncPayload(payload: Record<string, unknown>): MissionSyncPayload {
  const projectId = requireNonEmptyString(payload.project_id, "payload.project_id");
  const statusRaw = payload.status ?? "RECEIVED";
  if (typeof statusRaw !== "string" || !MISSION_STATUSES.has(statusRaw as MissionStatus)) {
    throw new CallbackPayloadInvalidError(`payload.status invalide : ${JSON.stringify(statusRaw)}.`);
  }
  return { projectId, status: statusRaw as MissionStatus };
}

export interface CallbackProcessingResult {
  outcome: "APPLIED" | "DUPLICATE" | "MISSION_CREATED" | "MISSION_EXISTS";
  missionId: string;
  traceId: string;
  eventId: string;
}

/**
 * Authentifie d'abord l'enveloppe puis :
 * - MISSION_SYNC : crée la mission ou confirme idempotemment son existence ;
 * - autres événements : exige une mission existante puis journalise via MissionStore.
 *
 * MISSION_SYNC ne journalise pas d'événement métier et ne déclenche aucune action GitHub.
 */
export function processCallback(rawBody: unknown, missionStore: MissionStore, now: number = Date.now()): CallbackProcessingResult {
  const { envelope, signature } = parseCallbackRequestBody(rawBody);
  verifyCallbackAuthentication(envelope, signature, now);
  assertSupportedContractVersion(envelope.schemaVersion);

  if (envelope.eventType === "MISSION_SYNC") {
    const sync = parseMissionSyncPayload(envelope.payload);
    const existing = missionStore.getMission(envelope.missionId);

    if (existing) {
      if (existing.traceId !== envelope.traceId) {
        throw new CallbackCorrelationFailedError(
          `trace_id '${envelope.traceId}' ne correspond pas à la mission '${envelope.missionId}' (trace_id attendu '${existing.traceId}').`,
        );
      }
      if (existing.projectId !== sync.projectId) {
        throw new CallbackCorrelationFailedError(
          `project_id '${sync.projectId}' ne correspond pas à la mission '${envelope.missionId}' (project_id attendu '${existing.projectId}').`,
        );
      }
      return {
        outcome: "MISSION_EXISTS",
        missionId: existing.missionId,
        traceId: existing.traceId,
        eventId: envelope.eventId,
      };
    }

    const created = missionStore.createMission({
      missionId: envelope.missionId,
      traceId: envelope.traceId,
      projectId: sync.projectId,
      status: sync.status,
    });
    return {
      outcome: "MISSION_CREATED",
      missionId: created.missionId,
      traceId: created.traceId,
      eventId: envelope.eventId,
    };
  }

  const mission = missionStore.getMission(envelope.missionId);
  if (!mission) throw new MissionNotFoundError(envelope.missionId);
  if (mission.traceId !== envelope.traceId) {
    throw new CallbackCorrelationFailedError(
      `trace_id '${envelope.traceId}' ne correspond pas à la mission '${envelope.missionId}' (trace_id attendu '${mission.traceId}').`,
    );
  }

  const result = missionStore.appendMissionEvent(
    {
      eventId: envelope.eventId,
      missionId: envelope.missionId,
      traceId: envelope.traceId,
      sequence: mission.lastEventSequence + 1,
      eventType: envelope.eventType,
      timestamp: envelope.timestamp,
      payload: envelope.payload,
    },
    mission.rowVersion,
  );

  return {
    outcome: result.duplicate ? "DUPLICATE" : "APPLIED",
    missionId: envelope.missionId,
    traceId: envelope.traceId,
    eventId: envelope.eventId,
  };
}
