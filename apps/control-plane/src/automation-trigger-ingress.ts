import { createHash, createHmac, randomBytes, timingSafeEqual } from "node:crypto";
import { TextDecoder } from "node:util";
import {
  LEGACY_AUTOMATION_TRIGGER_MEDIA_TYPE,
  WOLLIPOG_AUTOMATION_TRIGGER_MEDIA_TYPE,
  type AutomationTriggerDeliveryPolicy,
  type AutomationTriggerKind,
  type AutomationTriggerSessionSelector,
} from "@wollipog/protocol";
import type { FastifyInstance } from "fastify";

const SIGNATURE = /^v1=([a-f0-9]{64})$/;
const TIMESTAMP = /^(?:0|[1-9][0-9]{0,12})$/;
const NONCE = /^[A-Za-z0-9_-]{16,128}$/;
const EVENT_ID = /^[A-Za-z0-9._:-]{1,128}$/;
const PARAMETER_NAME = /^[A-Za-z][A-Za-z0-9_]{0,63}$/;
/** Current producer/documentation identity. Legacy remains accepted during the compatibility window. */
export const AUTOMATION_TRIGGER_MEDIA_TYPE = WOLLIPOG_AUTOMATION_TRIGGER_MEDIA_TYPE;
export { LEGACY_AUTOMATION_TRIGGER_MEDIA_TYPE, WOLLIPOG_AUTOMATION_TRIGGER_MEDIA_TYPE };
export const AUTOMATION_TRIGGER_MAX_BODY_BYTES = 16 * 1024;
export const AUTOMATION_TRIGGER_MAX_PROMPT_BYTES = 8 * 1024;
export const AUTOMATION_TRIGGER_MAX_PARAMETER_BYTES = 512;
export const AUTOMATION_TRIGGER_MAX_PARAMETERS = 16;
const MAX_CLOCK_SKEW_MS = 5 * 60_000;
const UTF8 = new TextDecoder("utf-8", { fatal: true });

export interface AutomationTriggerHeaders {
  timestamp?: string;
  nonce?: string;
  signature?: string;
}

export interface ParsedAutomationTriggerBody {
  eventId: string;
  senderHash?: string;
  prompt?: string;
  parameters?: Record<string, string>;
  target?: { selector: AutomationTriggerSessionSelector; value: string };
}

export function registerAutomationTriggerContentTypeParser(app: FastifyInstance): void {
  app.addContentTypeParser(
    [LEGACY_AUTOMATION_TRIGGER_MEDIA_TYPE, WOLLIPOG_AUTOMATION_TRIGGER_MEDIA_TYPE],
    { parseAs: "buffer", bodyLimit: AUTOMATION_TRIGGER_MAX_BODY_BYTES },
    (_req, body, done) => done(null, body),
  );
}

export function newAutomationTriggerSecret(): string {
  return `wollipogwhsec_${randomBytes(32).toString("base64url")}`;
}

export function automationTriggerBodySha256(body: Buffer): string {
  return createHash("sha256").update(body).digest("hex");
}

export function automationTriggerSigningInput(
  triggerId: string,
  timestamp: string,
  nonce: string,
  body: Buffer,
): string {
  return `v1\n${timestamp}\n${nonce}\n${triggerId}\n${automationTriggerBodySha256(body)}`;
}

export function signAutomationTrigger(
  secret: string,
  triggerId: string,
  timestamp: string,
  nonce: string,
  body: Buffer,
): string {
  return `v1=${createHmac("sha256", secret)
    .update(automationTriggerSigningInput(triggerId, timestamp, nonce, body), "utf8")
    .digest("hex")}`;
}

export function verifyAutomationTriggerSignature(
  secret: string,
  triggerId: string,
  headers: AutomationTriggerHeaders,
  body: Buffer,
  now = Date.now(),
): boolean {
  if (body.length < 2 || body.length > AUTOMATION_TRIGGER_MAX_BODY_BYTES || !TIMESTAMP.test(headers.timestamp ?? "") ||
      !NONCE.test(headers.nonce ?? "") || !SIGNATURE.test(headers.signature ?? "")) return false;
  const timestamp = Number(headers.timestamp) * 1_000;
  if (!Number.isSafeInteger(timestamp) || Math.abs(now - timestamp) > MAX_CLOCK_SKEW_MS) return false;
  const expected = signAutomationTrigger(secret, triggerId, headers.timestamp!, headers.nonce!, body);
  const actual = headers.signature!;
  return expected.length === actual.length && timingSafeEqual(Buffer.from(expected), Buffer.from(actual));
}

