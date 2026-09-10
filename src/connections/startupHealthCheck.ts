import type { ServiceOrchestrator } from "../orchestration/serviceOrchestrator.js";
import { ActivityStore } from "../observability/activityStore.js";

export interface StartupHealthCheckResult {
  serviceId: string;
  reachable: boolean;
  status: number;
  latencyMs: number;
}

/**
 * Chantier 8 (connections.autoTestOnStartup) : health-check réel de tous les services
 * activés au démarrage, réutilisant exactement le même mécanisme que le bouton
 * "Tester toutes les connexions" (POST /api/connections/test-all) — une seule
 * implémentation du health check, appliquée aux deux points d'entrée.
 */
export async function runStartupHealthChecks(orchestrator: ServiceOrchestrator): Promise<StartupHealthCheckResult[]> {
  const services = orchestrator.registry.listServices().filter((s) => s.enabled);
  const results = await Promise.all(
    services.map(async (s) => {
      const healthRes = await orchestrator.adapter.checkHealth(s);
      orchestrator.registry.connectionStore.recordDiagnostic(s.id, healthRes);
      return healthRes;
    }),
  );

  const unreachable = results.filter((r) => !r.reachable);
  try {
    new ActivityStore().append({
      eventType: "HEALTH_CHECK_COMPLETED",
      level: unreachable.length > 0 ? "warning" : "info",
      message:
        unreachable.length > 0
          ? `Health check démarrage : ${unreachable.length}/${results.length} service(s) injoignable(s)`
          : `Health check démarrage : ${results.length} service(s) OK`,
      metadata: { serviceIds: results.map((r) => r.serviceId), unreachableServiceIds: unreachable.map((r) => r.serviceId) },
    });
  } catch {
    // Best-effort : ne jamais bloquer le démarrage sur un souci de journalisation.
  }

  return results.map((r) => ({ serviceId: r.serviceId, reachable: r.reachable, status: r.status, latencyMs: r.latencyMs }));
}
