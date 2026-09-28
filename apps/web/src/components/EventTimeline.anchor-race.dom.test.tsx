import assert from "node:assert/strict";
import { test } from "node:test";
import React, { act, useRef } from "react";
import { createRoot } from "react-dom/client";
import { _resetIOSDetectionForTests } from "@tanstack/react-virtual";
import { Window } from "happy-dom";
import type { TimelineItem } from "../timeline.js";
import { installDomTestCleanup } from "../dom-test-cleanup.js";
import { EventTimeline } from "./EventTimeline.js";
import type { VirtualScrollAnchor } from "./MeasuredVirtualList.js";

// happy-dom has no layout, frame loop, or ResizeObserver delivery. This file supplies all three, so
// each test decides when a browser frame runs, when a row reports its new size, and what would be
// painted. Nothing waits on a real timer: frames, observations, and scroll-idle timers are driven
// explicitly, and React work that a browser would run as a later task is held until `act` returns.

const domWindow = new Window({ url: "http://localhost/" });

/** Creation-order delivery, plus one initial notice per observed target, as browsers do. */
class ControlledResizeObserver {
  static instances: ControlledResizeObserver[] = [];
  readonly deliveredSizes = new Map<Element, string | null>();
  constructor(readonly callback: ResizeObserverCallback) {
    ControlledResizeObserver.instances.push(this);
  }
  observe(target: Element) {
    if (!this.deliveredSizes.has(target)) this.deliveredSizes.set(target, null);
  }
  unobserve(target: Element) {
    this.deliveredSizes.delete(target);
  }
  disconnect() {
    this.deliveredSizes.clear();
    ControlledResizeObserver.instances = ControlledResizeObserver.instances.filter((observer) => observer !== this);
  }
}

for (const [name, value] of Object.entries({
  window: domWindow,
  document: domWindow.document,
  navigator: domWindow.navigator,
  Element: domWindow.Element,
  HTMLElement: domWindow.HTMLElement,
  Node: domWindow.Node,
  Event: domWindow.Event,
  MutationObserver: domWindow.MutationObserver,
  React,
  IS_REACT_ACT_ENVIRONMENT: true,
  ResizeObserver: ControlledResizeObserver,
})) Object.defineProperty(globalThis, name, { configurable: true, writable: true, value });
// TanStack creates its row and viewport observers from the scroll element's window.
Object.defineProperty(domWindow, "ResizeObserver", { configurable: true, writable: true, value: ControlledResizeObserver });

let frameCallbacks: Array<{ id: number; callback: FrameRequestCallback }> = [];
let nextFrameId = 1;
const requestFrame = ((callback: FrameRequestCallback) => {
  const id = nextFrameId++;
  frameCallbacks.push({ id, callback });
  return id;
}) as unknown as typeof domWindow.requestAnimationFrame;
const cancelFrame = ((id: number) => {
  frameCallbacks = frameCallbacks.filter((frame) => frame.id !== id);
}) as unknown as typeof domWindow.cancelAnimationFrame;
domWindow.requestAnimationFrame = requestFrame;
domWindow.cancelAnimationFrame = cancelFrame;
Object.defineProperty(globalThis, "requestAnimationFrame", { configurable: true, writable: true, value: requestFrame });
Object.defineProperty(globalThis, "cancelAnimationFrame", { configurable: true, writable: true, value: cancelFrame });

// TanStack resets its is-scrolling state from a debounce on the scroll element's window. Queue those
// timers and run them only when a test declares the reader idle.
let idleTimers = new Map<number, () => void>();
let nextTimerId = 1;
domWindow.setTimeout = ((callback: () => void) => {
  const id = nextTimerId++;
  idleTimers.set(id, callback);
  return id;
}) as unknown as typeof domWindow.setTimeout;
domWindow.clearTimeout = ((id: number) => {
  idleTimers.delete(id);
}) as unknown as typeof domWindow.clearTimeout;

