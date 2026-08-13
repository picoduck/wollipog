import { createHash } from "node:crypto";
import type {
  CreateWorkflowArtifactRequest,
  WorkflowArtifactKind,
  WorkflowArtifactMetadataValue,
} from "@wollipog/protocol";
import { EVENT_PAYLOAD_CHUNK_BYTES, MAX_PROMPT_IMAGE_BYTES, PROMPT_IMAGE_MIME_TYPES } from "@wollipog/protocol";

const KIND_CONTRACT: Record<WorkflowArtifactKind, { encoding: CreateWorkflowArtifactRequest["encoding"]; mimeTypes: string[]; maxBytes: number }> = {
  html_preview: { encoding: "utf8", mimeTypes: ["text/html"], maxBytes: 2 * 1024 * 1024 },
  patch: { encoding: "utf8", mimeTypes: ["text/x-diff", "text/plain"], maxBytes: EVENT_PAYLOAD_CHUNK_BYTES },
  review_report: { encoding: "utf8", mimeTypes: ["text/markdown", "text/plain"], maxBytes: 2 * 1024 * 1024 },
  screenshot: { encoding: "base64", mimeTypes: [...PROMPT_IMAGE_MIME_TYPES], maxBytes: MAX_PROMPT_IMAGE_BYTES },
  test_log: { encoding: "utf8", mimeTypes: ["text/plain"], maxBytes: EVENT_PAYLOAD_CHUNK_BYTES },
  verdict: { encoding: "json", mimeTypes: ["application/json"], maxBytes: 256 * 1024 },
};

export type ValidatedWorkflowArtifact = CreateWorkflowArtifactRequest & { sizeBytes: number; sha256: string };
export type ArtifactValidation = { ok: true; value: ValidatedWorkflowArtifact } | { ok: false; error: string };

export function screenshotBytesMatchMime(mimeType: string, bytes: Buffer): boolean {
  if (mimeType === "image/png") {
    return bytes.length >= 8 && bytes.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]));
  }
  if (mimeType === "image/jpeg" || mimeType === "image/jpg") {
    return bytes.length >= 3 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff;
  }
  if (mimeType === "image/gif") {
    const signature = bytes.length >= 6 ? bytes.subarray(0, 6).toString("ascii") : "";
    return signature === "GIF87a" || signature === "GIF89a";
  }
  return mimeType === "image/webp" && bytes.length >= 12 &&
    bytes.subarray(0, 4).toString("ascii") === "RIFF" && bytes.subarray(8, 12).toString("ascii") === "WEBP";
}

export function validateWorkflowArtifact(input: unknown): ArtifactValidation {
  if (!input || typeof input !== "object" || Array.isArray(input)) return { ok: false, error: "artifact must be an object" };
  const raw = input as Record<string, unknown>;
  const allowed = new Set(["runId", "sessionId", "kind", "name", "mimeType", "encoding", "data", "metadata"]);
  if (Object.keys(raw).some((key) => !allowed.has(key))) return { ok: false, error: "artifact contains unsupported fields" };
  const boundedId = (value: unknown) => value === undefined || (typeof value === "string" && value.length > 0 && value.length <= 256);
  if (!boundedId(raw.runId) || !boundedId(raw.sessionId) || (!raw.runId && !raw.sessionId)) {
    return { ok: false, error: "artifact requires a bounded runId or sessionId" };
  }
  if (typeof raw.kind !== "string" || !(raw.kind in KIND_CONTRACT)) return { ok: false, error: "unsupported artifact kind" };
  const contract = KIND_CONTRACT[raw.kind as WorkflowArtifactKind];
  if (typeof raw.name !== "string" || !raw.name.trim() || raw.name.length > 160 || /[\\/\x00-\x1f]/.test(raw.name)) {
    return { ok: false, error: "artifact name must be 1-160 characters without paths or controls" };
  }
  if (typeof raw.encoding !== "string" || raw.encoding !== contract.encoding) {
    return { ok: false, error: `${raw.kind} artifacts require ${contract.encoding} encoding` };
  }
  if (typeof raw.mimeType !== "string" || !contract.mimeTypes.includes(raw.mimeType)) {
    return { ok: false, error: `${raw.kind} artifact MIME type is not allowed` };
  }
  if (typeof raw.data !== "string") return { ok: false, error: "artifact data must be a string" };

  let data = raw.data;
  let bytes: Buffer;
  if (contract.encoding === "base64") {
    if (data.length > Math.ceil(contract.maxBytes / 3) * 4) return { ok: false, error: `${raw.kind} artifact exceeds its size limit` };
    if (!data || data.length % 4 !== 0 || !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(data)) {
      return { ok: false, error: "artifact data is not canonical base64" };
    }
    bytes = Buffer.from(data, "base64");
    if (bytes.toString("base64") !== data) return { ok: false, error: "artifact data is not canonical base64" };
    if (!screenshotBytesMatchMime(raw.mimeType as string, bytes)) {
      return { ok: false, error: "screenshot bytes do not match the declared MIME type" };
    }
  } else if (contract.encoding === "json") {
    if (data.length > contract.maxBytes) return { ok: false, error: `${raw.kind} artifact exceeds its size limit` };
    try {
      const parsed = JSON.parse(data) as unknown;
      if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return { ok: false, error: "verdict data must be a JSON object" };
      data = JSON.stringify(parsed);
    } catch {
      return { ok: false, error: "verdict data must be valid JSON" };
    }
    bytes = Buffer.from(data, "utf8");
  } else {
    if (data.length > contract.maxBytes) return { ok: false, error: `${raw.kind} artifact exceeds its size limit` };
    bytes = Buffer.from(data, "utf8");
  }
  if (bytes.length > contract.maxBytes) return { ok: false, error: `${raw.kind} artifact exceeds its size limit` };

  let metadata: Record<string, WorkflowArtifactMetadataValue> | undefined;
  if (raw.metadata !== undefined) {
    if (!raw.metadata || typeof raw.metadata !== "object" || Array.isArray(raw.metadata)) return { ok: false, error: "artifact metadata must be an object" };
    const entries = Object.entries(raw.metadata);
    if (entries.length > 32 || entries.some(([key, value]) =>
      !/^[A-Za-z][A-Za-z0-9_.-]{0,63}$/.test(key) || ["__proto__", "prototype", "constructor"].includes(key) ||
      (value !== null && typeof value !== "string" && typeof value !== "number" && typeof value !== "boolean") ||
      (typeof value === "number" && !Number.isFinite(value)) ||
      (typeof value === "string" && value.length > 2048))) {
      return { ok: false, error: "artifact metadata contains invalid keys or values" };
    }
    metadata = Object.fromEntries(entries) as Record<string, WorkflowArtifactMetadataValue>;
    if (Buffer.byteLength(JSON.stringify(metadata), "utf8") > 16 * 1024) return { ok: false, error: "artifact metadata exceeds its size limit" };
  }

  return {
    ok: true,
    value: {
      ...(typeof raw.runId === "string" ? { runId: raw.runId } : {}),
      ...(typeof raw.sessionId === "string" ? { sessionId: raw.sessionId } : {}),
      kind: raw.kind as WorkflowArtifactKind,
      name: raw.name.trim(),
      mimeType: raw.mimeType,
      encoding: contract.encoding,
      data,
      ...(metadata ? { metadata } : {}),
      sizeBytes: bytes.length,
      sha256: createHash("sha256").update(bytes).digest("hex"),
    },
  };
}
