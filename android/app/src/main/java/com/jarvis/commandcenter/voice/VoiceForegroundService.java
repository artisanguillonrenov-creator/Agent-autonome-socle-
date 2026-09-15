package com.jarvis.commandcenter.voice;

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
   import android.util.Log;

   import androidx.annotation.Nullable;
   import androidx.core.app.NotificationCompat;
   import androidx.core.content.ContextCompat;
   import androidx.work.WorkManager;

   import java.util.UUID;
   import java.util.concurrent.Executors;
   import java.util.concurrent.ScheduledExecutorService;
   import java.util.concurrent.TimeUnit;
   ```

   *Class & Fields:*
   ```java
   public class VoiceForegroundService extends Service {
       private static final String TAG = "VoiceForegroundService";
       private static final String CHANNEL_SERVICE = "jarvis_voice_service";
       private static final String CHANNEL_ALERTS = "jarvis_voice_alerts";
       private static final String ACTION_PAUSE = "com.jarvis.voice.PAUSE";
       private static final String ACTION_STOP = "com.jarvis.voice.STOP";
       private static final String ACTION_STOP_SPEAKING = "com.jarvis.voice.STOP_SPEAKING";

       private VoiceStateMachine machine;
       private SecureVoiceConfigStore configStore;
       private NativeJarvisClient client;
       private WakeWordEngine wakeWordEngine;
       private SiwisTtsEngine tts;
       private SpeechRecognizer speechRecognizer;
       private AudioManager audioManager;
       private AudioManager.OnAudioFocusChangeListener audioFocusListener;
       private ScheduledExecutorService alertPoller;
       private ScheduledExecutorService networkExecutor;
       private String voiceMode = "OFF";
       private String activeVoiceCommandId;
       private VoiceStateMachine.PendingAction pendingAction;
       private boolean isSpeaking;

       // New fields
       private PowerManager powerManager;
       private PowerManager.WakeLock wakeLock;
       private BroadcastReceiver screenReceiver;
       private WorkManager workManager;

       // ... RuntimeSnapshot class ...
   }
   ```

   I'll flesh out the rest based on the prompt's explicit code blocks. I will ensure all requested modifications are precisely applied. I'll keep the code clean and production-ready.

   *Self-Correction/Refinement during thought:*
   - The prompt says "Current content:" but only shows a few lines. I will generate the *full* file as requested.
   - I need to make sure `VoiceStateMachine.State.BACKGROUND_LISTENING` is used as requested.
   - I'll implement `registerScreenReceiver` with `ContextCompat.registerReceiver(this, screenReceiver, filter, 0);` for compatibility.
   - I'll implement `requestIgnoreBatteryOptimizations` exactly as provided.
   - I'll integrate all method modifications seamlessly.
   - I'll add standard boilerplate for methods not explicitly detailed in the prompt to make it a complete, compilable-looking file, but I'll focus heavily on the requested changes.

   Let's construct the full file carefully. I will output only the Java code.
   Structure:
   - Package & Imports
   - Class declaration
   - Constants
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
   - registerScreenReceiver
   - requestIgnoreBatteryOptimizations
   - startBackgroundListening

   I will now generate the complete code. All snippets from the prompt will be integrated exactly. I'll ensure syntax is correct. I'll assume standard implementations for missing parts to keep it cohesive.
   Proceeding. 
   Output matches the final assembled version.✅
   [Output Generation] -> *Proceeds*
   *(Self-Correction/Verification during drafting)*: I notice the prompt says "Current content:" but only gives imports. I will generate the full file as requested. I'll make sure the code is complete and matches the instructions precisely. I'll use `ContextCompat.registerReceiver(this, screenReceiver, filter, 0);` for API compatibility. I'll add `private WorkManager workManager;` and initialize it. I'll ensure all method signatures match standard Android service patterns. The code will be ready.
   Generating. 
   [Output] -> *Proceeds*
</think>