const { cleanup } = installDomTestCleanup(domWindow);

const VIEWPORT_HEIGHT = 600;
const ROW_HEIGHT = 120;
const READER_ID = "anchor-race-reader";

/**
 * Simulated layout: the reader is the viewport, the list starts at its content top, and each row
 * sits at its committed transform.
 */
const layout = {
  width: 800,
  heights: new Map<string, number>(),
  scrollTop: 0,
  dispatchedScrollTop: 0,
};

const isReader = (element: Element) => (element as HTMLElement).dataset?.testid === READER_ID;
const isListRoot = (element: Element) => (element as HTMLElement).dataset?.virtualKind === "timeline";
const isRow = (element: Element) => element.hasAttribute("data-virtual-row");
const rowTransform = (row: HTMLElement) => Number(/translateY\((-?[\d.]+)px\)/.exec(row.style.transform)?.[1] ?? 0);
const listHeight = () => {
  const root = domWindow.document.querySelector("[data-virtual-kind='timeline']") as unknown as HTMLElement | null;
  return Number.parseFloat(root?.style.height ?? "0") || 0;
};
const maxScrollTop = () => Math.max(0, listHeight() - VIEWPORT_HEIGHT);

function box(element: Element): { top: number; width: number; height: number } {
  if (isReader(element)) return { top: 0, width: layout.width, height: VIEWPORT_HEIGHT };
  if (isListRoot(element)) return { top: -layout.scrollTop, width: layout.width, height: listHeight() };
  if (isRow(element)) {
    const row = element as HTMLElement;
    return {
      top: rowTransform(row) - layout.scrollTop,
      width: layout.width,
      height: layout.heights.get(row.dataset.virtualKey ?? "") ?? ROW_HEIGHT,
    };
  }
  return { top: 0, width: 0, height: 0 };
}

Object.defineProperty(domWindow.Element.prototype, "getBoundingClientRect", {
  configurable: true,
  value(this: Element) {
    const { top, width, height } = box(this);
    return { x: 0, y: top, top, left: 0, right: width, bottom: top + height, width, height, toJSON: () => ({}) };
  },
});
for (const [name, read] of [
  ["offsetHeight", (element: Element) => box(element).height],
  ["offsetWidth", (element: Element) => box(element).width],
  ["clientHeight", (element: Element) => box(element).height],
  ["clientWidth", (element: Element) => box(element).width],
  ["scrollHeight", (element: Element) => isReader(element) ? Math.max(VIEWPORT_HEIGHT, listHeight()) : box(element).height],
] as const) {
  Object.defineProperty(domWindow.HTMLElement.prototype, name, {
    configurable: true,
    get(this: Element) { return read(this); },
  });
}
const nativeScrollTop = Object.getOwnPropertyDescriptor(domWindow.Element.prototype, "scrollTop")!;
Object.defineProperty(domWindow.Element.prototype, "scrollTop", {
  configurable: true,
  get(this: Element) {
    return isReader(this) ? layout.scrollTop : nativeScrollTop.get!.call(this);
  },
  set(this: Element, value: number) {
    if (!isReader(this)) {
      nativeScrollTop.set!.call(this, value);
      return;
    }
    // Browsers clamp a scroll position to the scrollable range when it is written.
    layout.scrollTop = Math.min(maxScrollTop(), Math.max(0, value));
  },
});

