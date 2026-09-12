import { randomUUID } from "node:crypto";
import type { Agent } from "../../core/agent.js";
import { PersonalityPolicyEngine } from "../../personality/personalityPolicyEngine.js";
import type { PersonalityTurnContext, PersonalityTurnPolicy } from "../../personality/domain/types.js";
import { loadCheckpoint } from "../checkpoint.js";
import type { IConversationRepository } from "./conversationRepository.js";
import { ConversationCoordinator } from "./conversationCoordinator.js";
import { computeRequestFingerprint, normalizeConversationMessage } from "./fingerprint.js";
import type {
  AgentExecutionContext,
  CompletedTurnPayload,
  ConversationPage,
  ConversationSession,
  StoredConversationMessage,
  TurnExecutionResult,
  TurnIngressDto,
} from "./types.js";

export class ConversationExecutionError extends Error {
  constructor(public readonly code: string, public readonly httpStatus: number, message = code) {
    super(message);
  }
}

export class ConversationExecutionService {
  constructor(
    readonly repository: IConversationRepository,
    readonly coordinator: ConversationCoordinator,
    readonly agent: Agent,
    readonly personalityPolicyEngine?: PersonalityPolicyEngine,
  ) {
    this.agent.memory.attachActivityProbe(coordinator);
  }

  async createSession(workspaceId: string | null = null): Promise<ConversationSession> {
    return this.repository.initializeSession(randomUUID(), workspaceId);
  }

  async getSession(conversationId: string): Promise<ConversationSession | null> {
    return this.repository.getSession(conversationId);
  }

  async listSessions(workspaceId: string | null): Promise<ConversationSession[]> {
    return this.repository.listSessions(workspaceId);
  }

  async getMessages(conversationId: string, limit = 30, beforeSequence?: number): Promise<ConversationPage> {
    if (!(await this.repository.getSession(conversationId))) throw new ConversationExecutionError("SESSION_NOT_FOUND", 404);
    return this.repository.getMessagesPage(conversationId, limit, beforeSequence);
  }

