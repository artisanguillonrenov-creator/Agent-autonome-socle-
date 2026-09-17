/**
 * Service Capability Matrix + gap analysis globale (chantier Skills &
 * Capabilities, plan V5 §PHASE 9/11/12/17). Deux sources, jamais mélangées
 * silencieusement :
 *
 * 1. `buildServiceCapabilityMatrix()` — dérivée mécaniquement des services
 *    réellement enregistrés (`config/services.json` via ServiceRegistry,
 *    injecté par l'appelant) croisés avec le `SkillCapabilityRegistry`
 *    (skillRegistry.ts). Aucune capacité inventée : uniquement ce que le
 *    service déclare + ce que le registre sait vraiment fournir.
 *
 * 2. `SOFTWARE_FACTORY_CAPABILITY_AUDIT` — audit factuel figé de la Software
 *    Factory (§PHASE 12), transcrit d'une lecture complète de
 *    `src/services/softwareFactoryService.ts` + `src/repository/*` : chaque
 *    ligne cite le fichier réel où la capacité existe (ou son absence
 *    confirmée par recherche exhaustive dans le dépôt). Ce n'est PAS dérivé
 *    automatiquement — une capacité "interne" (ex. create_branch, embarquée
 *    dans le skill software_development) ne peut pas être détectée par un
 *    simple croisement service/skill, elle demande la lecture du code.
 */

import type { RiskLevel } from "../orchestration/contract.js";
import type { SkillStatus } from "./skillManifest.js";
import { SkillCapabilityRegistry, type SkillDuplicateGroup } from "./skillRegistry.js";
import { REAL_SKILL_CATALOG } from "./skillCatalog.js";
import type { DeduplicationVerdict, DiscoveryClassification, RemediationType } from "./remediation.js";

export interface CapabilityMatrixRow {
  service: string;
  capability: string;
  skill?: string;
  tool?: string;
  status: SkillStatus;
  proof?: string;
  dependency?: string;
  risk?: RiskLevel;
  gap: DiscoveryClassification;
  recommendedAction?: RemediationType;
  notes?: string;
}

export interface ServiceCapabilitySource {
  id: string;
  capabilities: string[];
  riskByCapability?: Record<string, RiskLevel>;
}

/** Classification par défaut d'une capacité couverte par un skill enregistré, dérivée de son statut réel — jamais devinée. */
function classifyFromStatus(status: SkillStatus): DiscoveryClassification {
  return status === "AVAILABLE" ? "EXISTING_SKILL" : status === "MISSING" ? "MISSING" : status === "DEPRECATED" ? "LEGACY" : "EXISTING_CAPABILITY";
}

/** §PHASE 14 : mappe un statut observé vers l'action de remédiation recommandée — jamais appliquée automatiquement (§PHASE 14/15). */
export function suggestRemediation(status: SkillStatus, hasProbe: boolean): RemediationType | undefined {
  switch (status) {
    case "AVAILABLE":
      return undefined;
    case "MISSING":
      return "CREATE_SKILL";
    case "NOT_TESTED":
      return hasProbe ? "ADD_TEST" : "ADD_PROBE";
    case "DEGRADED":
    case "BROKEN":
      return "FIX_SKILL";
    case "AUTH_REQUIRED":
      return "ADD_CREDENTIAL";
    case "PERMISSION_REQUIRED":
      return "ADD_PERMISSION";
    case "DEPENDENCY_MISSING":
      return "CONNECT_SERVICE";
    case "DISABLED":
      return "CONNECT_SERVICE";
    case "DEPRECATED":
      return "DEPRECATE_DUPLICATE";
    default:
      return "HUMAN_ACTION_REQUIRED";
  }
}

/**
 * Matrice service × capability dérivée mécaniquement (§PHASE 9). Pour chaque
 * capacité déclarée par un service réel, cherche un skill enregistré qui la
 * fournit et dont la portée couvre ce service ; MISSING sinon.
 */
