# CLAUDE.md

Instructions pour Claude Code dans ce dépôt (socle agent autonome / Jarvis
Command Center). Lis aussi `README.md` (vue d'ensemble, 9 briques, extensions)
et `ARCHITECTURE.md` (carte des modules, journal des évolutions de fond).

## Stack

- TypeScript strict (`tsconfig.json` : `strict: true`), ESM pur (`NodeNext`).
- Node 22.x (`engines.node` dans `package.json`).
- Stockage : SQLite (`better-sqlite3`) par défaut, PostgreSQL (`pg`) en option
  via `DATABASE_URL` pour conversations/personnalité uniquement.
- LLM-agnostique : jamais de SDK propriétaire côté fournisseurs LLM — tout
  passe par l'interface `LLMProvider` (`src/llm/providers/`) en HTTP brut.

## Commandes

```bash
npm run dev      # exécution directe via tsx, sans build
npm run build     # tsc + génération du manifest OTA (scripts/build-ota.mjs)
npm start         # exécute dist/ (build requis avant)
npm test          # node --test sur src/**/*.test.ts, provider mock + SQLite en mémoire
```

Toujours valider avec `npm test` (et `npm run build` si les types sont en jeu)
avant de considérer une tâche terminée.

## Style de code attendu

- Ne modifie que ce qui est explicitement demandé. Pas de refactor, pas de
  nettoyage, pas d'abstraction ajoutée « au cas où » dans le fichier touché.
- Pas de commentaires par défaut. N'en ajoute que si le POURQUOI est
  non-évident (contrainte cachée, contournement d'un bug précis) — jamais pour
  décrire ce que fait le code.
- Pas de gestion d'erreur/validation/fallback pour des cas qui ne peuvent pas
  se produire. Fais confiance aux garanties internes (types stricts, contrats
  déjà en place comme `TASK_REQUEST`/`TASK_EVENT` dans
  `src/orchestration/contract.ts`). Ne valide qu'aux frontières réelles
  (entrée utilisateur, réponse LLM brute, fichier externe).
- Respecte les frontières architecturales existantes : Jarvis Core ne parle
  jamais directement à un service, tout passe par `ServiceOrchestrator`
  (`src/orchestration/`) ; une nouvelle compétence s'ajoute via
  `SkillDefinition` (`src/skills/builtin/`) + `agent.skills.register(...)`,
  jamais en contournant l'enregistrement/indexation par pertinence.
- Un nouveau fournisseur LLM/embeddings s'ajoute en implémentant
  `LLMProvider`/`EmbeddingProvider` et en l'enregistrant dans la factory
  correspondante (`src/llm/providers/index.ts`, `src/llm/embeddingFactory.ts`)
  — jamais en important son SDK ailleurs dans le code.
- Les tests sont des tests de fumée `node --test`, provider `mock`, SQLite en
  mémoire : aucun réseau ni fichier requis. Garde cette propriété pour tout
  test ajouté.

## Ce que je ne dois pas faire sans qu'on me le demande

- Créer de nouveaux fichiers si modifier un fichier existant suffit.
- Introduire une nouvelle dépendance npm.
- Toucher à `android/`, `www/`, ou au mécanisme OTA (`scripts/build-ota.mjs`,
  `www/ota-manifest.json`) pour une tâche qui ne les concerne pas.
- Activer un bureau métier (`config/services.json`) ou changer un défaut de
  configuration (ex. `LLM_PROVIDER`, `graphRetentionDays`) sans demande
  explicite — ces défauts sont documentés et volontaires (voir README/
  ARCHITECTURE).
