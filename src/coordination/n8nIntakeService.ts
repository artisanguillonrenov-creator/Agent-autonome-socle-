import { MissionStore } from "./missionStore.js";
import { verifyHmac } from "./hmacUtils.js";
import type { N8nIntakePayload, N8nIntakeResult } from "./types.js";

const SUPPORTED_SCHEMA_VERSIONS = new Set([1, 2]);
const CURRENT_SCHEMA_VERSION = 2;

/**
 * Service d'intake sécurisée des missions et événements venant de n8n.
 * Valide HMAC, schéma version, et délègue la persistance idempotente et la
 * gestion des conflits de concurrence à `MissionStore`.
 */
export class N8nIntakeService {
  constructor(private readonly missionStore: MissionStore = new MissionStore()) {}

  process(payload: N8nIntakePayload, signature: string, secret: string): N8nIntakeResult {
    if (!verifyHmac(JSON.stringify(payload), signature, secret)) {
      return { ok: false, error: "HMAC_VERIFICATION_FAILED" };
    }

    if (!SUPPORTED_SCHEMA_VERSIONS.has(payload.schema_version)) {
      return { ok: false, error: `SCHEMA_VERSION_UNSUPPORTED : version ${payload.schema_version}` };
    }

    try {
      const mission = this.missionStore.createMission({
        missionId: payload.mission_id,
        traceId: payload.trace_id,
        projectId: payload.project_id,
        status: payload.status,
      });

      if (payload.event_type && payload.event_id && payload.sequence !== undefined) {
        const latest = this.missionStore.getMission(mission.missionId);
        if (latest) {
          this.missionStore.appendMissionEvent(
            {
              eventId: payload.event_id,
              missionId: mission.missionId,
              traceId: payload.trace_id,
              sequence: payload.sequence,
              eventType: payload.event_type,
              timestamp: payload.timestamp,
              ...(payload.payload !== undefined ? { payload: payload.payload } : {}),
              ...(payload.payloadRef !== undefined ? { payloadRef: payload.payloadRef } : {}),
            },
            latest.rowVersion,
          );
        }
      }

      if (mission.status !== payload.status) {
        const updated = this.missionStore.updateMissionStatus(mission.missionId, mission.rowVersion, payload.status);
        return { ok: true, missionId: updated.missionId };
      }

      return { ok: true, missionId: mission.missionId };
    } catch (error) {
      const code = (error as Error).code ?? "INTAKE_PROCESSING_ERROR";
      return { ok: false, error: `${code} : ${(error as Error).message}` };
    }
  }
}