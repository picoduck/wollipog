import assert from "node:assert/strict";
import test from "node:test";
import React, { act, useRef } from "react";
import { createRoot } from "react-dom/client";
import { Window } from "happy-dom";
import { MeasuredVirtualList } from "./MeasuredVirtualList.js";

const domWindow = new Window({ url: "http://localhost/" });
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
  ResizeObserver: class { observe() {} unobserve() {} disconnect() {} },
})) Object.defineProperty(globalThis, name, { configurable: true, writable: true, value });

/** The Inbox's measured geometry either side of the phone breakpoint (#2541): eleven rows, 7px of
 * list padding, and a viewport whose height and width both change when the layout does. */
const breakpointGeometry = { width: 390, rowHeight: 98, viewportHeight: 637 };
const breakpointMaxScrollTop = () =>
  14 + 11 * breakpointGeometry.rowHeight - breakpointGeometry.viewportHeight;

Object.defineProperty(domWindow.Element.prototype, "getBoundingClientRect", {
  configurable: true,
  value() {
    const element = this as HTMLElement;
    const breakpointReader = element.dataset.testid === "breakpoint-reader"
      ? element
      : element.closest<HTMLElement>("[data-testid='breakpoint-reader']");
    if (breakpointReader) {
      const { width, rowHeight, viewportHeight } = breakpointGeometry;
      const row = element.hasAttribute("data-virtual-row");
      const top = element === breakpointReader ? 0
        : 7 + (row ? Number(element.dataset.index ?? 0) * rowHeight : 0) - breakpointReader.scrollTop;
      const height = element === breakpointReader ? viewportHeight : row ? rowHeight : 11 * rowHeight;
      return { x: 0, y: top, top, left: 0, right: width, bottom: top + height, width, height, toJSON: () => ({}) };
    }
    const reader = element.dataset.testid === "initial-offset-reader";
    const list = element.classList.contains("initial-offset-list");
    const anchorRecoveryList = element.classList.contains("anchor-recovery-list");
    const row = element.hasAttribute("data-virtual-row");
    const recoveryList = row ? element.closest(".anchor-recovery-list") : anchorRecoveryList ? element : null;
    const recoveryReader = recoveryList?.closest<HTMLElement>("[data-testid='anchor-recovery-reader']");
    const recoveryListTop = recoveryList?.previousElementSibling?.hasAttribute("data-recovery-notice") ? 180 : 120;
    const recoveryRowTop = row && recoveryList
      ? recoveryListTop + Number(element.dataset.index ?? 0) * 72 - (recoveryReader?.scrollTop ?? 0)
      : null;
    const top = recoveryRowTop ?? (anchorRecoveryList ? recoveryListTop : list || row ? 120 : 0);
    const height = reader ? 600 : list ? 720 : row ? 72 : 120;
    return {
      x: 0,
      y: top,
      top,
      left: 0,
      right: 800,
      bottom: top + height,
      width: 800,
      height,
      toJSON: () => ({}),
    };
  },
});
for (const [name, value] of [
  ["clientHeight", 600],
  ["clientWidth", 800],
  ["offsetHeight", 72],
  ["scrollHeight", 1_400],
] as const) {
  Object.defineProperty(domWindow.HTMLElement.prototype, name, { configurable: true, get: () => value });
}

const requestFrame = ((callback: FrameRequestCallback) => {
  queueMicrotask(() => callback(0));
  return 1;
}) as unknown as typeof domWindow.requestAnimationFrame;
const cancelFrame = (() => {}) as unknown as typeof domWindow.cancelAnimationFrame;
domWindow.requestAnimationFrame = requestFrame;
domWindow.cancelAnimationFrame = cancelFrame;
Object.defineProperty(globalThis, "requestAnimationFrame", { configurable: true, writable: true, value: requestFrame });
Object.defineProperty(globalThis, "cancelAnimationFrame", { configurable: true, writable: true, value: cancelFrame });

function InitialOffsetFixture() {
  const scrollRef = useRef<HTMLDivElement>(null);
  return (
    <div ref={scrollRef} data-testid="initial-offset-reader" style={{ overflow: "auto", height: 600 }}>
      <div data-testid="initial-offset-prefix" />
      <MeasuredVirtualList
        items={["row-1", "row-2", "row-3"]}
        getKey={(item) => item}
        renderItem={(item) => item}
        scrollRef={scrollRef}
        estimateSize={() => 72}
        overscan={2}
        className="initial-offset-list"
      />
    </div>
  );
}

