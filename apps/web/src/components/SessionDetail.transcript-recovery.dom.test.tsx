import assert from "node:assert/strict";
import test from "node:test";
import React, { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { Simulate } from "react-dom/test-utils";
import { Window } from "happy-dom";
import type {
  ControlPlaneToUi,
  RunnerView,
  SessionEvent,
  SessionEventsResponse,
  SessionView,
} from "@wollipog/protocol";
import { api, type ApiClient } from "../api.js";
import { ApiProvider } from "../api-context.js";
import type { ViewNavigation } from "../navigation.js";
import { StoreProvider, useStoreActions, useStoreSelector } from "../store.js";
import { UI_SOCKET_OPEN, type UiConnectionRuntime, type UiSocket } from "../ui-transport.js";
import { VIRTUAL_VIEWPORT_INTENT_EVENT } from "../viewport-intent.js";
import { SessionDetail } from "./SessionDetail.js";

const domWindow = new Window({ url: "http://localhost/" });
Object.defineProperty(domWindow.Element.prototype, "getBoundingClientRect", {
  configurable: true,
  value() {
    return { x: 0, y: 0, top: 0, left: 0, right: 800, bottom: 72, width: 800, height: 72, toJSON: () => ({}) };
  },
});
for (const [name, value] of Object.entries({
  window: domWindow,
  document: domWindow.document,
  navigator: domWindow.navigator,
  localStorage: domWindow.localStorage,
  Element: domWindow.Element,
  HTMLElement: domWindow.HTMLElement,
  HTMLTextAreaElement: domWindow.HTMLTextAreaElement,
  Node: domWindow.Node,
  Event: domWindow.Event,
  MouseEvent: domWindow.MouseEvent,
  KeyboardEvent: domWindow.KeyboardEvent,
  MutationObserver: domWindow.MutationObserver,
  React,
  IS_REACT_ACT_ENVIRONMENT: true,
  ResizeObserver: class { observe() {} unobserve() {} disconnect() {} },
  requestAnimationFrame: (callback: FrameRequestCallback) =>
    setTimeout(() => callback(0), 0) as unknown as number,
  cancelAnimationFrame: (id: number) => clearTimeout(id as unknown as NodeJS.Timeout),
})) Object.defineProperty(globalThis, name, { configurable: true, writable: true, value });

const runner = {
  runnerId: "runner-1",
  hostname: "runner-host",
  os: "linux",
  version: "1",
  status: "online",
  agents: [{
    id: "codex",
    name: "Codex",
    command: "codex",
    args: [],
    env: {},
    driver: "codex-app-server",
    available: true,
  }],
  workspaces: [],
  connectedAt: 1,
  lastSeen: 1,
  protocolVersion: 67,
} as RunnerView;

function session(id: string): SessionView {
  return {
    id,
    runnerId: runner.runnerId,
    workspaceId: null,
    workspaceName: null,
    projectId: null,
    agentId: "codex",
    agentName: "Codex",
    title: "Transcript Recovery Fixture",
    status: "idle",
    column: "review",
    runId: null,
    useWorktree: false,
    worktreePath: null,
    archived: false,
    createdAt: 1,
    updatedAt: 1,
    lastEventAt: null,
    messageCount: 0,
    eventEpoch: 0,
    preview: null,
    pendingApproval: null,
    driver: "codex-app-server",
    model: null,
    effort: null,
    permissionMode: null,
    tokensIn: 0,
    tokensOut: 0,
    costUsd: 0,
    adopted: false,
  };
}

class FakeSocket implements UiSocket {
  readonly readyState = UI_SOCKET_OPEN;
  onopen: (() => void) | null = null;
  onmessage: ((event: { data: string }) => void) | null = null;
  onclose: ((event: { code: number }) => void) | null = null;
  onerror: (() => void) | null = null;
  send() {}
  close() {}
  push(message: ControlPlaneToUi) { this.onmessage?.({ data: JSON.stringify(message) }); }
}

/** A long cached transcript: alternating user/agent turns already present before recovery. */
function cachedTranscriptEvents(sessionId: string, turns: number): SessionEvent[] {
  const events: SessionEvent[] = [];
  for (let turn = 0; turn < turns; turn += 1) {
    for (const payload of [
      { kind: "user_message", text: `cached question ${turn + 1}`, images: [] },
      { kind: "agent_message", text: `cached answer ${turn + 1}`, final: true },
    ] as SessionEvent["payload"][]) {
      const seq = events.length + 1;
      events.push({ id: seq, sessionId, seq, ts: seq, payload });
    }
  }
  return events;
}

function EventSeeder({ sessionId, events }: { sessionId: string; events: SessionEvent[] }) {
  const ready = useStoreSelector((state) => state.sessions.has(sessionId));
  const { dispatch } = useStoreActions();
  React.useEffect(() => {
    if (!ready) return;
    for (const event of events) {
      dispatch({ type: "msg", msg: { type: "session_event", event } });
    }
  }, [dispatch, events, ready, sessionId]);
  return null;
}

/** Controllable history endpoints: recovery stays "refreshing" until a response is released.
 * A fresh mount with no saved reading position takes the tail-first OPENING-WINDOW path
 * (getSessionEventTailPage); the forward page endpoint remains stubbed for the fallback. */
function pageController() {
  const forward: Array<(value: SessionEventsResponse) => void> = [];
  const tail: Array<{
    resolve: (value: SessionEventsResponse) => void;
    reject: (reason: Error) => void;
  }> = [];
  const tailCalls: Array<{ id: string; before: number | undefined; eventEpoch: number }> = [];
  return {
    tailCalls,
    fetchPage: () => new Promise<SessionEventsResponse>((resolve) => { forward.push(resolve); }),
    fetchTailPage: (id: string, before: number | undefined, eventEpoch: number) => {
      tailCalls.push({ id, before, eventEpoch });
      return new Promise<SessionEventsResponse>((resolve, reject) => { tail.push({ resolve, reject }); });
    },
    releaseTail(value: SessionEventsResponse) {
      const pending = tail.shift();
      assert.ok(pending, "a tail fetch is in flight");
      pending.resolve(value);
    },
    rejectTail(reason = new Error("history request failed")) {
      const pending = tail.shift();
      assert.ok(pending, "a tail fetch is in flight");
      pending.reject(reason);
    },
  };
}

interface Fixture {
  container: HTMLDivElement;
  root: Root;
  scroller: HTMLElement;
  events: SessionEvent[];
}

let fixtureSequence = 0;

async function mountFixture(
  pages: ReturnType<typeof pageController>,
  turns = 12,
  { pinnedOpen = false }: { pinnedOpen?: boolean } = {},
): Promise<Fixture> {
  fixtureSequence += 1;
  const currentSession = session(`transcript-recovery-${fixtureSequence}`);
  const socket = new FakeSocket();
  const connection: UiConnectionRuntime = {
    instanceId: `transcript-recovery-${fixtureSequence}`,
    runtimeKey: `transcript-recovery-${fixtureSequence}:1`,
    createSocket: () => socket,
    close() {},
  };
  const navigation: ViewNavigation = {
    current: () => ({ name: "session", id: currentSession.id }),
    push() {},
    listen: () => () => {},
  };
  const client = {
    ...api,
    session: () => new Promise<never>(() => {}),
    getSessionEventPage: pages.fetchPage,
    getSessionEventTailPage: pages.fetchTailPage,
  } as unknown as ApiClient;
  const rightPanel = {
    open: false,
    mode: "launcher" as const,
    width: 360,
    dragging: false,
    subagentTarget: null,
    toggle() {},
    openMode() {},
    show() {},
    setMode() {},
    setWidth() {},
    setDragging() {},
    close() {},
    selectSubagent() {},
    showSubagent() {},
    consumeSubagentFocusRequest() {},
  };
  const container = domWindow.document.createElement("div") as unknown as HTMLDivElement;
  domWindow.document.body.append(container as never);
  const root = createRoot(container);
  const events = cachedTranscriptEvents(currentSession.id, turns);
  await act(async () => {
    root.render(
      <ApiProvider client={client}>
        <StoreProvider connection={connection} navigation={navigation}>
          <EventSeeder sessionId={currentSession.id} events={events} />
          <SessionDetail
            sessionId={currentSession.id}
            rightPanel={rightPanel}
            onOpenTerminal={() => {}}
            pinnedOpen={pinnedOpen}
            composerDraftLoader={async () => null}
          />
        </StoreProvider>
      </ApiProvider>,
    );
  });
  await act(async () => {
    socket.push({
      type: "snapshot",
      capabilities: {
        sessionSubscriptions: false,
        boundedDelivery: false,
        paginatedSessionHistory: false,
        projects: true,
      },
      runners: [runner],
      boxes: [],
      projects: [],
      sessions: [currentSession],
      runs: [],
      pods: [],
    });
  });
  await flushAsyncWork();
  const scroller = container.querySelector(".detail-scroll") as HTMLElement | null;
  assert.ok(scroller, "the transcript reader is mounted");
  return { container, root, scroller, events };
}

async function unmountFixture(fixture: Fixture) {
  // Absorb queued frame callbacks (requestAnimationFrame is timer-backed here) inside act.
  await flushAsyncWork(1);
  await act(async () => fixture.root.unmount());
  fixture.container.remove();
}

function setScrollerMetrics(
  scroller: HTMLElement,
  metrics: { clientHeight: number; scrollHeight: number; scrollTop: number },
) {
  Object.defineProperties(scroller, {
    clientHeight: { configurable: true, value: metrics.clientHeight },
    scrollHeight: { configurable: true, value: metrics.scrollHeight },
    scrollTop: { configurable: true, writable: true, value: metrics.scrollTop },
  });
}

async function scrollReader(scroller: HTMLElement, scrollTop: number, readerIntent = true) {
  await act(async () => {
    if (readerIntent) {
      scroller.dispatchEvent(new domWindow.Event(VIRTUAL_VIEWPORT_INTENT_EVENT) as never);
    }
    scroller.scrollTop = scrollTop;
    scroller.dispatchEvent(new domWindow.Event("scroll", { bubbles: true }) as never);
  });
  await flushAsyncWork();
}

function touchInputEvent(type: "touchstart" | "touchmove" | "touchend", ...clientYs: number[]) {
  const event = new domWindow.Event(type, { bubbles: true });
  Object.defineProperty(event, "touches", {
    value: clientYs.map((clientY) => ({ clientY })),
  });
  return event;
}

function pointerInputEvent(
  type: "pointerdown" | "pointermove" | "pointerup" | "pointercancel",
  clientY: number,
) {
  const event = new domWindow.Event(type, { bubbles: true });
  Object.defineProperties(event, {
    clientY: { value: clientY },
    pointerType: { value: "touch" },
  });
  return event;
}

async function touchTraverseReader(scroller: HTMLElement, scrollTops: number[]) {
  await act(async () => {
    scroller.dispatchEvent(touchInputEvent("touchstart", 100) as never);
    for (const scrollTop of scrollTops) {
      scroller.scrollTop = scrollTop;
      scroller.dispatchEvent(new domWindow.Event("scroll", { bubbles: true }) as never);
    }
    scroller.dispatchEvent(touchInputEvent("touchend") as never);
  });
  await flushAsyncWork();
}

async function flushAsyncWork(delay = 0) {
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, delay));
    await Promise.resolve();
  });
}

