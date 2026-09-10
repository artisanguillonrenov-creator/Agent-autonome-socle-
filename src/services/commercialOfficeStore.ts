import { randomUUID } from "node:crypto";
import { getDb } from "../persistence/db.js";
import { bureauScope } from "./bureauScope.js";

export type ContactKind = "PROSPECT" | "CLIENT";
export const CONTACT_STATUSES = [
  "prospect",
  "contacted",
  "interested",
  "qualification",
  "proposition",
  "negotiation",
  "won",
  "lost",
  "to_follow_up",
] as const;
export type ContactStatus = (typeof CONTACT_STATUSES)[number];
/** Statuts après lesquels un contact est considéré "chaud" (activity.emailAlerts). */
export const HOT_STATUSES = new Set<ContactStatus>(["proposition", "negotiation"]);

export interface Contact {
  id: string;
  workspaceId: string;
  kind: ContactKind;
  name: string;
  email?: string;
  company?: string;
  status: ContactStatus;
  createdAt: number;
  updatedAt: number;
}

export interface Opportunity {
  id: string;
  workspaceId: string;
  contactId: string;
  title: string;
  status: ContactStatus;
  value?: number;
  currency?: string;
  createdAt: number;
  updatedAt: number;
}

export interface Interaction {
  id: string;
  workspaceId: string;
  contactId: string;
  opportunityId?: string;
  type: string;
  note?: string;
  occurredAt: number;
  createdAt: number;
}

export interface NextAction {
  id: string;
  workspaceId: string;
  contactId: string;
  opportunityId?: string;
  title: string;
  dueAt?: number;
  done: boolean;
  createdAt: number;
  updatedAt: number;
}

const contactRow = (r: any): Contact => ({
  id: r.id,
  workspaceId: r.workspace_id,
  kind: r.kind,
  name: r.name,
  email: r.email ?? undefined,
  company: r.company ?? undefined,
  status: r.status,
  createdAt: r.created_at,
  updatedAt: r.updated_at,
});
const opportunityRow = (r: any): Opportunity => ({
  id: r.id,
  workspaceId: r.workspace_id,
  contactId: r.contact_id,
  title: r.title,
  status: r.status,
  value: r.value ?? undefined,
  currency: r.currency ?? undefined,
  createdAt: r.created_at,
  updatedAt: r.updated_at,
});
const interactionRow = (r: any): Interaction => ({
  id: r.id,
  workspaceId: r.workspace_id,
  contactId: r.contact_id,
  opportunityId: r.opportunity_id ?? undefined,
  type: r.type,
  note: r.note ?? undefined,
  occurredAt: r.occurred_at,
  createdAt: r.created_at,
});
const nextActionRow = (r: any): NextAction => ({
  id: r.id,
  workspaceId: r.workspace_id,
  contactId: r.contact_id,
  opportunityId: r.opportunity_id ?? undefined,
  title: r.title,
  dueAt: r.due_at ?? undefined,
  done: Boolean(r.done),
  createdAt: r.created_at,
  updatedAt: r.updated_at,
});

/** CRM persistant du Commercial Office, strictement scopé par projet (voir bureauScope.ts). */
export class CommercialOfficeStore {
  createContact(workspaceId: string | undefined, input: { kind: ContactKind; name: string; email?: string; company?: string }): Contact {
    if (!input.name.trim()) throw new Error("COMMERCIAL_OFFICE_CONTACT_NAME_REQUIRED");
    const scope = bureauScope(workspaceId);
    const now = Date.now();
    const id = randomUUID();
    getDb()
      .prepare(
        `INSERT INTO crm_contacts (id, workspace_id, kind, name, email, company, status, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, 'prospect', ?, ?)`,
      )
      .run(id, scope, input.kind, input.name.trim(), input.email?.trim() || null, input.company?.trim() || null, now, now);
    return this.getContact(workspaceId, id)!;
  }

  getContact(workspaceId: string | undefined, id: string): Contact | null {
    const row = getDb().prepare("SELECT * FROM crm_contacts WHERE workspace_id=? AND id=?").get(bureauScope(workspaceId), id);
    return row ? contactRow(row) : null;
  }

  findContactByEmail(workspaceId: string | undefined, email: string): Contact | null {
    const row = getDb()
      .prepare("SELECT * FROM crm_contacts WHERE workspace_id=? AND email=? ORDER BY created_at DESC LIMIT 1")
      .get(bureauScope(workspaceId), email.trim().toLowerCase());
    return row ? contactRow(row) : null;
  }

  listContacts(workspaceId?: string): Contact[] {
    return (getDb().prepare("SELECT * FROM crm_contacts WHERE workspace_id=? ORDER BY created_at DESC").all(bureauScope(workspaceId)) as any[]).map(
      contactRow,
    );
  }

  updateContactStatus(workspaceId: string | undefined, id: string, status: ContactStatus): Contact {
    if (!CONTACT_STATUSES.includes(status)) throw new Error("COMMERCIAL_OFFICE_STATUS_INVALID");
    const scope = bureauScope(workspaceId);
    const changed = getDb().prepare("UPDATE crm_contacts SET status=?, updated_at=? WHERE workspace_id=? AND id=?").run(status, Date.now(), scope, id).changes;
    if (!changed) throw new Error("COMMERCIAL_OFFICE_CONTACT_NOT_FOUND");
    return this.getContact(workspaceId, id)!;
  }

