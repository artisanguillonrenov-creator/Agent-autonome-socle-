import { TaskStore } from "../../tasks/taskStore.js";
import type { SkillDefinition } from "../../types.js";

const taskStore = new TaskStore();

function formatTask(t: { title: string; status: string; dueAt: number | null }): string {
  const due = t.dueAt ? ` (échéance: ${new Date(t.dueAt).toISOString()})` : "";
  return `[${t.status}] ${t.title}${due}`;
}

export const createTaskSkill: SkillDefinition = {
  name: "create_task",
  description: "Crée une tâche ou un rappel, avec une échéance optionnelle.",
  argsHint: '{"title": string, "due_at_iso"?: string (date ISO 8601)}',
  handler: async (input) => {
    const title = String(input.title ?? "").trim();
    if (!title) return "Erreur: le champ title est requis.";

    let dueAt: number | null = null;
    if (typeof input.due_at_iso === "string" && input.due_at_iso.trim()) {
      const parsed = Date.parse(input.due_at_iso);
      if (Number.isNaN(parsed)) return `Erreur: date invalide "${input.due_at_iso}".`;
      dueAt = parsed;
    }

    const task = taskStore.create(title, dueAt);
    return `Tâche créée : ${formatTask(task)} (id: ${task.id})`;
  },
};

export const listTasksSkill: SkillDefinition = {
  name: "list_tasks",
  description: "Liste les tâches, éventuellement filtrées par statut (pending ou done).",
  argsHint: '{"status"?: "pending" | "done"}',
  handler: async (input) => {
    const status = input.status === "pending" || input.status === "done" ? input.status : undefined;
    const tasks = taskStore.list(status);
    if (tasks.length === 0) return "Aucune tâche.";
    return tasks.map((t) => `${formatTask(t)} — id: ${t.id}`).join("\n");
  },
};

export const completeTaskSkill: SkillDefinition = {
  name: "complete_task",
  description: "Marque une tâche comme terminée à partir de son identifiant.",
  argsHint: '{"id": string}',
  handler: async (input) => {
    const id = String(input.id ?? "").trim();
    if (!id) return "Erreur: le champ id est requis.";
    const ok = taskStore.complete(id);
    return ok ? `Tâche ${id} marquée comme terminée.` : `Aucune tâche trouvée avec l'id ${id}.`;
  },
};
