import { existsSync, readFileSync } from "node:fs";
import type { AgentProfileDefinition } from "./types.js";

const MODEL_ROLES = new Set(["coding", "research", "utility"]);

/**
 * Trois profils par défaut couvrant le cycle recherche → rédaction → révision,
 * dans l'esprit des frameworks multi-agents (CrewAI/AutoGen) : chaque profil a
 * son propre système de prompt et un pool de compétences restreint, plutôt
 * qu'un unique agent généraliste voyant tout à la fois.
 */
const BUILTIN_PROFILES: AgentProfileDefinition[] = [
  {
    id: "researcher",
    name: "Chercheur",
    role: "researcher",
    systemPrompt:
      "Tu es le Chercheur de l'équipe. Ta seule mission est de rassembler des faits vérifiables et des sources " +
      "pertinentes sur le sujet donné. Utilise les outils de recherche disponibles, cite tes sources, et ne tire " +
      "aucune conclusion éditoriale : livre une synthèse factuelle brute que le Rédacteur exploitera ensuite.",
    enabled: true,
    llmRole: "research",
    allowedSkills: ["web_search", "deep_research", "knowledge_search", "document_work"],
    order: 10,
  },
  {
    id: "writer",
    name: "Rédacteur",
    role: "writer",
    systemPrompt:
      "Tu es le Rédacteur de l'équipe. À partir des éléments factuels fournis par le Chercheur (visibles dans le " +
      "transcript ci-dessus), rédige une réponse claire, structurée et directement utile à l'objectif. N'invente " +
      "aucun fait qui ne figure pas dans le transcript ; si une information manque, signale-le explicitement.",
    enabled: true,
    llmRole: undefined,
    allowedSkills: ["report_generation", "document_work"],
    order: 20,
  },
  {
    id: "reviewer",
    name: "Réviseur",
    role: "reviewer",
    systemPrompt:
      "Tu es le Réviseur de l'équipe, le dernier filet de sécurité avant livraison. Relis la contribution du " +
      "Rédacteur au regard de l'objectif initial et des faits du Chercheur. Corrige toute erreur, imprécision ou " +
      "hallucination, améliore la clarté, puis produis la version finale prête à être livrée à l'utilisateur.",
    enabled: true,
    llmRole: "utility",
    allowedSkills: [],
    order: 30,
  },
];

function isValidProfile(value: unknown): value is AgentProfileDefinition {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const raw = value as Record<string, unknown>;
  if (typeof raw.id !== "string" || !raw.id.trim()) return false;
  if (typeof raw.name !== "string" || !raw.name.trim()) return false;
  if (typeof raw.role !== "string" || !raw.role.trim()) return false;
  if (typeof raw.systemPrompt !== "string" || !raw.systemPrompt.trim()) return false;
  if (typeof raw.enabled !== "boolean") return false;
  if (raw.llmRole !== undefined && !MODEL_ROLES.has(raw.llmRole as string)) return false;
  if (raw.allowedSkills !== undefined && (!Array.isArray(raw.allowedSkills) || !raw.allowedSkills.every((s) => typeof s === "string"))) return false;
  if (!Number.isFinite(raw.order)) return false;
  return true;
}

/**
 * Registre des profils d'agents disponibles pour la collaboration multi-agents.
 * Charge en plus, si présent, un fichier JSON (config.agentTeams.configPath) qui
 * peut ajouter ou remplacer des profils — même schéma de tolérance aux erreurs
 * que SpecialistRegistry : une entrée invalide est ignorée et journalisée dans
 * `diagnostics`, jamais fatale au démarrage.
 */
export class AgentProfileRegistry {
  private readonly profiles = new Map<string, AgentProfileDefinition>();
  readonly diagnostics: string[] = [];

  constructor(configPath?: string, seed: AgentProfileDefinition[] = BUILTIN_PROFILES) {
    for (const profile of seed) this.profiles.set(profile.id, profile);
    if (!configPath || !existsSync(configPath)) return;
    try {
      const values: unknown = JSON.parse(readFileSync(configPath, "utf8"));
      if (!Array.isArray(values)) throw new Error("root must be an array");
      for (const raw of values) {
        if (!isValidProfile(raw)) {
          this.diagnostics.push(`Invalid agent profile ignored: ${JSON.stringify(raw)}`);
          continue;
        }
        this.profiles.set(raw.id, raw);
      }
    } catch (error) {
      this.diagnostics.push(`Invalid agent profile registry: ${(error as Error).message}`);
    }
  }

  list(): AgentProfileDefinition[] {
    return [...this.profiles.values()].sort((a, b) => a.order - b.order);
  }

  enabled(): AgentProfileDefinition[] {
    return this.list().filter((profile) => profile.enabled);
  }

  get(id: string): AgentProfileDefinition | null {
    return this.profiles.get(id) ?? null;
  }

  register(profile: AgentProfileDefinition): void {
    this.profiles.set(profile.id, profile);
  }
}
