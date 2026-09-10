import test from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { closeDb, getDb } from "../persistence/db.js";
import { config } from "../config.js";
import type { TaskRequest } from "../orchestration/contract.js";
import { CONTRACT_SCHEMA_VERSION } from "../orchestration/contract.js";
import { CreativeStudioService } from "./creativeStudioService.js";
import { CreativeStudioStore } from "./creativeStudioStore.js";
import { StubLLMProvider } from "./testStubLlm.js";
import type { ChatMessage } from "../types.js";

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
    capability: "creative_studio",
    objective,
    context,
    constraints: [],
    priority: "medium",
    permissions: [],
  };
}

const DARK_FANTASY_IDENTITY = {
  palette: ["bleu nuit", "indigo", "doré"],
  typography: "Serif gothique",
  styleKeywords: ["dark fantasy", "mystique"],
  mood: "sombre et élégant",
  iconography: "runes et croissants de lune",
  principles: ["contraste fort", "lisibilité prioritaire"],
  references: ["Diablo", "Elden Ring"],
  assets: [],
};

test("SCÉNARIO B — Creative Studio : DEFINE_IDENTITY produit une direction artistique et la persiste par projet", async () => {
  setupTestDb();
  const workspaceId = "proj-rp";
  const llmFactory = () => new StubLLMProvider(() => JSON.stringify(DARK_FANTASY_IDENTITY));
  const service = new CreativeStudioService(new CreativeStudioStore(), llmFactory);

  const events = await service.handleTaskRequest(req("Définis une identité visuelle", { action: "DEFINE_IDENTITY", brief: "Dark fantasy", workspace: { id: workspaceId } }));
  assert.equal(events[0].type, "TASK_COMPLETED");
  const payload = events[0].payload as any;
  assert.deepEqual(payload.result.identity.palette, DARK_FANTASY_IDENTITY.palette);

  const store = new CreativeStudioStore();
  const state = store.getState(workspaceId);
  assert.ok(state.identity);
  assert.deepEqual(state.identity!.palette, DARK_FANTASY_IDENTITY.palette);
  assert.equal(state.decisions.length, 1);
  assert.equal(state.decisions[0].status, "DEFINED");
});

test("SCÉNARIO C — Creative Studio : continuité artistique — un second écran respecte l'identité déjà validée", async () => {
  setupTestDb();
  const workspaceId = "proj-rp";
  const store = new CreativeStudioStore();
  store.setIdentity(workspaceId, DARK_FANTASY_IDENTITY);

  let capturedPrompt = "";
  const llmFactory = () =>
    new StubLLMProvider((messages: ChatMessage[]) => {
      capturedPrompt = messages.map((m) => m.content ?? "").join("\n");
      return "Un écran de sélection de personnage tout en bleu nuit et doré, typographie gothique cohérente avec l'identité validée.";
    });
  const service = new CreativeStudioService(store, llmFactory);

  const events = await service.handleTaskRequest(
    req("Concept d'un nouvel écran", { action: "PROPOSE_SCREEN_CONCEPT", screenDescription: "Écran de sélection de personnage", workspace: { id: workspaceId } }),
  );
  assert.equal(events[0].type, "TASK_COMPLETED");

  // La direction artistique déjà validée est INJECTÉE dans le prompt — jamais une dérive
  // aléatoire (ex. une proposition pastel rose non demandée).
  assert.match(capturedPrompt, /bleu nuit/);
  assert.match(capturedPrompt, /indigo/);
  assert.match(capturedPrompt, /doré/);
  const payload = events[0].payload as any;
  assert.equal(payload.result.identityUsed, store.getState(workspaceId).identity!.id);
});

test("Creative Studio : PROPOSE_SCREEN_CONCEPT sans identité existante recommande d'en définir une plutôt que d'inventer un style", async () => {
  setupTestDb();
  const service = new CreativeStudioService(new CreativeStudioStore(), () => new StubLLMProvider(() => "ne doit pas être appelé"));
  const events = await service.handleTaskRequest(req("Concept d'écran", { action: "PROPOSE_SCREEN_CONCEPT", screenDescription: "Écran d'accueil" }));
  assert.equal(events[0].type, "TASK_COMPLETED");
  const payload = events[0].payload as any;
  assert.equal(payload.result.concept, null);
  assert.match(payload.recommendations.join(" "), /DEFINE_IDENTITY/);
});

test("Creative Studio : un changement majeur de direction artistique est journalisé comme décision REPLACED, jamais silencieux", async () => {
  setupTestDb();
  const workspaceId = "proj-rp";
  const store = new CreativeStudioStore();
  store.setIdentity(workspaceId, DARK_FANTASY_IDENTITY);

  const pastel = { ...DARK_FANTASY_IDENTITY, palette: ["rose pastel", "lavande"], mood: "doux et léger" };
  const service = new CreativeStudioService(store, () => new StubLLMProvider(() => JSON.stringify(pastel)));
  await service.handleTaskRequest(req("Nouvelle direction demandée explicitement", { action: "DEFINE_IDENTITY", brief: "Change pour un univers pastel doux, demande explicite du client", workspace: { id: workspaceId } }));

  const state = store.getState(workspaceId);
  assert.deepEqual(state.identity!.palette, pastel.palette);
  assert.ok(state.decisions.some((d) => d.status === "REPLACED"));
});

test("Creative Studio : RECORD_DECISION trace un élément explicitement refusé", async () => {
  setupTestDb();
  const workspaceId = "proj-rp";
  const store = new CreativeStudioStore();
  const service = new CreativeStudioService(store);
  const events = await service.handleTaskRequest(
    req("Décision", { action: "RECORD_DECISION", decision: "Icône trop enfantine", status: "REJECTED", note: "Ne correspond pas au ton dark fantasy", workspace: { id: workspaceId } }),
  );
  assert.equal(events[0].type, "TASK_COMPLETED");
  const state = store.getState(workspaceId);
  assert.equal(state.decisions[0].status, "REJECTED");
});
