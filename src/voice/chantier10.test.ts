import { test } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import type { LLMProvider, CompletionOptions, LLMCompletionResult } from "../llm/provider.js";
import type { ChatMessage } from "../types.js";
import { LocalHashingEmbeddingProvider } from "../llm/embeddings.js";
import { Agent } from "../core/agent.js";
import { QueuedAgent } from "../core/queuedAgent.js";
import { startHttpApi } from "../interfaces/httpApi.js";
import { VoiceIngressStore, hashVoiceRequest } from "./voiceIngressStore.js";
import { installVoiceHttpIngress } from "./httpVoiceIngress.js";
import { VoiceOutputFormatter } from "./voiceOutputFormatter.js";
import { AlertRouter } from "./alertRouter.js";
import type { SmsProvider, SmsSendResult } from "./smsProvider.js";
import { NotificationStore } from "../autonomy/notificationStore.js";
import { config } from "../config.js";
import { completeWithLocalPriority, clearLocalModelProbeCacheForTests } from "../llm/localModelPriority.js";
import { OllamaProvider } from "../llm/providers/ollama.js";
import { registerChantier10Settings } from "../settings/chantier10Catalog.js";
import { SettingsStore } from "../settings/store.js";

class TextProvider implements LLMProvider {
  readonly name = "mock";
  readonly model = "test-model";
  calls = 0;
  constructor(private readonly text = "réponse") {}
  async complete(_messages: ChatMessage[], _options: CompletionOptions = {}): Promise<LLMCompletionResult> {
    this.calls += 1;
    return { content: this.text };
  }
}

async function listeningServer(agent: Agent) {
  const server = startHttpApi(agent, 0);
  if (!server.listening) await new Promise<void>((resolve, reject) => {
    server.once("listening", resolve);
    server.once("error", reject);
  });
  const address = server.address();
  assert.ok(address && typeof address !== "string");
  return { server, baseUrl: `http://127.0.0.1:${address.port}` };
}

function auth(token: string): Record<string, string> {
  return { authorization: `Bearer ${token}`, "content-type": "application/json" };
}

test("QueuedAgent serializes concurrent interactive steps around the single Agent memory", async () => {
  const previousLocalPriority = config.llm.localModelPriority;
  config.llm.localModelPriority = false;
  let active = 0;
  let peak = 0;
  const provider: LLMProvider = {
    name: "mock",
    model: "slow",
    async complete(messages) {
      active += 1;
      peak = Math.max(peak, active);
      await new Promise((resolve) => setTimeout(resolve, 30));
      active -= 1;
      const user = [...messages].reverse().find((m) => m.role === "user")?.content || "";
      return { content: `ok:${user}` };
    },
  };
  try {
    const agent = new QueuedAgent({ llm: provider, embeddings: new LocalHashingEmbeddingProvider(), maxIterations: 1 });
    const [a, b] = await Promise.all([agent.step("A"), agent.step("B")]);
    assert.equal(peak, 1);
    assert.match(a.response, /A/);
    assert.match(b.response, /B/);
    assert.equal(agent.ingressQueue.activeCount, 0);
  } finally {
    config.llm.localModelPriority = previousLocalPriority;
  }
});

test("VoiceIngressStore hashes workspace and never purges unsafe states", () => {
  const store = new VoiceIngressStore();
  const doneId = randomUUID();
  const runningId = randomUUID();
  const recoveryId = randomUUID();
  const hash = hashVoiceRequest("  même commande  ", " ws-a ");
  assert.equal(hash, hashVoiceRequest("même commande", "ws-a"));
  assert.notEqual(hash, hashVoiceRequest("même commande", "ws-b"));

  assert.equal(store.begin(doneId, hash, "ws-a").kind, "NEW");
  store.complete(doneId, { response: "ok" });
  assert.equal(store.begin(runningId, hash, "ws-a").kind, "NEW");
  assert.equal(store.begin(recoveryId, hash, "ws-a").kind, "NEW");
  store.markRecoveryRequired(recoveryId, "crash");

  const deleted = store.cleanupDone(1, Date.now() + 10_000);
  assert.ok(deleted >= 1);
  assert.equal(store.get(doneId), null);
  assert.equal(store.get(runningId)?.state, "RUNNING");
  assert.equal(store.get(recoveryId)?.state, "RECOVERY_REQUIRED");
});

