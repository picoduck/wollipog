/**
 * Reduce a provider request-validation rejection to a content-free structural shape, so an
 * unrecognized one can be evidenced later without retaining anything the provider said.
 *
 * The safety property is compositional, not filtering: the result is *built* from tokens this
 * module recognizes, and everything else in the message is discarded. A denylist would have to
 * anticipate every way content can appear; an allowlist cannot leak what it never copies.
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

/** An indexed item in the request input, with its field path. Segments are schema identifiers. */
const INDEXED_ITEM_PATH = /\binput\[(?:\d{1,10})\](?:\[\d{1,10}\]|\.[A-Za-z_][A-Za-z0-9_]{0,63}){0,8}/;
const MAX_NUMBERS = 4;
const MAX_PHRASES = 6;

export interface ProviderRejectionShape {
  /** Structural path with every index normalized, e.g. `input[N].content[N].image_url`. */
  path: string;
  /** Recognized diagnostic phrases, in the order this module lists them. Never provider prose. */
  phrases: string[];
  /** Measured sizes and limits the provider reported. Numbers only; never identifiers. */
  numbers: number[];
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

  const normalized = path.replace(/\[\d+\]/g, "[N]");
  const lowered = message.toLowerCase();
  const phrases = RECOGNIZED_PHRASES.filter((phrase) => lowered.includes(phrase)).slice(0, MAX_PHRASES);
  const numbers: number[] = [];
  for (const match of message.matchAll(/\b(\d{1,15})\b/g)) {
    const value = Number(match[1]);
    // Indices already live in the path; keeping them again would only add noise.
    if (!Number.isSafeInteger(value) || numbers.includes(value)) continue;
    numbers.push(value);
    if (numbers.length >= MAX_NUMBERS) break;
  }
  return { path: normalized, phrases, numbers };
}

/** Stable identity for deduplication. Two rejections of the same shape are one piece of evidence. */
export function providerRejectionShapeKey(driver: string, shape: ProviderRejectionShape): string {
  return [driver, shape.path, shape.phrases.join("|")].join("\0");
}
