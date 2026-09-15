import { EventEmitter } from "node:events";

/**
 * Vague 6C / 7B : bus d'événements process-wide, unique point d'entrée pour tout signal
 * qui doit pouvoir réveiller ou interrompre l'agent sans dépendre d'un scrutin (cron/poll)
 * strict. Remplace le modèle "l'agent ne réagit qu'à son propre tour" par un modèle
 * événementiel : n'importe quel composant (ingress vocal, watcher du Document Workbench,
 * détection de PR/commit de la Software Factory, alerte de production) peut publier ici,
 * et les abonnés (AutonomyPlanner, Agent.requestInterrupt) décident de la réaction.
 */
export type AutonomyEventType =
  | "TASK_EVENT"
  | "PRIORITY_COMMAND"
  | "WORKBENCH_DOCUMENT_CHANGED"
  | "SOFTWARE_FACTORY_PR_EVENT"
  | "VOICE_COMMAND_RECEIVED"
  /** Vague 11A : cycle de vie anormal (die/oom/kill) d'un conteneur sandbox de la Software Factory — voir autonomy/watchers.ts. */
  | "SANDBOX_CONTAINER_EVENT";

export interface AutonomyEvent {
  type: AutonomyEventType;
  source: string;
  payload: Record<string, unknown>;
  emittedAt: number;
  /** Cible optionnelle : un plan run précis à interrompre (6C), sinon portée globale. */
  planRunId?: string;
}

export type AutonomyEventListener = (event: AutonomyEvent) => void;

class AutonomyEventBus {
  private readonly emitter = new EventEmitter();
  private lastEventAt = 0;

  constructor() {
    // Potentiellement de nombreux abonnés (Agent, AutonomyPlanner, preAttentionRouter) —
    // ce n'est pas une fuite mémoire, juste plus que la limite par défaut d'EventEmitter.
    this.emitter.setMaxListeners(50);
  }

  publish(event: Omit<AutonomyEvent, "emittedAt">): void {
    const full: AutonomyEvent = { ...event, emittedAt: Date.now() };
    this.lastEventAt = full.emittedAt;
    this.emitter.emit(full.type, full);
    this.emitter.emit("*", full);
  }

  on(type: AutonomyEventType | "*", listener: AutonomyEventListener): () => void {
    this.emitter.on(type, listener);
    return () => this.emitter.off(type, listener);
  }

  /** Utilisé par le détecteur d'idle (7A/7B) : dernier changement d'état factuel connu. */
  getLastEventAt(): number {
    return this.lastEventAt;
  }
}

/** Instance unique — c'est un bus process-wide, pas un service par requête. */
export const autonomyEventBus = new AutonomyEventBus();
