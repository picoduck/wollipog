import assert from "node:assert/strict";
import test from "node:test";
import React, { act } from "react";
import { createRoot } from "react-dom/client";
import { Window } from "happy-dom";
import {
  FOLLOW_TAIL_PROGRAMMATIC_SCROLL_SETTLE_MS,
  FOLLOW_TAIL_SCROLL_INTENT_DELAY_MS,
  countRowsAfter,
  isAtFollowTailBottom,
  hasSavedFollowTailAnchor,
  isFollowTailResumeKey,
  isFollowTailUpwardReadingKey,
  nextFollowTailState,
  useFollowTail,
  type FollowTailApi,
} from "./useFollowTail.js";
import { VIRTUAL_ROW_RESIZE_EVENT, VIRTUAL_VIEWPORT_INTENT_EVENT } from "./viewport-intent.js";

test("new rows are the ones after the detach point, never prepended history", () => {
  const rows = [{ id: 4 }, { id: 5 }, { id: 9 }, { id: 10 }];
  assert.equal(countRowsAfter(rows, 10), 0);
  assert.equal(countRowsAfter(rows, 5), 2);
  assert.equal(countRowsAfter([{ id: 1 }, { id: 2 }, ...rows], 5), 2, "earlier pages add older rows only");
  assert.equal(countRowsAfter(rows, Number.NEGATIVE_INFINITY), 4, "an empty detach point counts every row");
});

test("resume-key matching excludes Inbox navigation and modified global shortcuts", () => {
  const base = { shiftKey: false, ctrlKey: false, metaKey: false, altKey: false };
  assert.equal(isFollowTailResumeKey({ ...base, key: "k" }), false);
  assert.equal(isFollowTailResumeKey({ ...base, key: "ArrowUp" }), false);
  assert.equal(isFollowTailResumeKey({ ...base, key: "G", shiftKey: true }), true);
  assert.equal(isFollowTailResumeKey({ ...base, key: "End" }), true);
  assert.equal(isFollowTailResumeKey({ ...base, key: "G", shiftKey: true, ctrlKey: true }), false);
  assert.equal(isFollowTailUpwardReadingKey({ ...base, key: "Home" }), true);
  assert.equal(isFollowTailUpwardReadingKey({ ...base, key: "PageUp" }), true);
  assert.equal(isFollowTailUpwardReadingKey({ ...base, key: "Home", altKey: true }), false);
});

const domWindow = new Window({ url: "http://localhost/sessions/one" });
class MockResizeObserver {
  static instances: MockResizeObserver[] = [];
  readonly observed = new Set<Element>();
  constructor(private readonly callback: ResizeObserverCallback) {
    MockResizeObserver.instances.push(this);
  }
  observe(element: Element) { this.observed.add(element); }
  unobserve(element: Element) { this.observed.delete(element); }
  disconnect() { this.observed.clear(); }
  trigger() { this.callback([], this as unknown as ResizeObserver); }
}
for (const [name, value] of Object.entries({
  window: domWindow,
  document: domWindow.document,
  navigator: domWindow.navigator,
  HTMLElement: domWindow.HTMLElement,
  Element: domWindow.Element,
  Node: domWindow.Node,
  Event: domWindow.Event,
  KeyboardEvent: domWindow.KeyboardEvent,
  WheelEvent: domWindow.WheelEvent,
  MutationObserver: domWindow.MutationObserver,
  ResizeObserver: MockResizeObserver,
  React,
  IS_REACT_ACT_ENVIRONMENT: true,
})) Object.defineProperty(globalThis, name, { configurable: true, writable: true, value });

interface HarnessProps {
  sessionId: string;
  revision: number;
  mode: "preview" | "expanded";
  scope?: string;
  rows?: readonly { id: number }[];
  generation?: number;
  onApi?: (api: FollowTailApi) => void;
}

function Harness({ sessionId, revision, mode, scope = "test", rows, generation, onApi }: HarnessProps) {
  const scrollRef = React.useRef<HTMLDivElement>(null);
  const followTail = useFollowTail({
    scrollRef, contentRevision: revision, sessionId, persistenceScope: scope, rows, rowGeneration: generation,
  });
  const initialAnchor = followTail.getInitialAnchor();
  React.useLayoutEffect(() => onApi?.(followTail));
  return (
    <div
      ref={scrollRef}
      data-mode={mode}
      data-state={followTail.state}
      data-new={followTail.newRowCount}
      data-can-scroll={String(followTail.canScroll)}
      data-anchor-key={initialAnchor?.key}
      data-anchor-offset={initialAnchor?.offset}
      onScroll={followTail.onScroll}
      onWheel={followTail.onWheel}
      onPointerMove={followTail.onPointerMove}
      onTouchStart={(event) => followTail.onTouchStart(event.nativeEvent)}
      onPointerDown={(event) => { if (event.pointerType === "touch") followTail.onTouchPointerDown(event); }}
      onKeyDown={(event) => {
        if (mode !== "expanded") return;
        if (followTail.onKeyDown(event)) event.preventDefault();
      }}
      tabIndex={0}
    />
  );
}

function setScrollMetrics(element: HTMLElement, values: FollowTailTestMetrics): void {
  for (const [name, value] of Object.entries(values)) {
    Object.defineProperty(element, name, { configurable: true, writable: true, value });
  }
}

interface FollowTailTestMetrics {
  scrollTop: number;
  scrollHeight: number;
  clientHeight: number;
}

test("the state machine uses the inclusive 48px bottom threshold", () => {
  assert.equal(isAtFollowTailBottom({ scrollTop: 752, scrollHeight: 1_000, clientHeight: 200 }), true);
  assert.equal(isAtFollowTailBottom({ scrollTop: 751, scrollHeight: 1_000, clientHeight: 200 }), false);
  assert.equal(nextFollowTailState("following", "pause"), "paused");
  assert.equal(nextFollowTailState("following", "preview"), "previewing");
  assert.equal(nextFollowTailState("previewing", "pause"), "paused");
  assert.equal(nextFollowTailState("paused", "resume"), "following");
});

test("programmatic preview paging owns smooth-scroll frames until the requested direction settles", async () => {
  MockResizeObserver.instances.length = 0;
  const container = domWindow.document.createElement("div") as unknown as HTMLDivElement;
  domWindow.document.body.append(container as never);
  const root = createRoot(container);
  let api!: FollowTailApi;
  await act(async () => {
    root.render(<Harness sessionId="programmatic-paging" revision={0} mode="preview" onApi={(next) => { api = next; }} />);
  });

  const transcript = container.firstElementChild as HTMLElement;
  setScrollMetrics(transcript, { scrollTop: 800, scrollHeight: 1_000, clientHeight: 200 });
  const scrollRequests: ScrollToOptions[] = [];
  transcript.scrollTo = ((options: ScrollToOptions) => scrollRequests.push(options)) as typeof transcript.scrollTo;
  const viewportObserver = MockResizeObserver.instances.find((observer) => observer.observed.has(transcript));
  assert.ok(viewportObserver);

  await act(async () => { api.beginProgrammaticScroll("previous"); });
  assert.equal(transcript.dataset.state, "previewing");
  setScrollMetrics(transcript, { scrollTop: 799.5, scrollHeight: 1_000, clientHeight: 200 });
  await act(async () => {
    transcript.dispatchEvent(new domWindow.Event("scroll", { bubbles: true }) as never);
    await new Promise<void>((resolve) => setTimeout(resolve, FOLLOW_TAIL_PROGRAMMATIC_SCROLL_SETTLE_MS + 20));
  });
  assert.equal(transcript.dataset.state, "previewing",
    "the first Page Up frame inside the bottom threshold must not resume live follow");

  setScrollMetrics(transcript, { scrollTop: 610, scrollHeight: 1_240, clientHeight: 200 });
  await act(async () => {
    viewportObserver.trigger();
    root.render(<Harness sessionId="programmatic-paging" revision={1} mode="preview" onApi={(next) => { api = next; }} />);
    transcript.dispatchEvent(new domWindow.Event("scroll", { bubbles: true }) as never);
    await new Promise<void>((resolve) => setTimeout(resolve, FOLLOW_TAIL_PROGRAMMATIC_SCROLL_SETTLE_MS + 20));
  });
  assert.equal(transcript.dataset.state, "previewing");
  assert.equal(scrollRequests.length, 0, "streaming resize must not reclaim a programmatically paged viewport");

  await act(async () => { api.beginProgrammaticScroll("next"); });
  setScrollMetrics(transcript, { scrollTop: 900, scrollHeight: 1_240, clientHeight: 200 });
  await act(async () => {
    transcript.dispatchEvent(new domWindow.Event("scroll", { bubbles: true }) as never);
    await new Promise<void>((resolve) => setTimeout(resolve, FOLLOW_TAIL_PROGRAMMATIC_SCROLL_SETTLE_MS + 20));
  });
  assert.equal(transcript.dataset.state, "previewing", "Page Down remains previewing before the actual bottom");

  setScrollMetrics(transcript, { scrollTop: 1_039, scrollHeight: 1_240, clientHeight: 200 });
  await act(async () => {
    transcript.dispatchEvent(new domWindow.Event("scroll", { bubbles: true }) as never);
  });
  assert.equal(transcript.dataset.state, "previewing", "the bottom frame must settle before resuming follow");
  setScrollMetrics(transcript, { scrollTop: 1_039, scrollHeight: 1_300, clientHeight: 200 });
  await act(async () => {
    transcript.dispatchEvent(new domWindow.Event("scroll", { bubbles: true }) as never);
    await new Promise<void>((resolve) => setTimeout(resolve, FOLLOW_TAIL_PROGRAMMATIC_SCROLL_SETTLE_MS + 20));
  });
  assert.equal(transcript.dataset.state, "previewing",
    "tail growth before settle must cancel Page Down resume until the new bottom is reached");
  setScrollMetrics(transcript, { scrollTop: 1_099, scrollHeight: 1_300, clientHeight: 200 });
  await act(async () => {
    transcript.dispatchEvent(new domWindow.Event("scroll", { bubbles: true }) as never);
  });
  await act(async () => {
    await new Promise<void>((resolve) => setTimeout(resolve, FOLLOW_TAIL_PROGRAMMATIC_SCROLL_SETTLE_MS + 20));
  });
  assert.equal(transcript.dataset.state, "following", "settled Page Down at the actual bottom resumes follow");

  await act(async () => { root.unmount(); });
  container.remove();
});

