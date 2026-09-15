import type { WebSocketServer, WebSocket } from "ws";
import type { IncomingMessage } from "node:http";
import type { Agent } from "../core/agent.js";
import { config } from "../config.js";
import { autonomyEventBus, type AutonomyEvent } from "../autonomy/eventBus.js";
import { financialCircuitBreaker } from "../context/financialCircuitBreaker.js";
import { ActivityStore } from "../observability/activityStore.js";
import type { WsUpgradeRouter } from "./wsRouter.js";

const SNAPSHOT_INTERVAL_MS = 3000;

/**
 * Vague 13A (panneau Activité Autonome du dashboard) : canal WebSocket en lecture seule
 * diffusant en continu l'état du disjoncteur financier, l'arbre des tâches du Planner et les
 * derniers événements d'arrière-plan, ainsi que les événements bruts du bus d'autonomie dès
 * qu'ils sont publiés (sans attendre le prochain instantané périodique).
 */
export class WsLogsChannel {
  private wss?: WebSocketServer;
  private readonly activityStore = new ActivityStore();
  private snapshotTimer?: NodeJS.Timeout;
  private unsubscribeBus?: () => void;

  constructor(private readonly agent: Agent) {}

  attach(router: WsUpgradeRouter): void {
    // Vague 13A : voir wsRouter.ts — plusieurs canaux WebSocket partagent le même http.Server,
    // ce qui exige un unique listener `upgrade` routant par pathname plutôt que des instances
    // WebSocketServer indépendantes construites avec `{ server, path }`.
    this.wss = router.register("/ws/logs");
    this.wss.on("connection", (ws, req) => this.onConnection(ws, req));

    this.unsubscribeBus = autonomyEventBus.on("*", (event) => this.broadcastEvent(event));

    this.snapshotTimer = setInterval(() => this.broadcastSnapshot(), SNAPSHOT_INTERVAL_MS);
    this.snapshotTimer.unref?.();
  }

  dispose(): void {
    if (this.snapshotTimer) clearInterval(this.snapshotTimer);
    this.unsubscribeBus?.();
    this.wss?.close();
  }

  private onConnection(ws: WebSocket, req: IncomingMessage): void {
    const url = new URL(req.url || "/", "http://localhost");
    if (config.api.token && url.searchParams.get("token") !== config.api.token) {
      ws.close(4401, "unauthorized");
      return;
    }
    this.sendSnapshot(ws);
  }

  private buildSnapshot() {
    let plans: unknown[] = [];
    try {
      plans = this.agent.planner.listRuns().slice(-20);
    } catch {
      plans = [];
    }
    let activity: unknown[] = [];
    try {
      activity = this.activityStore.list({ limit: 30 });
    } catch {
      activity = [];
    }
    let operations: unknown[] = [];
    let pendingCritical: unknown[] = [];
    try {
      operations = this.agent.serviceOrchestrator.store.listOperations();
      pendingCritical = (operations as Array<{ status: string; approvalState?: string; riskLevel?: string }>).filter(
        (op) => op.status === "WAITING_PERMISSION" && op.approvalState === "PENDING",
      );
    } catch {
      operations = [];
      pendingCritical = [];
    }

    return {
      type: "snapshot" as const,
      emittedAt: Date.now(),
      circuitBreaker: financialCircuitBreaker.status(),
      contextBudget: this.agent.getContextBudgetStatus(),
      plans,
      activity,
      pendingApprovals: pendingCritical,
    };
  }

  private sendSnapshot(ws: WebSocket): void {
    try {
      ws.send(JSON.stringify(this.buildSnapshot()));
    } catch {
      // best-effort : le client peut être déconnecté entre-temps.
    }
  }

  private broadcastSnapshot(): void {
    if (!this.wss?.clients.size) return;
    const payload = JSON.stringify(this.buildSnapshot());
    for (const client of this.wss.clients) {
      if (client.readyState === client.OPEN) {
        try {
          client.send(payload);
        } catch {
          // best-effort
        }
      }
    }
  }

  private broadcastEvent(event: AutonomyEvent): void {
    if (!this.wss?.clients.size) return;
    const payload = JSON.stringify({ type: "autonomy_event", event });
    for (const client of this.wss.clients) {
      if (client.readyState === client.OPEN) {
        try {
          client.send(payload);
        } catch {
          // best-effort
        }
      }
    }
  }
}