  async handleTurn(dto: TurnIngressDto): Promise<TurnExecutionResult> {
    const session = await this.repository.getSession(dto.conversationId);
    if (!session) throw new ConversationExecutionError("SESSION_NOT_FOUND", 404);

    let fingerprint: string;
    let normalizedDto: TurnIngressDto;
    if (dto.requestKind === "MESSAGE") {
      const sentWorkspace = dto.payload.workspaceId?.trim() || undefined;
      if (sentWorkspace !== undefined && sentWorkspace !== (session.workspaceId ?? undefined)) {
        throw new ConversationExecutionError("CONVERSATION_WORKSPACE_MISMATCH", 409);
      }
      const message = normalizeConversationMessage(dto.payload.message);
      if (!message) throw new ConversationExecutionError("MESSAGE_REQUIRED", 400);
      normalizedDto = {
        requestKind: "MESSAGE",
        conversationId: dto.conversationId,
        clientRequestId: dto.clientRequestId,
        voiceCommandId: dto.voiceCommandId,
        ...(dto.personalityContext ? { personalityContext: dto.personalityContext } : {}),
        payload: { message, ...(session.workspaceId ? { workspaceId: session.workspaceId } : {}) },
      };
      fingerprint = computeRequestFingerprint("MESSAGE", {
        message,
        workspaceId: session.workspaceId,
        personalityContext: dto.personalityContext ?? null,
      });
    } else {
      const targetMessageId = dto.payload.targetMessageId.trim();
      if (!targetMessageId) throw new ConversationExecutionError("TARGET_MESSAGE_NOT_FOUND", 404);
      normalizedDto = {
        requestKind: "REGENERATE",
        conversationId: dto.conversationId,
        clientRequestId: dto.clientRequestId,
        ...(dto.personalityContext ? { personalityContext: dto.personalityContext } : {}),
        payload: { targetMessageId },
      };
      fingerprint = computeRequestFingerprint("REGENERATE", {
        targetMessageId,
        personalityContext: dto.personalityContext ?? null,
      });
    }

    const accepted = await this.repository.acceptTurnIdempotently({
      turnId: randomUUID(),
      conversationId: session.conversationId,
      clientRequestId: normalizedDto.clientRequestId?.trim() || null,
      voiceCommandId: normalizedDto.requestKind === "MESSAGE" ? normalizedDto.voiceCommandId?.trim() || null : null,
      requestKind: normalizedDto.requestKind,
      requestFingerprint: fingerprint,
    });

    if (accepted.kind === "MISMATCH") {
      throw new ConversationExecutionError("IDEMPOTENCY_KEY_REUSE_MISMATCH", 409);
    }
    if (accepted.kind === "EXISTING") {
      if (accepted.turn.status === "ACCEPTED" || accepted.turn.status === "RUNNING") {
        return { result: "EXISTING_PROCESSING", turnId: accepted.turn.turnId, conversationId: session.conversationId };
      }
      if (accepted.turn.status === "FAILED") {
        return {
          result: "EXISTING_FAILED",
          turnId: accepted.turn.turnId,
          conversationId: session.conversationId,
          failureReason: accepted.turn.failureReason || "UNKNOWN_FAILURE",
        };
      }
      const completed = await this.repository.getCompletedTurnResult(accepted.turn.turnId);
      if (!completed) throw new ConversationExecutionError("COMPLETED_TURN_RESULT_MISSING", 500);
      return {
        result: "EXISTING_COMPLETED",
        turnId: accepted.turn.turnId,
        conversationId: session.conversationId,
        ...completed,
      };
    }

    const turn = accepted.turn;
    return this.coordinator.execute(session.conversationId, async () => {
      const working = await this.agent.memory.getOrLoadSession(session.conversationId, this.repository, session.workspaceId ?? undefined);
      working.pin();
      let dropRehydratedRegenerationWindow = false;
      try {
        await this.repository.markTurnRunning(turn.turnId);
        const personalityPolicy = await this.preparePersonalityPolicy(
          session.conversationId,
          normalizedDto.personalityContext,
        );
        const context: AgentExecutionContext = {
          conversationId: session.conversationId,
          turnId: turn.turnId,
          ...(session.workspaceId ? { workspaceId: session.workspaceId } : {}),
          ...(personalityPolicy ? { personalityPolicy } : {}),
        };

        if (normalizedDto.requestKind === "MESSAGE") {
          const storedUser = await this.repository.appendMessage(
            session.conversationId,
            turn.turnId,
            { role: "user", content: normalizedDto.payload.message },
            randomUUID(),
          );
          await this.agent.memory.addStoredMessage(storedUser, context.workspaceId);

          // clientRequestId sert de traceId de corrélation (voir Agent.step / B.2 des
          // directives de correction) : sans lui, les opérations dispatchées pendant ce tour
          // héritaient d'un traceId auto-généré que la timeline live de www/app.js ne peut
          // jamais retrouver, puisque le client ne le connaît qu'après la fin du tour.
          const result = await this.agent.step(normalizedDto.payload.message, context, normalizedDto.clientRequestId ?? undefined);
          const completedPayload: CompletedTurnPayload = {
            response: result.response,
            iterations: result.iterations,
            ...(result.pendingAction ? { pendingAction: result.pendingAction } : {}),
          };
          const storedFinal = await this.repository.appendFinalMessageAndCompleteTurn(
            session.conversationId,
            turn.turnId,
            { role: "assistant", content: result.response },
            randomUUID(),
            completedPayload,
          );
          await this.agent.memory.addStoredMessage(storedFinal, context.workspaceId);
          await this.commitPersonalityBestEffort(session.conversationId, result.response, personalityPolicy);
          try {
            await this.agent.reflectAfterDurableTurn(context);
          } catch (reflectionError) {
            console.warn("[Conversation] Post-turn reflection failed:", (reflectionError as Error).message);
          }
          return {
            result: "NEW" as const,
            turnId: turn.turnId,
            conversationId: session.conversationId,
            ...completedPayload,
          };
        }

        const target = await this.repository.getMessage(normalizedDto.payload.targetMessageId);
        if (!target) throw new ConversationExecutionError("TARGET_MESSAGE_NOT_FOUND", 404);
        if (
          target.conversationId !== session.conversationId ||
          target.status !== "ACTIVE" ||
          target.message.role !== "assistant" ||
          (target.message.toolCalls?.length ?? 0) > 0
        ) {
          throw new ConversationExecutionError("TARGET_MESSAGE_NOT_REGENERABLE", 409);
        }

        // The durable target may be older than the hot WorkingMemory window. Rehydrate a
        // bounded ACTIVE history ending at the exact target so regeneration remains
        // targetMessageId-driven even for long conversations.
        if (!working.getEntryByMessageId(target.messageId)) {
          const historicalWindow = await this.repository.getMessagesPage(
            session.conversationId,
            30,
            target.sequence + 1,
          );
          if (!historicalWindow.items.some((item) => item.messageId === target.messageId)) {
            throw new ConversationExecutionError("TARGET_MESSAGE_NOT_FOUND", 404);
          }
          working.restoreStoredMessages(historicalWindow.items, context.workspaceId);
          dropRehydratedRegenerationWindow = true;
        }

        const regenerated = await this.agent.regenerateLastResponse(context, target.messageId);
        const completedPayload: CompletedTurnPayload = { response: regenerated.response, iterations: 1 };
        const storedRevision = await this.repository.appendRevisionAndCompleteTurn(
          session.conversationId,
          turn.turnId,
          target.messageId,
          { role: "assistant", content: regenerated.response },
          randomUUID(),
          completedPayload,
        );
        await this.agent.memory.replaceWithStoredRevision(target.messageId, storedRevision, context.workspaceId);
        // A revision replaces one ACTIVE final response. Reconcile from the authoritative
        // transcript instead of treating REGENERATE as an extra stylistic turn.
        await this.reconcilePersonalityBestEffort(session.conversationId);
        return {
          result: "NEW" as const,
          turnId: turn.turnId,
          conversationId: session.conversationId,
          ...completedPayload,
        };
      } catch (error) {
        await this.repository.failTurn(turn.turnId, error instanceof Error ? error.message : "INTERNAL_ERROR");
        throw error;
      } finally {
        working.unpin();
        if (dropRehydratedRegenerationWindow) {
          // Reload the latest durable tail on the next turn instead of leaving an old
          // target-centered window as the hot conversation context.
          this.agent.memory.dropSession(session.conversationId);
        }
        this.agent.memory.triggerPostTurnCleanup();
      }
    });
  }

