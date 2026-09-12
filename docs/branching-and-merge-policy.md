# Convention de nommage des branches et politique de merge

Plusieurs agents IA distincts (ChatGPT, Codex, Claude, la Software Factory
Jarvis elle-même) committent en parallèle sur ce dépôt, souvent sans revue
humaine systématique avant merge. Ce document fixe les règles minimales pour
que ça reste gérable.

## Conventions de nommage observées

| Préfixe | Origine | Exemple |
|---|---|---|
| `chatgpt/<slug>` | Agent ChatGPT (Codex web ou intégration ChatGPT) | `chatgpt/fix-android-speech-recognizer` |
| `codex/<slug>` | Agent Codex CLI | `codex/creer-le-centre-de-parametres-jarvis-v1` |
| `claude/<slug-aléatoire>` | Claude Code (cette session incluse) | `claude/new-session-q4ycbr` |
| `jarvis/task-<uuid>` | Software Factory Jarvis (auto-généré, PR "[Jarvis Software Factory] Patch for X") | `jarvis/task-538093a0-...` |

Règles :
- Le préfixe identifie l'agent/outil à l'origine de la branche — ne jamais
  réutiliser le préfixe d'un autre agent pour une branche créée manuellement.
- `<slug>` : court, en anglais ou français selon l'agent, décrivant l'intention
  (`fix-...`, `feat-...`, ou un thème de "chantier").
- Les branches `jarvis/task-<uuid>` sont générées automatiquement par la
  Software Factory à partir d'un `task_id` interne — ne pas les renommer, le
  suivi côté Software Factory dépend de cet identifiant.

## Politique de merge

1. **CI verte obligatoire** (`.github/workflows/ci.yml`, `npm test`) avant tout
   merge vers `main` — configurer la protection de branche GitHub en
   conséquence (voir note dans le commit ajoutant `ci.yml` : ce dépôt n'a pas
   d'accès pour la configurer via API depuis une session automatisée, un
   propriétaire du dépôt doit l'activer manuellement dans Settings → Branches).
2. **Une PR ouverte par fichier significatif à la fois.** Avant d'ouvrir une
   nouvelle PR touchant un fichier donné, vérifier qu'aucune PR ouverte ne le
   cible déjà (`gh pr list` / recherche GitHub). En cas de doublon détecté
   après coup, fermer les PR redondantes avec une note expliquant laquelle a
   été conservée et pourquoi (voir la Definition of Done des directives de
   correction : "Aucune PR ouverte ne cible un fichier déjà couvert par une
   autre PR ouverte").
3. **PR Software Factory (`[Jarvis Software Factory] Patch for X`)** : ce sont
   des patches automatiques, un par tâche interne. Si plusieurs PR de ce type
   ciblent le même fichier, ne garder que la plus récente/pertinente (celle
   dont le diff est le plus abouti ou le plus proche de `main`) et fermer les
   autres avec un lien vers celle conservée.
4. **Revue humaine recommandée avant merge sur `main`**, en particulier pour
   tout changement touchant : la séparation des rôles Jarvis Core/Orchestrator/
   services, le contrat `TASK_REQUEST`/`TASK_EVENT`, la configuration
   provider/modèle (`SOFTWARE_FACTORY_PROVIDER` ne doit jamais hériter de
   `LLM_PROVIDER`), ou tout ce qui touche l'authentification/l'exposition
   réseau (`API_TOKEN`, CORS). Un agent qui ouvre une telle PR doit le
   signaler explicitement dans sa description plutôt que de merger seul.
5. **Ne jamais rebase/force-push une branche créée par un autre agent** (perte
   de contexte pour cet agent s'il reprend la branche plus tard) — préférer un
   merge commit pour intégrer `main` dans une branche de travail.
6. **Un correctif à la fois par commit**, avec un message qui explique le
   *pourquoi*, pour qu'un futur agent (ou humain) qui reprend l'historique
   comprenne l'intention sans devoir relire tout le diff.
