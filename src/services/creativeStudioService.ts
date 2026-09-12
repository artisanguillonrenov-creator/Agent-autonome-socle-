import type { TaskRequest, ServiceEvent } from "../orchestration/contract.js";
import { CreativeStudioStore, type CreativeDecisionStatus, type VisualIdentity } from "./creativeStudioStore.js";
import { buildBureauResult, completedEvent, failedEvent, officeLlm, parseJsonObject, asStringArray } from "./bureauContract.js";
import type { ChatMessage } from "../types.js";
import type { LLMProvider } from "../llm/provider.js";
import type { ModelRole } from "../llm/modelRouter.js";

const IDENTITY_SYSTEM_PROMPT = [
  "Tu es le Creative Studio de Jarvis : la direction artistique complète d'un projet (identité visuelle, design d'application, UX/UI visuelle, assets), pas seulement de la rédaction publicitaire.",
  'Réponds UNIQUEMENT avec un objet JSON strict de la forme : {"palette":string[],"typography":string,"styleKeywords":string[],"mood":string,"iconography":string,"principles":string[],"references":string[],"assets":string[]}',
].join(" ");

function toIdentityInput(parsed: Record<string, unknown>): Omit<VisualIdentity, "id" | "createdAt"> {
  return {
    palette: asStringArray(parsed.palette),
    typography: String(parsed.typography ?? ""),
    styleKeywords: asStringArray(parsed.styleKeywords),
    mood: String(parsed.mood ?? ""),
    iconography: String(parsed.iconography ?? ""),
    principles: asStringArray(parsed.principles),
    references: asStringArray(parsed.references),
    assets: asStringArray(parsed.assets),
  };
}

function identitySummary(identity: VisualIdentity): string {
  return `Palette: ${identity.palette.join(", ") || "n/a"} | Typo: ${identity.typography || "n/a"} | Style: ${identity.styleKeywords.join(", ") || "n/a"} | Mood: ${identity.mood || "n/a"}`;
}

export class CreativeStudioService {
  constructor(
    private readonly store = new CreativeStudioStore(),
    private readonly llm: (role?: ModelRole) => LLMProvider = (role) => officeLlm("creative_studio", role),
  ) {}

  async handleTaskRequest(r: TaskRequest): Promise<ServiceEvent[]> {
    const action = String(r.context.action ?? "GET_IDENTITY");
    const workspaceId = typeof (r.context.workspace as any)?.id === "string" ? (r.context.workspace as any).id : undefined;
    try {
      switch (action) {
        case "DEFINE_IDENTITY":
          return await this.defineIdentity(r, workspaceId);
        case "GET_IDENTITY":
          return this.getIdentity(r, workspaceId);
        case "PROPOSE_SCREEN_CONCEPT":
          return await this.proposeScreenConcept(r, workspaceId);
        case "RECORD_DECISION":
          return this.recordDecision(r, workspaceId);
        case "REQUEST_ASSET_BRIEF":
          return await this.requestAssetBrief(r, workspaceId);
        default:
          throw new Error(`CREATIVE_STUDIO_ACTION_INVALID: ${action}`);
      }
    } catch (e) {
      return failedEvent(r, "creative_studio", (e as Error).message, true);
    }
  }

  private async defineIdentity(r: TaskRequest, workspaceId?: string): Promise<ServiceEvent[]> {
    const brief = String(r.context.brief ?? r.objective ?? "").trim();
    if (!brief) throw new Error("CREATIVE_STUDIO_BRIEF_REQUIRED");
    const existing = this.store.getState(workspaceId).identity;
    const messages: ChatMessage[] = [
      { role: "system", content: IDENTITY_SYSTEM_PROMPT },
      {
        role: "user",
        content: [
          `Brief : ${brief}`,
          existing
            ? `Direction artistique actuelle à faire évoluer volontairement (ne pas dériver au hasard, seulement si le brief le demande explicitement) : ${identitySummary(existing)}`
            : "Aucune direction artistique existante pour ce projet : propose une identité initiale cohérente.",
        ].join("\n\n"),
      },
    ];
    const raw = await this.llm().complete(messages, { temperature: 0.6 });
    const identity = this.store.setIdentity(workspaceId, toIdentityInput(parseJsonObject(raw.content ?? "")), brief);

    const result = buildBureauResult({
      office: "creative_studio",
      workspaceId: workspaceId ?? "__global__",
      action: "DEFINE_IDENTITY",
      mission: r.objective,
      summary: `Direction artistique ${existing ? "mise à jour" : "définie"} : ${identitySummary(identity)}`,
      result: { identity },
      nextSteps: ["Générer les assets nécessaires via Jarvis -> media_generation", "Valider l'identité avec l'utilisateur"],
      taskId: r.task_id,
    });
    return completedEvent(r, "creative_studio", { ...result });
  }

  private getIdentity(r: TaskRequest, workspaceId?: string): ServiceEvent[] {
    const state = this.store.getState(workspaceId);
    const result = buildBureauResult({
      office: "creative_studio",
      workspaceId: workspaceId ?? "__global__",
      action: "GET_IDENTITY",
      mission: r.objective,
      summary: state.identity ? identitySummary(state.identity) : "Aucune direction artistique définie pour ce projet.",
      result: { identity: state.identity, decisions: state.decisions },
      taskId: r.task_id,
    });
    return completedEvent(r, "creative_studio", { ...result });
  }