function AnchorRecoveryFixture({
  items,
  recoveryPending,
  notice = false,
  onAnchorLost,
  onVisibleAnchorChange,
}: {
  items: string[];
  recoveryPending: boolean;
  notice?: boolean;
  onAnchorLost?: (anchor: { key: string; offset: number; index?: number }) => void;
  onVisibleAnchorChange?: (anchor: { key: string; offset: number; index?: number }) => void;
}) {
  const scrollRef = useRef<HTMLDivElement>(null);
  return (
    <div ref={scrollRef} data-testid="anchor-recovery-reader" style={{ overflow: "auto", height: 600 }}>
      {notice && <div data-recovery-notice />}
      <MeasuredVirtualList
        items={items}
        getKey={(item) => item}
        renderItem={(item) => item}
        scrollRef={scrollRef}
        estimateSize={() => 72}
        overscan={2}
        className="anchor-recovery-list"
        getInitialAnchor={() => ({ key: "saved-row", offset: 16, index: 2 })}
        preserveAnchor
        anchorRecoveryPending={recoveryPending}
        onAnchorLost={onAnchorLost}
        onVisibleAnchorChange={onVisibleAnchorChange}
      />
    </div>
  );
}

const BREAKPOINT_ROWS = Array.from({ length: 11 }, (_, index) => `row-${index}`);

function BreakpointFixture({ shape }: { shape: "phone" | "desktop" }) {
  const scrollRef = useRef<HTMLDivElement>(null);
  return (
    <div ref={scrollRef} data-testid="breakpoint-reader" style={{ overflow: "auto" }}>
      <MeasuredVirtualList
        items={BREAKPOINT_ROWS}
        getKey={(item) => item}
        renderItem={(item) => item}
        scrollRef={scrollRef}
        estimateSize={() => shape === "phone" ? 97 : 76}
        overscan={6}
        preserveAnchor
        className="breakpoint-list"
      />
    </div>
  );
}

test("a nonzero initial list offset does not call flushSync from the passive setup effect", async () => {
  const container = domWindow.document.createElement("div") as unknown as HTMLDivElement;
  domWindow.document.body.append(container as never);
  const root = createRoot(container);
  const errors: unknown[][] = [];
  const originalError = console.error;
  console.error = (...args: unknown[]) => { errors.push(args); };
  try {
    await act(async () => {
      root.render(<InitialOffsetFixture />);
      await Promise.resolve();
    });
    const list = container.querySelector(".initial-offset-list") as HTMLElement | null;
    assert.ok(list, "the measured list mounted at the nonzero fixture offset");
    assert.equal(list.getBoundingClientRect().top, 120);
    assert.ok(container.querySelector("[data-virtual-row]"), "the virtualizer rendered a real row");
    assert.deepEqual(errors, [], "initial passive setup must not emit a lifecycle or flushSync console error");
  } finally {
    console.error = originalError;
    await act(async () => root.unmount());
    container.remove();
  }
});

test("the list's height and row positions never transition, whatever a stylesheet sets", async () => {
  // A transitioning transform, of any length, paints a scroll correction a frame before the rows it
  // compensates for. The reduced-motion guard once gave every element a 1ms transition on every
  // property (#2426, #2574); a stylesheet that declares one on rows must not bring that back.
  const container = domWindow.document.createElement("div") as unknown as HTMLDivElement;
  domWindow.document.body.append(container as never);
  const root = createRoot(container);
  try {
    await act(async () => {
      root.render(<InitialOffsetFixture />);
      await Promise.resolve();
    });
    const list = container.querySelector<HTMLElement>(".initial-offset-list");
    const rows = [...container.querySelectorAll<HTMLElement>("[data-virtual-row]")];
    assert.ok(list && rows.length > 0, "the measured list rendered rows");
    assert.equal(list.style.transitionProperty, "none");
    for (const row of rows) assert.equal(row.style.transitionProperty, "none", `row ${row.dataset.virtualKey}`);
  } finally {
    await act(async () => root.unmount());
    container.remove();
  }
});

test("StrictMode restores an already-loaded saved reader row and viewport offset", async () => {
  const container = domWindow.document.createElement("div") as unknown as HTMLDivElement;
  domWindow.document.body.append(container as never);
  const root = createRoot(container);
  const visible: Array<{ key: string; offset: number }> = [];
  try {
    await act(async () => {
      root.render(
        <React.StrictMode>
          <AnchorRecoveryFixture
            items={["older-row-1", "older-row-2", "saved-row", "newer-row-1", "newer-row-2"]}
            recoveryPending={false}
            onVisibleAnchorChange={(anchor) => visible.push(anchor)}
          />
        </React.StrictMode>,
      );
    });
    const reader = container.querySelector<HTMLElement>("[data-testid='anchor-recovery-reader']");
    assert.ok(reader);
    assert.ok(Math.abs(reader.scrollTop - 248) < 1,
      `the saved row must retain its 16px offset after StrictMode effect replay; scrollTop=${reader.scrollTop}`);
    assert.ok(visible.every((anchor) => anchor.key === "saved-row" && Math.abs(anchor.offset - 16) < 1),
      "mounting an already-loaded window must not publish a replacement position before restoration");
  } finally {
    await act(async () => root.unmount());
    container.remove();
  }
});

