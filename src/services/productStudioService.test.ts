import test from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { closeDb, getDb } from "../persistence/db.js";
import { config } from "../config.js";
import type { TaskRequest } from "../orchestration/contract.js";
import { CONTRACT_SCHEMA_VERSION } from "../orchestration/contract.js";
import { ProductStudioService } from "./productStudioService.js";
import { ProductStudioStore } from "./productStudioStore.js";
import { jsonLlmFactory, textLlmFactory } from "./testStubLlm.js";

function setupTestDb() {
  config.db.path = ":memory:";
  closeDb();
  getDb();
}

function req(capability: string, objective: string, context: Record<string, unknown>): TaskRequest {
  return {
    schema_version: CONTRACT_SCHEMA_VERSION,
    task_id: `task-${randomUUID()}`,
    trace_id: `trace-${randomUUID()}`,
    idempotency_key: `idemp-${randomUUID()}`,
    capability,
    objective,
    context,
    constraints: [],
    priority: "medium",
    permissions: [],
  };
}

const ANALYSIS_JSON = {
  summary: "Application RP avec fondations solides mais onboarding faible.",
  targetUsers: "Joueurs de RP narratif 18-35 ans",
  strengths: ["Univers riche"],
  weaknesses: ["Onboarding confus"],
  opportunities: ["Marché RP mobile en croissance"],
  recommendedImprovements: [{ title: "Refaire l'onboarding", value: "HIGH", effort: "MEDIUM", priority: 1 }],
  missingFeatures: ["Tutoriel interactif"],
  roadmap: [{ title: "Onboarding v2", priority: 1 }],
  specs: "Refonte de l'écran d'accueil avec tutoriel guidé.",
};

test("SCÉNARIO A — Product Studio : ANALYZE produit un résultat structuré et le persiste par projet", async () => {
  setupTestDb();
  const workspaceId = "proj-rp";
  const service = new ProductStudioService(new ProductStudioStore(), undefined, jsonLlmFactory(ANALYSIS_JSON));
  const r = req("product_studio", "Analyse mon application RP", { action: "ANALYZE", projectSummary: "Appli RP mobile", workspace: { id: workspaceId } });

  const events = await service.handleTaskRequest(r);
  assert.equal(events.length, 1);
  assert.equal(events[0].type, "TASK_COMPLETED");
  const payload = events[0].payload as any;
  assert.equal(payload.office, "product_studio");
  assert.equal(payload.status, "COMPLETED");
  assert.ok(payload.recommendations.length > 0);
  assert.ok(payload.result.analysis.summary.includes("Application RP"));

  const store = new ProductStudioStore();
  const state = store.getState(workspaceId);
  assert.equal(state.analyses.length, 1);
  assert.equal(state.analyses[0].summary, ANALYSIS_JSON.summary);
});

test("Product Studio : ANALYZE sans projectSummary ni objectif échoue explicitement, jamais silencieusement", async () => {
  setupTestDb();
  const service = new ProductStudioService(new ProductStudioStore(), undefined, jsonLlmFactory(ANALYSIS_JSON));
  const r = req("product_studio", "", { action: "ANALYZE" });
  const events = await service.handleTaskRequest(r);
  assert.equal(events[0].type, "TASK_FAILED");
  assert.match(String((events[0].payload as any).error), /PRODUCT_STUDIO_PROJECT_SUMMARY_REQUIRED/);
});

test("Product Studio : une sortie LLM non-JSON échoue explicitement (jamais une analyse partielle inventée)", async () => {
  setupTestDb();
  const service = new ProductStudioService(new ProductStudioStore(), undefined, textLlmFactory("Ceci n'est pas du JSON."));
  const r = req("product_studio", "Analyse", { action: "ANALYZE", projectSummary: "Un projet" });
  const events = await service.handleTaskRequest(r);
  assert.equal(events[0].type, "TASK_FAILED");
  assert.match(String((events[0].payload as any).error), /LLM_OUTPUT_NOT_JSON/);
});

test("Product Studio : RECORD_DECISION puis GET_STATE reflètent la décision, et BRIEF_FOR_OFFICE réutilise la dernière analyse", async () => {
  setupTestDb();
  const workspaceId = "proj-rp";
  const store = new ProductStudioStore();
  const service = new ProductStudioService(store, undefined, jsonLlmFactory(ANALYSIS_JSON));

  await service.handleTaskRequest(req("product_studio", "Analyse", { action: "ANALYZE", projectSummary: "Appli RP", workspace: { id: workspaceId } }));

  const decisionEvents = await service.handleTaskRequest(
    req("product_studio", "Décision", { action: "RECORD_DECISION", decision: "Prioriser l'onboarding v2", workspace: { id: workspaceId } }),
  );
  assert.equal(decisionEvents[0].type, "TASK_COMPLETED");

  const stateEvents = await service.handleTaskRequest(req("product_studio", "État", { action: "GET_STATE", workspace: { id: workspaceId } }));
  const statePayload = (stateEvents[0].payload as any).result.state;
  assert.equal(statePayload.analyses.length, 1);
  assert.equal(statePayload.decisions.length, 1);
  assert.equal(statePayload.decisions[0].decision, "Prioriser l'onboarding v2");

  const briefEvents = await service.handleTaskRequest(
    req("product_studio", "Brief", { action: "BRIEF_FOR_OFFICE", targetOffice: "marketing_office", workspace: { id: workspaceId } }),
  );
  const brief = (briefEvents[0].payload as any).result.brief;
  assert.equal(brief.targetOffice, "marketing_office");
  assert.ok(brief.priorities.length > 0);
});

test("Product Studio : RESEARCH_MARKET réutilise le WebSearchProvider existant, sans appel réseau non maîtrisé en test", async () => {
  setupTestDb();
  const stubSearch = { name: "stub", search: async () => [{ title: "Concurrent X", url: "https://example.com/x", snippet: "Analyse concurrente" }] };
  const service = new ProductStudioService(new ProductStudioStore(), stubSearch as any, jsonLlmFactory(ANALYSIS_JSON));
  const events = await service.handleTaskRequest(req("product_studio", "Recherche marché", { action: "RESEARCH_MARKET", queries: ["concurrents RP mobile"] }));
  assert.equal(events[0].type, "TASK_COMPLETED");
  const payload = events[0].payload as any;
  assert.equal(payload.result.sources.length, 1);
  assert.equal(payload.result.sources[0].title, "Concurrent X");
});

test("Product Studio : les projets restent isolés — l'analyse d'un projet n'apparaît jamais dans un autre", async () => {
  setupTestDb();
  const store = new ProductStudioStore();
  const service = new ProductStudioService(store, undefined, jsonLlmFactory(ANALYSIS_JSON));

  await service.handleTaskRequest(req("product_studio", "Analyse A", { action: "ANALYZE", projectSummary: "Projet A", workspace: { id: "proj-a" } }));

  const stateB = store.getState("proj-b");
  assert.equal(stateB.analyses.length, 0);
  const stateA = store.getState("proj-a");
  assert.equal(stateA.analyses.length, 1);
});