test("rows appended while the reader is away are counted until the reader returns to the tail", async () => {
  const container = domWindow.document.createElement("div") as unknown as HTMLDivElement;
  domWindow.document.body.append(container as never);
  const root = createRoot(container);
  const rows = (...ids: number[]) => ids.map((id) => ({ id }));
  const render = (revision: number, ids: number[]) => act(async () => {
    root.render(<Harness sessionId="new-rows" scope="new-rows" revision={revision} mode="expanded" rows={rows(...ids)} />);
  });
  await render(0, [1, 2, 3]);
  const transcript = container.firstElementChild as HTMLElement;
  setScrollMetrics(transcript, { scrollTop: 800, scrollHeight: 1_000, clientHeight: 200 });
  transcript.scrollTo = (() => {}) as typeof transcript.scrollTo;
  assert.equal(transcript.dataset.new, "0");

  await render(1, [1, 2, 3, 4]);
  assert.equal(transcript.dataset.new, "0", "rows that arrive while following are not new");

  await act(async () => {
    transcript.dispatchEvent(new domWindow.WheelEvent("wheel", { deltaY: -12, bubbles: true }) as never);
  });
  assert.equal(transcript.dataset.state, "paused");
  assert.equal(transcript.dataset.new, "0", "leaving the tail starts from nothing new");

  await render(2, [1, 2, 3, 4, 5, 6, 7]);
  assert.equal(transcript.dataset.new, "3");
  await render(3, [-1, 0, 1, 2, 3, 4, 5, 6, 7]);
  assert.equal(transcript.dataset.new, "3", "an earlier page loaded above the reader is not new");

  await act(async () => {
    transcript.dispatchEvent(new domWindow.KeyboardEvent("keydown", { key: "End", bubbles: true }) as never);
  });
  assert.equal(transcript.dataset.state, "following");
  assert.equal(transcript.dataset.new, "0", "returning to the tail clears the count");

  await act(async () => {
    transcript.dispatchEvent(new domWindow.WheelEvent("wheel", { deltaY: -12, bubbles: true }) as never);
  });
  await render(4, [-1, 0, 1, 2, 3, 4, 5, 6, 7, 8]);
  assert.equal(transcript.dataset.new, "1", "a second detach counts from its own point");

  await act(async () => { root.unmount(); });
  container.remove();
});

test("a history reset restarts the new-row count in its own id space without resuming", async () => {
  const container = domWindow.document.createElement("div") as unknown as HTMLDivElement;
  domWindow.document.body.append(container as never);
  const root = createRoot(container);
  const render = (revision: number, generation: number, ids: number[]) => act(async () => {
    root.render(<Harness sessionId="reset-rows" scope="reset-rows" revision={revision} mode="expanded"
      generation={generation} rows={ids.map((id) => ({ id }))} />);
  });
  await render(0, 0, [98, 99, 100]);
  const transcript = container.firstElementChild as HTMLElement;
  setScrollMetrics(transcript, { scrollTop: 800, scrollHeight: 1_000, clientHeight: 200 });
  transcript.scrollTo = (() => {}) as typeof transcript.scrollTo;
  await act(async () => {
    transcript.dispatchEvent(new domWindow.WheelEvent("wheel", { deltaY: -12, bubbles: true }) as never);
  });
  await render(1, 0, [98, 99, 100, 101]);
  assert.equal(transcript.dataset.new, "1");

  await render(2, 1, [1, 2, 3, 4, 5]);
  assert.equal(transcript.dataset.state, "paused", "a reset does not move the reader back to the tail");
  assert.equal(transcript.dataset.new, "0", "the reset's own rows are not new");
  await render(3, 1, [1, 2, 3, 4, 5, 6]);
  assert.equal(transcript.dataset.new, "1", "a row appended after the reset counts");

  await act(async () => { root.unmount(); });
  container.remove();
});

test("follow-tail pauses on upward intent and resumes only at the actual bottom or on follow keys", async () => {
  const container = domWindow.document.createElement("div") as unknown as HTMLDivElement;
  domWindow.document.body.append(container as never);
  const root = createRoot(container);
  await act(async () => { root.render(<Harness sessionId="one" revision={0} mode="preview" />); });

  const transcript = container.firstElementChild as HTMLElement;
  setScrollMetrics(transcript, { scrollTop: 800, scrollHeight: 1_000, clientHeight: 200 });
  const scrollRequests: ScrollToOptions[] = [];
  transcript.scrollTo = ((options: ScrollToOptions) => scrollRequests.push(options)) as typeof transcript.scrollTo;

  await act(async () => { root.render(<Harness sessionId="one" revision={1} mode="preview" />); });
  assert.equal(scrollRequests.at(-1)?.top, 1_000, "streamed content follows the actual bottom");

  await act(async () => {
    transcript.dispatchEvent(new domWindow.WheelEvent("wheel", { deltaY: -12, bubbles: true }) as never);
  });
  assert.equal(transcript.dataset.state, "paused");
  scrollRequests.length = 0;
  await act(async () => { root.render(<Harness sessionId="one" revision={2} mode="preview" />); });
  assert.equal(scrollRequests.length, 0, "streamed content must not move a paused transcript");

  await act(async () => { root.render(<Harness sessionId="one" revision={2} mode="expanded" />); });
  assert.equal(transcript.dataset.state, "paused", "mode-only changes preserve the state machine");

  let viewportIntentCount = 0;
  transcript.addEventListener(VIRTUAL_VIEWPORT_INTENT_EVENT, () => { viewportIntentCount += 1; });
  await act(async () => {
    transcript.dispatchEvent(new domWindow.KeyboardEvent("keydown", { key: "G", shiftKey: true, bubbles: true }) as never);
  });
  assert.equal(transcript.dataset.state, "following");
  assert.equal(scrollRequests.at(-1)?.top, 1_000);
  assert.equal(viewportIntentCount, 1, "resuming follow claims the virtual viewport before scrolling");

  for (const init of [
    { key: "k" },
    { key: "PageUp" },
    { key: " ", shiftKey: true },
  ]) {
    await act(async () => {
      transcript.dispatchEvent(new domWindow.KeyboardEvent("keydown", { ...init, bubbles: true }) as never);
    });
    assert.equal(transcript.dataset.state, "paused");
    await act(async () => {
      transcript.dispatchEvent(new domWindow.KeyboardEvent("keydown", { key: "End", bubbles: true }) as never);
    });
    assert.equal(transcript.dataset.state, "following");
  }

  await act(async () => {
    transcript.dispatchEvent(new domWindow.WheelEvent("wheel", { deltaY: -1, bubbles: true }) as never);
  });
  setScrollMetrics(transcript, { scrollTop: 752, scrollHeight: 1_000, clientHeight: 200 });
  await act(async () => { transcript.dispatchEvent(new domWindow.Event("scroll", { bubbles: true }) as never); });
  assert.equal(transcript.dataset.state, "paused",
    "a single upward line inside the 48px follow threshold must preserve the reader's position");
  scrollRequests.length = 0;
  await act(async () => { root.render(<Harness sessionId="one" revision={3} mode="expanded" />); });
  assert.equal(scrollRequests.length, 0, "new output must not snap a one-line-up reader back to the tail");

  setScrollMetrics(transcript, {
    scrollTop: 798.4,
    scrollHeight: 1_000,
    clientHeight: 200,
  });
  await act(async () => { transcript.dispatchEvent(new domWindow.Event("scroll", { bubbles: true }) as never); });
  assert.equal(transcript.dataset.state, "following",
    "fractional browser scroll metrics at the visual bottom resume following");

  await act(async () => {
    transcript.dispatchEvent(new domWindow.WheelEvent("wheel", { deltaY: -1, bubbles: true }) as never);
    root.render(<Harness sessionId="two" revision={3} mode="expanded" />);
  });
  assert.equal(transcript.dataset.state, "following", "session identity changes reset following");

  setScrollMetrics(transcript, { scrollTop: 420, scrollHeight: 1_000, clientHeight: 200 });
  await act(async () => {
    transcript.dispatchEvent(new domWindow.Event("scroll", { bubbles: true }) as never);
    await new Promise<void>((resolve) => setTimeout(resolve, FOLLOW_TAIL_SCROLL_INTENT_DELAY_MS + 10));
  });
  assert.equal(transcript.dataset.state, "paused",
    "a bare upward scroll such as a platform scrollbar drag preserves the reading position");

  await act(async () => { root.unmount(); });
  container.remove();
});

