import { Agent, type AgentOptions } from "./agent.js";
import type { AgentStepResult } from "../types.js";
import { AgentIngressQueue } from "../interfaces/agentIngressQueue.js";

/**
 * Runtime Agent used by interactive interfaces. Jarvis still has one Agent instance;
 * this subclass only serializes access to the mutable conversational WorkingMemory.
 */
export class QueuedAgent extends Agent {
  readonly ingressQueue = new AgentIngressQueue();

  constructor(opts: AgentOptions) {
    super(opts);
  }

  override step(userInput: string, workspaceId?: string): Promise<AgentStepResult> {
    return this.ingressQueue.run(() => super.step(userInput, workspaceId));
  }

  override regenerateLastResponse(): Promise<{ response: string }> {
    return this.ingressQueue.run(() => super.regenerateLastResponse());
  }
}