function deliverResizeObservations() {
  for (let pass = 0; pass < 16; pass += 1) {
    let delivered = false;
    for (const observer of [...ControlledResizeObserver.instances]) {
      const entries: ResizeObserverEntry[] = [];
      for (const [target, previous] of observer.deliveredSizes) {
        if (!target.isConnected) continue;
        const { width, height } = box(target);
        const size = `${width}x${height}`;
        if (size === previous) continue;
        observer.deliveredSizes.set(target, size);
        const boxSize = [{ inlineSize: width, blockSize: height }];
        entries.push({
          target,
          borderBoxSize: boxSize,
          contentBoxSize: boxSize,
          devicePixelContentBoxSize: boxSize,
          contentRect: { x: 0, y: 0, top: 0, left: 0, width, height, right: width, bottom: height, toJSON: () => ({}) },
        } as unknown as ResizeObserverEntry);
      }
      if (entries.length === 0) continue;
      delivered = true;
      observer.callback(entries, observer as unknown as ResizeObserver);
    }
    if (!delivered) return;
  }
  throw new Error("resize observations did not settle");
}

interface PaintedRow {
  key: string;
  index: number;
  top: number;
  bottom: number;
}

/** What the browser would paint now: each mounted row at its committed transform and current size. */
function paint(): PaintedRow[] {
  return [...document.querySelectorAll<HTMLElement>("[data-virtual-row]")]
    .map((row) => {
      const { top, height } = box(row);
      return { key: row.dataset.virtualKey ?? "", index: Number(row.dataset.index), top, bottom: top + height };
    })
    .sort((left, right) => left.index - right.index);
}

/**
 * One browser frame in HTML event-loop order: scroll events, animation-frame callbacks, then resize
 * observations. `beforeResizeObservations` changes layout after the frame callbacks, so a row's new
 * size reaches the observers in that same frame. Returns the painted rows.
 */
function runFrame({ beforeResizeObservations }: { beforeResizeObservations?: () => void } = {}): PaintedRow[] {
  const reader = domWindow.document.querySelector(`[data-testid='${READER_ID}']`);
  if (reader && layout.scrollTop !== layout.dispatchedScrollTop) {
    layout.dispatchedScrollTop = layout.scrollTop;
    reader.dispatchEvent(new domWindow.Event("scroll"));
  }
  const due = frameCallbacks;
  frameCallbacks = [];
  for (const { callback } of due) callback(0);
  beforeResizeObservations?.();
  deliverResizeObservations();
  return paint();
}

/** Runs one frame, then lets React commit the work a browser would schedule as a later task. */
async function frame(options?: Parameters<typeof runFrame>[0]): Promise<PaintedRow[]> {
  let painted: PaintedRow[] = [];
  await act(async () => {
    painted = runFrame(options);
  });
  return painted;
}

/** Runs frames until no component frame work remains, then lets the reader go idle. */
async function settle(check: (painted: PaintedRow[]) => void) {
  for (let count = 0; count < 32; count += 1) {
    check(await frame());
    if (frameCallbacks.length === 0) {
      await act(async () => {
        const timers = [...idleTimers.values()];
        idleTimers = new Map();
        for (const timer of timers) timer();
      });
      check(await frame());
      if (frameCallbacks.length === 0) return;
    }
  }
  throw new Error("frames did not settle");
}

/** Fails on any overlap the reader could see. Off-screen rows may briefly overlap before measurement. */
function assertNoVisibleOverlap(rows: PaintedRow[], label: string) {
  for (let index = 1; index < rows.length; index += 1) {
    const previous = rows[index - 1]!;
    const current = rows[index]!;
    const visibleOverlap = Math.min(previous.bottom, VIEWPORT_HEIGHT) - Math.max(current.top, 0);
    assert.ok(previous.bottom <= current.top + 0.5 || visibleOverlap <= 0.5,
      `${label}: ${previous.key} (bottom ${previous.bottom}) overlaps ${current.key} (top ${current.top}) on screen`);
  }
}

function paintedTop(rows: PaintedRow[], key: string, label: string): number {
  const row = rows.find((candidate) => candidate.key === key);
  assert.ok(row, `${label}: ${key} must stay mounted`);
  return row.top;
}

const items: TimelineItem[] = Array.from({ length: 12 }, (_, index) => index % 2 === 0
  ? { kind: "user_message", id: index + 1, text: `Question ${index + 1}` }
  : { kind: "agent_message", id: index + 1, text: `Answer ${index + 1}` });
