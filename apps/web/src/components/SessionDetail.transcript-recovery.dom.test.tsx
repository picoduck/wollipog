import { fireDomEvent } from "./test-dom-events.js";
import assert from "node:assert/strict";
import test from "node:test";
import React, { act } from "react";
import { createRoot, type Root } from "react-dom/client";
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
import { StoreProvider, useStoreActions, useStoreSelector, type ConnState } from "../store.js";
import { UI_SOCKET_OPEN, type UiConnectionRuntime, type UiSocket } from "../ui-transport.js";
import { VIRTUAL_VIEWPORT_INTENT_EVENT } from "../viewport-intent.js";
import { SessionDetail } from "./SessionDetail.js";
import { assertNoDomNode } from "../dom-test-assertions.js";
import { installDomTestCleanup } from "../dom-test-cleanup.js";
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
  sent: Array<{ type: string; revision?: number }> = [];
  send(data: string) { this.sent.push(JSON.parse(data)); }
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

test("a very long turn first renders its start and shares the opening across socket acknowledgement", async () => {
  const pages = pageController();
  let calls = 0;
  let release!: (page: SessionEventsResponse) => void;
  const pending = new Promise<SessionEventsResponse>(resolve => { release = resolve; });
  const fixture = await mountFixture(pages, 0, { acknowledgeSubscription: false,
    client: { getSessionTurnStartPage: async () => { calls++; return pending; } } });
  try {
    assert.equal(calls, 1);
    // A tail frame can arrive before HTTP. It must never be the reader's first visible content.
    await act(async () => fixture.socket.push({ type: "session_event", event: {
      id: 10_504, sessionId: fixture.sessionId, seq: 10_504, ts: 1,
      payload: { kind: "agent_message", text: "Unloaded current tail", final: true },
    } }));
    assert.ok(fixture.container.querySelector(".transcript-skeleton"));
    const prefix: SessionEvent[] = Array.from({ length: 200 }, (_, index) => ({
      id: 1_503 + index, seq: 1_503 + index, ts: index, sessionId: fixture.sessionId,
      payload: index === 0 ? { kind: "user_message", text: "Current turn begins here" }
        : { kind: "agent_message", text: `Current-turn step ${index}`, final: true },
    }));
    await act(async () => release({ events: prefix, eventEpoch: 0, turnStartSeq: 1_503,
      tailSeq: 10_503, nextAfter: 1_702, hasMoreLater: true, hasMoreOlder: true,
      turnAligned: true, cacheComplete: true }));
    await flushAsyncWork();
    assert.equal(followState(fixture), "paused", "the first content commit cannot follow to the prefix's tail");
    assert.equal(fixture.scroller.scrollTop, 0);
    assert.deepEqual(fixture.readLoadedEvents()?.[0]?.payload, { kind: "user_message", text: "Current turn begins here" });
    assert.equal(fixture.container.textContent!.includes("Unloaded current tail"), false);
    assert.equal(pages.tailCalls.length, 0);
    assert.equal(pages.forwardCalls(), 0, "unread range stays reader-driven");
    const revision = fixture.socket.sent.filter(message => message.type === "session_subscriptions").at(-1)?.revision;
    assert.ok(revision != null);
    await act(async () => fixture.socket.push({ type: "session_subscriptions_applied", revision,
      sessionIds: [fixture.sessionId], podIds: [] }));
    await flushAsyncWork();
    assert.equal(calls, 1, "the acknowledged owner reuses this exact opening response");
    assert.equal(followState(fixture), "paused");
    assert.equal(fixture.readLoadedEvents()!.length, 200);
  } finally { await unmountFixture(fixture); }
});

for (const count of [300, 1_000]) test(`Jump from a ${count}-event opening retires the gap and retains racing live rows`, async () => {
  const pages = pageController();
  const rows = (id: string, first: number, last: number): SessionEvent[] => Array.from({ length: last - first + 1 }, (_, i) => ({
    id: first + i, seq: first + i, sessionId: id, ts: i,
    payload: first + i === 1 ? { kind: "user_message", text: "Current prompt" }
      : { kind: "agent_message", text: `Step ${first + i}`, final: true },
  }));
  const fixture = await mountFixture(pages, 0, { acknowledgeSubscription: false,
    client: { getSessionTurnStartPage: async id => ({ events: rows(id, 1, 200), eventEpoch: 0,
      turnStartSeq: 1, nextAfter: 200, tailSeq: count, hasMoreLater: true, hasMoreOlder: false, cacheComplete: true }) } });
  try {
    await flushAsyncWork();
    const jump = [...fixture.container.querySelectorAll<HTMLButtonElement>("[data-later-activity-gap] button")]
      .find(button => button.textContent === "Jump to Latest");
    assert.ok(jump);
    await act(async () => jump.click());
    await flushAsyncWork();
    assert.equal(pages.tailCalls.length, 1);
    if (count > 300) for (let seq = count + 1; seq <= count + 3; seq++) {
      await act(async () => fixture.socket.push({ type: "session_event", event: rows(fixture.sessionId, seq, seq)[0]! }));
    }
    await act(async () => pages.releaseTail({ events: rows(fixture.sessionId, count - 199, count),
      eventEpoch: 0, cacheComplete: true, hasMoreOlder: count > 200 }));
    await flushAsyncWork();
    assert.equal(Boolean(fixture.container.querySelector("[data-later-activity-gap]")), false);
    assert.equal(fixture.container.textContent!.includes("Could not load the latest activity"), false);
    assert.equal(fixture.readLoadedEvents()!.at(-1)!.seq, count > 300 ? count + 3 : count);
  } finally { await unmountFixture(fixture); }
});

test("a rejected turn-start response never exposes a racing tail as initial content", async () => {
  const pages = pageController();
  let reject!: (error: Error) => void;
  const fixture = await mountFixture(pages, 0, { acknowledgeSubscription: false,
    client: { getSessionTurnStartPage: () => new Promise((_, fail) => { reject = fail; }) } });
  try {
    await act(async () => fixture.socket.push({ type: "session_event", event: {
      id: 999, seq: 999, sessionId: fixture.sessionId, ts: 1,
      payload: { kind: "agent_message", text: "Must not be first", final: true },
    } }));
    await act(async () => reject(new Error("read failed")));
    await flushAsyncWork();
    assert.equal(fixture.container.textContent!.includes("Must not be first"), false);
    assert.ok(fixture.container.querySelector(".transcript-history-notice"));
  } finally { await unmountFixture(fixture); }
});

test("reconnecting a paused turn-start reader preserves its slice when a new prompt exists", async () => {
  const pages = pageController();
  let calls = 0;
  const fixture = await mountFixture(pages, 0, { acknowledgeSubscription: false,
    client: { getSessionTurnStartPage: async id => {
      calls++;
      const start = calls === 1 ? 10 : 1_001;
      return { events: [{ id: start, seq: start, sessionId: id, ts: 1,
        payload: { kind: "user_message", text: calls === 1 ? "Saved prompt" : "New prompt" } }],
        eventEpoch: 0, turnStartSeq: start, nextAfter: start, tailSeq: start + 1_000,
        hasMoreLater: true, hasMoreOlder: true, cacheComplete: true };
    } } });
  try {
    await flushAsyncWork();
    const saved = fixture.readLoadedEvents()!.map(event => event.seq);
    await act(async () => fixture.socket.push({ type: "snapshot",
      capabilities: { sessionSubscriptions: true, currentTurnOpening: true }, runners: [runner], boxes: [],
      sessions: [fixture.readSession()!], runs: [], pods: [] }));
    await act(async () => fixture.socket.push({ type: "session_upsert",
      session: { ...session(`${fixture.sessionId}-busy`), status: "running" } }));
    await flushAsyncWork();
    const revision = fixture.socket.sent.filter(message => message.type === "session_subscriptions").at(-1)!.revision!;
    await act(async () => fixture.socket.push({ type: "session_subscriptions_applied", revision,
      sessionIds: [fixture.sessionId], podIds: [] }));
    await flushAsyncWork();
    assert.equal(calls, 1, "a new generation must not reopen over a paused reader");
    assert.deepEqual(fixture.readLoadedEvents()!.map(event => event.seq), saved);
    assert.equal(followState(fixture), "paused");
    assert.equal(pages.forwardCalls(), 1, "the reader uses ordinary fenced reconnect recovery");
  } finally { await unmountFixture(fixture); }
});

test("REST metadata before the first snapshot opens at the turn start", async () => {
  const pages = pageController();
  let calls = 0;
  const fixture = await mountFixture(pages, 0, { initialSnapshot: false, client: {
    session: async id => ({ session: session(id) }),
    getSessionTurnStartPage: async id => {
      calls++;
      return { events: [{ id: 10, seq: 10, sessionId: id, ts: 1,
        payload: { kind: "user_message", text: "First visible prompt" } }],
        eventEpoch: 0, turnStartSeq: 10, nextAfter: 10, tailSeq: 10_000,
        hasMoreLater: true, hasMoreOlder: true, cacheComplete: true };
    },
  } });
  try {
    assert.equal(calls, 1);
    assert.equal(pages.tailCalls.length, 0);
    assert.equal(fixture.readLoadedEvents()![0]!.seq, 10);
    assert.equal(followState(fixture), "paused");
  } finally { await unmountFixture(fixture); }
});

test("acknowledgement reuse preserves rows explicitly loaded above the opening", async () => {
  const pages = pageController();
  let calls = 0;
  const fixture = await mountFixture(pages, 0, { acknowledgeSubscription: false, client: {
    getSessionTurnStartPage: async id => {
      calls++;
      return { events: [{ id: 10, seq: 10, sessionId: id, ts: 1,
        payload: { kind: "user_message", text: "Saved prompt" } }],
        eventEpoch: 0, turnStartSeq: 10, nextAfter: 10, tailSeq: 1_000,
        hasMoreLater: true, hasMoreOlder: true, cacheComplete: true };
    },
  } });
  try {
    const earlier = fixture.container.querySelector(".tl-earlier button") as HTMLButtonElement;
    assert.ok(earlier);
    await act(async () => earlier.click());
    await act(async () => pages.releaseTail({ events: Array.from({ length: 9 }, (_, i) => ({
      id: i + 1, seq: i + 1, sessionId: fixture.sessionId, ts: 1,
      payload: { kind: "agent_message", text: `Earlier row ${i + 1}`, final: true },
    })), eventEpoch: 0, nextBefore: 1, hasMoreOlder: false, cacheComplete: true }));
    await flushAsyncWork();
    assert.equal(fixture.readLoadedEvents()![0]!.seq, 1);
    await act(async () => fixture.socket.push({ type: "session_upsert",
      session: { ...session(`${fixture.sessionId}-busy`), status: "running" } }));
    await flushAsyncWork();
    const revision = fixture.socket.sent.filter(message => message.type === "session_subscriptions").at(-1)!.revision!;
    await act(async () => fixture.socket.push({ type: "session_subscriptions_applied", revision,
      sessionIds: [fixture.sessionId], podIds: [] }));
    await flushAsyncWork();
    assert.equal(calls, 1);
    assert.deepEqual(fixture.readLoadedEvents()!.map(event => event.seq), [1,2,3,4,5,6,7,8,9,10]);
    assert.equal(followState(fixture), "paused");
    assert.equal(pages.tailCalls.length, 1, "reuse never jumps to the tail");
  } finally { await unmountFixture(fixture); }
});

test("Jump resumes with the new owner when acknowledgement replaces a pending tail fence", async () => {
  const pages = pageController();
  const fixture = await mountFixture(pages, 0, { acknowledgeSubscription: false, client: {
    getSessionTurnStartPage: async id => ({ events: [{ id: 10, seq: 10, sessionId: id, ts: 1,
      payload: { kind: "user_message", text: "Saved prompt" } }], eventEpoch: 0,
      turnStartSeq: 10, nextAfter: 10, tailSeq: 1_000,
      hasMoreLater: true, hasMoreOlder: true, cacheComplete: true }),
  } });
  try {
    const jump = [...fixture.container.querySelectorAll("[data-later-activity-gap] button")]
      .find(button => button.textContent === "Jump to Latest") as HTMLButtonElement;
    assert.ok(jump);
    await act(async () => jump.click());
    await flushAsyncWork();
    assert.equal(pages.tailCalls.length, 1);
    const revision = fixture.socket.sent.filter(message => message.type === "session_subscriptions").at(-1)!.revision!;
    await act(async () => fixture.socket.push({ type: "session_subscriptions_applied", revision,
      sessionIds: [fixture.sessionId], podIds: [] }));
    await flushAsyncWork();
    const tail: SessionEventsResponse = { events: [{ id: 1_000, seq: 1_000,
      sessionId: fixture.sessionId, ts: 1, payload: { kind: "agent_message", text: "Current tail", final: true } }],
      eventEpoch: 0, cacheComplete: true, hasMoreOlder: true, nextBefore: 1_000 };
    await act(async () => pages.releaseTail(tail));
    await flushAsyncWork();
    assert.equal(pages.tailCalls.length, 2, "releasing the obsolete request resumes the current gap owner");
    await act(async () => pages.releaseTail(tail));
    await flushAsyncWork();
    assert.equal(fixture.readLoadedEvents()!.at(-1)!.seq, 1_000);
    assert.equal(followState(fixture), "following");
    assert.equal(Boolean(fixture.container.querySelector("[data-later-activity-gap]")), false);
  } finally { await unmountFixture(fixture); }
});

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

function SessionObserver({ sessionId, observe }: {
  sessionId: string; observe: (value: SessionView | undefined, setConnection: (conn: ConnState) => void, events: SessionEvent[] | undefined) => void;
}) {
  const value = useStoreSelector((state) => state.sessions.get(sessionId));
  const events = useStoreSelector((state) => state.events.get(sessionId));
  const { dispatch } = useStoreActions();
  React.useEffect(() => observe(value, (conn) => dispatch({ type: "conn", conn }), events), [dispatch, events, observe, value]);
  return null;
}

/** Controllable history endpoints: recovery stays "refreshing" until a response is released.
 * A fresh mount with no saved reading position takes the tail-first OPENING-WINDOW path
 * (getSessionEventTailPage); the forward page endpoint remains stubbed for the fallback. */