  createOpportunity(workspaceId: string | undefined, input: { contactId: string; title: string; value?: number; currency?: string }): Opportunity {
    if (!this.getContact(workspaceId, input.contactId)) throw new Error("COMMERCIAL_OFFICE_CONTACT_NOT_FOUND");
    if (!input.title.trim()) throw new Error("COMMERCIAL_OFFICE_OPPORTUNITY_TITLE_REQUIRED");
    const scope = bureauScope(workspaceId);
    const now = Date.now();
    const id = randomUUID();
    getDb()
      .prepare(
        `INSERT INTO crm_opportunities (id, workspace_id, contact_id, title, status, value, currency, created_at, updated_at)
         VALUES (?, ?, ?, ?, 'prospect', ?, ?, ?, ?)`,
      )
      .run(id, scope, input.contactId, input.title.trim(), input.value ?? null, input.currency ?? null, now, now);
    return this.getOpportunity(workspaceId, id)!;
  }

  getOpportunity(workspaceId: string | undefined, id: string): Opportunity | null {
    const row = getDb().prepare("SELECT * FROM crm_opportunities WHERE workspace_id=? AND id=?").get(bureauScope(workspaceId), id);
    return row ? opportunityRow(row) : null;
  }

  updateOpportunityStatus(workspaceId: string | undefined, id: string, status: ContactStatus): Opportunity {
    if (!CONTACT_STATUSES.includes(status)) throw new Error("COMMERCIAL_OFFICE_STATUS_INVALID");
    const scope = bureauScope(workspaceId);
    const changed = getDb().prepare("UPDATE crm_opportunities SET status=?, updated_at=? WHERE workspace_id=? AND id=?").run(status, Date.now(), scope, id)
      .changes;
    if (!changed) throw new Error("COMMERCIAL_OFFICE_OPPORTUNITY_NOT_FOUND");
    return this.getOpportunity(workspaceId, id)!;
  }

  listOpportunities(workspaceId?: string): Opportunity[] {
    return (
      getDb().prepare("SELECT * FROM crm_opportunities WHERE workspace_id=? ORDER BY created_at DESC").all(bureauScope(workspaceId)) as any[]
    ).map(opportunityRow);
  }

  logInteraction(
    workspaceId: string | undefined,
    input: { contactId: string; opportunityId?: string; type: string; note?: string; occurredAt?: number },
  ): Interaction {
    if (!this.getContact(workspaceId, input.contactId)) throw new Error("COMMERCIAL_OFFICE_CONTACT_NOT_FOUND");
    if (!input.type.trim()) throw new Error("COMMERCIAL_OFFICE_INTERACTION_TYPE_REQUIRED");
    const scope = bureauScope(workspaceId);
    const now = Date.now();
    const id = randomUUID();
    getDb()
      .prepare(
        `INSERT INTO crm_interactions (id, workspace_id, contact_id, opportunity_id, type, note, occurred_at, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(id, scope, input.contactId, input.opportunityId ?? null, input.type.trim(), input.note ?? null, input.occurredAt ?? now, now);
    return interactionRow(getDb().prepare("SELECT * FROM crm_interactions WHERE id=?").get(id));
  }

  listInteractions(workspaceId?: string, contactId?: string): Interaction[] {
    const scope = bureauScope(workspaceId);
    const rows = contactId
      ? getDb().prepare("SELECT * FROM crm_interactions WHERE workspace_id=? AND contact_id=? ORDER BY occurred_at DESC").all(scope, contactId)
      : getDb().prepare("SELECT * FROM crm_interactions WHERE workspace_id=? ORDER BY occurred_at DESC").all(scope);
    return (rows as any[]).map(interactionRow);
  }

  createNextAction(
    workspaceId: string | undefined,
    input: { contactId: string; opportunityId?: string; title: string; dueAt?: number },
  ): NextAction {
    if (!this.getContact(workspaceId, input.contactId)) throw new Error("COMMERCIAL_OFFICE_CONTACT_NOT_FOUND");
    if (!input.title.trim()) throw new Error("COMMERCIAL_OFFICE_NEXT_ACTION_TITLE_REQUIRED");
    const scope = bureauScope(workspaceId);
    const now = Date.now();
    const id = randomUUID();
    getDb()
      .prepare(
        `INSERT INTO crm_next_actions (id, workspace_id, contact_id, opportunity_id, title, due_at, done, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, 0, ?, ?)`,
      )
      .run(id, scope, input.contactId, input.opportunityId ?? null, input.title.trim(), input.dueAt ?? null, now, now);
    return this.getNextAction(workspaceId, id)!;
  }

  getNextAction(workspaceId: string | undefined, id: string): NextAction | null {
    const row = getDb().prepare("SELECT * FROM crm_next_actions WHERE workspace_id=? AND id=?").get(bureauScope(workspaceId), id);
    return row ? nextActionRow(row) : null;
  }

  completeNextAction(workspaceId: string | undefined, id: string): NextAction {
    const scope = bureauScope(workspaceId);
    const changed = getDb().prepare("UPDATE crm_next_actions SET done=1, updated_at=? WHERE workspace_id=? AND id=?").run(Date.now(), scope, id).changes;
    if (!changed) throw new Error("COMMERCIAL_OFFICE_NEXT_ACTION_NOT_FOUND");
    return this.getNextAction(workspaceId, id)!;
  }

  listNextActions(workspaceId?: string, pendingOnly = false): NextAction[] {
    const scope = bureauScope(workspaceId);
    const rows = pendingOnly
      ? getDb().prepare("SELECT * FROM crm_next_actions WHERE workspace_id=? AND done=0 ORDER BY due_at IS NULL, due_at").all(scope)
      : getDb().prepare("SELECT * FROM crm_next_actions WHERE workspace_id=? ORDER BY created_at DESC").all(scope);
    return (rows as any[]).map(nextActionRow);
  }

  getState(workspaceId?: string) {
    return {
      contacts: this.listContacts(workspaceId),
      opportunities: this.listOpportunities(workspaceId),
      interactions: this.listInteractions(workspaceId),
      nextActions: this.listNextActions(workspaceId),
    };
  }
}
