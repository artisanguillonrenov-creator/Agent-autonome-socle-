# Socle agent autonome

Socle générique et réutilisable pour bâtir un agent IA autonome, condensé à
partir de dix architectures existantes (Hermes Agent, OpenClaw, AutoGPT,
BabyAGI, CrewAI, AutoGen, MetaGPT, Generative Agents, Voyager, SillyTavern)
en neuf briques communes.

## Principes

- **LLM-agnostique** : Anthropic, OpenAI, Ollama ou un fournisseur `mock` (hors-ligne,
  sans clé API) sont interchangeables via `LLM_PROVIDER`. Aucun SDK propriétaire :
  les fournisseurs parlent en HTTP brut derrière l'interface `LLMProvider`.
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

## Tests

```bash
npm test
```

Tests de fumée (`node --test`) : embeddings déterministes/similarité,
gestionnaire de budget de contexte, boucle agent (réponse simple, appel de
compétence, sauvegarde/restauration de checkpoint) — sur fournisseur `mock`
et base SQLite en mémoire, donc aucun réseau ni fichier requis.
