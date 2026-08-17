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
function cachedTranscriptPayloads(turns: number): SessionEvent["payload"][] {
  const payloads: SessionEvent["payload"][] = [];
  for (let turn = 0; turn < turns; turn += 1) {
    payloads.push({ kind: "user_message", text: `cached question ${turn + 1}`, images: [] });
    payloads.push({ kind: "agent_message", text: `cached answer ${turn + 1}`, final: true });
  }
  return payloads;
}

function EventSeeder({ sessionId, payloads }: { sessionId: string; payloads: SessionEvent["payload"][] }) {
  const ready = useStoreSelector((state) => state.sessions.has(sessionId));
  const { dispatch } = useStoreActions();
  React.useEffect(() => {
    if (!ready) return;
    payloads.forEach((payload, index) => {
      dispatch({
        type: "msg",
        msg: {
          type: "session_event",
          event: { id: index + 1, sessionId, seq: index + 1, ts: index + 1, payload },
        },
      });
    });
  }, [dispatch, payloads, ready, sessionId]);
  return null;
}

/** Controllable history endpoint: recovery stays "refreshing" until a page is released. */
function pageController() {
  const pending: Array<(value: SessionEventsResponse) => void> = [];
  return {
    fetchPage: () => new Promise<SessionEventsResponse>((resolve) => { pending.push(resolve); }),
    release(value: SessionEventsResponse) {
      const resolve = pending.shift();
      assert.ok(resolve, "a history page fetch is in flight");
      resolve(value);
    },
  };
}

interface Fixture {
  container: HTMLDivElement;
  root: Root;
  scroller: HTMLElement;
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
  await act(async () => {
    root.render(
      <ApiProvider client={client}>
        <StoreProvider connection={connection} navigation={navigation}>
          <EventSeeder sessionId={currentSession.id} payloads={cachedTranscriptPayloads(turns)} />
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
  return { container, root, scroller };
}

async function unmountFixture(fixture: Fixture) {
  // Absorb queued frame callbacks (requestAnimationFrame is timer-backed here) inside act.
  await flushAsyncWork(1);
  await act(async () => fixture.root.unmount());
  fixture.container.remove();
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
      // Legacy single-response shape: the completed compatibility path.
      pages.release({ events: [] });
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
      pages.release({ events: [] });
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
      // A mismatched event epoch ends recovery before completion: the failure path.
      pages.release({ events: [], eventEpoch: 7, nextAfter: 0, hasMoreCached: false, cacheComplete: false });
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
