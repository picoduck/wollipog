import { createHash, randomUUID } from "node:crypto";
import {
  EVENT_PAYLOAD_CHUNK_BYTES,
  EVENT_PAYLOAD_MAX_BYTES,
  EVENT_PAYLOAD_PREVIEW_BYTES,
  validateEventPayloadReferences,
  type EventPayloadReference,
  type SessionEventPayload,
  type WorkflowArtifactView,
} from "@wollipog/protocol";
import { artifactBlobSha256Async } from "./artifact-blob-store.js";
import type { ControlPlaneDb } from "./db.js";

type EventPayloadDb = Pick<ControlPlaneDb, "createWorkflowArtifactBytes" | "deleteWorkflowArtifact">;
type EventPayloadStagingDb = Pick<
  ControlPlaneDb,
  "stageArtifactBlob" | "releaseStagedArtifactBlob" | "createStagedEventPayloadArtifacts"
>;
type ArtifactIdForChunk = (index: number, sha256: string) => string;

const defaultArtifactIdForChunk: ArtifactIdForChunk = () =>
  `art_${randomUUID().replace(/-/g, "").slice(0, 16)}`;

export interface ExternalizedSessionEventPayload {
  payload: SessionEventPayload;
  artifactIds: string[];
}

interface EventTextField {
  field: "text" | "diff";
  refsField: "textRefs" | "diffRefs";
  value: string;
  mimeType: EventPayloadReference["mimeType"];
  artifactKind: "test_log" | "patch";
}

function eventTextField(payload: SessionEventPayload): EventTextField | null {
  switch (payload.kind) {
    case "tool_call":
    case "tool_call_update":
    case "command_output":
    case "stderr":
      return { field: "text", refsField: "textRefs", value: payload.text ?? "", mimeType: "text/plain", artifactKind: "test_log" };
    case "file_edit":
      return { field: "diff", refsField: "diffRefs", value: payload.diff ?? "", mimeType: "text/x-diff", artifactKind: "patch" };
    default:
      return null;
  }
}

function continuationByte(value: number): boolean {
  return (value & 0xc0) === 0x80;
}

function utf8Prefix(bytes: Buffer, maxBytes: number): string {
  let end = Math.min(bytes.byteLength, Math.max(0, maxBytes));
  if (end < bytes.byteLength) while (end > 0 && continuationByte(bytes[end]!)) end -= 1;
  return bytes.subarray(0, end).toString("utf8");
}

function utf8Suffix(bytes: Buffer, maxBytes: number): string {
  let start = Math.max(0, bytes.byteLength - Math.max(0, maxBytes));
  while (start < bytes.byteLength && continuationByte(bytes[start]!)) start += 1;
  return bytes.subarray(start).toString("utf8");
}

export function eventPayloadPreview(bytes: Buffer, chunkCount: number): string {
  const marker = `\n\n… [${bytes.byteLength} UTF-8 bytes externalized in ${chunkCount} artifact chunk${chunkCount === 1 ? "" : "s"}; load full content] …\n\n`;
  const markerBytes = Buffer.byteLength(marker, "utf8");
  const available = Math.max(0, EVENT_PAYLOAD_PREVIEW_BYTES - markerBytes);
  const headBudget = Math.floor(available * 0.75);
  const tailBudget = available - headBudget;
  const preview = `${utf8Prefix(bytes, headBudget)}${marker}${utf8Suffix(bytes, tailBudget)}`;
  if (Buffer.byteLength(preview, "utf8") > EVENT_PAYLOAD_PREVIEW_BYTES) {
    throw new Error("event payload preview exceeded its byte limit");
  }
  return preview;
}

