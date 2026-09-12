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
