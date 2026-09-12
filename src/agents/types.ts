import type { ModelRole } from "../llm/modelRouter.js";

/**
 * Brique multi-agents : un profil décrit un agent spécialisé au sein d'une équipe
 * collaborant sur un même objectif (ex: Chercheur, Rédacteur, Réviseur). Chaque
 * profil possède son propre prompt système, un rôle de modèle (résolu vers un
 * LLMProvider dédié via `providerForRole`) et un pool restreint de compétences.
 */
export interface AgentProfileDefinition {
  id: string;
  name: string;
  /** Rôle fonctionnel, informatif (affichage / routage) — ex: "researcher", "writer", "reviewer". */
  role: string;
  systemPrompt: string;
  enabled: boolean;
  /** Rôle de modèle résolu via config.llm.{codingModel,researchModel,utilityModel} ; absent = provider principal. */
  llmRole?: ModelRole;
  /** Sous-ensemble de noms de compétences autorisés pour cet agent. Vide/absent = aucune compétence (raisonnement pur). */
  allowedSkills?: string[];
  /** Ordre de passage par défaut au sein d'une équipe (croissant). */
  order: number;
}

export type AgentTeamRunStatus = "RUNNING" | "COMPLETED" | "FAILED";

export interface AgentTeamRun {
  id: string;
  objective: string;
  status: AgentTeamRunStatus;
  profileIds: string[];
  currentIndex: number;
  roundsCompleted: number;
  maxRounds: number;
  workspaceId?: string;
  conversationId?: string;
  lastError?: string;
  createdAt: number;
  updatedAt: number;
}

export interface AgentTeamMessage {
  id: string;
  teamRunId: string;
  sequence: number;
  agentId: string;
  role: "user" | "assistant";
  content: string;
  createdAt: number;
}
