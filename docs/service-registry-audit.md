# Audit registre de services ↔ handlers (point A.1)

Vérification effectuée le 2026-09-12, suite à l'audit du 12 septembre 2026.

## Méthode

Pour chaque entrée de `config/services.json`, recherche du handler correspondant
dans `src/services/` et de son enregistrement dans `src/orchestration/`.

## Correspondance vérifiée

| `id` (services.json) | Handler (`src/services/`) | Enregistrement (`src/orchestration/`) |
|---|---|---|
| `software_factory` | `SoftwareFactoryService` (softwareFactoryService.ts) | `ServiceAdapter` constructeur (`serviceAdapter.ts:21`) |
| `workspace_service` | `WorkspaceService` (workspaceService.ts) | `ServiceOrchestrator` constructeur (`serviceOrchestrator.ts:115`) |
| `research_service` | `ResearchService` (researchService.ts) | `serviceOrchestrator.ts:116` |
| `product_studio` | `ProductStudioService` (productStudioService.ts) | `serviceOrchestrator.ts:119` |
| `creative_studio` | `CreativeStudioService` (creativeStudioService.ts) | `serviceOrchestrator.ts:120` |
| `commercial_office` | `CommercialOfficeService` (commercialOfficeService.ts) | `serviceOrchestrator.ts:121` |
| `marketing_office` | `MarketingOfficeService` (marketingOfficeService.ts) | `serviceOrchestrator.ts:122` |

Chaque `riskByCapability` déclaré dans `config/services.json` correspond à une
capacité effectivement présente dans le tableau `capabilities` de la même
entrée (validé structurellement par `validateServiceDefinition` dans
`src/orchestration/serviceRegistry.ts`).

## Résultat

Aucun orphelin dans un sens ou dans l'autre :
- Tous les services déclarés dans `config/services.json` ont un handler et
  sont enregistrés auprès du `ServiceAdapter`.
- `src/services/mockService.ts` (`MockServiceServer`) est un double de test
  utilisé uniquement dans les tests HTTP (`httpApi.test.ts` et similaires) ;
  ce n'est pas un service de production et il n'a pas vocation à figurer
  dans `config/services.json`.

Aucune suppression ni ajout nécessaire côté registre.

## A.3 — Enregistrement des skills

Les 13 skills exportées par `src/skills/builtin/*.ts` sont toutes listées dans
`builtinSkills` (`src/skills/builtin/index.ts`) : `get_current_time`,
`remember_fact`, `create_task`, `list_tasks`, `complete_task`, `web_search`,
`execute_code`, `dispatch_capability`, `execute_mission`, `product_studio`,
`creative_studio`, `commercial_office`, `marketing_office`. Aucune skill
définie n'est absente de ce catalogue.

**Bug trouvé et corrigé** : `src/index.ts` réenregistrait une seconde fois
la totalité de `builtinSkills` juste après la construction de l'`Agent`
(`for (const skill of builtinSkills) agent.skills.register(skill);`), alors
que le constructeur d'`Agent` (`src/core/agent.ts`) enregistre déjà
l'intégralité de `builtinSkills`, fusionnée avec les skills runtime issues
de `createRuntimeSkills` (qui portent le `serviceCapability`, le `risk` et
la disponibilité déjà calculée par rapport à `ServiceRegistry`). Cette
double inscription écrasait la version fusionnée par la version brute du
fichier builtin (redevenant `AVAILABLE` par défaut avec un handler actif,
même pour un bureau désactivé dans `config/services.json`), et ne restait
sans effet visible que parce que `applyAllEffectiveRuntimeSettings(agent)`
— appelé juste après — réappelle `skills.refreshServiceAvailability(...)`
et corrige la disponibilité. Un futur changement d'ordre entre ces deux
lignes aurait exposé un bureau désactivé comme disponible. Le
réenregistrement redondant a été supprimé de `src/index.ts` ; le
constructeur d'`Agent` reste l'unique point d'enregistrement des skills
builtin en production.

## A.4 — Contrat d'événements uniforme

Le type `ServiceEvent` (`src/orchestration/contract.ts`) impose déjà
structurellement (au niveau TypeScript) les 8 champs
(`schema_version, event_id, task_id, trace_id, service, sequence, type,
timestamp, payload`) et les 7 types (`TASK_ACCEPTED, TASK_REJECTED,
TASK_PROGRESS, NEEDS_INPUT, NEEDS_PERMISSION, TASK_COMPLETED,
TASK_FAILED`) à tout service dont `handleTaskRequest` retourne
`Promise<ServiceEvent[]>`.

