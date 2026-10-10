import assert from "node:assert/strict";
import test from "node:test";
import React, { act } from "react";
import { createRoot } from "react-dom/client";
import { Window } from "happy-dom";
import {
  PROTOCOL_VERSION,
  type ControlPlaneToUi,
  type RunnerView,
  type SessionEvent,
  type SessionEventsResponse,
  type SessionView,
} from "@wollipog/protocol";
import { api, type ApiClient } from "../api.js";
import { ApiProvider } from "../api-context.js";
import type { ViewNavigation } from "../navigation.js";
import { StoreProvider } from "../store.js";
import { UI_SOCKET_OPEN, type UiConnectionRuntime, type UiSocket } from "../ui-transport.js";
import { installDomTestCleanup } from "../dom-test-cleanup.js";
import { SessionDetail } from "./SessionDetail.js";
import { staticPinnedSummary } from "./pinned-summary-state.js";

const domWindow = new Window({ url: "http://localhost/" });
installDomTestCleanup(domWindow);
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
  getComputedStyle: domWindow.getComputedStyle.bind(domWindow),
  React,
  IS_REACT_ACT_ENVIRONMENT: true,
  ResizeObserver: class { observe() {} unobserve() {} disconnect() {} },
  requestAnimationFrame: (callback: FrameRequestCallback) => setTimeout(() => callback(0), 0) as unknown as number,
  cancelAnimationFrame: (id: number) => clearTimeout(id as unknown as NodeJS.Timeout),
})) Object.defineProperty(globalThis, name, { configurable: true, writable: true, value });

const runner = {
  runnerId: "runner-1",
  hostname: "studio",
  displayName: "Studio Workstation",
  os: "linux",
  version: "1",
  status: "online",
  agents: [],
  workspaces: [],
  connectedAt: 1,
  lastSeen: 1,
  protocolVersion: PROTOCOL_VERSION,
} as unknown as RunnerView;

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

async function flushAsyncWork(delay = 0) {
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, delay));
    await Promise.resolve();
  });
}

/** Four numbered turns: a prompt, a reply and the turn's conversation checkpoint each. */
function transcript(sessionId: string): SessionEvent[] {
  const events: SessionEvent[] = [];
  for (let turn = 1; turn <= 4; turn += 1) {
    for (const payload of [
      { kind: "user_message", text: `Question ${turn}`, images: [], turnId: `turn-${turn}` },
      { kind: "agent_message", text: `Answer ${turn}`, final: true },
      { kind: "conversation_checkpoint", turn },
    ] as SessionEvent["payload"][]) {
      const seq = events.length + 1;
      events.push({ id: seq, sessionId, seq, ts: 1_000 + seq, payload });
    }
  }
  return events;
}