const PRECEDING_KEY = "item:user_message:3";
const SAVED_KEY = "item:agent_message:4";
const SAVED_INDEX = 3;
// The saved row begins above the viewport, so its whole predecessor is off screen.
const SAVED_OFFSET = -24;
const savedAnchor: VirtualScrollAnchor = { key: SAVED_KEY, offset: SAVED_OFFSET, index: SAVED_INDEX };
const GROWTH = 80;

function TimelineReader({
  timelineItems,
  onVisibleAnchorChange,
}: {
  timelineItems: TimelineItem[];
  onVisibleAnchorChange: (anchor: VirtualScrollAnchor) => void;
}) {
  const scrollRef = useRef<HTMLDivElement>(null);
  return (
    <div ref={scrollRef} data-testid={READER_ID} className="measured-virtual-scroll">
      <EventTimeline
        items={timelineItems}
        scrollRef={scrollRef}
        historyKey="session:anchor-race"
        getInitialAnchor={() => savedAnchor}
        preserveAnchor
        onVisibleAnchorChange={onVisibleAnchorChange}
      />
    </div>
  );
}

/** Mounts the session timeline as a phone reader returning to a saved row. */
async function returnToSavedRow() {
  frameCallbacks = [];
  idleTimers = new Map();
  ControlledResizeObserver.instances = [];
  layout.width = 800;
  layout.heights.clear();
  layout.scrollTop = 0;
  layout.dispatchedScrollTop = 0;
  const container = domWindow.document.createElement("div");
  domWindow.document.body.append(container);
  const root = createRoot(container as unknown as HTMLDivElement);
  const reports: VirtualScrollAnchor[] = [];
  let timelineItems = items;
  const render = () => root.render(
    <TimelineReader timelineItems={timelineItems} onVisibleAnchorChange={(anchor) => reports.push(anchor)} />,
  );
  let mounted = true;
  const unmount = async () => {
    if (!mounted) return;
    mounted = false;
    await act(async () => root.unmount());
    container.remove();
  };
  cleanup(unmount);
  await act(async () => render());
  return {
    reports,
    unmount,
    setItems: async (next: TimelineItem[]) => {
      timelineItems = next;
      await act(async () => render());
    },
    /** The row the reader would resume from if they scrolled now. */
    durableAnchor: async () => {
      await act(async () => {
        domWindow.document.querySelector(`[data-testid='${READER_ID}']`)!.dispatchEvent(new domWindow.Event("scroll"));
      });
      return reports.at(-1);
    },
  };
}

function assertSavedRowHeld(rows: PaintedRow[], label: string) {
  assertNoVisibleOverlap(rows, label);
  assert.equal(paintedTop(rows, SAVED_KEY, label), SAVED_OFFSET, `${label}: the saved row must keep its offset`);
}

/** Fails on any React error, such as a synchronous render requested from inside a commit. */
async function withoutConsoleErrors(run: () => Promise<void>) {
  const errors: string[] = [];
  const originalError = console.error;
  console.error = (...args: unknown[]) => { errors.push(args.map(String).join(" ")); };
  try {
    await run();
  } finally {
    console.error = originalError;
  }
  assert.deepEqual(errors, []);
}

