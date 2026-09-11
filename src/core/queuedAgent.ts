import { Agent, type AgentOptions } from "./agent.js";
import type { AgentStepResult } from "../types.js";
import { AgentIngressQueue } from "../interfaces/agentIngressQueue.js";
import type { AgentExecutionContext } from "../persistence/conversations/types.js";

/**
 * Legacy interactive wrapper. 11A durable calls are already serialized per conversation
 * by ConversationCoordinator and therefore must not pass through this global queue.
 */
export class QueuedAgent extends Agent {
  readonly ingressQueue = new AgentIngressQueue();

  constructor(opts: AgentOptions) {
    super(opts);
  }

  override step(userInput: string, workspaceOrContext?: string | AgentExecutionContext): Promise<AgentStepResult> {
    if (typeof workspaceOrContext === "object") {
      return super.step(userInput, workspaceOrContext);
    }
    return this.ingressQueue.run(() => super.step(userInput, workspaceOrContext));
  }

  override regenerateLastResponse(context?: AgentExecutionContext, targetMessageId?: string): Promise<{ response: string }> {
    if (context) return super.regenerateLastResponse(context, targetMessageId);
    return this.ingressQueue.run(() => super.regenerateLastResponse());
  }
}
