package com.jarvis.commandcenter.voice;

import android.content.Context;
import android.content.res.AssetManager;
import android.media.AudioAttributes;
import android.media.AudioFormat;
import android.media.AudioTrack;
import android.os.Build;

import com.k2fsa.sherpa.onnx.GeneratedAudio;
import com.k2fsa.sherpa.onnx.GenerationConfig;
import com.k2fsa.sherpa.onnx.OfflineTts;
import com.k2fsa.sherpa.onnx.OfflineTtsConfig;
import com.k2fsa.sherpa.onnx.OfflineTtsModelConfig;
import com.k2fsa.sherpa.onnx.OfflineTtsVitsModelConfig;

import java.io.File;
import java.io.FileOutputStream;
import java.io.IOException;
import java.io.InputStream;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;
import java.util.concurrent.atomic.AtomicLong;

/**
 * Jarvis' embedded French voice. The Piper/SIWIS model is packaged in the APK by
 * scripts/fetch-siwis-voice.sh and inference runs locally through sherpa-onnx.
 * No Android system TTS engine, network request or separate TTS application is required.
 */
final class SiwisTtsEngine {
    interface Listener {
        void onDone();
        void onError(String code);
    }

    static final String MODEL_DIR = "voice/vits-piper-fr_FR-siwis-medium";
    static final String MODEL_FILE = MODEL_DIR + "/fr_FR-siwis-medium.onnx";
    static final String TOKENS_FILE = MODEL_DIR + "/tokens.txt";
    static final String ESPEAK_ASSET_DIR = MODEL_DIR + "/espeak-ng-data";

    private final Context context;
    private final AssetManager assets;
    private final ExecutorService executor = Executors.newSingleThreadExecutor();
    private final AtomicLong playbackGeneration = new AtomicLong();
    private volatile AudioTrack activeTrack;
    private volatile boolean shutdown;

    SiwisTtsEngine(Context context) {
        this.context = context.getApplicationContext();
        this.assets = this.context.getAssets();
    }

    boolean isAvailable() {
        try (InputStream model = assets.open(MODEL_FILE); InputStream tokens = assets.open(TOKENS_FILE)) {
            return model.read() >= 0 && tokens.read() >= 0;
        } catch (Exception ignored) {
            return false;
        }
    }

    void speak(String text, Listener listener) {
        String value = text == null ? "" : text.trim();
        if (value.isEmpty()) {
            listener.onDone();
            return;
        }
        if (shutdown) {
            listener.onError("SIWIS_TTS_SHUTDOWN");
            return;
        }

        stop();
        long generation = playbackGeneration.incrementAndGet();
        executor.execute(() -> synthesizeAndPlay(value, generation, listener));
    }

    void stop() {
        playbackGeneration.incrementAndGet();
        AudioTrack track = activeTrack;
        activeTrack = null;
        if (track != null) {
            try { track.pause(); } catch (Exception ignored) { }
            try { track.flush(); } catch (Exception ignored) { }
            try { track.stop(); } catch (Exception ignored) { }
            try { track.release(); } catch (Exception ignored) { }
        }
    }

    void shutdown() {
        shutdown = true;
        stop();
        executor.shutdownNow();
    }

    private void synthesizeAndPlay(String text, long generation, Listener listener) {
        if (!isCurrent(generation)) return;
        OfflineTts tts = null;
        try {
            if (!isAvailable()) {
                listener.onError("SIWIS_TTS_MODEL_MISSING");
                return;
            }

            String dataDir = ensureEspeakDataDir().getAbsolutePath();

            OfflineTtsVitsModelConfig vits = new OfflineTtsVitsModelConfig();
            vits.setModel(MODEL_FILE);
            vits.setTokens(TOKENS_FILE);
            vits.setDataDir(dataDir);
            vits.setNoiseScale(0.667f);
            vits.setNoiseScaleW(0.8f);
            vits.setLengthScale(1.0f);

            OfflineTtsModelConfig model = new OfflineTtsModelConfig();
            model.setVits(vits);
            model.setNumThreads(2);
            model.setDebug(false);
            model.setProvider("cpu");

            OfflineTtsConfig config = new OfflineTtsConfig();
            config.setModel(model);
            config.setMaxNumSentences(1);
            config.setSilenceScale(0.2f);

            tts = new OfflineTts(assets, config);

            GenerationConfig generationConfig = new GenerationConfig();
            generationConfig.setSid(0);
            generationConfig.setSpeed(1.0f);
            generationConfig.setSilenceScale(0.2f);

            GeneratedAudio audio = tts.generateWithConfig(text, generationConfig);
            if (!isCurrent(generation)) return;
            if (audio == null || audio.getSamples() == null || audio.getSamples().length == 0 || audio.getSampleRate() <= 0) {
                listener.onError("SIWIS_TTS_EMPTY_AUDIO");
                return;
            }

            playBlocking(audio.getSamples(), audio.getSampleRate(), generation);
            if (isCurrent(generation)) listener.onDone();
        } catch (Throwable error) {
            if (isCurrent(generation)) listener.onError("SIWIS_TTS_FAILED");
        } finally {
            if (tts != null) {
                try { tts.release(); } catch (Throwable ignored) { }
            }
        }
    }

