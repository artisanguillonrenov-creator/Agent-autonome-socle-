import { readFileSync } from "node:fs";
import { PDFParse } from "pdf-parse";
import type { WorkspaceStore } from "../workspaces/workspaceStore.js";
import { WORKBENCH_LIMITS, workbenchError } from "./limits.js";

export type DocumentFormat = "txt" | "md" | "markdown" | "json" | "csv" | "html" | "htm" | "pdf";

const SUPPORTED_EXTENSIONS: Record<string, DocumentFormat> = {
  ".txt": "txt",
  ".md": "md",
  ".markdown": "markdown",
  ".json": "json",
  ".csv": "csv",
  ".html": "html",
  ".htm": "htm",
  ".pdf": "pdf",
};

export interface DocumentSection {
  level: number;
  title: string;
  charIndex: number;
}

export interface DocumentReadResult {
  format: DocumentFormat;
  path: string;
  sizeBytes: number;
  title?: string;
  pageCount?: number;
  text: string;
  sections: DocumentSection[];
  truncated: boolean;
  warnings: string[];
}

export interface DocumentSearchMatch {
  index: number;
  context: string;
}

export interface DocumentSearchResult {
  workspaceId: string;
  path: string;
  query: string;
  matches: DocumentSearchMatch[];
  totalMatches: number;
  truncated: boolean;
  warnings: string[];
}

function extensionOf(path: string): string {
  const idx = path.lastIndexOf(".");
  return idx === -1 ? "" : path.slice(idx).toLowerCase();
}

function detectFormat(path: string): DocumentFormat {
  const format = SUPPORTED_EXTENSIONS[extensionOf(path)];
  if (!format) throw workbenchError("DOCUMENT_FORMAT_UNSUPPORTED");
  return format;
}