export function buildServiceCapabilityMatrix(registry: SkillCapabilityRegistry, services: readonly ServiceCapabilitySource[]): CapabilityMatrixRow[] {
  const rows: CapabilityMatrixRow[] = [];
  for (const service of services) {
    for (const capability of service.capabilities) {
      const candidates = registry.findSkillsForService(service.id).filter((s) => s.capabilitiesProvided.includes(capability));
      const risk = service.riskByCapability?.[capability];
      if (candidates.length === 0) {
        rows.push({ service: service.id, capability, status: "MISSING", gap: "MISSING", risk, recommendedAction: "CREATE_SKILL" });
        continue;
      }
      const skill = candidates.find((s) => s.status === "AVAILABLE") ?? candidates[0]!;
      rows.push({
        service: service.id,
        capability,
        skill: skill.skillId,
        tool: skill.toolsRequired[0],
        status: skill.status,
        proof: skill.proofRefs[0],
        risk: skill.riskLevel ?? risk,
        gap: classifyFromStatus(skill.status),
        recommendedAction: suggestRemediation(skill.status, !!skill.probeId),
        notes: candidates.length > 1 ? `${candidates.length} skills candidats pour cette capacité — voir detectSkillDuplicates().` : undefined,
      });
    }
  }
  return rows;
}

/**
 * Audit factuel figé de la Software Factory (§PHASE 12) — chaque ligne a été
 * vérifiée par lecture complète de `softwareFactoryService.ts` et
 * `src/repository/*` (voir résumé dans le rapport final du chantier). Les
 * capacités "SERVICE_INTERNAL" sont couvertes par la preuve du skill
 * `software_development` qui les embarque (aucune ligne CI/build inventée).
 */