/** SessionDetail on a session with jobs in Turns 1, 2 and 4, its Background Work panel open. */
async function mountBackgroundTurns(sessionId: string) {
  const now = Date.now();
  const events = transcript(sessionId);
  const job = (id: string, parentTurnId: string, registeredAt: number) => ({
    id, parentTurnId, launchType: "shell", registeredAt, lastObservedAt: now, sourcePresent: true,
  });
  const session = {
    id: sessionId,
    runnerId: runner.runnerId,
    workspaceId: null,
    workspaceName: null,
    projectId: null,
    agentId: "claude",
    agentName: "Claude Code",
    title: "Background Turns",
    status: "idle",
    column: "review",
    runId: null,
    useWorktree: false,
    worktreePath: null,
    archived: false,
    createdAt: 1,
    updatedAt: 1,
    lastEventAt: null,
    messageCount: events.length,
    eventEpoch: 0,
    preview: null,
    pendingApproval: null,
    driver: "claude-code",
    model: null,
    effort: null,
    permissionMode: null,
    tokensIn: 0,
    tokensOut: 0,
    costUsd: 0,
    adopted: false,
    backgroundWorkTracking: "managed",
    backgroundWorkState: "running",
    backgroundJobsAvailable: true,
    backgroundJobs: [
      job("job-turn1-aaaaa1", "turn-1", now - 40 * 60_000),
      job("job-turn2-aaaaa2", "turn-2", now - 30 * 60_000),
      job("job-turn4-aaaaa4", "turn-4", now - 10 * 60_000),
    ],
    backgroundDeliveries: [],
  } as unknown as SessionView;

  const tailCalls: Array<{ before: number | undefined; eventEpoch: number }> = [];
  const pending: Array<(page: SessionEventsResponse) => void> = [];
  const client = {
    ...api,
    session: () => new Promise<never>(() => {}),
    getSessionEventPage: () => new Promise<never>(() => {}),
    getSessionEventTailPage: (_id: string, before: number | undefined, eventEpoch: number) => {
      tailCalls.push({ before, eventEpoch });
      return new Promise<SessionEventsResponse>((resolve) => { pending.push(resolve); });
    },
    getSessionTurnStartPage: undefined,
  } as unknown as ApiClient;
  const socket = new FakeSocket();
  const connection: UiConnectionRuntime = {
    instanceId: sessionId,
    runtimeKey: `${sessionId}:1`,
    createSocket: () => socket,
    close() {},
  };
  const navigation: ViewNavigation = {
    current: () => ({ name: "session", id: sessionId }),
    push() {},
    listen: () => () => {},
  };
  const rightPanel = {
    open: true,
    mode: "background" as const,
    width: 400,
    dragging: false,
    subagentTarget: null,
    toggle() {},
    openMode() {},
    show() {},
    setMode() {},
    setWidth() {},
    expanded: false,
    setExpanded() {},
    setDragging() {},
    close() {},
    selectSubagent() {},
    showSubagent() {},
    consumeSubagentFocusRequest() {},
  };
  const container = domWindow.document.createElement("div") as unknown as HTMLDivElement;
  domWindow.document.body.append(container as never);
  const root = createRoot(container);
  await act(async () => root.render(
    <ApiProvider client={client}>
      <StoreProvider connection={connection} navigation={navigation}>
        <SessionDetail
          sessionId={sessionId}
          mode="expanded"
          rightPanel={rightPanel}
          onOpenTerminal={() => {}}
          pinnedSummary={staticPinnedSummary(false)}
          composerDraftLoader={async () => null}
        />
      </StoreProvider>
    </ApiProvider>,
  ));
  await act(async () => socket.push({
    type: "snapshot",
    capabilities: {
      sessionSubscriptions: false,
      boundedDelivery: false,
      paginatedSessionHistory: false,
      currentTurnOpening: false,
      projects: true,
    },
    runners: [runner],
    boxes: [],
    projects: [],
    sessions: [session],
    runs: [],
    pods: [],
  } as unknown as ControlPlaneToUi));
  await flushAsyncWork();
  const headings = () => [...container.querySelectorAll(".background-work-turn-head h3")].map((heading) => heading.textContent);
  const viewTurn = (title: string) => [...container.querySelectorAll<HTMLElement>(".background-work-turn-head")]
    .find((head) => head.querySelector("h3")?.textContent === title)?.querySelector<HTMLButtonElement>("button") ?? null;
  /** The older pages requested, as the `before` of each. */
  const olderRequests = () => tailCalls.filter((call) => call.before !== undefined);
  /** The opening window: Turns 2 to 4, with Turn 1 on an older page. */
  const releaseOpening = (eventEpoch: number) => act(async () => pending.shift()!({
    events: events.slice(3), eventEpoch, nextBefore: 4, hasMoreOlder: true, cacheComplete: true,
  } as SessionEventsResponse));
  const releaseOlder = (eventEpoch: number) => act(async () => pending.shift()!({
    events: events.slice(0, 3), eventEpoch, nextBefore: 0, hasMoreOlder: false, cacheComplete: true,
  } as SessionEventsResponse));
  return {
    container, socket, session, tailCalls, pending, headings, viewTurn, olderRequests, releaseOpening, releaseOlder,
    /** A reader whose first window fills it, so nothing older loads on its own; or one it does not
     * fill, so the reader's own earlier-activity fill reads an older page. */
    fillViewport(filled = true) {
      Object.defineProperties(container.querySelector(".detail-scroll")!, {
        clientHeight: { configurable: true, value: filled ? 600 : 2_000 },
        scrollHeight: { configurable: true, value: filled ? 4_000 : 2_000 },
      });
    },
    async dispose() {
      await flushAsyncWork(1);
      await act(async () => root.unmount());
      container.remove();
    },
  };
}

