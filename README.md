# Socle agent autonome (Jarvis Command Center)

Socle générique et réutilisable pour bâtir un agent IA autonome, condensé à
partir de dix architectures existantes (Hermes Agent, OpenClaw, AutoGPT,
BabyAGI, CrewAI, AutoGen, MetaGPT, Generative Agents, Voyager, SillyTavern)
en neuf briques communes. Au-delà du socle, le dépôt implémente Jarvis
Command Center : voir [Au-delà des 9 briques](#au-delà-des-9-briques)
ci-dessous pour l'ampleur réelle du projet (Software Factory, bureaux
métier, personnalité, voix, repository intelligence).

## Principes

- **LLM-agnostique** : Anthropic, OpenAI, OpenRouter, Ollama, Infermatic ou un fournisseur `mock`
  (hors-ligne, sans clé API) sont interchangeables via `LLM_PROVIDER`. Aucun SDK
  propriétaire côté fournisseurs LLM : ils parlent tous en HTTP brut derrière
  l'interface `LLMProvider` — cette contrainte ne s'étend pas au reste du projet, qui
  utilise par ailleurs des SDK tiers là où c'est pertinent (`@octokit/rest` pour
  l'intégration GitHub de la Software Factory et de repository intelligence,
  `exceljs`/`pdf-parse` pour le Document & Data Workbench).
- **Stockage local par défaut, Postgres en option pour la durabilité** : SQLite
  (fichier unique, `better-sqlite3`) est le stockage par défaut pour à peu près tout
  (mémoire, tâches, opérations de service, connexions...). Si `DATABASE_URL` est
  défini, l'historique de conversation durable (Chantier 11A, `src/persistence/conversations/`)
  et l'état de personnalité (`src/personality/`) basculent automatiquement sur
  PostgreSQL au lieu de SQLite — c'est le mode recommandé pour un déploiement où la
  continuité de conversation doit survivre à un redémarrage/redéploiement (voir
  `.github/workflows/android.yml`/`chantier11a.yml`, qui provisionnent un Postgres de
  test). La mémoire vectorielle reste par feature hashing (déterministe, zéro
  dépendance) quel que soit le backend choisi. Le LLM nominal de Jarvis est Infermatic
  avec `Qwen-Qwen3.6-35B-A3B`, et nécessite donc une clé `INFERMATIC_API_KEY` valide.
  Des fournisseurs OpenAI/Voyage restent branchables pour les embeddings si besoin
  de meilleure précision sémantique (`EMBEDDING_PROVIDER`).

## Les 9 briques

| # | Brique | Fichiers |
|---|--------|----------|
| 1 | Boucle agent | `src/core/agent.ts` |
| 2 | 4 couches de mémoire | `src/memory/` |
| 3 | Réflexion périodique | `src/reflection/reflectionEngine.ts` |
| 4 | Planification hiérarchique | `src/planning/planner.ts` |
| 5 | Bibliothèque de compétences | `src/skills/` |
| 6 | Orchestration de rôles (optionnel) | `src/roles/orchestrator.ts` |
| 7 | Gestionnaire de budget de contexte | `src/context/contextBudgetManager.ts` |
| 8 | Façade(s) | `src/interfaces/cli.ts` |
| 9 | Points de reprise | `src/persistence/` |

## Au-delà des 9 briques

Le socle initial (9 briques ci-dessus) sert de fondation à Jarvis Command
Center, dont la portée réelle est nettement plus large :

- **Orchestration de services & Software Factory** (`src/orchestration/`,
  `src/services/softwareFactoryService.ts`) : Jarvis Core (le raisonnement)
  ne parle jamais directement à un service — tout passe par
  `ServiceOrchestrator`/le contrat `TASK_REQUEST`/`TASK_EVENT`
  (`src/orchestration/contract.ts`), avec gating par risque (LOW → CRITICAL,
  approbation explicite au-delà) et machine à états des opérations
  (`src/orchestration/operationStore.ts`). La Software Factory génère du
  code, ouvre des branches/PR sur GitHub (`@octokit/rest`) via son propre
  provider/modèle LLM (`SOFTWARE_FACTORY_PROVIDER`/`SOFTWARE_FACTORY_MODEL`),
  indépendant du provider actif de Jarvis.
