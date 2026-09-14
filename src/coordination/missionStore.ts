import { randomUUID } from "node:crypto";
import { getDb } from "../persistence/db.js";
import {
  ContextVersionError,
  MissionEventPayloadError,
  MissionEventSequenceError,
  MissionNotFoundError,
  MissionStateConflictError,
  MISSION_STATUSES,
  type ContextVersion,
  type Mission,
  type MissionEvent,
  type MissionStatus,
} from "./types.js";

interface MissionRow {
  mission_id: string;
  trace_id: string;
  project_id: string;
  status: string;
  row_version: number;
  last_event_sequence: number;
  created_at: number;
  updated_at: number;
}

function fromRow(row: MissionRow): Mission {
  return {
    missionId: row.mission_id,
    traceId: row.trace_id,
    projectId: row.project_id,
    status: row.status as MissionStatus,
    rowVersion: row.row_version,
    lastEventSequence: row.last_event_sequence,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

/**
 * Fondations JARVIS-00 : registre mission, journal d'événements append-only
 * et versioning de contexte chaîné par hash. Aucun appel réseau, aucune
 * dépendance GitHub — persistance SQLite pure via `getDb()` (même base que
 * le reste du dépôt, cf. src/persistence/db.ts), au même titre que
 * `OperationStore` (src/orchestration/operationStore.ts) dont cette classe
 * reprend délibérément les conventions (idempotence par clé primaire,
 * concurrence optimiste, erreurs structurées) sans dupliquer son code —
 * `OperationStore` reste la brique de dispatch de service, celle-ci est le
 * registre de mission JARVIS-00, à un autre niveau.
 */
export class MissionStore {
  /**
   * Idempotent par `missionId` : si une mission portant cet identifiant
   * existe déjà, elle est retournée telle quelle plutôt que recréée ou
   * modifiée — un appelant (n8n) qui rejoue une requête d'intake avec le
   * même `mission_id` ne doit jamais produire une seconde mission (plan V5
   * §14.A : "Si mission_id est absent, n8n en crée un").
   */
  createMission(input: { missionId?: string; traceId: string; projectId: string; status?: MissionStatus }): Mission {
    const missionId = input.missionId ?? randomUUID();
    const existing = this.getMission(missionId);
    if (existing) return existing;

    const status = input.status ?? "RECEIVED";
    if (!MISSION_STATUSES.has(status)) throw new Error(`MISSION_STATUS_INVALID : ${status}`);

    const db = getDb();
    const now = Date.now();
    db.prepare(
      `INSERT INTO jarvis00_missions (mission_id, trace_id, project_id, status, row_version, last_event_sequence, created_at, updated_at)
       VALUES (?, ?, ?, ?, 1, 0, ?, ?)`,
    ).run(missionId, input.traceId, input.projectId, status, now, now);

    return this.getMission(missionId)!;
  }

  getMission(missionId: string): Mission | null {
    const row = getDb().prepare(`SELECT * FROM jarvis00_missions WHERE mission_id = ?`).get(missionId) as MissionRow | undefined;
    return row ? fromRow(row) : null;
  }

  /**
   * Concurrence optimiste (plan V5 §60) : la mise à jour n'a lieu que si la
   * ligne est toujours à `expectedRowVersion`. En cas de conflit, rejette
   * avec `MissionStateConflictError` plutôt que d'écraser silencieusement un
   * état plus récent — l'appelant doit relire la mission et réessayer.
   */
  updateMissionStatus(missionId: string, expectedRowVersion: number, nextStatus: MissionStatus): Mission {
    if (!MISSION_STATUSES.has(nextStatus)) throw new Error(`MISSION_STATUS_INVALID : ${nextStatus}`);
    const current = this.getMission(missionId);
    if (!current) throw new MissionNotFoundError(missionId);

    const db = getDb();
    const now = Date.now();
    const changed = db
      .prepare(
        `UPDATE jarvis00_missions SET status = ?, row_version = row_version + 1, updated_at = ?
         WHERE mission_id = ? AND row_version = ?`,
      )
      .run(nextStatus, now, missionId, expectedRowVersion).changes;

    if (changed === 0) {
      const latest = this.getMission(missionId);
      if (!latest) throw new MissionNotFoundError(missionId);
      throw new MissionStateConflictError(missionId, expectedRowVersion, latest.rowVersion);
    }
    return this.getMission(missionId)!;
  }

  /**
   * Ajoute un événement au journal append-only et avance `last_event_sequence`
   * sur la mission dans la même transaction. Idempotent par `eventId` (clé
   * primaire de `jarvis00_mission_events`) : rejouer le même `event_id`
   * renvoie `{ duplicate: true, applied: false }` plutôt que d'échouer ou de
   * dupliquer une ligne — même principe que
   * `OperationStore.processEvent`/`processed_service_events`, sans en
   * dupliquer le code (domaines distincts : dispatch de service vs registre
   * de mission JARVIS-00).
   *
   * Exactement un de `event.payload`/`event.payloadRef` doit être fourni
   * (plan V5 §5.4 : jamais de gros contenu inline dans la ligne mission).
   *
   * Concurrence optimiste également appliquée ici : `expectedRowVersion` doit
   * correspondre à la version courante de la mission, faute de quoi
   * `MissionStateConflictError` est levée — appendMissionEvent modifie la
   * ligne mission (last_event_sequence, row_version) au même titre que
   * `updateMissionStatus`.
   */
  appendMissionEvent(event: MissionEvent, expectedRowVersion: number): { duplicate: boolean; applied: boolean } {
    const hasPayload = event.payload !== undefined;
    const hasPayloadRef = event.payloadRef !== undefined;
    if (hasPayload === hasPayloadRef) {
      throw new MissionEventPayloadError("exactement un de payload/payloadRef doit être fourni, jamais les deux ni aucun");
    }

    const mission = this.getMission(event.missionId);
    if (!mission) throw new MissionNotFoundError(event.missionId);
    if (mission.traceId !== event.traceId) {
      throw new Error(`EVENT_TRACE_MISMATCH : événement trace_id=${event.traceId} pour mission trace_id=${mission.traceId}`);
    }

    const db = getDb();

    const existing = db.prepare(`SELECT 1 FROM jarvis00_mission_events WHERE event_id = ?`).get(event.eventId);
    if (existing) return { duplicate: true, applied: false };

    if (event.sequence <= mission.lastEventSequence) {
      throw new MissionEventSequenceError(event.missionId, event.sequence, mission.lastEventSequence);
    }

    const applied = db.transaction(() => {
      db.prepare(
        `INSERT INTO jarvis00_mission_events (event_id, mission_id, trace_id, sequence, event_type, timestamp, payload_json, payload_ref, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      ).run(
        event.eventId,
        event.missionId,
        event.traceId,
        event.sequence,
        event.eventType,
        event.timestamp,
        hasPayload ? JSON.stringify(event.payload) : null,
        hasPayloadRef ? event.payloadRef! : null,
        Date.now(),
      );

      const now = Date.now();
      const changed = db
        .prepare(
          `UPDATE jarvis00_missions SET last_event_sequence = ?, row_version = row_version + 1, updated_at = ?
           WHERE mission_id = ? AND row_version = ?`,
        )
        .run(event.sequence, now, event.missionId, expectedRowVersion).changes;

      if (changed === 0) {
        // Provoque le rollback de la transaction : ni l'événement ni l'avancement
        // de séquence ne doivent survivre à un conflit de concurrence.
        const latest = db.prepare(`SELECT row_version FROM jarvis00_missions WHERE mission_id = ?`).get(event.missionId) as
          | { row_version: number }
          | undefined;
        throw new MissionStateConflictError(event.missionId, expectedRowVersion, latest?.row_version ?? -1);
      }
      return true;
    })();

    return { duplicate: false, applied };
  }

  listMissionEvents(missionId: string): MissionEvent[] {
    const rows = getDb()
      .prepare(
        `SELECT event_id, mission_id, trace_id, sequence, event_type, timestamp, payload_json, payload_ref
         FROM jarvis00_mission_events WHERE mission_id = ? ORDER BY sequence ASC`,
      )
      .all(missionId) as Array<{
      event_id: string;
      mission_id: string;
      trace_id: string;
      sequence: number;
      event_type: string;
      timestamp: number;
      payload_json: string | null;
      payload_ref: string | null;
    }>;

    return rows.map((row) => ({
      eventId: row.event_id,
      missionId: row.mission_id,
      traceId: row.trace_id,
      sequence: row.sequence,
      eventType: row.event_type,
      timestamp: row.timestamp,
      payload: row.payload_json !== null ? (JSON.parse(row.payload_json) as Record<string, unknown>) : undefined,
      payloadRef: row.payload_ref ?? undefined,
    }));
  }

  /**
   * Enregistre une version de contexte pour une mission. Append-only par
   * construction : la clé primaire (mission_id, context_version) refuse
   * toute réécriture d'une version déjà enregistrée. Rejette avec
   * `ContextVersionError` si la version n'enchaîne pas correctement sur la
   * dernière connue (numéro non consécutif, ou hash précédent incohérent) —
   * ne réutilise pas `verifyContextChain` en boucle (coûteux), revalide
   * seulement la transition entrante contre la dernière version stockée.
   */
  recordContextVersion(version: ContextVersion): ContextVersion {
    const mission = this.getMission(version.missionId);
    if (!mission) throw new MissionNotFoundError(version.missionId);

    const db = getDb();
    const last = db
      .prepare(
        `SELECT context_version, context_hash FROM jarvis00_context_versions
         WHERE mission_id = ? ORDER BY context_version DESC LIMIT 1`,
      )
      .get(version.missionId) as { context_version: number; context_hash: string } | undefined;

    if (!last) {
      if (version.contextVersion !== 1 || version.previousContextHash !== null) {
        throw new ContextVersionError("la première version d'une mission doit être context_version=1 avec previous_context_hash=null");
      }
    } else {
      if (version.contextVersion !== last.context_version + 1) {
        throw new ContextVersionError(`context_version attendu ${last.context_version + 1}, reçu ${version.contextVersion}`);
      }
      if (version.previousContextHash !== last.context_hash) {
        throw new ContextVersionError("previous_context_hash ne correspond pas au context_hash de la dernière version enregistrée");
      }
    }

    db.prepare(
      `INSERT INTO jarvis00_context_versions (mission_id, trace_id, context_version, schema_version, base_sha, previous_context_hash, context_hash, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run(
      version.missionId,
      version.traceId,
      version.contextVersion,
      version.schemaVersion,
      version.baseSha,
      version.previousContextHash,
      version.contextHash,
      version.createdAt,
    );

    return version;
  }

  listContextVersions(missionId: string): ContextVersion[] {
    const rows = getDb()
      .prepare(
        `SELECT mission_id, trace_id, context_version, schema_version, base_sha, previous_context_hash, context_hash, created_at
         FROM jarvis00_context_versions WHERE mission_id = ? ORDER BY context_version ASC`,
      )
      .all(missionId) as Array<{
      mission_id: string;
      trace_id: string;
      context_version: number;
      schema_version: number;
      base_sha: string;
      previous_context_hash: string | null;
      context_hash: string;
      created_at: number;
    }>;

    return rows.map((row) => ({
      missionId: row.mission_id,
      traceId: row.trace_id,
      contextVersion: row.context_version,
      schemaVersion: row.schema_version,
      baseSha: row.base_sha,
      previousContextHash: row.previous_context_hash,
      contextHash: row.context_hash,
      createdAt: row.created_at,
    }));
  }
}