test("modified reading keys remain unrelated and bubble without changing follow state", async () => {
  const container = domWindow.document.createElement("div") as unknown as HTMLDivElement;
  domWindow.document.body.append(container as never);
  const root = createRoot(container);
  await act(async () => {
    root.render(<Harness sessionId="modified-keys" revision={0} mode="expanded" scope="modified-keys" />);
  });
  const transcript = container.firstElementChild as HTMLElement;
  setScrollMetrics(transcript, { scrollTop: 400, scrollHeight: 1_000, clientHeight: 200 });
  transcript.scrollTo = (() => {}) as typeof transcript.scrollTo;

  await act(async () => {
    transcript.dispatchEvent(new domWindow.WheelEvent("wheel", { deltaY: -1, bubbles: true }) as never);
  });
  assert.equal(transcript.dataset.state, "paused");

  const bubbled: string[] = [];
  const record = (event: unknown): void => {
    bubbled.push((event as { key: string }).key);
  };
  domWindow.addEventListener("keydown", record);
  const openReview = new domWindow.KeyboardEvent("keydown", {
    key: "G",
    shiftKey: true,
    ctrlKey: true,
    bubbles: true,
    cancelable: true,
  });
  await act(async () => { transcript.dispatchEvent(openReview as never); });
  assert.equal(openReview.defaultPrevented, false);
  assert.equal(transcript.dataset.state, "paused", "Ctrl+Shift+G must not resume follow");

  await act(async () => {
    transcript.dispatchEvent(new domWindow.KeyboardEvent("keydown", {
      key: "End",
      bubbles: true,
      cancelable: true,
    }) as never);
  });
  assert.equal(transcript.dataset.state, "following");
  const search = new domWindow.KeyboardEvent("keydown", {
    key: "k",
    metaKey: true,
    bubbles: true,
    cancelable: true,
  });
  await act(async () => { transcript.dispatchEvent(search as never); });
  assert.equal(search.defaultPrevented, false);
  assert.equal(transcript.dataset.state, "following", "Meta+K must not persist an unrelated pause");
  assert.deepEqual(bubbled, ["G", "End", "k"], "handled and unrelated keys bubble; defaultPrevented owns dispatch");

  domWindow.removeEventListener("keydown", record);
  await act(async () => { root.unmount(); });
  container.remove();
});

test("Inbox preview bare k leaves the departing session following", async () => {
  const container = domWindow.document.createElement("div") as unknown as HTMLDivElement;
  domWindow.document.body.append(container as never);
  let root = createRoot(container);
  const render = async () => {
    await act(async () => {
      root.render(<Harness sessionId="preview-k" revision={0} mode="preview" scope="preview-k" />);
    });
    return container.firstElementChild as HTMLElement;
  };

  let transcript = await render();
  setScrollMetrics(transcript, { scrollTop: 800, scrollHeight: 1_000, clientHeight: 200 });
  transcript.scrollTo = (() => {}) as typeof transcript.scrollTo;
  await act(async () => {
    transcript.dispatchEvent(new domWindow.KeyboardEvent("keydown", { key: "k", bubbles: true }) as never);
  });
  assert.equal(transcript.dataset.state, "following", "Inbox navigation owns bare k in preview mode");

  await act(async () => { root.unmount(); });
  root = createRoot(container);
  transcript = await render();
  assert.equal(transcript.dataset.state, "following", "preview k must not persist an accidental pause snapshot");
  await act(async () => { root.unmount(); });
  container.remove();
});

test("bare scroll intent pauses during the bounded streaming settle window", async () => {
  const container = domWindow.document.createElement("div") as unknown as HTMLDivElement;
  domWindow.document.body.append(container as never);
  const root = createRoot(container);
  await act(async () => {
    root.render(<Harness sessionId="settle-intent" revision={0} mode="expanded" scope="settle-intent" />);
  });
  const transcript = container.firstElementChild as HTMLElement;
  setScrollMetrics(transcript, { scrollTop: 800, scrollHeight: 1_000, clientHeight: 200 });
  transcript.scrollTo = (({ top }: ScrollToOptions) => {
    setScrollMetrics(transcript, {
      scrollTop: typeof top === "number" ? top : transcript.scrollTop,
      scrollHeight: transcript.scrollHeight,
      clientHeight: transcript.clientHeight,
    });
  }) as typeof transcript.scrollTo;

  await act(async () => {
    root.render(<Harness sessionId="settle-intent" revision={1} mode="expanded" scope="settle-intent" />);
  });
  await act(async () => {
    setScrollMetrics(transcript, { scrollTop: 420, scrollHeight: 1_000, clientHeight: 200 });
    transcript.dispatchEvent(new domWindow.Event("scroll", { bubbles: true }) as never);
    await new Promise<void>((resolve) => setTimeout(resolve, FOLLOW_TAIL_SCROLL_INTENT_DELAY_MS + 25));
  });

  assert.equal(transcript.dataset.state, "paused",
    "settle frames after the first mutation frame must not veto scrollbar or assistive intent");
  await act(async () => { root.unmount(); });
  container.remove();
});

/** A touch event for the fingers `changed`, with `down` the fingers still on the page after it. */
function touchEvent(type: "touchstart" | "touchend", changed: readonly number[], down: readonly number[]): Event {
  const event = new domWindow.Event(type, { bubbles: true }) as unknown as Event;
  const list = (ids: readonly number[]) => ids.map((identifier) => ({ identifier, clientY: 0 }));
  Object.defineProperty(event, "changedTouches", { value: list(changed) });
  Object.defineProperty(event, "touches", { value: list(down) });
  return event;
}

function pointerEvent(type: "pointerdown" | "pointerup", pointerId: number): Event {
  const event = new domWindow.Event(type, { bubbles: true }) as unknown as Event;
  Object.defineProperty(event, "pointerId", { value: pointerId });
  Object.defineProperty(event, "pointerType", { value: "touch" });
  return event;
}

