package com.jarvis.commandcenter.voice;

import android.Manifest;
import android.app.Notification;
import android.app.NotificationChannel;
import android.app.NotificationManager;
import android.app.PendingIntent;
import android.app.Service;
import android.content.Context;
import android.content.Intent;
import android.content.pm.PackageManager;
import android.media.AudioManager;
import android.os.Build;
import android.os.Bundle;
import android.os.IBinder;
import android.speech.RecognitionListener;
import android.speech.RecognizerIntent;
import android.speech.SpeechRecognizer;
import android.speech.tts.TextToSpeech;
import android.speech.tts.UtteranceProgressListener;

import androidx.annotation.Nullable;
import androidx.core.app.NotificationCompat;
import androidx.core.content.ContextCompat;

import org.json.JSONArray;
import org.json.JSONObject;

import java.util.ArrayList;
import java.util.Locale;
import java.util.UUID;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;
import java.util.concurrent.ScheduledExecutorService;
import java.util.concurrent.TimeUnit;

public final class VoiceForegroundService extends Service {
    public static final String ACTION_START = "com.jarvis.commandcenter.voice.START";
    public static final String ACTION_SET_MODE = "com.jarvis.commandcenter.voice.SET_MODE";
    public static final String ACTION_LISTEN = "com.jarvis.commandcenter.voice.LISTEN";
    public static final String ACTION_PAUSE = "com.jarvis.commandcenter.voice.PAUSE";
    public static final String ACTION_RESUME = "com.jarvis.commandcenter.voice.RESUME";
    public static final String ACTION_STOP = "com.jarvis.commandcenter.voice.STOP";
    public static final String ACTION_STOP_SPEAKING = "com.jarvis.commandcenter.voice.STOP_SPEAKING";
    public static final String ACTION_SPEAK = "com.jarvis.commandcenter.voice.SPEAK";
    public static final String EXTRA_MODE = "mode";
    public static final String EXTRA_TEXT = "text";
    public static final String EXTRA_WORKSPACE_ID = "workspaceId";

    private static final String CHANNEL_SERVICE = "jarvis_voice_service";
    private static final String CHANNEL_ALERTS = "jarvis_native_alerts";
    private static final int FOREGROUND_NOTIFICATION_ID = 41001;
    private static final int ALERT_NOTIFICATION_BASE = 42000;

    public static final class RuntimeSnapshot {
        public final String state;
        public final String waitingReason;
        public final String taskId;
        public final String errorCode;
        public final String voiceCommandId;
        public final String transcription;
        public final String response;
        public final String voiceMode;

        RuntimeSnapshot(String state, String waitingReason, String taskId, String errorCode,
                        String voiceCommandId, String transcription, String response, String voiceMode) {
            this.state = state;
            this.waitingReason = waitingReason;
            this.taskId = taskId;
            this.errorCode = errorCode;
            this.voiceCommandId = voiceCommandId;
            this.transcription = transcription;
            this.response = response;
            this.voiceMode = voiceMode;
        }
    }

    private static volatile RuntimeSnapshot lastSnapshot = new RuntimeSnapshot(
            VoiceStateMachine.State.OFF.name(), VoiceStateMachine.WaitingReason.NONE.name(),
            null, null, null, null, null, "OFF");

    public static RuntimeSnapshot getRuntimeSnapshot() {
        return lastSnapshot;
    }

    private final VoiceStateMachine machine = new VoiceStateMachine();
    private final ExecutorService networkExecutor = Executors.newSingleThreadExecutor();
    private final ScheduledExecutorService alertPoller = Executors.newSingleThreadScheduledExecutor();
    private SecureVoiceConfigStore configStore;
    private NativeJarvisClient client;
    private WakeWordEngine wakeWordEngine;
    private SpeechRecognizer recognizer;
    private TextToSpeech tts;
    private AudioManager audioManager;
    private AudioManager.OnAudioFocusChangeListener audioFocusListener;
    private boolean ttsReady = false;
    private String voiceMode = "OFF";
    private String currentWorkspaceId;
    private String activeVoiceCommandId;
    private String lastTranscription;
    private String lastResponse;
    private NativeJarvisClient.PendingAction pendingAction;
    private int alertNotificationSequence = 0;