test("a preceding row measured as the mount anchor releases keeps the saved row as the reading anchor", async () => {
  // Count the bounded restore window's frames on an undisturbed return rather than hard-coding it.
  const probe = await returnToSavedRow();
  let releaseFrame = 0;
  for (let count = 1; count <= 32 && releaseFrame === 0; count += 1) {
    assertSavedRowHeld(await frame(), `undisturbed frame ${count}`);
    if (frameCallbacks.length === 0) releaseFrame = count;
  }
  assert.ok(releaseFrame > 1, "mount restoration must own more than one frame");
  await probe.unmount();

  const reader = await returnToSavedRow();
  assert.equal(layout.scrollTop, SAVED_INDEX * ROW_HEIGHT - SAVED_OFFSET, "mount restoration applied the saved offset");
  for (let count = 1; count < releaseFrame - 1; count += 1) {
    assertSavedRowHeld(await frame(), `restore frame ${count}`);
  }
  let measurementFrame: PaintedRow[] = [];
  let releasingFrame: PaintedRow[] = [];
  await act(async () => {
    // The last correcting frame's observers report the preceding row's growth. A browser commits a
    // non-synchronous React update as a later task, so hold it past the next frame's callbacks: the
    // measurement's render then lands on the frame that clears the mount anchor.
    measurementFrame = runFrame({
      beforeResizeObservations: () => layout.heights.set(PRECEDING_KEY, ROW_HEIGHT + GROWTH),
    });
    releasingFrame = runFrame();
    assert.equal(frameCallbacks.length, 0, "the second held frame must be the one that releases the mount anchor");
  });
  assertSavedRowHeld(measurementFrame, "measurement frame");
  assertSavedRowHeld(releasingFrame, "release frame");
  await settle((painted) => assertSavedRowHeld(painted, "after release"));

  assert.equal(layout.scrollTop, SAVED_INDEX * ROW_HEIGHT + GROWTH - SAVED_OFFSET,
    "the preceding row's growth is compensated exactly once");
  const anchor = await reader.durableAnchor();
  assert.equal(anchor?.key, SAVED_KEY, "the saved row remains the reading anchor");
  assert.equal(anchor?.offset, SAVED_OFFSET);
  assert.ok(!reader.reports.some((report) => report.key === PRECEDING_KEY),
    "the preceding row must never be adopted as the reading anchor");
});

test("a touch on iOS keeps the saved row during session return and compensates growth once", async () => {
  // iOS WebKit defers TanStack's scroll compensation while a touch is active and applies it after
  // the touch ends. A reader who touches the timeline right after returning must not see the saved
  // row move during the touch or jump when it ends.
  const userAgent = Object.getOwnPropertyDescriptor(domWindow.navigator, "userAgent");
  Object.defineProperty(domWindow.navigator, "userAgent", {
    configurable: true,
    get: () => "Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15",
  });
  _resetIOSDetectionForTests();
  try {
    const reader = await returnToSavedRow();
    assert.equal(layout.scrollTop, SAVED_INDEX * ROW_HEIGHT - SAVED_OFFSET, "mount restoration applied the saved offset");
    assertSavedRowHeld(await frame(), "restore frame");

    const readerElement = domWindow.document.querySelector(`[data-testid='${READER_ID}']`)!;
    await act(async () => { readerElement.dispatchEvent(new domWindow.Event("touchstart")); });
    assertSavedRowHeld(
      await frame({ beforeResizeObservations: () => layout.heights.set(PRECEDING_KEY, ROW_HEIGHT + GROWTH) }),
      "measurement frame",
    );
    for (let count = 1; count <= 16; count += 1) {
      assertSavedRowHeld(await frame(), `held touch frame ${count}`);
    }
    await act(async () => { readerElement.dispatchEvent(new domWindow.Event("touchend")); });
    await settle((painted) => assertSavedRowHeld(painted, "after touch"));

    assert.equal(layout.scrollTop, SAVED_INDEX * ROW_HEIGHT + GROWTH - SAVED_OFFSET,
      "the preceding row's growth is compensated exactly once");
    const anchor = await reader.durableAnchor();
    assert.equal(anchor?.key, SAVED_KEY, "the saved row remains the reading anchor");
    assert.equal(anchor?.offset, SAVED_OFFSET);
    assert.ok(!reader.reports.some((report) => report.key === PRECEDING_KEY),
      "the preceding row must never be adopted as the reading anchor");
  } finally {
    if (userAgent) Object.defineProperty(domWindow.navigator, "userAgent", userAgent);
    else delete (domWindow.navigator as { userAgent?: string }).userAgent;
    _resetIOSDetectionForTests();
  }
});

