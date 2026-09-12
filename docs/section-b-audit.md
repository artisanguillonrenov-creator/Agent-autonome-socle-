# Audit section B — erreurs de codage (directives de correction)

## B.1 — Message role:"user" synthétique dupliqué / toolCallId multi-outils

La PR référencée dans les directives (« PR #20 ») ne correspond pas, sur ce
dépôt GitHub, à un correctif touchant `src/core/agent.ts` (PR #20 réelle :
« Fix/software factory filepath noop v1 », sans rapport). Le numéro de PR
semble erroné dans le document source.

Vérification indépendante du symptôme décrit (message `role: "user"`
synthétique dupliqué après l'exécution d'un tool natif, perte du
`toolCallId` sur 2+ appels d'outils dans le même tour) :

- `src/core/agent.ts` (boucle `step`, gestion de `nativeToolCalls`) : un seul
  message `{role:"assistant", toolCalls}` est enregistré, puis exactement un
  message `{role:"tool", toolCallId, ...}` par appel d'outil — aucun message
  `role:"user"` synthétique n'est ajouté dans ce chemin.
- `src/memory/selectRecentMessages.ts` (déjà présent) garantit qu'un bloc
  assistant+tool_calls n'est jamais scindé lors de la sélection de
  l'historique récent, et rejette tout bloc dont les `toolCallId` sont
  dupliqués, orphelins ou incomplets.
- `src/llm/providers/infermatic.ts` (`formatNativeMessages`) restitue
  chaque message `role:"tool"` tel quel (pas de conversion en `user`) ; le
  mode compatibilité (`formatCompatibilityMessages`, pour les modèles sans
  tool calling natif) convertit chaque `tool` en un **unique** message
  `user` (1 pour 1, jamais dupliqué), ce qui est la traduction de format
  attendue pour ces modèles.

Aucun bug reproductible trouvé sur l'état actuel du dépôt. Couverture de
test renforcée pour verrouiller ce comportement :
- `src/core/agent.test.ts` (TEST B, multi-outils) : assertion ajoutée
  qu'un seul message `role:"user"` (le message utilisateur d'origine)
  atteint le provider au tour suivant, et que les deux `toolCallId` sont
  reçus dans l'ordre exact.
- `src/llm/providers/infermatic.test.ts` : nouveau test vérifiant qu'avec
  2 tool calls dans le même tour, exactement 4 messages sont envoyés à
  l'API (`user, assistant, tool, tool`) avec les `tool_call_id` préservés
  à l'identique.

## B.2 — Corrélation par timestamp dans www/app.js (PR référencée : #36)

Comme pour B.1, le numéro de PR indiqué dans les directives ne correspond
pas exactement au correctif décrit sur ce dépôt GitHub, mais le bug lui
existe bel et bien et a été corrigé.

**Bug confirmé** : `monitorChatOperations` (`www/app.js`) décidait qu'une
opération appartenait au tour de chat en cours via
`Number(operation.createdAt) < requestStartedAt` — une fenêtre de temps
partagée par tous les clients interrogeant le même `/api/operations`
global. Deux utilisateurs envoyant un message à quelques millisecondes
d'intervalle pouvaient voir apparaître, dans leur propre timeline, les
opérations déclenchées par l'autre.

**Correctif** :
- `src/core/agent.ts` : `step()` accepte un 3ème paramètre optionnel
  `chatRequestId`. Un `turnTraceId` (fourni par l'appelant ou généré par
  défaut) est calculé une fois par tour et injecté comme `traceId` par
  défaut de tout `dispatchCapability` déclenché par ce tour (via une fine
  enveloppe sur `ctx.serviceOrchestrator` exposée aux skills, qui ne
  duplique que `dispatchCapability`/`registry`).
- `src/interfaces/httpApi.ts` : `/api/chat` lit `body.requestId` (fourni
  par le client) et le transmet à `agent.step()`.
- `www/app.js` : génère `crypto.randomUUID()` avant l'envoi, l'inclut dans
  le corps de la requête, et `monitorChatOperations` filtre désormais par
  `operation.traceId === requestId` — plus aucune fenêtre de temps.

**Test de non-régression** ajouté dans `src/core/agent.test.ts` :
deux `Agent.step()` concurrents avec des `chatRequestId` distincts,
partageant le même `OperationStore`/`ServiceOrchestrator`, vérifient que
chaque opération créée porte bien le `traceId` de son propre tour et
qu'aucune des deux ne se retrouve sous l'identifiant de l'autre.