    @Override
    public void onCreate() {
        super.onCreate();
        configStore = new SecureVoiceConfigStore(this);
        client = new NativeJarvisClient(this);
        wakeWordEngine = new WakeWordEngine.Missing();
        audioManager = (AudioManager) getSystemService(Context.AUDIO_SERVICE);
        audioFocusListener = focusChange -> {
            if (focusChange == AudioManager.AUDIOFOCUS_LOSS
                    || focusChange == AudioManager.AUDIOFOCUS_LOSS_TRANSIENT) {
                stopSpeakingInternal(true);
            }
        };
        createNotificationChannels();
        initTts();
        alertPoller.scheduleWithFixedDelay(this::pollNativeAlertsSafely, 8, 15, TimeUnit.SECONDS);
    }

    @Override
    public int onStartCommand(Intent intent, int flags, int startId) {
        String action = intent == null ? ACTION_START : intent.getAction();
        if (action == null) action = ACTION_START;

        switch (action) {
            case ACTION_START:
                startAsForeground();
                setVoiceMode(intent == null ? configStore.getVoiceMode() : intent.getStringExtra(EXTRA_MODE));
                break;
            case ACTION_SET_MODE:
                startAsForeground();
                setVoiceMode(intent.getStringExtra(EXTRA_MODE));
                break;
            case ACTION_LISTEN:
                startAsForeground();
                currentWorkspaceId = emptyToNull(intent.getStringExtra(EXTRA_WORKSPACE_ID));
                beginSpeechRecognition(UUID.randomUUID().toString());
                break;
            case ACTION_PAUSE:
                pauseVoice();
                break;
            case ACTION_RESUME:
                startAsForeground();
                resumeVoice();
                break;
            case ACTION_STOP_SPEAKING:
                stopSpeakingInternal(false);
                break;
            case ACTION_SPEAK:
                startAsForeground();
                speakText(intent.getStringExtra(EXTRA_TEXT), false);
                break;
            case ACTION_STOP:
                stopVoice();
                break;
            default:
                publishError("VOICE_ACTION_UNKNOWN");
        }
        return START_NOT_STICKY;
    }

    private void setVoiceMode(String requestedMode) {
        String mode = requestedMode == null ? "OFF" : requestedMode;
        if (!mode.equals("OFF") && !mode.equals("PUSH_TO_TALK") && !mode.equals("CONVERSATION") && !mode.equals("ALWAYS_LISTENING")) {
            publishError("VOICE_MODE_INVALID");
            return;
        }
        voiceMode = mode;
        configStore.setVoiceMode(mode);
        if ("OFF".equals(mode)) {
            stopVoice();
            return;
        }
        machine.transition(VoiceStateMachine.State.STARTING);
        publishState();
        if (ContextCompat.checkSelfPermission(this, Manifest.permission.RECORD_AUDIO) != PackageManager.PERMISSION_GRANTED) {
            publishError("MICROPHONE_PERMISSION_REQUIRED");
            return;
        }
        if ("ALWAYS_LISTENING".equals(mode)) {
            beginWakeWord();
        } else {
            // PUSH_TO_TALK/CONVERSATION idle: no microphone consumer until an explicit
            // interaction starts; the state means the voice layer is ready for a trigger.
            machine.transition(VoiceStateMachine.State.WAITING_WAKE_WORD);
            publishState();
        }
    }

    private void beginWakeWord() {
        destroyRecognizer();
        wakeWordEngine.stop();
        if (!wakeWordEngine.isConfigured()) {
            publishError("WAKE_WORD_MODEL_NOT_CONFIGURED");
            return;
        }
        machine.transition(VoiceStateMachine.State.WAITING_WAKE_WORD);
        publishState();
        wakeWordEngine.start(new WakeWordEngine.Listener() {
            @Override
            public void onWakeWordDetected() {
                activeVoiceCommandId = UUID.randomUUID().toString();
                wakeWordEngine.stop();
                beginSpeechRecognition(activeVoiceCommandId);
            }

            @Override
            public void onError(String code) {
                publishError(code == null ? "WAKE_WORD_ERROR" : code);
            }
        });
    }

