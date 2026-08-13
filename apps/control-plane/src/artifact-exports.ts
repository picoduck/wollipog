import { Buffer } from "node:buffer";
import type { WorkflowArtifact, WorkflowArtifactKind } from "@wollipog/protocol";
import type { ControlPlaneDb } from "./db.js";
import type { AuthPrincipal, HumanPrincipal } from "./identity.js";
import { validateWorkflowArtifact } from "./workflow-artifacts.js";

const MAX_STORED_ARTIFACT_TEXT_BYTES = 8 * 1024 * 1024;

export type WorkflowArtifactExportResult =
  | { ok: false; status: 404 | 422; error: string; code: "not_found" | "invalid_artifact" }
  | { ok: true; body: Buffer; filename: string; headers: Record<string, string> };

const FALLBACK_EXTENSION: Record<Exclude<WorkflowArtifactKind, "screenshot">, string> = {
  html_preview: "html",
  patch: "patch",
  review_report: "md",
  test_log: "log",
  verdict: "json",
};

export function principalCanReadWorkflowArtifact(
  db: ControlPlaneDb,
  principal: AuthPrincipal,
  artifact: { runId?: string; sessionId?: string },
): boolean {
  if (artifact.runId) {
    const scope = db.workflowRunScope(artifact.runId);
    if (!scope?.runnerId || !db.canAccessRunner(principal, scope.runnerId)) return false;
    if (scope.workspaceId && !db.canAccessWorkspace(principal, scope.runnerId, scope.workspaceId)) return false;
    return true;
  }
  return Boolean(artifact.sessionId && db.canAccessSession(principal, artifact.sessionId));
}

function storedArtifactRequest(artifact: WorkflowArtifact) {
  return {
    ...(artifact.runId ? { runId: artifact.runId } : {}),
    ...(artifact.sessionId ? { sessionId: artifact.sessionId } : {}),
    kind: artifact.kind,
    name: artifact.name,
    mimeType: artifact.mimeType,
    encoding: artifact.encoding,
    data: artifact.data,
    ...(artifact.metadata ? { metadata: artifact.metadata } : {}),
  };
}

/**
 * Return the exact validated artifact bytes as an authenticated attachment. Raw workflow artifacts
 * are intentionally not redacted; corrupt or legacy-out-of-contract rows fail closed.
 */
export function buildAuthorizedWorkflowArtifactExport(
  db: ControlPlaneDb,
  principal: HumanPrincipal,
  artifactId: string,
): WorkflowArtifactExportResult {
  let preflight: ReturnType<ControlPlaneDb["workflowArtifactExportPreflight"]>;
  try {
    preflight = db.workflowArtifactExportPreflight(artifactId);
  } catch {
    return { ok: false, status: 422, error: "artifact content is invalid", code: "invalid_artifact" };
  }
  if (!preflight || !principalCanReadWorkflowArtifact(db, principal, preflight.artifact)) {
    return { ok: false, status: 404, error: "artifact not found", code: "not_found" };
  }
  if (!Number.isSafeInteger(preflight.storedDataBytes) || preflight.storedDataBytes < 0 ||
      preflight.storedDataBytes > MAX_STORED_ARTIFACT_TEXT_BYTES) {
    return { ok: false, status: 422, error: "artifact content is invalid", code: "invalid_artifact" };
  }

  let artifact: WorkflowArtifact | null;
  try {
    artifact = db.getWorkflowArtifact(artifactId);
  } catch {
    return { ok: false, status: 422, error: "artifact content is invalid", code: "invalid_artifact" };
  }
  if (!artifact) return { ok: false, status: 404, error: "artifact not found", code: "not_found" };
  if (!principalCanReadWorkflowArtifact(db, principal, artifact)) {
    return { ok: false, status: 404, error: "artifact not found", code: "not_found" };
  }
  const validated = validateWorkflowArtifact(storedArtifactRequest(artifact));
  if (!validated.ok || validated.value.data !== artifact.data || validated.value.name !== artifact.name ||
      validated.value.sizeBytes !== artifact.sizeBytes || validated.value.sha256 !== artifact.sha256) {
    return { ok: false, status: 422, error: "artifact content is invalid", code: "invalid_artifact" };
  }

  const body = artifact.encoding === "base64"
    ? Buffer.from(artifact.data, "base64")
    : Buffer.from(artifact.data, "utf8");
  const contentType = artifact.mimeType.startsWith("text/") || artifact.mimeType === "application/json"
    ? `${artifact.mimeType}; charset=utf-8`
    : artifact.mimeType;
  const extension = artifact.kind === "screenshot"
    ? artifact.mimeType === "image/png" ? "png"
      : artifact.mimeType === "image/jpeg" || artifact.mimeType === "image/jpg" ? "jpg"
        : artifact.mimeType === "image/gif" ? "gif" : "webp"
    : FALLBACK_EXTENSION[artifact.kind];
  const fallback = `workflow-artifact-${artifact.kind}.${extension}`;
  return {
    ok: true,
    body,
    filename: fallback,
    headers: {
      "content-type": contentType,
      "content-disposition": `attachment; filename="${fallback}"`,
      "content-length": String(body.byteLength),
      "cache-control": "private, no-store",
      pragma: "no-cache",
      vary: "Authorization",
      "x-content-type-options": "nosniff",
      "content-security-policy": "sandbox; default-src 'none'; frame-ancestors 'none'",
    },
  };
}
