import type { AgentPendingAction, ChatMessage, ChatRole, ToolCall } from "../../types.js";

export type ConversationStatus = "ACTIVE" | "ARCHIVED";
export type ConversationRequestKind = "MESSAGE" | "REGENERATE";
export type ConversationTurnStatus = "ACCEPTED" | "RUNNING" | "COMPLETED" | "FAILED";
export type ConversationMessageStatus = "ACTIVE" | "SUPERSEDED";

export interface ConversationSession {
  conversationId: string;
  workspaceId: string | null;
  title: string;
  status: ConversationStatus;
  lastMessageSequence: number;
  createdAt: number;
  lastInteractionAt: number;
}

export interface ConversationTurn {
  turnId: string;
  conversationId: string;
  clientRequestId: string | null;
  voiceCommandId: string | null;
  requestKind: ConversationRequestKind;
  status: ConversationTurnStatus;
  requestFingerprint: string;
  failureReason: string | null;
  createdAt: number;
  startedAt: number | null;
  completedAt: number | null;
}

export interface ConversationMessageInput {
  role: ChatRole;
  content: string | null;
  name?: string;
  toolCallId?: string;
  toolCalls?: ToolCall[];
}

export interface StoredConversationMessage {
  messageId: string;
  conversationId: string;
  turnId: string | null;
  sequence: number;
  status: ConversationMessageStatus;
  revisionOfId: string | null;
  createdAt: number;
  message: ChatMessage;
}

export interface ConversationPage {
  items: StoredConversationMessage[];
  nextBeforeSequence: number | null;
}

export interface AgentExecutionContext {
  conversationId: string;
  turnId: string;
  workspaceId?: string;
}

export type TurnIngressDto =
  | {
      requestKind: "MESSAGE";
      conversationId: string;
      clientRequestId?: string;
      voiceCommandId?: string;
      payload: { message: string; workspaceId?: string };
    }
  | {
      requestKind: "REGENERATE";
      conversationId: string;
      clientRequestId?: string;
      payload: { targetMessageId: string };
    };

export interface AcceptedTurnInput {
  turnId: string;
  conversationId: string;
  clientRequestId: string | null;
  voiceCommandId: string | null;
  requestKind: ConversationRequestKind;
  requestFingerprint: string;
}

export type TurnAcceptance =
  | { kind: "NEW"; turn: ConversationTurn }
  | { kind: "EXISTING"; turn: ConversationTurn }
  | { kind: "MISMATCH"; turn: ConversationTurn };

export type TurnExecutionResult =
  | {
      result: "NEW";
      turnId: string;
      conversationId: string;
      response: string;
      iterations: number;
      pendingAction?: AgentPendingAction;
    }
  | { result: "EXISTING_PROCESSING"; turnId: string; conversationId: string }
  | {
      result: "EXISTING_COMPLETED";
      turnId: string;
      conversationId: string;
      response: string;
      iterations: number;
      pendingAction?: AgentPendingAction;
    }
  | { result: "EXISTING_FAILED"; turnId: string; conversationId: string; failureReason: string };

export interface CompletedTurnPayload {
  response: string;
  iterations: number;
  pendingAction?: AgentPendingAction;
}