/** The slot is PERMANENTLY mounted between the scroller and the status strip; activity toggles
 * only its `active` class and the live-region text, never the mounted markup. */
function recoverySlot(fixture: Fixture): HTMLElement {
  const slot = fixture.container.querySelector(".transcript-recovery-slot") as HTMLElement | null;
  assert.ok(slot, "the recovery slot is permanently mounted");
  return slot;
}

function recoveryActive(fixture: Fixture): boolean {
  return recoverySlot(fixture).classList.contains("active");
}

function recoveryStatusText(fixture: Fixture): string {
  // The live region lives OUTSIDE the slot so the compact mode's `display: none` on the slot
  // can never silence announcements; it is the slot's immediate sibling.
  const status = recoverySlot(fixture).nextElementSibling;
  assert.ok(status?.getAttribute("role") === "status" && status.classList.contains("sr-only"),
    "the permanently-mounted sr-only live region sits beside the slot, not inside it");
  return status.textContent ?? "";
}

function recoveryStripEcho(fixture: Fixture): HTMLElement {
  const echo = fixture.container.querySelector(".transcript-recovery-strip-echo") as HTMLElement | null;
  assert.ok(echo, "the compact strip echo is permanently mounted inside the status strip");
  return echo;
}

/** The pill markup must ALWAYS be present — it is what sizes the slot to the pill's real
 * rendered height at the current pane width and font scale, active or not. */
