import type { LLMProvider } from "../llm/provider.js";
import type { ChatMessage } from "../types.js";

export interface Role {
  name: string;
  systemPrompt: string;
}

export interface RoleOutput {
  role: string;
  content: string;
}

/**
 * Brique 6 (optionnelle) : au-delà d'une certaine complexité, un seul point
 * de vue ne suffit plus. Chaque rôle reçoit le même transcript partagé (canal
 * commun) et y ajoute sa contribution — façon MetaGPT/AutoGen, mais minimal :
 * un tour = chaque rôle parle une fois, dans l'ordre, en voyant ce que les
 * précédents ont dit.
 */
export class RoleOrchestrator {
  constructor(private readonly llm: LLMProvider, private readonly roles: Role[]) {}

  async runRound(task: string): Promise<RoleOutput[]> {
    const transcript: ChatMessage[] = [{ role: "user", content: task }];
    const outputs: RoleOutput[] = [];

    for (const role of this.roles) {
      const messages: ChatMessage[] = [{ role: "system", content: role.systemPrompt }, ...transcript];
      const response = await this.llm.complete(messages);
      outputs.push({ role: role.name, content: response });
      transcript.push({ role: "assistant", content: `[${role.name}] ${response}` });
    }

    return outputs;
  }
}