- **Bureaux métier** (Chantier 9, `src/services/{product,creative,commercial,marketing}*.ts`) :
  Product Studio, Creative Studio, Commercial Office et Marketing Office —
  quatre services synchrones dispatchés comme des capacités, désactivés par
  défaut (`config/services.json`), activables depuis les réglages.
- **Personnalité** (`src/personality/`) : politique de ton/style appliquée
  aux réponses de Jarvis, avec validation de sortie et repli automatique si
  une régénération corrective échoue.
- **Voix** (Chantier 10, `src/voice/`) : ingestion de commandes vocales
  Android idempotente, alertes (SMS/notification native), file d'attente
  avec purge des commandes terminées (`DONE`/`RECOVERY_REQUIRED`).
- **Repository intelligence** (`src/repository/`) : lecture seule d'un
  dépôt GitHub (arborescence, recherche, PR, diffs, audit de secrets) via
  la skill `knowledge_search`, en local (`LOCAL_HANDLER`), sans passer par
  le contrat de service (elle ne dispatche rien à un service externe).
- **Document & Data Workbench** (`src/workbench/`) : lecture/écriture de
  fichiers de travail, tableurs (`exceljs`), PDF (`pdf-parse`), analyse de
  données, avec garde-fous anti zip-bomb pour les fichiers XLSX
  (`src/workbench/xlsxZipGuard.ts`).
- **Planification hiérarchique avancée** (`src/planning/`) : missions
  multi-étapes avec parallélisme borné, replanification sûre et
  spécialistes (`src/orchestration/specialistRegistry.ts`).
- **Autonomie** (`src/autonomy/`) : exécution en arrière-plan, planificateur,
  notifications, alertes email.
- **Android/Capacitor + OTA** (`android/`, `www/`) : app mobile encapsulant
  l'interface Web, avec mise à jour OTA du bundle Web (voir section
  dédiée plus bas) sans passer par le store pour les changements HTML/CSS/JS.

## Démarrage

```bash
npm install
cp .env.example .env
npm run dev
```

Par défaut, Jarvis utilise `LLM_PROVIDER=infermatic` avec
`LLM_MODEL=Qwen-Qwen3.6-35B-A3B`. Renseignez `INFERMATIC_API_KEY` dans `.env`
avant de démarrer. Les embeddings restent locaux par défaut (`EMBEDDING_PROVIDER=local`).

Pour un fonctionnement de développement entièrement hors-ligne, remplacez le provider
par `LLM_PROVIDER=mock`. Pour utiliser Claude : `LLM_PROVIDER=anthropic`,
`ANTHROPIC_API_KEY=...`, `LLM_MODEL=claude-sonnet-5` (voir `.env.example` pour toutes
les options).

> Derrière un proxy HTTP(S) (ex: `HTTPS_PROXY` défini, environnements sandboxés) :
> `npm run dev`/`npm start` activent déjà `NODE_USE_ENV_PROXY=1`, requis par le
> `fetch` natif de Node pour respecter la variable de proxy (Node ≥ 22.21).
> Sans proxy configuré, ce réglage n'a aucun effet.

## Commandes CLI

```
/help                      Affiche l'aide
/skills                    Liste les compétences enregistrées
/plan                      Affiche l'arbre de plan courant
/checkpoint save <label>   Sauvegarde l'état courant (brique 9)
/checkpoint load <id>      Restaure un état sauvegardé
/checkpoint list           Liste les checkpoints
/exit                      Quitte
```

## Étendre le socle