test("a held touch that turns back from the tail pauses at once, while layout and a lifted finger do not (#2549)", async () => {
  MockResizeObserver.instances.length = 0;
  const container = domWindow.document.createElement("div") as unknown as HTMLDivElement;
  domWindow.document.body.append(container as never);
  const root = createRoot(container);
  await act(async () => {
    root.render(<Harness sessionId="touch-reversal" revision={0} mode="expanded" scope="touch-reversal" />);
  });
  const transcript = container.firstElementChild as HTMLElement;
  setScrollMetrics(transcript, { scrollTop: 600, scrollHeight: 1_000, clientHeight: 200 });
  const scrollRequests: ScrollToOptions[] = [];
  transcript.scrollTo = ((options: ScrollToOptions) => {
    scrollRequests.push(options);
    setScrollMetrics(transcript, {
      scrollTop: Math.min(Number(options.top), transcript.scrollHeight - transcript.clientHeight),
      scrollHeight: transcript.scrollHeight,
      clientHeight: transcript.clientHeight,
    });
  }) as typeof transcript.scrollTo;
  const viewportObserver = MockResizeObserver.instances.find((observer) => observer.observed.has(transcript));
  assert.ok(viewportObserver);
  const scrollTo = async (scrollTop: number, scrollHeight = transcript.scrollHeight) => {
    setScrollMetrics(transcript, { scrollTop, scrollHeight, clientHeight: 200 });
    await act(async () => { transcript.dispatchEvent(new domWindow.Event("scroll", { bubbles: true }) as never); });
  };

  // The press pauses; the pan reaches the tail and resumes there.
  await act(async () => { transcript.dispatchEvent(touchEvent("touchstart", [1], [1]) as never); });
  assert.equal(transcript.dataset.state, "paused");
  await scrollTo(700);
  await scrollTo(800);
  assert.equal(transcript.dataset.state, "following");

  // Content shrinking under the held finger clamps the reader up: layout, not reading back.
  setScrollMetrics(transcript, { scrollTop: 800, scrollHeight: 950, clientHeight: 200 });
  await act(async () => { viewportObserver.trigger(); });
  await scrollTo(750, 950);
  assert.equal(transcript.dataset.state, "following", "a layout clamp under a held finger keeps following");

  // Turning back a single step, inside the 48px tail band, reads back at once.
  await scrollTo(725, 950);
  assert.equal(transcript.dataset.state, "paused", "a held finger turning back from the tail pauses");
  scrollRequests.length = 0;
  await act(async () => {
    root.render(<Harness sessionId="touch-reversal" revision={1} mode="expanded" scope="touch-reversal" />);
  });
  assert.equal(scrollRequests.length, 0, "streamed output leaves the reader where the finger left it");

  // Back at the tail it follows again; once the finger lifts, a small upward scroll inside the
  // tail band is no longer a turn-back and keeps following, as before.
  await scrollTo(750, 950);
  assert.equal(transcript.dataset.state, "following");
  await act(async () => { transcript.dispatchEvent(touchEvent("touchend", [1], []) as never); });
  await scrollTo(725, 950);
  assert.equal(transcript.dataset.state, "following", "without a held finger the tail band still applies");

  await act(async () => { root.unmount(); });
  container.remove();
});

test("each held finger is released by its own end, wherever that end is delivered (#2549)", async () => {
  interface Fingers { transcript: HTMLElement; row: HTMLElement; outside: HTMLElement }
  const dispatch = async (target: EventTarget, event: Event) => {
    await act(async () => { target.dispatchEvent(event as never); });
  };
  const cases: Array<{ name: string; held: boolean; gesture: (fingers: Fingers) => Promise<void> }> = [
    {
      name: "a finger that is still down",
      held: true,
      gesture: async ({ row }) => { await dispatch(row, touchEvent("touchstart", [1], [1])); },
    },
    {
      name: "a reader finger that lifts before a finger outside the reader",
      held: false,
      gesture: async ({ row, outside }) => {
        await dispatch(row, touchEvent("touchstart", [1], [1]));
        await dispatch(outside, touchEvent("touchstart", [2], [1, 2]));
        await dispatch(row, touchEvent("touchend", [1], [2]));
        await dispatch(outside, touchEvent("touchend", [2], []));
      },
    },
    {
      name: "one of two reader fingers, while the other stays down",
      held: true,
      gesture: async ({ row, transcript }) => {
        await dispatch(row, touchEvent("touchstart", [1], [1]));
        await dispatch(transcript, touchEvent("touchstart", [2], [1, 2]));
        await dispatch(row, touchEvent("touchend", [1], [2]));
      },
    },
    {
      name: "a finger whose row a re-render removed before it lifted",
      held: false,
      gesture: async ({ row }) => {
        await dispatch(row, touchEvent("touchstart", [1], [1]));
        row.remove();
        await dispatch(row, touchEvent("touchend", [1], []));
      },
    },
    {
      name: "a touch pointer that lifts outside the reader",
      held: false,
      gesture: async ({ transcript, outside }) => {
        await dispatch(transcript, pointerEvent("pointerdown", 7));
        await dispatch(outside, pointerEvent("pointerup", 7));
      },
    },
    {
      name: "a touch pointer while another pointer lifts",
      held: true,
      gesture: async ({ transcript, outside }) => {
        await dispatch(transcript, pointerEvent("pointerdown", 7));
        await dispatch(outside, pointerEvent("pointerup", 8));
      },
    },
  ];
  for (const [index, { name, held, gesture }] of cases.entries()) {
    const container = domWindow.document.createElement("div") as unknown as HTMLDivElement;
    const outside = domWindow.document.createElement("div") as unknown as HTMLElement;
    domWindow.document.body.append(container as never, outside as never);
    const root = createRoot(container);
    const scope = `touch-release-${index}`;
    await act(async () => { root.render(<Harness sessionId={scope} revision={0} mode="expanded" scope={scope} />); });
    const transcript = container.firstElementChild as HTMLElement;
    const row = domWindow.document.createElement("div") as unknown as HTMLElement;
    transcript.append(row as never);
    setScrollMetrics(transcript, { scrollTop: 800, scrollHeight: 1_000, clientHeight: 200 });
    transcript.scrollTo = (() => {}) as typeof transcript.scrollTo;
    const scrollTo = async (scrollTop: number) => {
      setScrollMetrics(transcript, { scrollTop, scrollHeight: 1_000, clientHeight: 200 });
      await dispatch(transcript, new domWindow.Event("scroll", { bubbles: true }) as unknown as Event);
    };

    await gesture({ transcript, row, outside });
    await scrollTo(800);
    assert.equal(transcript.dataset.state, "following", `${name}: at the tail`);
    await scrollTo(775);
    assert.equal(transcript.dataset.state, held ? "paused" : "following",
      held ? `${name} is held, so turning back pauses` : `${name} is released, so the tail band applies`);

    await act(async () => { root.unmount(); });
    container.remove();
    outside.remove();
  }
});

