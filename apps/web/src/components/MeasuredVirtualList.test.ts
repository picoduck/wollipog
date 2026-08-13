import assert from "node:assert/strict";
import test from "node:test";
import * as React from "react";
import { createRef } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import {
  MeasuredVirtualList,
  pinnedRangeExtractor,
  reanchorAtLogicalIndex,
  reseedMountedVirtualRows,
  scrollAnchorAdjustment,
  shouldAdjustVirtualScrollForResize,
  virtualTargetScrollAdjustment,
} from "./MeasuredVirtualList.js";

(globalThis as typeof globalThis & { React: typeof React }).React = React;

test("range extraction keeps focused and dragged rows mounted outside overscan", () => {
  const extracted = pinnedRangeExtractor({ startIndex: 10, endIndex: 14, overscan: 2, count: 100 }, [2, 60, 60, -1, 101]);
  assert.deepEqual(extracted, [2, 8, 9, 10, 11, 12, 13, 14, 15, 16, 60]);
});

test("scroll anchor adjustment preserves the previous viewport offset", () => {
  assert.equal(scrollAnchorAdjustment(24, 136), 112);
  assert.equal(scrollAnchorAdjustment(-8, -8), 0);
  assert.equal(scrollAnchorAdjustment(40, 10), -30);
});

test("logical index fallback survives key churn and clamps to the nearest surviving ordinal", () => {
  assert.deepEqual(
    reanchorAtLogicalIndex({ key: "item:tool:abc", offset: -8, index: 2 }, ["one", "two", "item:tool:abc:17"]),
    { key: "item:tool:abc:17", offset: -8, index: 2 },
  );
  assert.deepEqual(
    reanchorAtLogicalIndex({ key: "removed", offset: 4, index: 3 }, ["one", "two"], true),
    { key: "two", offset: 4, index: 1 },
  );
  assert.equal(
    reanchorAtLogicalIndex({ key: "structural", offset: 4, index: 3 }, ["one", "two"]),
    null,
    "ordinary structural anchors must not clamp to the tail when the list shrinks",
  );
});

test("late row measurements retain TanStack positional scroll semantics", () => {
  const base = {
    scrollOffset: 500,
    scrollAdjustments: 0,
    measured: true,
    scrollDirection: "forward" as const,
    anchorPending: false,
  };
  assert.equal(shouldAdjustVirtualScrollForResize({ ...base, itemStart: 400 }), true,
    "a changed row above the viewport compensates its size delta");
  assert.equal(shouldAdjustVirtualScrollForResize({ ...base, itemStart: 700 }), false,
    "a late overscanned row below the viewport must not move the reader");
  assert.equal(shouldAdjustVirtualScrollForResize({ ...base, itemStart: 400, anchorPending: true }), false,
    "the explicit logical anchor owns corrections while it is pending");
  assert.equal(shouldAdjustVirtualScrollForResize({ ...base, itemStart: 400, scrollDirection: "backward" }), true,
    "an old-width measured row above the viewport compensates while the reader moves backward");
  assert.equal(shouldAdjustVirtualScrollForResize({ ...base, itemStart: 400, measured: false, scrollDirection: "backward" }), true,
    "a first measurement above the viewport still corrects its estimate");
  assert.equal(shouldAdjustVirtualScrollForResize({ ...base, itemStart: 540, scrollAdjustments: 50 }), true,
    "TanStack's accumulated batch adjustments extend the effective viewport offset");
});

