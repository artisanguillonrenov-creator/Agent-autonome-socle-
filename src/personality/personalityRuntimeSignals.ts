import type { AgentPendingAction } from "../types.js";
import type { PersonalityTurnPolicy } from "./domain/types.js";

export function refinePolicyForSelectedSkills(
  policy: PersonalityTurnPolicy,
  selectedSkillCount: number,
): PersonalityTurnPolicy {
  if (selectedSkillCount <= 0) return policy;
  const certainty = policy.certainty === "UNKNOWN" ? "VERIFICATION_REQUIRED" : policy.certainty;
  return {
    ...policy,
    mode: "OPERATIONNEL",
    certainty,
    allowHumor: policy.gravity === "ROUTINE" && (certainty === "CONFIRMED" || certainty === "INFERRED"),
  };
}

export function refinePolicyAfterToolResult(
  policy: PersonalityTurnPolicy,
  result: string,
  pendingAction?: AgentPendingAction,
): PersonalityTurnPolicy {
  const successfulEvidence = !/^\s*(?:erreur|error)\s*:/i.test(result);
  const certainty = successfulEvidence && (
    policy.certainty === "UNKNOWN"
    || policy.certainty === "VERIFICATION_REQUIRED"
    || policy.certainty === "HYPOTHESIS"
  ) ? "INFERRED" : policy.certainty;

  const risk = pendingAction?.riskLevel;
  const gravity = risk === "CRITICAL"
    ? "CRITIQUE"
    : risk === "HIGH"
      ? "ELEVEE"
      : policy.gravity;

  return {
    ...policy,
    mode: "OPERATIONNEL",
    gravity,
    certainty,
    allowWilliam: policy.allowWilliam || risk === "CRITICAL",
    allowHumor: gravity === "ROUTINE" && (certainty === "CONFIRMED" || certainty === "INFERRED"),
    eventProtocol: (risk === "HIGH" || risk === "CRITICAL") ? "WARNING" : policy.eventProtocol,
  };
}
