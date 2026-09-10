# Socle agent autonome

Socle générique et réutilisable pour bâtir un agent IA autonome, condensé à
partir de dix architectures existantes (Hermes Agent, OpenClaw, AutoGPT,
BabyAGI, CrewAI, AutoGen, MetaGPT, Generative Agents, Voyager, SillyTavern)
en neuf briques communes.

## Principes

- **LLM-agnostique** : Anthropic, OpenAI, OpenRouter, Ollama ou un fournisseur `mock`
  (hors-ligne, sans clé API) sont interchangeables via `LLM_PROVIDER`. Aucun SDK
  propriétaire : les fournisseurs parlent en HTTP brut derrière l'interface `LLMProvider`.
- **100% local par défaut** : stockage SQLite (fichier unique, `better-sqlite3`),
  aucun service externe à faire tourner. La mémoire vectorielle utilise un
  embedding local par feature hashing (déterministe, zéro dépendance) ; des
  fournisseurs OpenAI/Voyage sont branchables si besoin de meilleure précision
  sémantique (`EMBEDDING_PROVIDER`).

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

## Démarrage

```bash
npm install
cp .env.example .env
npm run dev
```

Par défaut (`LLM_PROVIDER=mock`, `EMBEDDING_PROVIDER=local`), tout tourne
hors-ligne sans aucune clé API — utile pour explorer le socle avant de brancher
un vrai fournisseur.

Pour utiliser Claude : `LLM_PROVIDER=anthropic`, `ANTHROPIC_API_KEY=...`,
`LLM_MODEL=claude-sonnet-5` (voir `.env.example` pour toutes les options).

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
   fournisseur choisi, `LLM_MODEL`, et `AGENT_INTERFACE=http`
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

## Tests

```bash
npm test
```

Tests de fumée (`node --test`) : embeddings déterministes/similarité,
gestionnaire de budget de contexte, boucle agent (réponse simple, appel de
compétence, sauvegarde/restauration de checkpoint) — sur fournisseur `mock`
et base SQLite en mémoire, donc aucun réseau ni fichier requis.