  private async proposeScreenConcept(r: TaskRequest, workspaceId?: string): Promise<ServiceEvent[]> {
    const screenDescription = String(r.context.screenDescription ?? r.objective ?? "").trim();
    if (!screenDescription) throw new Error("CREATIVE_STUDIO_SCREEN_DESCRIPTION_REQUIRED");
    const identity = this.store.getState(workspaceId).identity;

    if (!identity) {
      const result = buildBureauResult({
        office: "creative_studio",
        workspaceId: workspaceId ?? "__global__",
        action: "PROPOSE_SCREEN_CONCEPT",
        mission: r.objective,
        summary: "Aucune direction artistique n'est encore définie pour ce projet.",
        result: { concept: null },
        recommendations: ["Définir d'abord une identité visuelle via DEFINE_IDENTITY avant de concevoir un écran."],
        taskId: r.task_id,
      });
      return completedEvent(r, "creative_studio", { ...result });
    }

    const messages: ChatMessage[] = [
      {
        role: "system",
        content:
          "Tu es le Creative Studio de Jarvis. Conçois un concept d'écran/application en respectant STRICTEMENT la direction artistique déjà validée du projet (palette, typographie, style, mood, principes) : continuité obligatoire, jamais de dérive aléatoire. Réponds en 4 à 8 phrases décrivant la composition visuelle, la hiérarchie, les couleurs et éléments graphiques utilisés.",
      },
      {
        role: "user",
        content: `Direction artistique validée : ${identitySummary(identity)} | Principes: ${identity.principles.join(", ")}\n\nÉcran à concevoir : ${screenDescription}`,
      },
    ];
    const raw = await this.llm().complete(messages, { temperature: 0.5 });
    const concept = (raw.content ?? "").trim();

    const result = buildBureauResult({
      office: "creative_studio",
      workspaceId: workspaceId ?? "__global__",
      action: "PROPOSE_SCREEN_CONCEPT",
      mission: r.objective,
      summary: `Concept d'écran proposé, cohérent avec la direction artistique du projet.`,
      result: { concept, identityUsed: identity.id },
      nextSteps: ["Transmettre ce concept à media_generation via Jarvis pour produire les visuels"],
      taskId: r.task_id,
    });
    return completedEvent(r, "creative_studio", { ...result });
  }

  private recordDecision(r: TaskRequest, workspaceId?: string): ServiceEvent[] {
    const description = String(r.context.decision ?? "").trim();
    if (!description) throw new Error("CREATIVE_STUDIO_DECISION_REQUIRED");
    const statusRaw = String(r.context.status ?? "ACCEPTED");
    const status: CreativeDecisionStatus = ["ACCEPTED", "REJECTED", "REPLACED"].includes(statusRaw) ? (statusRaw as CreativeDecisionStatus) : "ACCEPTED";
    const note = typeof r.context.note === "string" ? r.context.note : undefined;
    const decision = this.store.addDecision(workspaceId, status, description, note);
    const result = buildBureauResult({
      office: "creative_studio",
      workspaceId: workspaceId ?? "__global__",
      action: "RECORD_DECISION",
      mission: r.objective,
      summary: `Décision artistique enregistrée (${status}) : ${description}`,
      result: { decision },
      taskId: r.task_id,
    });
    return completedEvent(r, "creative_studio", { ...result });
  }

  private async requestAssetBrief(r: TaskRequest, workspaceId?: string): Promise<ServiceEvent[]> {
    const assetType = String(r.context.assetType ?? "").trim();
    const description = String(r.context.description ?? r.objective ?? "").trim();
    if (!assetType || !description) throw new Error("CREATIVE_STUDIO_ASSET_BRIEF_INPUT_REQUIRED");
    const identity = this.store.getState(workspaceId).identity;

    const messages: ChatMessage[] = [
      {
        role: "system",
        content:
          "Tu es le Creative Studio de Jarvis. Rédige un brief précis et actionnable pour un moteur de génération d'images (media_generation), en respectant la direction artistique du projet si elle existe. 3 à 6 phrases, concret (sujet, composition, palette, style, ambiance).",
      },
      {
        role: "user",
        content: [
          `Type d'asset : ${assetType}`,
          `Description : ${description}`,
          identity ? `Direction artistique à respecter : ${identitySummary(identity)}` : "Aucune direction artistique existante : rester cohérent et neutre.",
        ].join("\n"),
      },
    ];
    const raw = await this.llm().complete(messages, { temperature: 0.6 });
    const brief = (raw.content ?? "").trim();

    const result = buildBureauResult({
      office: "creative_studio",
      workspaceId: workspaceId ?? "__global__",
      action: "REQUEST_ASSET_BRIEF",
      mission: r.objective,
      summary: `Brief de génération d'asset (${assetType}) prêt.`,
      result: { assetType, brief },
      nextSteps: ["Transmettre ce brief à Jarvis -> media_generation pour produire l'asset"],
      taskId: r.task_id,
    });
    return completedEvent(r, "creative_studio", { ...result });
  }
}
