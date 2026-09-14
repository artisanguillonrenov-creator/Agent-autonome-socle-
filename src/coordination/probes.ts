/**
 * Probes réels (chantier Skills & Capabilities, plan V5 §PHASE 6). Un probe
 * vérifie qu'une capacité fonctionne VRAIMENT (pas juste "le fichier
 * existe", §PHASE 7) en exécutant l'opération réelle sous-jacente — jamais
 * un mock du probe lui-même.
 *
 * Toujours non destructif : chaque fabrique de probe ci-dessous appelle une
 * fonction de lecture existante (`readDocument`, `runDatabaseQuery` en
 * SELECT, `readRepositoryFile`, `getCiStatus`/`getMainProtectionStatus`,
 * un provider de recherche Web) ou une action confinée à un environnement de
 * test — jamais une écriture, jamais un create_branch/merge réel. Les
 * dépendances (client GitHub, WorkspaceStore, provider de recherche) sont
 * injectées, comme partout ailleurs dans ce dépôt (`createRuntimeSkills`,
 * `src/skills/mcp/fixtures/fakeStdioServer.mjs`) : la production y branche
 * les instances réelles, les tests y branchent des fixtures déterministes —
 * jamais un mock du RÉSULTAT du probe lui-même.
 */

import type { WorkspaceStore } from "../workspaces/workspaceStore.js";
import { readDocument } from "../workbench/documentEngine.js";
import { runDatabaseQuery } from "../workbench/databaseEngine.js";
import type { GithubReadOnlyClient, RepoRef } from "../repository/githubReadOnlyClient.js";
import { readRepositoryFile, resolveRef } from "../repository/repositoryIntelligenceEngine.js";

export interface ProbeResult {
  probeId: string;
  serviceId: string;
  capabilityId: string;
  skillId: string;
  success: boolean;
  timestamp: number;
  evidenceRef: string;
  errorCode?: string;
}

export interface ProbeDefinition {
  probeId: string;
  serviceId: string;
  capabilityId: string;
  skillId: string;
  /** Doit toujours être non destructif (lecture seule, ou action bornée à un fixture/environnement de test). */
  run: () => Promise<{ success: boolean; evidenceRef: string; errorCode?: string }>;
}

/** Exécute un ProbeDefinition et normalise le résultat — un probe qui lève une exception est un échec, jamais une exception qui remonte. */
export async function runProbe(def: ProbeDefinition): Promise<ProbeResult> {
  const timestamp = Date.now();
  try {
    const outcome = await def.run();
    return { probeId: def.probeId, serviceId: def.serviceId, capabilityId: def.capabilityId, skillId: def.skillId, timestamp, ...outcome };
  } catch (err) {
    return {
      probeId: def.probeId,
      serviceId: def.serviceId,
      capabilityId: def.capabilityId,
      skillId: def.skillId,
      timestamp,
      success: false,
      evidenceRef: "n/a",
      errorCode: err instanceof Error ? err.message : "PROBE_UNKNOWN_ERROR",
    };
  }
}

/** Probe `document_work`/`document_read` : lit réellement un fichier connu d'un workspace (§PHASE 6 exemple "document_read → document fixture"). */
export function createDocumentReadProbe(opts: {
  probeId: string;
  serviceId: string;
  skillId: string;
  workspaces: WorkspaceStore;
  workspaceId: string;
  path: string;
}): ProbeDefinition {
  return {
    probeId: opts.probeId,
    serviceId: opts.serviceId,
    capabilityId: "document_work",
    skillId: opts.skillId,
    run: async () => {
      const result = await readDocument(opts.workspaces, opts.workspaceId, opts.path);
      return { success: !!result, evidenceRef: `workspace:${opts.workspaceId}/${opts.path}` };
    },
  };
}