test("a missing saved key waits for incomplete history and restores the original key", async () => {
  const container = domWindow.document.createElement("div") as unknown as HTMLDivElement;
  domWindow.document.body.append(container as never);
  const root = createRoot(container);
  const lost: string[] = [];
  const visible: string[] = [];
  try {
    await act(async () => {
      root.render(
        <AnchorRecoveryFixture
          items={["partial-row-1", "partial-row-2"]}
          recoveryPending
          onAnchorLost={(anchor) => lost.push(anchor.key)}
          onVisibleAnchorChange={(anchor) => visible.push(anchor.key)}
        />,
      );
      await Promise.resolve();
      await Promise.resolve();
    });
    assert.equal(lost.length, 0, "a partial page must not permanently lose the saved anchor");
    assert.equal(visible.length, 0, "partial rows must not replace the durable anchor while recovery is pending");

    await act(async () => {
      root.render(
        <AnchorRecoveryFixture
          items={["older-row-1", "older-row-2", "saved-row", "partial-row-1", "partial-row-2"]}
          recoveryPending={false}
          onAnchorLost={(anchor) => lost.push(anchor.key)}
          onVisibleAnchorChange={(anchor) => visible.push(anchor.key)}
        />,
      );
      await Promise.resolve();
      await Promise.resolve();
    });
    const reader = container.querySelector<HTMLElement>("[data-testid='anchor-recovery-reader']");
    assert.ok(reader);
    assert.deepEqual(lost, []);
    assert.ok(container.querySelector("[data-virtual-key='saved-row']"));
    assert.ok(Math.abs(reader.scrollTop - 248) < 1, "the recovered row should regain its saved viewport offset");
  } finally {
    await act(async () => root.unmount());
    container.remove();
  }
});

test("authoritative history falls back to the clamped nearest surviving ordinal", async () => {
  const container = domWindow.document.createElement("div") as unknown as HTMLDivElement;
  domWindow.document.body.append(container as never);
  const root = createRoot(container);
  const visible: string[] = [];
  try {
    await act(async () => {
      root.render(
        <AnchorRecoveryFixture
          items={["survivor-1", "survivor-2"]}
          recoveryPending={false}
          onVisibleAnchorChange={(anchor) => visible.push(anchor.key)}
        />,
      );
      await Promise.resolve();
      await Promise.resolve();
    });
    assert.ok(visible.includes("survivor-2"), "the last surviving ordinal should become the durable anchor");
  } finally {
    await act(async () => root.unmount());
    container.remove();
  }
});

// #2541: widening a phone across the breakpoint first lays the phone list out under the desktop
// stylesheet. Its taller viewport clamps scrollTop to that layout's end, which puts a different row
// first. That geometry belongs to no width the list has observed, and nothing the reader did produced
// it, so it must never become the row a later width correction restores.
test("geometry at an unobserved width never replaces the reader's row", async () => {
  Object.assign(breakpointGeometry, { width: 390, rowHeight: 98, viewportHeight: 637 });
  const container = domWindow.document.createElement("div") as unknown as HTMLDivElement;
  domWindow.document.body.append(container as never);
  const root = createRoot(container);
  const rowOffset = (reader: HTMLElement, index: number) =>
    reader.querySelector<HTMLElement>(`[data-virtual-row][data-index="${index}"]`)!.getBoundingClientRect().top;
  try {
    await act(async () => root.render(<BreakpointFixture shape="phone" />));
    const reader = container.querySelector<HTMLElement>("[data-testid='breakpoint-reader']");
    assert.ok(reader);
    // A browser clamps scrollTop to the current layout's end.
    let scrollTop = 0;
    Object.defineProperty(reader, "scrollTop", {
      configurable: true,
      get: () => scrollTop,
      set: (value: number) => { scrollTop = Math.max(0, Math.min(value, breakpointMaxScrollTop())); },
    });
    const scroll = async () => await act(async () => {
      reader.dispatchEvent(new domWindow.Event("scroll") as never);
    });

    // The reader is at the end of the phone list, reading row 4 with 56px of it above the fold.
    reader.scrollTop = 455;
    await scroll();
    assert.equal(rowOffset(reader, 4), -56);

    // The desktop stylesheet lands first: a 725px viewport over the phone-shaped rows clamps the
    // end of the list to 367, where row 3 is first with 66px above the fold.
    Object.assign(breakpointGeometry, { width: 1400, viewportHeight: 725 });
    reader.scrollTop = reader.scrollTop;
    await scroll();
    assert.equal(rowOffset(reader, 3), -66);

    // The desktop cards then render: 73px rows in a 245px viewport.
    Object.assign(breakpointGeometry, { rowHeight: 73, viewportHeight: 245 });
    await act(async () => root.render(<BreakpointFixture shape="desktop" />));
    assert.equal(rowOffset(reader, 4), -56, "the reader's row keeps the offset it was read at");
  } finally {
    await act(async () => root.unmount());
    container.remove();
    Object.assign(breakpointGeometry, { width: 390, rowHeight: 98, viewportHeight: 637 });
  }
});

