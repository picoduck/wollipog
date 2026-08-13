import type { WorkflowArtifactView } from "@wollipog/protocol";

export type ArtifactPreviewClass = "html" | "image" | "json" | "markdown" | "text" | "unsupported";

const MAX_BROWSER_URL_LENGTH = 2_048;
const HTML_PREVIEW_CSP = "default-src 'none'; img-src data: blob:; style-src 'unsafe-inline'; font-src data:; form-action 'none'; base-uri 'none'";

export type BrowserUrlResult = { ok: true; url: string } | { ok: false; error: string };

/** Admit only explicit web URLs. The browser pane is not a search box or a credential forwarder. */
export function normalizeBrowserUrl(input: string): BrowserUrlResult {
  const value = input.trim();
  if (!value) return { ok: false, error: "Enter an http:// or https:// URL." };
  if (value.length > MAX_BROWSER_URL_LENGTH || /[\u0000-\u001f\u007f]/.test(value)) {
    return { ok: false, error: "URL is too long or contains control characters." };
  }
  let parsed: URL;
  try {
    parsed = new URL(value);
  } catch {
    return { ok: false, error: "Enter a complete http:// or https:// URL." };
  }
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
    return { ok: false, error: "Only http:// and https:// URLs can be previewed." };
  }
  if (parsed.username || parsed.password) return { ok: false, error: "URLs containing credentials are not allowed." };
  return { ok: true, url: parsed.href };
}

export function classifyArtifactPreview(artifact: Pick<WorkflowArtifactView, "kind" | "mimeType" | "encoding">): ArtifactPreviewClass {
  if (artifact.kind === "html_preview" && artifact.mimeType === "text/html" && artifact.encoding === "utf8") return "html";
  if (artifact.kind === "screenshot" && artifact.mimeType.startsWith("image/") && artifact.encoding === "base64") return "image";
  if (artifact.kind === "verdict" && artifact.mimeType === "application/json" && artifact.encoding === "json") return "json";
  if (artifact.kind === "review_report" && artifact.mimeType === "text/markdown" && artifact.encoding === "utf8") return "markdown";
  if (artifact.encoding === "utf8" && (
    (artifact.kind === "patch" && ["text/x-diff", "text/plain"].includes(artifact.mimeType)) ||
    (artifact.kind === "review_report" && artifact.mimeType === "text/plain") ||
    (artifact.kind === "test_log" && artifact.mimeType === "text/plain")
  )) return "text";
  return "unsupported";
}

function mediaType(value: string): string {
  return value.split(";", 1)[0]!.trim().toLowerCase();
}

export async function sha256Hex(bytes: ArrayBuffer): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", bytes);
  return Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, "0")).join("");
}

/** Validate the exact authenticated response before any bytes reach a renderer. */
export async function verifyArtifactPreviewBlob(artifact: WorkflowArtifactView, blob: Blob): Promise<ArrayBuffer> {
  if (!Number.isSafeInteger(artifact.sizeBytes) || artifact.sizeBytes < 0 || blob.size !== artifact.sizeBytes) {
    throw new Error("Artifact preview length does not match its immutable metadata.");
  }
  if (mediaType(blob.type) !== mediaType(artifact.mimeType)) {
    throw new Error("Artifact preview MIME type does not match its immutable metadata.");
  }
  const bytes = await blob.arrayBuffer();
  if ((await sha256Hex(bytes)) !== artifact.sha256.toLowerCase()) {
    throw new Error("Artifact preview digest does not match its immutable metadata.");
  }
  return bytes;
}

function escapeAttribute(value: string): string {
  return value.replaceAll("&", "&amp;").replaceAll('"', "&quot;");
}

/** Prefix the untrusted document with a non-relaxable, no-network policy. The iframe adds a
 * second boundary by omitting allow-scripts and allow-same-origin. */
export function sandboxHtmlDocument(source: string): string {
  return `<!doctype html><meta charset="utf-8"><meta http-equiv="Content-Security-Policy" content="${escapeAttribute(HTML_PREVIEW_CSP)}">${source}`;
}