export function parseAutomationTriggerBody(
  kind: AutomationTriggerKind,
  body: Buffer,
  policy?: AutomationTriggerDeliveryPolicy,
): ParsedAutomationTriggerBody | null {
  if (body.length < 2 || body.length > AUTOMATION_TRIGGER_MAX_BODY_BYTES) return null;
  let text: string;
  try {
    text = UTF8.decode(body);
  } catch {
    return null;
  }
  const record = parseJsonRecord(text);
  if (!record) return null;
  const keys = Object.keys(record).sort();
  const base = kind === "chatops" ? ["command", "eventId", "sender"] : ["eventId"];
  const optional = policy ? [
    ...(policy.allowPrompt ? ["prompt"] : []),
    ...(policy.parameterNames.length ? ["parameters"] : []),
    ...(policy.sessionSelectors?.length ? ["target"] : []),
  ] : [];
  const allowed = new Set([...base, ...optional]);
  if (keys.some((key) => !allowed.has(key)) || base.some((key) => !keys.includes(key))) return null;
  if (typeof record.eventId !== "string" || !EVENT_ID.test(record.eventId)) return null;
  const parsed: ParsedAutomationTriggerBody = { eventId: record.eventId };
  if (kind === "chatops") {
    if (record.command !== "run" || typeof record.sender !== "string" || !record.sender ||
        record.sender.length > 256 || /[\u0000-\u001f\u007f]/.test(record.sender)) return null;
    parsed.senderHash = createHash("sha256").update(record.sender, "utf8").digest("hex");
  }
  if (record.prompt !== undefined) {
    if (typeof record.prompt !== "string" || !record.prompt.trim() ||
        Buffer.byteLength(record.prompt, "utf8") > AUTOMATION_TRIGGER_MAX_PROMPT_BYTES) return null;
    parsed.prompt = record.prompt;
  }
  if (record.parameters !== undefined) {
    if (!jsonRecord(record.parameters)) return null;
    const entries = Object.entries(record.parameters);
    const configured = new Set(policy?.parameterNames ?? []);
    if (entries.length < 1 || entries.length > AUTOMATION_TRIGGER_MAX_PARAMETERS ||
        entries.some(([name, value]) => !PARAMETER_NAME.test(name) || !configured.has(name) ||
          typeof value !== "string" || Buffer.byteLength(value, "utf8") > AUTOMATION_TRIGGER_MAX_PARAMETER_BYTES)) return null;
    parsed.parameters = Object.fromEntries(entries as Array<[string, string]>);
  }
  if (record.target !== undefined) {
    if (!jsonRecord(record.target)) return null;
    const entries = Object.entries(record.target);
    const names: Record<string, AutomationTriggerSessionSelector> = {
      sessionId: "session_id",
      branch: "branch",
      pullRequest: "pull_request",
    };
    const [entry] = entries;
    const selector = entry ? names[entry[0]] : undefined;
    const value = entry?.[1];
    if (entries.length !== 1 || !selector || !policy?.sessionSelectors?.includes(selector) ||
        typeof value !== "string" || !value.trim() || value.length > 512 ||
        (selector === "session_id" && !/^[A-Za-z0-9._:-]{1,128}$/.test(value)) ||
        (selector === "branch" && !/^[^\u0000-\u001f\u007f]{1,256}$/.test(value)) ||
        (selector === "pull_request" && !/^https:\/\/[^\s/]+\/[^\s/]+\/[^\s/]+\/pull\/\d+\/?$/.test(value))) return null;
    parsed.target = { selector, value };
  }
  return parsed;
}

interface JsonRecord {
  [key: string]: string | JsonRecord;
}

function jsonRecord(value: string | JsonRecord): value is JsonRecord {
  return typeof value === "object" && value !== null;
}

function parseJsonRecord(text: string): JsonRecord | null {
  let offset = 0;
  const whitespace = (): void => {
    while (offset < text.length && /[\u0009\u000a\u000d\u0020]/.test(text[offset]!)) offset += 1;
  };
  const string = (): string | null => {
    if (text[offset] !== '"') return null;
    const start = offset;
    offset += 1;
    let escaped = false;
    while (offset < text.length) {
      const character = text[offset]!;
      const code = text.charCodeAt(offset);
      if (!escaped && character === '"') {
        offset += 1;
        try {
          const value = JSON.parse(text.slice(start, offset)) as unknown;
          return typeof value === "string" && wellFormed(value) ? value : null;
        } catch {
          return null;
        }
      }
      if (!escaped && code < 0x20) return null;
      if (!escaped && character === "\\") escaped = true;
      else escaped = false;
      offset += 1;
    }
    return null;
  };

  const object = (depth: number): JsonRecord | null => {
    if (depth > 2 || text[offset] !== "{") return null;
    offset += 1;
    whitespace();
    const result: JsonRecord = Object.create(null) as JsonRecord;
    if (text[offset] === "}") {
      offset += 1;
      return result;
    }
    while (offset < text.length) {
      const key = string();
      if (key === null || Object.hasOwn(result, key)) return null;
      whitespace();
      if (text[offset] !== ":") return null;
      offset += 1;
      whitespace();
      const value = text[offset] === "{" ? object(depth + 1) : string();
      if (value === null) return null;
      result[key] = value;
      whitespace();
      if (text[offset] === "}") {
        offset += 1;
        return result;
      }
      if (text[offset] !== ",") return null;
      offset += 1;
      whitespace();
    }
    return null;
  };

  whitespace();
  const result = object(0);
  if (!result) return null;
  whitespace();
  return offset === text.length ? result : null;
}

function wellFormed(value: string): boolean {
  for (let index = 0; index < value.length; index += 1) {
    const code = value.charCodeAt(index);
    if (code >= 0xd800 && code <= 0xdbff) {
      const next = value.charCodeAt(index + 1);
      if (!(next >= 0xdc00 && next <= 0xdfff)) return false;
      index += 1;
    } else if (code >= 0xdc00 && code <= 0xdfff) return false;
  }
  return true;
}
