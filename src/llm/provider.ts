import type { ChatMessage, SkillParameterSchema, ToolCall } from "../types.js";

export interface ToolDefinition {
  type: "function";
  function: {
    name: string;
    description: string;
    parameters?: SkillParameterSchema;
  };
}

export interface CompletionOptions {
  maxTokens?: number;
  temperature?: number;
  /** Nucleus sampling (0..1). Transmis uniquement aux providers qui le supportent. */
  topP?: number;
  stopSequences?: string[];
  tools?: ToolDefinition[];
  toolChoice?: string | Record<string, unknown>;
}

export interface LLMCompletionResult {
  content: string | null;
  toolCalls?: ToolCall[];
}

/**
 * Interface agnostique : chaque fournisseur (Anthropic, OpenAI, Ollama, mock...)
 * transforme ChatMessage[] en texte ou en structure native avec toolCalls.
 */
export interface LLMProvider {
  readonly name: string;
  /** Identifiant du modèle actif, quand connu — utilisé pour résoudre la fenêtre de contexte réelle. */
  readonly model?: string;
  supportsNativeTools?(): boolean;
  complete(messages: ChatMessage[], options?: CompletionOptions): Promise<LLMCompletionResult>;
}
