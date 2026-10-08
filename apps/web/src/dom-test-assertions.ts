import assert from "node:assert/strict";

/**
 * The parts of a DOM node a failure message reports. Typed structurally, like `dom-test-cleanup`,
 * so both lib `Element` results and happy-dom's own `Element` type satisfy it.
 */
interface DescribableDomNode {
  nodeName: string;
  textContent: string | null;
  getAttribute?: (name: string) => string | null;
}

/** Attributes that identify an element well enough to find it again from a failure message. */
const IDENTIFYING_ATTRIBUTES = ["role", "data-testid", "aria-label", "name", "type"] as const;
const MAX_CLASSES = 3;
const MAX_NAME = 40;
const MAX_TEXT = 80;

function truncate(text: string, limit: number): string {
  return text.length > limit ? `${text.slice(0, limit - 1)}…` : text;
}

/**
 * A selector-shaped description of the node — tag, id, a few classes and identifying attributes.
 * Every part is truncated, so the description stays short whatever the element carries.
 */
export function describeDomNode(node: DescribableDomNode): string {
  const tag = truncate(node.nodeName.toLowerCase(), MAX_NAME);
  const attribute = (name: string) => node.getAttribute?.(name) ?? null;
  let selector = tag;
  const id = attribute("id");
  if (id) selector += `#${truncate(id, MAX_NAME)}`;
  const classes = (attribute("class") ?? "").split(/\s+/u).filter(Boolean);
  selector += classes.slice(0, MAX_CLASSES).map((name) => `.${truncate(name, MAX_NAME)}`).join("");
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
export function assertNoDomNode(found: DescribableDomNode | null | undefined, message?: string): void {
  if (found === null) return;
  const description = found === undefined ? "undefined rather than null" : describeDomNode(found);
  assert.fail(message ? `${message}: found ${description}` : `expected no element, found ${description}`);
}

/**
 * Asserts that two lookups found the same DOM node: the replacement for `assert.equal(nodeA, nodeB)`,
 * most often `assert.equal(document.activeElement, field)`.
 *
 * That assertion fails the way `assert.equal(node, null)` does (#1943), only with two object graphs
 * to inspect. A focus check failing in a rendered dialog test grew the process to about 15 GB before
 * it was killed, with no result reported (#2731).
 *
 * This compares identity, as `assert.equal` does, and fails with a short description of each side
 * instead. `null` and `undefined` are distinct, so either side may be an optional lookup.
 */
export function assertSameDomNode(
  actual: DescribableDomNode | null | undefined,
  expected: DescribableDomNode | null | undefined,
  message?: string,
): void {
  if (actual === expected) return;
  const describe = (node: DescribableDomNode | null | undefined) =>
    node === null ? "null" : node === undefined ? "undefined" : describeDomNode(node);
  const [found, wanted] = [describe(actual), describe(expected)];
  // Two distinct nodes can describe alike, such as two unnamed inputs; say so, or it reads as a pass.
  const detail = found === wanted
    ? `expected ${wanted}, found a different node that describes the same`
    : `expected ${wanted}, found ${found}`;
  assert.fail(message ? `${message}: ${detail}` : detail);
}

/** The parts of a DOM node `textBefore` walks, typed structurally for the same reason as above. */
interface DomTextNode {
  nodeType: number;
  textContent: string | null;
  childNodes: ArrayLike<DomTextNode>;
}

/**
 * The text a reader meets before `node` inside `container`, whitespace collapsed and trimmed. A
 * masked identifier must follow a visible label or name (#1954); this is how a test reads it.
 */
export function textBefore(container: DomTextNode, node: DomTextNode): string {
  let text = "";
  let found = false;
  const walk = (current: DomTextNode) => {
    if (found) return;
    if (current === node) {
      found = true;
      return;
    }
    if (current.nodeType === 3) text += current.textContent ?? "";
    for (const child of Array.from(current.childNodes)) walk(child);
  };
  walk(container);
  assert.ok(found, "the node is inside the container");
  return text.replace(/\s+/gu, " ").trim();
}

/** The parts of an element `ariaReferencedText` reads, typed structurally for the same reason. */
interface DomReferencingElement {
  getAttribute: (name: string) => string | null;
  ownerDocument: { getElementById: (id: string) => { textContent: string | null } | null };
}

/**
 * The text of the elements an `aria-labelledby` or `aria-describedby` names, joined with spaces as
 * the accessible name computation joins them, or null when the attribute is absent (#2285, #2369).
 */
export function ariaReferencedText(
  element: DomReferencingElement,
  attribute: "aria-labelledby" | "aria-describedby",
): string | null {
  const ids = element.getAttribute(attribute);
  if (!ids) return null;
  return ids.split(/\s+/u).map((id) => element.ownerDocument.getElementById(id)?.textContent ?? "").join(" ");
}
