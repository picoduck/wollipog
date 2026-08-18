import assert from "node:assert/strict";
import test from "node:test";
import React, { act } from "react";
import { createRoot } from "react-dom/client";
import { Window } from "happy-dom";
import {
  FOLLOW_TAIL_LABELS,
  FOLLOW_TAIL_PROGRAMMATIC_SCROLL_SETTLE_MS,
  FOLLOW_TAIL_SCROLL_INTENT_DELAY_MS,
  followTailControlLabel,
  followTailControlTooltip,
  followTailSurfaceLabel,
  isAtFollowTailBottom,
  hasSavedFollowTailAnchor,
  isFollowTailResumeKey,
  nextFollowTailState,
  useFollowTail,
  type FollowTailApi,
} from "./useFollowTail.js";
import { VIRTUAL_VIEWPORT_INTENT_EVENT } from "./viewport-intent.js";

test("follow copy distinguishes live, paused, and previewing states", () => {
  assert.equal(followTailSurfaceLabel("paused", "preview", false), "Paused");
  assert.equal(followTailSurfaceLabel("paused", "expanded", false), "Paused");
  assert.equal(followTailSurfaceLabel("paused", "expanded", true), "Paused");
  assert.equal(followTailSurfaceLabel("previewing", "preview", false), "Previewing");
  assert.equal(followTailSurfaceLabel("following", "preview", false), "Following Live Output");
  assert.equal(followTailControlLabel("following"), "Following Live Output");
  assert.equal(followTailControlLabel("paused"), "Paused, Follow Live Output");
  assert.equal(followTailControlLabel("previewing"), "Previewing, Follow Live Output");
  assert.equal(followTailControlTooltip("following", true, "Shift+G"), "Following Live Output");
  assert.equal(followTailControlTooltip("paused", true, "Shift+G"), "Follow Live Output (Shift+G)");
  assert.equal(followTailControlTooltip("previewing", false, "Shift+G"), "Follow Live Output",
    "surfaces without active reading keys never advertise an inactive shortcut");
  assert.equal(followTailControlTooltip("paused", false, "Shift+G"), "Follow Live Output",
    "mobile expanded surfaces never advertise an inactive reading shortcut");
});

test("resume-key matching excludes Inbox navigation and modified global shortcuts", () => {
  const base = { shiftKey: false, ctrlKey: false, metaKey: false, altKey: false };
  assert.equal(isFollowTailResumeKey({ ...base, key: "k" }), false);
  assert.equal(isFollowTailResumeKey({ ...base, key: "ArrowUp" }), false);
  assert.equal(isFollowTailResumeKey({ ...base, key: "G", shiftKey: true }), true);
  assert.equal(isFollowTailResumeKey({ ...base, key: "End" }), true);
  assert.equal(isFollowTailResumeKey({ ...base, key: "G", shiftKey: true, ctrlKey: true }), false);
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
  onApi?: (api: FollowTailApi) => void;
}

function Harness({ sessionId, revision, mode, scope = "test", onApi }: HarnessProps) {
  const scrollRef = React.useRef<HTMLDivElement>(null);
  const followTail = useFollowTail({ scrollRef, contentRevision: revision, sessionId, persistenceScope: scope });
  const initialAnchor = followTail.getInitialAnchor();
  React.useLayoutEffect(() => onApi?.(followTail));
  return (
    <div
      ref={scrollRef}
      data-mode={mode}
      data-state={followTail.state}
      data-label={followTail.label}
      data-anchor-key={initialAnchor?.key}
      data-anchor-offset={initialAnchor?.offset}
      onScroll={followTail.onScroll}
      onWheel={followTail.onWheel}
      onPointerMove={followTail.onPointerMove}
      onTouchStart={followTail.onTouchStart}
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
  assert.equal(FOLLOW_TAIL_LABELS.paused, "Paused");
  assert.equal(FOLLOW_TAIL_LABELS.previewing, "Previewing");
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
