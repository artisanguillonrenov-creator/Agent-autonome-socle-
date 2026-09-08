import type { ChatMessage } from "../types.js";

interface MessageUnit {
  messages: ChatMessage[];
}

/**
 * Selects the most recent messages without ever splitting a native tool-calling
 * exchange. Invalid tool blocks and orphan tool results are omitted entirely.
 */
export function selectRecentMessages(history: ChatMessage[], limit: number): ChatMessage[] {
  if (limit <= 0) return [];

  const units: MessageUnit[] = [];

  for (let index = 0; index < history.length; ) {
    const message = history[index];

    if (message.role === "tool") {
      // A tool result is valid only as part of the immediately preceding block.
      index += 1;
      continue;
    }

    if (message.role !== "assistant" || !message.toolCalls?.length) {
      units.push({ messages: [message] });
      index += 1;
      continue;
    }

    const toolMessages: ChatMessage[] = [];
    let nextIndex = index + 1;
    while (nextIndex < history.length && history[nextIndex].role === "tool") {
      toolMessages.push(history[nextIndex]);
      nextIndex += 1;
    }

    const declaredIds = message.toolCalls.map((toolCall) => toolCall.id);
    const declaredIdSet = new Set(declaredIds);
    const resultIds = toolMessages.map((toolMessage) => toolMessage.toolCallId);
    const resultIdSet = new Set(resultIds);

    const validBlock =
      declaredIds.every((id) => id.length > 0) &&
      declaredIdSet.size === declaredIds.length &&
      resultIds.every((id): id is string => typeof id === "string" && id.length > 0) &&
      resultIdSet.size === resultIds.length &&
      resultIds.every((id) => id !== undefined && declaredIdSet.has(id)) &&
      declaredIds.every((id) => resultIdSet.has(id));

    if (validBlock) {
      units.push({ messages: [message, ...toolMessages] });
    }

    index = nextIndex;
  }

  const selected: MessageUnit[] = [];
  let selectedMessageCount = 0;

  for (let index = units.length - 1; index >= 0 && selectedMessageCount < limit; index -= 1) {
    selected.unshift(units[index]);
    selectedMessageCount += units[index].messages.length;
  }

  return selected.flatMap((unit) => unit.messages);
}