function assertSizingPillMounted(fixture: Fixture) {
  const pill = recoverySlot(fixture).querySelector(".transcript-recovery-notice");
  assert.ok(pill, "the sizing pill markup is always mounted inside the slot");
  assert.ok(pill.textContent!.includes("Checking for Missed Activity…"),
    "the sizing pill always carries the label that determines its height");
}

function followChipState(fixture: Fixture): string | null {
  const chip = fixture.container.querySelector(".follow-tail-chip");
  assert.ok(chip, "the follow-state control is mounted");
  return chip.getAttribute("data-follow-tail-state");
}

test("recovery over a long cached transcript announces at the reader's lower edge while following live output", async () => {
  const pages = pageController();
  const fixture = await mountFixture(pages);
  try {
    // The cached timeline (not a loading skeleton) is showing, and the reader follows the tail.
    assert.equal(fixture.container.querySelector(".transcript-skeleton"), null);
    assert.equal(followChipState(fixture), "following");

    const slot = recoverySlot(fixture);
    assert.equal(recoveryActive(fixture), true, "the slot is active while recovery is checking");
    assertSizingPillMounted(fixture);
    assert.equal(recoveryStatusText(fixture), "Checking for Missed Activity…",
      "the live status region announces the active recovery");
    assert.equal(fixture.scroller.getAttribute("aria-busy"), "true");

    // In normal flow at the LOWER edge: outside the reader region, immediately above the strip.
    const reader = fixture.container.querySelector(".detail-reader") as HTMLElement;
    assert.ok(reader, "the reader region wraps the scroller");
    assert.ok(reader.contains(fixture.scroller), "the scroller lives inside the reader region");
    assert.equal(reader.contains(slot), false, "the slot must not live inside the reader region");
    assert.equal(slot.previousElementSibling, reader);
    // slot → sr-only live region → status strip.
    assert.ok(slot.nextElementSibling?.nextElementSibling?.classList.contains("transcript-status-strip"));

    // The compact strip echo is mounted (CSS decides when it shows), decorative, and active.
    const echo = recoveryStripEcho(fixture);
    assert.ok(fixture.container.querySelector(".transcript-status-strip")!.contains(echo));
    assert.equal(echo.getAttribute("aria-hidden"), "true");
    assert.equal(echo.classList.contains("active"), true);
    assert.ok(echo.textContent!.includes("Checking for Missed Activity…"));

    // The sticky-top pill no longer renders for active recovery.
    assert.equal(fixture.container.querySelector(".transcript-load-notice"), null);
  } finally {
    await unmountFixture(fixture);
  }
});

