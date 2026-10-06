import type { WorkflowArtifactKind } from "@wollipog/protocol";

/** Never let an agent-authored display name choose an executable download extension. */
export function artifactDownloadFilename(kind: WorkflowArtifactKind, mimeType: string): string {
  const extension = kind === "screenshot"
    ? mimeType === "image/png" ? "png"
      : mimeType === "image/jpeg" || mimeType === "image/jpg" ? "jpg"
        : mimeType === "image/gif" ? "gif" : mimeType === "image/webp" ? "webp" : "bin"
    : kind === "video" ? mimeType === "video/mp4" ? "mp4" : mimeType === "video/webm" ? "webm" : "bin"
    : kind === "html_preview" ? "html"
      : kind === "patch" ? "patch"
      : kind === "review_report" ? "md"
        : kind === "test_log" ? "log"
          : "json";
  return `workflow-artifact-${kind}.${extension}`;
}