test("restore correction ignores layout movement until explicit viewport intent", async () => {
  const callbacks = new Map<number, FrameRequestCallback>();
  let nextFrame = 1;
  const controlledRequestFrame = ((callback: FrameRequestCallback) => {
    const id = nextFrame++;
    callbacks.set(id, callback);
    return id;
  }) as unknown as typeof domWindow.requestAnimationFrame;
  const controlledCancelFrame = ((id: number) => callbacks.delete(id)) as unknown as typeof domWindow.cancelAnimationFrame;
  domWindow.requestAnimationFrame = controlledRequestFrame;
  domWindow.cancelAnimationFrame = controlledCancelFrame;
  Object.defineProperty(globalThis, "requestAnimationFrame", { configurable: true, writable: true, value: controlledRequestFrame });
  Object.defineProperty(globalThis, "cancelAnimationFrame", { configurable: true, writable: true, value: controlledCancelFrame });

  const container = domWindow.document.createElement("div") as unknown as HTMLDivElement;
  domWindow.document.body.append(container as never);
  const root = createRoot(container);
  try {
    await act(async () => {
      root.render(<AnchorRecoveryFixture items={["row-1", "row-2", "saved-row", "row-4"]} recoveryPending={false} />);
    });
    const reader = container.querySelector<HTMLElement>("[data-testid='anchor-recovery-reader']");
    assert.ok(reader);
    assert.ok(Math.abs(reader.scrollTop - 248) < 1);

    domWindow.document.body.dispatchEvent(new domWindow.WheelEvent("wheel", { bubbles: true, deltaY: 90 }) as never);
    reader.scrollTop += 90;
    await act(async () => {
      root.render(<AnchorRecoveryFixture items={["row-1", "row-2", "saved-row", "row-4", "row-5"]} recoveryPending={false} />);
    });
    assert.ok(Math.abs(reader.scrollTop - 248) < 1, "layout-only movement must not steal restore ownership");

    reader.dispatchEvent(new domWindow.WheelEvent("wheel", { bubbles: true, deltaY: 90 }) as never);
    reader.scrollTop += 90;
    await act(async () => {
      root.render(<AnchorRecoveryFixture items={["row-1", "row-2", "saved-row", "row-4", "row-5", "row-6"]} recoveryPending={false} />);
    });
    assert.ok(Math.abs(reader.scrollTop - 338) < 1, "explicit reader intent must relinquish the old anchor");
  } finally {
    await act(async () => root.unmount());
    container.remove();
    domWindow.requestAnimationFrame = requestFrame;
    domWindow.cancelAnimationFrame = cancelFrame;
    Object.defineProperty(globalThis, "requestAnimationFrame", { configurable: true, writable: true, value: requestFrame });
    Object.defineProperty(globalThis, "cancelAnimationFrame", { configurable: true, writable: true, value: cancelFrame });
  }
});

test("recovered mount ownership survives a pending history notice removal", async () => {
  const callbacks = new Map<number, FrameRequestCallback>();
  let nextFrame = 1;
  const controlledRequestFrame = ((callback: FrameRequestCallback) => {
    const id = nextFrame++;
    callbacks.set(id, callback);
    return id;
  }) as unknown as typeof domWindow.requestAnimationFrame;
  const controlledCancelFrame = ((id: number) => callbacks.delete(id)) as unknown as typeof domWindow.cancelAnimationFrame;
  domWindow.requestAnimationFrame = controlledRequestFrame;
  domWindow.cancelAnimationFrame = controlledCancelFrame;
  Object.defineProperty(globalThis, "requestAnimationFrame", { configurable: true, writable: true, value: controlledRequestFrame });
  Object.defineProperty(globalThis, "cancelAnimationFrame", { configurable: true, writable: true, value: controlledCancelFrame });

  const container = domWindow.document.createElement("div") as unknown as HTMLDivElement;
  domWindow.document.body.append(container as never);
  const root = createRoot(container);
  try {
    await act(async () => {
      root.render(<AnchorRecoveryFixture items={["partial-1", "partial-2"]} recoveryPending notice />);
    });
    await act(async () => {
      root.render(
        <AnchorRecoveryFixture
          items={["older-1", "older-2", "saved-row", "partial-1", "partial-2"]}
          recoveryPending={false}
        />,
      );
      await Promise.resolve();
    });
    const recoveryFrame = [...callbacks.entries()].at(0);
    assert.ok(recoveryFrame);
    callbacks.delete(recoveryFrame[0]);
    await act(async () => recoveryFrame[1](0));

    const reader = container.querySelector<HTMLElement>("[data-testid='anchor-recovery-reader']");
    assert.ok(reader);
    assert.ok(Math.abs(reader.scrollTop - 248) < 1);
    reader.scrollTop += 90;
    await act(async () => {
      root.render(
        <AnchorRecoveryFixture
          items={["older-1", "older-2", "saved-row", "partial-1", "partial-2", "later"]}
          recoveryPending={false}
        />,
      );
    });
    assert.ok(Math.abs(reader.scrollTop - 248) < 1,
      "load-notice layout changes must not drop recovered mount ownership");
  } finally {
    await act(async () => root.unmount());
    container.remove();
    domWindow.requestAnimationFrame = requestFrame;
    domWindow.cancelAnimationFrame = cancelFrame;
    Object.defineProperty(globalThis, "requestAnimationFrame", { configurable: true, writable: true, value: requestFrame });
    Object.defineProperty(globalThis, "cancelAnimationFrame", { configurable: true, writable: true, value: cancelFrame });
  }
});

