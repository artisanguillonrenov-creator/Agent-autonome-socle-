import test from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { closeDb, getDb } from "../persistence/db.js";
import { config } from "../config.js";
import type { TaskRequest } from "../orchestration/contract.js";
import { CONTRACT_SCHEMA_VERSION } from "../orchestration/contract.js";
import { CommercialOfficeService } from "./commercialOfficeService.js";
import { CommercialOfficeStore } from "./commercialOfficeStore.js";
import { NotificationStore } from "../autonomy/notificationStore.js";
import { NoopEmailProvider, type EmailMessage, type EmailProvider, type EmailSendResult } from "../email/emailProvider.js";

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

class StubEmailProvider implements EmailProvider {
  public sent: EmailMessage[] = [];
  constructor(private readonly result: EmailSendResult = { ok: true, id: "stub-email-1" }) {}
  async send(message: EmailMessage): Promise<EmailSendResult> {
    this.sent.push(message);
    return this.result;
  }
}

test("SCÉNARIO E — Commercial Office : prospect -> interaction -> statut -> prochaine action, retrouvés après recréation du runtime", async () => {
  setupTestDb();
  const workspaceId = "proj-rp";
  const store = new CommercialOfficeStore();
  const service = new CommercialOfficeService(store, new NoopEmailProvider(), new NotificationStore());

  const createEvents = await service.handleTaskRequest(req("commercial_office", "Créer prospect", { action: "CREATE_PROSPECT", name: "Alice Dupont", email: "alice@example.com", workspace: { id: workspaceId } }));
  const contact = (createEvents[0].payload as any).result.contact;
  assert.equal(contact.status, "prospect");

  await service.handleTaskRequest(req("commercial_office", "Interaction", { action: "LOG_INTERACTION", contactId: contact.id, type: "CALL", note: "Premier contact", workspace: { id: workspaceId } }));
  await service.handleTaskRequest(req("commercial_office", "Statut", { action: "UPDATE_STATUS", contactId: contact.id, status: "qualification", workspace: { id: workspaceId } }));
  const nextActionEvents = await service.handleTaskRequest(
    req("commercial_office", "Prochaine action", { action: "CREATE_NEXT_ACTION", contactId: contact.id, title: "Envoyer une proposition", workspace: { id: workspaceId } }),
  );
  const nextAction = (nextActionEvents[0].payload as any).result.nextAction;

  // "Redémarre/recrée le runtime" : nouvelle instance du store lisant la même base.
  const reloadedStore = new CommercialOfficeStore();
  const state = reloadedStore.getState(workspaceId);
  assert.equal(state.contacts.length, 1);
  assert.equal(state.contacts[0].status, "qualification");
  assert.equal(state.interactions.length, 1);
  assert.equal(state.nextActions.length, 1);
  assert.equal(state.nextActions[0].done, false);

  const reloadedService = new CommercialOfficeService(reloadedStore, new NoopEmailProvider(), new NotificationStore());
  await reloadedService.handleTaskRequest(req("commercial_office", "Compléter", { action: "COMPLETE_NEXT_ACTION", actionId: nextAction.id, workspace: { id: workspaceId } }));
  assert.equal(reloadedStore.getState(workspaceId).nextActions[0].done, true);
});

test("SCÉNARIO H — Commercial Office : PREPARE_MESSAGE ne fait qu'un brouillon, n'envoie jamais rien", async () => {
  setupTestDb();
  const workspaceId = "proj-rp";
  const store = new CommercialOfficeStore();
  const contact = store.createContact(workspaceId, { kind: "PROSPECT", name: "Bob", email: "bob@example.com" });
  const emailProvider = new StubEmailProvider();
  const service = new CommercialOfficeService(store, emailProvider, new NotificationStore());

  const events = await service.handleTaskRequest(
    req("commercial_office", "Prépare une relance", { action: "PREPARE_MESSAGE", contactId: contact.id, kind: "FOLLOWUP", context: "Relance après devis", workspace: { id: workspaceId } }),
  );
  assert.equal(events[0].type, "TASK_COMPLETED");
  assert.ok((events[0].payload as any).result.draft);
  assert.equal(emailProvider.sent.length, 0, "PREPARE_MESSAGE ne doit jamais déclencher un envoi réel");
  const interactions = store.listInteractions(workspaceId, contact.id);
  assert.ok(interactions.some((i) => i.type === "MESSAGE_DRAFTED"));
  assert.ok(!interactions.some((i) => i.type === "EMAIL_OUT"));
});

test("SCÉNARIO H — Commercial Office : SEND_MESSAGE (commercial_office_send) envoie réellement quand un provider est configuré", async () => {
  setupTestDb();
  const workspaceId = "proj-rp";
  const store = new CommercialOfficeStore();
  const contact = store.createContact(workspaceId, { kind: "PROSPECT", name: "Bob", email: "bob@example.com" });
  const emailProvider = new StubEmailProvider();
  const service = new CommercialOfficeService(store, emailProvider, new NotificationStore());

  const events = await service.handleTaskRequest(
    req("commercial_office_send", "Envoie la relance", { action: "SEND_MESSAGE", contactId: contact.id, subject: "Relance", text: "Bonjour Bob", workspace: { id: workspaceId } }),
  );
  assert.equal(events[0].type, "TASK_COMPLETED");
  assert.equal(emailProvider.sent.length, 1);
  assert.equal(emailProvider.sent[0].to, "bob@example.com");
  assert.ok(store.listInteractions(workspaceId, contact.id).some((i) => i.type === "EMAIL_OUT"));
});

