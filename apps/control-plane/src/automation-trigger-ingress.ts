import { createHash, createHmac, randomBytes, timingSafeEqual } from "node:crypto";
import { TextDecoder } from "node:util";
import {
  LEGACY_AUTOMATION_TRIGGER_MEDIA_TYPE,
  WOLLIPOG_AUTOMATION_TRIGGER_MEDIA_TYPE,
  type AutomationTriggerKind,
} from "@wollipog/protocol";
import type { FastifyInstance } from "fastify";

const SIGNATURE = /^v1=([a-f0-9]{64})$/;
const TIMESTAMP = /^(?:0|[1-9][0-9]{0,12})$/;
const NONCE = /^[A-Za-z0-9_-]{16,128}$/;
const EVENT_ID = /^[A-Za-z0-9._:-]{1,128}$/;
/** Current producer/documentation identity. Legacy remains accepted during the compatibility window. */
export const AUTOMATION_TRIGGER_MEDIA_TYPE = WOLLIPOG_AUTOMATION_TRIGGER_MEDIA_TYPE;
export { LEGACY_AUTOMATION_TRIGGER_MEDIA_TYPE, WOLLIPOG_AUTOMATION_TRIGGER_MEDIA_TYPE };
export const AUTOMATION_TRIGGER_MAX_BODY_BYTES = 16 * 1024;
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
): ParsedAutomationTriggerBody | null {
  if (body.length < 2 || body.length > AUTOMATION_TRIGGER_MAX_BODY_BYTES) return null;
  let text: string;
  try {
    text = UTF8.decode(body);
  } catch {
    return null;
  }
  const record = parseStringRecord(text);
  if (!record) return null;
  const keys = Object.keys(record).sort();
  const expected = kind === "chatops" ? ["command", "eventId", "sender"] : ["eventId"];
  if (keys.length !== expected.length || keys.some((key, index) => key !== expected[index])) return null;
  if (!EVENT_ID.test(record.eventId ?? "")) return null;
  if (kind === "chatops") {
    if (record.command !== "run" || !record.sender ||
        record.sender.length > 256 || /[\u0000-\u001f\u007f]/.test(record.sender)) return null;
    return {
      eventId: record.eventId!,
      senderHash: createHash("sha256").update(record.sender, "utf8").digest("hex"),
    };
  }
  return { eventId: record.eventId! };
}

function parseStringRecord(text: string): Record<string, string> | null {
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

  whitespace();
  if (text[offset] !== "{") return null;
  offset += 1;
  whitespace();
  const result: Record<string, string> = Object.create(null) as Record<string, string>;
  if (text[offset] === "}") {
    offset += 1;
    whitespace();
    return offset === text.length ? result : null;
  }
  while (offset < text.length) {
    const key = string();
    if (key === null || Object.hasOwn(result, key)) return null;
    whitespace();
    if (text[offset] !== ":") return null;
    offset += 1;
    whitespace();
    const value = string();
    if (value === null) return null;
    result[key] = value;
    whitespace();
    if (text[offset] === "}") {
      offset += 1;
      whitespace();
      return offset === text.length ? result : null;
    }
    if (text[offset] !== ",") return null;
    offset += 1;
    whitespace();
  }
  return null;
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