/** Probe `database_query` : SELECT contrôlé (§PHASE 6 "database_query → SELECT contrôlé"), jamais une écriture. */
export function createDatabaseQueryProbe(opts: {
  probeId: string;
  serviceId: string;
  skillId: string;
  workspaces: WorkspaceStore;
  workspaceId: string;
  path: string;
}): ProbeDefinition {
  return {
    probeId: opts.probeId,
    serviceId: opts.serviceId,
    capabilityId: "database_query",
    skillId: opts.skillId,
    run: async () => {
      const result = runDatabaseQuery(opts.workspaces, opts.workspaceId, opts.path, "SELECT 1 AS probe");
      return { success: result.rows.length === 1, evidenceRef: `workspace:${opts.workspaceId}/${opts.path}#SELECT 1` };
    },
  };
}

/** Probe `knowledge_search`/repository intelligence : lit réellement un fichier connu (§PHASE 6 "read_repository → lire réellement un fichier connu"). */
export function createRepositoryReadProbe(opts: {
  probeId: string;
  serviceId: string;
  skillId: string;
  client: GithubReadOnlyClient;
  target: RepoRef;
  knownPath: string;
  ref?: string;
}): ProbeDefinition {
  return {
    probeId: opts.probeId,
    serviceId: opts.serviceId,
    capabilityId: "knowledge_search",
    skillId: opts.skillId,
    run: async () => {
      const ref = await resolveRef(opts.client, opts.target, opts.ref);
      const file = await readRepositoryFile(opts.client, opts.target, ref, opts.knownPath);
      return { success: !file.blocked && !file.isDirectory, evidenceRef: `${opts.target.owner}/${opts.target.repo}@${ref}:${opts.knownPath}` };
    },
  };
}

/** Probe `read_ci_status` : lit réellement le statut CI d'un SHA connu — capacité PR-C existante mais jusqu'ici sans aucun appelant en production (voir gap analysis). */
export function createCiStatusProbe(opts: { probeId: string; serviceId: string; skillId: string; client: GithubReadOnlyClient; target: RepoRef; sha: string }): ProbeDefinition {
  return {
    probeId: opts.probeId,
    serviceId: opts.serviceId,
    capabilityId: "read_ci_status",
    skillId: opts.skillId,
    run: async () => {
      const result = await opts.client.getCiStatus(opts.target, opts.sha);
      return { success: !!result.sha, evidenceRef: `${opts.target.owner}/${opts.target.repo}@${result.sha}#${result.overallState}` };
    },
  };
}

/** Probe `read_main_protection` : lit réellement la protection de branche — jamais destructif (getMainProtectionStatus ne modifie aucun réglage). */
export function createMainProtectionProbe(opts: { probeId: string; serviceId: string; skillId: string; client: GithubReadOnlyClient; target: RepoRef; branch: string }): ProbeDefinition {
  return {
    probeId: opts.probeId,
    serviceId: opts.serviceId,
    capabilityId: "read_main_protection",
    skillId: opts.skillId,
    run: async () => {
      const result = await opts.client.getMainProtectionStatus(opts.target, opts.branch);
      const unverified = result.status === "MAIN_PROTECTION_UNVERIFIED";
      return { success: !unverified, evidenceRef: `${opts.target.owner}/${opts.target.repo}#${opts.branch}:${result.status}`, errorCode: unverified ? result.reason : undefined };
    },
  };
}

/** Probe `web_search` : requête contrôlée (§PHASE 6 "web_search → requête contrôlée"). */
export function createWebSearchProbe(opts: {
  probeId: string;
  serviceId: string;
  skillId: string;
  search: (query: string) => Promise<unknown[]>;
  query: string;
}): ProbeDefinition {
  return {
    probeId: opts.probeId,
    serviceId: opts.serviceId,
    capabilityId: "web_search",
    skillId: opts.skillId,
    run: async () => {
      const results = await opts.search(opts.query);
      return { success: Array.isArray(results), evidenceRef: `query:${opts.query}#${Array.isArray(results) ? results.length : 0}` };
    },
  };
}
