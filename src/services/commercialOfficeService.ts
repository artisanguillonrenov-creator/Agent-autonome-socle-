import type { TaskRequest, ServiceEvent } from "../orchestration/contract.js";
import { CommercialOfficeStore, HOT_STATUSES, CONTACT_STATUSES, type ContactStatus } from "./commercialOfficeStore.js";
import { buildBureauResult, completedEvent, failedEvent, officeLlm } from "./bureauContract.js";
import { createEmailProvider, type EmailProvider } from "../email/emailProvider.js";
import { NotificationStore } from "../autonomy/notificationStore.js";
import type { ChatMessage } from "../types.js";
import type { LLMProvider } from "../llm/provider.js";
import type { ModelRole } from "../llm/modelRouter.js";

function scopedId(workspaceId?: string) {
  return workspaceId ?? "__global__";
}

export class CommercialOfficeService {
  constructor(
    private readonly store = new CommercialOfficeStore(),
    private readonly emailProvider: EmailProvider = createEmailProvider(),
    private readonly notifications = new NotificationStore(),
    private readonly llm: (role?: ModelRole) => LLMProvider = officeLlm,
  ) {}

  async handleTaskRequest(r: TaskRequest): Promise<ServiceEvent[]> {
    const action = String(r.context.action ?? "");
    const workspaceId = typeof (r.context.workspace as any)?.id === "string" ? (r.context.workspace as any).id : undefined;
    try {
      if (r.capability === "commercial_office_send") {
        if (action !== "SEND_MESSAGE") throw new Error(`COMMERCIAL_OFFICE_SEND_ACTION_INVALID: ${action}`);
        return await this.sendMessage(r, workspaceId);
      }
      switch (action) {
        case "CREATE_PROSPECT":
          return this.createProspect(r, workspaceId);
        case "UPDATE_STATUS":
          return this.updateStatus(r, workspaceId);
        case "CREATE_OPPORTUNITY":
          return this.createOpportunity(r, workspaceId);
        case "UPDATE_OPPORTUNITY_STATUS":
          return this.updateOpportunityStatus(r, workspaceId);
        case "LOG_INTERACTION":
          return this.logInteraction(r, workspaceId);
        case "PREPARE_MESSAGE":
          return await this.prepareMessage(r, workspaceId);
        case "CREATE_NEXT_ACTION":
          return this.createNextAction(r, workspaceId);
        case "COMPLETE_NEXT_ACTION":
          return this.completeNextAction(r, workspaceId);
        case "LIST_STATE":
          return this.listState(r, workspaceId);
        case "INGEST_EMAIL":
          return this.ingestEmail(r, workspaceId);
        case "INGEST_CRM_EVENT":
          return this.ingestCrmEvent(r, workspaceId);
        default:
          throw new Error(`COMMERCIAL_OFFICE_ACTION_INVALID: ${action}`);
      }
    } catch (e) {
      // service field = "commercial_office" (l'id du service enregistré), jamais
      // r.capability : OperationStore.validateEvent exige que l'événement porte le
      // selectedService réel, même pour la capacité commercial_office_send.
      return failedEvent(r, "commercial_office", (e as Error).message, true);
    }
  }

  private createProspect(r: TaskRequest, workspaceId?: string): ServiceEvent[] {
    const contact = this.store.createContact(workspaceId, {
      kind: "PROSPECT",
      name: String(r.context.name ?? "").trim(),
      email: typeof r.context.email === "string" ? r.context.email : undefined,
      company: typeof r.context.company === "string" ? r.context.company : undefined,
    });
    const result = buildBureauResult({
      office: "commercial_office",
      workspaceId: scopedId(workspaceId),
      action: "CREATE_PROSPECT",
      mission: r.objective,
      summary: `Prospect créé : ${contact.name}`,
      result: { contact },
      nextSteps: ["Qualifier le prospect", "Planifier une prochaine action"],
      taskId: r.task_id,
    });
    return completedEvent(r, "commercial_office", { ...result });
  }

