package com.jarvis.commandcenter.voice;

import android.content.Context;
import android.content.SharedPreferences;
import android.security.keystore.KeyGenParameterSpec;
import android.security.keystore.KeyProperties;
import android.util.Base64;

import java.nio.charset.StandardCharsets;
import java.security.KeyStore;

import javax.crypto.Cipher;
import javax.crypto.KeyGenerator;
import javax.crypto.SecretKey;
import javax.crypto.spec.GCMParameterSpec;

public final class SecureVoiceConfigStore {
    private static final String PREFS = "jarvis_voice_secure";
    private static final String KEY_ALIAS = "jarvis_voice_backend_credential";
    private static final String KEY_BACKEND = "backend_url";
    private static final String KEY_TOKEN = "credential";
    private static final String KEY_MODE = "voice_mode";
    private static final String KEY_RESPONSE_MODE = "voice_response_mode";
    private static final String KEY_CONVERSATION_ID_PREFIX = "active_conversation_id.";

    private final SharedPreferences prefs;

    public SecureVoiceConfigStore(Context context) {
        prefs = context.getSharedPreferences(PREFS, Context.MODE_PRIVATE);
    }

    public void setBackendUrl(String url) {
        String value = url == null ? "" : url.trim().replaceAll("/+$", "");
        prefs.edit().putString(KEY_BACKEND, value).apply();
    }

    public String getBackendUrl() {
        return prefs.getString(KEY_BACKEND, "");
    }

    public void setCredential(String token) throws Exception {
        if (token == null || token.isEmpty()) {
            prefs.edit().remove(KEY_TOKEN).apply();
            return;
        }
        Cipher cipher = Cipher.getInstance("AES/GCM/NoPadding");
        cipher.init(Cipher.ENCRYPT_MODE, getOrCreateKey());
        byte[] ciphertext = cipher.doFinal(token.getBytes(StandardCharsets.UTF_8));
        String encoded = Base64.encodeToString(cipher.getIV(), Base64.NO_WRAP)
                + ":" + Base64.encodeToString(ciphertext, Base64.NO_WRAP);
        prefs.edit().putString(KEY_TOKEN, encoded).apply();
    }

    public String getCredential() {
        String encoded = prefs.getString(KEY_TOKEN, "");
        if (encoded == null || encoded.isEmpty()) return "";
        try {
            String[] parts = encoded.split(":", 2);
            if (parts.length != 2) return "";
            byte[] iv = Base64.decode(parts[0], Base64.NO_WRAP);
            byte[] ciphertext = Base64.decode(parts[1], Base64.NO_WRAP);
            Cipher cipher = Cipher.getInstance("AES/GCM/NoPadding");
            cipher.init(Cipher.DECRYPT_MODE, getOrCreateKey(), new GCMParameterSpec(128, iv));
            return new String(cipher.doFinal(ciphertext), StandardCharsets.UTF_8);
        } catch (Exception error) {
            prefs.edit().remove(KEY_TOKEN).apply();
            return "";
        }
    }

    public void setVoiceMode(String mode) {
        prefs.edit().putString(KEY_MODE, mode == null ? "OFF" : mode).apply();
    }

    public String getVoiceMode() {
        return prefs.getString(KEY_MODE, "OFF");
    }

    public void setVoiceResponseMode(String mode) {
        prefs.edit().putString(KEY_RESPONSE_MODE, mode == null ? "AUTO" : mode).apply();
    }

    public String getVoiceResponseMode() {
        return prefs.getString(KEY_RESPONSE_MODE, "AUTO");
    }

    private static String conversationKey(String workspaceId) {
        String scope = workspaceId == null || workspaceId.trim().isEmpty()
                ? "__global__"
                : workspaceId.trim();
        String encodedScope = Base64.encodeToString(
                scope.getBytes(StandardCharsets.UTF_8),
                Base64.URL_SAFE | Base64.NO_WRAP | Base64.NO_PADDING
        );
        return KEY_CONVERSATION_ID_PREFIX + encodedScope;
    }

    public void setActiveConversationId(String workspaceId, String conversationId) {
        String key = conversationKey(workspaceId);
        if (conversationId == null || conversationId.trim().isEmpty()) {
            prefs.edit().remove(key).apply();
        } else {
            prefs.edit().putString(key, conversationId.trim()).apply();
        }
    }

    public String getActiveConversationId(String workspaceId) {
        return prefs.getString(conversationKey(workspaceId), "");
    }

    /** Legacy global-scope compatibility. */
    public void setActiveConversationId(String conversationId) {
        setActiveConversationId(null, conversationId);
    }

    /** Legacy global-scope compatibility. */
    public String getActiveConversationId() {
        return getActiveConversationId(null);
    }

    private SecretKey getOrCreateKey() throws Exception {
        KeyStore keyStore = KeyStore.getInstance("AndroidKeyStore");
        keyStore.load(null);
        if (keyStore.containsAlias(KEY_ALIAS)) {
            return ((KeyStore.SecretKeyEntry) keyStore.getEntry(KEY_ALIAS, null)).getSecretKey();
        }
        KeyGenerator keyGenerator = KeyGenerator.getInstance(KeyProperties.KEY_ALGORITHM_AES, "AndroidKeyStore");
        keyGenerator.init(new KeyGenParameterSpec.Builder(
                KEY_ALIAS,
                KeyProperties.PURPOSE_ENCRYPT | KeyProperties.PURPOSE_DECRYPT)
                .setBlockModes(KeyProperties.BLOCK_MODE_GCM)
                .setEncryptionPaddings(KeyProperties.ENCRYPTION_PADDING_NONE)
                .setRandomizedEncryptionRequired(true)
                .build());
        return keyGenerator.generateKey();
    }
}