export function splitEventPayloadBytes(bytes: Buffer): Buffer[] {
  if (!bytes.byteLength || bytes.byteLength > EVENT_PAYLOAD_MAX_BYTES) {
    throw new RangeError(`event payload must contain 1-${EVENT_PAYLOAD_MAX_BYTES} UTF-8 bytes`);
  }
  const chunks: Buffer[] = [];
  let start = 0;
  while (start < bytes.byteLength) {
    let end = Math.min(bytes.byteLength, start + EVENT_PAYLOAD_CHUNK_BYTES);
    if (end < bytes.byteLength) while (end > start && continuationByte(bytes[end]!)) end -= 1;
    if (end <= start) throw new Error("event payload could not be split on a UTF-8 boundary");
    chunks.push(bytes.subarray(start, end));
    start = end;
  }
  return chunks;
}

function eventPayloadArtifact(
  sessionId: string,
  payload: SessionEventPayload,
  field: EventTextField,
  chunk: { index: number; count: number; sizeBytes: number; sha256: string; artifactId: string },
  createdAt: number,
): WorkflowArtifactView {
  return {
    artifactId: chunk.artifactId,
    sessionId,
    kind: field.artifactKind,
    name: `session-event-${payload.kind}-${field.field}-${chunk.index + 1}.${field.artifactKind === "patch" ? "diff" : "txt"}`,
    mimeType: field.mimeType,
    encoding: "utf8",
    sizeBytes: chunk.sizeBytes,
    sha256: chunk.sha256,
    createdBy: { kind: "system", id: "event-payload" },
    metadata: {
      purpose: "session_event_payload",
      eventKind: payload.kind,
      field: field.field,
      chunkIndex: chunk.index,
      chunkCount: chunk.count,
    },
    createdAt,
  };
}

function externalizedPayload(
  payload: SessionEventPayload,
  field: EventTextField,
  preview: string,
  artifacts: readonly WorkflowArtifactView[],
): SessionEventPayload {
  const references: EventPayloadReference[] = artifacts.map((artifact) => ({
    artifactId: artifact.artifactId,
    mimeType: field.mimeType,
    encoding: "utf8",
    sizeBytes: artifact.sizeBytes,
    sha256: artifact.sha256,
  }));
  return {
    ...payload,
    [field.field]: preview,
    [field.refsField]: references,
  } as SessionEventPayload;
}

/** The UTF-8 size of a payload's eligible field when it is too large to stay inline, else 0. */
export function externalizableEventPayloadBytes(payload: SessionEventPayload): number {
  const field = eventTextField(payload);
  const bytes = field ? Buffer.byteLength(field.value, "utf8") : 0;
  return bytes > EVENT_PAYLOAD_PREVIEW_BYTES ? bytes : 0;
}

/** Externalize one eligible field. Callers own event persistence and must delete artifactIds if
 * the later event write does not commit. This function cleans every partial creation itself.
 * It writes and flushes each blob on the calling thread; the event loop stages instead. */
export function externalizeSessionEventPayload(
  db: EventPayloadDb,
  sessionId: string,
  payload: SessionEventPayload,
  createdAt: number,
  artifactIdForChunk: ArtifactIdForChunk = defaultArtifactIdForChunk,
): ExternalizedSessionEventPayload {
  const field = eventTextField(payload);
  if (!field) return { payload, artifactIds: [] };
  const bytes = Buffer.from(field.value, "utf8");
  if (bytes.byteLength <= EVENT_PAYLOAD_PREVIEW_BYTES) {
    const suppliedReferences = (payload as unknown as Record<string, unknown>)[field.refsField];
    if (suppliedReferences === undefined || validateEventPayloadReferences(suppliedReferences, field.mimeType).ok) {
      return { payload, artifactIds: [] };
    }
    const sanitized = { ...payload } as unknown as Record<string, unknown>;
    delete sanitized[field.refsField];
    return { payload: sanitized as unknown as SessionEventPayload, artifactIds: [] };
  }
  const chunks = splitEventPayloadBytes(bytes);
  const artifacts: WorkflowArtifactView[] = [];
  try {
    for (let index = 0; index < chunks.length; index++) {
      const chunk = chunks[index]!;
      const sha256 = createHash("sha256").update(chunk).digest("hex");
      const artifact = eventPayloadArtifact(sessionId, payload, field, {
        index, count: chunks.length, sizeBytes: chunk.byteLength, sha256,
        artifactId: artifactIdForChunk(index, sha256),
      }, createdAt);
      db.createWorkflowArtifactBytes(artifact, chunk);
      artifacts.push(artifact);
    }
  } catch (error) {
    cleanupEventPayloadArtifacts(db, artifacts.map((artifact) => artifact.artifactId));
    throw error;
  }
  return {
    payload: externalizedPayload(payload, field, eventPayloadPreview(bytes, chunks.length), artifacts),
    artifactIds: artifacts.map((artifact) => artifact.artifactId),
  };
}