    private void beginSpeechRecognition(String commandId) {
        if (ContextCompat.checkSelfPermission(this, Manifest.permission.RECORD_AUDIO) != PackageManager.PERMISSION_GRANTED) {
            publishError("MICROPHONE_PERMISSION_REQUIRED");
            return;
        }
        wakeWordEngine.stop();
        destroyRecognizer();
        activeVoiceCommandId = commandId == null ? UUID.randomUUID().toString() : commandId;

        try {
            if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.S && SpeechRecognizer.isOnDeviceRecognitionAvailable(this)) {
                recognizer = SpeechRecognizer.createOnDeviceSpeechRecognizer(this);
            } else {
                recognizer = SpeechRecognizer.createSpeechRecognizer(this);
            }
        } catch (Exception error) {
            publishError("STT_UNAVAILABLE");
            return;
        }

        recognizer.setRecognitionListener(new RecognitionListener() {
            @Override public void onReadyForSpeech(Bundle params) { machine.transition(VoiceStateMachine.State.LISTENING); publishState(); }
            @Override public void onBeginningOfSpeech() { }
            @Override public void onRmsChanged(float rmsdB) { }
            @Override public void onBufferReceived(byte[] buffer) { }
            @Override public void onEndOfSpeech() { machine.transition(VoiceStateMachine.State.TRANSCRIBING); publishState(); }
            @Override public void onPartialResults(Bundle partialResults) { }
            @Override public void onEvent(int eventType, Bundle params) { }

            @Override
            public void onError(int error) {
                destroyRecognizer();
                VoicePlugin.emitVoiceError("STT_ERROR_" + error);
                returnToReadyState();
            }

            @Override
            public void onResults(Bundle results) {
                ArrayList<String> values = results.getStringArrayList(SpeechRecognizer.RESULTS_RECOGNITION);
                float[] confidences = results.getFloatArray(SpeechRecognizer.CONFIDENCE_SCORES);
                String transcript = values == null || values.isEmpty() ? "" : values.get(0).trim();
                float confidence = confidences != null && confidences.length > 0 ? confidences[0] : 1.0f;
                destroyRecognizer();
                if (transcript.isEmpty() || (confidence >= 0f && confidence < 0.35f)) {
                    VoicePlugin.emitVoiceError("STT_NO_CONFIDENT_TRANSCRIPTION");
                    returnToReadyState();
                    return;
                }
                handleTranscript(transcript);
            }
        });