test("successful recovery removes the notice promptly without disturbing a follower", async () => {
  const pages = pageController();
  const fixture = await mountFixture(pages);
  try {
    assert.equal(recoveryActive(fixture), true);
    await act(async () => {
      // The completed tail-first opening window: it defines the visible slice and reached the
      // runner tail, so recovery is authoritatively done.
      pages.releaseTail({ events: fixture.events, eventEpoch: 0, nextBefore: 0, hasMoreOlder: false, cacheComplete: true });
    });
    await flushAsyncWork();
    assert.equal(recoveryActive(fixture), false, "the pill deactivates once recovery completes");
    assert.equal(recoveryStatusText(fixture), "", "the live region clears so AT hears the stop");
    // The slot, sizing pill, and strip echo stay mounted: deactivation only toggles their
    // `active` class, so it cannot change layout in either pane mode.
    assertSizingPillMounted(fixture);
    assert.equal(recoveryStripEcho(fixture).classList.contains("active"), false);
    assert.equal(fixture.scroller.getAttribute("aria-busy"), "false");
    assert.equal(followChipState(fixture), "following");
    assert.equal(fixture.container.querySelector(".transcript-load-notice"), null);
  } finally {
    await unmountFixture(fixture);
  }
});

test("a reader away from the tail keeps their place through recovery and its completion", async () => {
  const pages = pageController();
  const fixture = await mountFixture(pages);
  try {
    // The reader scrolls up to re-read earlier activity: wheel-up pauses following.
    await act(async () => {
      Simulate.wheel(fixture.scroller, { deltaY: -40 });
    });
    await flushAsyncWork();
    assert.equal(followChipState(fixture), "paused");
    fixture.scroller.scrollTop = 123;

    assert.equal(recoveryActive(fixture), true, "the recovery pill is visible to a reader away from the tail");
    assert.equal(fixture.scroller.contains(recoverySlot(fixture)), false);
    assert.equal(fixture.scroller.scrollTop, 123, "showing the pill does not move the reader");

    await act(async () => {
      pages.releaseTail({ events: fixture.events, eventEpoch: 0, nextBefore: 0, hasMoreOlder: false, cacheComplete: true });
    });
    await flushAsyncWork();
    assert.equal(recoveryActive(fixture), false);
    assertSizingPillMounted(fixture);
    assert.equal(fixture.scroller.scrollTop, 123, "hiding the pill does not move the reader");
    assert.equal(followChipState(fixture), "paused", "completion must not force the reader back to the tail");
  } finally {
    await unmountFixture(fixture);
  }
});

test("the pinned summary is contained by the reader region, which excludes the slot and strip", async () => {
  const pages = pageController();
  const fixture = await mountFixture(pages, 12, { pinnedOpen: true });
  try {
    assert.equal(recoveryActive(fixture), true);
    const reader = fixture.container.querySelector(".detail-reader") as HTMLElement;
    const summary = fixture.container.querySelector(".pinned-summary") as HTMLElement | null;
    assert.ok(summary, "the pinned summary renders while pinned open");
    // Structural exclusion: the summary's containing block is the reader region, and the reader
    // region contains neither the recovery slot nor the status strip — so the summary's bounds
    // can never intersect the pill regardless of the pill's rendered height.
    assert.ok(reader.contains(summary), "the summary is anchored inside the reader region");
    assert.equal(reader.contains(recoverySlot(fixture)), false);
    assert.equal(reader.contains(fixture.container.querySelector(".transcript-status-strip")!), false);
  } finally {
    await unmountFixture(fixture);
  }
});

test("recovery failure falls back to the existing error notice with its retry affordance", async () => {
  const pages = pageController();
  const fixture = await mountFixture(pages);
  try {
    assert.equal(recoveryActive(fixture), true);
    await act(async () => {
      // A mismatched event epoch ends the opening-window read before completion: the failure path.
      pages.releaseTail({ events: [], eventEpoch: 7, nextBefore: 0, hasMoreOlder: false, cacheComplete: true });
    });
    await flushAsyncWork();

    assert.equal(recoveryActive(fixture), false, "the recovery pill yields to the failure state");
    assert.equal(recoveryStatusText(fixture), "");
    const errorNotice = fixture.container.querySelector(".transcript-load-notice.error");
    assert.ok(errorNotice, "the failure keeps its explanatory notice");
    const retry = errorNotice.querySelector("button");
    assert.ok(retry, "the failure keeps its retry affordance");
    assert.equal(retry.textContent, "Retry");
    assert.equal(fixture.scroller.getAttribute("aria-busy"), "false");
  } finally {
    await unmountFixture(fixture);
  }
});