test("width reflow after restoration keeps the saved row without a second compensation", async () => {
  const reader = await returnToSavedRow();
  await settle((painted) => assertSavedRowHeld(painted, "restore"));

  // Narrowing the reader wraps every row. The width owner, not TanStack, restores the saved row.
  layout.width = 400;
  for (const row of paint()) layout.heights.set(row.key, 200);
  assertSavedRowHeld(await frame(), "width frame");
  await settle((painted) => assertSavedRowHeld(painted, "after width change"));

  assert.equal(layout.scrollTop, SAVED_INDEX * 200 - SAVED_OFFSET);
  assert.equal((await reader.durableAnchor())?.key, SAVED_KEY);
});

test("width reflow during restoration keeps the saved row without a second compensation", async () => {
  const reader = await returnToSavedRow();
  assertSavedRowHeld(await frame(), "restore frame 1");
  assertSavedRowHeld(await frame(), "restore frame 2");

  // The width reseed runs in a layout effect, where no synchronous render may be requested. The
  // mount anchor owns the fully preceding rows, so TanStack must not compensate them there.
  await withoutConsoleErrors(async () => {
    layout.width = 400;
    for (const row of paint()) layout.heights.set(row.key, 200);
    assertSavedRowHeld(await frame(), "width frame");
    await settle((painted) => assertSavedRowHeld(painted, "after width change"));
  });

  assert.equal(layout.scrollTop, SAVED_INDEX * 200 - SAVED_OFFSET);
  assert.equal((await reader.durableAnchor())?.key, SAVED_KEY);
});

test("an older history page keeps the saved row as the structural anchor", async () => {
  const reader = await returnToSavedRow();
  await settle((painted) => assertSavedRowHeld(painted, "restore"));

  const older: TimelineItem[] = [
    { kind: "user_message", id: -2, text: "Older question" },
    { kind: "agent_message", id: -1, text: "Older answer" },
  ];
  await reader.setItems([...older, ...items]);
  assertSavedRowHeld(paint(), "structural commit");
  await settle((painted) => assertSavedRowHeld(painted, "after older page"));

  assert.equal(layout.scrollTop, (SAVED_INDEX + older.length) * ROW_HEIGHT - SAVED_OFFSET);
  assert.equal((await reader.durableAnchor())?.key, SAVED_KEY);
});

test("a preceding row growing under a structural anchor keeps the saved row", async () => {
  const reader = await returnToSavedRow();
  await settle((painted) => assertSavedRowHeld(painted, "restore"));

  // A streamed tail row makes the visible row a structural anchor. That anchor owns the reflow:
  // TanStack does not compensate the growth, but its render commits before paint so the anchor
  // restores the row in the same pass.
  await reader.setItems([...items, { kind: "user_message", id: 13, text: "Streamed follow-up" }]);
  assertSavedRowHeld(paint(), "structural commit");
  assertSavedRowHeld(
    await frame({ beforeResizeObservations: () => layout.heights.set(PRECEDING_KEY, ROW_HEIGHT + GROWTH) }),
    "measurement frame",
  );
  await settle((rows) => assertSavedRowHeld(rows, "after growth"));

  assert.equal(layout.scrollTop, SAVED_INDEX * ROW_HEIGHT + GROWTH - SAVED_OFFSET);
  assert.equal((await reader.durableAnchor())?.key, SAVED_KEY);
});