  private updateStatus(r: TaskRequest, workspaceId?: string): ServiceEvent[] {
    const contactId = String(r.context.contactId ?? "");
    const status = String(r.context.status ?? "") as ContactStatus;
    const contact = this.store.updateContactStatus(workspaceId, contactId, status);
    const result = buildBureauResult({
      office: "commercial_office",
      workspaceId: scopedId(workspaceId),
      action: "UPDATE_STATUS",
      mission: r.objective,
      summary: `Statut de ${contact.name} mis à jour : ${status}`,
      result: { contact },
      taskId: r.task_id,
    });
    return completedEvent(r, "commercial_office", { ...result });
  }

  private createOpportunity(r: TaskRequest, workspaceId?: string): ServiceEvent[] {
    const opportunity = this.store.createOpportunity(workspaceId, {
      contactId: String(r.context.contactId ?? ""),
      title: String(r.context.title ?? "").trim(),
      value: typeof r.context.value === "number" ? r.context.value : undefined,
      currency: typeof r.context.currency === "string" ? r.context.currency : undefined,
    });
    const result = buildBureauResult({
      office: "commercial_office",
      workspaceId: scopedId(workspaceId),
      action: "CREATE_OPPORTUNITY",
      mission: r.objective,
      summary: `Opportunité créée : ${opportunity.title}`,
      result: { opportunity },
      taskId: r.task_id,
    });
    return completedEvent(r, "commercial_office", { ...result });
  }

  private updateOpportunityStatus(r: TaskRequest, workspaceId?: string): ServiceEvent[] {
    const opportunity = this.store.updateOpportunityStatus(workspaceId, String(r.context.opportunityId ?? ""), String(r.context.status ?? "") as ContactStatus);
    const result = buildBureauResult({
      office: "commercial_office",
      workspaceId: scopedId(workspaceId),
      action: "UPDATE_OPPORTUNITY_STATUS",
      mission: r.objective,
      summary: `Opportunité "${opportunity.title}" -> ${opportunity.status}`,
      result: { opportunity },
      taskId: r.task_id,
    });
    return completedEvent(r, "commercial_office", { ...result });
  }

  private logInteraction(r: TaskRequest, workspaceId?: string): ServiceEvent[] {
    const interaction = this.store.logInteraction(workspaceId, {
      contactId: String(r.context.contactId ?? ""),
      opportunityId: typeof r.context.opportunityId === "string" ? r.context.opportunityId : undefined,
      type: String(r.context.type ?? "").trim(),
      note: typeof r.context.note === "string" ? r.context.note : undefined,
      occurredAt: typeof r.context.occurredAt === "number" ? r.context.occurredAt : undefined,
    });
    const result = buildBureauResult({
      office: "commercial_office",
      workspaceId: scopedId(workspaceId),
      action: "LOG_INTERACTION",
      mission: r.objective,
      summary: `Interaction enregistrée (${interaction.type})`,
      result: { interaction },
      taskId: r.task_id,
    });
    return completedEvent(r, "commercial_office", { ...result });
  }

  private async prepareMessage(r: TaskRequest, workspaceId?: string): Promise<ServiceEvent[]> {
    const contactId = String(r.context.contactId ?? "");
    const contact = this.store.getContact(workspaceId, contactId);
    if (!contact) throw new Error("COMMERCIAL_OFFICE_CONTACT_NOT_FOUND");
    const kind = String(r.context.kind ?? "FOLLOWUP");
    const messageContext = String(r.context.context ?? r.objective ?? "");

    const messages: ChatMessage[] = [
      {
        role: "system",
        content:
          "Tu es le Commercial Office de Jarvis. Rédige UNIQUEMENT un brouillon de message commercial (prospection, relance ou proposition), jamais envoyé automatiquement. Ton professionnel, concis, personnalisé au contact.",
      },
      { role: "user", content: `Type de message : ${kind}\nContact : ${contact.name} (${contact.company ?? "sans société"}), statut ${contact.status}\nContexte : ${messageContext}` },
    ];
    const raw = await this.llm("utility").complete(messages, { temperature: 0.5 });
    const draft = (raw.content ?? "").trim();

    // Traçable, mais explicitement un BROUILLON — jamais confondu avec un envoi réel (EMAIL_OUT).
    this.store.logInteraction(workspaceId, { contactId, type: "MESSAGE_DRAFTED", note: draft });

    const result = buildBureauResult({
      office: "commercial_office",
      workspaceId: scopedId(workspaceId),
      action: "PREPARE_MESSAGE",
      mission: r.objective,
      summary: `Brouillon de message (${kind}) préparé pour ${contact.name}. Aucun envoi effectué.`,
      result: { draft, contactId },
      proposedActions: ["Envoyer ce message via la capacité commercial_office_send (soumis aux permissions SEND)"],
      taskId: r.task_id,
    });
    return completedEvent(r, "commercial_office", { ...result });
  }

