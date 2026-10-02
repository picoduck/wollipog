import assert from "node:assert/strict";
import test from "node:test";
import React, { act } from "react";
import { createRoot } from "react-dom/client";
import { Window } from "happy-dom";
import type {
  ControlPlaneToUi,
  ProjectView,
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
import { assertNoDomNode } from "../dom-test-assertions.js";
import { installDomTestCleanup } from "../dom-test-cleanup.js";

/** The reading column's load, empty and history-error states (#2172). */

const domWindow = new Window({ url: "http://localhost/" });
installDomTestCleanup(domWindow);
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
  hostname: "build-box.local",
  displayName: "Build Box",
  os: "linux",
  version: "1",
  status: "online",
  agents: [{ id: "claude", name: "Claude Code", command: "claude", args: [], env: {}, driver: "claude-code", available: true }],
  workspaces: [],
  connectedAt: 1,
  lastSeen: 1,
  protocolVersion: 200,
} as RunnerView;

const project = {
  id: "project-wollipog",
  name: "Wollipog",
  hidden: false,
  locations: [],
  activeSessionCount: 1,
  unarchivedSessionCount: 1,
  totalSessionCount: 1,
  createdAt: 1,
  updatedAt: 1,
} as ProjectView;

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

function transcriptEvents(sessionId: string, turns: number): SessionEvent[] {
  const events: SessionEvent[] = [];
  for (let turn = 0; turn < turns; turn += 1) {
    for (const payload of [
      { kind: "user_message", text: `question ${turn + 1}`, images: [] },
      { kind: "agent_message", text: `answer ${turn + 1}`, final: true },
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
    for (const event of events) dispatch({ type: "msg", msg: { type: "session_event", event } });
  }, [dispatch, events, ready, sessionId]);
  return null;
}

async function flushAsyncWork(delay = 0) {
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, delay));
    await Promise.resolve();
  });
}

let sequence = 0;
async function mountSession({
  status = "idle",
  archived = false,
  messageCount = 0,
  cachedEvents = 0,
  mode = "expanded",
  protocolVersion = 200,
}: {
  status?: SessionView["status"];
  archived?: boolean;
  messageCount?: number;
  cachedEvents?: number;
  mode?: "expanded" | "preview";
  protocolVersion?: number;
} = {}) {
  sequence += 1;
  const id = `reading-states-${sequence}`;
  const session = {
    id, runnerId: runner.runnerId, workspaceId: null, workspaceName: "wollipog", projectId: project.id,
    projectName: project.name, agentId: "claude", agentName: "Claude Code", title: "Reading States",
    status, column: "review", runId: null, useWorktree: false, worktreePath: null, archived,
    createdAt: 1, updatedAt: 1, lastEventAt: null, messageCount, eventEpoch: 0, preview: null,
    pendingApproval: null, driver: "claude-code", model: null, effort: null, permissionMode: null,
    tokensIn: 0, tokensOut: 0, costUsd: 0, adopted: false,
  } as SessionView;
  const tail: Array<{ resolve: (value: SessionEventsResponse) => void; reject: (reason: Error) => void }> = [];
  const shown: string[] = [];
  const socket = new FakeSocket();
  const connection: UiConnectionRuntime = {
    instanceId: id, runtimeKey: `${id}:1`, createSocket: () => socket, close() {},
  };
  const navigation: ViewNavigation = { current: () => ({ name: "session", id }), push() {}, listen: () => () => {} };
  const client = {
    ...api,
    session: () => new Promise<never>(() => {}),
    getSessionEventPage: () => new Promise<never>(() => {}),
    getSessionEventTailPage: () => new Promise<SessionEventsResponse>((resolve, reject) => { tail.push({ resolve, reject }); }),
  } as unknown as ApiClient;
  const record = (panel: string) => { shown.push(panel); };
  const rightPanel = {
    open: false, mode: "launcher" as const, width: 360, dragging: false, subagentTarget: null,
    toggle() {}, openMode: record, show: record, setMode() {}, setWidth() {}, setDragging() {}, close() {},
    selectSubagent() {}, showSubagent() {}, consumeSubagentFocusRequest() {},
  };
  const events = transcriptEvents(id, Math.ceil(cachedEvents / 2)).slice(0, cachedEvents);
  const container = domWindow.document.createElement("div") as unknown as HTMLDivElement;
  domWindow.document.body.append(container as never);
  const root = createRoot(container);
  await act(async () => root.render(
    <ApiProvider client={client}>
      <StoreProvider connection={connection} navigation={navigation}>
        <EventSeeder sessionId={id} events={events} />
        <SessionDetail sessionId={id} mode={mode} rightPanel={rightPanel} onOpenTerminal={() => {}}
          composerDraftLoader={async () => null} />
      </StoreProvider>
    </ApiProvider>,
  ));
  await act(async () => {
    socket.push({
      type: "snapshot",
      capabilities: { sessionSubscriptions: false, boundedDelivery: false, paginatedSessionHistory: false, projects: true },
      runners: [{ ...runner, protocolVersion }],
      boxes: [],
      projects: [project],
      sessions: [session],
      runs: [],
      pods: [],
    });
  });
  await flushAsyncWork();
  const scroller = container.querySelector(".detail-scroll") as HTMLElement;
  assert.ok(scroller, "the reader is mounted");
  return {
    id,
    container,
    scroller,
    shown,
    tailRequests: () => tail.length,
    async resolveTail(value: Partial<SessionEventsResponse> & { events: SessionEvent[] }) {
      const pending = tail.shift();
      assert.ok(pending, "a history read is in flight");
      await act(async () => pending.resolve({ eventEpoch: 0, nextBefore: 0, hasMoreOlder: false, cacheComplete: true, ...value }));
      await flushAsyncWork();
    },
    async rejectTail() {
      const pending = tail.shift();
      assert.ok(pending, "a history read is in flight");
      await act(async () => pending.reject(new Error("GET /events/tail failed: 502 Bad Gateway")));
      await flushAsyncWork();
    },
    button(scope: Element, name: string) {
      return [...scope.querySelectorAll<HTMLButtonElement>("button")].find((button) => button.firstChild?.textContent === name);
    },
    async unmount() {
      await flushAsyncWork(1);
      await act(async () => root.unmount());
      container.remove();
    },
  };
}

