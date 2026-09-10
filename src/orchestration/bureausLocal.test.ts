import test from "node:test";
import assert from "node:assert/strict";
import { closeDb, getDb } from "../persistence/db.js";
import { config } from "../config.js";
import { ServiceRegistry } from "./serviceRegistry.js";
import { ServiceOrchestrator } from "./serviceOrchestrator.js";

function setupTestDb() {
  config.db.path = ":memory:";
  closeDb();
  getDb();
}

function withStubbedFetch<T>(run: () => Promise<T>): Promise<T> & { calls: () => string[] } {
  const calls: string[] = [];
  const original = globalThis.fetch;
  globalThis.fetch = (async (input: any) => {
    calls.push(typeof input === "string" ? input : input?.url ?? String(input));
    throw new Error(`UNEXPECTED_NETWORK_CALL: ${calls[calls.length - 1]}`);
  }) as typeof fetch;
  const promise = run().finally(() => {
    globalThis.fetch = original;
  }) as Promise<T> & { calls: () => string[] };
  promise.calls = () => calls;
  return promise;
}

function enableAllBureaus(orchestrator: ServiceOrchestrator): void {
  for (const id of ["product_studio", "creative_studio", "commercial_office", "marketing_office"]) {
    orchestrator.registry.patchService(id, { enabled: true });
  }
}

test("SCÉNARIO J — les quatre bureaux sont enregistrés localement/in-process, désactivés par défaut", () => {
  setupTestDb();
  const registry = new ServiceRegistry();
  for (const id of ["product_studio", "creative_studio", "commercial_office", "marketing_office"]) {
    const s = registry.getServiceById(id);
    assert.ok(s, `${id} doit être enregistré`);
    assert.equal(s!.transport, "local");
    assert.equal(s!.enabled, false, `${id} doit être désactivé par défaut (settings.* = false)`);
  }
  const commercial = registry.getServiceById("commercial_office")!;
  assert.deepEqual(commercial.capabilities.sort(), ["commercial_office", "commercial_office_send"]);
  assert.equal(commercial.permissionByCapability?.commercial_office_send, "SEND");
});

test("SCÉNARIO J — dispatch local vers les quatre bureaux, zéro appel HTTP", async () => {
  setupTestDb();
  const orchestrator = new ServiceOrchestrator();
  enableAllBureaus(orchestrator);

  const run = withStubbedFetch(async () => {
    const product = await orchestrator.dispatchCapability({ action: "DISPATCH_CAPABILITY", capability: "product_studio", objective: "Décision", context: { action: "RECORD_DECISION", decision: "Prioriser l'onboarding" } });
    const creative = await orchestrator.dispatchCapability({ action: "DISPATCH_CAPABILITY", capability: "creative_studio", objective: "Décision", context: { action: "RECORD_DECISION", decision: "Palette validée", status: "ACCEPTED" } });
    const marketing = await orchestrator.dispatchCapability({ action: "DISPATCH_CAPABILITY", capability: "marketing_office", objective: "Campagne", context: { action: "PLAN_CAMPAIGN", name: "Lancement", channel: "Discord", goal: "500 inscrits" } });
    const commercial = await orchestrator.dispatchCapability({ action: "DISPATCH_CAPABILITY", capability: "commercial_office", objective: "Prospect", context: { action: "CREATE_PROSPECT", name: "Alice" } });
    return { product, creative, marketing, commercial };
  });
  const results = await run;

  for (const [name, result] of Object.entries(results)) {
    assert.equal(result.status, "COMPLETED", `${name}: ${result.error}`);
  }
  assert.deepEqual(run.calls(), []);
});

