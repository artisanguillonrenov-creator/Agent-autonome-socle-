import test from "node:test";
import assert from "node:assert/strict";
import { closeDb, getDb } from "../persistence/db.js";
import { config } from "../config.js";
import { NotificationStore } from "./notificationStore.js";
import type { EmailMessage, EmailProvider, EmailSendResult } from "../email/emailProvider.js";
import { ServiceOrchestrator } from "../orchestration/serviceOrchestrator.js";

function setupTestDb() {
  config.db.path = ":memory:";
  closeDb();
  getDb();
}

class StubEmailProvider implements EmailProvider {
  public sent: EmailMessage[] = [];
  async send(message: EmailMessage): Promise<EmailSendResult> {
    this.sent.push(message);
    return { ok: true, id: "stub" };
  }
}

test("activity.emailAlerts désactivé : une notification importante ne déclenche aucun envoi e-mail", async () => {
  setupTestDb();
  config.activity.emailAlerts = false;
  config.email.alertTo = "user@example.com";
  const provider = new StubEmailProvider();
  const store = new NotificationStore(provider);
  store.create({ type: "BACKGROUND_FAILED", severity: "error", title: "Échec", message: "Une opération a échoué" });
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(provider.sent.length, 0);
});

test("activity.emailAlerts activé sans destinataire configuré : jamais un envoi simulé", async () => {
  setupTestDb();
  config.activity.emailAlerts = true;
  config.email.alertTo = "";
  const provider = new StubEmailProvider();
  const store = new NotificationStore(provider);
  store.create({ type: "BACKGROUND_FAILED", severity: "error", title: "Échec", message: "Une opération a échoué" });
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(provider.sent.length, 0);
  config.activity.emailAlerts = false;
});

test("SCÉNARIO I — activity.emailAlerts activé + destinataire configuré : une notification importante envoie une alerte contextualisée, jamais dupliquée", async () => {
  setupTestDb();
  config.activity.emailAlerts = true;
  config.email.alertTo = "ops@example.com";
  try {
    const provider = new StubEmailProvider();
    const store = new NotificationStore(provider);
    store.create({ type: "RECOVERY_REQUIRED", severity: "error", title: "Reprise requise", message: "État externe inconnu pour op-1" }, "recovery:op-1");
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(provider.sent.length, 1);
    assert.equal(provider.sent[0].to, "ops@example.com");
    assert.match(provider.sent[0].subject, /Reprise requise/);
    assert.match(provider.sent[0].text, /op-1/);

    // Une seconde émission avec la MÊME dedupeKey (retry/redémarrage) ne renvoie pas d'e-mail.
    store.create({ type: "RECOVERY_REQUIRED", severity: "error", title: "Reprise requise", message: "État externe inconnu pour op-1" }, "recovery:op-1");
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(provider.sent.length, 1);
  } finally {
    config.activity.emailAlerts = false;
    config.email.alertTo = "";
  }
});

test("une notification de type non prioritaire (ex. REMINDER_DUE) n'envoie jamais d'alerte e-mail", async () => {
  setupTestDb();
  config.activity.emailAlerts = true;
  config.email.alertTo = "ops@example.com";
  try {
    const provider = new StubEmailProvider();
    const store = new NotificationStore(provider);
    store.create({ type: "REMINDER_DUE", severity: "info", title: "Rappel", message: "Un rappel arrive à échéance" });
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(provider.sent.length, 0);
  } finally {
    config.activity.emailAlerts = false;
    config.email.alertTo = "";
  }
});

test("SCÉNARIO I — une approbation requise (risque au-delà du plafond) crée une notification APPROVAL_REQUIRED", async () => {
  setupTestDb();
  const originalRisk = config.autonomy.globalRiskLevel;
  try {
    config.autonomy.globalRiskLevel = "LOW";
    const orchestrator = new ServiceOrchestrator();
    orchestrator.registry.patchService("commercial_office", { enabled: true });
    const result = await orchestrator.dispatchCapability({
      action: "DISPATCH_CAPABILITY",
      capability: "commercial_office",
      objective: "Créer un prospect",
      context: { action: "CREATE_PROSPECT", name: "Test" },
    });
    assert.equal(result.status, "WAITING_PERMISSION");

    const notifications = new NotificationStore().list();
    assert.ok(notifications.some((n) => n.type === "APPROVAL_REQUIRED" && n.operationTaskId === result.taskId));
  } finally {
    config.autonomy.globalRiskLevel = originalRisk;
  }
});
