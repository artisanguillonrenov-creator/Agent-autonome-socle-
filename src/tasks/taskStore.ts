import { randomUUID } from "node:crypto";
import { getDb } from "../persistence/db.js";
import type { TaskItem, TaskStatus } from "../types.js";

interface TaskRow {
  id: string;
  title: string;
  status: string;
  due_at: number | null;
  created_at: number;
}

function rowToTask(row: TaskRow): TaskItem {
  return {
    id: row.id,
    title: row.title,
    status: row.status as TaskStatus,
    dueAt: row.due_at,
    createdAt: row.created_at,
  };
}

/** Gestion de tâches/rappels — brique complémentaire au socle, stockage local. */
export class TaskStore {
  create(title: string, dueAt: number | null = null): TaskItem {
    const task: TaskItem = { id: randomUUID(), title, status: "pending", dueAt, createdAt: Date.now() };
    getDb()
      .prepare(`INSERT INTO tasks (id, title, status, due_at, created_at) VALUES (?, ?, ?, ?, ?)`)
      .run(task.id, task.title, task.status, task.dueAt, task.createdAt);
    return task;
  }

  complete(id: string): boolean {
    const result = getDb().prepare(`UPDATE tasks SET status = 'done' WHERE id = ?`).run(id);
    return result.changes > 0;
  }

  list(status?: TaskStatus): TaskItem[] {
    const rows = status
      ? (getDb().prepare(`SELECT * FROM tasks WHERE status = ? ORDER BY due_at IS NULL, due_at ASC, created_at ASC`).all(status) as TaskRow[])
      : (getDb().prepare(`SELECT * FROM tasks ORDER BY due_at IS NULL, due_at ASC, created_at ASC`).all() as TaskRow[]);
    return rows.map(rowToTask);
  }

  /** Tâches en retard : échéance passée et toujours non terminées. */
  dueNow(): TaskItem[] {
    const rows = getDb()
      .prepare(`SELECT * FROM tasks WHERE status = 'pending' AND due_at IS NOT NULL AND due_at <= ?`)
      .all(Date.now()) as TaskRow[];
    return rows.map(rowToTask);
  }
}