  private createNextAction(r: TaskRequest, workspaceId?: string): ServiceEvent[] {
    const nextAction = this.store.createNextAction(workspaceId, {
      contactId: String(r.context.contactId ?? ""),
      opportunityId: typeof r.context.opportunityId === "string" ? r.context.opportunityId : undefined,
      title: String(r.context.title ?? "").trim(),
      dueAt: typeof r.context.dueAt === "number" ? r.context.dueAt : undefined,
    });
    const result = buildBureauResult({
      office: "commercial_office",
      workspaceId: scopedId(workspaceId),
      action: "CREATE_NEXT_ACTION",
      mission: r.objective,
      summary: `Prochaine action créée : ${nextAction.title}`,
      result: { nextAction },
      taskId: r.task_id,
    });
    return completedEvent(r, "commercial_office", { ...result });
  }

  private completeNextAction(r: TaskRequest, workspaceId?: string): ServiceEvent[] {
    const nextAction = this.store.completeNextAction(workspaceId, String(r.context.actionId ?? ""));
    const result = buildBureauResult({
      office: "commercial_office",
      workspaceId: scopedId(workspaceId),
      action: "COMPLETE_NEXT_ACTION",
      mission: r.objective,
      summary: `Action "${nextAction.title}" marquée terminée`,
      result: { nextAction },
      taskId: r.task_id,
    });
    return completedEvent(r, "commercial_office", { ...result });
  }

  private listState(r: TaskRequest, workspaceId?: string): ServiceEvent[] {
    const state = this.store.getState(workspaceId);
    const result = buildBureauResult({
      office: "commercial_office",
      workspaceId: scopedId(workspaceId),
      action: "LIST_STATE",
      mission: r.objective,
      summary: `${state.contacts.length} contact(s), ${state.opportunities.length} opportunité(s), ${state.nextActions.filter((a) => !a.done).length} action(s) en attente.`,
      result: { state },
      taskId: r.task_id,
    });
    return completedEvent(r, "commercial_office", { ...result });
  }

  /** automations.emailTriggers : ingestion d'un e-mail entrant, idempotence assurée en amont par le trigger HTTP (voir triggers.ts). */
  private ingestEmail(r: TaskRequest, workspaceId?: string): ServiceEvent[] {
    const from = String(r.context.from ?? "").trim();
    const subject = String(r.context.subject ?? "").trim();
    const body = String(r.context.body ?? "").trim();
    if (!from) throw new Error("COMMERCIAL_OFFICE_EMAIL_FROM_REQUIRED");
    const emailAddress = (from.match(/<(.+)>/)?.[1] ?? from).trim().toLowerCase();

    let contact = this.store.findContactByEmail(workspaceId, emailAddress);
    let created = false;
    if (!contact) {
      contact = this.store.createContact(workspaceId, { kind: "PROSPECT", name: from.replace(/<.*>/, "").trim() || emailAddress, email: emailAddress });
      created = true;
    }
    this.store.logInteraction(workspaceId, { contactId: contact.id, type: "EMAIL_IN", note: `${subject}\n\n${body}`.trim() });

    const hot = HOT_STATUSES.has(contact.status);
    if (hot) {
      this.notifications.create(
        {
          type: "COMMERCIAL_ATTENTION_REQUIRED",
          severity: "warning",
          title: `Réponse de ${contact.name} (${contact.status})`,
          message: `${contact.name} a répondu par e-mail alors que son dossier est au statut "${contact.status}" : ${subject}`,
        },
        `commercial-attention:${contact.id}:${r.task_id}`,
      );
    }

    const result = buildBureauResult({
      office: "commercial_office",
      workspaceId: scopedId(workspaceId),
      action: "INGEST_EMAIL",
      mission: r.objective,
      summary: created ? `Nouveau prospect créé depuis un e-mail entrant : ${contact.name}` : `E-mail entrant rattaché à ${contact.name} (${contact.status})`,
      result: { contact, created },
      recommendations: hot ? ["Ce contact est en phase avancée : traiter en priorité."] : [],
      nextSteps: ["Qualifier/relancer selon le contenu du message"],
      taskId: r.task_id,
    });
    return completedEvent(r, "commercial_office", { ...result });
  }