test("explicit reader intent during incomplete history abandons the deferred restore", async () => {
  const callbacks = new Map<number, FrameRequestCallback>();
  let nextFrame = 1;
  const controlledRequestFrame = ((callback: FrameRequestCallback) => {
    const id = nextFrame++;
    callbacks.set(id, callback);
    return id;
  }) as unknown as typeof domWindow.requestAnimationFrame;
  const controlledCancelFrame = ((id: number) => callbacks.delete(id)) as unknown as typeof domWindow.cancelAnimationFrame;
  domWindow.requestAnimationFrame = controlledRequestFrame;
  domWindow.cancelAnimationFrame = controlledCancelFrame;
  Object.defineProperty(globalThis, "requestAnimationFrame", { configurable: true, writable: true, value: controlledRequestFrame });
  Object.defineProperty(globalThis, "cancelAnimationFrame", { configurable: true, writable: true, value: controlledCancelFrame });

  const container = domWindow.document.createElement("div") as unknown as HTMLDivElement;
  domWindow.document.body.append(container as never);
  const root = createRoot(container);
  try {
    await act(async () => {
      root.render(<AnchorRecoveryFixture items={["partial-1", "partial-2"]} recoveryPending />);
    });
    const reader = container.querySelector<HTMLElement>("[data-testid='anchor-recovery-reader']");
    assert.ok(reader);
    reader.dispatchEvent(new domWindow.WheelEvent("wheel", { bubbles: true, deltaY: 90 }) as never);
    reader.scrollTop = 90;
    await act(async () => {
      root.render(
        <AnchorRecoveryFixture
          items={["older-1", "older-2", "saved-row", "partial-1", "partial-2"]}
          recoveryPending={false}
        />,
      );
    });
    const recoveryFrame = [...callbacks.entries()].at(0);
    assert.ok(recoveryFrame);
    callbacks.delete(recoveryFrame[0]);
    await act(async () => recoveryFrame[1](0));
    assert.equal(reader.scrollTop, 90, "completed history must not yank a reader who moved during recovery");
  } finally {
    await act(async () => root.unmount());
    container.remove();
    domWindow.requestAnimationFrame = requestFrame;
    domWindow.cancelAnimationFrame = cancelFrame;
    Object.defineProperty(globalThis, "requestAnimationFrame", { configurable: true, writable: true, value: requestFrame });
    Object.defineProperty(globalThis, "cancelAnimationFrame", { configurable: true, writable: true, value: cancelFrame });
  }
});

test("reader movement during incomplete history is durable before recovery or unmount", async () => {
  const callbacks = new Map<number, FrameRequestCallback>();
  let nextFrame = 1;
  const controlledRequestFrame = ((callback: FrameRequestCallback) => {
    const id = nextFrame++;
    callbacks.set(id, callback);
    return id;
  }) as unknown as typeof domWindow.requestAnimationFrame;
  const controlledCancelFrame = ((id: number) => callbacks.delete(id)) as unknown as typeof domWindow.cancelAnimationFrame;
  domWindow.requestAnimationFrame = controlledRequestFrame;
  domWindow.cancelAnimationFrame = controlledCancelFrame;
  Object.defineProperty(globalThis, "requestAnimationFrame", { configurable: true, writable: true, value: controlledRequestFrame });
  Object.defineProperty(globalThis, "cancelAnimationFrame", { configurable: true, writable: true, value: controlledCancelFrame });

  const container = domWindow.document.createElement("div") as unknown as HTMLDivElement;
  domWindow.document.body.append(container as never);
  const root = createRoot(container);
  const visible: string[] = [];
  try {
    await act(async () => {
      root.render(
        <AnchorRecoveryFixture
          items={["partial-row-1", "partial-row-2"]}
          recoveryPending
          onVisibleAnchorChange={(anchor) => visible.push(anchor.key)}
        />,
      );
    });
    const reader = container.querySelector<HTMLElement>("[data-testid='anchor-recovery-reader']");
    assert.ok(reader);
    assert.deepEqual(visible, [], "passive partial history must not replace the saved anchor");

    await act(async () => {
      reader.dispatchEvent(new domWindow.WheelEvent("wheel", { bubbles: true, deltaY: 200 }) as never);
      reader.scrollTop = 200;
      reader.dispatchEvent(new domWindow.Event("scroll") as never);
    });
    assert.equal(visible.at(-1), "partial-row-2",
      "the post-intent scroll position must become durable before history finishes");

    await act(async () => root.unmount());
    assert.equal(visible.at(-1), "partial-row-2",
      "unmounting during recovery must preserve the reader-owned position");
  } finally {
    if (container.isConnected) await act(async () => root.unmount());
    container.remove();
    domWindow.requestAnimationFrame = requestFrame;
    domWindow.cancelAnimationFrame = cancelFrame;
    Object.defineProperty(globalThis, "requestAnimationFrame", { configurable: true, writable: true, value: requestFrame });
    Object.defineProperty(globalThis, "cancelAnimationFrame", { configurable: true, writable: true, value: cancelFrame });
  }
});

