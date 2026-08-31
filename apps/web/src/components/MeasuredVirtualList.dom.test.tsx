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

Object.defineProperty(domWindow.Element.prototype, "getBoundingClientRect", {
  configurable: true,
  value() {
    const element = this as HTMLElement;
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

function PinnedAvailabilityFixture({
  pinnedKey,
  onAvailabilityChange,
}: {
  pinnedKey: string;
  onAvailabilityChange: (key: string | null, available: boolean) => void;
}) {
  const scrollRef = useRef<HTMLDivElement>(null);
  return (
    <div ref={scrollRef} data-testid="pinned-reader" style={{ overflow: "auto", height: 600 }}>
      <MeasuredVirtualList
        items={["row-a", "row-b"]}
        getKey={(item) => item}
        renderItem={(item) => item}
        scrollRef={scrollRef}
        estimateSize={() => 72}
        overscan={2}
        pinnedKey={pinnedKey}
        onPinnedAvailabilityChange={onAvailabilityChange}
        className="pinned-list"
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

test("a mounted pin reports key replacement and unmount cleanup", async () => {
  const container = domWindow.document.createElement("div") as unknown as HTMLDivElement;
  domWindow.document.body.append(container as never);
  const root = createRoot(container);
  const reports: Array<[string | null, boolean]> = [];
  const onAvailabilityChange = (key: string | null, available: boolean) => reports.push([key, available]);
  try {
    await act(async () => {
      root.render(<PinnedAvailabilityFixture pinnedKey="row-a" onAvailabilityChange={onAvailabilityChange} />);
      await Promise.resolve();
      await Promise.resolve();
    });
    assert.deepEqual(reports.at(-1), ["row-a", true]);

    await act(async () => {
      root.render(<PinnedAvailabilityFixture pinnedKey="row-b" onAvailabilityChange={onAvailabilityChange} />);
      await Promise.resolve();
    });
    let lastAvailableA = -1;
    for (let index = 0; index < reports.length; index += 1) {
      if (reports[index]?.[0] === "row-a" && reports[index]?.[1] === true) lastAvailableA = index;
    }
    const replacementReports = reports.slice(lastAvailableA);
    assert.deepEqual(replacementReports, [["row-a", true], ["row-a", false], ["row-b", true]]);

    await act(async () => root.unmount());
    assert.deepEqual(reports.at(-1), ["row-b", false]);
  } finally {
    if (container.childNodes.length > 0) await act(async () => root.unmount());
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