    private void playBlocking(float[] samples, int sampleRate, long generation) throws Exception {
        int usage = Build.VERSION.SDK_INT >= Build.VERSION_CODES.O
                ? AudioAttributes.USAGE_ASSISTANT
                : AudioAttributes.USAGE_ASSISTANCE_ACCESSIBILITY;
        int minBuffer = AudioTrack.getMinBufferSize(
                sampleRate,
                AudioFormat.CHANNEL_OUT_MONO,
                AudioFormat.ENCODING_PCM_FLOAT);
        int requestedBytes = Math.max(samples.length * Float.BYTES, Math.max(minBuffer, 4096));

        AudioTrack track = new AudioTrack.Builder()
                .setAudioAttributes(new AudioAttributes.Builder()
                        .setUsage(usage)
                        .setContentType(AudioAttributes.CONTENT_TYPE_SPEECH)
                        .build())
                .setAudioFormat(new AudioFormat.Builder()
                        .setEncoding(AudioFormat.ENCODING_PCM_FLOAT)
                        .setSampleRate(sampleRate)
                        .setChannelMask(AudioFormat.CHANNEL_OUT_MONO)
                        .build())
                .setTransferMode(AudioTrack.MODE_STATIC)
                .setBufferSizeInBytes(requestedBytes)
                .build();

        activeTrack = track;
        int written = track.write(samples, 0, samples.length, AudioTrack.WRITE_BLOCKING);
        if (written < samples.length) throw new IOException("SIWIS_AUDIO_WRITE_FAILED");
        if (!isCurrent(generation)) return;

        track.play();
        long expectedMs = Math.max(250L, (samples.length * 1000L) / sampleRate);
        long deadline = System.currentTimeMillis() + expectedMs + 3000L;
        while (isCurrent(generation) && System.currentTimeMillis() < deadline) {
            long playedFrames = Integer.toUnsignedLong(track.getPlaybackHeadPosition());
            if (playedFrames >= samples.length) break;
            Thread.sleep(20L);
        }

        if (activeTrack == track) activeTrack = null;
        try { track.stop(); } catch (Exception ignored) { }
        try { track.release(); } catch (Exception ignored) { }
    }

    private boolean isCurrent(long generation) {
        return !shutdown && playbackGeneration.get() == generation && !Thread.currentThread().isInterrupted();
    }

    private File ensureEspeakDataDir() throws IOException {
        File voiceRoot = new File(context.getFilesDir(), "jarvis-siwis-v1");
        File dataDir = new File(voiceRoot, "espeak-ng-data");
        File marker = new File(voiceRoot, ".ready");
        if (marker.isFile() && dataDir.isDirectory()) return dataDir;

        deleteRecursively(voiceRoot);
        if (!voiceRoot.mkdirs() && !voiceRoot.isDirectory()) {
            throw new IOException("SIWIS_DATA_DIR_CREATE_FAILED");
        }
        copyAssetTree(ESPEAK_ASSET_DIR, dataDir);
        if (!marker.createNewFile() && !marker.isFile()) {
            throw new IOException("SIWIS_DATA_MARKER_FAILED");
        }
        return dataDir;
    }

    private void copyAssetTree(String assetPath, File destination) throws IOException {
        String[] children = assets.list(assetPath);
        if (children != null && children.length > 0) {
            if (!destination.mkdirs() && !destination.isDirectory()) {
                throw new IOException("SIWIS_ASSET_DIR_CREATE_FAILED");
            }
            for (String child : children) {
                copyAssetTree(assetPath + "/" + child, new File(destination, child));
            }
            return;
        }

        File parent = destination.getParentFile();
        if (parent != null && !parent.mkdirs() && !parent.isDirectory()) {
            throw new IOException("SIWIS_ASSET_PARENT_CREATE_FAILED");
        }
        try (InputStream input = assets.open(assetPath); FileOutputStream output = new FileOutputStream(destination)) {
            byte[] buffer = new byte[16 * 1024];
            int read;
            while ((read = input.read(buffer)) != -1) output.write(buffer, 0, read);
        }
    }

    private static void deleteRecursively(File file) {
        if (file == null || !file.exists()) return;
        if (file.isDirectory()) {
            File[] children = file.listFiles();
            if (children != null) for (File child : children) deleteRecursively(child);
        }
        // Best-effort cleanup; a subsequent copy will surface a real I/O error if needed.
        file.delete();
    }
}
