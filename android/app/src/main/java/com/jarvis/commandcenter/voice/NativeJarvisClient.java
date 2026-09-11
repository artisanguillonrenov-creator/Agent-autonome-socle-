package com.jarvis.commandcenter.voice;

import android.content.Context;

import org.json.JSONArray;
import org.json.JSONObject;

import java.io.BufferedReader;
import java.io.IOException;
import java.io.InputStream;
import java.io.InputStreamReader;
import java.io.OutputStream;
import java.net.HttpURLConnection;
import java.net.URI;
import java.net.URL;
import java.net.URLEncoder;
import java.nio.charset.StandardCharsets;

public final class NativeJarvisClient {
    public static final class PendingAction {
        public final String type;
        public final String taskId;
        public final String riskLevel;

        PendingAction(String type, String taskId, String riskLevel) {
            this.type = type;
            this.taskId = taskId;
            this.riskLevel = riskLevel;
        }
    }

    public static final class VoiceResponse {
        public final String voiceCommandId;
        public final String response;
        public final String speechText;
        public final int iterations;
        public final PendingAction pendingAction;

        VoiceResponse(String voiceCommandId, String response, String speechText, int iterations, PendingAction pendingAction) {
            this.voiceCommandId = voiceCommandId;
            this.response = response;
            this.speechText = speechText;
            this.iterations = iterations;
            this.pendingAction = pendingAction;
        }
    }

    private static final int CONNECT_TIMEOUT_MS = 15_000;
    private static final int READ_TIMEOUT_MS = 150_000;
    private final SecureVoiceConfigStore config;

    public NativeJarvisClient(Context context) {
        this.config = new SecureVoiceConfigStore(context);
    }

    public VoiceResponse executeVoiceCommand(String voiceCommandId, String message, String workspaceId) throws Exception {
        JSONObject body = new JSONObject();
        body.put("voiceCommandId", voiceCommandId);
        body.put("message", message);
        if (workspaceId != null && !workspaceId.trim().isEmpty()) body.put("workspaceId", workspaceId.trim());

        IOException firstNetworkError = null;
        for (int attempt = 0; attempt < 2; attempt++) {
            try {
                HttpResult result = request("POST", "/api/voice/command", body);
                if (result.status == 200) return parseVoiceResponse(result.json);
                if (result.status == 202) return pollCommandUntilTerminal(voiceCommandId);
                throw httpError(result);
            } catch (IOException error) {
                if (firstNetworkError == null) firstNetworkError = error;
                try {
                    VoiceResponse recovered = pollCommandUntilTerminal(voiceCommandId);
                    if (recovered != null) return recovered;
                } catch (Exception ignored) {
                    // Retry the exact same voiceCommandId once. The backend ingress store
                    // provides at-most-once semantics even if the original POST succeeded.
                }
            }
        }
        throw firstNetworkError != null ? firstNetworkError : new IOException("VOICE_BACKEND_UNAVAILABLE");
    }

    public JSONObject getVoiceCommand(String voiceCommandId) throws Exception {
        HttpResult result = request("GET", "/api/voice/commands/" + encode(voiceCommandId), null);
        if (result.status != 200) throw httpError(result);
        return result.json;
    }

    public JSONArray getPendingNativeAlerts() throws Exception {
        HttpResult result = request("GET", "/api/voice/alerts", null);
        if (result.status != 200) throw httpError(result);
        return result.json.optJSONArray("items") == null ? new JSONArray() : result.json.getJSONArray("items");
    }

    public void acknowledgeNativeAlert(String notificationId) throws Exception {
        HttpResult result = request("POST", "/api/voice/alerts/" + encode(notificationId) + "/ack", new JSONObject());
        if (result.status != 200) throw httpError(result);
    }

    public JSONObject respondToOperation(String taskId, String action, String value) throws Exception {
        JSONObject body = new JSONObject();
        body.put("action", action);
        if (value != null) body.put("value", value);
        HttpResult result = request("POST", "/api/operations/" + encode(taskId) + "/respond", body);
        if (result.status != 200) throw httpError(result);
        return result.json;
    }