test("width invalidation rebuilds estimates before restoring mounted DOM heights", () => {
  const calls: string[] = [];
  const estimates = [80, 80, 80];
  const sizes = [132, 96, 80];
  const cache = new Map<number, number>([[0, 132], [1, 96]]);
  let flat = [132, 96, 80];
  const virtualizer = {
    measure() {
      calls.push("measure");
      cache.clear();
      // This intentionally models TanStack's retained pre-invalidation flat measurements.
    },
    getVirtualItems() {
      calls.push("getVirtualItems");
      flat = estimates.map((estimate, index) => cache.get(index) ?? estimate);
      return flat;
    },
    resizeItem(index: number, size: number) {
      calls.push(`resizeItem:${index}:${size}`);
      if (size === (cache.get(index) ?? flat[index])) return;
      cache.set(index, size);
      flat = estimates.map((estimate, itemIndex) => cache.get(itemIndex) ?? estimate);
    },
  };
  const rows = [
    { dataset: { index: "0" }, offsetHeight: sizes[0] },
    { dataset: { index: "1" }, offsetHeight: sizes[1] },
    { dataset: {}, offsetHeight: 999 },
  ] as unknown as HTMLElement[];

  reseedMountedVirtualRows({ querySelectorAll: () => rows } as unknown as ParentNode, virtualizer);

  assert.deepEqual(calls, ["measure", "getVirtualItems", "resizeItem:0:132", "resizeItem:1:96"]);
  assert.deepEqual(flat, sizes, "mounted rows use observed heights while the offscreen row stays estimated");
  const positions = flat.map((size, index) => ({
    start: flat.slice(0, index).reduce((total, value) => total + value, 0),
    end: flat.slice(0, index + 1).reduce((total, value) => total + value, 0),
    size,
  }));
  assert.deepEqual(positions, [
    { start: 0, end: 132, size: 132 },
    { start: 132, end: 228, size: 96 },
    { start: 228, end: 308, size: 80 },
  ], "restored measurements position consecutive rows without overlap");
});

test("explicit logical-row navigation computes exact measured corrections", () => {
  const geometry = { rowStart: 420, rowEnd: 500, viewportStart: 100, viewportEnd: 700 };
  assert.equal(virtualTargetScrollAdjustment({ ...geometry, align: "start" }), 320);
  assert.equal(virtualTargetScrollAdjustment({ ...geometry, align: "center" }), 60);
  assert.equal(virtualTargetScrollAdjustment({ ...geometry, align: "end" }), -200);
  assert.equal(virtualTargetScrollAdjustment({ ...geometry, align: "auto" }), 0,
    "an already visible target does not move the reader");
  assert.equal(virtualTargetScrollAdjustment({
    align: "auto", rowStart: 20, rowEnd: 80, viewportStart: 100, viewportEnd: 700,
  }), -80, "an offscreen row above aligns its leading edge");
  assert.equal(virtualTargetScrollAdjustment({
    align: "auto", rowStart: 720, rowEnd: 800, viewportStart: 100, viewportEnd: 700,
  }), 100, "an offscreen row below aligns its trailing edge");
});

test("server rendering preserves logical list order and accessibility metadata", () => {
  const html = renderToStaticMarkup(React.createElement(MeasuredVirtualList<number>, {
    items: [3, 1, 2],
    getKey: (item) => `row-${item}`,
    renderItem: (item) => React.createElement("span", null, item),
    scrollRef: createRef<HTMLElement>(),
    estimateSize: () => 40,
    overscan: 2,
    ariaLabel: "Ordered values",
  }));
  assert.match(html, /role="list" aria-label="Ordered values"/);
  assert.match(html, /aria-posinset="1" aria-setsize="3"[^>]*data-virtual-key="row-3"/);
  assert.ok(html.indexOf(">3</") < html.indexOf(">1</") && html.indexOf(">1</") < html.indexOf(">2</"));
});

test("server rendering exposes the requested logical destination", () => {
  const html = renderToStaticMarkup(React.createElement(MeasuredVirtualList<number>, {
    items: [3, 1, 2],
    getKey: (item) => `row-${item}`,
    renderItem: (item) => React.createElement("span", null, item),
    scrollRef: createRef<HTMLElement>(),
    estimateSize: () => 40,
    overscan: 2,
    revealRequest: { key: "row-1", requestId: 7 },
  }));
  assert.match(html, /data-virtual-key="row-1" data-virtual-target="true" aria-current="location"/);
  assert.doesNotMatch(html, /data-virtual-key="row-3" data-virtual-target="true"/);
});
