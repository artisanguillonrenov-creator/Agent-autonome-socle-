/**
 * Transport sécurisé des callbacks asynchrones (plan V5, PR-F) entre n8n /
 * JARVIS-00, Jarvis, et les workers/services externes.
 *
 * Concrétise le "callback asynchrone authentifié" que `contracts.ts` (PR-E)
 * annonçait mais laissait explicitement hors périmètre pour transporter une
 * `HumanGateDecision` — et, plus généralement, tout événement de callback
 * connu. Ce module ne redéfinit AUCUN contrat déjà stabilisé : il réutilise
 * `MissionStore` (PR-A) pour la corrélation et l'idempotence, et
 * `JARVIS00_CONTRACTS_SCHEMA_VERSION`/`assertSupportedContractVersion`
 * (PR-E) pour le versionnement.
 *
 * Garanties de sécurité :
 * - authentification HMAC-SHA256 sur un corps canonicalisé de manière
 *   déterministe (jamais une sérialisation JSON ambiguë) ;
 * - comparaison de signature en temps constant (`timingSafeEqual`), jamais `===` ;
 * - fenêtre anti-rejeu sur le timestamp, puis idempotence par `event_id` via
 *   le journal d'événements append-only existant (aucun double effet de bord) ;
 * - corrélation stricte mission_id/trace_id : un callback cryptographiquement
 *   valide mais destiné à une autre mission est toujours rejeté ;
 * - le secret HMAC ne provient que de la configuration/variable
 *   d'environnement, n'est jamais journalisé, jamais persisté, jamais inclus
 *   dans une erreur, jamais renvoyé par l'API.
 *
 * Aucun appel réseau, aucune dépendance GitHub, aucune fusion : ce fichier ne
 * fait que vérifier et enregistrer un événement de callback déjà reçu par un
 * point d'entrée HTTP (src/interfaces/httpApi.ts).
 */

import { createHmac, timingSafeEqual } from "node:crypto";
import { config } from "../config.js";
import { MissionNotFoundError } from "./types.js";
import { MissionStore } from "./missionStore.js";
import { assertSupportedContractVersion } from "./contracts.js";

/** Fenêtre anti-rejeu (plan V5 PR-F) : ±5 minutes autour de l'heure serveur. */
export const CALLBACK_TIMESTAMP_WINDOW_MS = 5 * 60 * 1000;

/**
 * Limite stricte du corps HTTP accepté par l'endpoint de callback (correctif
 * sécurité post-audit) : cette route est volontairement exemptée du Bearer
 * API général (son authentification HMAC lui est propre), donc un client
 * non authentifié pourrait sinon forcer une accumulation mémoire illimitée
 * avant même que la signature soit vérifiée. 256 KiB couvre largement une
 * enveloppe JSON réaliste (identifiants + payload de décision/rapport de
 * build) sans autoriser cet abus. Le lecteur HTTP (src/interfaces/httpApi.ts)
 * doit arrêter la lecture dès que cette limite est dépassée, avant tout
 * JSON.parse et avant toute vérification HMAC.
 */
export const CALLBACK_MAX_BODY_BYTES = 256 * 1024;

/**
 * Vocabulaire connu des événements de callback. Un `event_type` absent de
 * cette liste est rejeté (`CALLBACK_PAYLOAD_INVALID`) plutôt qu'accepté à
 * l'aveugle — ce module ne fait qu'authentifier/corréler/journaliser
 * l'événement, jamais lui appliquer une logique métier spécifique (qui
 * reste, pour chaque type, la responsabilité de son consommateur interne).
 */
export const CALLBACK_EVENT_TYPES = [
  "HUMAN_GATE_DECISION",
  "BUILD_RESULT",
  "CI_STATUS_UPDATE",
  "MISSION_STATUS_UPDATE",
] as const;

export type CallbackEventType = (typeof CALLBACK_EVENT_TYPES)[number];

/**
 * Enveloppe de callback (plan V5 PR-F §1). Le timestamp est un choix
 * explicite et unique : epoch millisecondes (`number`), cohérent avec
 * `MissionEvent.timestamp`/`ContextVersion.createdAt` (PR-A) — jamais une
 * chaîne ISO en parallèle.
 */
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

/**
 * Levée par le lecteur HTTP (src/interfaces/httpApi.ts) dès que le corps de
 * la requête dépasse `CALLBACK_MAX_BODY_BYTES`, avant tout JSON.parse et
 * avant toute vérification HMAC — jamais après avoir déjà accepté un corps
 * hors limite, et jamais après une écriture MissionStore.
 */
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

// ---------------------------------------------------------------------------
// Canonicalisation + signature (plan V5 PR-F §1/§2)
// ---------------------------------------------------------------------------

/**
 * Sérialisation déterministe (clés triées récursivement) — même technique que
 * `computeContextHash` (src/coordination/contextVersioning.ts). Dupliquée
 * plutôt qu'importée : chaque module de ce domaine reste indépendant.
 */
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

