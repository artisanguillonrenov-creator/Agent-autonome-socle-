import { createWebSearchProvider } from "../../web/searchFactory.js";
import type { SkillDefinition } from "../../types.js";

const provider = createWebSearchProvider();

export const webSearchSkill: SkillDefinition = {
  name: "web_search",
  description: "Recherche sur le web des informations récentes ou externes (actualités, météo, faits...).",
  argsHint: '{"query": string}',
  parameters: {
    type: "object",
    properties: {
      query: {
        type: "string",
        description: "Requête à rechercher sur Internet",
      },
    },
    required: ["query"],
    additionalProperties: false,
  },
  handler: async (input) => {
    const query = String(input.query ?? "").trim();
    if (!query) return "Erreur: le champ query est requis.";

    try {
      const results = await provider.search(query, 5);
      if (results.length === 0) return "Aucun résultat trouvé.";
      return results.map((r, i) => `${i + 1}. ${r.title}\n${r.url}\n${r.snippet}`).join("\n\n");
    } catch (err) {
      return `Erreur de recherche web: ${(err as Error).message}`;
    }
  },
};