test("a press that lifts at the tail resumes following, while one that carried the reader away stays paused (#2526)", async () => {
  MockResizeObserver.instances.length = 0;
  const container = domWindow.document.createElement("div") as unknown as HTMLDivElement;
  const outside = domWindow.document.createElement("div") as unknown as HTMLElement;
  domWindow.document.body.append(container as never, outside as never);
  const root = createRoot(container);
  await act(async () => {
    root.render(<Harness sessionId="tap-release" revision={0} mode="expanded" scope="tap-release" />);
  });
  const transcript = container.firstElementChild as HTMLElement;
  transcript.scrollTo = (() => {}) as typeof transcript.scrollTo;
  const viewportObserver = MockResizeObserver.instances.find((observer) => observer.observed.has(transcript));
  assert.ok(viewportObserver);
  const dispatch = async (target: EventTarget, event: Event) => {
    await act(async () => { target.dispatchEvent(event as never); });
  };
  const scrollTo = async (scrollTop: number) => {
    setScrollMetrics(transcript, { scrollTop, scrollHeight: 1_000, clientHeight: 200 });
    await dispatch(transcript, new domWindow.Event("scroll", { bubbles: true }) as unknown as Event);
  };
  setScrollMetrics(transcript, { scrollTop: 800, scrollHeight: 1_000, clientHeight: 200 });
  await act(async () => { viewportObserver.trigger(); });
  assert.equal(transcript.dataset.canScroll, "true");

  // A tap on a control in the transcript: the press pauses, and the lift at the tail resumes.
  await dispatch(transcript, touchEvent("touchstart", [1], [1]));
  assert.equal(transcript.dataset.state, "paused", "the press pauses, as it always has");
  await dispatch(transcript, touchEvent("touchend", [1], []));
  assert.equal(transcript.dataset.state, "following", "a tap at the tail is not reading");

  // The same tap reported as both a touch pointer and a native touch resumes only once both lift.
  await dispatch(transcript, pointerEvent("pointerdown", 3));
  await dispatch(transcript, touchEvent("touchstart", [1], [1]));
  await dispatch(outside, pointerEvent("pointerup", 3));
  assert.equal(transcript.dataset.state, "paused", "a finger still down keeps the reader paused");
  await dispatch(transcript, touchEvent("touchend", [1], []));
  assert.equal(transcript.dataset.state, "following");

  // A pan that carried the reader away stays paused when it lifts, and a later tap there too.
  await dispatch(transcript, touchEvent("touchstart", [2], [2]));
  await scrollTo(500);
  await dispatch(transcript, touchEvent("touchend", [2], []));
  assert.equal(transcript.dataset.state, "paused", "a pan away from the tail is reading");
  await dispatch(transcript, touchEvent("touchstart", [3], [3]));
  await dispatch(transcript, touchEvent("touchend", [3], []));
  assert.equal(transcript.dataset.state, "paused", "a tap away from the tail leaves the reader where it is");
  await scrollTo(800);
  assert.equal(transcript.dataset.state, "following");

  // A pan inside a nested scroller (a tool output) leaves the reader itself at the tail, but it is
  // reading: the lift keeps the pause.
  const well = domWindow.document.createElement("pre") as unknown as HTMLElement;
  transcript.append(well as never);
  await dispatch(well, touchEvent("touchstart", [4], [4]));
  await dispatch(well, new domWindow.Event("scroll") as unknown as Event);
  await dispatch(well, touchEvent("touchend", [4], []));
  assert.equal(transcript.dataset.state, "paused", "a nested pan is reading, though the reader stayed at the tail");
  await scrollTo(800);
  assert.equal(transcript.dataset.state, "following");

  // A pan up from the tail that layout then clamps back to the bottom keeps the pause the scroll
  // rules gave it; the lift does not override them.
  await dispatch(transcript, touchEvent("touchstart", [5], [5]));
  await scrollTo(600);
  assert.equal(transcript.dataset.state, "paused");
  setScrollMetrics(transcript, { scrollTop: 600, scrollHeight: 1_000, clientHeight: 400 });
  await act(async () => { viewportObserver.trigger(); });
  await dispatch(transcript, new domWindow.Event("scroll", { bubbles: true }) as unknown as Event);
  assert.equal(transcript.dataset.state, "paused", "a layout clamp to the bottom is not the reader's");
  await dispatch(transcript, touchEvent("touchend", [5], []));
  assert.equal(transcript.dataset.state, "paused", "a press that panned is not a tap, wherever it lifts");

  // A tap that begins paused, even at the bottom, leaves the pause alone.
  await dispatch(transcript, touchEvent("touchstart", [6], [6]));
  await dispatch(transcript, touchEvent("touchend", [6], []));
  assert.equal(transcript.dataset.state, "paused", "only a press that began while following is a tap to undo");

  // A transcript with nothing to scroll reports it, so its owner offers no jump.
  setScrollMetrics(transcript, { scrollTop: 0, scrollHeight: 200, clientHeight: 200 });
  await act(async () => { viewportObserver.trigger(); });
  assert.equal(transcript.dataset.canScroll, "false");

  await act(async () => { root.unmount(); });
  container.remove();
  outside.remove();
});

test("previewing and paused sessions restore distinct logical anchors without following backfill", async () => {
  MockResizeObserver.instances.length = 0;
  const container = domWindow.document.createElement("div") as unknown as HTMLDivElement;
  domWindow.document.body.append(container as never);
  const root = createRoot(container);
  let api!: FollowTailApi;
  const captureApi = (next: FollowTailApi) => { api = next; };
  const render = async (sessionId: string, revision: number, mode: "preview" | "expanded" = "preview") => {
    await act(async () => {
      root.render(
        <Harness
          sessionId={sessionId}
          revision={revision}
          mode={mode}
          scope="anchor-persistence"
          onApi={captureApi}
        />,
      );
    });
  };

  await render("alpha", 0);
  const transcript = container.firstElementChild as HTMLElement;
  setScrollMetrics(transcript, { scrollTop: 400, scrollHeight: 1_000, clientHeight: 200 });
  const scrollRequests: ScrollToOptions[] = [];
  transcript.scrollTo = ((options: ScrollToOptions) => scrollRequests.push(options)) as typeof transcript.scrollTo;
  await act(async () => {
    api.onVisibleAnchorChange({ key: "alpha-row-7", offset: -13 });
    api.preview();
  });
  assert.equal(transcript.dataset.state, "previewing");

  scrollRequests.length = 0;
  await render("alpha", 1, "expanded");
  for (const observer of MockResizeObserver.instances) observer.trigger();
  await act(async () => { await new Promise<void>((resolve) => domWindow.requestAnimationFrame(() => resolve())); });
  assert.equal(transcript.dataset.state, "previewing", "panel mode and history updates preserve previewing");
  assert.equal(scrollRequests.length, 0, "streaming and measurements never move a previewing reader");

  await render("beta", 1);
  assert.equal(transcript.dataset.state, "following", "a new session starts at live output");
  await act(async () => {
    api.onVisibleAnchorChange({ key: "beta-row-3", offset: 6 });
    api.pause();
  });
  assert.equal(transcript.dataset.state, "paused");

  await render("alpha", 2, "expanded");
  assert.equal(transcript.dataset.state, "previewing");
  assert.equal(transcript.dataset.anchorKey, "alpha-row-7");
  assert.equal(transcript.dataset.anchorOffset, "-13");
  assert.equal(scrollRequests.at(-1)?.top, 1_000,
    "only the intervening following session requested the live bottom");

  await act(async () => {
    transcript.dispatchEvent(new domWindow.KeyboardEvent("keydown", { key: "G", shiftKey: true, bubbles: true }) as never);
  });
  assert.equal(transcript.dataset.state, "following", "G resumes from previewing");

  await render("beta", 2);
  assert.equal(transcript.dataset.state, "paused");
  assert.equal(transcript.dataset.anchorKey, "beta-row-3");
  assert.equal(transcript.dataset.anchorOffset, "6");

  await act(async () => { root.unmount(); });
  container.remove();
});

test("fresh keyed hook mounts restore per-session state and logical anchors", async () => {
  const container = domWindow.document.createElement("div") as unknown as HTMLDivElement;
  domWindow.document.body.append(container as never);
  const root = createRoot(container);
  let api!: FollowTailApi;
  const render = async (sessionId: string) => {
    await act(async () => {
      root.render(
        <Harness
          key={sessionId}
          sessionId={sessionId}
          revision={0}
          mode="preview"
          scope="keyed-lifecycle"
          onApi={(next) => { api = next; }}
        />,
      );
    });
    return container.firstElementChild as HTMLElement;
  };

  let transcript = await render("alpha");
  await act(async () => {
    api.onVisibleAnchorChange({ key: "alpha-row-9", offset: -17 });
    api.preview();
  });
  assert.equal(transcript.dataset.state, "previewing");

  transcript = await render("beta");
  assert.equal(transcript.dataset.state, "following", "a fresh session mount starts independently");
  await act(async () => {
    api.onVisibleAnchorChange({ key: "beta-row-4", offset: 8 });
    api.pause();
  });

  transcript = await render("alpha");
  assert.equal(transcript.dataset.state, "previewing");
  assert.equal(transcript.dataset.anchorKey, "alpha-row-9");
  assert.equal(transcript.dataset.anchorOffset, "-17");

  transcript = await render("beta");
  assert.equal(transcript.dataset.state, "paused");
  assert.equal(transcript.dataset.anchorKey, "beta-row-4");
  assert.equal(transcript.dataset.anchorOffset, "8");

  await act(async () => { root.unmount(); });
  container.remove();
});

