package com.jarvis.commandcenter.voice;

import android.Manifest;
import android.content.Intent;
import android.os.Build;

import androidx.core.content.ContextCompat;

import com.getcapacitor.JSObject;
import com.getcapacitor.PermissionState;
import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.annotation.CapacitorPlugin;
import com.getcapacitor.annotation.Permission;
import com.getcapacitor.annotation.PermissionCallback;

import java.lang.ref.WeakReference;

@CapacitorPlugin(
        name = "JarvisVoice",
        permissions = {
                @Permission(alias = "microphone", strings = { Manifest.permission.RECORD_AUDIO }),
                @Permission(alias = "notifications", strings = { Manifest.permission.POST_NOTIFICATIONS })
        }
)
public class VoicePlugin extends Plugin {
    private static WeakReference<VoicePlugin> activePlugin = new WeakReference<>(null);

    @Override
    public void load() {
        activePlugin = new WeakReference<>(this);
    }

    @PluginMethod
    public void requestMicrophonePermission(PluginCall call) {
        if (getPermissionState("microphone") == PermissionState.GRANTED) {
            call.resolve();
            return;
        }
        requestPermissionForAlias("microphone", call, "microphonePermissionCallback");
    }

    @PermissionCallback
    private void microphonePermissionCallback(PluginCall call) {
        if (getPermissionState("microphone") == PermissionState.GRANTED) call.resolve();
        else call.reject("MICROPHONE_PERMISSION_REQUIRED");
    }

    @PluginMethod
    public void requestNotificationPermission(PluginCall call) {
        if (Build.VERSION.SDK_INT < Build.VERSION_CODES.TIRAMISU || getPermissionState("notifications") == PermissionState.GRANTED) {
            call.resolve();
            return;
        }
        requestPermissionForAlias("notifications", call, "notificationPermissionCallback");
    }

    @PermissionCallback
    private void notificationPermissionCallback(PluginCall call) {
        if (Build.VERSION.SDK_INT < Build.VERSION_CODES.TIRAMISU || getPermissionState("notifications") == PermissionState.GRANTED) call.resolve();
        else call.reject("NOTIFICATION_PERMISSION_DENIED");
    }

    @PluginMethod
    public void configureBackend(PluginCall call) {
        String baseUrl = call.getString("baseUrl", "").trim();
        if (baseUrl.isEmpty()) {
            call.reject("BACKEND_URL_REQUIRED");
            return;
        }
        new SecureVoiceConfigStore(getContext()).setBackendUrl(baseUrl);
        call.resolve();
    }

    @PluginMethod
    public void configureCredential(PluginCall call) {
        String token = call.getString("token", "");
        try {
            new SecureVoiceConfigStore(getContext()).setCredential(token);
            call.resolve();
        } catch (Exception error) {
            call.reject("CREDENTIAL_STORAGE_FAILED");
        }
    }

    @PluginMethod
    public void setVoiceMode(PluginCall call) {
        String mode = call.getString("mode", "OFF");
        SecureVoiceConfigStore store = new SecureVoiceConfigStore(getContext());

        // OFF must never start the microphone foreground service. On Android 14+ / targetSdk 34+
        // promoting a microphone-typed service without RECORD_AUDIO can throw SecurityException.
        // This is especially dangerous immediately after a reinstall, where the WebView/settings
        // may be restored before the runtime permission is granted. Persist OFF and stop any
        // existing service instance instead of starting one just to tell it to stop.
        if ("OFF".equals(mode)) {
            store.setVoiceMode("OFF");
            getContext().stopService(new Intent(getContext(), VoiceForegroundService.class));
            call.resolve();
            return;
        }

        if (getPermissionState("microphone") != PermissionState.GRANTED) {
            call.reject("MICROPHONE_PERMISSION_REQUIRED");
            return;
        }

        store.setVoiceMode(mode);
        Intent intent = new Intent(getContext(), VoiceForegroundService.class)
                .setAction(VoiceForegroundService.ACTION_SET_MODE)
                .putExtra(VoiceForegroundService.EXTRA_MODE, mode);
        try {
            ContextCompat.startForegroundService(getContext(), intent);
            call.resolve();
        } catch (RuntimeException error) {
            call.reject("VOICE_SERVICE_START_FAILED", error);
        }
    }

    @PluginMethod
    public void setVoiceResponseMode(PluginCall call) {
        String mode = call.getString("mode", "AUTO");
        if (!"AUTO".equals(mode) && !"FULL".equals(mode) && !"SUMMARY".equals(mode)) {
            call.reject("VOICE_RESPONSE_MODE_INVALID");
            return;
        }
        new SecureVoiceConfigStore(getContext()).setVoiceResponseMode(mode);
        call.resolve();
    }