/** A large payload whose chunk blobs are already durable on disk, awaiting its event write. */
export interface StagedSessionEventPayload {
  /** Commit the chunks' artifact rows and return the payload to persist. Like
   * externalizeSessionEventPayload, the caller deletes artifactIds if the event write fails. */
  commit(): ExternalizedSessionEventPayload;
  /** End the staging; blobs that no committed row references are removed. Idempotent, and
   * required after commit too. */
  release(): void;
}

/** The asynchronous counterpart of externalizeSessionEventPayload, for a payload that
 * externalizableEventPayloadBytes measures as too large to stay inline (#2794). Hashing, writing
 * and flushing run on the thread pool; only once every chunk is durable may commit() write rows
 * that reference it. */
export async function stageSessionEventPayload(
  db: EventPayloadStagingDb,
  sessionId: string,
  payload: SessionEventPayload,
  createdAt: number,
  artifactIdForChunk: ArtifactIdForChunk = defaultArtifactIdForChunk,
): Promise<StagedSessionEventPayload> {
  const field = eventTextField(payload);
  if (!field) throw new Error(`a ${payload.kind} event has no externalizable field`);
  const bytes = Buffer.from(field.value, "utf8");
  if (bytes.byteLength <= EVENT_PAYLOAD_PREVIEW_BYTES) throw new Error("event payload fits inline");
  const chunks = splitEventPayloadBytes(bytes);
  const preview = eventPayloadPreview(bytes, chunks.length);
  const sizes = chunks.map((chunk) => chunk.byteLength);
  const digests = await Promise.all(chunks.map((chunk) => artifactBlobSha256Async(chunk)));
  let released = false;
  const release = () => {
    if (released) return;
    released = true;
    for (const digest of digests) db.releaseStagedArtifactBlob(digest);
  };
  // Settle every staging before releasing, so release() pairs with each call exactly once.
  const stagings = chunks.map((chunk, index) => db.stageArtifactBlob(digests[index]!, chunk, createdAt));
  const outcomes = await Promise.allSettled(stagings);
  const failed = outcomes.find((outcome) => outcome.status === "rejected");
  if (failed) {
    release();
    throw failed.reason;
  }
  return {
    commit() {
      if (released) throw new Error("staged event payload was already released");
      // Holds no copy of the bytes: only the preview, sizes and digests outlive staging.
      const artifacts = sizes.map((sizeBytes, index) => eventPayloadArtifact(sessionId, payload, field, {
        index, count: sizes.length, sizeBytes, sha256: digests[index]!,
        artifactId: artifactIdForChunk(index, digests[index]!),
      }, createdAt));
      db.createStagedEventPayloadArtifacts(artifacts);
      return {
        payload: externalizedPayload(payload, field, preview, artifacts),
        artifactIds: artifacts.map((artifact) => artifact.artifactId),
      };
    },
    release,
  };
}

export function cleanupEventPayloadArtifacts(db: Pick<ControlPlaneDb, "deleteWorkflowArtifact">, artifactIds: readonly string[]): void {
  for (const artifactId of artifactIds) {
    try {
      db.deleteWorkflowArtifact(artifactId);
    } catch {
      // Startup orphan recovery owns any artifact a failed immediate cleanup could not remove.
    }
  }
}