export const SOFTWARE_FACTORY_CAPABILITY_AUDIT: readonly CapabilityMatrixRow[] = Object.freeze([
  { service: "software_factory", capability: "list_tree", skill: "knowledge_search", status: "AVAILABLE", proof: "TEST:src/repository/repositoryIntelligenceEngine.test.ts", risk: "LOW", gap: "EXISTING_SKILL", notes: "browseTree() — transversal (knowledge_search), pas spécifique à software_factory." },
  { service: "software_factory", capability: "read_file", skill: "knowledge_search", status: "AVAILABLE", proof: "TEST:src/repository/repositoryIntelligenceEngine.test.ts", risk: "LOW", gap: "EXISTING_SKILL" },
  { service: "software_factory", capability: "search_code", skill: "knowledge_search", status: "AVAILABLE", proof: "TEST:src/repository/repositoryIntelligenceEngine.test.ts", risk: "LOW", gap: "EXISTING_SKILL" },
  { service: "software_factory", capability: "read_main_head", tool: "octokit.rest.git.getRef (embarqué dans SoftwareFactoryService.executeWorkflow)", status: "NOT_TESTED", risk: "LOW", gap: "TOOL_ONLY", recommendedAction: "CREATE_SKILL", notes: "Aucune capacité de lecture autonome du HEAD réel — uniquement interne au flux d'écriture." },
  { service: "software_factory", capability: "create_branch", skill: "software_development", tool: "octokit.rest.git.createRef", status: "AVAILABLE", proof: "TEST:src/services/softwareFactoryService.test.ts", risk: "MEDIUM", gap: "SERVICE_INTERNAL", notes: "Étape interne de software_development, jamais exposée seule." },
  { service: "software_factory", capability: "branch_from_exact_sha", skill: "software_development", tool: "src/services/softwareFactoryService.ts#executeWorkflow(branchFromSha)", status: "AVAILABLE", proof: "TEST:src/services/softwareFactoryService.test.ts", risk: "MEDIUM", gap: "SERVICE_INTERNAL", notes: "Câblé (tâche 5 sous-priorité 4) : branchFromSha crée la branche depuis un SHA précis (vérifié via git.getCommit, BRANCH_FROM_SHA_NOT_FOUND sinon) au lieu du HEAD courant de la branche par défaut ; le contenu existant est aussi lu à ce SHA. Incompatible avec targetBranch/targetPr (BRANCH_FROM_SHA_TARGET_CONFLICT)." },
  { service: "software_factory", capability: "stale_base_check", skill: "software_development", status: "AVAILABLE", proof: "TEST:src/services/softwareFactoryService.test.ts", risk: "MEDIUM", gap: "SERVICE_INTERNAL", notes: "expectedBaseSha / STALE_BASE — testé extensivement (PR-B.E)." },
  { service: "software_factory", capability: "create_file", skill: "software_development", status: "AVAILABLE", proof: "TEST:src/services/softwareFactoryService.test.ts", risk: "MEDIUM", gap: "SERVICE_INTERNAL" },
  { service: "software_factory", capability: "modify_file", skill: "software_development", status: "AVAILABLE", proof: "TEST:src/services/softwareFactoryService.test.ts", risk: "MEDIUM", gap: "SERVICE_INTERNAL", notes: "Remplacement fichier entier — jamais de patch par plage de lignes (choix architectural documenté, diffFidelity.ts)." },
  { service: "software_factory", capability: "delete_file", skill: "software_development", tool: "src/services/softwareFactoryService.ts#executeWorkflow(deleteFile)", status: "AVAILABLE", proof: "TEST:src/services/softwareFactoryService.test.ts", risk: "HIGH", gap: "SERVICE_INTERNAL", notes: "Câblé (tâche 5 sous-priorité 4) : deleteFile=true, opt-in explicite uniquement (jamais déduit des instructions). Mutuellement exclusif avec exactContent/oldString+newString/revertPrNumber/createIfMissing (DELETE_FILE_CONTENT_CONFLICT). Le fichier doit exister (DELETE_FILE_NOT_FOUND sinon). Réutilise octokit.rest.repos.deleteFile dans le même pipeline (branche unique, nouvelle PR) que create_file/modify_file — jamais checkDiffFidelity (sa règle de vidage de contenu rejetterait systématiquement une suppression)." },
  { service: "software_factory", capability: "surgical_edit", skill: "software_development", tool: "src/services/surgicalEdit.ts#applySurgicalEdit", status: "AVAILABLE", proof: "TEST:src/services/softwareFactoryService.test.ts", risk: "MEDIUM", gap: "SERVICE_INTERNAL", notes: "Câblé (str-replace oldString/newString, action software_development) : produit un updatedCode = fichier entier après édition, jamais un diff calculé localement — l'invariant du secret guard (fichier entier toujours scanné) reste donc valable sans adaptation (dépendance PR-B, résolue par construction plutôt que par une modification du secret guard)." },
  { service: "software_factory", capability: "diff", skill: "knowledge_search", status: "AVAILABLE", proof: "TEST:src/repository/repositoryIntelligenceEngine.test.ts", risk: "LOW", gap: "EXISTING_SKILL" },
  { service: "software_factory", capability: "fidelity_check", skill: "software_development", tool: "src/services/diffFidelity.ts#checkDiffFidelity", status: "AVAILABLE", proof: "TEST:src/services/diffFidelity.test.ts", risk: "MEDIUM", gap: "SERVICE_INTERNAL" },
  { service: "software_factory", capability: "secret_scan", skill: "software_development", tool: "src/repository/secretScanner.ts#scanForSecrets", status: "AVAILABLE", proof: "TEST:src/repository/secretScanner.test.ts", risk: "HIGH", gap: "SERVICE_INTERNAL", notes: "Deux couches : garde pré-écriture + rédaction en lecture (repositoryIntelligenceEngine)." },
  { service: "software_factory", capability: "run_build", skill: "software_development", tool: "src/services/softwareFactoryService.ts#runBuildCheck", status: "AVAILABLE", proof: "TEST:src/services/softwareFactoryService.test.ts", risk: "MEDIUM", gap: "SERVICE_INTERNAL", notes: "Vérification sandboxée nommée (tâche 5 sous-priorité 3) : même mécanisme que la validation sandboxée générique déjà existante (config.softwareFactorySandbox.validationCommand) — uniquement le fichier patché monté, jamais le dépôt hôte ni npm install/git clone. Désactivée par défaut (buildCommand vide)." },
  { service: "software_factory", capability: "run_tests", skill: "software_development", tool: "src/services/softwareFactoryService.ts#runTestCheck", status: "AVAILABLE", proof: "TEST:src/services/softwareFactoryService.test.ts", risk: "MEDIUM", gap: "SERVICE_INTERNAL", notes: "Même mécanisme que run_build, commande/config distincte (testCommand)." },
  { service: "software_factory", capability: "run_lint", skill: "software_development", tool: "src/services/softwareFactoryService.ts#runLintCheck", status: "AVAILABLE", proof: "TEST:src/services/softwareFactoryService.test.ts", risk: "MEDIUM", gap: "SERVICE_INTERNAL", notes: "Même mécanisme que run_build, commande/config distincte (lintCommand)." },
  { service: "software_factory", capability: "run_typecheck", skill: "software_development", tool: "src/services/softwareFactoryService.ts#runTypecheckCheck", status: "AVAILABLE", proof: "TEST:src/services/softwareFactoryService.test.ts", risk: "MEDIUM", gap: "SERVICE_INTERNAL", notes: "Même mécanisme que run_build, commande/config distincte (typecheckCommand)." },
  { service: "software_factory", capability: "create_pr", skill: "software_development", tool: "octokit.rest.pulls.create", status: "AVAILABLE", proof: "TEST:src/services/softwareFactoryService.test.ts", risk: "MEDIUM", gap: "SERVICE_INTERNAL" },
  { service: "software_factory", capability: "read_pr", skill: "knowledge_search", status: "AVAILABLE", proof: "TEST:src/repository/repositoryIntelligenceEngine.test.ts", risk: "LOW", gap: "EXISTING_SKILL" },
  { service: "software_factory", capability: "read_diff", skill: "knowledge_search", status: "AVAILABLE", proof: "TEST:src/repository/repositoryIntelligenceEngine.test.ts", risk: "LOW", gap: "EXISTING_SKILL" },
  { service: "software_factory", capability: "read_ci_status", skill: "knowledge_search", tool: "src/repository/githubReadOnlyClient.ts#getCiStatus", status: "AVAILABLE", proof: "TEST:src/skills/knowledgeSearch.test.ts", risk: "LOW", gap: "EXISTING_SKILL", notes: "Câblé PR-G comme action CI_STATUS de knowledge_search (src/skills/runtime.ts) — appelant réel en production, plus un simple import isolé (voir skillCatalog.ts)." },
  { service: "software_factory", capability: "read_main_protection", skill: "knowledge_search", tool: "src/repository/githubReadOnlyClient.ts#getMainProtectionStatus", status: "AVAILABLE", proof: "TEST:src/skills/knowledgeSearch.test.ts", risk: "LOW", gap: "EXISTING_SKILL", notes: "Câblé PR-G comme action MAIN_PROTECTION de knowledge_search (src/skills/runtime.ts) — appelant réel en production, plus un simple import isolé." },
  { service: "software_factory", capability: "resume", status: "MISSING", risk: "MEDIUM", gap: "MISSING", recommendedAction: "HUMAN_ACTION_REQUIRED", notes: "Aucun resume spécifique au build Software Factory (le resume existant est celui de MultiAgentCoordinator, sous-système différent) — décision de conception à trancher." },
  { service: "software_factory", capability: "retry", tool: "src/orchestration/operationStore.ts (retryable/retry_count générique)", status: "AVAILABLE", proof: "TEST:src/orchestration/e2e.test.ts", risk: "LOW", gap: "TOOL_ONLY", notes: "Plomberie de retry générique au dispatch, pas une capacité Software-Factory-spécifique." },
  { service: "software_factory", capability: "rollback", skill: "software_development", tool: "src/services/softwareFactoryService.ts#executeWorkflow(revertPrNumber)", status: "AVAILABLE", proof: "TEST:src/services/softwareFactoryService.test.ts", risk: "HIGH", gap: "SERVICE_INTERNAL", notes: "Câblé (revertPrNumber, action software_development) : annuler une PR mono-fichier ouvre une nouvelle PR propre restaurant le contenu d'avant cette PR, plutôt que d'empiler un nouveau chantier par-dessus. Limité aux PR mono-fichier et refuse une PR qui a créé le fichier (exigerait delete_file, toujours MISSING)." },
  { service: "software_factory", capability: "generate_revert_pr", skill: "software_development", tool: "src/services/softwareFactoryService.ts#executeWorkflow(revertPrNumber)", status: "AVAILABLE", proof: "TEST:src/services/softwareFactoryService.test.ts", risk: "MEDIUM", gap: "SERVICE_INTERNAL", notes: "Même mécanisme que rollback ci-dessus — pas une capacité distincte, la même implémentation les couvre toutes les deux." },
]);

