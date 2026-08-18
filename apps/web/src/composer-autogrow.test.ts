import assert from "node:assert/strict";
import test from "node:test";
import { resizeComposerToContent, type ComposerAutoGrowElement } from "./composer-autogrow.js";

interface ComposerFixtureOptions {
  contentHeight: number;
  initialHeight?: string;
  boxHeight?: number;
  boxInlineHeight?: string;
  clientWidth?: number;
  withBox?: boolean;
}

function createComposerFixture({
  contentHeight,
  initialHeight = "120px",
  boxHeight = 340,
  boxInlineHeight = "",
  clientWidth = 480,
  withBox = true,
}: ComposerFixtureOptions) {
  const operations: string[] = [];
  let elHeight = initialHeight;
  let boxInline = boxInlineHeight;
  const box = withBox
    ? {
      get offsetHeight() { return boxHeight; },
      style: {
        get height() { return boxInline; },
        set height(value: string) {
          boxInline = value;
          operations.push(`box:${value === "" ? "auto" : value}`);
        },
      },
    }
    : null;
  const el: ComposerAutoGrowElement = {
    clientWidth,
    get scrollHeight() {
      operations.push(`measure:el=${elHeight}:box=${boxInline === "" ? "unlocked" : "locked"}`);
      return contentHeight;
    },
    style: {
      get height() { return elHeight; },
      set height(value: string) {
        elHeight = value;
        operations.push(`el:${value}`);
      },
    },
    parentElement: box,
  };
  return {
    el,
    operations,
    get elHeight() { return elHeight; },
    get boxInline() { return boxInline; },
  };
}

test("the auto probe is confined to a height-locked composer box", () => {
  const grown = createComposerFixture({ contentHeight: 240 });
  resizeComposerToContent(grown.el);
  assert.deepEqual(grown.operations, [
    "box:340px",
    "el:auto",
    "measure:el=auto:box=locked",
    "el:240px",
    "box:auto",
  ], "the transient auto collapse must never be observable outside the locked composer box");
  assert.equal(grown.elHeight, "240px", "a wrapped draft grows the textarea to its content");
  assert.equal(grown.boxInline, "", "the box returns to natural layout after the single height commit");
});

test("deleting draft lines shrinks the textarea through the same confined probe", () => {
  const shrunk = createComposerFixture({ contentHeight: 60, initialHeight: "240px" });
  resizeComposerToContent(shrunk.el);
  assert.equal(shrunk.elHeight, "60px", "the auto probe releases height a fixed value would retain");
  assert.equal(shrunk.operations[0], "box:340px", "shrink probes lock the box before collapsing");
  assert.equal(shrunk.operations.at(-1), "box:auto");
});

test("a pre-existing inline box height is restored verbatim", () => {
  const fixture = createComposerFixture({ contentHeight: 96, boxInlineHeight: "50px" });
  resizeComposerToContent(fixture.el);
  assert.equal(fixture.boxInline, "50px");
  assert.equal(fixture.operations.at(-1), "box:50px");
});

test("a boxless textarea still resizes and a zero-width one is skipped", () => {
  const boxless = createComposerFixture({ contentHeight: 200, withBox: false });
  resizeComposerToContent(boxless.el);
  assert.equal(boxless.elHeight, "200px");

  const hidden = createComposerFixture({ contentHeight: 200, clientWidth: 0 });
  resizeComposerToContent(hidden.el);
  assert.deepEqual(hidden.operations, [],
    "a zero-width probe reads garbage-tall values; the next visible keystroke recomputes");
  assert.equal(hidden.elHeight, "120px");
});