test("Commercial Office : SEND_MESSAGE échoue explicitement si aucun fournisseur e-mail réel n'est configuré (jamais un faux succès)", async () => {
  setupTestDb();
  const workspaceId = "proj-rp";
  const store = new CommercialOfficeStore();
  const contact = store.createContact(workspaceId, { kind: "PROSPECT", name: "Bob", email: "bob@example.com" });
  const service = new CommercialOfficeService(store, new NoopEmailProvider(), new NotificationStore());

  const events = await service.handleTaskRequest(
    req("commercial_office_send", "Envoie", { action: "SEND_MESSAGE", contactId: contact.id, subject: "Relance", text: "Bonjour", workspace: { id: workspaceId } }),
  );
  assert.equal(events[0].type, "TASK_FAILED");
  assert.match(String((events[0].payload as any).error), /EMAIL_PROVIDER_NOT_CONFIGURED/);
  assert.equal(store.listInteractions(workspaceId, contact.id).filter((i) => i.type === "EMAIL_OUT").length, 0);
});

test("Commercial Office : la correspondance par e-mail est insensible à la casse (le contact n'est jamais dupliqué)", async () => {
  setupTestDb();
  const workspaceId = "proj-rp";
  const store = new CommercialOfficeStore();
  const service = new CommercialOfficeService(store, new NoopEmailProvider(), new NotificationStore());

  const created = store.createContact(workspaceId, { kind: "PROSPECT", name: "Carla", email: "Carla@Example.com" });
  const events = await service.handleTaskRequest(
    req("commercial_office", "E-mail entrant", { action: "INGEST_EMAIL", from: "carla@example.com", subject: "Suite", body: "Une question", workspace: { id: workspaceId } }),
  );
  assert.equal((events[0].payload as any).result.created, false);
  assert.equal((events[0].payload as any).result.contact.id, created.id);
  assert.equal(store.listContacts(workspaceId).length, 1);
});

test("Commercial Office : INGEST_EMAIL crée un prospect si aucun contact ne correspond, sinon rattache l'interaction au contact existant", async () => {
  setupTestDb();
  const workspaceId = "proj-rp";
  const store = new CommercialOfficeStore();
  const service = new CommercialOfficeService(store, new NoopEmailProvider(), new NotificationStore());

  const first = await service.handleTaskRequest(
    req("commercial_office", "E-mail entrant", { action: "INGEST_EMAIL", from: "Carla <carla@example.com>", subject: "Intéressée", body: "Je veux en savoir plus", workspace: { id: workspaceId } }),
  );
  assert.equal((first[0].payload as any).result.created, true);
  const contactId = (first[0].payload as any).result.contact.id;

  const second = await service.handleTaskRequest(
    req("commercial_office", "E-mail entrant 2", { action: "INGEST_EMAIL", from: "Carla <carla@example.com>", subject: "Suite", body: "Une autre question", workspace: { id: workspaceId } }),
  );
  assert.equal((second[0].payload as any).result.created, false);
  assert.equal((second[0].payload as any).result.contact.id, contactId);
  assert.equal(store.listContacts(workspaceId).length, 1);
});

test("Commercial Office : une réponse d'un contact 'chaud' (négociation) déclenche une notification d'attention", async () => {
  setupTestDb();
  const workspaceId = "proj-rp";
  const store = new CommercialOfficeStore();
  const contact = store.createContact(workspaceId, { kind: "PROSPECT", name: "Dana", email: "dana@example.com" });
  store.updateContactStatus(workspaceId, contact.id, "negotiation");
  const notifications = new NotificationStore();
  const service = new CommercialOfficeService(store, new NoopEmailProvider(), notifications);

  await service.handleTaskRequest(req("commercial_office", "E-mail entrant", { action: "INGEST_EMAIL", from: "dana@example.com", subject: "Ma réponse", body: "Ok pour signer", workspace: { id: workspaceId } }));

  const unread = notifications.list(true);
  assert.ok(unread.some((n) => n.type === "COMMERCIAL_ATTENTION_REQUIRED"));
});

test("Commercial Office : INGEST_CRM_EVENT gère NEW_LEAD, STATUS_CHANGE et OPPORTUNITY_WON", async () => {
  setupTestDb();
  const workspaceId = "proj-rp";
  const store = new CommercialOfficeStore();
  const service = new CommercialOfficeService(store, new NoopEmailProvider(), new NotificationStore());

  const leadEvents = await service.handleTaskRequest(
    req("commercial_office", "Lead CRM", { action: "INGEST_CRM_EVENT", eventType: "NEW_LEAD", data: { name: "Eve", email: "eve@example.com" }, workspace: { id: workspaceId } }),
  );
  const contact = (leadEvents[0].payload as any).result.contact;
  assert.equal(contact.name, "Eve");

  const statusEvents = await service.handleTaskRequest(
    req("commercial_office", "Statut CRM", { action: "INGEST_CRM_EVENT", eventType: "STATUS_CHANGE", data: { contactId: contact.id, status: "interested" }, workspace: { id: workspaceId } }),
  );
  assert.equal((statusEvents[0].payload as any).result.contact.status, "interested");

  const opportunity = store.createOpportunity(workspaceId, { contactId: contact.id, title: "Deal Eve" });
  const wonEvents = await service.handleTaskRequest(
    req("commercial_office", "Opportunité gagnée", { action: "INGEST_CRM_EVENT", eventType: "OPPORTUNITY_WON", data: { opportunityId: opportunity.id }, workspace: { id: workspaceId } }),
  );
  assert.equal((wonEvents[0].payload as any).result.opportunity.status, "won");
});