test("Voice ingress is idempotent: DONE replay, RUNNING 202, payload mismatch 409 and recovery block", async () => {
  const previousToken = config.api.token;
  const previousMode = config.voice.responseMode;
  config.api.token = `voice-${randomUUID()}`;
  config.voice.responseMode = "FULL";
  const provider = new TextProvider("backend nominal");
  const agent = new Agent({ llm: provider, embeddings: new LocalHashingEmbeddingProvider() });
  let stepCalls = 0;
  (agent as any).step = async (message: string) => {
    stepCalls += 1;
    return { response: `traité:${message}`, iterations: 1 };
  };
  const store = new VoiceIngressStore();
  const { server, baseUrl } = await listeningServer(agent);
  const runtime = installVoiceHttpIngress(server, agent, store, new AlertRouter());
  const commandId = randomUUID();

  try {
    const send = (id: string, message: string, workspaceId = "ws") => fetch(`${baseUrl}/api/voice/command`, {
      method: "POST",
      headers: auth(config.api.token),
      body: JSON.stringify({ voiceCommandId: id, message, workspaceId }),
    });

    const first = await send(commandId, "bonjour");
    assert.equal(first.status, 200);
    const firstBody = await first.json() as any;
    assert.equal(firstBody.response, "traité:bonjour");
    assert.equal(firstBody.speechText, "traité:bonjour");
    assert.equal(stepCalls, 1);

    const replay = await send(commandId, "bonjour");
    assert.equal(replay.status, 200);
    assert.equal(stepCalls, 1, "DONE must never re-enter Agent.step");

    const mismatch = await send(commandId, "autre texte");
    assert.equal(mismatch.status, 409);
    assert.equal((await mismatch.json() as any).error, "VOICE_COMMAND_ID_REUSE_MISMATCH");
    assert.equal(stepCalls, 1);

    const runningId = randomUUID();
    store.begin(runningId, hashVoiceRequest("en cours", "ws"), "ws");
    const running = await send(runningId, "en cours");
    assert.equal(running.status, 202);
    assert.equal((await running.json() as any).status, "PROCESSING");

    const recoveryId = randomUUID();
    store.begin(recoveryId, hashVoiceRequest("dangereux", "ws"), "ws");
    store.markRecoveryRequired(recoveryId, "backend crashed");
    const recovery = await send(recoveryId, "dangereux");
    assert.equal(recovery.status, 409);
    assert.equal((await recovery.json() as any).error, "VOICE_COMMAND_RECOVERY_REQUIRED");
    assert.equal(stepCalls, 1);
  } finally {
    runtime.dispose();
    await new Promise<void>((resolve) => server.close(() => resolve()));
    config.api.token = previousToken;
    config.voice.responseMode = previousMode;
  }
});

test("orphan RUNNING voice ingress becomes RECOVERY_REQUIRED before any replay", () => {
  const store = new VoiceIngressStore();
  const id = randomUUID();
  store.begin(id, hashVoiceRequest("mutation possible"));
  const changed = store.markRunningAsRecoveryRequired();
  assert.ok(changed >= 1);
  assert.equal(store.get(id)?.state, "RECOVERY_REQUIRED");
});

test("VoiceOutputFormatter preserves full result and safely falls back", async () => {
  const previousLocalPriority = config.llm.localModelPriority;
  config.llm.localModelPriority = false;
  try {
    const summaryProvider = new TextProvider("Résumé vocal fidèle.");
    const formatter = new VoiceOutputFormatter(() => summaryProvider);
    assert.equal(await formatter.format("texte complet", "FULL"), "texte complet");
    assert.equal(await formatter.format("Un texte technique long à résumer.", "SUMMARY"), "Résumé vocal fidèle.");

    const failing: LLMProvider = { name: "mock", async complete() { throw new Error("down"); } };
    const fallback = new VoiceOutputFormatter(() => failing);
    assert.equal(await fallback.format("Mission réussie, réponse intégrale.", "SUMMARY"), "Mission réussie, réponse intégrale.");
  } finally {
    config.llm.localModelPriority = previousLocalPriority;
  }
});

