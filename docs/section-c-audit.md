# Audit section C — organisation générale (directives de correction)

## C.1 — Découverte automatique des fichiers de test

`package.json`'s `test` script listait manuellement les 45 fichiers de
test. Remplacé par un glob natif reconnu directement par le test runner
Node (`node --test "src/**/*.test.ts"`, sans dépendre de l'expansion du
shell) : les nouveaux fichiers `*.test.ts` sont désormais pris en compte
automatiquement, sans modification de `package.json`.

## C.2 — CI

Voir la section dédiée (déjà traitée en tout premier — `.github/workflows/ci.yml`).

## C.3 — pretest découplé de build-ota.mjs

`pretest` exécutait `scripts/build-ota.mjs` avant **chaque** `npm test`,
donc pour les 500+ tests backend qui n'en dépendent absolument pas — et
ce script mute des fichiers suivis par git (`www/index.html` : inlining
du bootstrap de conversation ; `www/ota-manifest.json` et
`www/ota-bundle.json` : buildId/timestamp/sha256 régénérés à chaque
exécution), polluant `git status` après le moindre `npm test`.

Seul `src/interfaces/otaClient.test.ts` a réellement besoin d'un
`www/ota-*.json` à jour (il vérifie que le bundle servi par Render
correspond exactement au code Web courant). Le script `pretest` a été
supprimé ; `otaClient.test.ts` exécute désormais lui-même
`scripts/build-ota.mjs` (via `execFileSync`, dans un hook `before()`
`node:test`) avant ses propres tests. Vérifié qu'exécuter un fichier de
test sans rapport (ex. `agent.test.ts`) seul ne touche plus aucun fichier
sous `www/`.

## C.4 — Revue des 15 PR ouvertes

Les 15 PR ouvertes ont été passées en revue une par une le 12 septembre
2026. Verdict pour chacune : **fermée**, avec un commentaire explicatif
posté sur la PR elle-même (pas ici en détail, pour éviter la duplication —
voir le commentaire de fermeture de chaque PR pour la justification
complète et les références précises au code de `main`).

| Groupe | PR | Raison de fermeture |
|---|---|---|
| Doublon `src/core/agent.test.ts` (Software Factory) | #22, #23, #24, #25, #26, #27 | Même objectif (verrouiller le protocole de tool calling natif) que le correctif déjà ajouté sur `claude/new-session-q4ycbr` (B.1) ; aucun bug reproductible trouvé |
| Doublon `src/memory/memoryManager.ts` (Software Factory) | #28, #29 | `selectRecentMessages` déjà présent sur `main`, plus robuste (valide les toolCallId dupliqués/orphelins) |
| Régressive vs `main` | #20 | Supprimerait des garde-fous déjà en place (`GITHUB_COMMIT_SHA_MISSING`, `NO_GITHUB_DIFF`, support `exactContent`/`TARGET_BRANCH`) |
| Fonctionnalité déjà présente sur `main` | #30 | `TARGET_BRANCH`/`TARGET_PR` déjà implémentés |
| Fonctionnalité déjà présente sur `main` | #36 | Événements structurés/risque/approbation/timeline déjà implémentés ; le bug P1 de corrélation (référencé B.2) traité indépendamment |
| Fonctionnalité déjà présente sur `main` | #44 | Settings Center + Connection Center déjà présents (`src/settings/`, `src/connections/`) |
| Doublon entre elles + déjà présent sur `main` | #46, #48 | Repository intelligence déjà présente sous `src/repository/` (troisième implémentation indépendante) |
| Fonctionnalité déjà présente sur `main` | #47 | Les 5 moteurs du Document & Data Workbench existent déjà sous `src/workbench/` |

Constat général : plusieurs agents IA (Codex, Jules, Software Factory
Jarvis) ont, à des moments différents, implémenté indépendamment les mêmes
fonctionnalités sous des chemins de fichiers différents ; certaines de ces
implémentations indépendantes ont fini par atterrir sur `main` par une
autre voie que ces PR, laissant ces dernières orphelines. Voir
`docs/branching-and-merge-policy.md` pour la règle qui doit prévenir ça à
l'avenir (vérifier qu'aucune PR ouverte ne cible déjà un fichier/une
fonctionnalité avant d'en ouvrir une nouvelle).