export interface ArchitecturalOverlap {
  items: string[];
  verdict: DeduplicationVerdict;
  reason: string;
}

/**
 * Chevauchements architecturaux constatés à l'audit qu'aucun croisement
 * programmatique ne peut détecter (noms différents, même rôle) — §PHASE 17.
 * Verdict volontairement UNKNOWN : "ne supprime rien automatiquement sans
 * preuve que c'est inutilisé" (§PHASE 17) — un humain tranche.
 */
export const KNOWN_ARCHITECTURAL_OVERLAPS: readonly ArchitecturalOverlap[] = Object.freeze([
  {
    items: ["src/skills/builtin/tasks.ts#TaskStore instance", "src/skills/runtime.ts#createRuntimeSkills TaskStore instance"],
    verdict: "UNKNOWN",
    reason: "Deux instances TaskStore indépendantes sur la même table SQLite, exposées par deux familles de skills distinctes (create_task/list_tasks/complete_task vs schedule_task/monitor_condition/inspect_task/cancel_task). Pas un bug de cohérence des données, mais une surface dupliquée pour le LLM — à évaluer par un humain avant toute fusion.",
  },
  {
    items: ["src/orchestration/contract.ts#RiskLevel", "src/types.ts#SkillRisk", "src/types.ts#PendingActionRisk"],
    verdict: "UNKNOWN",
    reason: "Trois alias de type distincts portant exactement le même ensemble de valeurs (LOW|MEDIUM|HIGH|CRITICAL), jamais unifiés. Aucune divergence de valeur constatée — risque de dérive future si un seul est étendu sans les deux autres.",
  },
  {
    items: ["src/repository/githubReadOnlyClient.ts#getCiStatus/getMainProtectionStatus", "src/coordination/contracts.ts#AuditPacketInput"],
    verdict: "UNKNOWN",
    reason: "Les deux moitiés d'un pipeline Reviewer Gate (lecture CI/protection + contrat AuditPacket) existent et sont testées séparément, mais rien ne les relie en production — ni doublon ni bug, juste une intégration manquante (cf. gap read_ci_status/read_main_protection ci-dessus).",
  },
]);

