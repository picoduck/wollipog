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

async function mountFixture(pages: ReturnType<typeof pageController>, turns = 12): Promise<Fixture> {
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
            pinnedOpen={false}
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

function recoveryNotice(fixture: Fixture): HTMLElement | null {
  return fixture.container.querySelector(".transcript-recovery-notice");
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

    const notice = recoveryNotice(fixture);
    assert.ok(notice, "the recovery notice is shown while recovery is active");
    assert.equal(notice.textContent, "Checking for Missed Activity…");
    assert.equal(notice.getAttribute("role"), "status");
    assert.equal(fixture.scroller.getAttribute("aria-busy"), "true");

    // Anchored at the LOWER edge: outside the scroll flow, immediately above the status strip.
    assert.equal(fixture.scroller.contains(notice), false, "the notice must not live inside the scroller");
    const anchor = notice.closest(".transcript-recovery-anchor") as HTMLElement;
    assert.ok(anchor, "the notice hangs from a zero-height anchor");
    assert.equal(anchor.previousElementSibling, fixture.scroller);
    assert.ok(anchor.nextElementSibling?.classList.contains("transcript-status-strip"));

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
    assert.ok(recoveryNotice(fixture));
    await act(async () => {
      // Legacy single-response shape: the completed compatibility path.
      pages.release({ events: [] });
    });
    await flushAsyncWork();
    assert.equal(recoveryNotice(fixture), null, "the notice disappears once recovery completes");
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

    const notice = recoveryNotice(fixture);
    assert.ok(notice, "the recovery notice is visible to a reader away from the tail");
    assert.equal(fixture.scroller.contains(notice), false);
    assert.equal(fixture.scroller.scrollTop, 123, "showing the notice does not move the reader");

    await act(async () => {
      pages.release({ events: [] });
    });
    await flushAsyncWork();
    assert.equal(recoveryNotice(fixture), null);
    assert.equal(fixture.scroller.scrollTop, 123, "removing the notice does not move the reader");
    assert.equal(followChipState(fixture), "paused", "completion must not force the reader back to the tail");
  } finally {
    await unmountFixture(fixture);
  }
});

test("recovery failure falls back to the existing error notice with its retry affordance", async () => {
  const pages = pageController();
  const fixture = await mountFixture(pages);
  try {
    assert.ok(recoveryNotice(fixture));
    await act(async () => {
      // A mismatched event epoch ends recovery before completion: the failure path.
      pages.release({ events: [], eventEpoch: 7, nextAfter: 0, hasMoreCached: false, cacheComplete: false });
    });
    await flushAsyncWork();

    assert.equal(recoveryNotice(fixture), null, "the recovery pill yields to the failure state");
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