function ResultSetFixture({ items, resultSetKey }: { items: string[]; resultSetKey: string }) {
  const scrollRef = useRef<HTMLDivElement>(null);
  return (
    <div ref={scrollRef} data-testid="breakpoint-reader" style={{ overflow: "auto" }}>
      <MeasuredVirtualList
        items={items}
        getKey={(item) => item}
        renderItem={(item) => item}
        scrollRef={scrollRef}
        estimateSize={() => 97}
        overscan={6}
        preserveAnchor
        resultSetKey={resultSetKey}
        className="breakpoint-list"
      />
    </div>
  );
}

test("a new result set starts at the top, while a reorder under the same key keeps the reader's row (#2804)", async () => {
  Object.assign(breakpointGeometry, { width: 390, rowHeight: 98, viewportHeight: 637 });
  const container = domWindow.document.createElement("div") as unknown as HTMLDivElement;
  domWindow.document.body.append(container as never);
  const root = createRoot(container);
  const keyOffset = (reader: HTMLElement, key: string) =>
    reader.querySelector<HTMLElement>(`[data-virtual-row][data-virtual-key="${key}"]`)!.getBoundingClientRect().top;
  try {
    await act(async () => root.render(<ResultSetFixture items={BREAKPOINT_ROWS} resultSetKey="" />));
    const reader = container.querySelector<HTMLElement>("[data-testid='breakpoint-reader']");
    assert.ok(reader);
    // A browser clamps scrollTop to the current layout's end.
    let scrollTop = 0;
    Object.defineProperty(reader, "scrollTop", {
      configurable: true,
      get: () => scrollTop,
      set: (value: number) => { scrollTop = Math.max(0, Math.min(value, breakpointMaxScrollTop())); },
    });
    reader.scrollTop = 455;
    await act(async () => {
      reader.dispatchEvent(new domWindow.Event("scroll") as never);
    });
    assert.equal(keyOffset(reader, "row-4"), -56);

    // A live reorder moves a row from above the reader's to the end: the reader's row stays put.
    const reordered = [...BREAKPOINT_ROWS.slice(1), BREAKPOINT_ROWS[0]!];
    await act(async () => root.render(<ResultSetFixture items={reordered} resultSetKey="" />));
    assert.equal(keyOffset(reader, "row-4"), -56, "a reorder keeps the reader's row where it was");
    assert.equal(reader.scrollTop, 357);

    // A search answers with a different set that still holds the reader's row. It starts at the top.
    const results = ["row-2", "row-3", "row-4", "row-5", "row-6", "row-7", "row-8", "row-9"];
    await act(async () => root.render(<ResultSetFixture items={results} resultSetKey="row" />));
    assert.equal(reader.scrollTop, 0, "a different result set does not carry the reader's row into it");
    assert.equal(keyOffset(reader, "row-2"), 7);

    // A later update under the same key holds the new first row, not the old set's.
    await act(async () => root.render(<ResultSetFixture items={[...results]} resultSetKey="row" />));
    assert.equal(reader.scrollTop, 0);

    // Clearing the search is a new set too.
    await act(async () => root.render(<ResultSetFixture items={reordered} resultSetKey="" />));
    assert.equal(reader.scrollTop, 0, "the whole list returns at its first row");
    assert.equal(keyOffset(reader, "row-1"), 7);
  } finally {
    await act(async () => root.unmount());
    container.remove();
    Object.assign(breakpointGeometry, { width: 390, rowHeight: 98, viewportHeight: 637 });
  }
});

test("dropping a reading anchor whose row is in view renders nothing more", async () => {
  const callbacks = new Map<number, FrameRequestCallback>();
  let nextFrame = 1;
  const controlledRequestFrame = ((callback: FrameRequestCallback) => {
    const id = nextFrame++;
    callbacks.set(id, callback);
    return id;
  }) as unknown as typeof domWindow.requestAnimationFrame;
  const controlledCancelFrame = ((id: number) => callbacks.delete(id)) as unknown as typeof domWindow.cancelAnimationFrame;
  domWindow.requestAnimationFrame = controlledRequestFrame;
  domWindow.cancelAnimationFrame = controlledCancelFrame;
  Object.defineProperty(globalThis, "requestAnimationFrame", { configurable: true, writable: true, value: controlledRequestFrame });
  Object.defineProperty(globalThis, "cancelAnimationFrame", { configurable: true, writable: true, value: controlledCancelFrame });

  let renders = 0;
  function CountingFixture() {
    const scrollRef = useRef<HTMLDivElement>(null);
    return (
      <div ref={scrollRef} data-testid="anchor-recovery-reader" style={{ overflow: "auto", height: 600 }}>
        <MeasuredVirtualList
          items={["row-1", "row-2", "saved-row", "row-4"]}
          getKey={(item) => item}
          renderItem={(item) => { renders += 1; return item; }}
          scrollRef={scrollRef}
          estimateSize={() => 72}
          overscan={2}
          className="anchor-recovery-list"
          getInitialAnchor={() => ({ key: "saved-row", offset: 16, index: 2 })}
          preserveAnchor
        />
      </div>
    );
  }
  const container = domWindow.document.createElement("div") as unknown as HTMLDivElement;
  domWindow.document.body.append(container as never);
  const root = createRoot(container);
  try {
    await act(async () => root.render(<CountingFixture />));
    const settled = renders;
    for (let round = 0; round < 20 && callbacks.size > 0; round += 1) {
      await act(async () => {
        const due = [...callbacks.values()];
        callbacks.clear();
        for (const callback of due) callback(0);
      });
    }
    assert.equal(renders, settled, "the restore's settle frames add no render for a row already in range");
  } finally {
    await act(async () => root.unmount());
    container.remove();
    domWindow.requestAnimationFrame = requestFrame;
    domWindow.cancelAnimationFrame = cancelFrame;
    Object.defineProperty(globalThis, "requestAnimationFrame", { configurable: true, writable: true, value: requestFrame });
    Object.defineProperty(globalThis, "cancelAnimationFrame", { configurable: true, writable: true, value: cancelFrame });
  }
});