test("SCÉNARIO D — orchestration multi-bureaux : Jarvis enchaîne product_studio -> creative_studio -> marketing_office -> commercial_office et consolide", async () => {
  setupTestDb();
  const orchestrator = new ServiceOrchestrator();
  enableAllBureaus(orchestrator);

  const productResult = await orchestrator.dispatchCapability({
    action: "DISPATCH_CAPABILITY",
    capability: "product_studio",
    objective: "Analyse produit",
    context: { action: "RECORD_DECISION", decision: "Le produit cible les joueurs RP mobiles" },
  });
  assert.equal(productResult.status, "COMPLETED");

  const creativeResult = await orchestrator.dispatchCapability({
    action: "DISPATCH_CAPABILITY",
    capability: "creative_studio",
    objective: "Identité visuelle",
    context: { action: "RECORD_DECISION", decision: "Direction dark fantasy retenue", status: "ACCEPTED" },
  });
  assert.equal(creativeResult.status, "COMPLETED");

  const marketingResult = await orchestrator.dispatchCapability({
    action: "DISPATCH_CAPABILITY",
    capability: "marketing_office",
    objective: "Stratégie de lancement",
    context: { action: "PLAN_CAMPAIGN", name: "Bêta fermée", channel: "Discord", goal: "Recruter des testeurs" },
  });
  assert.equal(marketingResult.status, "COMPLETED");

  const commercialResult = await orchestrator.dispatchCapability({
    action: "DISPATCH_CAPABILITY",
    capability: "commercial_office",
    objective: "Prospection de lancement",
    context: { action: "CREATE_PROSPECT", name: "Studio partenaire" },
  });
  assert.equal(commercialResult.status, "COMPLETED");

  // Chaque bureau produit un résultat structuré et machine-exploitable (bureau/projet/mission/statut/...).
  for (const result of [productResult, creativeResult, marketingResult, commercialResult]) {
    const payload = JSON.parse(result.result!);
    assert.ok(payload.office);
    assert.ok(payload.taskId);
    assert.equal(payload.status, "COMPLETED");
  }
});

test("SCÉNARIO H — commercial_office_send exige la permission SEND : bloqué par défaut (autonomy.permissionMatrix=EXECUTE)", async () => {
  setupTestDb();
  const originalPermissionMatrix = config.autonomy.permissionMatrix;
  try {
    config.autonomy.permissionMatrix = "EXECUTE";
    const orchestrator = new ServiceOrchestrator();
    enableAllBureaus(orchestrator);
    const prospect = await orchestrator.dispatchCapability({ action: "DISPATCH_CAPABILITY", capability: "commercial_office", objective: "Prospect", context: { action: "CREATE_PROSPECT", name: "Bob", email: "bob@example.com" } });
    const contactId = JSON.parse(prospect.result!).result.contact.id;

    const sendAttempt = await orchestrator.dispatchCapability({
      action: "DISPATCH_CAPABILITY",
      capability: "commercial_office_send",
      objective: "Envoie un e-mail",
      context: { action: "SEND_MESSAGE", contactId, subject: "Bonjour", text: "Test" },
    });
    assert.equal(sendAttempt.status, "REJECTED");
    assert.match(sendAttempt.error ?? "", /PERMISSION_DENIED/);
  } finally {
    config.autonomy.permissionMatrix = originalPermissionMatrix;
  }
});

test("SCÉNARIO H — avec la permission SEND accordée, la capacité atteint réellement le service (et échoue proprement faute de provider e-mail configuré)", async () => {
  setupTestDb();
  const originalPermissionMatrix = config.autonomy.permissionMatrix;
  try {
    config.autonomy.permissionMatrix = "SEND";
    const orchestrator = new ServiceOrchestrator();
    enableAllBureaus(orchestrator);
    const prospect = await orchestrator.dispatchCapability({ action: "DISPATCH_CAPABILITY", capability: "commercial_office", objective: "Prospect", context: { action: "CREATE_PROSPECT", name: "Bob", email: "bob@example.com" } });
    const contactId = JSON.parse(prospect.result!).result.contact.id;

    const sendAttempt = await orchestrator.dispatchCapability({
      action: "DISPATCH_CAPABILITY",
      capability: "commercial_office_send",
      objective: "Envoie un e-mail",
      context: { action: "SEND_MESSAGE", contactId, subject: "Bonjour", text: "Test" },
    });
    // La permission n'est plus le blocage : l'échec vient maintenant de l'absence de
    // fournisseur e-mail réel configuré (EMAIL_WEBHOOK_URL), jamais d'un faux succès.
    assert.equal(sendAttempt.status, "FAILED");
    assert.doesNotMatch(sendAttempt.error ?? "", /PERMISSION_DENIED/);
    assert.match(sendAttempt.error ?? "", /EMAIL_PROVIDER_NOT_CONFIGURED/);
  } finally {
    config.autonomy.permissionMatrix = originalPermissionMatrix;
  }
});

test("un bureau désactivé (skills.*/office* = false côté registre) reste inatteignable via dispatchCapability", async () => {
  setupTestDb();
  const orchestrator = new ServiceOrchestrator();
  // Ne pas activer product_studio : reste enabled=false par défaut (config/services.json).
  const result = await orchestrator.dispatchCapability({ action: "DISPATCH_CAPABILITY", capability: "product_studio", objective: "Analyse", context: { action: "GET_STATE" } });
  assert.equal(result.status, "REJECTED");
  assert.equal(result.selectedService, "none");
});