test("an opening-window safety cut identifies the partial response and reach-back clears it", async () => {
  const pages = pageController();
  const fixture = await mountFixture(pages);
  try {
    const openingWindow = fixture.events.slice(-7);
    await act(async () => {
      pages.releaseTail({
        events: openingWindow,
        eventEpoch: 0,
        nextBefore: openingWindow[0]!.seq,
        hasMoreOlder: true,
        turnAligned: false,
        cacheComplete: true,
      });
    });
    await flushAsyncWork();

    const control = fixture.container.querySelector(".transcript-earlier-activity") as HTMLElement;
    assert.ok(control.textContent!.includes("The beginning of the latest response may not be loaded."));
    const partialDescription = control.querySelector("span") as HTMLSpanElement;
    const load = control.querySelector("button") as HTMLButtonElement;
    assert.equal(load.textContent, "Load Earlier Activity");
    assert.equal(load.getAttribute("aria-describedby"), partialDescription.id,
      "the visible partial-response explanation directly describes the recovery control");
    await act(async () => load.click());
    assert.equal(pages.tailCalls.length, 2, "the partial-response notice keeps a reliable reach-back control");

    const earlierPage = fixture.events.slice(-15, -7);
    assert.ok(earlierPage.some((entry) => entry.payload.kind === "user_message"));
    await act(async () => {
      pages.releaseTail({
        events: earlierPage,
        eventEpoch: 0,
        nextBefore: earlierPage[0]!.seq,
        hasMoreOlder: true,
        cacheComplete: true,
      });
    });
    await flushAsyncWork();
    assert.equal(
      fixture.container.textContent!.includes("The beginning of the latest response may not be loaded."),
      false,
      "loading through the turn boundary removes the partial-response warning",
    );
    assert.equal((fixture.container.querySelector(".transcript-earlier-activity button") as HTMLButtonElement)
      .getAttribute("aria-describedby"), null);
  } finally {
    await unmountFixture(fixture);
  }
});

test("scrolling near the partial window head loads one earlier page and requires further navigation", async () => {
  const pages = pageController();
  const fixture = await mountFixture(pages);
  try {
    const openingWindow = fixture.events.slice(-8);
    await act(async () => {
      pages.releaseTail({
        events: openingWindow,
        eventEpoch: 0,
        nextBefore: openingWindow[0]!.seq,
        hasMoreOlder: true,
        cacheComplete: true,
      });
    });
    await flushAsyncWork();
    assert.equal(pages.tailCalls.length, 1, "opening reads only the bounded tail window");

    setScrollerMetrics(fixture.scroller, { clientHeight: 400, scrollHeight: 1_600, scrollTop: 1_200 });
    await scrollReader(fixture.scroller, 500);
    assert.equal(pages.tailCalls.length, 1, "scrolling away from the head does not page");

    await scrollReader(fixture.scroller, 120, false);
    assert.equal(pages.tailCalls.length, 1, "saved-anchor restoration cannot inherit earlier intent");

    await scrollReader(fixture.scroller, 120);
    assert.equal(pages.tailCalls.length, 2, "the near-head scroll requests an earlier page");
    assert.equal(pages.tailCalls[1]!.before, openingWindow[0]!.seq);
    await scrollReader(fixture.scroller, 0);
    assert.equal(pages.tailCalls.length, 2, "the same window base is deduplicated while in flight");

    const earlierPage = fixture.events.slice(-16, -8);
    await act(async () => {
      pages.releaseTail({
        events: earlierPage,
        eventEpoch: 0,
        nextBefore: earlierPage[0]!.seq,
        hasMoreOlder: true,
        cacheComplete: true,
      });
    });
    setScrollerMetrics(fixture.scroller, { clientHeight: 400, scrollHeight: 3_200, scrollTop: 1_600 });
    await scrollReader(fixture.scroller, 1_560, false);
    assert.equal(pages.tailCalls.length, 2, "a prepend does not cascade into an uncontrolled request loop");

    await flushAsyncWork(10);
    await scrollReader(fixture.scroller, 1_560);
    assert.equal(pages.tailCalls.length, 2, "fresh upward travel far from the new head does not page");

    await scrollReader(fixture.scroller, 120);
    assert.equal(pages.tailCalls.length, 3, "further near-head navigation requests the next page");
    assert.equal(pages.tailCalls[2]!.before, earlierPage[0]!.seq);
  } finally {
    await unmountFixture(fixture);
  }
});

test("the first mobile touch traversal keeps its intent until it reaches the window head", async () => {
  const pages = pageController();
  const fixture = await mountFixture(pages);
  try {
    const openingWindow = fixture.events.slice(-8);
    await act(async () => {
      pages.releaseTail({
        events: openingWindow,
        eventEpoch: 0,
        nextBefore: openingWindow[0]!.seq,
        hasMoreOlder: true,
        cacheComplete: true,
      });
    });
    await flushAsyncWork();
    setScrollerMetrics(fixture.scroller, { clientHeight: 400, scrollHeight: 1_600, scrollTop: 1_200 });

    await touchTraverseReader(fixture.scroller, [500, 120]);

    assert.equal(pages.tailCalls.length, 2, "one touch traversal requests the earlier page on its first trip");
    assert.equal(pages.tailCalls[1]!.before, openingWindow[0]!.seq);
  } finally {
    await unmountFixture(fixture);
  }
});