export interface GapAnalysisReport {
  matrix: CapabilityMatrixRow[];
  duplicates: SkillDuplicateGroup[];
  architecturalOverlaps: ArchitecturalOverlap[];
  missingCapabilities: string[];
}

/** Assemble le rapport complet (§PHASE 9/17) à partir du registre peuplé et des services réellement enregistrés. */
export function buildGapAnalysisReport(registry: SkillCapabilityRegistry, services: readonly ServiceCapabilitySource[], requiredCapabilityIds: readonly string[] = []): GapAnalysisReport {
  return {
    matrix: [...buildServiceCapabilityMatrix(registry, services), ...SOFTWARE_FACTORY_CAPABILITY_AUDIT],
    duplicates: registry.detectSkillDuplicates(),
    architecturalOverlaps: [...KNOWN_ARCHITECTURAL_OVERLAPS],
    missingCapabilities: registry.detectMissingCapabilities(requiredCapabilityIds),
  };
}

/** Peuple un SkillCapabilityRegistry avec le catalogue réel audité (skillCatalog.ts) — point d'entrée unique pour la production comme pour les tests. */
export function createPopulatedRegistry(): SkillCapabilityRegistry {
  const registry = new SkillCapabilityRegistry();
  for (const skill of REAL_SKILL_CATALOG) registry.registerSkill(skill);
  return registry;
}
