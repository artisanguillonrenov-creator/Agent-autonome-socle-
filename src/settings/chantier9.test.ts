import test from "node:test";
import assert from "node:assert/strict";
import { closeDb, getDb } from "../persistence/db.js";
import { config } from "../config.js";
import { SETTINGS_CATALOG } from "./catalog.js";
import { SettingsStore } from "./store.js";

function setupTestDb() {
  config.db.path = ":memory:";
  closeDb();
  getDb();
}

const CHANTIER_9_KEYS = [
  "skills.studioProduct",
  "skills.studioCreative",
  "skills.officeCommercial",
  "skills.officeMarketing",
  "automations.emailTriggers",
  "automations.crmTriggers",
  "automations.externalEventTriggers",
  "activity.emailAlerts",
];

test("CHANTIER 9: les 8 réglages sont AVAILABLE et éditables (jamais cosmétiques)", () => {
  for (const key of CHANTIER_9_KEYS) {
    const def = SETTINGS_CATALOG.find((s) => s.key === key);
    assert.ok(def, `${key} doit exister au catalogue`);
    assert.equal(def!.availability, "AVAILABLE", `${key} doit être AVAILABLE`);
    assert.equal(def!.editable, true, `${key} doit être éditable`);
    assert.equal(def!.defaultValue, false, `${key} doit être désactivé par défaut`);
    assert.equal(def!.unavailableReason, undefined, `${key} ne doit plus porter de unavailableReason`);
  }
});

test("CHANTIER 9: activer/désactiver un bureau via settings active/désactive réellement le service correspondant", async () => {
  setupTestDb();
  const { applyAllEffectiveRuntimeSettings } = await import("./applier.js");
  const { Agent } = await import("../core/agent.js");
  const { MockProvider } = await import("../llm/providers/mock.js");
  const { LocalHashingEmbeddingProvider } = await import("../llm/embeddings.js");

  const store = new SettingsStore();
  const agent = new Agent({ llm: new MockProvider(), embeddings: new LocalHashingEmbeddingProvider() });

  // Par défaut, les 4 bureaux sont désactivés : ni capacité dispatchable, ni skill AVAILABLE.
  applyAllEffectiveRuntimeSettings(agent, store);
  assert.equal(agent.serviceOrchestrator.registry.findServiceForCapability("product_studio"), null);
  assert.equal(agent.skills.get("product_studio")!.availability, "UNAVAILABLE");

  store.setSetting("skills.studioProduct", true, "GLOBAL", "global");
  applyAllEffectiveRuntimeSettings(agent, store);
  assert.ok(agent.serviceOrchestrator.registry.findServiceForCapability("product_studio"));
  assert.equal(agent.skills.get("product_studio")!.availability, "AVAILABLE");
  assert.equal(config.skills.studioProduct, true);

  store.setSetting("skills.studioProduct", false, "GLOBAL", "global");
  applyAllEffectiveRuntimeSettings(agent, store);
  assert.equal(agent.serviceOrchestrator.registry.findServiceForCapability("product_studio"), null);
  assert.equal(agent.skills.get("product_studio")!.availability, "UNAVAILABLE");
});

test("CHANTIER 9: activation persiste après redémarrage/recréation du runtime", async () => {
  setupTestDb();
  const { applyAllEffectiveRuntimeSettings } = await import("./applier.js");
  const { Agent } = await import("../core/agent.js");
  const { MockProvider } = await import("../llm/providers/mock.js");
  const { LocalHashingEmbeddingProvider } = await import("../llm/embeddings.js");

  const store = new SettingsStore();
  store.setSetting("skills.studioCreative", true, "GLOBAL", "global");
  store.setSetting("skills.officeCommercial", true, "GLOBAL", "global");
  store.setSetting("skills.officeMarketing", true, "GLOBAL", "global");
  store.setSetting("automations.emailTriggers", true, "GLOBAL", "global");
  store.setSetting("automations.crmTriggers", true, "GLOBAL", "global");
  store.setSetting("automations.externalEventTriggers", true, "GLOBAL", "global");
  store.setSetting("activity.emailAlerts", true, "GLOBAL", "global");

  const freshStore = new SettingsStore();
  const agent = new Agent({ llm: new MockProvider(), embeddings: new LocalHashingEmbeddingProvider() });
  applyAllEffectiveRuntimeSettings(agent, freshStore);

  assert.ok(agent.serviceOrchestrator.registry.findServiceForCapability("creative_studio"));
  assert.ok(agent.serviceOrchestrator.registry.findServiceForCapability("commercial_office"));
  assert.ok(agent.serviceOrchestrator.registry.findServiceForCapability("marketing_office"));
  assert.equal(config.automations.emailTriggers, true);
  assert.equal(config.automations.crmTriggers, true);
  assert.equal(config.automations.externalEventTriggers, true);
  assert.equal(config.activity.emailAlerts, true);
});
