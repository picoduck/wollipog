import assert from "node:assert/strict";
import test from "node:test";
import { markClipEdges } from "./clip-edges.js";

/** A scroll container as `markClipEdges` reads it: its metrics, its overflow and its attributes. */
function container(metrics: { scrollTop: number; clientHeight: number; scrollHeight: number }, overflowY = "auto") {
  const attributes = new Set<string>();
  const element = {
    ...metrics,
    ownerDocument: { defaultView: { getComputedStyle: () => ({ overflowY }) } },
    toggleAttribute: (name: string, on: boolean) => { if (on) attributes.add(name); else attributes.delete(name); },
  };
  return { element: element as unknown as HTMLElement, marks: () => [...attributes].sort() };
}

test("a scrolling body marks each edge it can still scroll past, and clears the one it reaches (#2715)", () => {
  const start = container({ scrollTop: 0, clientHeight: 200, scrollHeight: 400 });
  markClipEdges(start.element);
  assert.deepEqual(start.marks(), ["data-clip-end"]);

  const middle = container({ scrollTop: 100, clientHeight: 200, scrollHeight: 400 });
  markClipEdges(middle.element);
  assert.deepEqual(middle.marks(), ["data-clip-end", "data-clip-start"]);

  const end = container({ scrollTop: 200, clientHeight: 200, scrollHeight: 400 });
  markClipEdges(end.element);
  assert.deepEqual(end.marks(), ["data-clip-start"]);

  // Sub-pixel rounding at an end is not more to scroll to.
  const rounded = container({ scrollTop: 199.5, clientHeight: 200, scrollHeight: 400 });
  markClipEdges(rounded.element);
  assert.deepEqual(rounded.marks(), ["data-clip-start"]);
});

test("a body that fits, or one that does not scroll on its own, has no marks", () => {
  const fits = container({ scrollTop: 0, clientHeight: 200, scrollHeight: 200 });
  markClipEdges(fits.element);
  assert.deepEqual(fits.marks(), []);

  // A panel's body, or a question card scrolling whole: overflow visible, so the page or the card
  // scrolls instead and marks its own edges.
  const visible = container({ scrollTop: 0, clientHeight: 200, scrollHeight: 400 }, "visible");
  markClipEdges(visible.element);
  assert.deepEqual(visible.marks(), []);
});

test("marks that no longer hold are removed", () => {
  const body = container({ scrollTop: 100, clientHeight: 200, scrollHeight: 400 });
  markClipEdges(body.element);
  assert.deepEqual(body.marks(), ["data-clip-end", "data-clip-start"]);
  Object.assign(body.element, { scrollTop: 0, scrollHeight: 200 });
  markClipEdges(body.element);
  assert.deepEqual(body.marks(), []);
});