    private VoiceResponse pollCommandUntilTerminal(String voiceCommandId) throws Exception {
        for (int attempt = 0; attempt < 75; attempt++) {
            HttpResult result;
            try {
                result = request("GET", "/api/voice/commands/" + encode(voiceCommandId), null);
            } catch (IOException network) {
                Thread.sleep(Math.min(250L + attempt * 50L, 1500L));
                continue;
            }
            if (result.status == 404) {
                if (attempt < 2) {
                    Thread.sleep(250L);
                    continue;
                }
                throw new IOException("VOICE_COMMAND_NOT_FOUND");
            }
            if (result.status != 200) throw httpError(result);
            String state = result.json.optString("status", "");
            if ("DONE".equals(state) || result.json.has("response")) return parseVoiceResponse(result.json);
            if ("RECOVERY_REQUIRED".equals(state)) throw new IOException("VOICE_COMMAND_RECOVERY_REQUIRED");
            Thread.sleep(1200L);
        }
        throw new IOException("VOICE_COMMAND_POLL_TIMEOUT");
    }

    private VoiceResponse parseVoiceResponse(JSONObject json) {
        JSONObject pending = json.optJSONObject("pendingAction");
        PendingAction pendingAction = pending == null ? null : new PendingAction(
                pending.optString("type", ""),
                pending.optString("taskId", ""),
                pending.optString("riskLevel", "")
        );
        return new VoiceResponse(
                json.optString("voiceCommandId", ""),
                json.optString("response", ""),
                json.optString("speechText", json.optString("response", "")),
                json.optInt("iterations", 0),
                pendingAction
        );
    }

    private HttpResult request(String method, String path, JSONObject body) throws Exception {
        String base = config.getBackendUrl();
        String credential = config.getCredential();
        if (base == null || base.isEmpty()) throw new IOException("BACKEND_NOT_CONFIGURED");
        if (credential == null || credential.isEmpty()) throw new IOException("BACKEND_CREDENTIAL_NOT_CONFIGURED");
        enforceTransportSecurity(base);

        HttpURLConnection connection = (HttpURLConnection) new URL(base + path).openConnection();
        connection.setRequestMethod(method);
        connection.setConnectTimeout(CONNECT_TIMEOUT_MS);
        connection.setReadTimeout(READ_TIMEOUT_MS);
        connection.setRequestProperty("Accept", "application/json");
        connection.setRequestProperty("Authorization", "Bearer " + credential);
        if (body != null) {
            connection.setDoOutput(true);
            connection.setRequestProperty("Content-Type", "application/json; charset=utf-8");
            byte[] bytes = body.toString().getBytes(StandardCharsets.UTF_8);
            connection.setFixedLengthStreamingMode(bytes.length);
            try (OutputStream output = connection.getOutputStream()) {
                output.write(bytes);
            }
        }

        int status = connection.getResponseCode();
        InputStream stream = status >= 200 && status < 400 ? connection.getInputStream() : connection.getErrorStream();
        String text = read(stream);
        connection.disconnect();
        JSONObject json;
        try {
            json = text == null || text.trim().isEmpty() ? new JSONObject() : new JSONObject(text);
        } catch (Exception invalidJson) {
            throw new IOException("BACKEND_RESPONSE_INVALID_JSON");
        }
        return new HttpResult(status, json);
    }

    private static void enforceTransportSecurity(String base) throws Exception {
        URI uri = URI.create(base);
        String scheme = uri.getScheme();
        String host = uri.getHost();
        boolean loopback = "localhost".equalsIgnoreCase(host) || "127.0.0.1".equals(host) || "::1".equals(host);
        if (!"https".equalsIgnoreCase(scheme) && !("http".equalsIgnoreCase(scheme) && loopback)) {
            throw new IOException("INSECURE_REMOTE_BACKEND_URL");
        }
    }

    private static String read(InputStream stream) throws IOException {
        if (stream == null) return "";
        StringBuilder builder = new StringBuilder();
        try (BufferedReader reader = new BufferedReader(new InputStreamReader(stream, StandardCharsets.UTF_8))) {
            String line;
            while ((line = reader.readLine()) != null) builder.append(line);
        }
        return builder.toString();
    }

    private static String encode(String value) {
        return URLEncoder.encode(value, StandardCharsets.UTF_8).replace("+", "%20");
    }

    private static IOException httpError(HttpResult result) {
        String code = result.json.optString("error", "HTTP_" + result.status);
        return new IOException(code);
    }

    private static final class HttpResult {
        final int status;
        final JSONObject json;

        HttpResult(int status, JSONObject json) {
            this.status = status;
            this.json = json;
        }
    }
}