test("a reading anchor relinquished in a settle frame stops keeping its row mounted (#2734)", async () => {
  const callbacks = new Map<number, FrameRequestCallback>();
  let nextFrame = 1;
  const controlledRequestFrame = ((callback: FrameRequestCallback) => {
    const id = nextFrame++;
    callbacks.set(id, callback);
    return id;
  }) as unknown as typeof domWindow.requestAnimationFrame;
  const controlledCancelFrame = ((id: number) => callbacks.delete(id)) as unknown as typeof domWindow.cancelAnimationFrame;
  domWindow.requestAnimationFrame = controlledRequestFrame;
  domWindow.cancelAnimationFrame = controlledCancelFrame;
  Object.defineProperty(globalThis, "requestAnimationFrame", { configurable: true, writable: true, value: controlledRequestFrame });
  Object.defineProperty(globalThis, "cancelAnimationFrame", { configurable: true, writable: true, value: controlledCancelFrame });

  const items = Array.from({ length: 200 }, (_, index) => index === 2 ? "saved-row" : `row-${index}`);
  const container = domWindow.document.createElement("div") as unknown as HTMLDivElement;
  domWindow.document.body.append(container as never);
  const root = createRoot(container);
  const savedRow = () => container.querySelector('[data-virtual-key="saved-row"]');
  try {
    await act(async () => {
      root.render(<AnchorRecoveryFixture items={items} recoveryPending={false} />);
    });
    const reader = container.querySelector<HTMLElement>("[data-testid='anchor-recovery-reader']")!;
    assert.ok(savedRow(), "the restored reader row is mounted");

    // The reader scrolls away while the restore's settle frames are still pending: the anchor still
    // pins its row in the render that follows the scroll.
    reader.dispatchEvent(new domWindow.WheelEvent("wheel", { bubbles: true, deltaY: 400 }) as never);
    await act(async () => {
      reader.scrollTop = 10_000;
      reader.dispatchEvent(new domWindow.Event("scroll") as never);
    });
    assert.ok(reader.scrollTop > 500, `the reader moved far below the anchor (scrollTop=${reader.scrollTop})`);

    // The settle frames see the reader's intent and relinquish the anchor.
    for (let round = 0; round < 20 && callbacks.size > 0; round += 1) {
      await act(async () => {
        const due = [...callbacks.values()];
        callbacks.clear();
        for (const callback of due) callback(0);
      });
    }
    assert.equal(savedRow() === null, true, "a relinquished anchor no longer keeps its row mounted");
  } finally {
    await act(async () => root.unmount());
    container.remove();
    domWindow.requestAnimationFrame = requestFrame;
    domWindow.cancelAnimationFrame = cancelFrame;
    Object.defineProperty(globalThis, "requestAnimationFrame", { configurable: true, writable: true, value: requestFrame });
    Object.defineProperty(globalThis, "cancelAnimationFrame", { configurable: true, writable: true, value: cancelFrame });
  }
});

function FollowedFixture({ items, preserveAnchor, onVisibleAnchorChange }: {
  items: string[];
  preserveAnchor: boolean;
  onVisibleAnchorChange?: (anchor: { key: string; offset: number; index?: number }) => void;
}) {
  const scrollRef = useRef<HTMLDivElement>(null);
  return (
    <div ref={scrollRef} data-testid="initial-offset-reader" style={{ overflow: "auto", height: 600 }}>
      <MeasuredVirtualList
        items={items}
        getKey={(item) => item}
        renderItem={(item) => item}
        scrollRef={scrollRef}
        estimateSize={() => 72}
        overscan={2}
        className="initial-offset-list"
        preserveAnchor={preserveAnchor}
        onVisibleAnchorChange={onVisibleAnchorChange}
      />
    </div>
  );
}