test("a finished touch traversal cannot leak intent into a later layout scroll", async () => {
  const pages = pageController();
  const fixture = await mountFixture(pages);
  try {
    const openingWindow = fixture.events.slice(-8);
    await act(async () => {
      pages.releaseTail({
        events: openingWindow,
        eventEpoch: 0,
        nextBefore: openingWindow[0]!.seq,
        hasMoreOlder: true,
        cacheComplete: true,
      });
    });
    await flushAsyncWork();
    setScrollerMetrics(fixture.scroller, { clientHeight: 400, scrollHeight: 1_600, scrollTop: 1_200 });

    await touchTraverseReader(fixture.scroller, [500]);
    await flushAsyncWork(250);
    await scrollReader(fixture.scroller, 120, false);

    assert.equal(pages.tailCalls.length, 1, "a later layout scroll cannot inherit finished touch intent");
  } finally {
    await unmountFixture(fixture);
  }
});

test("a touch tap cannot arm later programmatic pagination", async () => {
  const pages = pageController();
  const fixture = await mountFixture(pages);
  try {
    const openingWindow = fixture.events.slice(-8);
    await act(async () => {
      pages.releaseTail({
        events: openingWindow,
        eventEpoch: 0,
        nextBefore: openingWindow[0]!.seq,
        hasMoreOlder: true,
        cacheComplete: true,
      });
    });
    await flushAsyncWork();
    setScrollerMetrics(fixture.scroller, { clientHeight: 400, scrollHeight: 1_600, scrollTop: 500 });

    await act(async () => {
      fixture.scroller.dispatchEvent(touchInputEvent("touchstart", 100) as never);
      fixture.scroller.dispatchEvent(touchInputEvent("touchend") as never);
    });
    await scrollReader(fixture.scroller, 120, false);

    assert.equal(pages.tailCalls.length, 1, "a tap without upward traversal cannot arm pagination");
  } finally {
    await unmountFixture(fixture);
  }
});

test("touch momentum after lift can finish the same upward traversal", async () => {
  const pages = pageController();
  const fixture = await mountFixture(pages);
  try {
    const openingWindow = fixture.events.slice(-8);
    await act(async () => {
      pages.releaseTail({
        events: openingWindow,
        eventEpoch: 0,
        nextBefore: openingWindow[0]!.seq,
        hasMoreOlder: true,
        cacheComplete: true,
      });
    });
    await flushAsyncWork();
    setScrollerMetrics(fixture.scroller, { clientHeight: 400, scrollHeight: 1_600, scrollTop: 1_200 });

    await act(async () => {
      fixture.scroller.dispatchEvent(touchInputEvent("touchstart", 100) as never);
      fixture.scroller.dispatchEvent(touchInputEvent("touchmove", 200) as never);
      fixture.scroller.dispatchEvent(touchInputEvent("touchend") as never);
    });
    await scrollReader(fixture.scroller, 500, false);
    await scrollReader(fixture.scroller, 120, false);

    assert.equal(pages.tailCalls.length, 2, "post-lift momentum completes the proven touch traversal");
  } finally {
    await unmountFixture(fixture);
  }
});

test("Android pointer cancellation does not end the native touch traversal", async () => {
  const pages = pageController();
  const fixture = await mountFixture(pages);
  try {
    const openingWindow = fixture.events.slice(-8);
    await act(async () => {
      pages.releaseTail({
        events: openingWindow,
        eventEpoch: 0,
        nextBefore: openingWindow[0]!.seq,
        hasMoreOlder: true,
        cacheComplete: true,
      });
    });
    await flushAsyncWork();
    setScrollerMetrics(fixture.scroller, { clientHeight: 400, scrollHeight: 1_600, scrollTop: 1_200 });

    await act(async () => {
      fixture.scroller.dispatchEvent(pointerInputEvent("pointerdown", 100) as never);
      fixture.scroller.dispatchEvent(touchInputEvent("touchstart", 100) as never);
      fixture.scroller.dispatchEvent(pointerInputEvent("pointermove", 200) as never);
      fixture.scroller.dispatchEvent(touchInputEvent("touchmove", 200) as never);
      fixture.scroller.dispatchEvent(pointerInputEvent("pointercancel", 200) as never);
    });
    await flushAsyncWork(250);
    await act(async () => {
      fixture.scroller.dispatchEvent(touchInputEvent("touchmove", 300) as never);
    });
    await scrollReader(fixture.scroller, 120, false);
    await act(async () => {
      fixture.scroller.dispatchEvent(touchInputEvent("touchend") as never);
    });

    assert.equal(pages.tailCalls.length, 2, "browser pan takeover keeps the native touch traversal armed");
  } finally {
    await unmountFixture(fixture);
  }
});

