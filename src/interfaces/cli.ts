import { randomUUID } from "node:crypto";
import { createInterface } from "node:readline/promises";
import { stdin, stdout } from "node:process";
import type { Agent } from "../core/agent.js";
import type { ConversationExecutionService } from "../persistence/conversations/conversationExecutionService.js";

const HELP = [
  "/help                      Affiche cette aide",
  "/skills                    Liste les compétences enregistrées",
  "/plan                      Affiche l'arbre de plan courant",
  "/checkpoint save <label>   Sauvegarde l'état courant",
  "/checkpoint load <id>      Restaure dans une nouvelle branche conversationnelle",
  "/checkpoint list           Liste les checkpoints",
  "/exit                      Quitte",
].join("\n");

export async function runCli(agent: Agent, conversations?: ConversationExecutionService): Promise<void> {
  const rl = createInterface({ input: stdin, output: stdout, prompt: "vous> " });
  let activeConversationId: string | undefined;
  if (conversations) activeConversationId = (await conversations.createSession(null)).conversationId;

  console.log("Socle agent autonome — /help pour les commandes, /exit pour quitter.\n");
  rl.prompt();

  for await (const line of rl) {
    const input = line.trim();
    if (!input) { rl.prompt(); continue; }
    if (input === "/exit" || input === "/quit") break;
    if (input === "/help") { console.log(HELP); rl.prompt(); continue; }

    if (input === "/skills") {
      const skills = agent.skills.list();
      console.log(skills.length ? skills.map((skill) => `- ${skill.name}: ${skill.description}`).join("\n") : "(aucune compétence enregistrée)");
      rl.prompt();
      continue;
    }

    if (input === "/plan") {
      const nodes = agent.planner.all();
      console.log(nodes.length
        ? nodes.map((node) => `[${node.status}] ${node.title} (${node.id.slice(0, 8)}${node.parentId ? ", parent " + node.parentId.slice(0, 8) : ""})`).join("\n")
        : "(aucun plan)");
      rl.prompt();
      continue;
    }

    if (input.startsWith("/checkpoint")) {
      const [, sub, ...rest] = input.split(" ");
      if (sub === "save") {
        const label = rest.join(" ") || `checkpoint-${Date.now()}`;
        console.log(`Checkpoint sauvegardé: ${agent.saveCheckpoint(label, activeConversationId)}`);
      } else if (sub === "load") {
        const id = rest[0];
        if (id && conversations) {
          try {
            activeConversationId = await conversations.restoreCheckpointBranch(id, null);
            console.log(`Checkpoint restauré dans une nouvelle conversation: ${activeConversationId}`);
          } catch {
            console.log("Checkpoint introuvable.");
          }
        } else {
          const ok = id ? agent.restoreCheckpoint(id) : false;
          console.log(ok ? "Checkpoint restauré." : "Checkpoint introuvable.");
        }
      } else if (sub === "list") {
        const list = agent.listCheckpoints();
        console.log(list.length ? list.map((checkpoint) => `${checkpoint.id}  ${checkpoint.label}  ${new Date(checkpoint.createdAt).toISOString()}`).join("\n") : "(aucun checkpoint)");
      } else {
        console.log("Usage: /checkpoint save <label> | load <id> | list");
      }
      rl.prompt();
      continue;
    }

    try {
      if (conversations && activeConversationId) {
        const result = await conversations.handleTurn({
          requestKind: "MESSAGE",
          conversationId: activeConversationId,
          clientRequestId: randomUUID(),
          payload: { message: input },
        });
        if (result.result === "EXISTING_PROCESSING") console.log("\nagent> Traitement déjà en cours.\n");
        else if (result.result === "EXISTING_FAILED") console.log(`\nagent> Échec précédent: ${result.failureReason}\n`);
        else console.log(`\nagent> ${result.response}\n`);
      } else {
        const result = await agent.step(input);
        console.log(`\nagent> ${result.response}\n`);
      }
    } catch (err) {
      console.error(`Erreur: ${(err as Error).message}`);
    }
    rl.prompt();
  }

  rl.close();
}
