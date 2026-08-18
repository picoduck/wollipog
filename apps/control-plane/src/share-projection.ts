import { Buffer } from "node:buffer";
import {
  OPERATIONAL_TRANSCRIPT_PROJECTION_VERSION,
  type OperationalTranscriptMessage,
  type OperationalTranscriptProjection,
  type SessionEvent,
  type SessionEventPayload,
} from "@wollipog/protocol";

/** Hard defaults for one point-in-time export. Callers may lower them, never silently truncate. */
export const DEFAULT_OPERATIONAL_TRANSCRIPT_MAX_EVENTS = 10_000;
export const DEFAULT_OPERATIONAL_TRANSCRIPT_MAX_UTF8_BYTES = 8 * 1024 * 1024;

export interface OperationalTranscriptProjectionOptions {
  maxEvents?: number;
  maxUtf8Bytes?: number;
  /** Absolute workspace/worktree roots known by the authenticated caller. */
  sensitivePathPrefixes?: readonly string[];
}

export type OperationalTranscriptProjectionRejection = {
  ok: false;
  code: "event_limit" | "byte_limit" | "invalid_source";
  error: string;
  limit: number;
  actual: number;
};

export type OperationalTranscriptProjectionSuccess = {
  ok: true;
  projection: OperationalTranscriptProjection;
  canonicalJson: string;
  markdown: string;
  /** Maximum of the generated JSON and Markdown representation sizes. */
  utf8Bytes: number;
};

export type OperationalTranscriptProjectionResult =
  | OperationalTranscriptProjectionSuccess
  | OperationalTranscriptProjectionRejection;

const SECRET = "<redacted-secret>";
const PATH = "<redacted-path>";

function boundedMarker(marker: string, matchedLength: number): string {
  return marker.length <= matchedLength ? marker : "*".repeat(matchedLength);
}

const escapeRegex = (value: string): string => value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

function configuredPathPattern(prefix: string): RegExp | null {
  const trimmed = prefix.trim().replace(/[\\/]+$/, "");
  if (!trimmed) return null;
  const absolute = /^[A-Za-z]:[\\/]/.test(trimmed) || /^(?:\\\\|\/\/)[^\\/]+[\\/][^\\/]+/.test(trimmed) || /^\/(?!\/)/.test(trimmed);
  if (!absolute) return null;
  const segments = trimmed.split(/[\\/]+/).filter(Boolean).map(escapeRegex);
  if (segments.length === 0) return null;
  const root = /^[\\/]/.test(trimmed) ? String.raw`[\\/]` : "";
  const body = segments.join(String.raw`[\\/]`);
  // A configured root is authoritative. Redact it and every descendant even when it appears in
  // prose without a leading whitespace boundary. Quotes and line endings end the path conservatively.
  const caseInsensitive = /^[A-Za-z]:/.test(trimmed) || /^\/mnt\/[a-z]\//i.test(trimmed) || /^(?:\\\\|\/\/)/.test(trimmed);
  return new RegExp(`${root}${body}(?:[\\/][^\\r\\n\"'<>|]+)*`, caseInsensitive ? "gi" : "g");
}

function redactPrivateKeyBlocks(input: string): string {
  const begin = /-----BEGIN ([A-Z0-9 ]*PRIVATE KEY)-----/g;
  let cursor = 0;
  let result = "";
  while (true) {
    begin.lastIndex = cursor;
    const opening = begin.exec(input);
    if (!opening) return result + input.slice(cursor);
    result += input.slice(cursor, opening.index);
    const endMarker = `-----END ${opening[1]}-----`;
    const closingIndex = input.indexOf(endMarker, begin.lastIndex);
    const stop = closingIndex >= 0 ? closingIndex + endMarker.length : input.length;
    result += boundedMarker(SECRET, stop - opening.index);
    cursor = stop;
    if (closingIndex < 0) return result;
  }
}

