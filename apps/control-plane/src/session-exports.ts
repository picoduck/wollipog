import { Buffer } from "node:buffer";
import type { OperationalTranscriptProjection, SessionEvent } from "@wollipog/protocol";
import { ControlPlaneDb } from "./db.js";
import type { AuthPrincipal } from "./identity.js";
import {
  DEFAULT_OPERATIONAL_TRANSCRIPT_MAX_EVENTS,
  DEFAULT_OPERATIONAL_TRANSCRIPT_MAX_UTF8_BYTES,
  buildOperationalTranscriptProjection,
} from "./share-projection.js";

export type TranscriptExportFormat = "json" | "markdown";

/** Bounds complete raw event payloads before JSON parsing. The rendered output has its own 8 MiB cap. */
export const DEFAULT_OPERATIONAL_TRANSCRIPT_MAX_SOURCE_BYTES = 16 * 1024 * 1024;

export interface TranscriptExportLimits {
  maxEvents?: number;
  maxSourceBytes?: number;
  maxUtf8Bytes?: number;
}

export type TranscriptExportResult =
  | { ok: false; status: 404 | 413 | 422; error: string; code: "not_found" | "event_limit" | "source_byte_limit" | "byte_limit" | "invalid_source" }
  | {
      ok: true;
      body: Buffer;
      format: TranscriptExportFormat;
      projection: OperationalTranscriptProjection;
      throughSeq: number;
      headers: Record<string, string>;
    };

function positiveLimit(value: number | undefined, fallback: number, name: string): number {
  const resolved = value ?? fallback;
  if (!Number.isSafeInteger(resolved) || resolved < 1) throw new RangeError(`${name} must be a positive safe integer`);
  return resolved;
}

/**
 * Export one immutable high-water snapshot of the control-plane's persisted event cache.
 * This deliberately does not hydrate runner history: the runner RPC is currently unbounded and
 * hydration is not awaitably single-flight. Callers must describe the result as cached/possibly partial.
 */
export function buildSessionTranscriptExport(
  db: ControlPlaneDb,
  sessionId: string,
  format: TranscriptExportFormat,
  limits: TranscriptExportLimits = {},
): TranscriptExportResult {
  if (!db.getSession(sessionId)) {
    return { ok: false, status: 404, error: "session not found", code: "not_found" };
  }

  const maxEvents = positiveLimit(limits.maxEvents, DEFAULT_OPERATIONAL_TRANSCRIPT_MAX_EVENTS, "maxEvents");
  const maxSourceBytes = positiveLimit(
    limits.maxSourceBytes,
    DEFAULT_OPERATIONAL_TRANSCRIPT_MAX_SOURCE_BYTES,
    "maxSourceBytes",
  );
  const maxUtf8Bytes = positiveLimit(
    limits.maxUtf8Bytes,
    DEFAULT_OPERATIONAL_TRANSCRIPT_MAX_UTF8_BYTES,
    "maxUtf8Bytes",
  );
  const snapshot = db.sessionEventSnapshot(sessionId);
  if (snapshot.eventCount > maxEvents) {
    return {
      ok: false,
      status: 413,
      error: `transcript snapshot contains ${snapshot.eventCount} events; maximum is ${maxEvents}`,
      code: "event_limit",
    };
  }
  if (snapshot.sourceBytes > maxSourceBytes) {
    return {
      ok: false,
      status: 413,
      error: `transcript snapshot source is ${snapshot.sourceBytes} UTF-8 bytes; maximum is ${maxSourceBytes}`,
      code: "source_byte_limit",
    };
  }

  let events: SessionEvent[];
  try {
    events = db.listTranscriptEventsThrough(sessionId, snapshot.throughSeq, snapshot.eventCount);
  } catch {
    return { ok: false, status: 422, error: "transcript source contains an invalid event", code: "invalid_source" };
  }
  const rendered = buildOperationalTranscriptProjection(events, {
    maxEvents,
    maxUtf8Bytes,
    sensitivePathPrefixes: db.sessionSensitivePaths(sessionId),
  });
  if (!rendered.ok) {
    return { ok: false, status: rendered.code === "invalid_source" ? 422 : 413, error: rendered.error, code: rendered.code };
  }

  const text = format === "json" ? rendered.canonicalJson : rendered.markdown;
  const body = Buffer.from(text, "utf8");
  const extension = format === "json" ? "json" : "md";
  const headers: Record<string, string> = {
    "content-type": format === "json" ? "application/json; charset=utf-8" : "text/markdown; charset=utf-8",
    "content-disposition": `attachment; filename="session-transcript-operationally-redacted.${extension}"`,
    "content-length": String(body.byteLength),
    "cache-control": "private, no-store",
    pragma: "no-cache",
    "x-content-type-options": "nosniff",
  };
  if (format === "markdown") headers["content-security-policy"] = "sandbox";
  return { ok: true, body, format, projection: rendered.projection, throughSeq: snapshot.throughSeq, headers };
}

/** Defense-in-depth session scope check kept beside the read so denied calls cannot touch events. */
export function buildAuthorizedSessionTranscriptExport(
  db: ControlPlaneDb,
  principal: AuthPrincipal,
  sessionId: string,
  format: TranscriptExportFormat,
  limits: TranscriptExportLimits = {},
): TranscriptExportResult {
  if (!db.canAccessSession(principal, sessionId)) {
    return { ok: false, status: 404, error: "session not found", code: "not_found" };
  }
  return buildSessionTranscriptExport(db, sessionId, format, limits);
}