test("the live initial-anchor getter retains identity across paused parent renders", async () => {
  const container = domWindow.document.createElement("div") as unknown as HTMLDivElement;
  domWindow.document.body.append(container as never);
  let root = createRoot(container);
  let api!: FollowTailApi;
  await act(async () => {
    root.render(
      <Harness
        sessionId="stable-anchor"
        revision={0}
        mode="preview"
        scope="stable-anchor"
        onApi={(next) => { api = next; }}
      />,
    );
  });
  await act(async () => {
    api.onVisibleAnchorChange({ key: "stable-row", offset: -9, index: 4 });
    api.pause();
  });
  await act(async () => { root.unmount(); });

  let boundaryRenders = 0;
  const AnchorMemoBoundary = React.memo(function AnchorMemoBoundary({ getInitialAnchor }: {
    getInitialAnchor: FollowTailApi["getInitialAnchor"];
  }) {
    boundaryRenders += 1;
    return <output data-testid="anchor-boundary">{getInitialAnchor()?.key}</output>;
  });
  function ParentHarness() {
    const [unrelated, setUnrelated] = React.useState(0);
    const scrollRef = React.useRef<HTMLDivElement>(null);
    const followTail = useFollowTail({
      scrollRef,
      contentRevision: 0,
      sessionId: "stable-anchor",
      persistenceScope: "stable-anchor",
    });
    React.useLayoutEffect(() => { api = followTail; });
    return (
      <div ref={scrollRef} data-state={followTail.state}>
        <button type="button" onClick={() => setUnrelated((value) => value + 1)}>Render {unrelated}</button>
        <AnchorMemoBoundary getInitialAnchor={followTail.getInitialAnchor} />
      </div>
    );
  }

  root = createRoot(container);
  await act(async () => { root.render(<ParentHarness />); });
  const firstGetter = api.getInitialAnchor;
  assert.deepEqual(firstGetter(), { key: "stable-row", offset: -9, index: 4 });
  assert.equal(boundaryRenders, 1);

  const current = { key: "new-current-row", offset: 7, index: 9 };
  await act(async () => { api.onVisibleAnchorChange(current); });
  assert.deepEqual(firstGetter(), current, "a keyed timeline remount reads the latest persisted anchor");

  await act(async () => {
    (container.querySelector("button") as HTMLButtonElement).click();
  });
  assert.equal(Object.is(api.getInitialAnchor, firstGetter), true,
    "live persistence updates must not mint a new getter prop");
  assert.equal(boundaryRenders, 1, "a shallow memo boundary must survive an unrelated paused parent render");

  await act(async () => { root.unmount(); });
  container.remove();
});

test("losing the saved logical row clears the snapshot and recovers to the live tail", async () => {
  const container = domWindow.document.createElement("div") as unknown as HTMLDivElement;
  domWindow.document.body.append(container as never);
  let root = createRoot(container);
  let api!: FollowTailApi;
  const render = async () => {
    await act(async () => {
      root.render(
        <Harness
          sessionId="lost-anchor"
          revision={0}
          mode="preview"
          scope="lost-anchor"
          onApi={(next) => { api = next; }}
        />,
      );
    });
  };
  await render();
  const transcript = container.firstElementChild as HTMLElement;
  setScrollMetrics(transcript, { scrollTop: 300, scrollHeight: 1_000, clientHeight: 200 });
  const scrollRequests: ScrollToOptions[] = [];
  transcript.scrollTo = ((options: ScrollToOptions) => scrollRequests.push(options)) as typeof transcript.scrollTo;
  const lost = { key: "removed-row", offset: -11 };
  await act(async () => {
    api.onVisibleAnchorChange(lost);
    api.preview();
  });
  assert.equal(transcript.dataset.state, "previewing");
  assert.deepEqual(api.getInitialAnchor(), lost, "the mount getter reads the latest live persistence anchor");

  await act(async () => { api.onAnchorLost(lost); });
  assert.equal(transcript.dataset.state, "following");
  assert.equal(transcript.dataset.anchorKey, undefined);
  assert.equal(scrollRequests.at(-1)?.top, 1_000);

  await act(async () => { root.unmount(); });
  root = createRoot(container);
  await render();
  const restored = container.firstElementChild as HTMLElement;
  assert.equal(restored.dataset.state, "following", "the dead row must not survive in the persisted snapshot");
  assert.equal(restored.dataset.anchorKey, undefined);

  await act(async () => { root.unmount(); });
  container.remove();
});

test("composer growth and shrink are layout, never reader intent", async () => {
  MockResizeObserver.instances.length = 0;
  const container = domWindow.document.createElement("div") as unknown as HTMLDivElement;
  domWindow.document.body.append(container as never);
  const root = createRoot(container);
  await act(async () => {
    root.render(<Harness sessionId="composer-resize" revision={0} mode="expanded" scope="composer-resize" />);
  });
  const transcript = container.firstElementChild as HTMLElement;
  setScrollMetrics(transcript, { scrollTop: 800, scrollHeight: 1_000, clientHeight: 200 });
  const scrollRequests: ScrollToOptions[] = [];
  transcript.scrollTo = (({ top }: ScrollToOptions) => {
    scrollRequests.push({ top });
    const target = typeof top === "number" ? top : transcript.scrollTop;
    setScrollMetrics(transcript, {
      // A real browser clamps the request to the current maximum scroll offset.
      scrollTop: Math.min(target, transcript.scrollHeight - transcript.clientHeight),
      scrollHeight: transcript.scrollHeight,
      clientHeight: transcript.clientHeight,
    });
  }) as typeof transcript.scrollTo;
  const viewportObserver = MockResizeObserver.instances.find((observer) => observer.observed.has(transcript));
  assert.ok(viewportObserver);

  await act(async () => {
    root.render(<Harness sessionId="composer-resize" revision={1} mode="expanded" scope="composer-resize" />);
  });
  assert.equal(transcript.dataset.state, "following");

  // A wrapping draft grows the composer: the viewport shrinks without any scroll event.
  setScrollMetrics(transcript, { scrollTop: 800, scrollHeight: 1_000, clientHeight: 120 });
  scrollRequests.length = 0;
  await act(async () => { viewportObserver.trigger(); });
  assert.equal(scrollRequests.at(-1)?.top, 1_000,
    "a shrinking viewport re-pins the tail in the same pre-paint resize delivery, not a frame later");
  await act(async () => {
    transcript.dispatchEvent(new domWindow.Event("scroll", { bubbles: true }) as never);
    await new Promise<void>((resolve) => setTimeout(resolve, FOLLOW_TAIL_SCROLL_INTENT_DELAY_MS + 25));
  });
  assert.equal(transcript.dataset.state, "following", "composer growth must never flip a follower to Paused");

  // Deleting the draft shrinks the composer: the browser clamps scrollTop onto the new bottom and
  // delivers that scroll event before the resize callback.
  setScrollMetrics(transcript, { scrollTop: 760, scrollHeight: 1_000, clientHeight: 240 });
  await act(async () => {
    transcript.dispatchEvent(new domWindow.Event("scroll", { bubbles: true }) as never);
    viewportObserver.trigger();
    await new Promise<void>((resolve) => setTimeout(resolve, FOLLOW_TAIL_SCROLL_INTENT_DELAY_MS + 25));
  });
  assert.equal(transcript.dataset.state, "following", "composer shrink keeps the tail followed");

  // A reader paused just above the tail: composer shrink clamps its scrollTop exactly onto the
  // bottom. That layout-driven scroll must not resume following or move the logical anchor.
  await act(async () => {
    transcript.dispatchEvent(new domWindow.WheelEvent("wheel", { deltaY: -1, bubbles: true }) as never);
  });
  assert.equal(transcript.dataset.state, "paused");
  setScrollMetrics(transcript, { scrollTop: 755, scrollHeight: 1_000, clientHeight: 240 });
  await act(async () => { transcript.dispatchEvent(new domWindow.Event("scroll", { bubbles: true }) as never); });
  assert.equal(transcript.dataset.state, "paused");
  scrollRequests.length = 0;
  setScrollMetrics(transcript, { scrollTop: 700, scrollHeight: 1_000, clientHeight: 300 });
  await act(async () => { transcript.dispatchEvent(new domWindow.Event("scroll", { bubbles: true }) as never); });
  assert.equal(transcript.dataset.state, "paused",
    "a clamped bottom landing during a viewport resize is layout, not reader intent");
  await act(async () => {
    viewportObserver.trigger();
    await new Promise<void>((resolve) => domWindow.requestAnimationFrame(() => resolve()));
  });
  assert.equal(transcript.dataset.state, "paused");
  assert.equal(scrollRequests.length, 0, "composer resizes must not move a paused reader's anchor");

  // Genuine reader movement deviates from the clamp prediction and still resumes at the bottom.
  setScrollMetrics(transcript, { scrollTop: 650, scrollHeight: 1_000, clientHeight: 300 });
  await act(async () => { transcript.dispatchEvent(new domWindow.Event("scroll", { bubbles: true }) as never); });
  assert.equal(transcript.dataset.state, "paused");
  setScrollMetrics(transcript, { scrollTop: 700, scrollHeight: 1_000, clientHeight: 300 });
  await act(async () => { transcript.dispatchEvent(new domWindow.Event("scroll", { bubbles: true }) as never); });
  assert.equal(transcript.dataset.state, "following", "an actual reader return to the tail resumes following");

  await act(async () => { root.unmount(); });
  container.remove();
});

