/**
 * Fondations JARVIS-00 (Coordination IA) — contrats typés uniquement.
 *
 * Ce module ne dépend d'aucune API GitHub, d'aucun provider LLM et d'aucun
 * workflow n8n : c'est la brique de données pure (mission / journal
 * d'événements / versioning de contexte) que JARVIS-00 (n8n), Software
 * Factory, un futur endpoint de callback et le Reviewer Gate pourront
 * consommer une fois construits. Sans rapport avec `MissionConsolidator`
 * (src/planning/missionConsolidator.ts), qui condense le résultat final
 * d'un `PlanRun` — "mission" y désigne ici l'unité de coordination
 * JARVIS-00 du plan V5 (mission_id/trace_id/context_version/row_version).
 */

/** États officiels du cycle JARVIS-00 (plan V5 §15). */
export type MissionStatus =
  | "RECEIVED"
  | "CONTEXT_READY"
  | "ARCHITECT_PLANNED"
  | "CRITIC_REVIEWED"
  | "PLAN_CONSOLIDATED"
  | "MAX_ROUNDS_EXCEEDED"
  | "WAITING_EXTERNAL_AI"
  | "PROVIDER_BLOCKED"
  | "WAITING_HUMAN"
  | "APPROVED_FOR_BUILD"
  | "LOCKED"
  | "BUILDING"
  | "PR_CREATED"
  | "CI_RUNNING"
  | "CI_FAILED"
  | "REVIEWING"
  | "GO_FUSION"
  | "REFUS_FUSION"
  | "WAITING_MERGE_APPROVAL"
  | "MERGED"
  | "ROLLED_BACK"
  | "CANCELLED"
  | "FAILED";

export const MISSION_STATUSES: ReadonlySet<MissionStatus> = new Set([
  "RECEIVED", "CONTEXT_READY", "ARCHITECT_PLANNED", "CRITIC_REVIEWED", "PLAN_CONSOLIDATED",
  "MAX_ROUNDS_EXCEEDED", "WAITING_EXTERNAL_AI", "PROVIDER_BLOCKED", "WAITING_HUMAN",
  "APPROVED_FOR_BUILD", "LOCKED", "BUILDING", "PR_CREATED", "CI_RUNNING", "CI_FAILED",
  "REVIEWING", "GO_FUSION", "REFUS_FUSION", "WAITING_MERGE_APPROVAL", "MERGED",
  "ROLLED_BACK", "CANCELLED", "FAILED",
]);

/**
 * Registre mission — état vivant minimal (plan V5 §5.1/§60). Volontairement
 * réduit au périmètre PR-A : les champs métier (objective, repo, pr_number,
 * risk, ...) et le verrou de repo appartiennent à des PR ultérieures.
 */
export interface Mission {
  missionId: string;
  traceId: string;
  projectId: string;
  status: MissionStatus;
  createdAt: number;
  updatedAt: number;
  /** Concurrence optimiste (plan V5 §60) — incrémenté à chaque mutation de la ligne. */
  rowVersion: number;
  /** Dernière séquence d'événement effectivement appliquée à cette mission. */
  lastEventSequence: number;
}

/**
 * Entrée du journal d'événements — append-only par construction : la clé
 * primaire (event_id) empêche toute réécriture, et l'unicité de
 * (mission_id, sequence) empêche toute réutilisation d'un numéro de
 * séquence déjà consommé (plan V5 §5.2).
 *
 * Exactement un de `payload`/`payloadRef` doit être fourni : les gros
 * contenus ne doivent jamais être stockés inline dans le journal (plan V5
 * §5.4) — `payloadRef` porte alors un pointeur (PR, artefact, etc.) vers le
 * contenu réel, géré par une couche ultérieure.
 */
export interface MissionEvent {
  eventId: string;
  missionId: string;
  traceId: string;
  sequence: number;
  eventType: string;
  timestamp: number;
  payload?: Record<string, unknown>;
  payloadRef?: string;
}

/**
 * Une version de contexte canonique (plan V5 §6). Chaînée par hash : chaque
 * version référence le hash de la version précédente, formant un journal
 * d'intégrité vérifiable indépendamment du contenu lui-même.
 */
export interface ContextVersion {
  missionId: string;
  traceId: string;
  contextVersion: number;
  schemaVersion: number;
  baseSha: string;
  previousContextHash: string | null;
  contextHash: string;
  createdAt: number;
}

export class MissionNotFoundError extends Error {
  readonly code = "MISSION_NOT_FOUND" as const;
  constructor(readonly missionId: string) {
    super(`Mission introuvable : ${missionId}.`);
    this.name = "MissionNotFoundError";
  }
}

/** Conflit de concurrence optimiste (plan V5 §60) — jamais d'écrasement silencieux d'un état plus récent. */
export class MissionStateConflictError extends Error {
  readonly code = "MISSION_STATE_CONFLICT" as const;
  constructor(
    readonly missionId: string,
    readonly expectedRowVersion: number,
    readonly actualRowVersion: number,
  ) {
    super(
      `MISSION_STATE_CONFLICT : mission ${missionId}, row_version attendu ${expectedRowVersion}, actuel ${actualRowVersion}.`,
    );
    this.name = "MissionStateConflictError";
  }
}

export class MissionEventSequenceError extends Error {
  readonly code = "EVENT_SEQUENCE_INVALID" as const;
  constructor(
    readonly missionId: string,
    readonly attemptedSequence: number,
    readonly lastEventSequence: number,
  ) {
    super(
      `EVENT_SEQUENCE_INVALID : mission ${missionId}, séquence ${attemptedSequence} doit être strictement supérieure à la dernière séquence appliquée (${lastEventSequence}).`,
    );
    this.name = "MissionEventSequenceError";
  }
}

export class MissionEventPayloadError extends Error {
  readonly code = "EVENT_PAYLOAD_INVALID" as const;
  constructor(message: string) {
    super(`EVENT_PAYLOAD_INVALID : ${message}`);
    this.name = "MissionEventPayloadError";
  }
}

export class ContextVersionError extends Error {
  readonly code = "CONTEXT_VERSION_INVALID" as const;
  constructor(message: string) {
    super(`CONTEXT_VERSION_INVALID : ${message}`);
    this.name = "ContextVersionError";
  }
}
export interface N8nIntakePayload {
  schema_version: number;
  mission_id?: string;
  trace_id: string;
  project_id: string;
  status: MissionStatus;
  event_type?: string;
  event_id?: string;
  sequence?: number;
  payload?: Record<string, unknown>;
  payloadRef?: string;
  timestamp: number;
}

export interface N8nIntakeResult {
  ok: boolean;
  missionId?: string;
  error?: string;
}