/** Extraction de texte seule : script/style/iframe ne sont jamais exécutés ni conservés. */
function stripHtml(html: string): string {
  const withoutDangerous = html
    .replace(/<!--[\s\S]*?-->/g, " ")
    .replace(/<(script|style|iframe)\b[^>]*>[\s\S]*?<\/\1>/gi, " ")
    .replace(/<[^>]+>/g, " ");
  return withoutDangerous
    .replace(/&nbsp;/gi, " ")
    .replace(/&amp;/gi, "&")
    .replace(/&lt;/gi, "<")
    .replace(/&gt;/gi, ">")
    .replace(/&quot;/gi, '"')
    .replace(/&#39;/gi, "'")
    .replace(/[ \t]+/g, " ")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

function extractMarkdownSections(text: string): DocumentSection[] {
  const sections: DocumentSection[] = [];
  const re = /^(#{1,6})\s+(.+)$/gm;
  let m: RegExpExecArray | null;
  while ((m = re.exec(text))) {
    sections.push({ level: m[1].length, title: m[2].trim(), charIndex: m.index });
  }
  return sections;
}

function truncateText(text: string): { text: string; truncated: boolean } {
  if (text.length <= WORKBENCH_LIMITS.DOCUMENT_MAX_TEXT_CHARS) return { text, truncated: false };
  return { text: text.slice(0, WORKBENCH_LIMITS.DOCUMENT_MAX_TEXT_CHARS), truncated: true };
}

const OCR_REQUIRED_MIN_CHARS = 10;

async function readPdf(absolutePath: string, path: string, size: number): Promise<DocumentReadResult> {
  const data = readFileSync(absolutePath);
  const parser = new PDFParse({ data });
  try {
    const warnings: string[] = [];
    const textResult = await parser.getText();
    let title: string | undefined;
    try {
      const info = await parser.getInfo();
      const infoTitle = (info.info as Record<string, unknown> | undefined)?.Title;
      if (typeof infoTitle === "string" && infoTitle.trim()) title = infoTitle.trim();
    } catch {
      warnings.push("DOCUMENT_PDF_INFO_UNAVAILABLE");
    }
    const pageCount = textResult.total;
    const fullText = textResult.text ?? "";
    // Le texte concaténé (`.text`) inclut des séparateurs de page ("-- N of M --") : on les exclut
    // du calcul, sinon un PDF scanné multi-pages sans aucun texte réel pourrait sembler exploitable.
    const meaningfulChars = textResult.pages.map((p) => p.text).join("").replace(/\s+/g, "").length;
    if (pageCount > 0 && meaningfulChars < OCR_REQUIRED_MIN_CHARS) {
      throw workbenchError("DOCUMENT_OCR_REQUIRED");
    }
    const { text, truncated } = truncateText(fullText);
    return { format: "pdf", path, sizeBytes: size, title, pageCount, text, sections: [], truncated, warnings };
  } finally {
    await parser.destroy();
  }
}

export async function readDocument(
  workspaces: WorkspaceStore,
  workspaceId: string,
  path: string,
): Promise<DocumentReadResult> {
  const format = detectFormat(path);
  const { absolutePath, size } = workspaces.resolveExistingFile(workspaceId, path);
  if (size > WORKBENCH_LIMITS.INPUT_FILE_MAX_BYTES) throw workbenchError("DOCUMENT_FILE_TOO_LARGE");

  if (format === "pdf") return readPdf(absolutePath, path, size);

  const raw = readFileSync(absolutePath, "utf8");
  const warnings: string[] = [];

  if (format === "json") {
    try {
      const pretty = JSON.stringify(JSON.parse(raw), null, 2);
      const { text, truncated } = truncateText(pretty);
      return { format, path, sizeBytes: size, text, sections: [], truncated, warnings };
    } catch {
      warnings.push("DOCUMENT_JSON_INVALID");
      const { text, truncated } = truncateText(raw);
      return { format, path, sizeBytes: size, text, sections: [], truncated, warnings };
    }
  }

  if (format === "html" || format === "htm") {
    const { text, truncated } = truncateText(stripHtml(raw));
    return { format, path, sizeBytes: size, text, sections: [], truncated, warnings };
  }

  const { text, truncated } = truncateText(raw);
  const sections = format === "md" || format === "markdown" ? extractMarkdownSections(text) : [];
  return { format, path, sizeBytes: size, text, sections, truncated, warnings };
}

export interface DocumentSearchOptions {
  caseSensitive?: boolean;
  maxResults?: number;
  contextChars?: number;
}

export async function searchDocument(
  workspaces: WorkspaceStore,
  workspaceId: string,
  path: string,
  query: string,
  options: DocumentSearchOptions = {},
): Promise<DocumentSearchResult> {
  if (typeof query !== "string" || !query.length) throw workbenchError("DOCUMENT_SEARCH_QUERY_REQUIRED");
  const doc = await readDocument(workspaces, workspaceId, path);
  const caseSensitive = options.caseSensitive === true;
  const contextChars =
    Number.isFinite(options.contextChars) && (options.contextChars as number) >= 0
      ? Math.floor(options.contextChars as number)
      : 40;
  const requested =
    Number.isFinite(options.maxResults) && (options.maxResults as number) > 0
      ? Math.floor(options.maxResults as number)
      : WORKBENCH_LIMITS.DOCUMENT_MAX_SEARCH_RESULTS;
  const maxResults = Math.min(requested, WORKBENCH_LIMITS.DOCUMENT_MAX_SEARCH_RESULTS);

  const haystack = caseSensitive ? doc.text : doc.text.toLowerCase();
  const needle = caseSensitive ? query : query.toLowerCase();

  const matches: DocumentSearchMatch[] = [];
  let totalMatches = 0;
  let fromIndex = 0;
  while (true) {
    const idx = haystack.indexOf(needle, fromIndex);
    if (idx === -1) break;
    totalMatches++;
    if (matches.length < maxResults) {
      const start = Math.max(0, idx - contextChars);
      const end = Math.min(doc.text.length, idx + needle.length + contextChars);
      matches.push({ index: idx, context: doc.text.slice(start, end) });
    }
    fromIndex = idx + Math.max(needle.length, 1);
  }

  const warnings = [...doc.warnings];
  if (doc.truncated) warnings.push("DOCUMENT_TEXT_TRUNCATED_BEFORE_SEARCH");

  return { workspaceId, path, query, matches, totalMatches, truncated: totalMatches > matches.length, warnings };
}
