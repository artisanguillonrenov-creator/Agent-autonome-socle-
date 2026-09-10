import { randomUUID } from "node:crypto";
import { Artifact, ArtifactStore } from "../workspaces/artifactStore.js";
import { WorkspaceStore } from "../workspaces/workspaceStore.js";
import {
  Finding,
  GeneratedReportResult,
  Provenance,
  ReportSection,
  ReportStructure,
  resolveWorkspacePath,
  WORKBENCH_ERRORS
} from "./workbenchTypes.js";

export class ReportEngine {
  constructor(
    private workspaceStore: WorkspaceStore = new WorkspaceStore(),
    private artifactStore: ArtifactStore = new ArtifactStore(workspaceStore)
  ) {}

  generateReport(
    workspaceId: string,
    structure: Omit<ReportStructure, "generatedAt">,
    format: "markdown" | "json" | "csv" = "markdown",
    options: { persistArtifact?: boolean; targetPath?: string } = {}
  ): GeneratedReportResult {
    const reportId = randomUUID();
    const generatedAt = Date.now();
    const fullStructure: ReportStructure = { ...structure, generatedAt };

    let content = "";
    let mimeType = "text/plain";

    if (format === "markdown") {
      content = this.renderMarkdown(fullStructure);
      mimeType = "text/markdown; charset=utf-8";
    } else if (format === "json") {
      content = JSON.stringify(fullStructure, null, 2);
      mimeType = "application/json";
    } else if (format === "csv") {
      content = this.renderCsv(fullStructure);
      mimeType = "text/csv; charset=utf-8";
    } else {
      throw new Error(WORKBENCH_ERRORS.REPORT_GENERATION_FAILED);
    }

    const contentBuffer = Buffer.from(content, "utf-8");
    let relativePath: string | undefined;
    let artifactId: string | undefined;

    if (options.persistArtifact || options.targetPath) {
      try {
        const safeTitle = structure.title.replace(/[^a-zA-Z0-9._-]/g, "_") || "report";
        const workingPath = options.targetPath ?? `reports/${safeTitle}_${reportId.slice(0, 8)}.${format === "markdown" ? "md" : format}`;

        // Ensure path stays safely in workspace
        const { relativePath: cleanRel } = resolveWorkspacePath(this.workspaceStore, workspaceId, workingPath, { allowMissing: true });

        // Atomic file and DB record creation via ArtifactStore.createBatch
        const artifacts = this.artifactStore.createBatch([
          {
            workspaceId,
            kind: "REPORT",
            name: structure.title,
            mimeType,
            content: contentBuffer,
            workingPath: cleanRel,
            metadata: {
              reportId,
              format,
              sources: structure.sources
            }
          }
        ]);

        artifactId = artifacts[0]?.id;
        relativePath = cleanRel;
      } catch (err) {
        throw new Error(WORKBENCH_ERRORS.REPORT_GENERATION_FAILED);
      }
    }

    return {
      reportId,
      workspaceId,
      title: structure.title,
      format,
      content,
      artifactId,
      relativePath,
      sizeBytes: contentBuffer.length,
      sources: structure.sources
    };
  }

  private renderMarkdown(report: ReportStructure): string {
    const lines: string[] = [];
    lines.push(`# ${report.title}`);
    lines.push("");
    lines.push(`**Date de génération :** ${new Date(report.generatedAt).toISOString()}`);
    lines.push("");
    lines.push("## Résumé");
    lines.push(report.summary);
    lines.push("");

    if (report.findings && report.findings.length > 0) {
      lines.push("## Constats et Anomalies");
      for (const f of report.findings) {
        const sev = f.severity ? `[${f.severity}] ` : "";
        lines.push(`- **${sev}${f.title}**`);
        if (f.evidence) lines.push(`  - *Preuve :* ${f.evidence}`);
        if (f.recommendation) lines.push(`  - *Recommandation :* ${f.recommendation}`);
      }
      lines.push("");
    }

    if (report.sections && report.sections.length > 0) {
      for (const sec of report.sections) {
        lines.push(`## ${sec.title}`);
        lines.push(sec.content);
        if (sec.provenance && sec.provenance.length > 0) {
          lines.push("");
          lines.push("*Sources de la section :* " + sec.provenance.map((p) => this.formatProvenance(p)).join(", "));
        }
        lines.push("");
      }
    }

    if (report.tables && report.tables.length > 0) {
      for (const tbl of report.tables) {
        lines.push(`### ${tbl.title}`);
        if (tbl.columns.length > 0) {
          lines.push(`| ${tbl.columns.join(" | ")} |`);
          lines.push(`| ${tbl.columns.map(() => "---").join(" | ")} |`);
          for (const row of tbl.rows) {
            lines.push(`| ${row.map((cell) => String(cell ?? "")).join(" | ")} |`);
          }
        }
        lines.push("");
      }
    }

    if (report.sources && report.sources.length > 0) {
      lines.push("## Provenance et Sources");
      for (const src of report.sources) {
        lines.push(`- ${this.formatProvenance(src)}`);
      }
      lines.push("");
    }

    return lines.join("\n");
  }

  private renderCsv(report: ReportStructure): string {
    if (report.tables && report.tables.length > 0) {
      const tbl = report.tables[0];
      const lines: string[] = [];
      lines.push(tbl.columns.map((c) => this.escapeCsvCell(c)).join(","));
      for (const row of tbl.rows) {
        lines.push(row.map((cell) => this.escapeCsvCell(String(cell ?? ""))).join(","));
      }
      return lines.join("\n");
    } else {
      const lines = ["Key,Value"];
      lines.push(`Title,${this.escapeCsvCell(report.title)}`);
      lines.push(`Summary,${this.escapeCsvCell(report.summary)}`);
      return lines.join("\n");
    }
  }

  private escapeCsvCell(cell: string): string {
    if (cell.includes(",") || cell.includes('"') || cell.includes("\n")) {
      return `"${cell.replace(/"/g, '""')}"`;
    }
    return cell;
  }

  private formatProvenance(p: Provenance): string {
    const parts = [`File: ${p.path}`];
    if (p.sheet) parts.push(`Sheet: ${p.sheet}`);
    if (p.page) parts.push(`Page: ${p.page}`);
    if (p.rows) parts.push(`Rows: ${Array.isArray(p.rows) ? p.rows.join(",") : p.rows}`);
    if (p.columns) parts.push(`Cols: ${p.columns.join(",")}`);
    if (p.query) parts.push(`Query: "${p.query}"`);
    return parts.join(" | ");
  }
}