test("Background Work names groups by the transcript's turns, and View Turn loads earlier activity to land on an unloaded turn (#2858)", async () => {
  const view = await mountBackgroundTurns("background-turns");
  try {
    view.fillViewport();
    assert.ok(view.pending.length >= 1, "the opening tail is requested");
    await view.releaseOpening(0);
    await flushAsyncWork(1);

    assert.deepEqual(view.headings(), ["Turn 4", "Turn 2", "Earlier Turn"],
      "groups read the transcript's own turn numbers, newest first, never list positions");
    assert.ok(view.viewTurn("Turn 4") && view.viewTurn("Turn 2"), "each loaded turn has View Turn");

    // Every follow state the reader passes through from here on. (Where the row lands is measured in
    // a browser, background-work-visibility.spec.ts; this DOM has no layout to scroll.)
    const scroller = view.container.querySelector<HTMLElement>(".detail-scroll")!;
    const followStates: string[] = [];
    const observer = new domWindow.MutationObserver(() => {
      followStates.push(scroller.getAttribute("data-follow-tail-state") ?? "");
    });
    observer.observe(scroller as never, { attributes: true, attributeFilter: ["data-follow-tail-state"] });
    assert.deepEqual(view.olderRequests(), [], "nothing older is loaded yet");
    await act(async () => view.viewTurn("Earlier Turn")!.click());
    await flushAsyncWork(1);
    assert.deepEqual(view.olderRequests().map((call) => call.before), [4], "View Turn loads the page that holds the turn");
    assert.deepEqual(followStates, [], "nothing moves until the turn is there");
    await view.releaseOlder(0);
    await flushAsyncWork(1);
    assert.deepEqual(view.headings(), ["Turn 4", "Turn 2", "Turn 1"], "once loaded, the turn has its number");
    assert.equal(followStates[0], "previewing", "and the transcript leaves the tail to show it");
    assert.deepEqual(view.olderRequests().map((call) => call.before), [4], "no page past the turn is requested");
    observer.disconnect();
  } finally {
    await view.dispose();
  }
});

test("View Turn waiting on an older read from a rebuilt history resumes once that read settles (#2858)", async () => {
  const view = await mountBackgroundTurns("background-turns-rebuilt");
  try {
    // The reader's own earlier-activity fill holds the one older read open.
    view.fillViewport(false);
    await view.releaseOpening(0);
    await flushAsyncWork(1);
    assert.deepEqual(view.olderRequests(), [{ before: 4, eventEpoch: 0 }], "the reader's fill is reading an older page");
    const staleRead = view.pending.shift()!;

    // The history is rebuilt, and the new generation's window opens without Turn 1.
    await act(async () => view.socket.push({
      type: "session_upsert", session: { ...view.session, eventEpoch: 1, updatedAt: 2 },
    } as unknown as ControlPlaneToUi));
    await flushAsyncWork(1);
    assert.ok(view.pending.length >= 1, "the new generation's window is requested");
    view.fillViewport();
    await view.releaseOpening(1);
    await flushAsyncWork(1);
    assert.equal(view.headings().at(-1), "Earlier Turn");

    // View Turn waits for the one older read, which belongs to the old history.
    const before = view.olderRequests().length;
    await act(async () => view.viewTurn("Earlier Turn")!.click());
    await flushAsyncWork(1);
    assert.equal(view.olderRequests().length, before, "it waits while the older read is out");
    await act(async () => staleRead({
      events: [], eventEpoch: 0, nextBefore: 0, hasMoreOlder: false, cacheComplete: true,
    } as SessionEventsResponse));
    await flushAsyncWork(1);
    assert.deepEqual(view.olderRequests().slice(before), [{ before: 4, eventEpoch: 1 }],
      "once it settles, View Turn reads the new history's older page itself");
    await view.releaseOlder(1);
    await flushAsyncWork(1);
    assert.equal(view.headings().at(-1), "Turn 1");
  } finally {
    await view.dispose();
  }
});
