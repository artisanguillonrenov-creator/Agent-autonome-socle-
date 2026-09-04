import { randomUUID } from "node:crypto";
import { getDb } from "../persistence/db.js";
import type { PlanNode, PlanNodeStatus } from "../types.js";

interface PlanNodeRow {
  id: string;
  parent_id: string | null;
  title: string;
  status: string;
  created_at: number;
}

function rowToNode(row: PlanNodeRow): PlanNode {
  return {
    id: row.id,
    parentId: row.parent_id,
    title: row.title,
    status: row.status as PlanNodeStatus,
    createdAt: row.created_at,
  };
}

/**
 * Brique 4 : planification hiérarchique. Un objectif racine se décompose en
 * sous-objectifs puis en étapes. Chaque palier est régénérable (on peut
 * abandonner et recréer les enfants d'un nœud) sans toucher aux niveaux
 * au-dessus ni aux branches parallèles.
 */
export class Planner {
  createNode(title: string, parentId: string | null = null): PlanNode {
    const node: PlanNode = {
      id: randomUUID(),
      parentId,
      title,
      status: "pending",
      createdAt: Date.now(),
    };
    getDb()
      .prepare(`INSERT INTO plan_nodes (id, parent_id, title, status, created_at) VALUES (?, ?, ?, ?, ?)`)
      .run(node.id, node.parentId, node.title, node.status, node.createdAt);
    return node;
  }

  decompose(parentId: string, subgoalTitles: string[]): PlanNode[] {
    return subgoalTitles.map((title) => this.createNode(title, parentId));
  }

  setStatus(id: string, status: PlanNodeStatus): void {
    getDb().prepare(`UPDATE plan_nodes SET status = ? WHERE id = ?`).run(status, id);
  }

  children(parentId: string | null): PlanNode[] {
    const rows = getDb()
      .prepare(`SELECT * FROM plan_nodes WHERE parent_id IS ? ORDER BY created_at ASC`)
      .all(parentId) as PlanNodeRow[];
    return rows.map(rowToNode);
  }

  /**
   * Régénère la branche sous un nœud : abandonne les enfants existants (traçabilité
   * conservée) et crée de nouveaux sous-objectifs à la place — sans toucher au nœud
   * parent ni aux autres branches du plan.
   */
  regenerateBranch(nodeId: string, newChildTitles: string[]): PlanNode[] {
    const existingChildren = this.children(nodeId);
    for (const child of existingChildren) {
      this.setStatus(child.id, "abandoned");
    }
    return this.decompose(nodeId, newChildTitles);
  }

  all(): PlanNode[] {
    const rows = getDb().prepare(`SELECT * FROM plan_nodes ORDER BY created_at ASC`).all() as PlanNodeRow[];
    return rows.map(rowToNode);
  }

  /** Remplace tout le plan par un état sauvegardé (restauration de checkpoint). */
  restore(nodes: PlanNode[]): void {
    const db = getDb();
    db.exec(`DELETE FROM plan_nodes`);
    const insert = db.prepare(
      `INSERT INTO plan_nodes (id, parent_id, title, status, created_at) VALUES (?, ?, ?, ?, ?)`,
    );
    for (const node of nodes) {
      insert.run(node.id, node.parentId, node.title, node.status, node.createdAt);
    }
  }
}
