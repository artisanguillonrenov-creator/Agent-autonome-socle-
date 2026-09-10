import type { ArtifactStore } from "../workspaces/artifactStore.js";
import { workbenchError } from "./limits.js";

export type ReportFormat = "MARKDOWN" | "JSON";

export interface ReportRequest {
  workspaceId: string;
  title: string;
  content: string;
  format: ReportFormat;
  targetPath?: string;
  metadata?: Record<string, unknown>;
}

export interface ReportResult {
  artifactId: string;
  relativePath?: string;
  workingPath?: string;
  mimeType?: string;
  sizeBytes?: number;
  sha256?: string;
}

function safeFileStem(title: string): string {
  const stem = title
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
  return stem || "report";
}

/**
 * Persiste un rapport terminé via ArtifactStore (kind REPORT). Si `targetPath`
 * est fourni, il est utilisé comme `workingPath` afin qu'une copie réelle et
 * sécurisée soit écrite dans le workspace — jamais annoncée si l'écriture n'a
 * pas eu lieu (l'échec fait échouer tout l'appel, atomiquement).
 */
export function generateReport(artifacts: ArtifactStore, request: ReportRequest): ReportResult {
  if (typeof request.title !== "string" || !request.title.trim()) throw workbenchError("REPORT_TITLE_REQUIRED");
  if (typeof request.content !== "string") throw workbenchError("REPORT_CONTENT_REQUIRED");
  if (request.format !== "MARKDOWN" && request.format !== "JSON") throw workbenchError("REPORT_FORMAT_UNSUPPORTED");

  let body: string;
  let mimeType: string;
  let extension: string;
  if (request.format === "JSON") {
    try {
      body = JSON.stringify(JSON.parse(request.content), null, 2);
    } catch {
      throw workbenchError("REPORT_INVALID_JSON");
    }
    mimeType = "application/json; charset=utf-8";
    extension = "json";
  } else {
    body = request.content;
    mimeType = "text/markdown; charset=utf-8";
    extension = "md";
  }

  const name = `${safeFileStem(request.title)}.${extension}`;
  const content = Buffer.from(body, "utf8");
  const [artifact] = artifacts.createBatch([
    {
      workspaceId: request.workspaceId,
      kind: "REPORT",
      name,
      mimeType,
      content,
      metadata: { title: request.title, ...(request.metadata ?? {}) },
      ...(request.targetPath ? { workingPath: request.targetPath } : {}),
    },
  ]);

  return {
    artifactId: artifact.id,
    relativePath: artifact.relativePath,
    workingPath: request.targetPath,
    mimeType: artifact.mimeType,
    sizeBytes: artifact.sizeBytes,
    sha256: artifact.sha256,
  };
}
