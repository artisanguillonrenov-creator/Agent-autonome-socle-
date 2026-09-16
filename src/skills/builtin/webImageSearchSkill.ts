import type { SkillDefinition } from "../../types.js";
import { searchWebImages } from "../../web/imageSearch.js";

/**
 * Recherche d'images déjà existantes sur le web (photos, illustrations) — à distinguer de
 * `generate_image` qui, lui, fabrique une image inédite. Retourne des URLs directement
 * affichables en Markdown (`![alt](url)`), servies telles quelles depuis leur hébergeur
 * d'origine (aucun proxy local nécessaire).
 */
export const webImageSearchSkill: SkillDefinition = {
  name: "search_web_image",
  description:
    "Recherche de vraies photos/illustrations existantes sur le web (Google Images via Serper si configuré, sinon Wikimedia Commons). " +
    "Retourne des URLs d'images directement utilisables en Markdown. À utiliser quand l'utilisateur veut voir une image d'un sujet réel, " +
    "pas une création originale (pour ça, voir generate_image).",
  argsHint: '{"query": string, "count"?: number}',
  category: "Technique",
  parameters: {
    type: "object",
    properties: {
      query: { type: "string", description: "Sujet de l'image recherchée." },
      count: { type: "number", description: "Nombre de résultats souhaités (défaut 3, max 10)." },
    },
    required: ["query"],
    additionalProperties: false,
  },
  handler: async (input) => {
    const query = String(input.query ?? "").trim();
    if (!query) return "Erreur search_web_image : le paramètre query est obligatoire.";
    const count = Math.min(Math.max(typeof input.count === "number" ? input.count : 3, 1), 10);

    try {
      const results = await searchWebImages(query, count);
      if (results.length === 0) return `Erreur search_web_image : aucune image trouvée pour "${query}".`;
      return JSON.stringify({ results });
    } catch (error) {
      return `Erreur search_web_image : recherche échouée (${(error as Error).message}).`;
    }
  },
};