test("a preceding row measured as a streamed row's structural anchor releases keeps the saved row", async () => {
  const streamed: TimelineItem = { kind: "user_message", id: 13, text: "Streamed follow-up" };
  // Count the structural anchor's bounded window on an undisturbed stream rather than hard-coding it.
  const probe = await returnToSavedRow();
  await settle((painted) => assertSavedRowHeld(painted, "probe restore"));
  await probe.setItems([...items, streamed]);
  let releaseFrame = 0;
  for (let count = 1; count <= 32 && releaseFrame === 0; count += 1) {
    assertSavedRowHeld(await frame(), `undisturbed frame ${count}`);
    if (frameCallbacks.length === 0) releaseFrame = count;
  }
  assert.ok(releaseFrame > 1, "the structural anchor must own more than one frame");
  await probe.unmount();

  const reader = await returnToSavedRow();
  await settle((painted) => assertSavedRowHeld(painted, "restore"));
  await reader.setItems([...items, streamed]);
  assertSavedRowHeld(paint(), "structural commit");
  for (let count = 1; count < releaseFrame - 1; count += 1) {
    assertSavedRowHeld(await frame(), `structural frame ${count}`);
  }
  let measurementFrame: PaintedRow[] = [];
  let releasingFrame: PaintedRow[] = [];
  await act(async () => {
    // As in the mount-anchor race: hold the growth's render past the next frame's callbacks so it
    // lands on the frame that clears the structural anchor.
    measurementFrame = runFrame({
      beforeResizeObservations: () => layout.heights.set(PRECEDING_KEY, ROW_HEIGHT + GROWTH),
    });
    releasingFrame = runFrame();
    assert.equal(frameCallbacks.length, 0, "the second held frame must be the one that releases the structural anchor");
  });
  assertSavedRowHeld(measurementFrame, "measurement frame");
  assertSavedRowHeld(releasingFrame, "release frame");
  await settle((painted) => assertSavedRowHeld(painted, "after release"));

  assert.equal(layout.scrollTop, SAVED_INDEX * ROW_HEIGHT + GROWTH - SAVED_OFFSET,
    "the preceding row's growth is compensated exactly once");
  const anchor = await reader.durableAnchor();
  assert.equal(anchor?.key, SAVED_KEY, "the saved row remains the reading anchor");
  assert.equal(anchor?.offset, SAVED_OFFSET);
  assert.ok(!reader.reports.some((report) => report.key === PRECEDING_KEY),
    "the preceding row must never be adopted as the reading anchor");
});

test("the saved row growing with its predecessor under a structural anchor keeps its offset", async () => {
  const reader = await returnToSavedRow();
  await settle((painted) => assertSavedRowHeld(painted, "restore"));
  await reader.setItems([...items, { kind: "user_message", id: 13, text: "Streamed follow-up" }]);
  assertSavedRowHeld(paint(), "structural commit");
  assertSavedRowHeld(await frame(), "structural frame");

  // The anchor restores the preceding row's growth. It must stay pending for the rest of the
  // delivery: if it released, the spanning saved row's own growth would be compensated and move it.
  const measured = await frame({
    beforeResizeObservations: () => {
      layout.heights.set(PRECEDING_KEY, ROW_HEIGHT + GROWTH);
      layout.heights.set(SAVED_KEY, ROW_HEIGHT + 50);
    },
  });
  assert.equal(paintedTop(measured, SAVED_KEY, "measurement frame"), SAVED_OFFSET,
    "measurement frame: the saved row must keep its offset");
  await settle((rows) => assertSavedRowHeld(rows, "after growth"));

  assert.equal(layout.scrollTop, SAVED_INDEX * ROW_HEIGHT + GROWTH - SAVED_OFFSET);
  assert.equal((await reader.durableAnchor())?.key, SAVED_KEY);
});

