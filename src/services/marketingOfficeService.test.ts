import test from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { closeDb, getDb } from "../persistence/db.js";
import { config } from "../config.js";
import type { TaskRequest } from "../orchestration/contract.js";
import { CONTRACT_SCHEMA_VERSION } from "../orchestration/contract.js";
import { MarketingOfficeService } from "./marketingOfficeService.js";
import { MarketingOfficeStore } from "./marketingOfficeStore.js";
import { jsonLlmFactory } from "./testStubLlm.js";

function setupTestDb() {
  config.db.path = ":memory:";
  closeDb();
  getDb();
}

function req(objective: string, context: Record<string, unknown>): TaskRequest {
  return {
    schema_version: CONTRACT_SCHEMA_VERSION,
    task_id: `task-${randomUUID()}`,
    trace_id: `trace-${randomUUID()}`,
    idempotency_key: `idemp-${randomUUID()}`,
    capability: "marketing_office",
    objective,
    context,
    constraints: [],
    priority: "medium",
    permissions: [],
  };
}

const STRATEGY_JSON = {
  segments: ["Joueurs RP mobiles"],
  personas: ["Le narrateur passionné"],
  positioning: "Le RP mobile le plus immersif du marché",
  valueProposition: "Un onboarding fluide vers un univers dark fantasy riche",
  messages: ["Entrez dans la légende"],
  launchStrategy: "Bêta fermée puis lancement communautaire",
  channels: ["Discord", "TikTok"],
};

test("SCÉNARIO D (Marketing Office) : DEFINE_STRATEGY exploite les briefs Product/Creative et persiste la stratégie", async () => {
  setupTestDb();
  const workspaceId = "proj-rp";
  const service = new MarketingOfficeService(new MarketingOfficeStore(), undefined, jsonLlmFactory(STRATEGY_JSON));

  const events = await service.handleTaskRequest(
    req("Prépare le lancement commercial", {
      action: "DEFINE_STRATEGY",
      productBrief: { valueProposition: "Onboarding fluide" },
      creativeBrief: { styleKeywords: ["dark fantasy"] },
      workspace: { id: workspaceId },
    }),
  );
  assert.equal(events[0].type, "TASK_COMPLETED");
  const payload = events[0].payload as any;
  assert.equal(payload.result.strategy.positioning, STRATEGY_JSON.positioning);
  assert.deepEqual(payload.dependencies, ["product_studio", "creative_studio"]);

  const store = new MarketingOfficeStore();
  const state = store.getState(workspaceId);
  assert.ok(state.strategy);
  assert.equal(state.strategy!.channels.join(","), STRATEGY_JSON.channels.join(","));
});

test("Marketing Office : PLAN_CAMPAIGN puis RECORD_RESULT persistent, et GET_STATE renvoie l'ensemble après recréation du store", async () => {
  setupTestDb();
  const workspaceId = "proj-rp";
  const store = new MarketingOfficeStore();
  const service = new MarketingOfficeService(store, undefined, jsonLlmFactory(STRATEGY_JSON));

  const campaignEvents = await service.handleTaskRequest(req("Planifie une campagne", { action: "PLAN_CAMPAIGN", name: "Lancement Discord", channel: "Discord", goal: "500 inscrits", workspace: { id: workspaceId } }));
  const campaign = (campaignEvents[0].payload as any).result.campaign;

  await service.handleTaskRequest(req("Résultat", { action: "RECORD_RESULT", campaignId: campaign.id, metric: "inscriptions", value: 620, workspace: { id: workspaceId } }));

  const reloaded = new MarketingOfficeStore();
  const state = reloaded.getState(workspaceId);
  assert.equal(state.campaigns.length, 1);
  assert.equal(state.results.length, 1);
  assert.equal(state.results[0].value, 620);
});

test("Marketing Office : ANALYZE_MARKET réutilise le WebSearchProvider existant, sans appel réseau non maîtrisé en test", async () => {
  setupTestDb();
  const stubSearch = { name: "stub", search: async () => [{ title: "Tendance Y", url: "https://example.com/y", snippet: "Tendance marché" }] };
  const service = new MarketingOfficeService(new MarketingOfficeStore(), stubSearch as any, jsonLlmFactory(STRATEGY_JSON));
  const events = await service.handleTaskRequest(req("Analyse marché", { action: "ANALYZE_MARKET", queries: ["tendances RP mobile"] }));
  assert.equal(events[0].type, "TASK_COMPLETED");
  assert.equal((events[0].payload as any).result.sources.length, 1);
});

test("Marketing Office : RECORD_RESULT échoue explicitement pour une campagne inconnue", async () => {
  setupTestDb();
  const service = new MarketingOfficeService(new MarketingOfficeStore(), undefined, jsonLlmFactory(STRATEGY_JSON));
  const events = await service.handleTaskRequest(req("Résultat", { action: "RECORD_RESULT", campaignId: "inconnue", metric: "clics", value: 10 }));
  assert.equal(events[0].type, "TASK_FAILED");
  assert.match(String((events[0].payload as any).error), /MARKETING_OFFICE_CAMPAIGN_NOT_FOUND/);
});