  private async preparePersonalityPolicy(
    conversationId: string,
    turnContext: PersonalityTurnContext = {},
  ): Promise<PersonalityTurnPolicy | undefined> {
    if (!this.personalityPolicyEngine) return undefined;
    try {
      const recentFinals = await this.getRecentFinalAssistantMessages(conversationId, 3);
      await this.personalityPolicyEngine.reconcileFromTranscript(conversationId, recentFinals);
      return await this.personalityPolicyEngine.generatePolicy(conversationId, turnContext);
    } catch (error) {
      console.warn("[Personality] Policy preparation failed; continuing without personality state:", (error as Error).message);
      return undefined;
    }
  }

  private async getRecentFinalAssistantMessages(
    conversationId: string,
    limit: number,
  ): Promise<StoredConversationMessage[]> {
    const collected: StoredConversationMessage[] = [];
    let beforeSequence: number | undefined;

    while (collected.length < limit) {
      const page = await this.repository.getMessagesPage(conversationId, 100, beforeSequence);
      for (let index = page.items.length - 1; index >= 0 && collected.length < limit; index -= 1) {
        const item = page.items[index];
        if (
          item.message.role === "assistant"
          && !item.message.toolCalls?.length
          && typeof item.message.content === "string"
        ) {
          collected.push(item);
        }
      }
      if (page.nextBeforeSequence == null) break;
      beforeSequence = page.nextBeforeSequence;
    }

    return collected.reverse();
  }

  private async commitPersonalityBestEffort(
    conversationId: string,
    response: string,
    policy?: PersonalityTurnPolicy,
  ): Promise<void> {
    if (!this.personalityPolicyEngine || !policy) return;
    try {
      await this.personalityPolicyEngine.commitAcceptedResponse(conversationId, response, policy);
    } catch (error) {
      console.warn("[Personality] State commit failed; durable transcript remains authoritative:", (error as Error).message);
    }
  }

  private async reconcilePersonalityBestEffort(conversationId: string): Promise<void> {
    if (!this.personalityPolicyEngine) return;
    try {
      const recentFinals = await this.getRecentFinalAssistantMessages(conversationId, 3);
      await this.personalityPolicyEngine.reconcileFromTranscript(conversationId, recentFinals);
    } catch (error) {
      console.warn("[Personality] State reconciliation failed; durable transcript remains authoritative:", (error as Error).message);
    }
  }

  async restoreCheckpointBranch(checkpointId: string, workspaceId: string | null = null): Promise<string> {
    return this.coordinator.executeExclusive(async () => {
      const state = loadCheckpoint(checkpointId);
      if (!state) throw new ConversationExecutionError("CHECKPOINT_NOT_FOUND", 404);
      const session = await this.createSession(workspaceId);
      await this.repository.importHistoricalMessages(session.conversationId, state.workingMemory);
      this.agent.applyCheckpointRuntimeState(state, false);
      this.agent.memory.dropSession(session.conversationId);
      await this.agent.memory.getOrLoadSession(session.conversationId, this.repository, session.workspaceId ?? undefined);
      await this.reconcilePersonalityBestEffort(session.conversationId);
      return session.conversationId;
    });
  }
}