/**
 * Corps canonique signé — défini explicitement sur les champs porteurs de
 * sens de l'enveloppe (noms de champ "wire" en snake_case, indépendants de la
 * représentation interne camelCase), jamais sur une sérialisation JSON brute
 * et potentiellement ambiguë du corps de requête reçu.
 */
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

/** HMAC_SHA256(secret, timestamp + "." + canonical_body), format documenté et déterministe (plan V5 PR-F §2). */
export function computeCallbackSignature(secret: string, timestamp: number, canonicalBody: string): string {
  return createHmac("sha256", secret).update(`${timestamp}.${canonicalBody}`).digest("hex");
}

/** Comparaison en temps constant — jamais `===` (plan V5 PR-F §2). */
function signaturesMatch(expectedHex: string, providedHex: string): boolean {
  const expected = Buffer.from(expectedHex, "hex");
  const provided = Buffer.from(providedHex, "hex");
  if (expected.length === 0 || provided.length !== expected.length) return false;
  return timingSafeEqual(expected, provided);
}

/**
 * Le secret ne provient que de la configuration (elle-même lue depuis
 * `JARVIS_CALLBACK_HMAC_SECRET`), n'est jamais généré automatiquement, jamais
 * journalisé, jamais renvoyé. Absent -> `CALLBACK_AUTH_NOT_CONFIGURED`.
 */
function getCallbackSecret(): string {
  const secret = config.callback.hmacSecret;
  if (!secret || !secret.trim()) {
    throw new CallbackAuthNotConfiguredError();
  }
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

/** Vérifie timestamp + signature. Ne fait aucune corrélation mission ni aucune écriture. */
export function verifyCallbackAuthentication(envelope: CallbackEnvelope, signature: string, now: number = Date.now()): void {
  const secret = getCallbackSecret();
  assertTimestampWithinWindow(envelope.timestamp, now);
  const canonicalBody = canonicalizeCallbackBody(envelope);
  const expected = computeCallbackSignature(secret, envelope.timestamp, canonicalBody);
  if (!signaturesMatch(expected, signature)) {
    throw new CallbackSignatureInvalidError();
  }
}

// ---------------------------------------------------------------------------
// Validation du payload reçu (plan V5 PR-F §7)
// ---------------------------------------------------------------------------

function requireNonEmptyString(value: unknown, field: string): string {
  if (typeof value !== "string" || value.trim() === "") {
    throw new CallbackPayloadInvalidError(`${field} est obligatoire et doit être une chaîne non vide.`);
  }
  return value;
}

/** Body JSON reçu -> enveloppe typée + signature transportée séparément (jamais incluse dans le corps signé). */
export function parseCallbackRequestBody(body: unknown): { envelope: CallbackEnvelope; signature: string } {
  if (!body || typeof body !== "object" || Array.isArray(body)) {
    throw new CallbackPayloadInvalidError("le corps de la requête doit être un objet JSON.");
  }
  const raw = body as Record<string, unknown>;

  const eventId = requireNonEmptyString(raw.event_id, "event_id");
  const missionId = requireNonEmptyString(raw.mission_id, "mission_id");
  const traceId = requireNonEmptyString(raw.trace_id, "trace_id");
  const eventTypeRaw = requireNonEmptyString(raw.event_type, "event_type");
  if (!(CALLBACK_EVENT_TYPES as readonly string[]).includes(eventTypeRaw)) {
    throw new CallbackPayloadInvalidError(`event_type inconnu : ${JSON.stringify(eventTypeRaw)} (attendu l'un de : ${CALLBACK_EVENT_TYPES.join(", ")}).`);
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
  const signature = raw.signature;

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
    signature,
  };
}

// ---------------------------------------------------------------------------
// Traitement complet (auth -> version -> corrélation -> idempotence)
// ---------------------------------------------------------------------------

export interface CallbackProcessingResult {
  /** "DUPLICATE" si ce event_id avait déjà été appliqué : aucun second effet de bord. */
  outcome: "APPLIED" | "DUPLICATE";
  missionId: string;
  traceId: string;
  eventId: string;
}

/**
 * Point d'entrée unique du transport de callback : authentifie, vérifie la
 * version de contrat, corrèle à la mission réelle, puis journalise
 * l'événement de façon idempotente via `MissionStore.appendMissionEvent`
 * (PR-A) — la primitive d'idempotence par clé primaire déjà existante, sans
 * en construire une seconde. Ne fusionne rien, n'exécute aucune décision :
 * seul le journal d'événements de la mission est mis à jour.
 */
export function processCallback(rawBody: unknown, missionStore: MissionStore, now: number = Date.now()): CallbackProcessingResult {
  const { envelope, signature } = parseCallbackRequestBody(rawBody);
  verifyCallbackAuthentication(envelope, signature, now);
  assertSupportedContractVersion(envelope.schemaVersion);

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