const emptyHistory = { events: [] };

test("a session awaiting its first prompt says where the agent is ready and opens Files", async () => {
  const view = await mountSession();
  try {
    await view.resolveTail(emptyHistory);
    const state = view.scroller.querySelector(".state.compact") as HTMLElement;
    assert.ok(state, "a compact state in the reading column");
    assert.equal(state.querySelector(".state-title")?.textContent, "Start the Conversation");
    assert.equal(state.querySelector(".state-body")?.textContent, "Claude Code is ready in Wollipog on Build Box.");
    const browse = view.button(state, "Browse Files");
    assert.ok(browse, "Browse Files is the state's action");
    await act(async () => browse.click());
    assert.deepEqual(view.shown, ["files"], "Browse Files opens the Files tab");
    assert.doesNotMatch(view.container.textContent ?? "", /Waiting for the agent|No Activity Yet/u);
  } finally {
    await view.unmount();
  }
});

test("Browse Files appears only where a Files tab can open", async () => {
  const preview = await mountSession({ mode: "preview" });
  try {
    await preview.resolveTail(emptyHistory);
    assert.match(preview.scroller.textContent ?? "", /Start the Conversation/u);
    assert.equal(preview.button(preview.scroller, "Browse Files"), undefined, "the preview has no Files tab");
  } finally {
    await preview.unmount();
  }
  const older = await mountSession({ protocolVersion: 15 });
  try {
    await older.resolveTail(emptyHistory);
    assert.equal(older.button(older.scroller, "Browse Files"), undefined, "the machine cannot browse files");
  } finally {
    await older.unmount();
  }
});

test("a starting session names the agent beside a spinner tile", async () => {
  const view = await mountSession({ status: "starting" });
  try {
    await view.resolveTail(emptyHistory);
    const state = view.scroller.querySelector(".state.compact") as HTMLElement;
    assert.equal(state?.querySelector(".state-title")?.textContent, "Starting Claude Code");
    assert.ok(state.querySelector(".state-icon .spinner"), "the spinner sits in the state's icon tile");
    assert.doesNotMatch(view.container.textContent ?? "", /Waiting for the agent/u);
  } finally {
    await view.unmount();
  }
});

for (const [label, options] of [
  ["stopped", { status: "stopped" }],
  ["failed", { status: "failed" }],
  ["archived", { status: "stopped", archived: true }],
] as const) {
  test(`a ${label} session with no activity says nothing was sent and offers no action`, async () => {
    const view = await mountSession(options);
    try {
      await view.resolveTail(emptyHistory);
      const state = view.scroller.querySelector(".state.compact") as HTMLElement;
      assert.equal(state?.querySelector(".state-title")?.textContent, "No Messages");
      assert.equal(state.querySelector(".state-body")?.textContent, "This session ended before anything was sent.");
      assertNoDomNode(state.querySelector("button"), "the session notice slot carries the way back");
    } finally {
      await view.unmount();
    }
  });
}

test("a history load that fails with nothing loaded is one notice, not a second unavailable state", async () => {
  const view = await mountSession({ messageCount: 240 });
  try {
    await view.rejectTail();
    const notices = view.scroller.querySelectorAll(".notice");
    assert.equal(notices.length, 1, "exactly one notice");
    const notice = notices[0] as HTMLElement;
    assert.ok(notice.classList.contains("t-danger") && notice.classList.contains("compact"));
    assert.equal(notice.querySelector(".notice-title")?.textContent, "Couldn't Load the Full Conversation");
    assert.equal(notice.querySelector(".notice-body")?.textContent, "No activity loaded from Build Box.");
    assertNoDomNode(view.scroller.querySelector(".state"), "no Activity Unavailable state beside it");
    assert.doesNotMatch(view.scroller.textContent ?? "", /Activity Unavailable/u);
  } finally {
    await view.unmount();
  }
});

