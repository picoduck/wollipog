/**
 * Reduce a provider request-validation rejection to a content-free structural shape, so an
 * unrecognized one can be evidenced later without retaining anything the provider said.
 *
 * The safety property is compositional, not filtering: EVERY element of the result is drawn from a
 * finite set this module defines. A path segment is `input[N]`, a known field name, or `<field>`;
 * a phrase is one of the literals listed below. Nothing derived from the message's own bytes is
 * reproduced.
 *
 * Measured sizes were deliberately dropped. Within one opaque string there is no sound way to tell
 * provider-generated text from user content the provider echoed back, so any grammar for extracting
 * "the limit" can be mimicked by content that contains the same words — `unsupported value
 * 'tokens 123456789'` is indistinguishable from a real token limit by proximity, and a cap on how
 * many numbers are kept only bounds how much leaks. Sizes are not needed here anyway: this journal
 * answers "which rejection shapes exist", and a classifier case added later carries its own exact
 * anchored matcher, as `classifyPoisonedProviderHistory` already does.
 *
 * Scope is deliberately narrow. Only a rejection naming an indexed item in the request's own input
 * — the shape of "something in your stored conversation is unacceptable" — produces a shape at all.
 * A rate limit, a transport failure, an authentication error, or a refusal has no such path and is
 * ignored, because widening the history quarantine is the only question this evidence answers.
 */

/** Diagnostic vocabulary. Only these exact phrases are ever retained from a provider message. */
const RECOGNIZED_PHRASES = [
  "string too long",
  "string too short",
  "array too long",
  "array too short",
  "maximum length",
  "minimum length",
  "is required",
  "is not allowed",
  "unknown parameter",
  "additional properties",
  "unsupported value",
  "unsupported parameter",
  "invalid value",
  "invalid type",
  "expected a string",
  "expected an object",
  "expected an array",
  "must be",
  "malformed",
  "exceeds",
  "too large",
] as const;

/** An indexed item in the request input, with its field path. */
const INDEXED_ITEM_PATH = /\binput\[(?:\d{1,10})\](?:\[\d{1,10}\]|\.[A-Za-z_][A-Za-z0-9_]{0,63}){0,8}/;

/**
 * Field names this module will name in its output. Everything else becomes `<field>`.
 *
 * Restricting a segment's characters and length does NOT make it content-free: a secret made of
 * word characters passes such a filter unchanged. Only a fixed vocabulary does, so a segment is
 * either one this module already knew about or it is not reproduced at all.
 */
const RECOGNIZED_FIELDS = new Set([
  "annotations", "arguments", "call_id", "content", "data", "detail", "encrypted_content",
  "file_data", "file_id", "file_url", "function", "id", "image_url", "input", "input_audio",
  "instructions", "messages", "metadata", "name", "output", "output_text", "parameters", "path",
  "reasoning", "refusal", "role", "status", "summary", "text", "tool_calls", "tool_choice",
  "tools", "type", "url",
]);
const REDACTED_FIELD = "<field>";

const MAX_PHRASES = 6;

export interface ProviderRejectionShape {
  /** Structural path with every index normalized, e.g. `input[N].content[N].image_url`. */
  path: string;
  /** Recognized diagnostic phrases, in the order this module lists them. Never provider prose. */
  phrases: string[];
}

/**
 * `null` when the message is not an indexed-item rejection, which is most errors. A non-null shape
 * is safe to persist and to show: it contains a normalized schema path, phrases from the list
 * above, and integers.
 */
export function providerRejectionShape(message: unknown): ProviderRejectionShape | null {
  if (typeof message !== "string" || !message) return null;
  const path = INDEXED_ITEM_PATH.exec(message)?.[0];
  if (!path) return null;

  const normalized = path
    .replace(/\[\d+\]/g, "[N]")
    .split(".")
    // A segment carries its own indices (`content[N]`), so the name is checked apart from them and
    // the structure is preserved either way.
    .map((segment, index) => {
      if (index === 0) return segment;
      const parsed = /^([A-Za-z_][A-Za-z0-9_]*)((?:\[N\])*)$/.exec(segment);
      if (!parsed) return REDACTED_FIELD;
      return (RECOGNIZED_FIELDS.has(parsed[1]!) ? parsed[1]! : REDACTED_FIELD) + parsed[2]!;
    })
    .join(".");
  const lowered = message.toLowerCase();
  const phrases = RECOGNIZED_PHRASES.filter((phrase) => lowered.includes(phrase)).slice(0, MAX_PHRASES);
  return { path: normalized, phrases };
}

/** Stable identity for deduplication. Two rejections of the same shape are one piece of evidence. */
export function providerRejectionShapeKey(driver: string, shape: ProviderRejectionShape): string {
  return [driver, shape.path, shape.phrases.join("|")].join("\0");
}