function pageController() {
  const forward: Array<(value: SessionEventsResponse) => void> = [];
  let forwardCalls = 0;
  const forwardAfters: number[] = [];
  const tail: Array<{
    resolve: (value: SessionEventsResponse) => void;
    reject: (reason: Error) => void;
  }> = [];
  const tailCalls: Array<{
    id: string;
    before: number | undefined;
    eventEpoch: number;
    alignToTurn: boolean | undefined;
  }> = [];
  return {
    tailCalls,
    forwardCalls: () => forwardCalls,
    forwardAfters,
    releaseForward(value: SessionEventsResponse) {
      const pending = forward.shift();
      assert.ok(pending, "a forward fetch is in flight");
      pending(value);
    },
    fetchPage: (_id: string, after: number) => { forwardCalls++; forwardAfters.push(after); return new Promise<SessionEventsResponse>((resolve) => { forward.push(resolve); }); },
    fetchTailPage: (
      id: string,
      before: number | undefined,
      eventEpoch: number,
      _limit?: number,
      alignToTurn?: boolean,
    ) => {
      tailCalls.push({ id, before, eventEpoch, alignToTurn });
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
  sessionId: string;
  container: HTMLDivElement;
  root: Root;
  scroller: HTMLElement;
  events: SessionEvent[];
  socket: FakeSocket;
  readSession: () => SessionView | undefined;
  readLoadedEvents: () => SessionEvent[] | undefined;
  setConnection: (conn: ConnState) => void;
  reopen: () => Promise<void>;
  readApiClient: () => ApiClient;
  setApiClient: (client: ApiClient) => Promise<void>;
  renderMode: (mode: "preview" | "expanded") => Promise<void>;
}

let fixtureSequence = 0;

async function mountFixture(
  pages: ReturnType<typeof pageController>,
  turns = 12,
  {
    pinnedOpen = false,
    pendingQuestion = false,
    pendingStandalone = false,
    mode = "expanded",
    pendingPrompts,
    steeringAttempts,
    sessionOverrides,
    client: clientOverrides,
    acknowledgeSubscription = true,
    strictMode = false,
    initialSnapshot = true,
  }: {
    pinnedOpen?: boolean;
    pendingQuestion?: boolean;
    pendingStandalone?: boolean;
    mode?: "preview" | "expanded";
    pendingPrompts?: SessionView["pendingPrompts"];
    steeringAttempts?: SessionView["steeringAttempts"];
    sessionOverrides?: Partial<SessionView>;
    client?: Partial<ApiClient>;
    acknowledgeSubscription?: boolean;
    strictMode?: boolean;
    initialSnapshot?: boolean;
  } = {},
): Promise<Fixture> {
  fixtureSequence += 1;
  const currentSession = session(`transcript-recovery-${fixtureSequence}`);
  if (pendingPrompts) currentSession.pendingPrompts = pendingPrompts;
  if (steeringAttempts) currentSession.steeringAttempts = steeringAttempts;
  Object.assign(currentSession, sessionOverrides);
  if (pendingQuestion) {
    currentSession.status = "input_required";
    currentSession.pendingApproval = {
      kind: "question",
      requestId: "pending-question",
      title: "Agent Questions",
      options: [],
      questions: [{
        id: "language",
        question: "Which language should I use?",
        options: [{ label: "TypeScript" }, { label: "JavaScript" }],
      }],
    };
  }
  if (pendingStandalone) {
    currentSession.status = "input_required";
    currentSession.pendingApproval = {
      kind: "permission",
      requestId: "worktree-trust",
      occurrenceId: "worktree-trust",
      title: "Trust Worktree Configuration",
      context: { input: "pnpm install" },
      options: [
        { optionId: "trust", name: "Trust This Configuration", kind: "allow_once" },
        { optionId: "deny", name: "Deny", kind: "reject_once" },
      ],
    };
  }
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
  let client = {
    ...api,
    session: () => new Promise<never>(() => {}),
    getSessionEventPage: pages.fetchPage,
    getSessionEventTailPage: pages.fetchTailPage,
    getSessionTurnStartPage: undefined,
    ...clientOverrides,
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
  const events = cachedTranscriptEvents(currentSession.id, turns);
  if (pendingQuestion && currentSession.pendingApproval?.kind === "question") {
    const seq = events.length + 1;
    events.push({
      id: seq,
      sessionId: currentSession.id,
      seq,
      ts: seq,
      payload: {
        kind: "question_request",
        requestId: currentSession.pendingApproval.requestId,
        questions: currentSession.pendingApproval.questions ?? [],
      },
    });
  }
  let detailMount = 0;
  let observedSession: SessionView | undefined;
  let observedEvents: SessionEvent[] | undefined;
  let connectionSetter: (conn: ConnState) => void = () => {};
  const observeSession = (value: SessionView | undefined, setConnection: (conn: ConnState) => void, events: SessionEvent[] | undefined) => {
    observedSession = value;
    observedEvents = events;
    connectionSetter = setConnection;
  };
  const renderMode = async (nextMode: "preview" | "expanded") => {
    const content = <ApiProvider client={client}>
        <StoreProvider connection={connection} navigation={navigation}>
          <EventSeeder sessionId={currentSession.id} events={events} />
          <SessionObserver sessionId={currentSession.id} observe={observeSession} />
          <SessionDetail
            key={detailMount}
            sessionId={currentSession.id}
            mode={nextMode}
            rightPanel={rightPanel}
            onOpenTerminal={() => {}}
            pinnedSummary={staticPinnedSummary(pinnedOpen)}
            composerDraftLoader={async () => null}
          />
        </StoreProvider>
      </ApiProvider>;
    await act(async () => root.render(strictMode ? <React.StrictMode>{content}</React.StrictMode> : content));
  };
  await renderMode(mode);
  if (initialSnapshot) await act(async () => {
    socket.push({
      type: "snapshot",
      capabilities: {
        sessionSubscriptions: !acknowledgeSubscription,
        boundedDelivery: false,
        paginatedSessionHistory: false,
        currentTurnOpening: clientOverrides?.getSessionTurnStartPage !== undefined,
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
  if (!initialSnapshot) await act(async () => connectionSetter("online"));
  await flushAsyncWork();
  const scroller = container.querySelector(".detail-scroll") as HTMLElement | null;
  assert.ok(scroller, "the transcript reader is mounted");
  return { sessionId: currentSession.id, container, root, scroller, events, socket, renderMode, readSession: () => observedSession, readLoadedEvents: () => observedEvents, setConnection: (conn) => connectionSetter(conn), reopen: async () => { detailMount++; await renderMode(mode); }, readApiClient: () => client, setApiClient: async (nextClient) => { client = nextClient; await renderMode(mode); } };
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

/** Fingers `0..n-1` are down at `clientYs`. A start or move changes all of them; an end lifts finger
 * `n`, the last one down before it. */
function touchInputEvent(type: "touchstart" | "touchmove" | "touchend", ...clientYs: number[]) {
  const touches = clientYs.map((clientY, identifier) => ({ identifier, clientY }));
  return fingerEvent(type, type === "touchend" ? [{ identifier: touches.length, clientY: 0 }] : touches, touches);
}

/** A touch event for the fingers `changed`, with `touches` every finger still on the page after it. */
function fingerEvent(
  type: "touchstart" | "touchmove" | "touchend",
  changed: ReadonlyArray<{ identifier: number; clientY: number }>,
  touches: ReadonlyArray<{ identifier: number; clientY: number }>,
) {
  const event = new domWindow.Event(type, { bubbles: true });
  Object.defineProperties(event, {
    changedTouches: { value: changed },
    touches: { value: touches },
  });
  return event;
}

function pointerInputEvent(
  type: "pointerdown" | "pointermove" | "pointerup" | "pointercancel",
  clientY: number,
  pointerId = 1,
) {
  const event = new domWindow.Event(type, { bubbles: true });
  Object.defineProperties(event, {
    clientY: { value: clientY },
    pointerId: { value: pointerId },
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

/** The zero-height anchor is PERMANENTLY mounted between the reader and the status strip; only its
 * one floating child comes and goes. */
function tailAnchor(fixture: Fixture): HTMLElement {
  const anchor = fixture.container.querySelector(".transcript-tail-anchor") as HTMLElement | null;
  assert.ok(anchor, "the tail anchor is permanently mounted");
  return anchor;
}

/** The floating control, or null when the reader has nothing to say at its lower edge. */
function tailControl(fixture: Fixture): HTMLElement | null {
  return tailAnchor(fixture).querySelector(".transcript-tail-control");
}

function recoveryActive(fixture: Fixture): boolean {
  return tailControl(fixture)?.classList.contains("is-recovering") === true;
}

function recoveryStatusText(fixture: Fixture): string {
  const status = fixture.container.querySelector("[data-transcript-recovery-status]");
  assert.ok(status?.getAttribute("role") === "status" && status.classList.contains("sr-only"),
    "one permanently-mounted sr-only live region announces recovery");
  return status.textContent ?? "";
}

function followState(fixture: Fixture): string | null {
  return fixture.scroller.getAttribute("data-follow-tail-state");
}

async function pushEvent(fixture: Fixture, text: string) {
  const seq = fixture.events.length + 1;
  const event: SessionEvent = {
    id: seq,
    sessionId: fixture.events[0]!.sessionId,
    seq,
    ts: seq,
    payload: { kind: "agent_message", text, final: true } as SessionEvent["payload"],
  };
  fixture.events.push(event);
  await act(async () => fixture.socket.push({ type: "session_event", event }));
  await flushAsyncWork();
}

async function settleRecovery(pages: ReturnType<typeof pageController>, fixture: Fixture) {
  await act(async () => {
    pages.releaseTail({ events: fixture.events, eventEpoch: 0, nextBefore: 0, hasMoreOlder: false, cacheComplete: true });
  });
  await flushAsyncWork();
}

test("SessionDetail keeps a pending question on its dock through transcript recovery (#2205)", async () => {
  const pages = pageController();
  const fixture = await mountFixture(pages, 40, { pendingQuestion: true });
  try {
    const docked = () => fixture.container.querySelector('.request-dock [aria-label="Agent Questions"]');
    assert.ok(docked(), "the question is on the dock while transcript recovery is pending");
    assert.equal(fixture.container.querySelectorAll('[aria-label="Agent Questions"]').length, 1);

    await act(async () => {
      pages.releaseTail({ events: fixture.events, eventEpoch: 0, nextBefore: 0, hasMoreOlder: false, cacheComplete: true });
    });
    await flushAsyncWork();

    assert.ok(docked(), "the dock keeps it once the transcript has loaded");
    assert.equal(fixture.container.querySelectorAll('[aria-label="Agent Questions"]').length, 1);
    assert.equal(fixture.container.querySelectorAll('input[type="radio"]').length, 3, "two options and Something Else");
    assertNoDomNode(fixture.scroller.querySelector('[aria-label="Agent Questions"]'), "never a transcript row");
  } finally {
    await unmountFixture(fixture);
  }
});

test("a cold conversation reads REST history and refreshes Starting before subscription acknowledgement", async () => {
  const pages = pageController();
  let metadataCalls = 0;
  const fixture = await mountFixture(pages, 0, {
    acknowledgeSubscription: false,
    sessionOverrides: { status: "starting" },
    client: { session: async (id) => { metadataCalls++; return { session: session(id) }; } },
  });
  try {
    assert.equal(pages.tailCalls.length, 1, "opening history must not wait for a socket acknowledgement");
    assert.equal(metadataCalls, 1, "the row is refreshed through the same authorized REST client");
    assert.equal(fixture.readSession()?.status, "idle", "Starting settles without the lost live upsert");
    assert.ok(fixture.container.querySelector(".transcript-skeleton"));
    await act(async () => pages.releaseTail({
      events: [], eventEpoch: 0, nextBefore: 0, hasMoreOlder: false, cacheComplete: true,
    }));
    await flushAsyncWork();
    assertNoDomNode(fixture.container.querySelector(".transcript-skeleton"));
    assert.match(fixture.scroller.textContent ?? "", /Start the Conversation/u);
    assert.equal(pages.forwardCalls(), 0, "the provisional read stays bounded");
    await fixture.renderMode("expanded");
    assert.equal(pages.tailCalls.length, 1, "unrelated renders do not retry the provisional read");
    const revision = fixture.socket.sent.filter((message) => message.type === "session_subscriptions").at(-1)?.revision;
    assert.ok(revision != null);
    await act(async () => fixture.socket.push({
      type: "session_subscriptions_applied", revision, sessionIds: [fixture.sessionId], podIds: [],
    }));
    await flushAsyncWork();
    assert.equal(pages.tailCalls.length, 2, "acknowledged recovery rechecks the bounded tail");
    assert.equal(pages.forwardCalls(), 0, "provisional completeness cannot divert recovery into a full forward walk");
  } finally { await unmountFixture(fixture); }
});

test("a missing acknowledgement cannot strand Starting after the initial REST read precedes readiness", async () => {
  const pages = pageController();
  let metadataCalls = 0;
  const fixture = await mountFixture(pages, 0, {
    acknowledgeSubscription: false,
    sessionOverrides: { status: "starting" },
    client: { session: async (id) => ({
      session: { ...session(id), status: ++metadataCalls === 1 ? "starting" : "idle" },
    }) },
  });
  try {
    assert.equal(fixture.readSession()?.status, "starting");
    await act(async () => pages.releaseTail({
      events: [], eventEpoch: 0, nextBefore: 0, hasMoreOlder: false, cacheComplete: true,
    }));
    await flushAsyncWork(2_050);
    assert.equal(fixture.readSession()?.status, "idle", "provider readiness reaches the row through bounded REST refresh");
    assert.equal(metadataCalls, 2);
    assert.equal(pages.tailCalls.length, 1, "readiness polling does not reread the transcript");
  } finally { await unmountFixture(fixture); }
});

test("acknowledgement cancels the pending Starting metadata refresh", async () => {
  const pages = pageController();
  let metadataCalls = 0;
  const fixture = await mountFixture(pages, 0, {
    acknowledgeSubscription: false,
    sessionOverrides: { status: "starting" },
    client: { session: async (id) => { metadataCalls++; return { session: { ...session(id), status: "starting" } }; } },
  });
  try {
    assert.equal(metadataCalls, 1);
    const revision = fixture.socket.sent.filter((message) => message.type === "session_subscriptions").at(-1)?.revision;
    assert.ok(revision != null);
    await act(async () => fixture.socket.push({
      type: "session_subscriptions_applied", revision, sessionIds: [fixture.sessionId], podIds: [],
    }));
    await flushAsyncWork(2_050);
    assert.equal(metadataCalls, 1, "live admission owns status once acknowledged");
  } finally { await unmountFixture(fixture); }
});

test("a reopened complete window reads the latest REST tail while acknowledgement is missing", async () => {
  const pages = pageController();
  const fixture = await mountFixture(pages, 12, { acknowledgeSubscription: false });
  try {
    const tail = fixture.events.slice(-8);
    await act(async () => pages.releaseTail({
      events: tail, eventEpoch: 0, nextBefore: tail[0]!.seq, hasMoreOlder: true, cacheComplete: true,
    }));
    await flushAsyncWork();
    assertNoDomNode(fixture.container.querySelector(".transcript-skeleton"));
    await fixture.reopen();
    assert.equal(pages.tailCalls.length, 2, "a warm following reader rechecks the tail before the stream is acknowledged");
    assert.equal(pages.forwardCalls(), 0);
    await act(async () => pages.releaseTail({
      events: [...tail, { ...tail.at(-1)!, id: 25, seq: 25,
        payload: { kind: "agent_message", text: "latest REST-only answer", final: true } }],
      eventEpoch: 0, nextBefore: tail[0]!.seq, hasMoreOlder: true, cacheComplete: true,
    }));
    await flushAsyncWork();
    assertNoDomNode(fixture.container.querySelector(".transcript-skeleton"));
    assert.deepEqual(fixture.readLoadedEvents()?.at(-1)?.payload, { kind: "agent_message", text: "latest REST-only answer", final: true });
  } finally { await unmountFixture(fixture); }
});

test("a completed provisional tail cannot suppress Starting refresh across connection phases", async () => {
  const pages = pageController();
  let metadataCalls = 0;
  const fixture = await mountFixture(pages, 0, {
    acknowledgeSubscription: false,
    sessionOverrides: { status: "starting" },
    client: { session: async (id) => ({
      session: { ...session(id), status: ++metadataCalls < 3 ? "starting" : "idle" },
    }) },
  });
  try {
    await act(async () => fixture.setConnection("connecting"));
    assert.equal(pages.tailCalls.length, 2);
    await act(async () => {
      for (let index = 0; index < 2; index++) pages.releaseTail({
        events: [], eventEpoch: 0, nextBefore: 0, hasMoreOlder: false, cacheComplete: true,
      });
    });
    await flushAsyncWork();
    assertNoDomNode(fixture.container.querySelector(".transcript-skeleton"));
    assert.equal(fixture.readSession()?.status, "starting");
    await act(async () => fixture.setConnection("online"));
    await flushAsyncWork(2_050);
    assert.equal(fixture.readSession()?.status, "idle", "completed history must not prevent metadata readiness refresh");
    assert.equal(pages.tailCalls.length, 3, "the new connection phase rechecks one bounded tail");
  } finally { await unmountFixture(fixture); }
});

test("live readiness stops a scheduled Starting metadata retry before it sends another request", async () => {
  const pages = pageController();
  let metadataCalls = 0;
  const fixture = await mountFixture(pages, 0, {
    acknowledgeSubscription: false,
    sessionOverrides: { status: "starting" },
    client: { session: async (id) => { metadataCalls++; return { session: { ...session(id), status: "starting" } }; } },
  });
  try {
    assert.equal(metadataCalls, 1);
    await act(async () => fixture.socket.push({
      type: "session_upsert", session: { ...session(fixture.sessionId), updatedAt: 2 },
    }));
    await flushAsyncWork(2_050);
    assert.equal(metadataCalls, 1, "the scheduled retry checks the latest live row before sending");
    assert.equal(fixture.readSession()?.status, "idle");
  } finally { await unmountFixture(fixture); }
});

test("a provisional history read cannot replace an acknowledged recovery", async () => {
  const pages = pageController();
  const fixture = await mountFixture(pages, 0, { acknowledgeSubscription: false });
  try {
    assert.equal(pages.tailCalls.length, 1);
    const revision = fixture.socket.sent.filter((message) => message.type === "session_subscriptions").at(-1)?.revision;
    assert.ok(revision != null);
    await act(async () => fixture.socket.push({
      type: "session_subscriptions_applied", revision, sessionIds: [fixture.sessionId], podIds: [],
    }));
    await flushAsyncWork();
    assert.equal(pages.tailCalls.length, 2, "acknowledged recovery owns a new read");
    await act(async () => pages.releaseTail({
      events: [], eventEpoch: 0, nextBefore: 0, hasMoreOlder: false, cacheComplete: true,
    }));
    await flushAsyncWork();
    assert.ok(fixture.container.querySelector(".transcript-skeleton"), "the late provisional response is ignored");
    await act(async () => pages.releaseTail({
      events: [], eventEpoch: 0, nextBefore: 0, hasMoreOlder: false, cacheComplete: true,
    }));
    await flushAsyncWork();
    assertNoDomNode(fixture.container.querySelector(".transcript-skeleton"));
  } finally { await unmountFixture(fixture); }
});

test("StrictMode cannot consume the provisional history load during its setup rehearsal", async () => {
  const pages = pageController();
  const fixture = await mountFixture(pages, 0, { acknowledgeSubscription: false, strictMode: true });
  try {
    assert.ok(pages.tailCalls.length > 0);
    await act(async () => {
      for (let index = 0; index < pages.tailCalls.length; index++) pages.releaseTail({
        events: [], eventEpoch: 0, nextBefore: 0, hasMoreOlder: false, cacheComplete: true,
      });
    });
    await flushAsyncWork();
    assertNoDomNode(fixture.container.querySelector(".transcript-skeleton"), "the active setup owns a response even after cleanup rehearsal");
  } finally { await unmountFixture(fixture); }
});

test("an older REST metadata response cannot overwrite a newer live session row", async () => {
  const pages = pageController();
  let resolveMetadata!: (value: { session: SessionView }) => void;
  const fixture = await mountFixture(pages, 0, {
    acknowledgeSubscription: false,
    sessionOverrides: { status: "starting" },
    client: { session: () => new Promise((resolve) => { resolveMetadata = resolve; }) },
  });
  try {
    await act(async () => {
      fixture.socket.push({
        type: "session_upsert", session: { ...session(fixture.sessionId), status: "running", updatedAt: 1 },
      });
      resolveMetadata({ session: session(fixture.sessionId) });
    });
    await flushAsyncWork();
    assert.equal(fixture.readSession()?.status, "running");
  } finally { await unmountFixture(fixture); }
});

test("a server without backward history support waits for acknowledgement without a forward walk", async () => {
  const pages = pageController();
  const fixture = await mountFixture(pages, 0, { acknowledgeSubscription: false });
  try {
    assert.equal(pages.tailCalls.length, 1);
    await act(async () => pages.releaseTail({ events: [] }));
    await flushAsyncWork();
    assert.equal(pages.forwardCalls(), 0);
    assertNoDomNode(fixture.container.querySelector(".transcript-skeleton"), "an unsupported provisional read becomes retryable");
  } finally { await unmountFixture(fixture); }
});

test("SessionDetail keeps a standalone request reachable through skeleton and empty transcript states", async () => {
  const pages = pageController();
  const fixture = await mountFixture(pages, 0, { pendingStandalone: true });
  try {
    const allow = () => [...fixture.container.querySelectorAll<HTMLButtonElement>(".request-dock .request-card-foot button")]
      .find((button) => button.textContent?.startsWith("Trust This Configuration"));
    assert.ok(allow(), "the request's decision is on the dock while history is loading");
    assert.ok(fixture.container.querySelector(".transcript-skeleton"));

    await act(async () => {
      pages.releaseTail({ events: [], eventEpoch: 0, nextBefore: 0, hasMoreOlder: false, cacheComplete: true });
    });
    await flushAsyncWork();

    assert.ok(allow(), "the request stays on the dock beside an authoritative empty state");
    assert.match(fixture.scroller.textContent ?? "", /Start the Conversation/u);
  } finally {
    await unmountFixture(fixture);
  }
});

test("SessionDetail docks a standalone request between loaded activity and the composer (#2179)", async () => {
  const pages = pageController();
  const fixture = await mountFixture(pages, 12, { pendingStandalone: true });
  try {
    const reading = fixture.container.querySelector(".chat-reading")!;
    const dock = fixture.container.querySelector(".request-dock")!;
    const composer = fixture.container.querySelector(".composer")!;
    assert.ok(reading && dock && composer);
    assert.equal(fixture.scroller.contains(dock), false, "the request is not a transcript row");
    assert.equal(reading.lastElementChild?.contains(dock), true, "the dock ends the reading column");
    assert.equal(reading.nextElementSibling, composer, "the composer is directly below it");
    assert.equal(dock.closest(".session-notice-slot")?.getAttribute("data-notice-key"), "request-dock",
      "the dock takes the notice slot");
    assertNoDomNode(composer.querySelector(".session-notice-slot"), "the slot is not also above the composer");
    assertNoDomNode(fixture.container.querySelector(".tl-request-card"));
    assert.doesNotMatch(fixture.container.textContent ?? "", /Review Request|awaiting decision/u);
  } finally {
    await unmountFixture(fixture);
  }
});

test("SessionDetail returns focus to the composer when the last docked request resolves behind a worker's (#2179)", async () => {
  const options = [
    { optionId: "allow", name: "Allow", kind: "allow_once" as const },
    { optionId: "deny", name: "Reject", kind: "reject_once" as const },
  ];
  // The worker's request is the session's primary one; the coordinator tracks it, not the dock's.
  const worker = { requestId: "worker-ask", kind: "permission" as const, title: "Worker Ask", options, ownerToolUseId: "tool-1" };
  const own = { requestId: "own-ask", kind: "permission" as const, title: "Run pnpm deploy?", options };
  const pages = pageController();
  const fixture = await mountFixture(pages, 12, {
    sessionOverrides: { status: "input_required", pendingApproval: { ...worker, additionalRequests: [own] } },
  });
  try {
    const allow = [...fixture.container.querySelectorAll<HTMLButtonElement>(".request-dock .request-card-foot button")]
      .find((button) => button.textContent?.startsWith("Allow"))!;
    assert.ok(allow, "the session's own request is on the dock");
    await act(async () => { allow.focus(); });
    await act(async () => fixture.socket.push({
      type: "session_upsert",
      session: { ...session(fixture.sessionId), status: "input_required", pendingApproval: worker },
    }));
    await flushAsyncWork();
    assertNoDomNode(fixture.container.querySelector(".request-dock"));
    const active = domWindow.document.activeElement as unknown as Element | null;
    assert.ok(active === fixture.container.querySelector(".composer-input") || active === fixture.scroller,
      `focus returns to the composer or the reader, not ${active?.tagName}`);
  } finally {
    await unmountFixture(fixture);
  }
});

test("recovery over a long cached transcript shows at the reader's lower edge while following", async () => {
  const pages = pageController();
  const fixture = await mountFixture(pages);
  try {
    // The cached timeline (not a loading skeleton) is showing, and the reader follows the tail.
    assertNoDomNode(fixture.container.querySelector(".transcript-skeleton"));
    assert.equal(followState(fixture), "following");

    const control = tailControl(fixture);
    assert.ok(control, "recovery speaks even at the tail");
    assert.equal(recoveryActive(fixture), true);
    assert.equal(control.textContent, "Checking for missed activity…");
    assert.equal(control.tagName, "DIV", "recovery is a status, not a control");
    assert.equal(control.getAttribute("role"), "status");
    assert.equal(control.getAttribute("aria-live"), "off", "the reader's one live region does the announcing");
    assert.equal(control.hasAttribute("tabindex"), false, "the recovery status is not focusable");
    assert.equal(recoveryStatusText(fixture), "Checking for missed activity…",
      "the live status region announces the active recovery");
    assert.equal(fixture.scroller.getAttribute("aria-busy"), "true");

    // At the LOWER edge, outside the reader region, on a zero-height anchor above the composer.
    const reader = fixture.container.querySelector(".detail-reader") as HTMLElement;
    const anchor = tailAnchor(fixture);
    assert.ok(reader.contains(fixture.scroller), "the scroller lives inside the reader region");
    assert.equal(reader.contains(anchor), false, "the anchor must not live inside the reader region");
    assert.equal(anchor.previousElementSibling, reader);
    // anchor → sr-only live region, and nothing else: no status strip sits between the reader and
    // the composer (#2166).
    assertNoDomNode(anchor.nextElementSibling?.nextElementSibling ?? null);
    assertNoDomNode(fixture.container.querySelector("[class^='transcript-status'], [class*=' transcript-status']"));

    // Neither the old band nor the chip render, and the top-of-reader notice stays away.
    assertNoDomNode(fixture.container.querySelector(".transcript-recovery-slot"));
    assertNoDomNode(fixture.container.querySelector(".follow-tail-chip"));
    assertNoDomNode(fixture.container.querySelector(".transcript-history-notice"));
  } finally {
    await unmountFixture(fixture);
  }
});

test("successful recovery leaves an idle tail with nothing below the last row and announces completion", async () => {
  const pages = pageController();
  const fixture = await mountFixture(pages);
  try {
    assert.equal(recoveryActive(fixture), true);
    // The completed tail-first opening window: it defines the visible slice and reached the
    // runner tail, so recovery is authoritatively done.
    await settleRecovery(pages, fixture);
    assertNoDomNode(tailControl(fixture), "an idle tail shows no control");
    assert.equal(tailAnchor(fixture).childElementCount, 0);
    assert.equal(recoveryStatusText(fixture), "Caught up on missed activity.",
      "the live region announces the check's completion");
    assert.equal(fixture.scroller.getAttribute("aria-busy"), "false");
    assert.equal(followState(fixture), "following");
    assertNoDomNode(fixture.container.querySelector(".transcript-history-notice"));
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
      fireDomEvent.wheel(fixture.scroller, { deltaY: -40 });
    });
    await flushAsyncWork();
    assert.equal(followState(fixture), "paused");
    // A transcript with somewhere to scroll; one without has nothing to jump to (#2526).
    setScrollerMetrics(fixture.scroller, { clientHeight: 500, scrollHeight: 900, scrollTop: 0 });
    await scrollReader(fixture.scroller, 123, false);

    assert.equal(recoveryActive(fixture), true, "recovery outranks Jump to Latest");
    assert.equal(fixture.scroller.scrollTop, 123, "showing the control does not move the reader");

    await settleRecovery(pages, fixture);
    assert.equal(tailControl(fixture)?.childNodes[0]?.textContent, "Jump to Latest", "the reader is still away from the tail");
    assert.equal(fixture.scroller.scrollTop, 123, "swapping the control does not move the reader");
    assert.equal(followState(fixture), "paused", "completion must not force the reader back to the tail");
  } finally {
    await unmountFixture(fixture);
  }
});

test("Jump to Latest appears only away from the tail, counts new rows, and returns to the tail", async () => {
  const pages = pageController();
  const fixture = await mountFixture(pages);
  try {
    await settleRecovery(pages, fixture);
    assertNoDomNode(tailControl(fixture));

    await act(async () => {
      fireDomEvent.wheel(fixture.scroller, { deltaY: -40 });
    });
    await flushAsyncWork();
    setScrollerMetrics(fixture.scroller, { clientHeight: 500, scrollHeight: 900, scrollTop: 0 });
    await scrollReader(fixture.scroller, 200, false);
    const jump = tailControl(fixture) as HTMLButtonElement | null;
    assert.ok(jump, "leaving the tail shows the control");
    assert.equal(jump.tagName, "BUTTON");
    assert.equal(jump.classList.contains("btn") && jump.classList.contains("sm"), true);
    assert.equal(jump.childNodes[0]!.textContent, "Jump to Latest");
    assert.equal(jump.querySelector("kbd")?.textContent, "End", "the End keycap on a fine pointer");
    assert.equal(jump.title, "Jump to Latest (End)");
    assert.equal(fixture.scroller.scrollTop, 200, "showing the control does not move the reader");
    assert.equal(followState(fixture), "paused", "showing the control does not change the follow state");

    for (const text of ["new answer 1", "new answer 2", "new answer 3"]) await pushEvent(fixture, text);
    const counted = tailControl(fixture)!;
    assert.equal(counted.childNodes[0]!.textContent, "3 New");
    assert.equal(counted.getAttribute("aria-label"), "3 New, Jump to Latest");
    assert.equal(fixture.scroller.scrollTop, 200, "new rows do not move a reader who left the tail");

    await act(async () => {
      counted.focus();
      counted.click();
    });
    await flushAsyncWork();
    assert.equal(followState(fixture), "following");
    assertNoDomNode(tailControl(fixture), "the tail hides the control");
    assert.equal(domWindow.document.activeElement, fixture.scroller, "focus stays in the reader");

    await act(async () => {
      fireDomEvent.wheel(fixture.scroller, { deltaY: -40 });
    });
    await flushAsyncWork();
    assert.equal(tailControl(fixture)?.childNodes[0]!.textContent, "Jump to Latest",
      "returning to the tail cleared the count");
  } finally {
    await unmountFixture(fixture);
  }
});

test("loading, empty and history-error transcripts render no follow control", async () => {
  const pages = pageController();
  const loading = await mountFixture(pages, 0);
  try {
    assert.ok(loading.container.querySelector(".transcript-skeleton"), "the transcript is loading");
    assertNoDomNode(tailControl(loading), "loading has no tail");
    assert.equal(recoveryStatusText(loading), "");

    await act(async () => {
      pages.releaseTail({ events: [], eventEpoch: 0, nextBefore: 0, hasMoreOlder: false, cacheComplete: true });
    });
    await flushAsyncWork();
    assert.ok(loading.container.textContent!.includes("Start the Conversation"), "the transcript is empty");
    assertNoDomNode(tailControl(loading), "an empty transcript has no tail");
  } finally {
    await unmountFixture(loading);
  }

  const failing = await mountFixture(pages, 0);
  try {
    await act(async () => { pages.rejectTail(); });
    await flushAsyncWork();
    assert.ok(failing.container.textContent!.includes("Couldn't Load the Full Conversation"), "history failed to load");
    assertNoDomNode(tailControl(failing), "a history error has no tail");
    assertNoDomNode(failing.container.querySelector(".follow-tail-chip"));
  } finally {
    await unmountFixture(failing);
  }
});

test("an off-screen message that was not sent outranks every other state and scrolls to itself", async () => {
  const observed: Array<{ element: Element; callback: IntersectionObserverCallback }> = [];
  const original = Object.getOwnPropertyDescriptor(globalThis, "IntersectionObserver");
  Object.defineProperty(globalThis, "IntersectionObserver", {
    configurable: true,
    writable: true,
    value: class {
      constructor(private readonly callback: IntersectionObserverCallback) {}
      observe(element: Element) { observed.push({ element, callback: this.callback }); }
      unobserve() {}
      disconnect() {}
    },
  });
  const pages = pageController();
  const fixture = await mountFixture(pages, 12, {
    pendingPrompts: [{
      commandId: "prompt-not-sent",
      text: "Please also update the changelog.",
      hasImages: false,
      state: "failed",
      revision: 1,
      attemptCount: 1,
      error: "The runner was offline.",
      canRetry: true,
      createdAt: 2,
      updatedAt: 2,
    }],
  });
  try {
    assert.equal(recoveryActive(fixture), true, "while the message is on screen, recovery shows");
    const target = observed.find(({ element }) =>
      (element as HTMLElement).dataset.pendingPromptId === "prompt-not-sent");
    assert.ok(target, "the undelivered message is watched for visibility");
    await act(async () => {
      target.callback([{ target: target.element, isIntersecting: false } as unknown as IntersectionObserverEntry],
        {} as IntersectionObserver);
    });
    const control = tailControl(fixture) as HTMLButtonElement;
    assert.equal(control.textContent, "1 Message Not Sent");
    assert.equal(control.classList.contains("is-not-sent"), true, "danger text");
    assert.equal(recoveryStatusText(fixture), "Checking for missed activity…",
      "recovery is still announced while the control shows the undelivered message");

    let scrolledTo: Element | null = null;
    (target.element as HTMLElement).scrollIntoView = function (this: Element) { scrolledTo = this; };
    await act(async () => { control.click(); });
    assert.equal(scrolledTo, target.element, "the control scrolls to the message");
    assert.equal(domWindow.document.activeElement?.textContent, "Retry", "focus lands on the message's action");

    await act(async () => {
      target.callback([{ target: target.element, isIntersecting: true } as unknown as IntersectionObserverEntry],
        {} as IntersectionObserver);
    });
    assert.equal(recoveryActive(fixture), true, "once the message is on screen the control steps down");
  } finally {
    await unmountFixture(fixture);
    if (original) Object.defineProperty(globalThis, "IntersectionObserver", original);
    else delete (globalThis as { IntersectionObserver?: unknown }).IntersectionObserver;
  }
});

test("the docked pinned summary sits beside the reader column, never over the transcript", async () => {
  const pages = pageController();
  const fixture = await mountFixture(pages, 12, { pinnedOpen: true });
  try {
    assert.equal(recoveryActive(fixture), true);
    const body = fixture.container.querySelector(".detail-body") as HTMLElement;
    const chat = fixture.container.querySelector(".detail-chat") as HTMLElement;
    const summary = fixture.container.querySelector('aside.ps[aria-label="Pinned Summary"]') as HTMLElement | null;
    assert.ok(summary, "the pinned summary renders while pinned open");
    // Structural exclusion (#2147): the summary is the reader column's sibling in the session
    // body, so it can cover neither the transcript, the recovery slot nor the status strip.
    assert.equal(summary.parentElement, body);
    assert.equal(chat.parentElement, body);
    assert.equal(chat.contains(summary), false, "the summary is outside the reader column");
    assert.equal(summary.dataset.presentation, "docked");
    assertNoDomNode(fixture.container.querySelector(".ps-scrim"), "a docked summary has no scrim");
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
    const errorNotice = fixture.container.querySelector(".transcript-history-notice[data-state='error']");
    assert.ok(errorNotice, "the failure keeps its explanatory notice");
    const retry = errorNotice.querySelector(".notice-actions button");
    assert.ok(retry, "the failure keeps its retry affordance");
    assert.equal(retry.textContent, "Retry");
    assert.equal(fixture.scroller.getAttribute("aria-busy"), "false");
  } finally {
    await unmountFixture(fixture);
  }
});

test("an opening-window safety cut keeps one compact reach-back control", async () => {
  const pages = pageController();
  const fixture = await mountFixture(pages);
  try {
    const openingWindow = fixture.events.slice(-7);
    assert.equal(openingWindow[0]?.payload.kind, "agent_message",
      "the opening window splits an older response");
    assert.equal(openingWindow.filter((entry) => entry.payload.kind === "user_message").length, 3,
      "the same window contains newer complete turns");
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

    const control = fixture.container.querySelector(".tl-earlier") as HTMLElement;
    assert.equal(
      control.textContent!.includes("A response near the beginning of the loaded activity may be incomplete."),
      false,
      "the capped fallback does not grow into a prose-and-button row",
    );
    const load = control.querySelector("button") as HTMLButtonElement;
    assert.equal(load.firstChild?.textContent, "Load Earlier Activity");
    assert.equal(control.dataset.state, "idle");
    assert.equal(load.getAttribute("aria-describedby"), null,
      "the compact control has no missing visible description relationship");
    await act(async () => load.click());
    assert.equal(pages.tailCalls.length, 2, "the capped fallback keeps a reliable reach-back control");

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
    assert.equal((fixture.container.querySelector(".tl-earlier button") as HTMLButtonElement)
      .getAttribute("aria-describedby"), null);
  } finally {
    await unmountFixture(fixture);
  }
});

test("an underfilled partial opening automatically reaches a complete scrollable window", async () => {
  const pages = pageController();
  const fixture = await mountFixture(pages);
  try {
    setScrollerMetrics(fixture.scroller, { clientHeight: 500, scrollHeight: 300, scrollTop: 0 });
    const openingWindow = fixture.events.slice(-7);
    assert.equal(openingWindow[0]?.payload.kind, "agent_message");
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
    await flushAsyncWork(10);

    assert.equal(pages.tailCalls.length, 2,
      "opening recovery prepends without waiting for reader navigation");
    assert.deepEqual(pages.tailCalls.map((call) => call.alignToTurn), [true, true],
      "both the initial window and automatic opening fill request a semantic turn boundary");
    assertNoDomNode(fixture.container.querySelector(".tl-earlier"),
      "the manual fallback stays out of the underfilled opening while recovery is active");
    const announcement = fixture.container.querySelector(
      "[data-earlier-activity-announcement]",
    ) as HTMLElement;
    assert.equal(announcement.textContent, "",
      "opening recovery does not announce reader-navigation progress");

    const earlierPage = fixture.events.slice(-15, -7);
    assert.ok(earlierPage.some((entry) => entry.payload.kind === "user_message"));
    setScrollerMetrics(fixture.scroller, { clientHeight: 500, scrollHeight: 900, scrollTop: 400 });
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

    assert.equal(pages.tailCalls.length, 2, "a complete scrollable window stops automatic paging");
    const fallback = fixture.container.querySelector(".tl-earlier") as HTMLElement;
    assert.ok(fallback, "older history remains reachable after bounded opening recovery");
    assert.equal(fallback.dataset.state, "idle");
    assert.equal(fallback.querySelector("button")?.firstChild?.textContent, "Load Earlier Activity");
    assert.equal(announcement.textContent, "",
      "completing opening recovery stays silent until the reader requests history");
  } finally {
    await unmountFixture(fixture);
  }
});

test("a desktop preview fills its opening window once and expansion preserves it", async () => {
  const pages = pageController();
  const fixture = await mountFixture(pages, 12, { mode: "preview" });
  try {
    setScrollerMetrics(fixture.scroller, { clientHeight: 500, scrollHeight: 300, scrollTop: 0 });
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
    await flushAsyncWork(10);
    assert.equal(pages.tailCalls.length, 2,
      "an underfilled preview prepends history without waiting for expansion");
    assert.equal(pages.tailCalls[1]!.alignToTurn, true,
      "preview fill recovers a semantic turn boundary");
    assertNoDomNode(fixture.container.querySelector(".tl-earlier"),
      "the underfilled manual control stays hidden while preview fill runs");

    const earlierPage = fixture.events.slice(-15, -7);
    setScrollerMetrics(fixture.scroller, { clientHeight: 500, scrollHeight: 900, scrollTop: 400 });
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
    assert.equal(pages.tailCalls.length, 2, "a filled preview settles after one bounded prepend");
    const filledScrollTop = fixture.scroller.scrollTop;
    assert.equal(filledScrollTop, 900, "a following preview remains anchored to the filled tail");

    await fixture.renderMode("expanded");
    await flushAsyncWork(10);
    assert.equal(pages.tailCalls.length, 2,
      "expanding a filled preview does not repeat its history request");
    assert.equal(fixture.scroller.scrollTop, filledScrollTop,
      "expansion keeps the filled preview's reading position");
  } finally {
    await unmountFixture(fixture);
  }
});

test("expansion rechecks taller geometry without repeating the preview cursor", async () => {
  const pages = pageController();
  const fixture = await mountFixture(pages, 12, { mode: "preview" });
  try {
    setScrollerMetrics(fixture.scroller, { clientHeight: 300, scrollHeight: 200, scrollTop: 0 });
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
    await flushAsyncWork(10);
    assert.equal(pages.tailCalls.length, 2);

    const previewPage = fixture.events.slice(-15, -7);
    setScrollerMetrics(fixture.scroller, { clientHeight: 300, scrollHeight: 600, scrollTop: 300 });
    await act(async () => {
      pages.releaseTail({
        events: previewPage,
        eventEpoch: 0,
        nextBefore: previewPage[0]!.seq,
        hasMoreOlder: true,
        cacheComplete: true,
      });
    });
    await flushAsyncWork(10);
    assert.equal(pages.tailCalls.length, 2, "the filled preview settles at its own height");
    assert.ok(fixture.container.querySelector(".tl-earlier"));

    setScrollerMetrics(fixture.scroller, { clientHeight: 700, scrollHeight: 600, scrollTop: 600 });
    await fixture.renderMode("expanded");
    await flushAsyncWork(10);
    assert.equal(pages.tailCalls.length, 3,
      "the taller expanded reader continues from the preview's next cursor");
    assert.deepEqual(pages.tailCalls.map((call) => call.before), [undefined, openingWindow[0]!.seq,
      previewPage[0]!.seq], "expansion never repeats an already loaded page");
    assert.equal(fixture.scroller.scrollTop, 600,
      "rechecking expanded geometry does not reset the live-tail position");
  } finally {
    await unmountFixture(fixture);
  }
});

test("opening fill stops at its absolute page cap without duplicate requests", async () => {
  const pages = pageController();
  const fixture = await mountFixture(pages);
  try {
    setScrollerMetrics(fixture.scroller, { clientHeight: 500, scrollHeight: 300, scrollTop: 0 });
    const openingEvent = fixture.events.at(-1)!;
    await act(async () => {
      pages.releaseTail({
        events: [openingEvent],
        eventEpoch: 0,
        nextBefore: openingEvent.seq,
        hasMoreOlder: true,
        turnAligned: false,
        cacheComplete: true,
      });
    });
    await flushAsyncWork(10);
    assert.equal(pages.tailCalls.length, 2);

    for (let page = 0; page < 10; page += 1) {
      const seq = openingEvent.seq - page - 1;
      await act(async () => {
        pages.releaseTail({
          events: [{
            id: 10_000 + page,
            sessionId: openingEvent.sessionId,
            seq,
            ts: seq,
            payload: { kind: "agent_message", text: `older chunk ${page + 1}` },
          }],
          eventEpoch: 0,
          nextBefore: seq,
          hasMoreOlder: true,
          cacheComplete: true,
        });
      });
      await flushAsyncWork(10);
    }

    assert.equal(pages.tailCalls.length, 11,
      "the initial tail request plus ten bounded earlier pages are the absolute maximum");
    await flushAsyncWork(20);
    assert.equal(pages.tailCalls.length, 11, "settling cannot issue a duplicate capped request");
    assert.equal(
      (fixture.container.querySelector(".tl-earlier button") as HTMLButtonElement)
        .firstChild?.textContent,
      "Load Earlier Activity",
      "the pathological turn retains one compact manual fallback",
    );
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

    // A reader gesture stays armed only through its own scroll stream; once that stream has gone
    // quiet, a later saved-anchor restoration cannot inherit it.
    await flushAsyncWork(250);
    await scrollReader(fixture.scroller, 120, false);
    assert.equal(pages.tailCalls.length, 1, "saved-anchor restoration cannot inherit earlier intent");

    await scrollReader(fixture.scroller, 120);
    assert.equal(pages.tailCalls.length, 2, "the near-head scroll requests an earlier page");
    assert.equal(pages.tailCalls[1]!.before, openingWindow[0]!.seq);
    assert.equal(pages.tailCalls[1]!.alignToTurn, false,
      "reader-driven pagination keeps its ordinary count-bounded cursor");
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

test("each reader finger releases the touch traversal by its own end, wherever that end is delivered (#2563)", async () => {
  interface Fingers { scroller: HTMLElement; row: HTMLElement; outside: HTMLElement }
  const dispatch = (target: EventTarget, event: unknown) => act(async () => {
    target.dispatchEvent(event as never);
  });
  const finger = (identifier: number) => ({ identifier, clientY: 100 + identifier * 100 });
  // A reader finger lifts first; the outside finger's end never passes through the reader.
  const liftReaderFingerBeforeOutsideFinger = async ({ row, outside }: Fingers) => {
    await dispatch(row, fingerEvent("touchstart", [finger(1)], [finger(1)]));
    await dispatch(outside, fingerEvent("touchstart", [finger(2)], [finger(1), finger(2)]));
    await dispatch(row, fingerEvent("touchend", [finger(1)], [finger(2)]));
    await dispatch(outside, fingerEvent("touchend", [finger(2)], []));
  };
  const cases: Array<{ name: string; held: boolean; gesture: (fingers: Fingers) => Promise<void> }> = [
    {
      name: "a reader finger that is still down",
      held: true,
      gesture: async ({ row }) => { await dispatch(row, fingerEvent("touchstart", [finger(1)], [finger(1)])); },
    },
    {
      name: "a reader finger that lifts before a finger outside the reader",
      held: false,
      gesture: liftReaderFingerBeforeOutsideFinger,
    },
    {
      name: "a reader finger whose row a re-render removed before it lifted",
      held: false,
      gesture: async ({ row }) => {
        await dispatch(row, fingerEvent("touchstart", [finger(1)], [finger(1)]));
        row.remove();
        await dispatch(row, fingerEvent("touchend", [finger(1)], []));
      },
    },
    {
      name: "one of two reader fingers, while the other stays down",
      held: true,
      gesture: async ({ row, scroller }) => {
        await dispatch(row, fingerEvent("touchstart", [finger(1)], [finger(1)]));
        await dispatch(scroller, fingerEvent("touchstart", [finger(2)], [finger(1), finger(2)]));
        await dispatch(row, fingerEvent("touchend", [finger(1)], [finger(2)]));
      },
    },
    {
      name: "both of two reader fingers, one after the other",
      held: false,
      gesture: async ({ row, scroller }) => {
        await dispatch(row, fingerEvent("touchstart", [finger(1)], [finger(1)]));
        await dispatch(scroller, fingerEvent("touchstart", [finger(2)], [finger(1), finger(2)]));
        await dispatch(row, fingerEvent("touchend", [finger(1)], [finger(2)]));
        await dispatch(scroller, fingerEvent("touchend", [finger(2)], []));
      },
    },
    {
      name: "a native pan whose pointer the browser cancelled",
      held: true,
      gesture: async ({ scroller }) => {
        await dispatch(scroller, pointerInputEvent("pointerdown", 100, 1));
        await dispatch(scroller, fingerEvent("touchstart", [finger(1)], [finger(1)]));
        await dispatch(scroller, pointerInputEvent("pointercancel", 100, 1));
      },
    },
    {
      name: "a drag relayed from Jump to Latest that lifts",
      held: false,
      gesture: async ({ scroller }) => {
        await dispatch(scroller, pointerInputEvent("pointerdown", 100, 7));
        await dispatch(scroller, pointerInputEvent("pointerup", 100, 7));
      },
    },
    {
      name: "a relayed drag that lifts after a reader finger lifted before an outside finger",
      held: false,
      gesture: async (fingers) => {
        await liftReaderFingerBeforeOutsideFinger(fingers);
        await dispatch(fingers.scroller, pointerInputEvent("pointerdown", 100, 7));
        await dispatch(fingers.scroller, pointerInputEvent("pointerup", 100, 7));
      },
    },
    {
      name: "a touch pointer that lifts outside the reader",
      held: false,
      gesture: async ({ scroller, outside }) => {
        await dispatch(scroller, pointerInputEvent("pointerdown", 100, 7));
        await dispatch(outside, pointerInputEvent("pointerup", 100, 7));
      },
    },
    {
      name: "a touch pointer while another pointer lifts",
      held: true,
      gesture: async ({ scroller, outside }) => {
        await dispatch(scroller, pointerInputEvent("pointerdown", 100, 7));
        await dispatch(outside, pointerInputEvent("pointerup", 100, 8));
      },
    },
  ];
  for (const { name, held, gesture } of cases) {
    const pages = pageController();
    const fixture = await mountFixture(pages);
    const outside = domWindow.document.createElement("div") as unknown as HTMLElement;
    const row = domWindow.document.createElement("div") as unknown as HTMLElement;
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
      domWindow.document.body.append(outside as never);
      fixture.scroller.append(row as never);

      await gesture({ scroller: fixture.scroller, row, outside });
      // Past the traversal's idle window, an upward scroll the reader did not start reaches the head.
      await flushAsyncWork(250);
      await scrollReader(fixture.scroller, 120, false);

      assert.equal(pages.tailCalls.length, held ? 2 : 1, held
        ? `${name} keeps the traversal held, so it loads at the head`
        : `${name} ends the traversal, so a later scroll it did not start cannot load`);
    } finally {
      row.remove();
      outside.remove();
      await unmountFixture(fixture);
    }
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
    const announcement = fixture.container.querySelector(
      "[data-earlier-activity-announcement]",
    ) as HTMLElement;
    assert.equal(announcement.textContent, "Loading earlier activity.");
    assert.equal(fixture.container.querySelector(".tl-earlier")?.getAttribute("data-state"), "loading");
    await act(async () => pages.rejectTail());
    await flushAsyncWork();

    const control = fixture.container.querySelector(".tl-earlier") as HTMLElement;
    assert.equal(control.dataset.state, "error");
    assert.ok(control.textContent!.includes("Could not load earlier activity."));
    assert.equal(announcement.textContent, "Could not load earlier activity. Retry is available.");
    const retry = control.querySelector("button") as HTMLButtonElement;
    assert.equal(retry.disabled, false);
    await act(async () => retry.click());
    assert.equal(pages.tailCalls.length, 3, "the fallback control retries the failed page");
    assert.equal(announcement.textContent, "Loading earlier activity.");
    assert.equal(fixture.container.querySelector(".tl-earlier")?.getAttribute("data-state"), "loading");

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
    await flushAsyncWork();
    assert.equal(announcement.textContent, "Earlier activity loaded.");
    setScrollerMetrics(fixture.scroller, { clientHeight: 400, scrollHeight: 3_200, scrollTop: 1_600 });
    await scrollReader(fixture.scroller, 1_560);
    assert.equal(pages.tailCalls.length, 3, "a manual prepend uses the same settle gate");
  } finally {
    await unmountFixture(fixture);
  }
});

test("an older page from a server without backward reads names Wollipog, not the control plane", async () => {
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
    // No `hasMoreOlder`: the server answered a backward read with a forward page (#2579).
    await act(async () => pages.releaseTail({ events: [], eventEpoch: 0, nextBefore: 0, cacheComplete: true }));
    await flushAsyncWork();

    const sentence = "Earlier activity isn't available from this version of Wollipog. Update Wollipog to load it.";
    const control = fixture.container.querySelector(".tl-earlier") as HTMLElement;
    assert.equal(control.dataset.state, "error");
    assert.ok(control.textContent!.includes(sentence));
    assert.doesNotMatch(control.textContent!, /control plane/i);
    assert.equal(
      fixture.container.querySelector("[data-earlier-activity-announcement]")?.textContent,
      `${sentence} Retry is available.`,
    );
  } finally {
    await unmountFixture(fixture);
  }
});

async function openBoundedWindow(pages: ReturnType<typeof pageController>, fixture: Fixture) {
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
  return openingWindow;
}

/** One gesture, many scroll events: a smooth-scrolling browser answers a wheel tick or reading
 * key with a stream whose early events are still above the trigger zone. */
async function streamReaderScroll(scroller: HTMLElement, scrollTops: number[]) {
  for (const scrollTop of scrollTops) {
    await act(async () => {
      scroller.scrollTop = scrollTop;
      scroller.dispatchEvent(new domWindow.Event("scroll", { bubbles: true }) as never);
    });
    await flushAsyncWork(16);
  }
}

test("a reading key whose scroll stream starts above the trigger still loads when it lands at the head", async () => {
  const pages = pageController();
  const fixture = await mountFixture(pages);
  try {
    const openingWindow = await openBoundedWindow(pages, fixture);
    setScrollerMetrics(fixture.scroller, { clientHeight: 400, scrollHeight: 1_600, scrollTop: 700 });

    await act(async () => {
      fireDomEvent.keyDown(fixture.scroller, { key: "PageUp" });
    });
    await streamReaderScroll(fixture.scroller, [520, 360, 210, 90, 0]);

    assert.equal(pages.tailCalls.length, 2, "the gesture that lands on the head requests the earlier page");
    assert.equal(pages.tailCalls[1]!.before, openingWindow[0]!.seq);
  } finally {
    await unmountFixture(fixture);
  }
});

test("a wheel tick whose scroll stream starts above the trigger still loads when it lands inside it", async () => {
  const pages = pageController();
  const fixture = await mountFixture(pages);
  try {
    await openBoundedWindow(pages, fixture);
    setScrollerMetrics(fixture.scroller, { clientHeight: 400, scrollHeight: 1_600, scrollTop: 300 });

    await act(async () => {
      fireDomEvent.wheel(fixture.scroller, { deltaY: -120 });
    });
    await streamReaderScroll(fixture.scroller, [260, 200, 150, 120]);

    assert.equal(pages.tailCalls.length, 2, "the tick that lands inside the trigger zone requests the earlier page");
  } finally {
    await unmountFixture(fixture);
  }
});

test("a scroll stream that turns back downward releases the reader's intent", async () => {
  const pages = pageController();
  const fixture = await mountFixture(pages);
  try {
    await openBoundedWindow(pages, fixture);
    setScrollerMetrics(fixture.scroller, { clientHeight: 400, scrollHeight: 1_600, scrollTop: 700 });

    await act(async () => {
      fireDomEvent.keyDown(fixture.scroller, { key: "PageUp" });
    });
    await streamReaderScroll(fixture.scroller, [520, 360, 500, 120]);

    assert.equal(pages.tailCalls.length, 1, "forward movement is never a request for history");
  } finally {
    await unmountFixture(fixture);
  }
});

test("a wheel tick that produces no scroll stream expires before a later layout scroll", async () => {
  const pages = pageController();
  const fixture = await mountFixture(pages);
  try {
    await openBoundedWindow(pages, fixture);
    setScrollerMetrics(fixture.scroller, { clientHeight: 400, scrollHeight: 1_600, scrollTop: 1_200 });

    await act(async () => {
      fireDomEvent.wheel(fixture.scroller, { deltaY: -40 });
    });
    await flushAsyncWork(250);
    await scrollReader(fixture.scroller, 120, false);

    assert.equal(pages.tailCalls.length, 1, "a quiet gesture cannot arm a later programmatic scroll");
  } finally {
    await unmountFixture(fixture);
  }
});

test("a downward wheel tick never arms earlier pagination", async () => {
  const pages = pageController();
  const fixture = await mountFixture(pages);
  try {
    await openBoundedWindow(pages, fixture);
    setScrollerMetrics(fixture.scroller, { clientHeight: 400, scrollHeight: 1_600, scrollTop: 300 });

    await act(async () => {
      fireDomEvent.wheel(fixture.scroller, { deltaY: 120 });
    });
    await streamReaderScroll(fixture.scroller, [120]);

    assert.equal(pages.tailCalls.length, 1, "reading forward inside the trigger zone does not page");
  } finally {
    await unmountFixture(fixture);
  }
});

test("upward wheel input at the head loads the next page without a scroll event", async () => {
  const pages = pageController();
  const fixture = await mountFixture(pages);
  try {
    const openingWindow = await openBoundedWindow(pages, fixture);
    setScrollerMetrics(fixture.scroller, { clientHeight: 400, scrollHeight: 1_600, scrollTop: 0 });

    await act(async () => {
      fireDomEvent.wheel(fixture.scroller, { deltaY: -40 });
    });
    await flushAsyncWork();
    assert.equal(pages.tailCalls.length, 2, "a wheel tick at the head requests the earlier page directly");
    assert.equal(pages.tailCalls[1]!.before, openingWindow[0]!.seq);

    await act(async () => {
      fireDomEvent.wheel(fixture.scroller, { deltaY: -40 });
      fireDomEvent.wheel(fixture.scroller, { deltaY: -40 });
    });
    await flushAsyncWork();
    assert.equal(pages.tailCalls.length, 2, "repeated ticks while the page is in flight cannot duplicate it");
  } finally {
    await unmountFixture(fixture);
  }
});

test("upward wheel input above the head leaves the request to its scroll stream", async () => {
  const pages = pageController();
  const fixture = await mountFixture(pages);
  try {
    await openBoundedWindow(pages, fixture);
    setScrollerMetrics(fixture.scroller, { clientHeight: 400, scrollHeight: 1_600, scrollTop: 100 });

    await act(async () => {
      fireDomEvent.wheel(fixture.scroller, { deltaY: -40 });
    });
    await flushAsyncWork();
    assert.equal(pages.tailCalls.length, 1, "input that still has a scroll event coming does not page early");

    await streamReaderScroll(fixture.scroller, [60]);
    assert.equal(pages.tailCalls.length, 2, "its scroll stream requests the page once it arrives");
  } finally {
    await unmountFixture(fixture);
  }
});

test("an upward reading key at the head loads the next page without a scroll event", async () => {
  const pages = pageController();
  const fixture = await mountFixture(pages);
  try {
    await openBoundedWindow(pages, fixture);
    setScrollerMetrics(fixture.scroller, { clientHeight: 400, scrollHeight: 1_600, scrollTop: 0 });

    await act(async () => {
      fireDomEvent.keyDown(fixture.scroller, { key: "ArrowUp" });
    });
    await flushAsyncWork();
    assert.equal(pages.tailCalls.length, 2, "an upward reading key at the head requests the earlier page directly");

    await act(async () => {
      fireDomEvent.keyDown(fixture.scroller, { key: "ArrowDown" });
    });
    await flushAsyncWork();
    assert.equal(pages.tailCalls.length, 2, "a downward reading key never pages");
  } finally {
    await unmountFixture(fixture);
  }
});

test("a downward finger drag at the head loads the next page without a scroll event", async () => {
  const pages = pageController();
  const fixture = await mountFixture(pages);
  try {
    await openBoundedWindow(pages, fixture);
    setScrollerMetrics(fixture.scroller, { clientHeight: 400, scrollHeight: 1_600, scrollTop: 0 });

    await act(async () => {
      fixture.scroller.dispatchEvent(touchInputEvent("touchstart", 100) as never);
      fixture.scroller.dispatchEvent(touchInputEvent("touchmove", 110) as never);
      fixture.scroller.dispatchEvent(touchInputEvent("touchend") as never);
    });
    await flushAsyncWork(250);
    assert.equal(pages.tailCalls.length, 1, "a short touch is a tap or a jitter, never a request for history");

    await act(async () => {
      fixture.scroller.dispatchEvent(touchInputEvent("touchstart", 100) as never);
      fixture.scroller.dispatchEvent(touchInputEvent("touchmove", 118) as never);
      fixture.scroller.dispatchEvent(touchInputEvent("touchmove", 140) as never);
    });
    await flushAsyncWork();
    assert.equal(pages.tailCalls.length, 2, "a genuine downward drag at the head requests the earlier page");

    await act(async () => {
      fixture.scroller.dispatchEvent(touchInputEvent("touchmove", 170) as never);
      fixture.scroller.dispatchEvent(touchInputEvent("touchend") as never);
    });
    await flushAsyncWork();
    assert.equal(pages.tailCalls.length, 2, "the rest of the drag cannot duplicate the in-flight request");
  } finally {
    await unmountFixture(fixture);
  }
});

test("a scrollbar press stays armed until the button is released", async () => {
  const pages = pageController();
  const fixture = await mountFixture(pages);
  try {
    await openBoundedWindow(pages, fixture);
    setScrollerMetrics(fixture.scroller, { clientHeight: 400, scrollHeight: 1_600, scrollTop: 900 });

    await act(async () => {
      fireDomEvent.pointerDown(fixture.scroller, { pointerType: "mouse", button: 0 });
    });
    // The drag begins well after the idle window a wheel tick would get.
    await flushAsyncWork(250);
    await streamReaderScroll(fixture.scroller, [600, 300, 120]);
    assert.equal(pages.tailCalls.length, 2, "a held scrollbar drag that reaches the trigger zone pages");
  } finally {
    await unmountFixture(fixture);
  }
});

test("an upward Session Reading claim at the head loads the next page, a downward one never arms", async () => {
  const pages = pageController();
  const fixture = await mountFixture(pages);
  try {
    await openBoundedWindow(pages, fixture);
    setScrollerMetrics(fixture.scroller, { clientHeight: 400, scrollHeight: 1_600, scrollTop: 0 });

    await act(async () => {
      fixture.scroller.dispatchEvent(
        new domWindow.CustomEvent(VIRTUAL_VIEWPORT_INTENT_EVENT, { detail: { direction: "down" } }) as never,
      );
    });
    await streamReaderScroll(fixture.scroller, [40]);
    assert.equal(pages.tailCalls.length, 1, "a downward programmatic claim cannot arm pagination");

    await act(async () => {
      fixture.scroller.scrollTop = 0;
      fixture.scroller.dispatchEvent(
        new domWindow.CustomEvent(VIRTUAL_VIEWPORT_INTENT_EVENT, { detail: { direction: "up" } }) as never,
      );
    });
    await flushAsyncWork();
    assert.equal(pages.tailCalls.length, 2, "an upward claim at the head requests the earlier page directly");
  } finally {
    await unmountFixture(fixture);
  }
});

test("a nested scroller that can still move upward consumes head input instead of paging", async () => {
  const pages = pageController();
  const fixture = await mountFixture(pages);
  try {
    await openBoundedWindow(pages, fixture);
    setScrollerMetrics(fixture.scroller, { clientHeight: 400, scrollHeight: 1_600, scrollTop: 0 });
    const output = domWindow.document.createElement("pre") as unknown as HTMLElement;
    fixture.scroller.append(output as never);
    setScrollerMetrics(output, { clientHeight: 200, scrollHeight: 600, scrollTop: 120 });

    await act(async () => {
      fireDomEvent.wheel(output, { deltaY: -40 });
    });
    await flushAsyncWork();
    assert.equal(pages.tailCalls.length, 1, "a tool output scrolling up inside the transcript is not a request for history");

    await act(async () => {
      fixture.scroller.dispatchEvent(touchInputEvent("touchstart", 100) as never);
      output.dispatchEvent(touchInputEvent("touchmove", 118) as never);
      output.dispatchEvent(touchInputEvent("touchmove", 140) as never);
      fixture.scroller.dispatchEvent(touchInputEvent("touchend") as never);
    });
    await flushAsyncWork(250);
    assert.equal(pages.tailCalls.length, 1, "a finger drag inside that output is consumed by it as well");

    output.scrollTop = 0;
    await act(async () => {
      fireDomEvent.wheel(output, { deltaY: -40 });
    });
    await flushAsyncWork();
    assert.equal(pages.tailCalls.length, 2, "once the output cannot move, the same gesture reaches the transcript head");
  } finally {
    await unmountFixture(fixture);
  }
});

test("a steering receipt keeps its actions while the history is loading or failed to load (#2171)", async () => {
  const pages = pageController();
  const fixture = await mountFixture(pages, 0, {
    steeringAttempts: [{
      submissionId: "steer-uncertain", turnId: "turn-previous", source: "direct", text: "Stop after the build.",
      state: "uncertain", reason: "transport_uncertain", createdAt: 2, updatedAt: 3,
    }],
  });
  const receipt = () => fixture.scroller.querySelector('[data-testid="steering-attempt-steer-uncertain"]');
  try {
    assert.ok(fixture.container.querySelector(".transcript-skeleton"), "the transcript is loading");
    assert.ok(receipt(), "the receipt is in the reader while history loads");
    await act(async () => { pages.rejectTail(); });
    await flushAsyncWork();
    assert.ok(fixture.container.textContent!.includes("Couldn't Load the Full Conversation"), "history failed to load");
    const buttons = [...(receipt()?.querySelectorAll("button") ?? [])].map((button) => button.textContent);
    assert.deepEqual(buttons, ["Queue Again", "Dismiss"], "its recovery actions stay reachable");
  } finally {
    await unmountFixture(fixture);
  }
});

test("a focused receipt stays mounted and focused when the history it waited for arrives (#2171)", async () => {
  const pages = pageController();
  const fixture = await mountFixture(pages, 0, {
    steeringAttempts: [{
      submissionId: "steer-focused", turnId: "turn-previous", source: "direct", text: "Stop after the build.",
      state: "uncertain", reason: "transport_uncertain", createdAt: 2, updatedAt: 3,
    }],
  });
  try {
    assert.ok(fixture.container.querySelector(".transcript-skeleton"), "the transcript is loading");
    const queueAgain = [...fixture.scroller.querySelectorAll<HTMLButtonElement>(
      '[data-testid="steering-attempt-steer-focused"] button')].find((button) => button.textContent === "Queue Again");
    assert.ok(queueAgain);
    await act(async () => { queueAgain.focus(); });
    assert.equal(domWindow.document.activeElement, queueAgain);
    await act(async () => {
      pages.releaseTail({ events: [], eventEpoch: 0, nextBefore: 0, hasMoreOlder: false, cacheComplete: true });
    });
    await flushAsyncWork();
    assertNoDomNode(fixture.container.querySelector(".transcript-skeleton"), "history has arrived");
    assert.equal(queueAgain.isConnected, true, "the receipt was not remounted");
    assert.equal(domWindow.document.activeElement, queueAgain, "focus stays where the person left it");
  } finally {
    await unmountFixture(fixture);
  }
});

/** A message sign-in recovery left undelivered: retryable and dismissible (#2500). */
function failedAuthenticationPrompt(commandId: string): NonNullable<SessionView["pendingPrompts"]>[number] {
  return {
    commandId,
    text: "Please also update the changelog.",
    hasImages: false,
    state: "failed",
    errorCode: "PROVIDER_AUTHENTICATION_REQUIRED",
    error: "authentication recovery was dismissed; this message was not sent",
    canDismiss: true,
    canRetry: true,
    revision: 1,
    attemptCount: 1,
    createdAt: 2,
    updatedAt: 2,
  };
}

function pendingPromptButtons(fixture: Fixture, commandId: string) {
  return [...fixture.scroller.querySelectorAll<HTMLButtonElement>(
    `[data-testid="pending-prompt-${commandId}"] .tl-receipt-buttons button`)];
}

test("a failed message keeps its row, reason, Retry and Dismiss while the history is loading or failed to load (#2500)", async () => {
  const pages = pageController();
  const resolved: string[] = [];
  const fixture = await mountFixture(pages, 0, {
    pendingPrompts: [failedAuthenticationPrompt("prompt-failed")],
    client: {
      resolvePendingPrompt: async (_id: string, commandId: string, action: "cancel" | "dismiss" | "retry") => {
        resolved.push(`${action}:${commandId}`);
        return {} as SessionView;
      },
    },
  });
  const row = () => fixture.scroller.querySelector('[data-testid="pending-prompt-prompt-failed"]');
  try {
    assert.ok(fixture.container.querySelector(".transcript-skeleton"), "the transcript is loading");
    assert.ok(row(), "the failed message is in the reader while history loads");
    await act(async () => { pages.rejectTail(); });
    await flushAsyncWork();
    assert.ok(fixture.container.textContent!.includes("Couldn't Load the Full Conversation"), "history failed to load");
    assert.match(row()?.querySelector(".tl-receipt")?.textContent ?? "",
      /^Delivery Failed·Sign-in was dismissed, so this message wasn't sent\.·RetryDismissShow Details$/u,
      "its status, reason and actions read as in a loaded transcript");
    const buttons = pendingPromptButtons(fixture, "prompt-failed");
    assert.deepEqual(buttons.map((button) => [button.textContent, button.disabled]), [["Retry", false], ["Dismiss", false]]);
    await act(async () => { buttons[0]!.click(); });
    await flushAsyncWork();
    await act(async () => { pendingPromptButtons(fixture, "prompt-failed")[1]!.click(); });
    await flushAsyncWork();
    assert.deepEqual(resolved, ["retry:prompt-failed", "dismiss:prompt-failed"], "both actions reach the service");
  } finally {
    await unmountFixture(fixture);
  }
});

test("a failed message under a history error keeps the Viewer refusal and worktree-recovery rules (#2500)", async () => {
  const refusal = "Viewers can't manage this session's messages.";
  const refused = { allowed: false as const, reason: refusal };
  for (const variant of [
    {
      name: "refused",
      overrides: { commandPermissions: {
        stop: refused, restart: refused, stopBackgroundJob: refused, manageQueue: refused, prompt: refused,
      } } satisfies Partial<SessionView>,
      expected: [["Retry", true, refusal], ["Dismiss", true, refusal]],
    },
    {
      name: "worktree recovery",
      overrides: { worktreeRecovery: {
        recoveryId: "recovery-1", detectedAt: 1, selectedPath: "/repos/demo/missing", expectedBranch: "agent/demo",
        detail: "The selected worktree is missing.",
      } } satisfies Partial<SessionView>,
      expected: [["Retry", true, "Recover the selected worktree before retrying this message."], ["Dismiss", false, null]],
    },
  ]) {
    const pages = pageController();
    const fixture = await mountFixture(pages, 0, {
      pendingPrompts: [failedAuthenticationPrompt("prompt-ruled")],
      sessionOverrides: variant.overrides,
    });
    try {
      await act(async () => { pages.rejectTail(); });
      await flushAsyncWork();
      assert.ok(fixture.container.textContent!.includes("Couldn't Load the Full Conversation"), "history failed to load");
      assert.deepEqual(
        pendingPromptButtons(fixture, "prompt-ruled")
          .map((button) => [button.textContent, button.disabled, button.getAttribute("title")]),
        variant.expected,
        variant.name,
      );
    } finally {
      await unmountFixture(fixture);
    }
  }
});

test("a focused failed message stays mounted and focused when the history it waited for arrives (#2500)", async () => {
  const pages = pageController();
  const fixture = await mountFixture(pages, 0, { pendingPrompts: [failedAuthenticationPrompt("prompt-focused")] });
  try {
    assert.ok(fixture.container.querySelector(".transcript-skeleton"), "the transcript is loading");
    for (const label of ["Retry", "Dismiss"]) {
      const action = pendingPromptButtons(fixture, "prompt-focused").find((button) => button.textContent === label);
      assert.ok(action, label);
      await act(async () => { action.focus(); });
      assert.equal(domWindow.document.activeElement, action);
      if (label === "Dismiss") {
        await act(async () => {
          pages.releaseTail({
            events: cachedTranscriptEvents(fixture.sessionId, 2),
            eventEpoch: 0,
            nextBefore: 0,
            hasMoreOlder: false,
            cacheComplete: true,
          });
        });
        await flushAsyncWork();
        assertNoDomNode(fixture.container.querySelector(".transcript-skeleton"), "history has arrived");
        const timeline = fixture.scroller.querySelector(".timeline");
        assert.ok(timeline, "the transcript shows its rows");
        assert.equal(Boolean(timeline.compareDocumentPosition(action as never) & domWindow.Node.DOCUMENT_POSITION_FOLLOWING),
          true, "the failed message sits after the transcript's rows");
        assert.equal(action.isConnected, true, "the row was not remounted");
        assert.equal(domWindow.document.activeElement, action, "focus stays where the person left it");
      }
    }
  } finally {
    await unmountFixture(fixture);
  }
});

test("once the history gives the transcript a tail, Message Not Sent counts and finds the failed message once (#2500)", async () => {
  const observed: Array<{ element: Element; callback: IntersectionObserverCallback }> = [];
  const original = Object.getOwnPropertyDescriptor(globalThis, "IntersectionObserver");
  Object.defineProperty(globalThis, "IntersectionObserver", {
    configurable: true,
    writable: true,
    value: class {
      constructor(private readonly callback: IntersectionObserverCallback) {}
      observe(element: Element) { observed.push({ element, callback: this.callback }); }
      unobserve() {}
      disconnect() {}
    },
  });
  const pages = pageController();
  const fixture = await mountFixture(pages, 0, { pendingPrompts: [failedAuthenticationPrompt("prompt-tail")] });
  try {
    const row = fixture.scroller.querySelector('[data-pending-prompt-id="prompt-tail"]');
    assert.ok(row, "the failed message shows while history loads");
    assert.equal(observed.length, 0, "a loading transcript has no tail to raise the control");
    assertNoDomNode(tailControl(fixture));
    await act(async () => {
      pages.releaseTail({
        events: cachedTranscriptEvents(fixture.sessionId, 2),
        eventEpoch: 0,
        nextBefore: 0,
        hasMoreOlder: false,
        cacheComplete: true,
      });
    });
    await flushAsyncWork();
    const watched = observed.filter(({ element }) => element.getAttribute("data-receipt-id") === "prompt:prompt-tail");
    assert.ok(watched.length > 0, "the failed message is watched once the transcript has a tail");
    assert.equal(new Set(watched.map(({ element }) => element)).size, 1, "one row stands for the message");
    assert.equal(watched[0]!.element, row, "the row rendered while loading is the one watched");
    const target = watched.at(-1)!;
    await act(async () => {
      target.callback([{ target: target.element, isIntersecting: false } as unknown as IntersectionObserverEntry],
        {} as IntersectionObserver);
    });
    const control = tailControl(fixture) as HTMLButtonElement;
    assert.equal(control.textContent, "1 Message Not Sent");
    let scrolledTo: Element | null = null;
    (target.element as HTMLElement).scrollIntoView = function (this: Element) { scrolledTo = this; };
    await act(async () => { control.click(); });
    assert.equal(scrolledTo, row, "the control scrolls to the message");
    assert.equal(domWindow.document.activeElement?.textContent, "Retry", "focus lands on its first action");
  } finally {
    await unmountFixture(fixture);
    if (original) Object.defineProperty(globalThis, "IntersectionObserver", original);
    else delete (globalThis as { IntersectionObserver?: unknown }).IntersectionObserver;
  }
});


test("a paused provisional reader resumes its REST tail when the first subscription acknowledgement arrives", async () => {
  const pages = pageController();
  const fixture = await mountFixture(pages, 0, { acknowledgeSubscription: false });
  try {
    const windowEvents = cachedTranscriptEvents(fixture.sessionId, 12).map((event) => ({
      ...event, id: event.id + 1_000, seq: event.seq + 1_000,
    }));
    const tail = windowEvents.at(-1)!.seq;
    Object.defineProperties(fixture.scroller, {
      offsetHeight: { configurable: true, value: 500 },
      offsetWidth: { configurable: true, value: 800 },
      clientWidth: { configurable: true, value: 800 },
    });
    setScrollerMetrics(fixture.scroller, { clientHeight: 500, scrollHeight: 2_500, scrollTop: 900 });
    await act(async () => pages.releaseTail({
      events: windowEvents, eventEpoch: 0, hasMoreOlder: true, cacheComplete: true, turnAligned: true,
    }));
    await flushAsyncWork(30);
    assert.ok(fixture.container.querySelector("[data-virtual-row]"), "the measured reader has a visible anchor");
    await act(async () => fireDomEvent.wheel(fixture.scroller, { deltaY: -40 }));
    await scrollReader(fixture.scroller, 860, false);
    assert.equal(followState(fixture), "paused");
    const anchorTop = fixture.scroller.scrollTop;
    // A live tail can race ahead of the REST window. It proves nothing about the missing gap.
    await act(async () => fixture.socket.push({ type: "session_event", event: {
      id: tail + 5, sessionId: fixture.sessionId, seq: tail + 5, ts: tail + 5,
      payload: { kind: "agent_message", text: "live after the provisional window", final: true },
    } }));
    const revision = fixture.socket.sent.filter((message) => message.type === "session_subscriptions").at(-1)?.revision;
    assert.ok(revision != null);
    await act(async () => fixture.socket.push({
      type: "session_subscriptions_applied", revision, sessionIds: [fixture.sessionId], podIds: [],
    }));
    await flushAsyncWork();
    assert.deepEqual(pages.forwardAfters, [tail], "late acknowledgement must not replay the prefix or skip to the live seq");
    assert.equal(pages.tailCalls.length, 1, "the paused provisional window stays mounted");
    await act(async () => pages.releaseForward({
      events: Array.from({ length: 4 }, (_, index): SessionEvent => ({
        id: tail + index + 1, sessionId: fixture.sessionId, seq: tail + index + 1, ts: tail + index + 1,
        payload: { kind: "agent_message", text: "recovered gap", final: true },
      })),
      eventEpoch: 0, nextAfter: tail + 4, hasMoreCached: false, cacheComplete: true,
    }));
    await flushAsyncWork();
    assert.equal(followState(fixture), "paused");
    assert.equal(fixture.scroller.scrollTop, anchorTop, "gap completion preserves the paused viewport");
    assert.equal(pages.forwardCalls(), 1);
  } finally { await unmountFixture(fixture); }
});


test("pausing a cached reader during a provisional tail read preserves its row and offset", async () => {
  const pages = pageController();
  let metadataCalls = 0;
  const fixture = await mountFixture(pages, 0, {
    acknowledgeSubscription: false,
    sessionOverrides: { status: "starting" },
    client: { session: async (id) => ({
      session: { ...session(id), status: ++metadataCalls <= 2 ? "starting" : "idle" },
    }) },
  });
  try {
    const windowEvents = cachedTranscriptEvents(fixture.sessionId, 12).map((event) => ({
      ...event, id: event.id + 1_000, seq: event.seq + 1_000,
    }));
    Object.defineProperties(fixture.scroller, {
      offsetHeight: { configurable: true, value: 500 },
      offsetWidth: { configurable: true, value: 800 },
      clientWidth: { configurable: true, value: 800 },
    });
    setScrollerMetrics(fixture.scroller, { clientHeight: 500, scrollHeight: 2_500, scrollTop: 900 });
    await act(async () => pages.releaseTail({
      events: windowEvents, eventEpoch: 0, hasMoreOlder: true, cacheComplete: true, turnAligned: true,
    }));
    await flushAsyncWork(30);
    assert.ok(fixture.container.querySelector("[data-virtual-row]"), "the measured reader has a visible anchor");
    await act(async () => fixture.setConnection("connecting"));
    await flushAsyncWork();
    assert.equal(pages.tailCalls.length, 2, "a fresh provisional tail is pending over the cached reader");
    await act(async () => fireDomEvent.wheel(fixture.scroller, { deltaY: -40 }));
    await scrollReader(fixture.scroller, 860, false);
    assert.equal(followState(fixture), "paused");
    const anchorTop = fixture.scroller.scrollTop;
    const oldRowIds = fixture.readLoadedEvents()!.map((event) => event.id);
    await act(async () => pages.releaseTail({
      events: windowEvents.map((event) => ({ ...event, id: event.id + 1_000, seq: event.seq + 1_000 })),
      eventEpoch: 0, hasMoreOlder: true, cacheComplete: true, turnAligned: true,
    }));
    await flushAsyncWork(30);
    assert.deepEqual(fixture.readLoadedEvents()!.map((event) => event.id), oldRowIds,
      "a late disjoint REST tail cannot evict the row the user paused on");
    assert.equal(fixture.scroller.scrollTop, anchorTop, "the paused viewport keeps its pixel offset");
    assert.equal(followState(fixture), "paused");
    assert.ok(!fixture.container.textContent?.includes("Could not load session activity"),
      "pausing is not reported as a REST failure");
    await flushAsyncWork(2_050);
    assert.equal(fixture.readSession()?.status, "idle", "metadata readiness remains independent of the paused tail");
    assert.equal(metadataCalls, 3);
    assert.equal(pages.tailCalls.length, 2, "readiness polling cannot retry the skipped tail");
  } finally { await unmountFixture(fixture); }
});


test("unrelated busy-session subscriptions do not reread an already acknowledged conversation", async () => {
  const pages = pageController();
  let metadataCalls = 0;
  const fixture = await mountFixture(pages, 12, {
    acknowledgeSubscription: false,
    client: { session: async (id) => { metadataCalls++; return { session: session(id) }; } },
  });
  try {
    await act(async () => pages.releaseTail({
      events: fixture.events, eventEpoch: 0, hasMoreOlder: false, cacheComplete: true, turnAligned: true,
    }));
    await flushAsyncWork();
    const firstRevision = fixture.socket.sent.filter((message) => message.type === "session_subscriptions").at(-1)?.revision;
    assert.ok(firstRevision != null);
    await act(async () => fixture.socket.push({
      type: "session_subscriptions_applied", revision: firstRevision, sessionIds: [fixture.sessionId], podIds: [],
    }));
    await flushAsyncWork();
    await act(async () => pages.releaseForward({
      events: [], eventEpoch: 0, nextAfter: 24, hasMoreCached: false, cacheComplete: true,
    }));
    await flushAsyncWork();
    assert.equal(pages.tailCalls.length, 1);
    assert.equal(metadataCalls, 1);
    const otherSessionId = `${fixture.sessionId}-busy-neighbor`;
    await act(async () => fixture.socket.push({
      type: "session_upsert", session: { ...session(otherSessionId), status: "running" },
    }));
    await flushAsyncWork();
    const nextRevision = fixture.socket.sent.filter((message) => message.type === "session_subscriptions").at(-1)?.revision;
    assert.ok(nextRevision != null && nextRevision > firstRevision, "the busy neighbor changes the real fleet subscription");
    assert.equal(metadataCalls, 1, "a transient fleet acknowledgement cannot restart provisional metadata reads");
    assert.equal(pages.tailCalls.length, 1, "an already acknowledged detail does not request a replacement tail");
    assert.equal(pages.forwardCalls(), 1, "normal gap recovery still waits for the new acknowledgement");
    await act(async () => fixture.socket.push({
      type: "session_subscriptions_applied", revision: nextRevision,
      sessionIds: [fixture.sessionId, otherSessionId], podIds: [],
    }));
    await flushAsyncWork();
    assert.deepEqual(pages.forwardAfters, [24, 24], "the new acknowledgement recovers from the existing tail");
    await act(async () => pages.releaseForward({
      events: [{ id: 25, sessionId: fixture.sessionId, seq: 25, ts: 25,
        payload: { kind: "agent_message", text: "gap after fleet acknowledgement", final: true } }],
      eventEpoch: 0, nextAfter: 25, hasMoreCached: false, cacheComplete: true,
    }));
    await flushAsyncWork();
    assert.deepEqual(fixture.readLoadedEvents()?.map((event) => event.id),
      [...fixture.events.map((event) => event.id), 25], "acknowledged gap recovery preserves the loaded conversation");
    await act(async () => fixture.setConnection("connecting"));
    await flushAsyncWork();
    assert.equal(metadataCalls, 2, "a real connection loss re-enables independent REST metadata");
    assert.equal(pages.tailCalls.length, 2, "a missing reconnect acknowledgement can still use the bounded REST tail");
  } finally { await unmountFixture(fixture); }
});


test("fleet acknowledgement churn cannot strand an unfinished opening but skips a complete empty window", async () => {
  const pages = pageController();
  let metadataCalls = 0;
  const fixture = await mountFixture(pages, 0, {
    acknowledgeSubscription: false,
    client: { session: async (id) => { metadataCalls++; return { session: session(id) }; } },
  });
  try {
    const firstRevision = fixture.socket.sent.filter((message) => message.type === "session_subscriptions").at(-1)?.revision;
    assert.ok(firstRevision != null);
    await act(async () => fixture.socket.push({
      type: "session_subscriptions_applied", revision: firstRevision, sessionIds: [fixture.sessionId], podIds: [],
    }));
    await flushAsyncWork();
    assert.equal(pages.tailCalls.length, 2, "the first acknowledgement starts ordinary opening recovery");
    const otherSessionId = `${fixture.sessionId}-busy-neighbor`;
    await act(async () => fixture.socket.push({
      type: "session_upsert", session: { ...session(otherSessionId), status: "running" },
    }));
    await flushAsyncWork();
    assert.equal(pages.tailCalls.length, 3,
      "an acknowledged but unfinished opening still has a bounded REST path when the next ack is missing");
    assert.equal(metadataCalls, 2);
    const empty = { events: [], eventEpoch: 0, hasMoreOlder: false, cacheComplete: true };
    await act(async () => pages.releaseTail(empty));
    await act(async () => pages.releaseTail(empty));
    await flushAsyncWork();
    assert.ok(fixture.container.querySelector(".transcript-skeleton"), "the two cancelled reads cannot finish the opening");
    await act(async () => pages.releaseTail(empty));
    await flushAsyncWork();
    assertNoDomNode(fixture.container.querySelector(".transcript-skeleton"), "provisional REST finishes without the fleet acknowledgement");
    const nextRevision = fixture.socket.sent.filter((message) => message.type === "session_subscriptions").at(-1)?.revision;
    assert.ok(nextRevision != null && nextRevision > firstRevision);
    await act(async () => fixture.socket.push({
      type: "session_subscriptions_applied", revision: nextRevision,
      sessionIds: [fixture.sessionId, otherSessionId], podIds: [],
    }));
    await flushAsyncWork();
    assert.equal(pages.tailCalls.length, 4, "ordinary acknowledgement rechecks the complete empty tail");
    await act(async () => pages.releaseTail(empty));
    await flushAsyncWork();
    await act(async () => fixture.socket.push({
      type: "session_upsert", session: { ...session(otherSessionId), status: "idle", updatedAt: 2 },
    }));
    await flushAsyncWork();
    const stoppedRevision = fixture.socket.sent.filter((message) => message.type === "session_subscriptions").at(-1)?.revision;
    assert.ok(stoppedRevision != null && stoppedRevision > nextRevision);
    assert.equal(metadataCalls, 2, "complete empty history also suppresses redundant provisional metadata");
    assert.equal(pages.tailCalls.length, 4, "a complete empty window does not need a fleet-triggered replacement");
    assertNoDomNode(fixture.container.querySelector(".transcript-skeleton"));
  } finally { await unmountFixture(fixture); }
});


test("a cancelled acknowledged gap still uses REST while its replacement acknowledgement is missing", async () => {
  const pages = pageController();
  const fixture = await mountFixture(pages, 12, { acknowledgeSubscription: false });
  try {
    await act(async () => pages.releaseTail({
      events: fixture.events, eventEpoch: 0, hasMoreOlder: false, cacheComplete: true,
    }));
    await flushAsyncWork();
    const revision = fixture.socket.sent.filter((message) => message.type === "session_subscriptions").at(-1)?.revision;
    assert.ok(revision != null);
    await act(async () => fixture.socket.push({
      type: "session_subscriptions_applied", revision, sessionIds: [fixture.sessionId], podIds: [],
    }));
    await flushAsyncWork();
    assert.equal(pages.forwardCalls(), 1, "ordinary acknowledged recovery has an unfinished gap");
    assert.equal(recoveryActive(fixture), true);
    await act(async () => fixture.socket.push({
      type: "session_upsert", session: { ...session(`${fixture.sessionId}-busy`), status: "running" },
    }));
    await flushAsyncWork();
    assert.equal(pages.tailCalls.length, 2,
      "previous completeness cannot suppress REST after a pending normal gap was cancelled");
    await act(async () => pages.releaseForward({
      events: [], eventEpoch: 0, nextAfter: 24, hasMoreCached: false, cacheComplete: true,
    }));
    await flushAsyncWork();
    assert.equal(recoveryActive(fixture), true, "the cancelled forward read cannot settle the active fallback");
    const latest: SessionEvent = { id: 25, sessionId: fixture.sessionId, seq: 25, ts: 25,
      payload: { kind: "agent_message", text: "recovered without the replacement acknowledgement", final: true } };
    await act(async () => pages.releaseTail({
      events: [...fixture.events, latest], eventEpoch: 0, hasMoreOlder: false, cacheComplete: true,
    }));
    await flushAsyncWork();
    assert.equal(recoveryActive(fixture), false, "REST settles the interrupted gap even when the new ack never arrives");
    assert.equal(fixture.readLoadedEvents()?.at(-1)?.id, 25);
  } finally { await unmountFixture(fixture); }
});

test("a failed acknowledged refresh can retry through REST while the next fleet acknowledgement is missing", async () => {
  const pages = pageController();
  const fixture = await mountFixture(pages, 12, { acknowledgeSubscription: false });
  try {
    await act(async () => pages.releaseTail({
      events: fixture.events, eventEpoch: 0, hasMoreOlder: false, cacheComplete: true,
    }));
    await flushAsyncWork();
    const revision = fixture.socket.sent.filter((message) => message.type === "session_subscriptions").at(-1)?.revision;
    assert.ok(revision != null);
    await act(async () => fixture.socket.push({
      type: "session_subscriptions_applied", revision, sessionIds: [fixture.sessionId], podIds: [],
    }));
    await flushAsyncWork();
    await act(async () => pages.releaseForward({
      events: [], eventEpoch: 7, nextAfter: 24, hasMoreCached: false, cacheComplete: true,
    }));
    await flushAsyncWork();
    assert.ok(fixture.container.querySelector(".transcript-history-notice[data-state='error']"));
    await act(async () => fixture.socket.push({
      type: "session_upsert", session: { ...session(`${fixture.sessionId}-busy`), status: "running" },
    }));
    await flushAsyncWork();
    assert.equal(pages.tailCalls.length, 2, "a failed refresh is not proof that the current window is settled");
    await act(async () => pages.rejectTail());
    await flushAsyncWork();
    const retry = fixture.container.querySelector<HTMLButtonElement>(
      ".transcript-history-notice[data-state='error'] .notice-actions button");
    assert.ok(retry, "REST failure keeps a manual retry available despite the missing ack");
    await act(async () => retry.click());
    await flushAsyncWork();
    assert.equal(pages.tailCalls.length, 3, "manual retry cannot be suppressed by an older complete window");
    await act(async () => pages.releaseTail({
      events: fixture.events, eventEpoch: 0, hasMoreOlder: false, cacheComplete: true,
    }));
    await flushAsyncWork();
    assertNoDomNode(fixture.container.querySelector(".transcript-history-notice[data-state='error']"));
    assert.equal(recoveryActive(fixture), false);
  } finally { await unmountFixture(fixture); }
});


test("a temporary API source change cannot reuse an older acknowledged opening when returning without an ack", async () => {
  const pages = pageController();
  const alternatePages = pageController();
  const fixture = await mountFixture(pages, 12, { acknowledgeSubscription: false });
  try {
    const originalClient = fixture.readApiClient();
    const response = { events: fixture.events, eventEpoch: 0, hasMoreOlder: false, cacheComplete: true };
    await act(async () => pages.releaseTail(response));
    await flushAsyncWork();
    const revision = fixture.socket.sent.filter((message) => message.type === "session_subscriptions").at(-1)?.revision;
    assert.ok(revision != null);
    await act(async () => fixture.socket.push({
      type: "session_subscriptions_applied", revision, sessionIds: [fixture.sessionId], podIds: [],
    }));
    await flushAsyncWork();
    await act(async () => pages.releaseForward({
      events: [], eventEpoch: 0, nextAfter: 24, hasMoreCached: false, cacheComplete: true,
    }));
    await flushAsyncWork();
    await act(async () => fixture.socket.push({
      type: "session_upsert", session: { ...session(`${fixture.sessionId}-busy`), status: "running" },
    }));
    await flushAsyncWork();
    assert.equal(pages.tailCalls.length, 1, "the settled source has no redundant fleet read");
    const alternateClient: ApiClient = { ...originalClient,
      getSessionEventPage: alternatePages.fetchPage,
      getSessionEventTailPage: alternatePages.fetchTailPage,
    };
    await fixture.setApiClient(alternateClient);
    assert.equal(alternatePages.tailCalls.length, 1, "a new API identity owns a fresh unacknowledged opening");
    await act(async () => alternatePages.releaseTail(response));
    await flushAsyncWork();
    await fixture.setApiClient(originalClient);
    assert.equal(pages.tailCalls.length, 2,
      "returning to the old API is a fresh opening, not an inherited acknowledgement from before the source switch");
    await act(async () => pages.releaseTail(response));
    await flushAsyncWork();
    assert.equal(recoveryActive(fixture), false);
  } finally { await unmountFixture(fixture); }
});


test("resuming a pause-skipped provisional tail settles history without an acknowledgement or metadata reread", async () => {
  const pages = pageController();
  let metadataCalls = 0;
  const fixture = await mountFixture(pages, 0, {
    acknowledgeSubscription: false,
    client: { session: async (id) => { metadataCalls++; return { session: session(id) }; } },
  });
  try {
    const oldWindow = cachedTranscriptEvents(fixture.sessionId, 12).map((event) => ({
      ...event, id: event.id + 1_000, seq: event.seq + 1_000,
    }));
    Object.defineProperties(fixture.scroller, {
      offsetHeight: { configurable: true, value: 500 },
      offsetWidth: { configurable: true, value: 800 },
      clientWidth: { configurable: true, value: 800 },
    });
    setScrollerMetrics(fixture.scroller, { clientHeight: 500, scrollHeight: 2_500, scrollTop: 900 });
    await act(async () => pages.releaseTail({
      events: oldWindow, eventEpoch: 0, hasMoreOlder: false, cacheComplete: true,
    }));
    await flushAsyncWork(30);
    await act(async () => fixture.setConnection("connecting"));
    await act(async () => fixture.setConnection("online"));
    // Connecting's read is cancelled by the next phase; keep the online read pending.
    await act(async () => pages.releaseTail({
      events: oldWindow, eventEpoch: 0, hasMoreOlder: false, cacheComplete: true,
    }));
    await flushAsyncWork();
    assert.ok(fixture.container.querySelector("[data-virtual-row]"), "the warm reader has a real visible anchor");
    assert.equal(pages.tailCalls.length, 3, "a fresh online tail is pending over the cached reader");
    await act(async () => fireDomEvent.wheel(fixture.scroller, { deltaY: -40 }));
    await scrollReader(fixture.scroller, 860, false);
    assert.equal(followState(fixture), "paused");
    const anchorTop = fixture.scroller.scrollTop;
    const currentMetadataCalls = metadataCalls;
    const freshWindow = oldWindow.map((event) => ({ ...event, id: event.id + 1_000, seq: event.seq + 1_000 }));
    await act(async () => pages.releaseTail({
      events: freshWindow, eventEpoch: 0, hasMoreOlder: true, cacheComplete: true,
    }));
    await flushAsyncWork();
    assert.deepEqual(fixture.readLoadedEvents()?.map((event) => event.id), oldWindow.map((event) => event.id));
    assert.equal(fixture.scroller.scrollTop, anchorTop);
    assert.equal(fixture.scroller.getAttribute("aria-busy"), "true", "the skipped read still needs recovery");
    await act(async () => {
      fixture.scroller.focus();
      fireDomEvent.keyDown(fixture.scroller, { key: "End" });
    });
    await flushAsyncWork();
    assert.equal(followState(fixture), "following");
    assert.equal(pages.tailCalls.length, 4, "resume alone retries the skipped bounded tail");
    assert.equal(metadataCalls, currentMetadataCalls, "resume does not restart metadata or its Starting timer");
    await act(async () => pages.releaseTail({
      events: freshWindow, eventEpoch: 0, hasMoreOlder: true, cacheComplete: true,
    }));
    await flushAsyncWork(30);
    assert.equal(fixture.readLoadedEvents()?.at(-1)?.seq, 2_024);
    assert.equal(fixture.scroller.getAttribute("aria-busy"), "false", "REST settles recovery while the acknowledgement remains withheld");
    assertNoDomNode(fixture.container.querySelector(".transcript-history-notice[data-state='error']"));
    assert.equal(pages.forwardCalls(), 0);
    assert.equal(pages.tailCalls.length, 4, "a completed resume cannot form a polling loop");
  } finally { await unmountFixture(fixture); }
});


async function measuredUnacknowledgedRefresh(strictMode = false) {
  const pages = pageController();
  let metadataCalls = 0;
  const fixture = await mountFixture(pages, 0, {
    acknowledgeSubscription: false, strictMode,
    client: { session: async (id) => { metadataCalls++; return { session: session(id) }; } },
  });
  const oldWindow = cachedTranscriptEvents(fixture.sessionId, 12).map((event) => ({
    ...event, id: event.id + 1_000, seq: event.seq + 1_000,
  }));
  const freshWindow = oldWindow.map((event) => ({ ...event, id: event.id + 1_000, seq: event.seq + 1_000 }));
  Object.defineProperties(fixture.scroller, {
    offsetHeight: { configurable: true, value: 500 },
    offsetWidth: { configurable: true, value: 800 },
    clientWidth: { configurable: true, value: 800 },
  });
  setScrollerMetrics(fixture.scroller, { clientHeight: 500, scrollHeight: 2_500, scrollTop: 900 });
  await act(async () => {
    for (let index = 0; index < pages.tailCalls.length; index++) pages.releaseTail({
      events: oldWindow, eventEpoch: 0, hasMoreOlder: false, cacheComplete: true,
    });
  });
  await flushAsyncWork(30);
  assert.ok(fixture.container.querySelector("[data-virtual-row]"));
  // A new API capture rechecks the same online warm reader without acknowledging its stream.
  await fixture.setApiClient({ ...fixture.readApiClient() });
  await flushAsyncWork();
  return { fixture, pages, oldWindow, freshWindow, metadataCalls: () => metadataCalls };
}

async function pauseMeasuredReader(fixture: Fixture) {
  await act(async () => fireDomEvent.wheel(fixture.scroller, { deltaY: -40 }));
  await scrollReader(fixture.scroller, 860, false);
  assert.equal(followState(fixture), "paused");
}

async function resumeMeasuredReader(fixture: Fixture) {
  await act(async () => {
    fixture.scroller.focus();
    fireDomEvent.keyDown(fixture.scroller, { key: "End" });
  });
  await flushAsyncWork();
  assert.equal(followState(fixture), "following");
}

test("quick and repeated provisional pause-resume transitions reuse one pending history read", async () => {
  const { fixture, pages, oldWindow, freshWindow, metadataCalls } = await measuredUnacknowledgedRefresh();
  try {
    const initialReads = pages.tailCalls.length;
    const initialMetadataCalls = metadataCalls();
    await pauseMeasuredReader(fixture);
    await resumeMeasuredReader(fixture);
    assert.equal(pages.tailCalls.length, initialReads, "resume before the response reuses the still-valid read");
    await pauseMeasuredReader(fixture);
    const anchorTop = fixture.scroller.scrollTop;
    await act(async () => pages.releaseTail({
      events: freshWindow, eventEpoch: 0, hasMoreOlder: true, cacheComplete: true,
    }));
    await flushAsyncWork();
    assert.equal(fixture.scroller.scrollTop, anchorTop);
    assert.deepEqual(fixture.readLoadedEvents()?.map((event) => event.id), oldWindow.map((event) => event.id));
    await resumeMeasuredReader(fixture);
    assert.equal(pages.tailCalls.length, initialReads + 1, "the skipped result gets one replacement");
    await pauseMeasuredReader(fixture);
    await resumeMeasuredReader(fixture);
    await resumeMeasuredReader(fixture);
    assert.equal(pages.tailCalls.length, initialReads + 1, "repeated resume cannot compete with the current replacement");
    await act(async () => pages.releaseTail({
      events: freshWindow, eventEpoch: 0, hasMoreOlder: true, cacheComplete: true,
    }));
    await flushAsyncWork(30);
    assert.equal(fixture.scroller.getAttribute("aria-busy"), "false");
    await pauseMeasuredReader(fixture);
    await resumeMeasuredReader(fixture);
    assert.equal(pages.tailCalls.length, initialReads + 1, "a settled read needs no later pause-resume refresh");
    assert.equal(metadataCalls(), initialMetadataCalls);
  } finally { await unmountFixture(fixture); }
});

test("a late resumed provisional response cannot replace acknowledged recovery", async () => {
  const { fixture, pages, oldWindow, freshWindow, metadataCalls } = await measuredUnacknowledgedRefresh();
  try {
    await pauseMeasuredReader(fixture);
    await act(async () => pages.releaseTail({
      events: freshWindow, eventEpoch: 0, hasMoreOlder: true, cacheComplete: true,
    }));
    await flushAsyncWork();
    await resumeMeasuredReader(fixture);
    const reads = pages.tailCalls.length;
    const metadata = metadataCalls();
    const revision = fixture.socket.sent.filter((message) => message.type === "session_subscriptions").at(-1)?.revision;
    assert.ok(revision != null);
    await act(async () => fixture.socket.push({
      type: "session_subscriptions_applied", revision, sessionIds: [fixture.sessionId], podIds: [],
    }));
    await flushAsyncWork();
    assert.deepEqual(pages.forwardAfters, [1_024]);
    await act(async () => pages.releaseTail({
      events: freshWindow, eventEpoch: 0, hasMoreOlder: true, cacheComplete: true,
    }));
    await flushAsyncWork();
    assert.deepEqual(fixture.readLoadedEvents()?.map((event) => event.id), oldWindow.map((event) => event.id),
      "the superseded provisional response cannot evict the acknowledged window");
    await act(async () => pages.releaseForward({
      events: [], eventEpoch: 0, nextAfter: 1_024, hasMoreCached: false, cacheComplete: true,
    }));
    await flushAsyncWork();
    assert.equal(fixture.scroller.getAttribute("aria-busy"), "false");
    assert.equal(pages.tailCalls.length, reads);
    assert.equal(metadataCalls(), metadata);
  } finally { await unmountFixture(fixture); }
});

test("StrictMode and a source switch revoke a resumed provisional owner without a retry loop", async () => {
  const { fixture, pages, oldWindow, freshWindow, metadataCalls } = await measuredUnacknowledgedRefresh(true);
  try {
    await pauseMeasuredReader(fixture);
    await act(async () => pages.releaseTail({
      events: freshWindow, eventEpoch: 0, hasMoreOlder: true, cacheComplete: true,
    }));
    await flushAsyncWork();
    const reads = pages.tailCalls.length;
    const metadata = metadataCalls();
    await resumeMeasuredReader(fixture);
    assert.equal(pages.tailCalls.length, reads + 1, "only the active StrictMode owner resumes history");
    assert.equal(metadataCalls(), metadata);
    const nextPages = pageController();
    await fixture.setApiClient({ ...fixture.readApiClient(),
      getSessionEventPage: nextPages.fetchPage,
      getSessionEventTailPage: nextPages.fetchTailPage,
    });
    assert.equal(nextPages.tailCalls.length, 1);
    await act(async () => pages.releaseTail({
      events: freshWindow, eventEpoch: 0, hasMoreOlder: true, cacheComplete: true,
    }));
    await flushAsyncWork();
    assert.deepEqual(fixture.readLoadedEvents()?.map((event) => event.id), oldWindow.map((event) => event.id));
    assert.equal(fixture.scroller.getAttribute("aria-busy"), "true");
    await act(async () => nextPages.releaseTail({
      events: oldWindow, eventEpoch: 0, nextAfter: 1_024, hasMoreCached: false, cacheComplete: true,
    }));
    await flushAsyncWork();
    assert.ok(fixture.container.querySelector(".transcript-history-notice[data-state='error']"),
      "the active source's unsupported backward read remains an honest retryable failure");
    await pauseMeasuredReader(fixture);
    await resumeMeasuredReader(fixture);
    assert.equal(nextPages.tailCalls.length, 1, "unsupported reads do not retry merely because following resumed");
    assert.equal(nextPages.forwardCalls(), 0, "the provisional owner never starts a legacy forward walk");
  } finally { await unmountFixture(fixture); }
});


test("resume between a provisional response fence and its continuation retries once without a false failure", async () => {
  const { fixture, pages, freshWindow, metadataCalls } = await measuredUnacknowledgedRefresh();
  try {
    const reads = pages.tailCalls.length;
    const metadata = metadataCalls();
    await pauseMeasuredReader(fixture);
    await act(async () => {
      pages.releaseTail({ events: freshWindow, eventEpoch: 0, hasMoreOlder: true, cacheComplete: true });
      // The recovery helper resumes first and fences the paused response. Resume following
      // before its caller's .then/finally continuations run.
      await Promise.resolve();
      fixture.scroller.focus();
      fireDomEvent.keyDown(fixture.scroller, { key: "End" });
    });
    await flushAsyncWork();
    assert.equal(followState(fixture), "following");
    assert.equal(pages.tailCalls.length, reads + 1);
    assertNoDomNode(fixture.container.querySelector(".transcript-history-notice[data-state='error']"),
      "the pause fence keeps its cancellation reason after the reader resumes");
    assert.equal(metadataCalls(), metadata);
    await act(async () => pages.releaseTail({
      events: freshWindow, eventEpoch: 0, hasMoreOlder: true, cacheComplete: true,
    }));
    await flushAsyncWork(30);
    assert.equal(fixture.scroller.getAttribute("aria-busy"), "false");
    assert.equal(pages.tailCalls.length, reads + 1);
  } finally { await unmountFixture(fixture); }
});


test("live activity after an empty opening can stage a bounded gap for a paused reader", async () => {
  const pages = pageController();
  const fixture = await mountFixture(pages, 0, { acknowledgeSubscription: false });
  try {
    Object.defineProperties(fixture.scroller, {
      offsetHeight: { configurable: true, value: 500 },
      offsetWidth: { configurable: true, value: 800 },
      clientWidth: { configurable: true, value: 800 },
    });
    setScrollerMetrics(fixture.scroller, { clientHeight: 500, scrollHeight: 2_500, scrollTop: 900 });
    await act(async () => pages.releaseTail({
      events: [], eventEpoch: 0, hasMoreOlder: false, cacheComplete: true,
    }));
    await flushAsyncWork();
    assert.equal(fixture.scroller.getAttribute("aria-busy"), "false", "the authoritative empty opening has settled");

    const liveRows = cachedTranscriptEvents(fixture.sessionId, 12);
    await act(async () => {
      for (const event of liveRows) fixture.socket.push({ type: "session_event", event });
    });
    await flushAsyncWork(30);
    assert.ok(fixture.container.querySelector("[data-virtual-row]"), "live rows provide a real measured reading anchor");
    await pauseMeasuredReader(fixture);
    const anchorTop = fixture.scroller.scrollTop;
    const anchorText = fixture.container.querySelector("[data-virtual-row]")?.textContent;
    assert.ok(anchorText);

    const revision = fixture.socket.sent.filter((message) => message.type === "session_subscriptions").at(-1)?.revision;
    assert.ok(revision != null);
    await act(async () => fixture.socket.push({
      type: "session_subscriptions_applied", revision, sessionIds: [fixture.sessionId], podIds: [],
    }));
    await flushAsyncWork();
    assert.deepEqual(pages.forwardAfters, [0], "the first acknowledgement retains its frozen opening cursor");
    const gapRows = cachedTranscriptEvents(fixture.sessionId, 400);
    for (let page = 0; page < 4; page++) {
      await act(async () => pages.releaseForward({
        events: gapRows.slice(page * 200, (page + 1) * 200), eventEpoch: 0,
        nextAfter: (page + 1) * 200, hasMoreCached: true, cacheComplete: true,
      }));
      await flushAsyncWork();
    }
    assert.deepEqual(pages.forwardAfters, [0, 200, 400, 600], "gap recovery stops after four forward pages");
    assert.equal(pages.tailCalls.length, 2, "the oversized gap uses one supported tail read");
    const laterRows = liveRows.map((event) => ({ ...event, id: event.id + 10_000, seq: event.seq + 10_000 }));
    await act(async () => pages.releaseTail({
      events: laterRows, eventEpoch: 0, hasMoreOlder: true, cacheComplete: true, turnAligned: true,
    }));
    await flushAsyncWork(30);
    assertNoDomNode(fixture.container.querySelector(".transcript-history-notice[data-state='error']"),
      "the empty opening's populated reader accepts its valid paused recovery owner");
    assert.ok(fixture.container.querySelector("[data-later-activity-gap='available']"),
      "the bounded tail is staged as later activity rather than discarded");
    assert.equal(fixture.scroller.getAttribute("aria-busy"), "false");
    assert.equal(followState(fixture), "paused");
    assert.equal(fixture.scroller.scrollTop, anchorTop, "the paused reader retains its pixel offset");
    assert.ok(fixture.container.textContent?.includes(anchorText), "the anchored live row remains rendered");
    assert.deepEqual(fixture.readLoadedEvents()?.map((event) => event.seq), gapRows.map((event) => event.seq),
      "the deferred disjoint tail cannot replace the paused rows");
    assert.equal(pages.forwardCalls(), 4, "staging cannot begin an unbounded forward walk");
  } finally { await unmountFixture(fixture); }
});