test("a partial history failure says how much loaded and keeps the raw error behind Show Details", async () => {
  const view = await mountSession({ messageCount: 240, cachedEvents: 9 });
  try {
    assert.ok(view.scroller.querySelector(".timeline"), "the cached rows are on screen");
    await view.rejectTail();
    const notices = view.scroller.querySelectorAll(".notice");
    assert.equal(notices.length, 1, "exactly one notice");
    const notice = notices[0] as HTMLElement;
    assert.equal(notice.querySelector(".notice-title")?.textContent, "Couldn't Load the Full Conversation");
    assert.equal(notice.querySelector(".notice-body")?.textContent, "Loaded 9 of 240 events from Build Box.");
    const retry = view.button(notice, "Retry");
    assert.ok(retry, "Retry is the resolving action");
    assert.equal(retry.disabled, false);

    const rawError = "Could not load complete session activity.";
    assert.equal(notice.textContent!.includes(rawError), false, "the raw error is not in the notice body");
    assert.equal(view.container.textContent!.includes(rawError), false, "nor anywhere else on screen");
    const details = view.button(notice, "Show Details");
    assert.ok(details, "Show Details is in the action row");
    await act(async () => details.click());
    assert.equal(notice.querySelector(".notice-details-body")?.textContent, rawError);
    assertNoDomNode(view.scroller.querySelector(".state"));
  } finally {
    await view.unmount();
  }
});

test("Retry reads the history again", async () => {
  const view = await mountSession({ messageCount: 240, cachedEvents: 9 });
  try {
    await view.rejectTail();
    const retry = view.button(view.scroller.querySelector(".notice")!, "Retry")!;
    await act(async () => retry.click());
    await flushAsyncWork();
    await view.resolveTail({ events: [] });
  } finally {
    await view.unmount();
  }
});

test("a slow load adds its sentence after 3 seconds, with the snapshot's event count", async () => {
  const view = await mountSession({ messageCount: 1240 });
  try {
    assert.ok(view.scroller.querySelector(".transcript-skeleton"));
    assertNoDomNode(view.scroller.querySelector(".transcript-skeleton-sentence"));
    await flushAsyncWork(3050);
    assert.equal(view.scroller.querySelector(".transcript-skeleton-sentence")?.textContent,
      "Loading a long conversation (1,240 events)…");
    assertNoDomNode(view.container.querySelector(".transcript-tail-control"), "no follow control while loading");
  } finally {
    await view.unmount();
  }
});

async function openWindowWithOlderActivity(view: Awaited<ReturnType<typeof mountSession>>) {
  const window = transcriptEvents(view.id, 30).slice(-24);
  await view.resolveTail({ events: window, nextBefore: window[0]!.seq, hasMoreOlder: true, turnAligned: true });
  const row = view.scroller.querySelector(".tl-earlier") as HTMLElement;
  assert.ok(row, "one earlier-activity row");
  return row;
}

test("the earlier-activity row names its action and counts what is above the window", async () => {
  const view = await mountSession({ messageCount: 60 });
  try {
    const row = await openWindowWithOlderActivity(view);
    assert.equal(row.dataset.state, "idle");
    const load = row.querySelector("button") as HTMLButtonElement;
    assert.ok(load.classList.contains("btn") && load.classList.contains("sm") && load.classList.contains("ghost"));
    assert.equal(load.firstChild?.textContent, "Load Earlier Activity");
    assert.equal(load.querySelector(".count")?.textContent, "36", "events 1–36 sit above a window starting at 37");
    assert.match(load.textContent ?? "", /\(36 Earlier Events\)/u, "the count is in the accessible name as words");
  } finally {
    await view.unmount();
  }
});

test("a failed earlier load is a compact danger notice with Retry in the same row", async () => {
  const view = await mountSession({ messageCount: 60 });
  try {
    const row = await openWindowWithOlderActivity(view);
    await act(async () => (row.querySelector("button") as HTMLButtonElement).click());
    const loading = view.scroller.querySelector(".tl-earlier") as HTMLElement;
    assert.equal(loading.dataset.state, "loading");
    assert.equal(loading.textContent, "Loading earlier activity…");
    assert.ok(loading.querySelector(".spinner"), "a spinner beside the sentence");
    await view.rejectTail();

    const failed = view.scroller.querySelector(".tl-earlier") as HTMLElement;
    assert.equal(failed.dataset.state, "error");
    const notice = failed.querySelector(".notice") as HTMLElement;
    assert.ok(notice.classList.contains("compact") && notice.classList.contains("t-danger"));
    assert.equal(notice.querySelector(".notice-body")?.textContent, "Could not load earlier activity.");
    const retry = view.button(notice, "Retry");
    assert.ok(retry, "Retry sits in the row's notice");
    await act(async () => retry.click());
    assert.equal(view.tailRequests(), 1, "Retry asks for the earlier page again");
    assert.equal((view.scroller.querySelector(".tl-earlier") as HTMLElement).dataset.state, "loading");
  } finally {
    await view.unmount();
  }
});
