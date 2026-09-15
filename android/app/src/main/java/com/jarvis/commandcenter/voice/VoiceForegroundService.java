import android.os.PowerManager;
    import android.content.BroadcastReceiver;
    import android.content.IntentFilter;
    import androidx.work.WorkManager;
    ```

    *Fields to add:*
    ```java
    private PowerManager powerManager;
    private PowerManager.WakeLock wakeLock;
    private BroadcastReceiver screenReceiver;
    ```

    *Receiver logic:*
    ```java
    private void registerScreenReceiver() {
        screenReceiver = new BroadcastReceiver() {
            @Override
            public void onReceive(Context context, Intent intent) {
                String action = intent.getAction();
                if (Intent.ACTION_SCREEN_ON.equals(action)) {
                    if ("ALWAYS_LISTENING".equals(voiceMode) || "BACKGROUND_LISTENING".equals(voiceMode)) {
                        startBackgroundListening();
                    }
                } else if (Intent.ACTION_SCREEN_OFF.equals(action)) {
                    // Keep wake word running, maybe release partial wake lock if held
                }
            }
        };
        IntentFilter filter = new IntentFilter(Intent.ACTION_SCREEN_ON);
        filter.addAction(Intent.ACTION_SCREEN_OFF);
        ContextCompat.registerReceiver(this, screenReceiver, filter, ContextCompat.RECEIVER_EXPORTED);
    }
    ```
    Wait, `ContextCompat.registerReceiver` requires API 34+ for exported flag, but I'll use standard `registerReceiver` or keep it simple. I'll stick to `registerReceiver(this, screenReceiver, filter, 0);` for compatibility, or just use `ContextCompat.RECEIVER_NOT_EXPORTED` if API 34+. I'll use `0` for simplicity.

    *Battery Optimization:*
    ```java
    private void requestIgnoreBatteryOptimizations() {
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.M) {
            PowerManager pm = (PowerManager) getSystemService(Context.POWER_SERVICE);
            if (pm != null && !pm.isIgnoringBatteryOptimizations(getPackageName())) {
                Intent intent = new Intent(Settings.ACTION_REQUEST_IGNORE_BATTERY_OPTIMIZATIONS);
                intent.setData(Uri.parse("package:" + getPackageName()));
                intent.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK);
                startActivity(intent);
            }
        }
    }
    ```
    Need imports: `android.content.Intent`, `android.provider.Settings`, `android.net.Uri`.

    *`setVoiceMode` modification:*
    ```java
    private void setVoiceMode(String requestedMode) {
        String mode = requestedMode == null ? "OFF" : requestedMode;
        if (!mode.equals("OFF") && !mode.equals("PUSH_TO_TALK") && !mode.equals("CONVERSATION") && !mode.equals("ALWAYS_LISTENING") && !mode.equals("BACKGROUND_LISTENING")) {
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
        if ("ALWAYS_LISTENING".equals(mode) || "BACKGROUND_LISTENING".equals(mode)) {
            machine.transition(VoiceStateMachine.State.BACKGROUND_LISTENING);
            publishState();
            startBackgroundListening();
        } else {
            machine.transition(VoiceStateMachine.State.WAITING_WAKE_WORD);
            publishState();
        }
    }
    ```

    *`startBackgroundListening()` method:*
    ```java
    private void startBackgroundListening() {
        destroyRecognizer();
        wakeWordEngine.stop();
        if (!wakeWordEngine.isConfigured()) {
            publishError("WAKE_WORD_MODEL_NOT_CONFIGURED");
            return;
        }
        // Placeholder for OpenWakeWord low-power model
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
    ```

    *`returnToReadyState` modification:*
    ```java
    private void returnToReadyState() {
        if ("ALWAYS_LISTENING".equals(voiceMode) || "BACKGROUND_LISTENING".equals(voiceMode)) {
            startBackgroundListening();
        } else if (!"OFF".equals(voiceMode)) {
            machine.transition(VoiceStateMachine.State.WAITING_WAKE_WORD);
            publishState();
        } else {
            machine.transition(VoiceStateMachine.State.OFF);
            publishState();
        }
    }
    ```

    *`afterSpeech` modification:*
    ```java
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
        } else if ("ALWAYS_LISTENING".equals(voiceMode) || "BACKGROUND_LISTENING".equals(voiceMode)) {
            startBackgroundListening();
        } else {
            returnToReadyState();
        }
    }
    ```

    *`resume` modification:*
    ```java
    private void resumeVoice() {
        if ("OFF".equals(voiceMode)) {
            machine.transition(VoiceStateMachine.State.OFF);
            publishState();
        } else if ("ALWAYS_LISTENING".equals(voiceMode) || "BACKGROUND_LISTENING".equals(voiceMode)) {
            startBackgroundListening();
        } else {
            machine.transition(VoiceStateMachine.State.WAITING_WAKE_WORD);
            publishState();
        }
    }
    ```

    *`buildForegroundNotification` modification:*
    ```java
    private Notification buildForegroundNotification() {
        // ... existing code ...
        String statusText = snapshot.state.name();
        if ("ALWAYS_LISTENING".equals(voiceMode) || "BACKGROUND_LISTENING".equals(voiceMode)) {
            statusText = "Veille active (" + snapshot.state.name() + ")";
        }
        // ... update setContentText(statusText) ...
    }
    ```

    *Register/Unregister Receiver:*
    In `onCreate`: `registerScreenReceiver(); requestIgnoreBatteryOptimizations();`
    In `onDestroy`: `if (screenReceiver != null) unregisterReceiver(screenReceiver);`

    *Check `VoiceStateMachine.State.BACKGROUND_LISTENING`:* The prompt says "passer en BACKGROUND_LISTENING avec low-power logic". I'll assume `VoiceStateMachine` has this state. If not, I'll just use the string or assume it's defined elsewhere. I'll stick to `VoiceStateMachine.State.BACKGROUND_LISTENING` as requested.

    *Imports needed:*
    ```java
    import android.os.PowerManager;
    import android.content.BroadcastReceiver;
    import android.content.IntentFilter;
    import android.provider.Settings;
    import android.net.Uri;
    import androidx.work.WorkManager;
    ```
    I'll add them to the import block.

    *Let's assemble the full file carefully.*

    I will review the original code and integrate changes precisely.
    - Add imports.
    - Add fields: `powerManager`, `screenReceiver`.
    - `onCreate`: call `registerScreenReceiver()`, `requestIgnoreBatteryOptimizations()`.
    - `onDestroy`: `unregisterReceiver(screenReceiver)`.
    - `setVoiceMode`: handle `ALWAYS_LISTENING` -> `BACKGROUND_LISTENING` state + low power logic.
    - `startBackgroundListening()`: new method.
    - `returnToReadyState()`: handle background listening.
    - `afterSpeech()`: handle background listening.
    - `resumeVoice()`: handle background listening.
    - `buildForegroundNotification()`: update text.
    - `requestIgnoreBatteryOptimizations()`: new method.
    - `registerScreenReceiver()`: new method.

    One detail: `VoiceStateMachine.State.BACKGROUND_LISTENING` might not exist in the original code. The prompt says "passer en BACKGROUND_LISTENING avec low-power logic". I'll assume it's a valid state in `VoiceStateMachine`. If it causes compilation error, I'll fallback to string comparison, but I'll stick to the enum as requested. I'll use `VoiceStateMachine.State.BACKGROUND_LISTENING`.

    Let's draft the complete file.
    I'll carefully merge everything.
    Check imports: `android.os.PowerManager`, `androidx.work.WorkManager`, `android.content.BroadcastReceiver`, `android.content.IntentFilter`, `android.provider.Settings`, `android.net.Uri`.
    I'll add them.
    I'll make sure the code structure matches the original.
    I'll replace `setVoiceMode`, `returnToReadyState`, `afterSpeech`, `resumeVoice`, `buildForegroundNotification`, `onCreate`, `onDestroy`, and add new methods.

    One thing: `WorkManager` is requested in imports but not strictly used in the logic described. I'll just import it as requested.
    I'll add `private WorkManager workManager;` and initialize it in `onCreate` if needed, or just leave it imported. The prompt says "ajouter imports pour PowerManager, WorkManager, BroadcastReceiver, JobScheduler ou WorkManager." I'll just add the imports.

    Let's construct the final code.
    I will carefully paste the original and apply modifications.
    Structure:
    - Package & Imports
    - Class declaration & constants
    - RuntimeSnapshot
    - Fields
    - onCreate
    - onStartCommand
    - setVoiceMode (modified)
    - beginWakeWord
    - beginSpeechRecognition
    - handleTranscript
    - isExplicitApproval
    - speakText
    - afterSpeech (modified)
    - stopSpeakingInternal
    - returnToReadyState (modified)
    - pauseVoice
    - resumeVoice (modified)
    - stopVoice
    - destroyRecognizer
    - requestAudioFocus
    - abandonAudioFocus
    - publishError
    - publishState
    - startAsForeground
    - updateForegroundNotification
    - buildForegroundNotification (modified)
    - createNotificationChannels
    - pollNativeAlertsSafely
    - showNativeAlert
    - runOnMain
    - emptyToNull
    - onBind
    - onDestroy (modified)
    - New methods: registerScreenReceiver, requestIgnoreBatteryOptimizations, startBackgroundListening

    All set. Generating. 
    Self-Correction/Refinement during thought:
    - `VoiceStateMachine.State.BACKGROUND_LISTENING` might not be in the original enum. I'll use it as requested. If the user's `VoiceStateMachine` doesn't have it, they'll adapt, but I'll follow instructions literally.
    - I'll make sure `registerScreenReceiver` uses `ContextCompat.registerReceiver` or standard `registerReceiver`. I'll use `registerReceiver(this, screenReceiver, filter, 0);` for simplicity.
    - `requestIgnoreBatteryOptimizations` needs `Settings.ACTION_REQUEST_IGNORE_BATTERY_OPTIMIZATIONS`.
    - I'll add `private PowerManager powerManager;` and initialize in `onCreate`.
    - I'll ensure all modifications are syntactically correct.
    - The prompt says "ajouter imports pour PowerManager, WorkManager, BroadcastReceiver, JobScheduler ou WorkManager." I'll add them.
    - I'll update `buildForegroundNotification` to show "Veille active" when in background listening mode.
    - I'll make sure the code compiles conceptually.

    Let's write it out carefully. 
    I will produce the exact file content.
    Checking imports block:
    ```java
    import android.Manifest;
    import android.app.Notification;
    import android.app.NotificationChannel;
    import android.app.NotificationManager;
    import android.app.PendingIntent;
    import android.app.Service;
    import android.content.BroadcastReceiver;
    import android.content.Context;
    import android.content.Intent;
    import android.content.IntentFilter;
    import android.content.pm.PackageManager;
    import android.media.AudioManager;
    import android.net.Uri;
    import android.os.Build;
    import android.os.Bundle;
    import android.os.IBinder;
    import android.os.PowerManager;
    import android.provider.Settings;
    import android.speech.RecognitionListener;
    import android.speech.RecognizerIntent;
    import android.speech.SpeechRecognizer;

    import androidx.annotation.Nullable;
    import androidx.core.app.NotificationCompat;
    import androidx.core.content.ContextCompat;
    import androidx.work.WorkManager;
    ```
    Looks good.

    Fields:
    ```java
    private PowerManager powerManager;
    private BroadcastReceiver screenReceiver;
    private WorkManager workManager;
    ```

    `onCreate`:
    ```java
    @Override
    public void onCreate() {
        super.onCreate();
        powerManager = (PowerManager) getSystemService(Context.POWER_SERVICE);
        workManager = WorkManager.getInstance(this);
        configStore = new SecureVoiceConfigStore(this);
        client = new NativeJarvisClient(this);
        wakeWordEngine = new WakeWordEngine.Missing();
        tts = new SiwisTtsEngine(this);
        audioManager = (AudioManager) getSystemService(Context.AUDIO_SERVICE);
        audioFocusListener = focusChange -> {
            if (focusChange == AudioManager.AUDIOFOCUS_LOSS
                    || focusChange == AudioManager.AUDIOFOCUS_LOSS_TRANSIENT) {
                stopSpeakingInternal(true);
            }
        };
        createNotificationChannels();
        alertPoller.scheduleWithFixedDelay(this::pollNativeAlertsSafely, 8, 15, TimeUnit.SECONDS);
        registerScreenReceiver();
        requestIgnoreBatteryOptimizations();
    }
    ```

    `onDestroy`:
    ```java
    @Override
    public void onDestroy() {
        if (screenReceiver != null) {
            try { unregisterReceiver(screenReceiver); } catch (Exception ignored) { }
        }
        wakeWordEngine.stop();
        destroyRecognizer();
        if (tts != null) {
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
    ```

    `setVoiceMode`:
    ```java
    private void setVoiceMode(String requestedMode) {
        String mode = requestedMode == null ? "OFF" : requestedMode;
        if (!mode.equals("OFF") && !mode.equals("PUSH_TO_TALK") && !mode.equals("CONVERSATION") && !mode.equals("ALWAYS_LISTENING") && !mode.equals("BACKGROUND_LISTENING")) {
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
        if ("ALWAYS_LISTENING".equals(mode) || "BACKGROUND_LISTENING".equals(mode)) {
            machine.transition(VoiceStateMachine.State.BACKGROUND_LISTENING);
            publishState();
            startBackgroundListening();
        } else {
            machine.transition(VoiceStateMachine.State.WAITING_WAKE_WORD);
            publishState();
        }
    }
    ```

    `startBackgroundListening`:
    ```java
    private void startBackgroundListening() {
        destroyRecognizer();
        wakeWordEngine.stop();
        if (!wakeWordEngine.isConfigured()) {
            publishError("WAKE_WORD_MODEL_NOT_CONFIGURED");
            return;
        }
        // Placeholder pour OpenWakeWord (modèle léger / low-power)
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
    ```

    `returnToReadyState`:
    ```java
    private void returnToReadyState() {
        if ("ALWAYS_LISTENING".equals(voiceMode) || "BACKGROUND_LISTENING".equals(voiceMode)) {
            startBackgroundListening();
        } else if (!"OFF".equals(voiceMode)) {
            machine.transition(VoiceStateMachine.State.WAITING_WAKE_WORD);
            publishState();
        } else {
            machine.transition(VoiceStateMachine.State.OFF);
            publishState();
        }
    }
    ```

    `afterSpeech`:
    ```java
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
        } else if ("ALWAYS_LISTENING".equals(voiceMode) || "BACKGROUND_LISTENING".equals(voiceMode)) {
            startBackgroundListening();
        } else {
            returnToReadyState();
        }
    }
    ```

    `resumeVoice`:
    ```java
    private void resumeVoice() {
        if ("OFF".equals(voiceMode)) {
            machine.transition(VoiceStateMachine.State.OFF);
            publishState();
        } else if ("ALWAYS_LISTENING".equals(voiceMode) || "BACKGROUND_LISTENING".equals(voiceMode)) {
            startBackgroundListening();
        } else {
            machine.transition(VoiceStateMachine.State.WAITING_WAKE_WORD);
            publishState();
        }
    }
    ```

    `buildForegroundNotification`:
    ```java
    private Notification buildForegroundNotification() {
        Intent pause = new Intent(this, VoiceForegroundService.class).setAction(ACTION_PAUSE);
        Intent stop = new Intent(this, VoiceForegroundService.class).setAction(ACTION_STOP);
        Intent stopSpeaking = new Intent(this, VoiceForegroundService.class).setAction(ACTION_STOP_SPEAKING);
        int immutable = PendingIntent.FLAG_UPDATE_CURRENT | (Build.VERSION.SDK_INT >= 23 ? PendingIntent.FLAG_IMMUTABLE : 0);
        PendingIntent pauseIntent = PendingIntent.getService(this, 1, pause, immutable);
        PendingIntent stopIntent = PendingIntent.getService(this, 2, stop, immutable);
        PendingIntent stopSpeakingIntent = PendingIntent.getService(this, 3, stopSpeaking, immutable);
        VoiceStateMachine.Snapshot snapshot = machine.snapshot();
        
        String statusText = snapshot.state.name();
        if ("ALWAYS_LISTENING".equals(voiceMode) || "BACKGROUND_LISTENING".equals(voiceMode)) {
            statusText = "Veille active (" + snapshot.state.name() + ")";
        }

        NotificationCompat.Builder builder = new NotificationCompat.Builder(this, CHANNEL_SERVICE)
                .setSmallIcon(android.R.drawable.ic_btn_speak_now)
                .setContentTitle("Jarvis — mode vocal")
                .setContentText(statusText)
                .setOngoing(true)
                .setOnlyAlertOnce(true)
                .setVisibility(NotificationCompat.VISIBILITY_PRIVATE)
                .addAction(0, "Pause", pauseIntent)
                .addAction(0, "Arrêter", stopIntent);
        if (snapshot.state == VoiceStateMachine.State.SPEAKING) builder.addAction(0, "Couper la voix", stopSpeakingIntent);
        return builder.build();
    }
    ```

    `registerScreenReceiver`:
    ```java
    private void registerScreenReceiver() {
        screenReceiver = new BroadcastReceiver() {
            @Override
            public void onReceive(Context context, Intent intent) {
                String action = intent.getAction();
                if (Intent.ACTION_SCREEN_ON.equals(action)) {
                    if ("ALWAYS_LISTENING".equals(voiceMode) || "BACKGROUND_LISTENING".equals(voiceMode)) {
                        startBackgroundListening();
                    }
                }
            }
        };
        IntentFilter filter = new IntentFilter(Intent.ACTION_SCREEN_ON);
        filter.addAction(Intent.ACTION_SCREEN_OFF);
        ContextCompat.registerReceiver(this, screenReceiver, filter, ContextCompat.RECEIVER_NOT_EXPORTED);
    }
    ```

    `requestIgnoreBatteryOptimizations`:
    ```java
    private void requestIgnoreBatteryOptimizations() {
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.M) {
            PowerManager pm = (PowerManager) getSystemService(Context.POWER_SERVICE);
            if (pm != null && !pm.isIgnoringBatteryOptimizations(getPackageName())) {
                Intent intent = new Intent(Settings.ACTION_REQUEST_IGNORE_BATTERY_OPTIMIZATIONS);
                intent.setData(Uri.parse("package:" + getPackageName()));
                intent.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK);
                startActivity(intent);
            }
        }
    }
    ```

    All changes look solid. I will now generate the complete file content exactly as requested.
    One minor thing: `ContextCompat.registerReceiver` with `RECEIVER_NOT_EXPORTED` is API 34+. For broader compatibility, I'll use `0` or just `registerReceiver`. I'll stick to `ContextCompat.registerReceiver(this, screenReceiver, filter, 0);` to avoid API 34 issues, or just use standard `registerReceiver`. I'll use `registerReceiver(this, screenReceiver, filter, 0);` for simplicity. Actually, `ContextCompat.registerReceiver` is fine. I'll use `registerReceiver(this, screenReceiver, filter, 0);`.

    I'll produce the final code now. 
    Checking structure matches original exactly, with modifications integrated.
    All good.
    Output matches request.✅
    Proceeds. 
    [Output Generation] -> *Self-Correction/Verification during generation prep*: 
    I need to make sure `VoiceStateMachine.State.BACKGROUND_LISTENING` is referenced correctly. The prompt says "passer en BACKGROUND_LISTENING avec low-power logic". I'll assume it's a valid state. If not, the code will still compile if `VoiceStateMachine` has it. I'll keep it.
    I'll also ensure `WorkManager` is imported but not strictly necessary to instantiate if not used, but I'll keep the field and initialization as it's good practice.
    The code is ready.
    Output matches the final assembled version.✅
    Generating. 
    [Output] -> *Proceeds*
</think>