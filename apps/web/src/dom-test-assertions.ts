import assert from "node:assert/strict";

/**
 * The parts of a DOM node an absence failure reports. Typed structurally, like `dom-test-cleanup`,
 * so both lib `Element` results and happy-dom's own `Element` type satisfy it.
 */
interface DomAbsenceCandidate {
  nodeName: string;
  textContent: string | null;
  getAttribute?: (name: string) => string | null;
}

/** Attributes that identify an element well enough to find it again from a failure message. */
const IDENTIFYING_ATTRIBUTES = ["role", "data-testid", "aria-label", "name", "type"] as const;
const MAX_CLASSES = 3;
const MAX_TEXT = 80;

function truncate(text: string, limit: number): string {
  return text.length > limit ? `${text.slice(0, limit - 1)}…` : text;
}

/** A selector-shaped description of the node — tag, id, a few classes and identifying attributes. */
export function describeDomNode(node: DomAbsenceCandidate): string {
  const tag = node.nodeName.toLowerCase();
  const attribute = (name: string) => node.getAttribute?.(name) ?? null;
  let selector = tag;
  const id = attribute("id");
  if (id) selector += `#${id}`;
  const classes = (attribute("class") ?? "").split(/\s+/u).filter(Boolean);
  selector += classes.slice(0, MAX_CLASSES).map((name) => `.${name}`).join("");
  if (classes.length > MAX_CLASSES) selector += "…";
  for (const name of IDENTIFYING_ATTRIBUTES) {
    const value = attribute(name);
    if (value !== null) selector += `[${name}=${JSON.stringify(truncate(value, MAX_TEXT))}]`;
  }
  const text = (node.textContent ?? "").replace(/\s+/gu, " ").trim();
  return text ? `${selector} with text ${JSON.stringify(truncate(text, MAX_TEXT))}` : selector;
}

/**
 * Asserts that a DOM lookup found nothing: the replacement for `assert.equal(node, null)`.
 *
 * When that assertion fails, its `actual` is a happy-dom node, and `node:assert` builds the failure
 * message by inspecting the node's whole object graph — measured at over ten seconds and 2.7 million
 * characters for one empty `<div>`, and in a rendered component test long enough for the file to be
 * killed before it reports anything (#1943). A plain failure then reads as a crashed test run.
 *
 * This fails with a short message naming the element instead, and never hands the node to
 * `node:assert`. The semantics are `assert.equal(found, null)`'s exactly: only `null` passes, so an
 * `undefined` from an optional chain still fails, as it did before.
 *
 * `src/dom-test-assertions.test.ts` rejects any new node-valued `assert.equal(..., null)`.
 */
export function assertNoDomNode(found: DomAbsenceCandidate | null | undefined, message?: string): void {
  if (found === null) return;
  const description = found === undefined ? "undefined rather than null" : describeDomNode(found);
  assert.fail(message ? `${message}: found ${description}` : `expected no element, found ${description}`);
}