test("position accounting: deviating landings resume, predicted clamps never do, in either delivery order", async () => {
  MockResizeObserver.instances.length = 0;
  const container = domWindow.document.createElement("div") as unknown as HTMLDivElement;
  domWindow.document.body.append(container as never);
  const root = createRoot(container);
  await act(async () => {
    root.render(<Harness sessionId="position-accounting" revision={0} mode="expanded" scope="position-accounting" />);
  });
  const transcript = container.firstElementChild as HTMLElement;
  setScrollMetrics(transcript, { scrollTop: 700, scrollHeight: 1_000, clientHeight: 200 });
  transcript.scrollTo = (() => {}) as typeof transcript.scrollTo;
  const viewportObserver = MockResizeObserver.instances.find((observer) => observer.observed.has(transcript));
  assert.ok(viewportObserver);

  await act(async () => {
    transcript.dispatchEvent(new domWindow.WheelEvent("wheel", { deltaY: -1, bubbles: true }) as never);
  });
  assert.equal(transcript.dataset.state, "paused");
  await act(async () => { transcript.dispatchEvent(new domWindow.Event("scroll", { bubbles: true }) as never); });
  assert.equal(transcript.dataset.state, "paused", "mid-transcript scrolls prime the geometry sample");

  // A BARE landing on the live tail while a streamed chunk grew scrollHeight in the same turn:
  // growth predicts an unchanged scrollTop of 700, so this deviates and is the reader's. No wheel,
  // touch, or pointer event precedes it — the same shape as assistive-technology scrolling or a
  // reading key's scrollBy, whose keydown is consumed elsewhere with preventDefault.
  setScrollMetrics(transcript, { scrollTop: 900, scrollHeight: 1_100, clientHeight: 200 });
  await act(async () => { transcript.dispatchEvent(new domWindow.Event("scroll", { bubbles: true }) as never); });
  assert.equal(transcript.dataset.state, "following",
    "a bare reader landing on the streamed bottom must resume even though geometry moved in the same turn");

  await act(async () => {
    transcript.dispatchEvent(new domWindow.WheelEvent("wheel", { deltaY: -1, bubbles: true }) as never);
  });
  assert.equal(transcript.dataset.state, "paused");
  setScrollMetrics(transcript, { scrollTop: 855, scrollHeight: 1_100, clientHeight: 200 });
  await act(async () => { transcript.dispatchEvent(new domWindow.Event("scroll", { bubbles: true }) as never); });
  assert.equal(transcript.dataset.state, "paused");

  // Chromium's real composer-shrink ordering: the ResizeObserver delivers the grown, already
  // clamped viewport BEFORE the clamped scroll event. The prediction must be recorded at the
  // resize delivery, or this scroll would compare against settled geometry and read as a landing.
  setScrollMetrics(transcript, { scrollTop: 800, scrollHeight: 1_100, clientHeight: 300 });
  await act(async () => { viewportObserver.trigger(); });
  await act(async () => { transcript.dispatchEvent(new domWindow.Event("scroll", { bubbles: true }) as never); });
  assert.equal(transcript.dataset.state, "paused",
    "a clamp whose resize callback delivers before its scroll event must not resume a paused reader");

  // The reader moves back up; virtualizer compensations then preserve the reading distance while
  // rows above grow. Each deviates from the growth prediction (which forecasts an unchanged
  // scrollTop), consumes it, and never lands at the bottom — no timing window is involved.
  setScrollMetrics(transcript, { scrollTop: 700, scrollHeight: 1_100, clientHeight: 300 });
  await act(async () => { transcript.dispatchEvent(new domWindow.Event("scroll", { bubbles: true }) as never); });
  assert.equal(transcript.dataset.state, "paused");
  setScrollMetrics(transcript, { scrollTop: 730, scrollHeight: 1_130, clientHeight: 300 });
  await act(async () => { transcript.dispatchEvent(new domWindow.Event("scroll", { bubbles: true }) as never); });
  assert.equal(transcript.dataset.state, "paused", "an above-viewport growth compensation is not a landing");
  setScrollMetrics(transcript, { scrollTop: 760, scrollHeight: 1_160, clientHeight: 300 });
  await act(async () => { transcript.dispatchEvent(new domWindow.Event("scroll", { bubbles: true }) as never); });
  assert.equal(transcript.dataset.state, "paused");

  // A clamp immediately after those corrections still matches its own prediction (scroll event
  // first, resize callback second this time): classification is positional, not timed.
  setScrollMetrics(transcript, { scrollTop: 740, scrollHeight: 1_160, clientHeight: 420 });
  await act(async () => {
    transcript.dispatchEvent(new domWindow.Event("scroll", { bubbles: true }) as never);
    viewportObserver.trigger();
  });
  assert.equal(transcript.dataset.state, "paused",
    "recent corrections must not let a scroll-first clamp read as a reader landing");

  // And a further deviating landing on a freshly streamed bottom still resumes.
  setScrollMetrics(transcript, { scrollTop: 780, scrollHeight: 1_200, clientHeight: 420 });
  await act(async () => { transcript.dispatchEvent(new domWindow.Event("scroll", { bubbles: true }) as never); });
  assert.equal(transcript.dataset.state, "following",
    "position accounting keeps genuine bottom landings resuming after any clamp history");

  await act(async () => { root.unmount(); });
  container.remove();
});

test("following tracks late virtual measurements while paused readers remain anchored", async () => {
  MockResizeObserver.instances.length = 0;
  const container = domWindow.document.createElement("div") as unknown as HTMLDivElement;
  domWindow.document.body.append(container as never);
  const root = createRoot(container);
  await act(async () => { root.render(<Harness sessionId="late-height" revision={0} mode="preview" />); });

  const transcript = container.firstElementChild as HTMLElement;
  const viewportObserver = MockResizeObserver.instances.find((observer) => observer.observed.has(transcript));
  assert.ok(viewportObserver, "follow-tail observes the reader viewport, not only its virtual rows");
  setScrollMetrics(transcript, { scrollTop: 800, scrollHeight: 1_000, clientHeight: 200 });
  const scrollRequests: ScrollToOptions[] = [];
  transcript.scrollTo = ((options: ScrollToOptions) => scrollRequests.push(options)) as typeof transcript.scrollTo;

  await act(async () => { root.render(<Harness sessionId="late-height" revision={1} mode="preview" />); });
  assert.equal(scrollRequests.at(-1)?.top, 1_000, "the committed stream update follows immediately");

  setScrollMetrics(transcript, { scrollTop: 800, scrollHeight: 1_240, clientHeight: 200 });
  await act(async () => {
    transcript.dispatchEvent(new domWindow.Event("scroll", { bubbles: true }) as never);
    viewportObserver.trigger();
    await new Promise<void>((resolve) => setTimeout(resolve, FOLLOW_TAIL_SCROLL_INTENT_DELAY_MS + 10));
  });
  assert.equal(scrollRequests.at(-1)?.top, 1_240,
    "a virtual row measured after commit must advance the live transcript to its new bottom");
  assert.equal(transcript.dataset.state, "following");

  setScrollMetrics(transcript, { scrollTop: 410, scrollHeight: 1_240, clientHeight: 200 });
  await act(async () => {
    viewportObserver.trigger();
    transcript.dispatchEvent(new domWindow.Event("scroll", { bubbles: true }) as never);
    await new Promise<void>((resolve) => setTimeout(resolve, FOLLOW_TAIL_SCROLL_INTENT_DELAY_MS + 10));
  });
  assert.equal(scrollRequests.at(-1)?.top, 1_240,
    "a scroll delivered after the viewport resize callback remains owned by follow-tail");
  assert.equal(transcript.dataset.state, "following",
    "layout-driven scroll timing must not be misclassified as reader intent");

  await act(async () => {
    transcript.dispatchEvent(new domWindow.PointerEvent("pointerdown", { bubbles: true }) as never);
  });
  assert.equal(transcript.dataset.state, "following", "an ordinary transcript click must not stop live following");

  await act(async () => {
    transcript.dispatchEvent(new domWindow.PointerEvent("pointermove", { buttons: 1, bubbles: true }) as never);
  });
  assert.equal(transcript.dataset.state, "paused", "dragging a scrollbar or text selection pauses live following");
  await act(async () => {
    transcript.dispatchEvent(new domWindow.KeyboardEvent("keydown", { key: "G", shiftKey: true, bubbles: true }) as never);
  });

  await act(async () => {
    transcript.dispatchEvent(new domWindow.WheelEvent("wheel", { deltaY: -1, bubbles: true }) as never);
  });
  assert.equal(transcript.dataset.state, "paused", "upward reader intent still pauses live following");
  scrollRequests.length = 0;
  setScrollMetrics(transcript, { scrollTop: 800, scrollHeight: 1_480, clientHeight: 200 });
  await act(async () => {
    for (const observer of MockResizeObserver.instances) observer.trigger();
    await new Promise<void>((resolve) => domWindow.requestAnimationFrame(() => resolve()));
  });
  assert.equal(scrollRequests.length, 0, "late measurements must not yank a paused reader");

  await act(async () => { root.unmount(); });
  container.remove();
});

