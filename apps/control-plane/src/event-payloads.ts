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
import type { ControlPlaneDb } from "./db.js";

type EventPayloadDb = Pick<ControlPlaneDb, "createWorkflowArtifactBytes" | "deleteWorkflowArtifact">;

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

/** Externalize one eligible field. Callers own event persistence and must delete artifactIds if
 * the later event write does not commit. This function cleans every partial creation itself. */
export function externalizeSessionEventPayload(
  db: EventPayloadDb,
  sessionId: string,
  payload: SessionEventPayload,
  createdAt: number,
  artifactIdForChunk: (index: number, sha256: string) => string = () =>
    `art_${randomUUID().replace(/-/g, "").slice(0, 16)}`,
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
  const references: EventPayloadReference[] = [];
  const artifactIds: string[] = [];
  try {
    for (let index = 0; index < chunks.length; index++) {
      const chunk = chunks[index]!;
      const sha256 = createHash("sha256").update(chunk).digest("hex");
      const artifactId = artifactIdForChunk(index, sha256);
      const artifact: WorkflowArtifactView = {
        artifactId,
        sessionId,
        kind: field.artifactKind,
        name: `session-event-${payload.kind}-${field.field}-${index + 1}.${field.artifactKind === "patch" ? "diff" : "txt"}`,
        mimeType: field.mimeType,
        encoding: "utf8",
        sizeBytes: chunk.byteLength,
        sha256,
        createdBy: { kind: "system", id: "event-payload" },
        metadata: {
          purpose: "session_event_payload",
          eventKind: payload.kind,
          field: field.field,
          chunkIndex: index,
          chunkCount: chunks.length,
        },
        createdAt,
      };
      db.createWorkflowArtifactBytes(artifact, chunk);
      artifactIds.push(artifactId);
      references.push({
        artifactId,
        mimeType: field.mimeType,
        encoding: "utf8",
        sizeBytes: chunk.byteLength,
        sha256,
      });
    }
  } catch (error) {
    cleanupEventPayloadArtifacts(db, artifactIds);
    throw error;
  }
  return {
    payload: {
      ...payload,
      [field.field]: eventPayloadPreview(bytes, chunks.length),
      [field.refsField]: references,
    } as SessionEventPayload,
    artifactIds,
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
