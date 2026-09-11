export type InteractionMode = "CONVERSATIONNEL" | "OPERATIONNEL";
export type GravityLevel = "ROUTINE" | "ELEVEE" | "CRITIQUE";
export type CertaintyLevel = "CONFIRMED" | "INFERRED" | "HYPOTHESIS" | "UNKNOWN" | "VERIFICATION_REQUIRED";
export type EventProtocol = "NONE" | "JARVIS_ERROR" | "POST_DISAGREEMENT" | "POST_SUCCESS" | "WARNING";

export interface PersonalityTurnContext {
  explicitMode?: InteractionMode;
  explicitGravity?: GravityLevel;
  explicitCertainty?: CertaintyLevel;
  criticalDirectAttention?: boolean;
  escalatedWarning?: boolean;
  userOpenedPersonalRegister?: boolean;
  importantAcknowledgement?: boolean;
  strongContradiction?: boolean;
  elevatedWarning?: boolean;
  importantOperationConclusion?: boolean;
  naturalButlerShortReply?: boolean;
  lastEvent?: EventProtocol;
}

export interface PersonalityTurnPolicy {
  mode: InteractionMode;
  gravity: GravityLevel;
  certainty: CertaintyLevel;
  allowMonsieur: boolean;
  allowWilliam: boolean;
  allowHumor: boolean;
  eventProtocol: EventProtocol;
}

export interface JarvisPersonalityState {
  conversationId: string;
  monsieurCooldownRemaining: number;
  updatedAt: number;
}

export interface PersonalityValidationResult {
  isValid: boolean;
  text: string;
  violations: string[];
  usedMonsieurVocative: boolean;
  usedWilliamVocative: boolean;
}