- Les quatre bureaux (`product_studio`, `creative_studio`,
  `commercial_office`, `marketing_office`) construisent tous leurs
  événements via les mêmes helpers partagés `completedEvent`/`failedEvent`
  de `src/services/bureauContract.ts` — aucune variante locale.
- `workspace_service` et `research_service` construisent l'objet
  `ServiceEvent` "à la main" mais avec exactement la même forme (vérifié
  champ par champ) ; ils n'émettent que `TASK_COMPLETED`/`TASK_FAILED`
  car leurs opérations sont synchrones, comme les bureaux.
- `software_factory` (`softwareFactoryService.ts`) est le seul service à
  utiliser `TASK_ACCEPTED`/`TASK_PROGRESS` en plus de
  `TASK_COMPLETED`/`TASK_FAILED`, car c'est le seul flux asynchrone
  multi-étapes (issue de repo → PR) ; la forme des événements reste
  conforme au même contrat.
- **Repository intelligence** (`src/repository/repositoryIntelligenceEngine.ts`,
  exposé via la skill `knowledge_search`) n'émet aucun `ServiceEvent` : ce
  n'est pas un service déclaré dans `config/services.json` mais une skill
  `LOCAL_HANDLER` synchrone, au même titre que `execute_code`, `tasks` ou
  `web_search` — catégorie volontairement distincte des services
  risk-gated dispatchés via l'Orchestrator (voir A.7). Aucune incohérence
  de contrat : il n'y a simplement pas de contrat d'événements à ce niveau
  par conception.

Aucune variante locale du contrat d'événements trouvée parmi les services
réellement dispatchés par l'Orchestrator.

## A.5 — Trou de la machine à états (corrigé)

`ALLOWED_TRANSITIONS.DISPATCHING` (`src/orchestration/operationStore.ts`)
n'autorisait pas `WAITING_INPUT` ni `WAITING_PERMISSION` : un service qui
répond `NEEDS_INPUT`/`NEEDS_PERMISSION` comme tout premier événement (avant
tout `TASK_ACCEPTED`/`TASK_PROGRESS`) voyait son événement rejeté avec
`EVENT_STATE_TRANSITION_INVALID` alors que l'opération est légitime. Corrigé
en ajoutant ces deux transitions. Test de non-régression ajouté dans
`src/orchestration/controlSafety.test.ts` (« un service qui répond
NEEDS_INPUT/NEEDS_PERMISSION en tout premier événement... ») ; vérifié qu'il
échoue bien sans le correctif.

## A.6 — Source de vérité unique pour les connexions de service

Le "Jarvis Settings Center" et le "Service Connection Center" (PR #44)
opèrent tous deux exclusivement via `agent.serviceOrchestrator.registry`
(voir `src/interfaces/httpApi.ts`), la même instance de `ServiceRegistry`
que celle utilisée par l'Orchestrator en exécution, elle-même adossée à un
unique `ConnectionStore` (SQLite). Aucune config parallèle trouvée.

## A.7 — Aucun contournement de l'Orchestrator

Toutes les skills qui déclenchent un bureau ou un service (`product_studio`,
`creative_studio`, `commercial_office`, `marketing_office`,
`dispatch_capability`, `execute_mission`) passent par
`ctx.serviceOrchestrator.dispatchCapability(...)`. Aucun bouton d'UI
(`www/`) n'appelle directement un endpoint de service. Les deux instances
directes de `SoftwareFactoryService` trouvées
(`src/interfaces/httpApi.ts:31` sur la route `POST /tasks`, et
`SoftwareFactoryServer` dans `softwareFactoryService.ts`) sont le **côté
service** du contrat (elles reçoivent un `TaskRequest` déjà construit par
l'Orchestrator ou par un appelant `task_http` externe et répondent en
`ServiceEvent[]`) — ce n'est pas un contournement, c'est la cible que
l'Orchestrator/`ServiceAdapter` appelle. La route `POST /api/tasks/dispatch`,
elle, passe bien par `agent.serviceOrchestrator.dispatchCapability`.