  /** automations.crmTriggers : événement CRM externe ou interne, idempotence assurée en amont par le trigger HTTP. */
  private ingestCrmEvent(r: TaskRequest, workspaceId?: string): ServiceEvent[] {
    const eventType = String(r.context.eventType ?? "");
    const data = (r.context.data && typeof r.context.data === "object" ? r.context.data : {}) as Record<string, unknown>;
    let summary: string;
    let payload: Record<string, unknown>;

    switch (eventType) {
      case "NEW_LEAD": {
        const contact = this.store.createContact(workspaceId, {
          kind: "PROSPECT",
          name: String(data.name ?? "Lead CRM").trim(),
          email: typeof data.email === "string" ? data.email : undefined,
          company: typeof data.company === "string" ? data.company : undefined,
        });
        summary = `Nouveau lead CRM créé : ${contact.name}`;
        payload = { contact };
        break;
      }
      case "STATUS_CHANGE": {
        const contact = this.store.updateContactStatus(workspaceId, String(data.contactId ?? ""), String(data.status ?? "") as ContactStatus);
        summary = `Statut CRM mis à jour pour ${contact.name} : ${contact.status}`;
        payload = { contact };
        break;
      }
      case "OPPORTUNITY_WON":
      case "OPPORTUNITY_LOST": {
        const status: ContactStatus = eventType === "OPPORTUNITY_WON" ? "won" : "lost";
        const opportunity = this.store.updateOpportunityStatus(workspaceId, String(data.opportunityId ?? ""), status);
        summary = `Opportunité "${opportunity.title}" -> ${status}`;
        payload = { opportunity };
        break;
      }
      case "INTERACTION": {
        const interaction = this.store.logInteraction(workspaceId, {
          contactId: String(data.contactId ?? ""),
          type: String(data.type ?? "CRM_EVENT"),
          note: typeof data.note === "string" ? data.note : undefined,
        });
        summary = `Interaction CRM enregistrée (${interaction.type})`;
        payload = { interaction };
        break;
      }
      default:
        throw new Error(`COMMERCIAL_OFFICE_CRM_EVENT_TYPE_INVALID: ${eventType}`);
    }

    const result = buildBureauResult({
      office: "commercial_office",
      workspaceId: scopedId(workspaceId),
      action: "INGEST_CRM_EVENT",
      mission: r.objective,
      summary,
      result: payload,
      taskId: r.task_id,
    });
    return completedEvent(r, "commercial_office", { ...result });
  }

  /** commercial_office_send (permission SEND) : action réelle externe, jamais confondue avec PREPARE_MESSAGE. */
  private async sendMessage(r: TaskRequest, workspaceId?: string): Promise<ServiceEvent[]> {
    const contactId = String(r.context.contactId ?? "");
    const contact = this.store.getContact(workspaceId, contactId);
    if (!contact) throw new Error("COMMERCIAL_OFFICE_CONTACT_NOT_FOUND");
    if (!contact.email) throw new Error("COMMERCIAL_OFFICE_CONTACT_EMAIL_MISSING");
    const subject = String(r.context.subject ?? "").trim();
    const text = String(r.context.text ?? "").trim();
    if (!subject || !text) throw new Error("COMMERCIAL_OFFICE_SEND_CONTENT_REQUIRED");

    const sendResult = await this.emailProvider.send({ to: contact.email, subject, text });
    if (!sendResult.ok) throw new Error(`COMMERCIAL_OFFICE_SEND_FAILED: ${sendResult.error}`);

    this.store.logInteraction(workspaceId, { contactId, type: "EMAIL_OUT", note: `${subject}\n\n${text}` });
    const result = buildBureauResult({
      office: "commercial_office",
      workspaceId: scopedId(workspaceId),
      action: "SEND_MESSAGE",
      mission: r.objective,
      summary: `E-mail envoyé à ${contact.name} (${contact.email}).`,
      result: { contactId, emailId: sendResult.id },
      taskId: r.task_id,
    });
    return completedEvent(r, "commercial_office", { ...result });
  }
}

export { CONTACT_STATUSES };