        Intent recognizerIntent = new Intent(RecognizerIntent.ACTION_RECOGNIZE_SPEECH);
        recognizerIntent.putExtra(RecognizerIntent.EXTRA_LANGUAGE_MODEL, RecognizerIntent.LANGUAGE_MODEL_FREE_FORM);
        recognizerIntent.putExtra(RecognizerIntent.EXTRA_LANGUAGE, Locale.getDefault().toLanguageTag());
        recognizerIntent.putExtra(RecognizerIntent.EXTRA_PARTIAL_RESULTS, false);
        recognizer.startListening(recognizerIntent);
        machine.transition(VoiceStateMachine.State.LISTENING);
        publishState();
    }

    private void handleTranscript(String transcript) {
        lastTranscription = transcript;
        VoicePlugin.emitTranscription(transcript, activeVoiceCommandId);

        VoiceStateMachine.Snapshot snapshot = machine.snapshot();
        // The state has normally just left TRANSCRIBING; pendingAction is the authoritative
        // marker for an approval interaction, not the literal word "yes".
        if (pendingAction != null && "PERMISSION".equals(pendingAction.type) && isExplicitApproval(transcript)) {
            if ("CRITICAL".equals(pendingAction.riskLevel)) {
                VoicePlugin.emitVoiceError("CRITICAL_APPROVAL_REQUIRES_UNLOCKED_UI");
                machine.waiting(VoiceStateMachine.WaitingReason.PERMISSION, pendingAction.taskId);
                publishState();
                return;
            }
            final String taskId = pendingAction.taskId;
            machine.transition(VoiceStateMachine.State.PROCESSING);
            publishState();
            networkExecutor.execute(() -> {
                try {
                    client.respondToOperation(taskId, "authorize", null);
                    pendingAction = null;
                    runOnMain(() -> speakText("Autorisation enregistrée pour cette opération.", false));
                } catch (Exception error) {
                    runOnMain(() -> publishError(error.getMessage() == null ? "VOICE_APPROVAL_FAILED" : error.getMessage()));
                }
            });
            return;
        }

        // WAITING_INPUT intentionally starts a NEW Agent interaction. The previous
        // service operation is not resumed because service continuation is unsupported.
        pendingAction = null;
        final String commandId = activeVoiceCommandId == null ? UUID.randomUUID().toString() : activeVoiceCommandId;
        machine.transition(VoiceStateMachine.State.PROCESSING);
        publishState();
        networkExecutor.execute(() -> {
            try {
                NativeJarvisClient.VoiceResponse result = client.executeVoiceCommand(commandId, transcript, currentWorkspaceId);
                lastResponse = result.response;
                pendingAction = result.pendingAction;
                VoicePlugin.emitVoiceResponse(result.voiceCommandId, result.response, result.speechText);
                runOnMain(() -> speakText(result.speechText, false));
            } catch (Exception error) {
                runOnMain(() -> publishError(error.getMessage() == null ? "VOICE_BACKEND_FAILED" : error.getMessage()));
            }
        });
    }

    private boolean isExplicitApproval(String transcript) {
        String normalized = transcript.toLowerCase(Locale.ROOT);
        boolean invokesJarvis = normalized.contains("jarvis");
        boolean explicitVerb = normalized.contains("autorise") || normalized.contains("j'autorise")
                || normalized.contains("approuve") || normalized.contains("j'approuve")
                || normalized.contains("valide l'action") || normalized.contains("authorize") || normalized.contains("approve");
        return invokesJarvis && explicitVerb;
    }

    private void speakText(String text, boolean alert) {
        String value = text == null ? "" : text.trim();
        if (value.isEmpty()) {
            afterSpeech(alert);
            return;
        }
        if (!ttsReady || tts == null) {
            VoicePlugin.emitVoiceError("TTS_UNAVAILABLE");
            afterSpeech(alert);
            return;
        }
        requestAudioFocus();
        machine.transition(VoiceStateMachine.State.SPEAKING);
        publishState();
        String utteranceId = (alert ? "alert-" : "voice-") + UUID.randomUUID();
        int status = tts.speak(value, TextToSpeech.QUEUE_FLUSH, null, utteranceId);
        if (status == TextToSpeech.ERROR) {
            VoicePlugin.emitVoiceError("TTS_SPEAK_FAILED");
            abandonAudioFocus();
            afterSpeech(alert);
        }
    }

    private void initTts() {
        tts = new TextToSpeech(this, status -> {
            ttsReady = status == TextToSpeech.SUCCESS;
            if (!ttsReady) {
                VoicePlugin.emitVoiceError("TTS_INIT_FAILED");
                return;
            }
            tts.setLanguage(Locale.getDefault());
            tts.setOnUtteranceProgressListener(new UtteranceProgressListener() {
                @Override public void onStart(String utteranceId) { }
                @Override public void onError(String utteranceId) { runOnMain(() -> { abandonAudioFocus(); VoicePlugin.emitVoiceError("TTS_ERROR"); afterSpeech(utteranceId.startsWith("alert-")); }); }
                @Override public void onDone(String utteranceId) { runOnMain(() -> { abandonAudioFocus(); afterSpeech(utteranceId.startsWith("alert-")); }); }
            });
        });
    }

    private void afterSpeech(boolean alert) {
        if (alert) {
            returnToReadyState();
            return;
        }
        if (pendingAction != null) {
            VoiceStateMachine.WaitingReason reason = "PERMISSION".equals(pendingAction.type)
                    ? VoiceStateMachine.WaitingReason.PERMISSION : VoiceStateMachine.WaitingReason.INPUT;
            machine.waiting(reason, pendingAction.taskId);
            publishState();
            return;
        }
        if ("CONVERSATION".equals(voiceMode)) {
            beginSpeechRecognition(UUID.randomUUID().toString());
        } else {
            returnToReadyState();
        }
    }

    private void stopSpeakingInternal(boolean audioFocusLoss) {
        if (tts != null) tts.stop();
        abandonAudioFocus();
        if (audioFocusLoss) VoicePlugin.emitVoiceError("AUDIO_FOCUS_LOST");
        returnToReadyState();
    }

    private void returnToReadyState() {
        if ("ALWAYS_LISTENING".equals(voiceMode)) {
            beginWakeWord();
        } else if (!"OFF".equals(voiceMode)) {
            machine.transition(VoiceStateMachine.State.WAITING_WAKE_WORD);
            publishState();
        } else {
            machine.transition(VoiceStateMachine.State.OFF);
            publishState();
        }
    }

    private void pauseVoice() {
        wakeWordEngine.stop();
        destroyRecognizer();
        if (tts != null) tts.stop();
        abandonAudioFocus();
        machine.transition(VoiceStateMachine.State.PAUSED);
        publishState();
    }

    private void resumeVoice() {
        if ("OFF".equals(voiceMode)) {
            machine.transition(VoiceStateMachine.State.OFF);
            publishState();
        } else if ("ALWAYS_LISTENING".equals(voiceMode)) {
            beginWakeWord();
        } else {
            machine.transition(VoiceStateMachine.State.WAITING_WAKE_WORD);
            publishState();
        }
    }

    private void stopVoice() {
        voiceMode = "OFF";
        configStore.setVoiceMode("OFF");
        wakeWordEngine.stop();
        destroyRecognizer();
        if (tts != null) tts.stop();
        abandonAudioFocus();
        machine.transition(VoiceStateMachine.State.OFF);
        publishState();
        stopForeground(true);
        stopSelf();
    }

    private void destroyRecognizer() {
        if (recognizer != null) {
            try { recognizer.cancel(); } catch (Exception ignored) { }
            try { recognizer.destroy(); } catch (Exception ignored) { }
            recognizer = null;
        }
    }

    private void requestAudioFocus() {
        if (audioManager != null) {
            audioManager.requestAudioFocus(audioFocusListener, AudioManager.STREAM_MUSIC, AudioManager.AUDIOFOCUS_GAIN_TRANSIENT);
        }
    }

    private void abandonAudioFocus() {
        if (audioManager != null) audioManager.abandonAudioFocus(audioFocusListener);
    }

    private void publishError(String code) {
        machine.error(code == null ? "VOICE_ERROR" : code);
        publishState();
        VoicePlugin.emitVoiceError(code == null ? "VOICE_ERROR" : code);
    }

    private void publishState() {
        VoiceStateMachine.Snapshot state = machine.snapshot();
        lastSnapshot = new RuntimeSnapshot(
                state.state.name(), state.waitingReason.name(), state.taskId, state.errorCode,
                activeVoiceCommandId, lastTranscription, lastResponse, voiceMode);
        VoicePlugin.emitState(lastSnapshot);
        updateForegroundNotification();
    }

    private void startAsForeground() {
        startForeground(FOREGROUND_NOTIFICATION_ID, buildForegroundNotification());
    }

    private void updateForegroundNotification() {
        NotificationManager manager = (NotificationManager) getSystemService(Context.NOTIFICATION_SERVICE);
        if (manager != null && machine.snapshot().state != VoiceStateMachine.State.OFF) {
            manager.notify(FOREGROUND_NOTIFICATION_ID, buildForegroundNotification());
        }
    }

    private Notification buildForegroundNotification() {
        Intent pause = new Intent(this, VoiceForegroundService.class).setAction(ACTION_PAUSE);
        Intent stop = new Intent(this, VoiceForegroundService.class).setAction(ACTION_STOP);
        Intent stopSpeaking = new Intent(this, VoiceForegroundService.class).setAction(ACTION_STOP_SPEAKING);
        int immutable = PendingIntent.FLAG_UPDATE_CURRENT | (Build.VERSION.SDK_INT >= 23 ? PendingIntent.FLAG_IMMUTABLE : 0);
        PendingIntent pauseIntent = PendingIntent.getService(this, 1, pause, immutable);
        PendingIntent stopIntent = PendingIntent.getService(this, 2, stop, immutable);
        PendingIntent stopSpeakingIntent = PendingIntent.getService(this, 3, stopSpeaking, immutable);
        VoiceStateMachine.Snapshot snapshot = machine.snapshot();
        NotificationCompat.Builder builder = new NotificationCompat.Builder(this, CHANNEL_SERVICE)
                .setSmallIcon(android.R.drawable.ic_btn_speak_now)
                .setContentTitle("Jarvis — mode vocal")
                .setContentText(snapshot.state.name())
                .setOngoing(true)
                .setOnlyAlertOnce(true)
                .setVisibility(NotificationCompat.VISIBILITY_PRIVATE)
                .addAction(0, "Pause", pauseIntent)
                .addAction(0, "Arrêter", stopIntent);
        if (snapshot.state == VoiceStateMachine.State.SPEAKING) builder.addAction(0, "Couper la voix", stopSpeakingIntent);
        return builder.build();
    }

    private void createNotificationChannels() {
        if (Build.VERSION.SDK_INT < Build.VERSION_CODES.O) return;
        NotificationManager manager = (NotificationManager) getSystemService(Context.NOTIFICATION_SERVICE);
        if (manager == null) return;
        NotificationChannel service = new NotificationChannel(CHANNEL_SERVICE, "Jarvis vocal", NotificationManager.IMPORTANCE_LOW);
        service.setDescription("Service vocal actif en arrière-plan");
        manager.createNotificationChannel(service);
        NotificationChannel alerts = new NotificationChannel(CHANNEL_ALERTS, "Alertes Jarvis", NotificationManager.IMPORTANCE_DEFAULT);
        alerts.setDescription("Notifications locales sûres provenant de Jarvis");
        manager.createNotificationChannel(alerts);
    }

    private void pollNativeAlertsSafely() {
        if ("OFF".equals(voiceMode)) return;
        VoiceStateMachine.State current = machine.snapshot().state;
        if (current != VoiceStateMachine.State.WAITING_WAKE_WORD && current != VoiceStateMachine.State.PAUSED) return;
        try {
            JSONArray alerts = client.getPendingNativeAlerts();
            for (int index = 0; index < alerts.length(); index++) {
                JSONObject alert = alerts.getJSONObject(index);
                String id = alert.optString("notificationId", "");
                if (id.isEmpty()) continue;
                boolean android = alert.optBoolean("android", false);
                boolean voice = alert.optBoolean("voice", false);
                if (android) showNativeAlert(alert);
                if (voice && machine.snapshot().state == VoiceStateMachine.State.WAITING_WAKE_WORD) {
                    String title = alert.optString("title", "Alerte Jarvis");
                    runOnMain(() -> speakText("Alerte Jarvis. " + title, true));
                }
                client.acknowledgeNativeAlert(id);
            }
        } catch (Exception ignored) {
            // Polling is best effort; absence of network must not stop the wake-word loop.
        }
    }

    private void showNativeAlert(JSONObject alert) {
        NotificationManager manager = (NotificationManager) getSystemService(Context.NOTIFICATION_SERVICE);
        if (manager == null) return;
        String title = alert.optString("title", "Jarvis");
        String safeMessage = alert.optString("lockscreenMessage", "Ouvrez Jarvis pour consulter les détails.");
        Notification publicVersion = new NotificationCompat.Builder(this, CHANNEL_ALERTS)
                .setSmallIcon(android.R.drawable.ic_dialog_info)
                .setContentTitle("Jarvis")
                .setContentText("Nouvelle notification")
                .build();
        Notification notification = new NotificationCompat.Builder(this, CHANNEL_ALERTS)
                .setSmallIcon(android.R.drawable.ic_dialog_info)
                .setContentTitle(title)
                .setContentText(safeMessage)
                .setAutoCancel(true)
                .setVisibility(NotificationCompat.VISIBILITY_PRIVATE)
                .setPublicVersion(publicVersion)
                .build();
        manager.notify(ALERT_NOTIFICATION_BASE + (alertNotificationSequence++ % 1000), notification);
    }

    private void runOnMain(Runnable runnable) {
        new android.os.Handler(getMainLooper()).post(runnable);
    }

    private static String emptyToNull(String value) {
        if (value == null || value.trim().isEmpty()) return null;
        return value.trim();
    }

    @Nullable
    @Override
    public IBinder onBind(Intent intent) {
        return null;
    }

    @Override
    public void onDestroy() {
        wakeWordEngine.stop();
        destroyRecognizer();
        if (tts != null) {
            tts.stop();
            tts.shutdown();
            tts = null;
        }
        alertPoller.shutdownNow();
        networkExecutor.shutdownNow();
        abandonAudioFocus();
        machine.transition(VoiceStateMachine.State.OFF);
        publishState();
        super.onDestroy();
    }
}
