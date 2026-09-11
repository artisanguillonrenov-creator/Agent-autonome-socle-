import type {
  AcceptedTurnInput,
  CompletedTurnPayload,
  ConversationMessageInput,
  ConversationPage,
  ConversationSession,
  ConversationTurn,
  StoredConversationMessage,
  TurnAcceptance,
} from "./types.js";

export interface IConversationRepository {
  initialize(): Promise<void>;
  initializeSession(conversationId: string, workspaceId: string | null): Promise<ConversationSession>;
  getSession(conversationId: string): Promise<ConversationSession | null>;
  listSessions(workspaceId: string | null): Promise<ConversationSession[]>;
  updateSessionTitle(conversationId: string, title: string): Promise<void>;
  archiveSession(conversationId: string): Promise<void>;

  acceptTurnIdempotently(input: AcceptedTurnInput): Promise<TurnAcceptance>;
  markTurnRunning(turnId: string): Promise<void>;
  failTurn(turnId: string, reason: string): Promise<void>;

  appendMessage(
    conversationId: string,
    turnId: string | null,
    message: ConversationMessageInput,
    messageId: string,
  ): Promise<StoredConversationMessage>;

  appendFinalMessageAndCompleteTurn(
    conversationId: string,
    turnId: string,
    message: ConversationMessageInput,
    messageId: string,
    completed: CompletedTurnPayload,
  ): Promise<StoredConversationMessage>;

  appendRevisionAndCompleteTurn(
    conversationId: string,
    turnId: string,
    oldMessageId: string,
    message: ConversationMessageInput,
    messageId: string,
    completed: CompletedTurnPayload,
  ): Promise<StoredConversationMessage>;

  getMessage(messageId: string): Promise<StoredConversationMessage | null>;
  getCompletedTurnResult(turnId: string): Promise<CompletedTurnPayload | null>;
  getLastActiveMessages(conversationId: string, limit: number): Promise<StoredConversationMessage[]>;
  getMessagesPage(conversationId: string, limit: number, beforeSequence?: number): Promise<ConversationPage>;
  recoverInterruptedTurns(): Promise<number>;

  importHistoricalMessages(
    conversationId: string,
    messages: ConversationMessageInput[],
  ): Promise<StoredConversationMessage[]>;
}