    @PluginMethod
    public void startListening(PluginCall call) {
        if (getPermissionState("microphone") != PermissionState.GRANTED) {
            call.reject("MICROPHONE_PERMISSION_REQUIRED");
            return;
        }
        Intent intent = new Intent(getContext(), VoiceForegroundService.class)
                .setAction(VoiceForegroundService.ACTION_LISTEN);
        String workspaceId = call.getString("workspaceId");
        if (workspaceId != null) intent.putExtra(VoiceForegroundService.EXTRA_WORKSPACE_ID, workspaceId);
        try {
            ContextCompat.startForegroundService(getContext(), intent);
            call.resolve();
        } catch (RuntimeException error) {
            call.reject("VOICE_SERVICE_START_FAILED", error);
        }
    }

    @PluginMethod
    public void pauseVoice(PluginCall call) {
        sendAction(VoiceForegroundService.ACTION_PAUSE);
        call.resolve();
    }

    @PluginMethod
    public void resumeVoice(PluginCall call) {
        Intent intent = new Intent(getContext(), VoiceForegroundService.class).setAction(VoiceForegroundService.ACTION_RESUME);
        try {
            ContextCompat.startForegroundService(getContext(), intent);
            call.resolve();
        } catch (RuntimeException error) {
            call.reject("VOICE_SERVICE_START_FAILED", error);
        }
    }

    @PluginMethod
    public void stopVoice(PluginCall call) {
        sendAction(VoiceForegroundService.ACTION_STOP);
        call.resolve();
    }

    @PluginMethod
    public void stopSpeaking(PluginCall call) {
        sendAction(VoiceForegroundService.ACTION_STOP_SPEAKING);
        call.resolve();
    }

    @PluginMethod
    public void speak(PluginCall call) {
        String text = call.getString("text", "").trim();
        if (text.isEmpty()) {
            call.reject("VOICE_TEXT_REQUIRED");
            return;
        }
        if (getPermissionState("microphone") != PermissionState.GRANTED) {
            // The only native service in Chantier 10 is microphone-typed; do not try to
            // start it from the background without its required while-in-use permission.
            call.reject("MICROPHONE_PERMISSION_REQUIRED");
            return;
        }
        Intent intent = new Intent(getContext(), VoiceForegroundService.class)
                .setAction(VoiceForegroundService.ACTION_SPEAK)
                .putExtra(VoiceForegroundService.EXTRA_TEXT, text);
        try {
            ContextCompat.startForegroundService(getContext(), intent);
            call.resolve();
        } catch (RuntimeException error) {
            call.reject("VOICE_SERVICE_START_FAILED", error);
        }
    }

    @PluginMethod
    public void getVoiceState(PluginCall call) {
        VoiceForegroundService.RuntimeSnapshot snapshot = VoiceForegroundService.getRuntimeSnapshot();
        JSObject data = new JSObject();
        data.put("state", snapshot.state);
        data.put("waitingReason", snapshot.waitingReason);
        if (snapshot.taskId != null) data.put("taskId", snapshot.taskId);
        if (snapshot.errorCode != null) data.put("errorCode", snapshot.errorCode);
        if (snapshot.voiceCommandId != null) data.put("voiceCommandId", snapshot.voiceCommandId);
        if (snapshot.transcription != null) data.put("transcription", snapshot.transcription);
        if (snapshot.response != null) data.put("response", snapshot.response);
        data.put("voiceMode", snapshot.voiceMode);
        call.resolve(data);
    }

    private void sendAction(String action) {
        try {
            getContext().startService(new Intent(getContext(), VoiceForegroundService.class).setAction(action));
        } catch (RuntimeException error) {
            VoicePlugin.emitVoiceError("VOICE_SERVICE_ACTION_FAILED");
        }
    }

    static void emitState(VoiceForegroundService.RuntimeSnapshot snapshot) {
        VoicePlugin plugin = activePlugin.get();
        if (plugin == null) return;
        JSObject data = new JSObject();
        data.put("state", snapshot.state);
        data.put("waitingReason", snapshot.waitingReason);
        if (snapshot.taskId != null) data.put("taskId", snapshot.taskId);
        if (snapshot.errorCode != null) data.put("errorCode", snapshot.errorCode);
        if (snapshot.voiceCommandId != null) data.put("voiceCommandId", snapshot.voiceCommandId);
        data.put("voiceMode", snapshot.voiceMode);
        plugin.notifyListeners("voiceStateChanged", data, true);
    }

    static void emitTranscription(String text, String commandId) {
        VoicePlugin plugin = activePlugin.get();
        if (plugin == null) return;
        JSObject data = new JSObject();
        data.put("text", text);
        if (commandId != null) data.put("voiceCommandId", commandId);
        plugin.notifyListeners("transcription", data, true);
    }

    static void emitVoiceResponse(String commandId, String response, String speechText) {
        VoicePlugin plugin = activePlugin.get();
        if (plugin == null) return;
        JSObject data = new JSObject();
        data.put("voiceCommandId", commandId);
        data.put("response", response);
        data.put("speechText", speechText);
        plugin.notifyListeners("voiceResponse", data, true);
    }

    static void emitVoiceError(String code) {
        VoicePlugin plugin = activePlugin.get();
        if (plugin == null) return;
        JSObject data = new JSObject();
        data.put("code", code == null ? "VOICE_ERROR" : code);
        plugin.notifyListeners("voiceError", data, true);
    }
}