test("AlertRouter keeps email separate, deduplicates native/SMS and never exposes full lockscreen message", async () => {
  const previous = { android: config.activity.androidPush, sms: config.activity.smsAlerts, voice: config.activity.voiceAlerts, to: config.sms.alertTo };
  config.activity.androidPush = true;
  config.activity.smsAlerts = true;
  config.activity.voiceAlerts = true;
  config.sms.alertTo = "+33000000000";
  let smsCalls = 0;
  const smsProvider: SmsProvider = {
    async send(): Promise<SmsSendResult> { smsCalls += 1; return { ok: true }; },
  };
  const router = new AlertRouter(smsProvider);
  try {
    const notification = new NotificationStore().create({
      type: "APPROVAL_REQUIRED",
      severity: "warning",
      title: `Validation ${randomUUID()}`,
      message: "SECRET_DETAIL_SHOULD_NOT_BE_ON_LOCKSCREEN",
      operationTaskId: `op-${randomUUID()}`,
    });
    await router.handle(notification);
    await router.handle(notification);
    assert.equal(smsCalls, 1);
    const native = router.pendingNative(100).find((item) => item.notificationId === notification.id);
    assert.ok(native);
    assert.equal(native.android, true);
    assert.equal(native.voice, true);
    assert.doesNotMatch(native.lockscreenMessage, /SECRET_DETAIL/);
    assert.equal(router.acknowledgeNative(notification.id), true);
  } finally {
    config.activity.androidPush = previous.android;
    config.activity.smsAlerts = previous.sms;
    config.activity.voiceAlerts = previous.voice;
    config.sms.alertTo = previous.to;
  }
});

test("localModelPriority without configured candidate immediately uses nominal provider", async () => {
  const previous = { enabled: config.llm.localModelPriority, model: config.llm.localModel };
  config.llm.localModelPriority = true;
  config.llm.localModel = "";
  const nominal = new TextProvider("nominal");
  try {
    const result = await completeWithLocalPriority(nominal, [{ role: "user", content: "test" }], { maxTokens: 20 });
    assert.equal(result.content, "nominal");
    assert.equal(nominal.calls, 1);
  } finally {
    config.llm.localModelPriority = previous.enabled;
    config.llm.localModel = previous.model;
    clearLocalModelProbeCacheForTests();
  }
});

test("Ollama provider transports Jarvis tool definitions and parses native tool_calls", async () => {
  const previousFetch = globalThis.fetch;
  let requestBody: any;
  globalThis.fetch = (async (_input: string | URL | Request, init?: RequestInit) => {
    requestBody = JSON.parse(String(init?.body || "{}"));
    return new Response(JSON.stringify({
      message: {
        content: "",
        tool_calls: [{ function: { name: "demo_tool", arguments: { value: "OK" } } }],
      },
    }), { status: 200, headers: { "content-type": "application/json" } });
  }) as typeof fetch;
  try {
    const provider = new OllamaProvider({ baseUrl: "http://localhost:11434", model: "tool-model" });
    const result = await provider.complete([{ role: "user", content: "appel outil" }], {
      tools: [{ type: "function", function: { name: "demo_tool", description: "demo", parameters: { type: "object", properties: { value: { type: "string" } } } } }],
    });
    assert.equal(provider.supportsNativeTools(), true);
    assert.equal(requestBody.tools[0].function.name, "demo_tool");
    assert.equal(result.toolCalls?.[0].function.name, "demo_tool");
    assert.equal(JSON.parse(result.toolCalls?.[0].function.arguments || "{}").value, "OK");
  } finally {
    globalThis.fetch = previousFetch;
  }
});

test("pendingAction uses the exact taskId from the tool result, not a global latest operation", () => {
  const agent = new Agent({ llm: new TextProvider(), embeddings: new LocalHashingEmbeddingProvider() });
  const exactTask = `pending-${randomUUID()}`;
  agent.serviceOrchestrator.store.createOperation({
    taskId: exactTask,
    traceId: `trace-${randomUUID()}`,
    idempotencyKey: `idem-${randomUUID()}`,
    objective: "approval",
    capability: "test",
    selectedService: "none",
    status: "WAITING_PERMISSION",
    riskLevel: "HIGH",
    approvalState: "PENDING",
  });
  const pending = (agent as any).pendingActionFromToolResult(JSON.stringify({ status: "WAITING_PERMISSION", taskId: exactTask }));
  assert.deepEqual(pending, { type: "PERMISSION", taskId: exactTask, riskLevel: "HIGH" });
  assert.equal((agent as any).pendingActionFromToolResult(JSON.stringify({ status: "WAITING_PERMISSION", taskId: "not-real" })), undefined);
});

test("Chantier 10 settings are AVAILABLE only after their real runtime registration", () => {
  registerChantier10Settings();
  const store = new SettingsStore();
  for (const key of [
    "settings.automaticVoiceReading",
    "settings.voiceMode",
    "settings.voiceResponseMode",
    "intelligence.localModelPriority",
    "activity.androidPush",
    "activity.smsAlerts",
    "activity.voiceAlerts",
  ]) {
    assert.equal(store.getDefinition(key)?.availability, "AVAILABLE", key);
    assert.equal(store.getDefinition(key)?.editable, true, key);
  }
});
