import type { ChatMessage, ToolCall } from "../../types.js";
import type { CompletionOptions, LLMCompletionResult, LLMProvider } from "../provider.js";

interface InfermaticOptions {
  apiKey: string;
  baseUrl: string;
  model: string;
  /**
   * Active le masquage du raisonnement interne (<think>...</think>) dans `content`.
   * Par défaut désactivé (contenu brut, comportement historique) : InfermaticProvider est
   * partagé par le chat Jarvis ET par la Software Factory (génération de code), or du code
   * source légitime peut contenir un `<think>` littéral (ex. un nom de balise dans une
   * chaîne) sans jamais être fermé — le sanitizer le traiterait alors à tort comme un
   * raisonnement non terminé et tronquerait le reste du fichier généré.
   * Seul le flux conversationnel Jarvis (destiné à un utilisateur humain) doit donc passer
   * explicitement `sanitizeReasoning: true`. La Software Factory reçoit toujours la sortie
   * brute du provider et continue d'utiliser son propre cleanLLMCodeOutput().
   */
  sanitizeReasoning?: boolean;
}

const THINK_BLOCK_RE = /<think>[\s\S]*?<\/think>/gi;
const THINK_OPEN_RE = /<think>/i;
const THINK_CLOSE_RE = /<\/think>/i;

/**
 * Qwen (et d'autres modèles "reasoning") peuvent renvoyer leur raisonnement interne
 * directement dans `message.content`, encadré par des balises <think>...</think>.
 * Ce raisonnement ne doit jamais atteindre l'utilisateur final de Jarvis : cette
 * fonction ne nettoie que le flux "chat" (voir infermatic.ts) et ne doit pas être
 * réutilisée telle quelle pour la Software Factory, qui possède déjà son propre
 * nettoyage (cleanLLMCodeOutput dans softwareFactoryService.ts, couplé à l'extraction
 * de blocs de code).
 */
export function sanitizeInfermaticVisibleContent(rawContent: string | null | undefined): string | null {
  if (rawContent == null) {
    return null;
  }

  let cleaned = rawContent.replace(THINK_BLOCK_RE, "");

  // </think> résiduel sans ouverture correspondante : tout ce qui précède est
  // considéré comme du raisonnement interne, on ne garde que ce qui suit.
  const closeIdx = cleaned.search(THINK_CLOSE_RE);
  if (closeIdx !== -1) {
    cleaned = cleaned.slice(closeIdx).replace(THINK_CLOSE_RE, "");
  }

  // <think> jamais refermé : impossible de distinguer raisonnement et réponse finale,
  // on écarte tout ce qui suit l'ouverture plutôt que d'exposer du raisonnement brut.
  const openIdx = cleaned.search(THINK_OPEN_RE);
  if (openIdx !== -1) {
    cleaned = cleaned.slice(0, openIdx);
  }

  cleaned = cleaned.trim();
  return cleaned.length > 0 ? cleaned : null;
}

/**
 * Infermatic (Core API) expose une API OpenAI-compatible : https://api.totalgpt.ai/v1.
 * Le protocole de tool calling natif suit le même format que OpenRouter/OpenAI (voir
 * openrouter.ts) : seules l'URL de base et l'absence de `parallel_tool_calls` (non
 * validé côté Infermatic, donc jamais imposé) diffèrent.
 */
export class InfermaticProvider implements LLMProvider {
  readonly name = "infermatic";

  constructor(private readonly opts: InfermaticOptions) {}

  supportsNativeTools(): boolean {
    return true;
  }

  async complete(messages: ChatMessage[], options: CompletionOptions = {}): Promise<LLMCompletionResult> {
    if (!this.opts.apiKey) {
      throw new Error("INFERMATIC_API_KEY manquant : impossible d'appeler le fournisseur infermatic.");
    }

    const endpoint = `${this.opts.baseUrl.replace(/\/+$/, "")}/chat/completions`;

    const formattedMessages = messages.map((m) => {
      if (m.role === "tool") {
        return {
          role: "tool",
          tool_call_id: m.toolCallId || "call_unknown",
          name: m.name,
          content: m.content ?? "",
        };
      }

      if (m.role === "assistant") {
        const msgObj: Record<string, unknown> = {
          role: "assistant",
          content: m.content ?? null,
        };
        if (m.toolCalls && m.toolCalls.length > 0) {
          msgObj.tool_calls = m.toolCalls;
        }
        return msgObj;
      }

      return {
        role: m.role,
        content: m.content ?? "",
      };
    });

    const body: Record<string, unknown> = {
      model: this.opts.model,
      messages: formattedMessages,
      max_tokens: options.maxTokens ?? 1024,
      temperature: options.temperature,
      stop: options.stopSequences,
    };

    if (options.tools && options.tools.length > 0) {
      body.tools = options.tools;
      body.tool_choice = options.toolChoice || "auto";
    }

    const res = await fetch(endpoint, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        authorization: `Bearer ${this.opts.apiKey}`,
      },
      body: JSON.stringify(body),
    });

    if (!res.ok) {
      const rawBody = await res.text().catch(() => "");
      let detail = rawBody.slice(0, 300);
      try {
        const parsed = JSON.parse(rawBody) as { error?: { message?: string } | string };
        detail = (typeof parsed.error === "string" ? parsed.error : parsed.error?.message) || detail;
      } catch {
        // rawBody n'est pas du JSON exploitable, on garde l'extrait brut tronqué.
      }
      throw new Error(`Infermatic API ${res.status}: ${detail || "erreur inconnue"}`);
    }

    const data = (await res.json()) as {
      choices?: Array<{ message?: { content?: string | null; tool_calls?: ToolCall[] } }>;
    };
    if (!Array.isArray(data.choices) || data.choices.length === 0) {
      throw new Error("Infermatic API : réponse sans choix (modèle possiblement incompatible avec /chat/completions).");
    }

    const message = data.choices[0]?.message;
    // Certains fournisseurs OpenAI-compatibles exposent un raisonnement séparé via
    // `reasoning` / `reasoning_content` : on ne les lit jamais ici, ils ne doivent ni
    // remplacer `content` ni être renvoyés à l'utilisateur.
    const rawContent = message?.content ?? null;
    const content = this.opts.sanitizeReasoning ? sanitizeInfermaticVisibleContent(rawContent) : rawContent;
    const toolCalls = Array.isArray(message?.tool_calls) && message.tool_calls.length > 0 ? message.tool_calls : undefined;

    return { content, toolCalls };
  }
}
