import type { ControlPlaneDb } from "./db.js";

export type RunnerPromptImageResult =
  | { ok: false; status: 401 | 404 | 422; error: string }
  | { ok: true; body: Buffer; mimeType: string };

/** Authenticate, scope, and verify a prompt-image read before any bytes leave the blob store. */
export function runnerPromptImage(
  db: Pick<ControlPlaneDb,
    "verifyActiveRunnerCredential" | "getSession" | "workflowArtifactExportPreflight" |
    "readWorkflowArtifactBytes" | "sessionForkIncludesAncestor">,
  runnerId: string,
  sessionId: string,
  artifactId: string,
  tokenHash: string | null,
): RunnerPromptImageResult {
  if (!tokenHash || !db.verifyActiveRunnerCredential(runnerId, tokenHash)) {
    return { ok: false, status: 401, error: "active runner credential required" };
  }
  const session = db.getSession(sessionId);
  if (!session || session.runnerId !== runnerId) return { ok: false, status: 404, error: "artifact not found" };
  let preflight: ReturnType<ControlPlaneDb["workflowArtifactExportPreflight"]>;
  try {
    preflight = db.workflowArtifactExportPreflight(artifactId);
  } catch {
    return { ok: false, status: 422, error: "artifact content is invalid" };
  }
  const artifact = preflight?.artifact;
  const authorized = artifact?.sessionId === sessionId ||
    Boolean(artifact?.sessionId && db.sessionForkIncludesAncestor(sessionId, artifact.sessionId)) ||
    Boolean(session.runId && artifact?.runId === session.runId);
  if (!artifact || artifact.kind !== "screenshot" || artifact.encoding !== "base64" || !authorized) {
    return { ok: false, status: 404, error: "artifact not found" };
  }
  try {
    const body = db.readWorkflowArtifactBytes(artifactId);
    return body
      ? { ok: true, body, mimeType: artifact.mimeType }
      : { ok: false, status: 404, error: "artifact not found" };
  } catch {
    return { ok: false, status: 422, error: "artifact content is invalid" };
  }
}