test("a followed list reads no layout in its commits, and the commit that stops following reads its own row (#2840)", async () => {
  // While follow-tail owns the viewport nothing preserves a reader row, so a streamed commit has
  // nothing to correct; reading the visible row there forced a synchronous layout in every one.
  const prototype = domWindow.Element.prototype as unknown as { getBoundingClientRect: () => DOMRect };
  const measure = prototype.getBoundingClientRect;
  let reads = 0;
  const container = domWindow.document.createElement("div") as unknown as HTMLDivElement;
  domWindow.document.body.append(container as never);
  const root = createRoot(container);
  const visible: Array<{ key: string; offset: number }> = [];
  const onVisibleAnchorChange = (anchor: { key: string; offset: number }) => visible.push(anchor);
  try {
    await act(async () => {
      root.render(<FollowedFixture items={["row-1", "row-2"]} preserveAnchor={false} onVisibleAnchorChange={onVisibleAnchorChange} />);
    });
    assert.equal(container.querySelector(".initial-offset-list")?.getAttribute("data-virtual-measurements"), "ready");
    const reader = container.querySelector<HTMLElement>("[data-testid='initial-offset-reader']")!;

    Object.defineProperty(prototype, "getBoundingClientRect", {
      configurable: true,
      value(this: Element) {
        reads += 1;
        return measure.call(this);
      },
    });
    visible.length = 0;
    for (const items of [["row-1", "row-2", "row-3"], ["row-1", "row-2", "row-3", "row-4"]]) {
      await act(async () => {
        root.render(<FollowedFixture items={items} preserveAnchor={false} onVisibleAnchorChange={onVisibleAnchorChange} />);
      });
    }
    await act(async () => { reader.dispatchEvent(new domWindow.Event("scroll") as never); });
    assert.equal(reads, 0, "neither streamed commits nor follow pins read row geometry while following");
    assert.equal(visible.length, 0, "a followed tail reports no reading position");

    // The reader pauses in the same render that brings another row: the last recorded position is
    // out of date, so that render reads the row on screen and reports it.
    await act(async () => {
      root.render(<FollowedFixture items={["row-1", "row-2", "row-3", "row-4", "row-5"]} preserveAnchor onVisibleAnchorChange={onVisibleAnchorChange} />);
    });
    assert.ok(reads > 0, "the render that starts preserving reads its rows");
    assert.equal(visible[0]?.key, "row-1");
    assert.equal(visible[0]?.offset, 120);
  } finally {
    Object.defineProperty(prototype, "getBoundingClientRect", { configurable: true, value: measure });
    await act(async () => root.unmount());
    container.remove();
  }
});

function PrependFixture({ items, preserveAnchor, onVisibleAnchorChange }: {
  items: string[];
  preserveAnchor: boolean;
  onVisibleAnchorChange?: (anchor: { key: string; offset: number; index?: number }) => void;
}) {
  const scrollRef = useRef<HTMLDivElement>(null);
  return (
    <div ref={scrollRef} data-testid="anchor-recovery-reader" style={{ overflow: "auto", height: 600 }}>
      <MeasuredVirtualList
        items={items}
        getKey={(item) => item}
        renderItem={(item) => item}
        scrollRef={scrollRef}
        estimateSize={() => 72}
        overscan={2}
        className="anchor-recovery-list"
        preserveAnchor={preserveAnchor}
        onVisibleAnchorChange={onVisibleAnchorChange}
      />
    </div>
  );
}

test("pausing in the render that prepends history holds the row the reader was on (#2840)", async () => {
  // Rows sit at 120 + 72 x index - scrollTop in this geometry, so prepending moves every kept row.
  const container = domWindow.document.createElement("div") as unknown as HTMLDivElement;
  domWindow.document.body.append(container as never);
  const root = createRoot(container);
  const live = Array.from({ length: 16 }, (_, index) => `row-${index + 5}`);
  const visible: Array<{ key: string; offset: number }> = [];
  const onVisibleAnchorChange = (anchor: { key: string; offset: number }) => visible.push(anchor);
  try {
    await act(async () => {
      root.render(<PrependFixture items={live} preserveAnchor={false} onVisibleAnchorChange={onVisibleAnchorChange} />);
    });
    const reader = container.querySelector<HTMLElement>("[data-testid='anchor-recovery-reader']")!;
    await act(async () => {
      reader.scrollTop = 300;
      reader.dispatchEvent(new domWindow.Event("scroll") as never);
    });
    // While following, row-7 (index 2) is the first row on screen, 36px above the reader's top.
    visible.length = 0;
    const history = ["row-0", "row-1", "row-2", "row-3", "row-4"];
    await act(async () => {
      root.render(<PrependFixture items={[...history, ...live]} preserveAnchor onVisibleAnchorChange={onVisibleAnchorChange} />);
    });
    assert.deepEqual(visible[0], { key: "row-7", offset: -36, index: 2 },
      "the reader's row is read before the prepend moves it");
    assert.ok(Math.abs(reader.scrollTop - (300 + history.length * 72)) < 1,
      `the prepend is compensated so row-7 stays put; scrollTop=${reader.scrollTop}`);
  } finally {
    await act(async () => root.unmount());
    container.remove();
  }
});
