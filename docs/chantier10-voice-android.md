# Chantier 10 — voix Android, ingress sûr, alertes et priorité locale

## Architecture livrée

La voix reste une couche d'entrée/sortie. Il n'existe aucun `VoiceAgent` : le service Android transcrit la commande puis appelle le backend Jarvis, qui exécute la même instance d'`Agent` que le chat texte. Les entrées interactives passent par une sérialisation globale pour protéger la `WorkingMemory` mutable.

Flux nominal :

`microphone Android -> STT -> NativeJarvisClient -> /api/voice/command -> Agent.step() -> réponse complète -> VoiceOutputFormatter -> Android TextToSpeech`.

`voiceCommandId` est un UUID créé une fois par commande et conservé lors des retries. Le backend persiste l'état d'ingress (`RUNNING`, `DONE`, `RECOVERY_REQUIRED`) afin qu'une perte de réponse HTTP ne déclenche jamais une seconde exécution de l'Agent.

## Limites intentionnelles de la V1

- `WAITING_INPUT` n'a toujours pas de continuation d'opération native. Une réponse utilisateur devient une nouvelle interaction Agent ; `SERVICE_CONTINUATION_NOT_SUPPORTED` n'est pas masqué.
- Une approbation vocale non critique doit viser le `taskId` exact et employer une formulation explicite. Une opération `CRITICAL` ne peut pas être approuvée uniquement à la voix ; l'interface sécurisée existante et `APPROVE_CRITICAL` restent autoritaires.
- Le barge-in vocal mains libres n'est pas requis. La V1 coupe/suspend l'écoute pendant le TTS et permet l'arrêt par UI/notification. L'AEC doit être validé sur appareil avant activation future.
- Les notifications Android de ce chantier sont locales et récupérées par le runtime natif actif via polling borné. Ce n'est pas un push distant garanti si le processus Android est totalement arrêté. Aucun FCM n'est simulé.
- Les SMS exigent `SMS_WEBHOOK_URL` et `ALERT_SMS_TO`. Sans provider, l'échec reste explicite (`SMS_PROVIDER_NOT_CONFIGURED`). L'APK ne demande jamais `SEND_SMS`.
- `localModelPriority` signifie local par rapport au runtime backend. Il ne donne pas au backend un accès automatique à un modèle physiquement présent sur la tablette.
- La Software Factory conserve son provider/modèle indépendant et n'utilise pas le routeur local de l'Agent.

## Wake word commercial

Le contrat `WakeWordEngine` est présent mais aucun poids de modèle tiers n'est embarqué par défaut. `ALWAYS_LISTENING` doit donc signaler `WAKE_WORD_MODEL_NOT_CONFIGURED` tant qu'une implémentation et un modèle approuvés ne sont pas fournis.

Avant une distribution commerciale, valider explicitement la provenance et les droits de :

- runtime/inférence embarqué éventuel (par exemple ONNX Runtime Android) ;
- code de feature extraction ;
- poids de modèle d'embedding intermédiaire éventuels ;
- classifieur wake-word final ;
- corpus positifs/négatifs et données synthétiques utilisés pour l'entraînement.

Aucun modèle OpenWakeWord préentraîné non validé commercialement ne doit être ajouté au dépôt.

## Paramètres externes optionnels

- `LOCAL_LLM_PROVIDER` — V1 : `ollama` ;
- `LOCAL_LLM_MODEL` — vide signifie aucun candidat local configuré ;
- `LOCAL_LLM_CONTEXT_WINDOW` — override seulement si le contexte n'est pas détectable ;
- `VOICE_INGRESS_TTL_MS` — purge uniquement des entrées `DONE` ;
- `SMS_WEBHOOK_URL`, `SMS_WEBHOOK_TOKEN`, `ALERT_SMS_TO` — passerelle SMS externe.

Le credential du backend Android n'est pas compilé dans l'APK : il est fourni après installation puis chiffré avec une clé Android Keystore.

## Checklist réelle Samsung SM-X230

À valider sur la tablette cible avant de considérer la voix matérielle prête :

- [ ] autorisation microphone accordée/refusée proprement ;
- [ ] démarrage du Foreground Service depuis l'application visible ;
- [ ] notification FGS persistante et actions Pause/Arrêt/Couper la voix ;
- [ ] PUSH_TO_TALK écran allumé ;
- [ ] STT on-device lorsqu'il est disponible ; fallback Android sinon ;
- [ ] aucune commande envoyée sur transcription vide ou non fiable ;
- [ ] TTS français, arrêt manuel et nettoyage ;
- [ ] perte Audio Focus : TTS arrêté sans reprise spontanée ;
- [ ] écran éteint / écran verrouillé / retour écran ;
- [ ] fonctionnement prolongé en arrière-plan sous One UI ;
- [ ] reload WebView/OTA pendant attente et pendant `PROCESSING` ;
- [ ] réponse produite pendant reload récupérée par `getVoiceState()` + GET ingress ;
- [ ] timeout/changement Wi-Fi : même `voiceCommandId`, aucune double exécution ;
- [ ] backend redémarré pendant `RUNNING` : `RECOVERY_REQUIRED`, aucun rejeu aveugle ;
- [ ] approbation non critique liée au bon `taskId` ;
- [ ] opération `CRITICAL` impossible à approuver uniquement à la voix ;
- [ ] notifications lockscreen sans secret/contenu détaillé ;
- [ ] consommation CPU, RAM et batterie mesurée ;
- [ ] lorsque le futur modèle wake-word commercial est présent : faux positifs/faux négatifs et écran éteint ;
- [ ] `AcousticEchoCanceler.isAvailable()` et comportement réel testés avant tout GO barge-in niveau 2.

## GO / NO-GO barge-in niveau 2

Le barge-in vocal mains libres reste désactivé tant que le SM-X230 n'a pas démontré : AEC disponible sur la session audio utilisée, absence d'auto-déclenchement, interruption fiable à voix normale et coût CPU compatible avec un TTS stable. Un NO-GO n'empêche pas la validation du Chantier 10 : le fallback sans écoute pendant `SPEAKING` est la V1 supportée.