test("an older history page mounted under a pending structural anchor keeps the saved row", async () => {
  const reader = await returnToSavedRow();
  await settle((painted) => assertSavedRowHeld(painted, "restore"));
  const streamed: TimelineItem = { kind: "user_message", id: 13, text: "Streamed follow-up" };
  await reader.setItems([...items, streamed]);
  assertSavedRowHeld(paint(), "structural commit");
  assertSavedRowHeld(await frame(), "structural frame");

  // The prepended rows mount in overscan and are measured from their ref during the commit. React
  // already commits that update before paint, so no synchronous render may be requested there.
  const older: TimelineItem[] = [
    { kind: "user_message", id: -2, text: "Older question" },
    { kind: "agent_message", id: -1, text: "Older answer" },
  ];
  await withoutConsoleErrors(async () => {
    await reader.setItems([...older, ...items, streamed]);
    assertSavedRowHeld(paint(), "prepend commit");
    await settle((painted) => assertSavedRowHeld(painted, "after older page"));
  });

  assert.equal(layout.scrollTop, (SAVED_INDEX + older.length) * ROW_HEIGHT - SAVED_OFFSET);
  assert.equal((await reader.durableAnchor())?.key, SAVED_KEY);
});

test("a touch on iOS keeps the saved row under a structural anchor and compensates growth once", async () => {
  // iOS WebKit defers TanStack's scroll compensation while a touch is active and applies it after
  // the touch ends. The structural anchor must stay the only owner of this growth.
  const userAgent = Object.getOwnPropertyDescriptor(domWindow.navigator, "userAgent");
  Object.defineProperty(domWindow.navigator, "userAgent", {
    configurable: true,
    get: () => "Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15",
  });
  _resetIOSDetectionForTests();
  try {
    const reader = await returnToSavedRow();
    await settle((painted) => assertSavedRowHeld(painted, "restore"));
    await reader.setItems([...items, { kind: "user_message", id: 13, text: "Streamed follow-up" }]);
    assertSavedRowHeld(paint(), "structural commit");
    assertSavedRowHeld(await frame(), "structural frame");

    const readerElement = domWindow.document.querySelector(`[data-testid='${READER_ID}']`)!;
    await act(async () => { readerElement.dispatchEvent(new domWindow.Event("touchstart")); });
    await frame({ beforeResizeObservations: () => layout.heights.set(PRECEDING_KEY, ROW_HEIGHT + GROWTH) });
    for (let count = 1; count <= 16; count += 1) {
      assertSavedRowHeld(await frame(), `held touch frame ${count}`);
    }
    await act(async () => { readerElement.dispatchEvent(new domWindow.Event("touchend")); });
    await settle((painted) => assertSavedRowHeld(painted, "after touch"));

    assert.equal(layout.scrollTop, SAVED_INDEX * ROW_HEIGHT + GROWTH - SAVED_OFFSET,
      "the preceding row's growth is compensated exactly once");
  } finally {
    if (userAgent) Object.defineProperty(domWindow.navigator, "userAgent", userAgent);
    else delete (domWindow.navigator as { userAgent?: string }).userAgent;
    _resetIOSDetectionForTests();
  }
});

test("width reflow under a streamed row's structural anchor keeps the saved row without a second compensation", async () => {
  const reader = await returnToSavedRow();
  await settle((painted) => assertSavedRowHeld(painted, "restore"));

  await reader.setItems([...items, { kind: "user_message", id: 13, text: "Streamed follow-up" }]);
  assertSavedRowHeld(paint(), "structural commit");
  assertSavedRowHeld(await frame(), "structural frame");

  // The width owner restores the saved row even though a structural anchor is pending. Its reseed
  // runs in a layout effect, where no synchronous render may be requested.
  await withoutConsoleErrors(async () => {
    layout.width = 400;
    for (const row of paint()) layout.heights.set(row.key, 200);
    assertSavedRowHeld(await frame(), "width frame");
    await settle((painted) => assertSavedRowHeld(painted, "after width change"));
  });

  assert.equal(layout.scrollTop, SAVED_INDEX * 200 - SAVED_OFFSET);
  assert.equal((await reader.durableAnchor())?.key, SAVED_KEY);
});