test("lifting one finger does not end a multi-touch traversal", async () => {
  const pages = pageController();
  const fixture = await mountFixture(pages);
  try {
    const openingWindow = fixture.events.slice(-8);
    await act(async () => {
      pages.releaseTail({
        events: openingWindow,
        eventEpoch: 0,
        nextBefore: openingWindow[0]!.seq,
        hasMoreOlder: true,
        cacheComplete: true,
      });
    });
    await flushAsyncWork();
    setScrollerMetrics(fixture.scroller, { clientHeight: 400, scrollHeight: 1_600, scrollTop: 1_200 });

    await act(async () => {
      fixture.scroller.dispatchEvent(touchInputEvent("touchstart", 100) as never);
      fixture.scroller.dispatchEvent(touchInputEvent("touchmove", 200) as never);
    });
    await scrollReader(fixture.scroller, 500, false);
    await act(async () => {
      fixture.scroller.dispatchEvent(touchInputEvent("touchstart", 200, 300) as never);
      fixture.scroller.dispatchEvent(touchInputEvent("touchend", 300) as never);
    });
    await flushAsyncWork(250);
    await act(async () => {
      fixture.scroller.dispatchEvent(touchInputEvent("touchmove", 400) as never);
    });
    await scrollReader(fixture.scroller, 120, false);
    await act(async () => {
      fixture.scroller.dispatchEvent(touchInputEvent("touchend") as never);
    });

    assert.equal(pages.tailCalls.length, 2, "remaining touch input keeps the traversal armed");
  } finally {
    await unmountFixture(fixture);
  }
});

test("a two-finger touch start remains active after one pointer lifts", async () => {
  const pages = pageController();
  const fixture = await mountFixture(pages);
  try {
    const openingWindow = fixture.events.slice(-8);
    await act(async () => {
      pages.releaseTail({
        events: openingWindow,
        eventEpoch: 0,
        nextBefore: openingWindow[0]!.seq,
        hasMoreOlder: true,
        cacheComplete: true,
      });
    });
    await flushAsyncWork();
    setScrollerMetrics(fixture.scroller, { clientHeight: 400, scrollHeight: 1_600, scrollTop: 1_200 });

    await act(async () => {
      fixture.scroller.dispatchEvent(pointerInputEvent("pointerdown", 200) as never);
      fixture.scroller.dispatchEvent(pointerInputEvent("pointerdown", 300) as never);
      fixture.scroller.dispatchEvent(touchInputEvent("touchstart", 200, 300) as never);
      fixture.scroller.dispatchEvent(touchInputEvent("touchmove", 400, 500) as never);
    });
    await scrollReader(fixture.scroller, 500, false);
    await act(async () => {
      fixture.scroller.dispatchEvent(pointerInputEvent("pointerup", 400) as never);
      fixture.scroller.dispatchEvent(touchInputEvent("touchend", 500) as never);
    });
    await flushAsyncWork(250);
    await act(async () => {
      fixture.scroller.dispatchEvent(touchInputEvent("touchmove", 600) as never);
    });
    await scrollReader(fixture.scroller, 120, false);
    await act(async () => {
      fixture.scroller.dispatchEvent(touchInputEvent("touchend") as never);
    });

    assert.equal(pages.tailCalls.length, 2, "native ownership survives a partial two-finger lift");
  } finally {
    await unmountFixture(fixture);
  }
});

test("a downward touch traversal near the head does not load earlier activity", async () => {
  const pages = pageController();
  const fixture = await mountFixture(pages);
  try {
    const openingWindow = fixture.events.slice(-8);
    await act(async () => {
      pages.releaseTail({
        events: openingWindow,
        eventEpoch: 0,
        nextBefore: openingWindow[0]!.seq,
        hasMoreOlder: true,
        cacheComplete: true,
      });
    });
    await flushAsyncWork();
    setScrollerMetrics(fixture.scroller, { clientHeight: 400, scrollHeight: 1_600, scrollTop: 120 });

    await act(async () => {
      fixture.scroller.dispatchEvent(touchInputEvent("touchstart", 200) as never);
      fixture.scroller.scrollTop = 160;
      fixture.scroller.dispatchEvent(new domWindow.Event("scroll", { bubbles: true }) as never);
      fixture.scroller.dispatchEvent(touchInputEvent("touchend") as never);
    });
    await flushAsyncWork();

    assert.equal(pages.tailCalls.length, 1, "downward touch movement cannot arm earlier pagination");
  } finally {
    await unmountFixture(fixture);
  }
});

test("reader-initiated paging fills an unscrollable viewport but never starts on open", async () => {
  const pages = pageController();
  const fixture = await mountFixture(pages);
  try {
    const openingWindow = fixture.events.slice(-4);
    await act(async () => {
      pages.releaseTail({
        events: openingWindow,
        eventEpoch: 0,
        nextBefore: openingWindow[0]!.seq,
        hasMoreOlder: true,
        cacheComplete: true,
      });
    });
    await flushAsyncWork();
    setScrollerMetrics(fixture.scroller, { clientHeight: 500, scrollHeight: 800, scrollTop: 300 });
    setScrollerMetrics(fixture.scroller, { clientHeight: 500, scrollHeight: 300, scrollTop: 0 });
    await act(async () => {
      fixture.scroller.dispatchEvent(new domWindow.Event("scroll", { bubbles: true }) as never);
    });
    await flushAsyncWork();
    assert.equal(pages.tailCalls.length, 1, "a layout clamp cannot start paging an underfilled opening");

    setScrollerMetrics(fixture.scroller, { clientHeight: 500, scrollHeight: 800, scrollTop: 300 });
    await scrollReader(fixture.scroller, 0);
    assert.equal(pages.tailCalls.length, 2, "reader navigation starts pagination");
    setScrollerMetrics(fixture.scroller, { clientHeight: 500, scrollHeight: 300, scrollTop: 0 });
    const earlierPage = fixture.events.slice(-8, -4);
    await act(async () => {
      pages.releaseTail({
        events: earlierPage,
        eventEpoch: 0,
        nextBefore: earlierPage[0]!.seq,
        hasMoreOlder: true,
        cacheComplete: true,
      });
    });
    await flushAsyncWork(10);
    assert.equal(pages.tailCalls.length, 3, "paging continues only to make the initiated viewport scrollable");
  } finally {
    await unmountFixture(fixture);
  }
});

