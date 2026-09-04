import { createInterface } from "node:readline/promises";
import { stdin, stdout } from "node:process";
import type { Agent } from "../core/agent.js";

const HELP = [
  "/help                      Affiche cette aide",
  "/skills                    Liste les compétences enregistrées",
  "/plan                      Affiche l'arbre de plan courant",
  "/checkpoint save <label>   Sauvegarde l'état courant",
  "/checkpoint load <id>      Restaure un état sauvegardé",
  "/checkpoint list           Liste les checkpoints",
  "/exit                      Quitte",
].join("\n");

/** Brique 8 : une façade parmi d'autres possibles (API HTTP, canal de messagerie...) sur le même cœur Agent. */
export async function runCli(agent: Agent): Promise<void> {
  const rl = createInterface({ input: stdin, output: stdout, prompt: "vous> " });

  console.log("Socle agent autonome — /help pour les commandes, /exit pour quitter.\n");
  rl.prompt();

  for await (const line of rl) {
    const input = line.trim();
    if (!input) {
      rl.prompt();
      continue;
    }

    if (input === "/exit" || input === "/quit") break;

    if (input === "/help") {
      console.log(HELP);
      rl.prompt();
      continue;
    }

    if (input === "/skills") {
      const skills = agent.skills.list();
      console.log(
        skills.length
          ? skills.map((s) => `- ${s.name}: ${s.description}`).join("\n")
          : "(aucune compétence enregistrée)",
      );
      rl.prompt();
      continue;
    }

    if (input === "/plan") {
      const nodes = agent.planner.all();
      console.log(
        nodes.length
          ? nodes
              .map(
                (n) =>
                  `[${n.status}] ${n.title} (${n.id.slice(0, 8)}${n.parentId ? ", parent " + n.parentId.slice(0, 8) : ""})`,
              )
              .join("\n")
          : "(aucun plan)",
      );
      rl.prompt();
      continue;
    }

    if (input.startsWith("/checkpoint")) {
      const [, sub, ...rest] = input.split(" ");
      if (sub === "save") {
        const label = rest.join(" ") || `checkpoint-${Date.now()}`;
        console.log(`Checkpoint sauvegardé: ${agent.saveCheckpoint(label)}`);
      } else if (sub === "load") {
        const id = rest[0];
        const ok = id ? agent.restoreCheckpoint(id) : false;
        console.log(ok ? "Checkpoint restauré." : "Checkpoint introuvable.");
      } else if (sub === "list") {
        const list = agent.listCheckpoints();
        console.log(
          list.length
            ? list.map((c) => `${c.id}  ${c.label}  ${new Date(c.createdAt).toISOString()}`).join("\n")
            : "(aucun checkpoint)",
        );
      } else {
        console.log("Usage: /checkpoint save <label> | load <id> | list");
      }
      rl.prompt();
      continue;
    }

    try {
      const result = await agent.step(input);
      console.log(`\nagent> ${result.response}\n`);
    } catch (err) {
      console.error(`Erreur: ${(err as Error).message}`);
    }
    rl.prompt();
  }

  rl.close();
}
