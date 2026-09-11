package com.jarvis.commandcenter.voice;

/**
 * Commercial-safe contract. No third-party wake-word model is bundled in the APK by
 * default; a licensed ONNX/OpenWakeWord-compatible implementation can replace Missing.
 */
public interface WakeWordEngine {
    interface Listener {
        void onWakeWordDetected();
        void onError(String code);
    }

    boolean isConfigured();
    void start(Listener listener);
    void stop();

    final class Missing implements WakeWordEngine {
        @Override
        public boolean isConfigured() {
            return false;
        }

        @Override
        public void start(Listener listener) {
            listener.onError("WAKE_WORD_MODEL_NOT_CONFIGURED");
        }

        @Override
        public void stop() {
            // No audio resource is held.
        }
    }
}
