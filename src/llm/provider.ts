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
  supportsNativeTools?(): boolean;
  complete(messages: ChatMessage[], options?: CompletionOptions): Promise<string | LLMCompletionResult>;
}