test("a saved reading position is reported for load-shape decisions without disturbing it", async () => {
  const container = domWindow.document.createElement("div") as unknown as HTMLDivElement;
  domWindow.document.body.append(container as never);
  const root = createRoot(container);
  let api!: FollowTailApi;
  try {
    // Following the tail is not a saved position: there is nothing below an opening window that a
    // restore would depend on, so opening this session may read only its tail.
    assert.equal(hasSavedFollowTailAnchor("window-scope", "windowed-session"), false);
    await act(async () => {
      root.render(
        <Harness
          sessionId="windowed-session"
          revision={0}
          mode="preview"
          scope="window-scope"
          onApi={(next) => { api = next; }}
        />,
      );
    });
    assert.equal(hasSavedFollowTailAnchor("window-scope", "windowed-session"), false);

    // A visible anchor is recorded continuously, including while following. That is not a saved
    // position — `getInitialAnchor` returns null in that state — so it must not divert the open.
    await act(async () => {
      api.onVisibleAnchorChange({ key: "item:agent_message:46", offset: -9, index: 45 });
    });
    assert.equal(api.getInitialAnchor(), null);
    assert.equal(
      hasSavedFollowTailAnchor("window-scope", "windowed-session"),
      false,
      "following the tail leaves nothing below a window to restore",
    );

    await act(async () => { api.pause(); });
    assert.equal(hasSavedFollowTailAnchor("window-scope", "windowed-session"), true);

    // Resuming follow gives the position up again.
    await act(async () => { api.follow(); });
    assert.equal(hasSavedFollowTailAnchor("window-scope", "windowed-session"), false);
    await act(async () => { api.pause(); });
    assert.equal(
      hasSavedFollowTailAnchor("other-scope", "windowed-session"),
      false,
      "instances keep independent reading positions",
    );
    // Reading it must not consume it: the reader stays paused where they were.
    assert.equal(api.getInitialAnchor()?.key, "item:agent_message:46");
    assert.equal(api.state, "paused");
  } finally {
    await act(async () => { root.unmount(); });
  }
});

const nextFrame = () => new Promise<void>((resolve) => domWindow.requestAnimationFrame(() => resolve()));

/** A transcript whose scrollTo lands on the clamped request, counting each `scrollHeight` read: in a
 * browser every one forces a synchronous layout once anything has changed since the last. */
function instrumentTranscript(transcript: HTMLElement, metrics: FollowTailTestMetrics) {
  const counts = { heightReads: 0, scrolls: [] as number[] };
  let height = metrics.scrollHeight;
  setScrollMetrics(transcript, { scrollTop: metrics.scrollTop, scrollHeight: 0, clientHeight: metrics.clientHeight });
  Object.defineProperty(transcript, "scrollHeight", {
    configurable: true,
    get: () => { counts.heightReads += 1; return height; },
    set: (value: number) => { height = value; },
  });
  transcript.scrollTo = (({ top }: ScrollToOptions) => {
    counts.scrolls.push(top ?? Number.NaN);
    Object.defineProperty(transcript, "scrollTop", {
      configurable: true, writable: true, value: Math.min(top ?? 0, height - transcript.clientHeight),
    });
  }) as typeof transcript.scrollTo;
  return counts;
}

test("a row-resize report pins a following reader at once, and settle frames read no layout without a change (#2840)", async () => {
  const container = domWindow.document.createElement("div") as unknown as HTMLDivElement;
  domWindow.document.body.append(container as never);
  const root = createRoot(container);
  try {
    await act(async () => {
      root.render(<Harness sessionId="row-resize" revision={0} mode="expanded" scope="row-resize" />);
    });
    const transcript = container.firstElementChild as HTMLElement;
    const counts = instrumentTranscript(transcript, { scrollTop: 800, scrollHeight: 1_000, clientHeight: 200 });
    // Let the mount's converging window run out.
    await act(async () => { for (let frame = 0; frame < 10; frame += 1) await nextFrame(); });

    counts.heightReads = 0;
    counts.scrolls.length = 0;
    (transcript as unknown as { scrollHeight: number }).scrollHeight = 1_080;
    await act(async () => { transcript.dispatchEvent(new domWindow.Event(VIRTUAL_ROW_RESIZE_EVENT) as never); });
    assert.deepEqual(counts.scrolls, [1_080], "the grown row is pinned in the delivery that reports it, before paint");

    // A streamed chunk mutates the transcript; nothing else changes, so no settle frame re-reads.
    counts.heightReads = 0;
    counts.scrolls.length = 0;
    await act(async () => {
      for (let frame = 0; frame < 4; frame += 1) {
        transcript.append(domWindow.document.createTextNode("chunk") as never);
        await nextFrame();
      }
      for (let frame = 0; frame < 10; frame += 1) await nextFrame();
    });
    assert.equal(counts.heightReads, 0, "settle frames make no layout read for a change already pinned");
    assert.deepEqual(counts.scrolls, []);
    assert.equal(transcript.dataset.state, "following");

    // A paused reader is never moved by a row that grows.
    await act(async () => {
      transcript.dispatchEvent(new domWindow.WheelEvent("wheel", { deltaY: -1, bubbles: true }) as never);
    });
    assert.equal(transcript.dataset.state, "paused");
    await act(async () => {
      transcript.dispatchEvent(new domWindow.Event(VIRTUAL_ROW_RESIZE_EVENT) as never);
      await nextFrame();
    });
    assert.deepEqual(counts.scrolls, [], "a row resize must not yank a paused reader");
  } finally {
    await act(async () => { root.unmount(); });
    container.remove();
  }
});

test("returning to the tail converges for one settle window, which streamed mutations do not extend (#2840)", async () => {
  const apis: FollowTailApi[] = [];
  const container = domWindow.document.createElement("div") as unknown as HTMLDivElement;
  domWindow.document.body.append(container as never);
  const root = createRoot(container);
  try {
    await act(async () => {
      root.render(<Harness sessionId="converge" revision={0} mode="expanded" scope="converge" onApi={(api) => { apis.push(api); }} />);
    });
    const transcript = container.firstElementChild as HTMLElement;
    const counts = instrumentTranscript(transcript, { scrollTop: 300, scrollHeight: 1_000, clientHeight: 200 });
    await act(async () => {
      transcript.dispatchEvent(new domWindow.WheelEvent("wheel", { deltaY: -1, bubbles: true }) as never);
    });
    assert.equal(transcript.dataset.state, "paused");

    counts.scrolls.length = 0;
    await act(async () => {
      apis.at(-1)!.follow();
      // Output keeps streaming in, mutating the transcript every frame for longer than one window.
      for (let frame = 0; frame < 24; frame += 1) {
        transcript.append(domWindow.document.createTextNode("chunk") as never);
        await nextFrame();
      }
    });
    assert.equal(transcript.dataset.state, "following");
    // One pin from follow() itself, then one per frame of its converging window, and no more.
    assert.ok(counts.scrolls.length >= 2, `returning to the tail re-pins while rows measure in (${counts.scrolls.length})`);
    assert.ok(counts.scrolls.length <= 9, `the converging window stays bounded while output streams (${counts.scrolls.length})`);
  } finally {
    await act(async () => { root.unmount(); });
    container.remove();
  }
});
