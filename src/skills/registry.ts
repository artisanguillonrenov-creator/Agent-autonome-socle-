import type { EmbeddingProvider } from "../llm/embeddings.js";
import { cosineSimilarity } from "../llm/embeddings.js";
import type { SkillContext, SkillDefinition } from "../types.js";

/**
 * Brique 5 : bibliothèque de compétences. Les skills sont indexées par leur
 * description (embeddée) et rappelées par pertinence plutôt qu'injectées en
 * dur en intégralité à chaque appel — ça permet d'ajouter des dizaines de
 * compétences sans faire exploser le budget de contexte (brique 7).
 */
export class SkillRegistry {
  private readonly skills = new Map<string, SkillDefinition>();
  private readonly descriptionEmbeddings = new Map<string, number[]>();

  constructor(private readonly embeddings: EmbeddingProvider) {}

  register(skill: SkillDefinition): void {
    this.skills.set(skill.name, skill);
  }

  get(name: string): SkillDefinition | undefined {
    return this.skills.get(name);
  }

  list(): SkillDefinition[] {
    return [...this.skills.values()];
  }

  async findRelevant(query: string, topK = 3): Promise<SkillDefinition[]> {
    if (this.skills.size === 0) return [];
    const queryEmbedding = await this.embeddings.embed(query);

    const scored = await Promise.all(
      [...this.skills.values()].map(async (skill) => {
        let embedding = this.descriptionEmbeddings.get(skill.name);
        if (!embedding) {
          embedding = await this.embeddings.embed(`${skill.name}: ${skill.description}`);
          this.descriptionEmbeddings.set(skill.name, embedding);
        }
        return { skill, score: cosineSimilarity(queryEmbedding, embedding) };
      }),
    );

    return scored
      .sort((a, b) => b.score - a.score)
      .slice(0, topK)
      .map((s) => s.skill);
  }

  async execute(name: string, input: Record<string, unknown>, ctx: SkillContext): Promise<string> {
    const skill = this.skills.get(name);
    if (!skill) {
      return `Erreur: compétence "${name}" introuvable. Disponibles: ${[...this.skills.keys()].join(", ")}`;
    }
    try {
      return await skill.handler(input, ctx);
    } catch (err) {
      return `Erreur lors de l'exécution de "${name}": ${(err as Error).message}`;
    }
  }
}