- **Ajouter une compétence** : implémenter `SkillDefinition` (voir
  `src/skills/builtin/`) et l'enregistrer via `agent.skills.register(...)`.
  Elle est automatiquement indexée par pertinence (embedding de sa description)
  et rappelée seulement quand elle est utile — pas besoin de tout injecter à
  chaque appel.
- **Ajouter un fournisseur LLM/embeddings** : implémenter `LLMProvider` ou
  `EmbeddingProvider` et l'ajouter à la factory correspondante
  (`src/llm/providers/index.ts` ou `src/llm/embeddingFactory.ts`).
- **Activer l'orchestration de rôles (brique 6)** : instancier
  `RoleOrchestrator` avec une liste de `Role` (nom + prompt système) —
  pertinent seulement passé un certain niveau de complexité.

## Déployer un accès public (ex: Render, gratuit)

Le serveur HTTP (`AGENT_INTERFACE=http`) sert aussi une page de chat à la racine (`/`) —
utile pour discuter avec l'agent depuis un navigateur sans passer par la CLI.

1. Compte gratuit sur [render.com](https://render.com), connecté à GitHub
2. **New > Web Service**, sélectionner ce dépôt
3. Build command : `npm install && npm run build`
4. Start command : `npm start`
5. Variables d'environnement (Environment) : au minimum `LLM_PROVIDER`, la clé du
   fournisseur choisi, `LLM_MODEL`, `AGENT_INTERFACE=http`, et **`API_TOKEN`**
   (obligatoire dès que `AGENT_INTERFACE` inclut `http` sur un hébergement comme
   Render — le serveur refuse de démarrer sans lui plutôt que d'exposer une API non
   protégée ; toute requête doit alors envoyer `Authorization: Bearer <API_TOKEN>`)
6. Déployer — l'URL publique (`https://....onrender.com`) sert la page de chat

Limites du tier gratuit à connaître : le service peut se mettre en veille après
inactivité (premier message plus lent le temps du réveil), et le disque n'est pas
garanti persistant d'un déploiement à l'autre — la mémoire/les tâches peuvent donc
repartir de zéro après une mise à jour du code.

### Mises à jour OTA de l'app Android

`npm run build` exécute aussi `scripts/build-ota.mjs`, qui régénère
`www/ota-manifest.json` et `www/ota-bundle.json` à partir du code Web courant. Comme
Render lance cette même commande à chaque déploiement, `/api/ota/manifest` et
`/api/ota/bundle` correspondent toujours au code effectivement en ligne — jamais à un
artifact GitHub Actions à part (celui du workflow `ota.yml` n'est qu'une vérification CI).

Chaque bundle est identifié par un `buildId` (commit déployé) et son SHA-256, jamais par
un numéro de version saisi à la main : l'app Android compare cette identité, pas le
numéro de version, pour savoir si une mise à jour existe et pour ne jamais réinstaller
en boucle un bundle déjà actif. Seuls les changements Web (HTML/CSS/JS) passent par ce
mécanisme ; un changement natif Android/Capacitor nécessite toujours un nouvel APK.

Au démarrage, une mise à jour compatible est téléchargée, vérifiée (SHA-256) et
installée automatiquement, sans action de l'utilisateur ; l'écran Système garde un
bouton de vérification manuelle (avec confirmation visible) et un rollback vers la
version précédente. Le bundle embarque aussi `index.html` : au lieu d'un simple
`window.location.reload()` qui resservirait l'index.html figé dans l'APK, l'app réécrit
le document courant avec l'`index.html` du bundle actif — les évolutions HTML prennent
donc réellement effet, pas seulement CSS/JS.

## Tests

```bash
npm test
```

Tests de fumée (`node --test`) : embeddings déterministes/similarité,
gestionnaire de budget de contexte, boucle agent (réponse simple, appel de
compétence, sauvegarde/restauration de checkpoint) — sur fournisseur `mock`
et base SQLite en mémoire, donc aucun réseau ni fichier requis.
