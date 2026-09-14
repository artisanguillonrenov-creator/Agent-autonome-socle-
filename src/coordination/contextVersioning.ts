import { createHash } from "node:crypto";
import type { ContextVersion } from "./types.js";

/** Schéma du paquet de contexte canonique (plan V5 §6) — figé pour cette fondation. */
export const CONTEXT_SCHEMA_VERSION = 2;

/**
 * Sérialisation déterministe (clés triées récursivement) avant hachage — même
 * technique que `computeRequestFingerprint`
 * (src/persistence/conversations/fingerprint.ts) : deux appelants qui
 * construisent le même contenu de contexte dans un ordre de clés différent
 * doivent obtenir le même hash. Dupliquée ici plutôt qu'importée : les deux
 * modules restent indépendants (aucun couplage entre le domaine
 * "conversations" et le domaine "coordination JARVIS-00").
 */
function stable(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(stable);
  if (value && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>)
        .sort(([a], [b]) => a.localeCompare(b))
        .map(([key, nested]) => [key, stable(nested)]),
    );
  }
  return value;
}

export function computeContextHash(content: unknown): string {
  const canonical = JSON.stringify(stable(content));
  return createHash("sha256").update(canonical).digest("hex");
}

/** Première version d'un contexte canonique pour une mission (context_version = 1, pas de hash précédent). */
export function createInitialContextVersion(input: {
  missionId: string;
  traceId: string;
  baseSha: string;
  content: unknown;
  now?: number;
}): ContextVersion {
  return {
    missionId: input.missionId,
    traceId: input.traceId,
    contextVersion: 1,
    schemaVersion: CONTEXT_SCHEMA_VERSION,
    baseSha: input.baseSha,
    previousContextHash: null,
    contextHash: computeContextHash(input.content),
    createdAt: input.now ?? Date.now(),
  };
}

/**
 * Version suivante, chaînée sur la précédente (plan V5 §6 : fusion des
 * findings → incrément context_version → nouveau SHA-256). `baseSha` est
 * repris tel quel sauf si explicitement fourni (un rebase/replan peut le
 * faire évoluer).
 */
export function advanceContextVersion(previous: ContextVersion, content: unknown, baseSha?: string): ContextVersion {
  return {
    missionId: previous.missionId,
    traceId: previous.traceId,
    contextVersion: previous.contextVersion + 1,
    schemaVersion: CONTEXT_SCHEMA_VERSION,
    baseSha: baseSha ?? previous.baseSha,
    previousContextHash: previous.contextHash,
    contextHash: computeContextHash(content),
    createdAt: Date.now(),
  };
}

/**
 * Vérifie qu'une suite de versions forme réellement une chaîne valide :
 * numéros de version strictement croissants de 1 en 1, et hash précédent de
 * chaque version égal au hash de la version qui la précède immédiatement.
 * Ne vérifie pas le contenu lui-même (aucune version de contexte en clair
 * n'est conservée par cette fondation) — seulement l'intégrité de la chaîne.
 */
export function verifyContextChain(versions: ContextVersion[]): { valid: true } | { valid: false; reason: string } {
  const sorted = [...versions].sort((a, b) => a.contextVersion - b.contextVersion);
  for (let i = 0; i < sorted.length; i += 1) {
    const version = sorted[i];
    const expectedVersionNumber = i + 1;
    if (version.contextVersion !== expectedVersionNumber) {
      return { valid: false, reason: `context_version attendu ${expectedVersionNumber}, trouvé ${version.contextVersion}` };
    }
    if (i === 0) {
      if (version.previousContextHash !== null) {
        return { valid: false, reason: "la première version ne doit avoir aucun previous_context_hash" };
      }
      continue;
    }
    const previous = sorted[i - 1];
    if (version.previousContextHash !== previous.contextHash) {
      return {
        valid: false,
        reason: `previous_context_hash de la version ${version.contextVersion} ne correspond pas au context_hash de la version ${previous.contextVersion}`,
      };
    }
  }
  return { valid: true };
}
