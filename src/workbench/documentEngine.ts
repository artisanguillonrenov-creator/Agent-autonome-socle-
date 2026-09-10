import { randomUUID } from "node:crypto";
import { statSync, readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { WorkspaceStore } from "../workspaces/workspaceStore.js";
import {
  DocumentFormat,
  DocumentResult,
  DocumentSearchMatch,
  DocumentSearchOptions,
  DocumentSection,
  resolveWorkspacePath,
  WORKBENCH_ERRORS
} from "./workbenchTypes.js";

const require = createRequire(import.meta.url);
const pdfParse = require("pdf-parse");

export const DOCUMENT_LIMITS = {
  maxInputBytes: 25 * 1024 * 1024, // 25 MB
  maxExtractedCharacters: 2_000_000,
  maxSearchResults: 100,
  maxSections: 500
};

export class DocumentEngine {
  constructor(private workspaceStore: WorkspaceStore = new WorkspaceStore()) {}

  private detectFormat(relativePath: string): DocumentFormat {
    const ext = relativePath.split(".").pop()?.toLowerCase();
    switch (ext) {
      case "txt":
        return "txt";
      case "md":
      case "markdown":
        return "markdown";
      case "json":
        return "json";
      case "csv":
        return "csv";
      case "html":
      case "htm":
        return "html";
      case "pdf":
        return "pdf";
      default:
        throw new Error(WORKBENCH_ERRORS.DOCUMENT_FORMAT_UNSUPPORTED);
    }
  }

  private cleanHtml(htmlContent: string): string {
    // Strip scripts, styles, iframes, and comments
    let text = htmlContent
      .replace(/<script\b[^<]*(?:(?!<\/script>)<[^<]*)*<\/script>/gi, " ")
      .replace(/<style\b[^<]*(?:(?!<\/style>)<[^<]*)*<\/style>/gi, " ")
      .replace(/<iframe\b[^<]*(?:(?!<\/iframe>)<[^<]*)*<\/iframe>/gi, " ")
      .replace(/<!--[\s\S]*?-->/g, " ");

    // Replace line break elements with newlines
    text = text.replace(/<(?:br|h[1-6]|p|div|li|tr)[^>]*>/gi, "\n");
    // Strip remaining tags
    text = text.replace(/<[^>]+>/g, " ");
    // Unescape basic HTML entities
    text = text
      .replace(/&nbsp;/gi, " ")
      .replace(/&amp;/gi, "&")
      .replace(/&lt;/gi, "<")
      .replace(/&gt;/gi, ">")
      .replace(/&quot;/gi, '"')
      .replace(/&#39;/gi, "'");

    // Clean up excessive whitespace per line
    return text
      .split("\n")
      .map((line) => line.trim())
      .filter((line) => line.length > 0)
      .join("\n");
  }

  async readDocument(workspaceId: string, relativePath: string): Promise<DocumentResult> {
    const { relativePath: cleanRel, absolutePath } = resolveWorkspacePath(
      this.workspaceStore,
      workspaceId,
      relativePath
    );

    const stats = statSync(absolutePath);
    if (stats.size > DOCUMENT_LIMITS.maxInputBytes) {
      throw new Error(WORKBENCH_ERRORS.DOCUMENT_TOO_LARGE);
    }

    const format = this.detectFormat(cleanRel);
    const warnings: string[] = [];
    let truncated = false;
    let fullText = "";
    let pageCount: number | undefined;
    let metadata: Record<string, unknown> = {};
    let title: string | undefined;

    if (format === "pdf") {
      const buffer = readFileSync(absolutePath);
      try {
        const data = await pdfParse(buffer);
        pageCount = data.numpages;
        metadata = {
          info: data.info ?? {},
          metadata: data.metadata ?? null,
          version: data.version ?? null
        };
        if (data.info?.Title && typeof data.info.Title === "string" && data.info.Title.trim()) {
          title = data.info.Title.trim();
        }
        fullText = data.text ?? "";

        // OCR Required check if PDF has pages but virtually no extractable text
        if ((pageCount ?? 0) > 0 && fullText.trim().replace(/\s+/g, "").length < 10) {
          throw new Error(WORKBENCH_ERRORS.DOCUMENT_OCR_REQUIRED);
        }
      } catch (err: any) {
        if (err?.message === WORKBENCH_ERRORS.DOCUMENT_OCR_REQUIRED) {
          throw err;
        }
        throw new Error(WORKBENCH_ERRORS.DOCUMENT_PARSE_FAILED);
      }
    } else {
      const rawContent = readFileSync(absolutePath, "utf-8");
      if (format === "html") {
        fullText = this.cleanHtml(rawContent);
        const titleMatch = rawContent.match(/<title\b[^>]*>(.*?)<\/title>/i);
        if (titleMatch) {
          title = titleMatch[1].trim();
        }
      } else if (format === "json") {
        try {
          const parsed = JSON.parse(rawContent);
          fullText = JSON.stringify(parsed, null, 2);
          if (typeof parsed === "object" && parsed !== null && "title" in parsed) {
            title = String(parsed.title);
          }
        } catch {
          fullText = rawContent;
          warnings.push("Invalid JSON format, loaded as raw text.");
        }
      } else if (format === "markdown") {
        fullText = rawContent;
        const h1Match = rawContent.match(/^#\s+(.+)$/m);
        if (h1Match) {
          title = h1Match[1].trim();
        }
      } else {
        fullText = rawContent;
      }
    }

    // Enforce character limit
    if (fullText.length > DOCUMENT_LIMITS.maxExtractedCharacters) {
      fullText = fullText.slice(0, DOCUMENT_LIMITS.maxExtractedCharacters);
      truncated = true;
      warnings.push(`Document text truncated to ${DOCUMENT_LIMITS.maxExtractedCharacters} characters.`);
    }

    // Split sections
    const sections = this.extractSections(fullText, format);
    if (sections.length >= DOCUMENT_LIMITS.maxSections) {
      warnings.push(`Sections capped at ${DOCUMENT_LIMITS.maxSections}.`);
    }

    return {
      documentId: randomUUID(),
      workspaceId,
      path: cleanRel,
      format,
      sizeBytes: stats.size,
      pageCount,
      title,
      metadata,
      text: fullText,
      sections,
      truncated,
      warnings
    };
  }

  private extractSections(fullText: string, format: DocumentFormat): DocumentSection[] {
    const sections: DocumentSection[] = [];
    if (!fullText) return sections;

    if (format === "markdown") {
      const headerRegex = /^(#{1,6})\s+(.+)$/gm;
      let match: RegExpExecArray | null;
      const headers: { index: number; title: string; offset: number }[] = [];

      while ((match = headerRegex.exec(fullText)) !== null) {
        headers.push({ index: headers.length, title: match[2].trim(), offset: match.index });
      }

      if (headers.length === 0) {
        sections.push({ index: 0, text: fullText, startOffset: 0, endOffset: fullText.length });
      } else {
        for (let i = 0; i < headers.length; i++) {
          if (sections.length >= DOCUMENT_LIMITS.maxSections) break;
          const current = headers[i];
          const nextOffset = i + 1 < headers.length ? headers[i + 1].offset : fullText.length;
          const sectionText = fullText.slice(current.offset, nextOffset).trim();
          sections.push({
            index: i,
            title: current.title,
            startOffset: current.offset,
            endOffset: nextOffset,
            text: sectionText
          });
        }
      }
    } else {
      // Split by double newlines or logical paragraphs
      const paragraphs = fullText.split(/\n\s*\n/);
      let cursor = 0;
      for (let i = 0; i < paragraphs.length; i++) {
        if (sections.length >= DOCUMENT_LIMITS.maxSections) break;
        const para = paragraphs[i].trim();
        if (!para) continue;
        const startOffset = fullText.indexOf(para, cursor);
        const endOffset = startOffset + para.length;
        cursor = endOffset;
        sections.push({
          index: sections.length,
          startOffset: startOffset >= 0 ? startOffset : undefined,
          endOffset: endOffset >= 0 ? endOffset : undefined,
          text: para
        });
      }
    }

    return sections;
  }

  searchDocument(document: DocumentResult, options: DocumentSearchOptions): DocumentSearchMatch[] {
    const { query, caseSensitive = false, maxResults = DOCUMENT_LIMITS.maxSearchResults, contextChars = 40 } = options;
    if (!query || !document.text) return [];

    const normText = this.normalizeSearchString(document.text, caseSensitive);
    const normQuery = this.normalizeSearchString(query, caseSensitive);

    if (!normQuery) return [];

    const matches: DocumentSearchMatch[] = [];
    let pos = 0;

    while (pos < normText.length && matches.length < maxResults) {
      const foundIdx = normText.indexOf(normQuery, pos);
      if (foundIdx === -1) break;

      const rawMatchedText = document.text.substring(foundIdx, foundIdx + normQuery.length);
      const startExcerpt = Math.max(0, foundIdx - contextChars);
      const endExcerpt = Math.min(document.text.length, foundIdx + normQuery.length + contextChars);
      const excerpt = document.text.substring(startExcerpt, endExcerpt).replace(/\n/g, " ");

      // Find corresponding section
      let matchingSectionIdx: number | undefined;
      if (document.sections) {
        const sec = document.sections.find(
          (s) =>
            s.startOffset !== undefined &&
            s.endOffset !== undefined &&
            foundIdx >= s.startOffset &&
            foundIdx < s.endOffset
        );
        if (sec) matchingSectionIdx = sec.index;
      }

      matches.push({
        section: matchingSectionIdx,
        offset: foundIdx,
        matchedText: rawMatchedText,
        excerpt: excerpt.trim()
      });

      pos = foundIdx + Math.max(1, normQuery.length);
    }

    return matches;
  }

  private normalizeSearchString(str: string, caseSensitive: boolean): string {
    let result = str.normalize("NFD").replace(/\p{Diacritic}/gu, "");
    if (!caseSensitive) {
      result = result.toLowerCase();
    }
    return result;
  }
}
