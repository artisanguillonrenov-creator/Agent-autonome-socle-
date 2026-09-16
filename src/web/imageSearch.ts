import { config } from "../config.js";

export interface WebImageResult {
  title: string;
  imageUrl: string;
  sourceUrl: string;
}

interface SerperImagesResponse {
  images?: Array<{ title?: string; imageUrl?: string; link?: string }>;
}

/** Recherche d'images via Serper (Google Images), quand SERPER_API_KEY est configurée. */
async function searchViaSerper(query: string, count: number, apiKey: string): Promise<WebImageResult[]> {
  const res = await fetch("https://google.serper.dev/images", {
    method: "POST",
    headers: { "X-API-KEY": apiKey, "content-type": "application/json" },
    body: JSON.stringify({ q: query, num: count }),
  });
  if (!res.ok) throw new Error(`Serper Images API ${res.status}: ${await res.text()}`);
  const data = (await res.json()) as SerperImagesResponse;
  return (data.images ?? [])
    .filter((item) => item.imageUrl)
    .slice(0, count)
    .map((item) => ({ title: (item.title || query).trim(), imageUrl: item.imageUrl!.trim(), sourceUrl: (item.link || item.imageUrl!).trim() }));
}

interface CommonsSearchResponse {
  query?: {
    pages?: Record<string, { title?: string; imageinfo?: Array<{ url?: string; descriptionurl?: string }> }>;
  };
}

/**
 * Wikimedia Commons : source d'images libres de droit, sans clé d'API, utilisée par défaut
 * quand aucun provider payant n'est configuré (voir SERPER_API_KEY).
 */
async function searchViaWikimediaCommons(query: string, count: number): Promise<WebImageResult[]> {
  const params = new URLSearchParams({
    action: "query",
    generator: "search",
    gsrsearch: `${query} filetype:bitmap`,
    gsrnamespace: "6",
    gsrlimit: String(count),
    prop: "imageinfo",
    iiprop: "url",
    format: "json",
    origin: "*",
  });
  const res = await fetch(`https://commons.wikimedia.org/w/api.php?${params.toString()}`);
  if (!res.ok) throw new Error(`Wikimedia Commons API ${res.status}`);
  const data = (await res.json()) as CommonsSearchResponse;
  const pages = Object.values(data.query?.pages ?? {});
  return pages
    .map((page) => {
      const info = page.imageinfo?.[0];
      if (!info?.url) return null;
      return {
        title: (page.title || query).replace(/^File:/, "").trim(),
        imageUrl: info.url,
        sourceUrl: info.descriptionurl || info.url,
      };
    })
    .filter((item): item is WebImageResult => item !== null)
    .slice(0, count);
}

/**
 * Recherche d'images web réelles (pas de génération) : Serper Images si une clé est
 * configurée (résultats Google Images), sinon Wikimedia Commons (aucune clé requise).
 */
export async function searchWebImages(query: string, count = 3): Promise<WebImageResult[]> {
  const trimmed = query.trim();
  if (!trimmed) return [];
  if (config.webSearch.serperApiKey) {
    return searchViaSerper(trimmed, count, config.webSearch.serperApiKey);
  }
  return searchViaWikimediaCommons(trimmed, count);
}