test("zero-sized reader geometry never drains remaining history in the background", async () => {
  const pages = pageController();
  const fixture = await mountFixture(pages);
  try {
    const openingWindow = fixture.events.slice(-8);
    await act(async () => {
      pages.releaseTail({
        events: openingWindow,
        eventEpoch: 0,
        nextBefore: openingWindow[0]!.seq,
        hasMoreOlder: true,
        cacheComplete: true,
      });
    });
    await flushAsyncWork();
    setScrollerMetrics(fixture.scroller, { clientHeight: 400, scrollHeight: 1_600, scrollTop: 120 });
    await scrollReader(fixture.scroller, 120);
    setScrollerMetrics(fixture.scroller, { clientHeight: 0, scrollHeight: 0, scrollTop: 0 });

    const earlierPage = fixture.events.slice(-16, -8);
    await act(async () => {
      pages.releaseTail({
        events: earlierPage,
        eventEpoch: 0,
        nextBefore: earlierPage[0]!.seq,
        hasMoreOlder: true,
        cacheComplete: true,
      });
    });
    await flushAsyncWork(10);
    assert.equal(pages.tailCalls.length, 2, "hidden geometry does not continue pagination");
  } finally {
    await unmountFixture(fixture);
  }
});

test("a no-progress page releases the automatic gate for later reader navigation", async () => {
  const pages = pageController();
  const fixture = await mountFixture(pages);
  try {
    const openingWindow = fixture.events.slice(-8);
    await act(async () => {
      pages.releaseTail({
        events: openingWindow,
        eventEpoch: 0,
        nextBefore: openingWindow[0]!.seq,
        hasMoreOlder: true,
        cacheComplete: true,
      });
    });
    await flushAsyncWork();
    setScrollerMetrics(fixture.scroller, { clientHeight: 400, scrollHeight: 1_600, scrollTop: 120 });
    await scrollReader(fixture.scroller, 120);
    await act(async () => {
      pages.releaseTail({
        events: [],
        eventEpoch: 0,
        nextBefore: openingWindow[0]!.seq,
        hasMoreOlder: true,
        cacheComplete: true,
      });
    });
    await flushAsyncWork(10);

    fixture.scroller.dispatchEvent(new domWindow.Event(VIRTUAL_VIEWPORT_INTENT_EVENT) as never);
    await scrollReader(fixture.scroller, 0);
    assert.equal(pages.tailCalls.length, 3, "reader navigation can retry a settled no-progress base");
    assert.equal(pages.tailCalls[2]!.before, openingWindow[0]!.seq);
  } finally {
    await unmountFixture(fixture);
  }
});

test("an automatic load failure keeps an understandable manual retry path", async () => {
  const pages = pageController();
  const fixture = await mountFixture(pages);
  try {
    const openingWindow = fixture.events.slice(-8);
    await act(async () => {
      pages.releaseTail({
        events: openingWindow,
        eventEpoch: 0,
        nextBefore: openingWindow[0]!.seq,
        hasMoreOlder: true,
        cacheComplete: true,
      });
    });
    await flushAsyncWork();
    setScrollerMetrics(fixture.scroller, { clientHeight: 400, scrollHeight: 1_600, scrollTop: 120 });
    await scrollReader(fixture.scroller, 120);
    await act(async () => pages.rejectTail());
    await flushAsyncWork();

    const control = fixture.container.querySelector(".transcript-earlier-activity") as HTMLElement;
    assert.ok(control.textContent!.includes("Could not load earlier activity."));
    const retry = control.querySelector("button") as HTMLButtonElement;
    assert.equal(retry.disabled, false);
    await act(async () => retry.click());
    assert.equal(pages.tailCalls.length, 3, "the fallback control retries the failed page");

    const earlierPage = fixture.events.slice(-16, -8);
    await act(async () => {
      pages.releaseTail({
        events: earlierPage,
        eventEpoch: 0,
        nextBefore: earlierPage[0]!.seq,
        hasMoreOlder: true,
        cacheComplete: true,
      });
    });
    setScrollerMetrics(fixture.scroller, { clientHeight: 400, scrollHeight: 3_200, scrollTop: 1_600 });
    await scrollReader(fixture.scroller, 1_560);
    assert.equal(pages.tailCalls.length, 3, "a manual prepend uses the same settle gate");
  } finally {
    await unmountFixture(fixture);
  }
});