/**
 * Conservative, deterministic redaction for content entering an operational projection. Structural
 * allowlisting remains the primary boundary; this catches common credentials and machine-local
 * paths inside the two text event kinds that survive it.
 */
export function redactOperationalTranscriptText(
  input: string,
  sensitivePathPrefixes: readonly string[] = [],
): string {
  let text = input;

  // Complete and unterminated private-key blocks both fail closed in one linear scan.
  text = redactPrivateKeyBlocks(text);

  // Header/cookie forms and URL userinfo are high-confidence credential containers.
  text = text.replace(/\b((?:authorization|proxy-authorization)\s*:\s*)[^\r\n]+/gi,
    (match, prefix: string) => prefix + boundedMarker(SECRET, match.length - prefix.length));
  text = text.replace(/\b((?:cookie|set-cookie)\s*:\s*)[^\r\n]+/gi,
    (match, prefix: string) => prefix + boundedMarker(SECRET, match.length - prefix.length));
  text = text.replace(/\b(https?:\/\/)[^/\s:@]+:[^/\s@]+@/gi,
    (match, scheme: string) => scheme + boundedMarker(SECRET, match.length - scheme.length - 1) + "@");
  text = text.replace(/\b(Bearer\s+)[A-Za-z0-9._~+/=-]+/gi,
    (match, prefix: string) => prefix + boundedMarker(SECRET, match.length - prefix.length));

  // Common assignment/JSON/env spellings. Preserve the non-secret key for readability.
  text = text.replace(
    /((?:--)?["']?(?:token|password|passwd|secret|api[_-]?key|access[_-]?key|client[_-]?secret|private[_-]?key)["']?\s*(?:=|:)\s*)(?:"[^"\r\n]*"|'[^'\r\n]*'|[^\s,;}\]\r\n]+)/gi,
    (match, prefix: string) => prefix + boundedMarker(SECRET, match.length - prefix.length),
  );

  // Provider-shaped tokens and JWTs can appear without a label.
  text = text.replace(/\bgh[pousr]_[A-Za-z0-9_]{20,}\b/g, (match) => boundedMarker(SECRET, match.length));
  text = text.replace(/\bsk-(?:proj-)?[A-Za-z0-9_-]{16,}\b/g, (match) => boundedMarker(SECRET, match.length));
  text = text.replace(/\bxox[baprs]-[A-Za-z0-9-]{10,}\b/g, (match) => boundedMarker(SECRET, match.length));
  text = text.replace(/\bAKIA[0-9A-Z]{16}\b/g, (match) => boundedMarker(SECRET, match.length));
  text = text.replace(/\beyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\b/g, (match) => boundedMarker(SECRET, match.length));

  // Explicit roots come from the authenticated session/workspace lookup. Longest first avoids a
  // parent root partially replacing a more specific child before it can be recognized.
  for (const prefix of [...sensitivePathPrefixes].sort((a, b) => b.length - a.length)) {
    const pattern = configuredPathPattern(prefix);
    if (pattern) text = text.replace(pattern, (match) => boundedMarker(PATH, match.length));
  }

  // Machine-local home and conventional workspace roots are sensitive even when a caller does
  // not have the source SessionView available (for example, a stored export being re-rendered).
  text = text.replace(
    /(^|[\s("'=])([A-Za-z]:[\\/](?:Users|Documents and Settings)[\\/][^\\/\s"'<>]+(?:[\\/][^\r\n"'<>|]+)*)/gim,
    (match, boundary: string, path: string) => boundary + boundedMarker(PATH, path.length),
  );
  text = text.replace(
    /(^|[\s("'=])((?:\\\\|\/\/)[^\\/\s"'<>]+[\\/][^\\/\s"'<>]+(?:[\\/][^\r\n"'<>|]+)*)/gm,
    (match, boundary: string, path: string) => boundary + boundedMarker(PATH, path.length),
  );
  text = text.replace(
    /(^|[\s("'=])((?:\/(?:home|Users)\/[^/\s"'<>]+|\/root|\/workspaces?|\/mnt\/[a-z]\/Users\/[^/\s"'<>]+)(?:\/[^\r\n"'<>]+)*)/gim,
    (match, boundary: string, path: string) => boundary + boundedMarker(PATH, path.length),
  );
  text = text.replace(/(^|[\s("'=])(~[\\/][^\s"'<>]+)/gm,
    (match, boundary: string, path: string) => boundary + boundedMarker(PATH, path.length));

  return text;
}

function publicMessages(
  events: readonly SessionEvent[],
  sensitivePathPrefixes: readonly string[],
): { ok: true; messages: OperationalTranscriptMessage[] } | { ok: false } {
  const raw: OperationalTranscriptMessage[] = [];
  let mergeableAssistantIndex: number | null = null;
  let mergeableAssistantMessageId: string | undefined;

  for (const event of [...events].sort((a, b) => a.seq - b.seq || a.id - b.id)) {
    const candidate: unknown = event.payload;
    if (!candidate || typeof candidate !== "object" || typeof (candidate as { kind?: unknown }).kind !== "string") return { ok: false };
    const payload = candidate as SessionEventPayload;
    switch (payload.kind) {
      case "user_message":
        if (typeof payload.text !== "string") return { ok: false };
        // Images and commandId are intentionally not projected.
        raw.push({ role: "user", text: payload.text });
        mergeableAssistantIndex = null;
        mergeableAssistantMessageId = undefined;
        break;
      case "agent_message":
        if (typeof payload.text !== "string") return { ok: false };
        if (Object.prototype.hasOwnProperty.call(payload, "messageId") &&
            payload.messageId !== undefined && typeof payload.messageId !== "string") return { ok: false };
        if (Object.prototype.hasOwnProperty.call(payload, "parentToolUseId") && payload.parentToolUseId !== undefined) {
          mergeableAssistantIndex = null;
          mergeableAssistantMessageId = undefined;
          break;
        }
        // Live assistant deltas are concatenated before redaction, so a credential split across
        // chunks cannot bypass pattern matching. Provider identity prevents distinct adjacent
        // messages from being joined; an absent id retains the bounded legacy adjacency path.
        // A final event is already one complete message.
        if (payload.final && payload.messageId !== undefined && mergeableAssistantIndex !== null &&
            mergeableAssistantMessageId === payload.messageId) {
          const prior = raw[mergeableAssistantIndex]!;
          raw[mergeableAssistantIndex] = { ...prior, text: payload.text };
          mergeableAssistantIndex = null;
          mergeableAssistantMessageId = undefined;
        } else if (!payload.final && mergeableAssistantIndex !== null &&
                   mergeableAssistantMessageId === payload.messageId) {
          const prior = raw[mergeableAssistantIndex]!;
          raw[mergeableAssistantIndex] = { ...prior, text: prior.text + payload.text };
        } else {
          raw.push({ role: "assistant", text: payload.text });
          mergeableAssistantIndex = payload.final ? null : raw.length - 1;
          mergeableAssistantMessageId = payload.final ? undefined : payload.messageId;
        }
        break;
      case "agent_thought":
      case "tool_call":
      case "tool_call_update":
      case "plan":
      case "command_output":
      case "file_edit":
      case "stderr":
      case "background_continuation_delivered":
      case "status":
      case "error":
      case "policy_transport":
      case "review_decision":
      case "permission_request":
      case "permission_resolved":
      case "question_request":
      case "question_resolved":
      case "checkpoint":
      case "checkpoint_restored":
      case "conversation_checkpoint":
      case "conversation_forked":
      case "token_usage":
        mergeableAssistantIndex = null;
        mergeableAssistantMessageId = undefined;
        break;
      case "turn_interrupted":
        raw.push({ role: "assistant", text: "[Turn interrupted]" });
        mergeableAssistantIndex = null;
        mergeableAssistantMessageId = undefined;
        break;
      default:
        payload satisfies never;
        return { ok: false };
    }
  }

  return { ok: true, messages: raw.map((message) => ({
    role: message.role,
    text: redactOperationalTranscriptText(message.text, sensitivePathPrefixes),
  })) };
}

/** Stable compact JSON: only protocol-defined keys are emitted, in a fixed order. */
export function canonicalOperationalTranscriptJson(projection: OperationalTranscriptProjection): string {
  const parts = [
    `{"schemaVersion":${projection.schemaVersion},"source":"${projection.source}","completeness":"${projection.completeness}","messages":[`,
  ];
  projection.messages.forEach((message, index) => {
    if (index > 0) parts.push(",");
    parts.push(`{"role":"${message.role}","text":`, JSON.stringify(message.text), "}");
  });
  parts.push("]}");
  return parts.join("");
}

function codeFenceFor(text: string): string {
  let longest = 0;
  let current = 0;
  for (const char of text) {
    if (char === "`") {
      current += 1;
      if (current > longest) longest = current;
    } else {
      current = 0;
    }
  }
  return "`".repeat(Math.max(3, longest + 1));
}

/**
 * Render message text inside dynamically sized code fences. Raw HTML, Markdown images, links,
 * headings, and fence-looking input therefore remain inert text in any CommonMark renderer.
 */
export function operationalTranscriptMarkdown(projection: OperationalTranscriptProjection): string {
  const parts = [
    "# Operationally redacted transcript export\n\n",
    "> Source: control-plane cache snapshot; possibly partial relative to runner history.\n",
    "> Message text may still contain secrets, source code, or personal data.\n",
  ];
  for (const message of projection.messages) {
    const fence = codeFenceFor(message.text);
    parts.push(
      `\n${message.role === "user" ? "## User" : "## Assistant"}\n\n${fence}text\n`,
      message.text,
      `\n${fence}\n`,
    );
  }
  return parts.join("");
}

function jsonEscapedContentUtf8Bytes(text: string): number {
  let bytes = 0;
  for (let index = 0; index < text.length; index += 1) {
    const code = text.charCodeAt(index);
    if (code === 0x22 || code === 0x5c || code === 0x08 || code === 0x09 || code === 0x0a || code === 0x0c || code === 0x0d) {
      bytes += 2;
    } else if (code <= 0x1f) {
      bytes += 6;
    } else if (code >= 0xd800 && code <= 0xdbff) {
      const next = text.charCodeAt(index + 1);
      if (next >= 0xdc00 && next <= 0xdfff) {
        bytes += 4;
        index += 1;
      } else {
        bytes += 6;
      }
    } else if (code >= 0xdc00 && code <= 0xdfff) {
      bytes += 6;
    } else if (code <= 0x7f) {
      bytes += 1;
    } else if (code <= 0x7ff) {
      bytes += 2;
    } else {
      bytes += 3;
    }
  }
  return bytes;
}

function projectedRepresentationUtf8Bytes(projection: OperationalTranscriptProjection): number {
  let jsonBytes = Buffer.byteLength(
    `{"schemaVersion":${projection.schemaVersion},"source":"${projection.source}","completeness":"${projection.completeness}","messages":[]}`,
    "utf8",
  );
  let markdownBytes = Buffer.byteLength(
    "# Operationally redacted transcript export\n\n" +
    "> Source: control-plane cache snapshot; possibly partial relative to runner history.\n" +
    "> Message text may still contain secrets, source code, or personal data.\n",
    "utf8",
  );
  projection.messages.forEach((message, index) => {
    jsonBytes += (index > 0 ? 1 : 0) + Buffer.byteLength(`{"role":"${message.role}","text":""}`, "utf8") + jsonEscapedContentUtf8Bytes(message.text);
    const fence = codeFenceFor(message.text);
    markdownBytes += Buffer.byteLength(
      `\n${message.role === "user" ? "## User" : "## Assistant"}\n\n${fence}text\n\n${fence}\n`,
      "utf8",
    ) + Buffer.byteLength(message.text, "utf8");
  });
  return Math.max(jsonBytes, markdownBytes);
}

function positiveLimit(value: number | undefined, fallback: number, name: string): number {
  const resolved = value ?? fallback;
  if (!Number.isSafeInteger(resolved) || resolved < 1) throw new RangeError(`${name} must be a positive safe integer`);
  return resolved;
}

function projectableSourceUtf8Bytes(events: readonly SessionEvent[]): number | null {
  let bytes = 0;
  for (const event of events) {
    const candidate: unknown = event.payload;
    if (!candidate || typeof candidate !== "object") return null;
    const payload = candidate as SessionEventPayload;
    if (payload.kind === "user_message") {
      if (typeof payload.text !== "string") return null;
      bytes += Buffer.byteLength(payload.text, "utf8");
    } else if (payload.kind === "agent_message") {
      if (typeof payload.text !== "string") return null;
      if (!Object.prototype.hasOwnProperty.call(payload, "parentToolUseId") || payload.parentToolUseId === undefined) {
        bytes += Buffer.byteLength(payload.text, "utf8");
      }
    }
  }
  return bytes;
}

/** Build a strict point-in-time projection, rejecting any oversized source or representation. */
export function buildOperationalTranscriptProjection(
  events: readonly SessionEvent[],
  options: OperationalTranscriptProjectionOptions = {},
): OperationalTranscriptProjectionResult {
  const maxEvents = positiveLimit(options.maxEvents, DEFAULT_OPERATIONAL_TRANSCRIPT_MAX_EVENTS, "maxEvents");
  const maxUtf8Bytes = positiveLimit(options.maxUtf8Bytes, DEFAULT_OPERATIONAL_TRANSCRIPT_MAX_UTF8_BYTES, "maxUtf8Bytes");
  if (events.length > maxEvents) {
    return {
      ok: false,
      code: "event_limit",
      error: `transcript contains ${events.length} events; maximum is ${maxEvents}`,
      limit: maxEvents,
      actual: events.length,
    };
  }

  // Check raw projectable text before concatenation/redaction/rendering. Even if a very large
  // credential would redact to one marker, accepting it would let export construction allocate
  // far beyond the declared response budget.
  const sourceUtf8Bytes = projectableSourceUtf8Bytes(events);
  if (sourceUtf8Bytes === null) {
    return { ok: false, code: "invalid_source", error: "transcript source contains an invalid event", limit: 0, actual: 0 };
  }
  if (sourceUtf8Bytes > maxUtf8Bytes) {
    return {
      ok: false,
      code: "byte_limit",
      error: `transcript source text is ${sourceUtf8Bytes} UTF-8 bytes; maximum is ${maxUtf8Bytes}`,
      limit: maxUtf8Bytes,
      actual: sourceUtf8Bytes,
    };
  }

  const projectedMessages = publicMessages(events, options.sensitivePathPrefixes ?? []);
  if (!projectedMessages.ok) {
    return { ok: false, code: "invalid_source", error: "transcript source contains an invalid event", limit: 0, actual: 0 };
  }
  const projection: OperationalTranscriptProjection = {
    schemaVersion: OPERATIONAL_TRANSCRIPT_PROJECTION_VERSION,
    source: "control-plane-cache",
    completeness: "possibly-partial",
    messages: projectedMessages.messages,
  };
  const utf8Bytes = projectedRepresentationUtf8Bytes(projection);
  if (utf8Bytes > maxUtf8Bytes) {
    return {
      ok: false,
      code: "byte_limit",
      error: `transcript representation is ${utf8Bytes} UTF-8 bytes; maximum is ${maxUtf8Bytes}`,
      limit: maxUtf8Bytes,
      actual: utf8Bytes,
    };
  }
  const canonicalJson = canonicalOperationalTranscriptJson(projection);
  const markdown = operationalTranscriptMarkdown(projection);
  return { ok: true, projection, canonicalJson, markdown, utf8Bytes };
}
