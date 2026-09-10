/**
 * Format commun aux quatre skills de bureaux métier (Chantier 9) : traduit le résultat
 * structuré de ServiceOrchestrator.dispatchCapability (voir services/bureauContract.ts)
 * en texte lisible pour l'utilisateur/Jarvis, sans jamais exposer de structure JSON brute
 * dans la réponse finale (voir Agent.buildInstructions : "ne rédiges jamais de JSON").
 */
export function formatBureauResult(label: string, orchResult: { status: string; taskId: string; selectedService: string; result?: string; error?: string }): string {
  if (orchResult.status === "COMPLETED") {
    let payload: Record<string, unknown> = {};
    if (orchResult.result) {
      try {
        payload = JSON.parse(orchResult.result);
      } catch {
        // Non-JSON : conservé tel quel dans le résumé ci-dessous.
      }
    }
    const summary = typeof payload.summary === "string" ? payload.summary : "Mission terminée.";
    const lines = [`[${label}] ${summary}`, `task_id: ${orchResult.taskId}`];
    const recommendations = Array.isArray(payload.recommendations) ? payload.recommendations.filter((x) => typeof x === "string") : [];
    const nextSteps = Array.isArray(payload.nextSteps) ? payload.nextSteps.filter((x) => typeof x === "string") : [];
    const proposedActions = Array.isArray(payload.proposedActions) ? payload.proposedActions.filter((x) => typeof x === "string") : [];
    if (recommendations.length) lines.push(`Recommandations : ${recommendations.join(" ; ")}`);
    if (proposedActions.length) lines.push(`Actions proposées : ${proposedActions.join(" ; ")}`);
    if (nextSteps.length) lines.push(`Prochaines étapes : ${nextSteps.join(" ; ")}`);
    if (payload.result !== undefined) lines.push(`Détails (JSON) : ${JSON.stringify(payload.result)}`);
    return lines.join("\n");
  }
  if (orchResult.status === "WAITING_PERMISSION") {
    return `[${label}] Action soumise à approbation avant exécution (task_id: ${orchResult.taskId}) : ${orchResult.result ?? "permission requise"}.`;
  }
  if (orchResult.status === "REJECTED") {
    return `[${label}] Rejeté : ${orchResult.error ?? "raison inconnue"}.`;
  }
  return `[${label}] Échec (statut ${orchResult.status}) : ${orchResult.error ?? "erreur inconnue"}.`;
}

export function extractBureauContext(input: Record<string, unknown>): { workspaceId?: string; objective: string; context: Record<string, unknown> } {
  const workspaceId = typeof input.workspaceId === "string" && input.workspaceId.trim() ? input.workspaceId.trim() : undefined;
  const objective = typeof input.objective === "string" && input.objective.trim() ? input.objective.trim() : `Mission (${String(input.action ?? "défaut")})`;
  const context: Record<string, unknown> = { ...input };
  delete context.objective;
  delete context.workspaceId;
  return { workspaceId, objective, context };
}
