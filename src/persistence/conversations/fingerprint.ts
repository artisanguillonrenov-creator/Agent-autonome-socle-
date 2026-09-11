import crypto from "node:crypto";
import type { ConversationRequestKind } from "./types.js";

function stable(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(stable);
  if (value && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>)
        .sort(([a], [b]) => a.localeCompare(b))
        .map(([key, nested]) => [key, stable(nested)]),
    );
  }
  return value;
}

export function normalizeConversationMessage(message: string): string {
  return message.trim();
}

export function computeRequestFingerprint(
  requestKind: ConversationRequestKind,
  payload: Record<string, unknown>,
): string {
  const canonical = JSON.stringify(stable({ requestKind, ...payload }));
  return crypto.createHash("sha256").update(canonical).digest("hex");
}
