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
