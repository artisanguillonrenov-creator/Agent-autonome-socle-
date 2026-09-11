import { hasMonsieurVocative } from "./addressing.js";
import type { IPersonalityRepository } from "./domain/personalityRepository.js";
import type {
  JarvisPersonalityState,
  PersonalityTurnContext,
  PersonalityTurnPolicy,
} from "./domain/types.js";
import type { StoredConversationMessage } from "../persistence/conversations/types.js";

const DEFAULT_STATE = (conversationId: string): JarvisPersonalityState => ({
  conversationId,
  monsieurCooldownRemaining: 0,
  updatedAt: Date.now(),
});

export class PersonalityPolicyEngine {
  constructor(private readonly repository: IPersonalityRepository) {}

  async generatePolicy(
    conversationId: string,
    context: PersonalityTurnContext = {},
  ): Promise<PersonalityTurnPolicy> {
    const state = await this.repository.getState(conversationId) ?? DEFAULT_STATE(conversationId);
    const mode = context.explicitMode ?? "CONVERSATIONNEL";
    const gravity = context.explicitGravity ?? "ROUTINE";
    const certainty = context.explicitCertainty ?? "UNKNOWN";

    const allowWilliam = Boolean(
      context.criticalDirectAttention
      || context.escalatedWarning
      || context.userOpenedPersonalRegister,
    );

    const monsieurException = Boolean(
      context.importantAcknowledgement
      || context.strongContradiction
      || context.elevatedWarning
      || context.importantOperationConclusion
      || context.naturalButlerShortReply,
    );

    return {
      mode,
      gravity,
      certainty,
      allowMonsieur: state.monsieurCooldownRemaining === 0 || monsieurException,
      allowWilliam,
      allowHumor: gravity === "ROUTINE" && (certainty === "CONFIRMED" || certainty === "INFERRED"),
      eventProtocol: context.lastEvent ?? "NONE",
    };
  }

  async commitAcceptedResponse(
    conversationId: string,
    response: string,
    policy: PersonalityTurnPolicy,
  ): Promise<void> {
    const current = await this.repository.getState(conversationId) ?? DEFAULT_STATE(conversationId);
    const usedMonsieur = policy.allowMonsieur && hasMonsieurVocative(response);
    const nextCooldown = usedMonsieur
      ? 2
      : Math.max(0, current.monsieurCooldownRemaining - 1);

    await this.repository.saveState({
      conversationId,
      monsieurCooldownRemaining: nextCooldown,
      updatedAt: Date.now(),
    });
  }

  async reconcileFromTranscript(
    conversationId: string,
    messages: StoredConversationMessage[],
  ): Promise<JarvisPersonalityState> {
    const finalAssistantMessages = messages
      .filter((item) => (
        item.status === "ACTIVE"
        && item.message.role === "assistant"
        && !item.message.toolCalls?.length
        && typeof item.message.content === "string"
      ))
      .slice(-3);

    let monsieurCooldownRemaining = 0;
    for (let offset = 0; offset < finalAssistantMessages.length; offset += 1) {
      const candidate = finalAssistantMessages[finalAssistantMessages.length - 1 - offset];
      if (hasMonsieurVocative(candidate.message.content ?? "")) {
        monsieurCooldownRemaining = Math.max(0, 2 - offset);
        break;
      }
    }

    const current = await this.repository.getState(conversationId);
    if (!current || current.monsieurCooldownRemaining !== monsieurCooldownRemaining) {
      const reconciled = { conversationId, monsieurCooldownRemaining, updatedAt: Date.now() };
      await this.repository.saveState(reconciled);
      return reconciled;
    }
    return current;
  }
}
