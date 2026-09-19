import assert from "node:assert/strict";
import { after, before, test } from "node:test";
import React, { act } from "react";
import { createRoot } from "react-dom/client";
import { Window } from "happy-dom";
import { PROTOCOL_VERSION, type ChildSessionRegistryEntry, type ChildSessionRegistryPage,
  type SessionEventPayload, type SessionView } from "@wollipog/protocol";
import { api, type ApiClient } from "../api.js";
import { ApiProvider } from "../api-context.js";
import { StoreProvider } from "../store.js";
import { FeedbackProvider } from "./FeedbackProvider.js";
import { UI_SOCKET_OPEN, type UiConnectionRuntime } from "../ui-transport.js";
import { TimelineBuilder, type TimelineItem } from "../timeline.js";
import { installDomTestCleanup } from "../dom-test-cleanup.js";
import { AgentsPanel, REGISTRY_SWEEP_EVERY_IDLE_REFRESHES } from "./AgentsPanel.js";

const domWindow = new Window({ url: "http://localhost/" });
const globals: Record<string, unknown> = {
  window: domWindow,
  document: domWindow.document,
  navigator: domWindow.navigator,
  localStorage: domWindow.localStorage,
  HTMLElement: domWindow.HTMLElement,
  ResizeObserver: domWindow.ResizeObserver,
  React,
  IS_REACT_ACT_ENVIRONMENT: true,
};
const prior = Object.fromEntries(
  Object.keys(globals).map((name) => [name, (globalThis as Record<string, unknown>)[name]]),
);

before(() => {
  for (const [name, value] of Object.entries(globals)) {
    Object.defineProperty(globalThis, name, { configurable: true, writable: true, value });
  }
});

after(() => {
  for (const [name, value] of Object.entries(prior)) {
    Object.defineProperty(globalThis, name, { configurable: true, writable: true, value });
  }
  domWindow.close();
});

// Both the panel's refresh timer and the store's stall clock re-arm themselves; without this an
// assertion throwing before `root.unmount()` leaves them running and the failure reads as a hang (#690).
installDomTestCleanup(domWindow);

const connection: UiConnectionRuntime = {
  instanceId: "registry-cadence", runtimeKey: "registry-cadence",
  createSocket: () => ({ readyState: UI_SOCKET_OPEN, onopen: null, onmessage: null,
    onclose: null, onerror: null, send() {}, close() {} }), close() {},
};

const now = Date.now();
const baseSession = {
  id: "orchestrator", runnerId: "runner", workspaceId: null, agentId: null,
  title: "Orchestrator", status: "running", runId: null, archived: false,
  createdAt: now - 60_000, updatedAt: now, lastEventAt: now, messageCount: 10,
  eventEpoch: 0, pendingApproval: null,
} as unknown as SessionView;

const startedTool = (toolCallId: string, id: number): TimelineItem => ({
  kind: "tool_call", id, toolCallId, title: toolCallId, text: "",
  toolKind: "agent", status: "in_progress", startedAt: now - 30_000,
});

/** The same agent row once its tool call has settled: the roster fingerprint moves, nothing else. */
const settledTool = (toolCallId: string, id: number): TimelineItem => ({
  kind: "tool_call", id, toolCallId, title: toolCallId, text: "",
  toolKind: "agent", status: "completed", startedAt: now - 30_000,
});

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
/** React flushes effects when `act` exits, so scheduled timers need their own settled window. */
const advance = (ms: number) => act(async () => { await sleep(ms); });

/**
 * #1207: a streaming turn bumps `lastEventAt`/`messageCount` on every transcript event, which used
 * to re-fetch every loaded registry page about once a second for the whole turn. Requests are the
 * assertion here — the roster never changes during the burst, so the only permitted traffic is the
 * one initial page load.
 */
test("a burst of transcript events with an unchanged roster costs no extra registry requests", async () => {
  let calls = 0;
  const childSessions = async (): Promise<ChildSessionRegistryPage> => {
    calls += 1;
    return {
      children: [{ toolCallId: "child-a", name: "Child A", status: "running", lifecycle: "running",
        sourceSeq: 1, startedAt: now - 30_000, lastActivityAt: now, toolCount: 2 }],
      attentionOwners: [], unidentifiedChildren: 0, eventEpoch: 0, nextAfter: null, truncated: false,
    };
  };
  const client: ApiClient = { ...api, childSessions };
  const happyContainer = domWindow.document.createElement("div");
  domWindow.document.body.append(happyContainer);
  const container = happyContainer as unknown as HTMLDivElement;
  const root = createRoot(container);
  const render = (session: SessionView, items: TimelineItem[]) =>
    root.render(<ApiProvider client={client}><FeedbackProvider><StoreProvider connection={connection}>
      <AgentsPanel session={session} items={items} runnerOnline runnerProtocolVersion={PROTOCOL_VERSION}
        requestedId={null} onSelect={() => {}} parentTurnEventIds={new Map()} onOpenParentTurn={() => {}} />
    </StoreProvider></FeedbackProvider></ApiProvider>);

  try {
    const items = [startedTool("child-a", 1)];
    await act(async () => { render(baseSession, items); });
    await advance(50);
    assert.equal(calls, 1, "the panel loads the registry once when it opens");

    // Twelve events over 1.2 s — longer than the old one-second refresh floor, so the pre-fix panel
    // fetched at least once more here.
    for (let tick = 1; tick <= 12; tick += 1) {
      await act(async () => { render({ ...baseSession, messageCount: 10 + tick, lastEventAt: now + tick * 100 }, items); });
      await advance(100);
    }
    assert.equal(calls, 1, "unrelated transcript progress does not re-read the child registry");

    // A new subagent tool call is roster-affecting evidence and must refresh promptly.
    const withNewChild = [...items, startedTool("child-b", 2)];
    await act(async () => { render({ ...baseSession, messageCount: 30, lastEventAt: now + 2_000 }, withNewChild); });
    await advance(150);
    assert.equal(calls, 2, "a new subagent tool call refreshes the registry promptly");
  } finally {
    await act(async () => { root.unmount(); });
    container.remove();
  }
});

/**
 * A "Load More" page load or an inventory retry starts its own request without re-running the
 * refresh effect, so it moves the refresh deadline under an already-armed timer. Firing at the old
 * deadline would both break the cadence and hand `registryRequest` to the refresh while the page
 * load is still in flight, silently discarding the page the reader asked for. Exercised on the 1 s
 * roster tier, which is the same code path as the 15 s idle tier.
 */
test("a page load started under an armed timer moves the deadline instead of losing its request", async () => {
  const calls: Array<{ after: number; kind: "load" | "refresh" }> = [];
  let served = 0;
  const childSessions = async (_id: string, _epoch: number, after = 0): Promise<ChildSessionRegistryPage> => {
    served += 1;
    const slow = served === 2;
    calls.push({ after, kind: after === 0 ? "refresh" : "load" });
    if (slow) await sleep(400);
    return {
      children: [{ toolCallId: after === 0 ? "child-a" : "child-b",
        name: after === 0 ? "Recorded First" : "Recorded Second", status: "running",
        lifecycle: "running", sourceSeq: after === 0 ? 1 : 2, startedAt: now - 30_000,
        lastActivityAt: now, toolCount: 1 }],
      attentionOwners: [], unidentifiedChildren: 0, eventEpoch: 0,
      nextAfter: after === 0 ? 1 : null, truncated: after === 0,
    };
  };
  const client: ApiClient = { ...api, childSessions };
  const happyContainer = domWindow.document.createElement("div");
  domWindow.document.body.append(happyContainer);
  const container = happyContainer as unknown as HTMLDivElement;
  const root = createRoot(container);
  const render = (session: SessionView, items: TimelineItem[]) =>
    root.render(<ApiProvider client={client}><FeedbackProvider><StoreProvider connection={connection}>
      <AgentsPanel session={session} items={items} runnerOnline runnerProtocolVersion={PROTOCOL_VERSION}
        requestedId={null} onSelect={() => {}} parentTurnEventIds={new Map()} onOpenParentTurn={() => {}} />
    </StoreProvider></FeedbackProvider></ApiProvider>);

  try {
    const items = [startedTool("child-a", 1)];
    await act(async () => { render(baseSession, items); });
    await advance(50);

    // Roster evidence arms the 1 s timer.
    await act(async () => { render({ ...baseSession, messageCount: 11 }, [...items, startedTool("child-b", 2)]); });
    await advance(800);
    assert.equal(calls.length, 1, "the roster refresh is still waiting on its 1 s floor");

    // "Load More" starts its own request 0.8 s in, resetting the deadline to 1.8 s.
    const loadMore = Array.from(container.querySelectorAll("button"))
      .find((button) => button.textContent === "Load More Recorded Workers")!;
    await act(async () => { (loadMore as HTMLButtonElement).click(); });
    await advance(500);
    assert.deepEqual(calls, [{ after: 0, kind: "refresh" }, { after: 1, kind: "load" }],
      "the armed timer re-armed rather than firing at its original deadline and stealing the request slot");
    assert.match(container.textContent ?? "", /Recorded Second/, "the page the reader asked for was applied");
  } finally {
    await act(async () => { root.unmount(); });
    container.remove();
  }
});

/**
 * #1289: when a provider re-emits an identical full tool-call observation, `TimelineBuilder` folds
 * that statement into the row it already holds, so the status, lifecycle, title and parent the
 * roster fingerprint reads all stay equal — while the control plane, now holding a third
 * observation, stops identifying the child at all. The warning used to wait for the 15 s idle
 * cadence.
 *
 * Both acceptance criteria are asserted here in one run, because they constrain each other: the
 * obvious signal for the first (the agent row's `lastActivityAt`) moves on every child event, so
 * satisfying it that way would have made the burst below cost one request per second — the exact
 * traffic #1207 removed. `calls` is therefore the assertion on both sides of the re-statement.
 */
test("a folded re-statement refreshes promptly without restoring per-event registry traffic", async () => {
  let ambiguous = false;
  let calls = 0;
  const childSessions = async (): Promise<ChildSessionRegistryPage> => {
    calls += 1;
    return {
      children: ambiguous ? [] : [{ toolCallId: "child-a", name: "Child A", status: "running",
        lifecycle: "running", sourceSeq: 1, startedAt: now - 30_000, lastActivityAt: now, toolCount: 2 }],
      attentionOwners: [], unidentifiedChildren: ambiguous ? 1 : 0, eventEpoch: 0,
      nextAfter: null, truncated: false,
    };
  };
  const client: ApiClient = { ...api, childSessions };
  const happyContainer = domWindow.document.createElement("div");
  domWindow.document.body.append(happyContainer);
  const container = happyContainer as unknown as HTMLDivElement;
  const root = createRoot(container);
  const render = (session: SessionView, items: TimelineItem[]) =>
    root.render(<ApiProvider client={client}><FeedbackProvider><StoreProvider connection={connection}>
      <AgentsPanel session={session} items={items} runnerOnline runnerProtocolVersion={PROTOCOL_VERSION}
        requestedId={null} onSelect={() => {}} parentTurnEventIds={new Map()} onOpenParentTurn={() => {}} />
    </StoreProvider></FeedbackProvider></ApiProvider>);

  // Real events through the real fold: hand-authored items could not show that a re-statement
  // leaves the row otherwise identical, which is the whole defect.
  const builder = new TimelineBuilder();
  let seq = 0;
  const push = (payload: SessionEventPayload) => {
    seq += 1;
    builder.push({ id: seq, sessionId: baseSession.id, seq, ts: now + seq * 10, payload });
  };
  const spawn = { kind: "tool_call", toolCallId: "child-a", title: "child-a",
    toolKind: "agent", status: "in_progress" } as const;

  try {
    // Claude's partial stream and its full assistant record: two compatible observations of one
    // spawn, which the control plane still collapses into a single identity.
    push({ ...spawn, status: "pending" });
    push(spawn);
    await act(async () => { render(baseSession, builder.snapshot()); });
    await advance(50);
    assert.equal(calls, 1, "the panel loads the registry once when it opens");

    // A streaming turn under that child: text chunks, its own tool rows, and rollups. Each one
    // bumps the agent row's activity and tool count, and none of it moves the roster.
    for (let tick = 1; tick <= 12; tick += 1) {
      push({ kind: "agent_message", text: `chunk ${tick}`, parentToolUseId: "child-a" });
      push({ kind: "tool_call", toolCallId: `read-${tick}`, title: "Read", toolKind: "read",
        status: "completed", parentToolUseId: "child-a" });
      push({ kind: "token_usage", parentToolUseId: "child-a", inputTokens: tick, outputTokens: tick });
      await act(async () => {
        render({ ...baseSession, messageCount: 10 + tick, lastEventAt: now + tick * 100 }, builder.snapshot());
      });
      await advance(100);
    }
    assert.equal(calls, 1, "a streaming turn that leaves the roster alone still costs no refresh");

    // The provider re-states the identical full observation. The fold leaves the row's status,
    // lifecycle, title and parent exactly as they were; the control plane now holds a third
    // observation and can no longer identify the child.
    ambiguous = true;
    push(spawn);
    await act(async () => {
      render({ ...baseSession, messageCount: 23, lastEventAt: now + 1_300 }, builder.snapshot());
    });
    await advance(150);
    assert.equal(calls, 2, "a folded re-statement refreshes the roster on the 1 s tier, not the 15 s one");
    assert.match(container.textContent ?? "", /1 worker has an ambiguous provider identity/,
      "the reclassification the re-statement caused is visible without waiting for the idle cadence");
  } finally {
    await act(async () => { root.unmount(); });
    container.remove();
  }
});

/**
 * #1290: #1207 reduced how often the panel refreshed its registry but not how much each refresh
 * read — `refreshRegistry` looped `ceil(registry.length / PAGE_SIZE)` pages, so one child's change
 * against a five-page registry cost five requests. Cursors are the assertion here: a refresh reads
 * the page holding the child that moved and the tail page a new spawn would land on, and leaves the
 * pages with no evidence behind them alone.
 */
test("a single child's change costs two requests against a five-page registry, not five", async () => {
  const registrySize = 250;
  const entry = (index: number): ChildSessionRegistryEntry => ({
    toolCallId: `child-${index}`, name: `Child ${index}`,
    status: index === 1 ? "in_progress" : "completed",
    lifecycle: index === 1 ? "running" : "completed",
    sourceSeq: index, startedAt: now - 30_000, lastActivityAt: now - 20_000,
    // The control plane stamps `completedAt` exactly when it judges a child terminal, which is what
    // lets a refresh skip a page of settled children.
    ...(index === 1 ? {} : { completedAt: now - 20_000 }),
    toolCount: 1,
  });
  const all = Array.from({ length: registrySize }, (_value, index) => entry(index + 1));
  const cursors: number[] = [];
  const childSessions = async (
    _id: string, _epoch: number, after = 0, limit = 50,
  ): Promise<ChildSessionRegistryPage> => {
    cursors.push(after);
    const eligible = all.filter((child) => child.sourceSeq > after);
    const children = eligible.slice(0, limit);
    const truncated = eligible.length > children.length;
    return { children, attentionOwners: [], unidentifiedChildren: 0, eventEpoch: 0,
      nextAfter: truncated ? children.at(-1)!.sourceSeq : null, truncated };
  };
  const client: ApiClient = { ...api, childSessions };
  const happyContainer = domWindow.document.createElement("div");
  domWindow.document.body.append(happyContainer);
  const container = happyContainer as unknown as HTMLDivElement;
  const root = createRoot(container);
  const render = (session: SessionView, items: TimelineItem[]) =>
    root.render(<ApiProvider client={client}><FeedbackProvider><StoreProvider connection={connection}>
      <AgentsPanel session={session} items={items} runnerOnline runnerProtocolVersion={PROTOCOL_VERSION}
        requestedId={null} onSelect={() => {}} parentTurnEventIds={new Map()} onOpenParentTurn={() => {}} />
    </StoreProvider></FeedbackProvider></ApiProvider>);

  try {
    // `child-1` is the one child still running, and its row is loaded, so the transcript already
    // renders its live state and no idle sweep needs its page.
    const items = [startedTool("child-1", 1)];
    await act(async () => { render(baseSession, items); });
    await advance(50);

    // Read the whole registry in, the way a reader does: five pages, four of them behind Load More.
    for (let page = 1; page < 5; page += 1) {
      const loadMore = Array.from(container.querySelectorAll("button"))
        .find((button) => button.textContent === "Load More Recorded Workers")!;
      await act(async () => { (loadMore as HTMLButtonElement).click(); });
      await advance(60);
    }
    assert.deepEqual(cursors, [0, 50, 100, 150, 200], "the reader loaded all five pages");

    // That child completes. Its evidence is on the first page, so that page and the tail are the
    // only ones with anything to say; the pre-fix refresh read all five.
    await act(async () => {
      render({ ...baseSession, messageCount: 11, lastEventAt: now + 1_000 },
        [settledTool("child-1", 1)]);
    });
    await advance(1_200);
    assert.deepEqual(cursors.slice(5), [0, 200],
      "one child's change reads its own page and the tail, never every loaded page");

    // A different child, five pages in, moves the roster. The request follows it rather than
    // restarting at the front, and the settled pages on either side stay unread.
    await act(async () => {
      render({ ...baseSession, messageCount: 12, lastEventAt: now + 2_000 },
        [settledTool("child-1", 1), startedTool("child-120", 2)]);
    });
    await advance(1_200);
    assert.deepEqual(cursors.slice(7), [100, 200],
      "the refresh reads the page holding the child that moved, not the pages that did not");
    assert.ok(cursors.every((cursor) => cursor !== 50 || cursors.indexOf(cursor) < 5),
      "no page was re-read without evidence behind it");
  } finally {
    await act(async () => { root.unmount(); });
    container.remove();
  }
});

/**
 * The evidence a refresh is chasing is spent only when the pages come back. A refresh that rejects
 * merges nothing, so banking its fingerprints at scheduling time would retire the change with it:
 * the page holding the child would never be selected again, and the panel would keep showing what
 * it failed to re-read. Before #1290 this healed by accident, because the next refresh re-read
 * every page regardless.
 */
test("a rejected refresh leaves its evidence unspent, so the next one still reads that page", async () => {
  const settled = (index: number): ChildSessionRegistryEntry => ({
    toolCallId: `child-${index}`, name: `Child ${index}`,
    status: index === 1 ? "in_progress" : "completed",
    lifecycle: index === 1 ? "running" : "completed",
    sourceSeq: index, startedAt: now - 30_000, lastActivityAt: now - 20_000,
    ...(index === 1 ? {} : { completedAt: now - 20_000 }),
    toolCount: 1,
  });
  const all = Array.from({ length: 150 }, (_value, index) => settled(index + 1));
  const cursors: number[] = [];
  let rejectNext = false;
  const childSessions = async (
    _id: string, _epoch: number, after = 0, limit = 50,
  ): Promise<ChildSessionRegistryPage> => {
    cursors.push(after);
    if (rejectNext) { rejectNext = false; throw new Error("registry unavailable"); }
    const eligible = all.filter((child) => child.sourceSeq > after);
    const children = eligible.slice(0, limit);
    const truncated = eligible.length > children.length;
    return { children, attentionOwners: [], unidentifiedChildren: 0, eventEpoch: 0,
      nextAfter: truncated ? children.at(-1)!.sourceSeq : null, truncated };
  };
  const client: ApiClient = { ...api, childSessions };
  const happyContainer = domWindow.document.createElement("div");
  domWindow.document.body.append(happyContainer);
  const container = happyContainer as unknown as HTMLDivElement;
  const root = createRoot(container);
  const render = (session: SessionView, items: TimelineItem[]) =>
    root.render(<ApiProvider client={client}><FeedbackProvider><StoreProvider connection={connection}>
      <AgentsPanel session={session} items={items} runnerOnline runnerProtocolVersion={PROTOCOL_VERSION}
        requestedId={null} onSelect={() => {}} parentTurnEventIds={new Map()} onOpenParentTurn={() => {}} />
    </StoreProvider></FeedbackProvider></ApiProvider>);

  try {
    await act(async () => { render(baseSession, [startedTool("child-1", 1)]); });
    await advance(50);
    for (let page = 1; page < 3; page += 1) {
      const loadMore = Array.from(container.querySelectorAll("button"))
        .find((button) => button.textContent === "Load More Recorded Workers")!;
      await act(async () => { (loadMore as HTMLButtonElement).click(); });
      await advance(60);
    }
    assert.deepEqual(cursors, [0, 50, 100], "three pages loaded");

    // `child-1` settles, on the first page, and the refresh that goes to fetch it rejects.
    rejectNext = true;
    await act(async () => {
      render({ ...baseSession, messageCount: 11, lastEventAt: now + 1_000 }, [settledTool("child-1", 1)]);
    });
    await advance(1_200);
    assert.deepEqual(cursors.slice(3), [0], "the refresh reached for the first page and failed");

    // A later change to a child on the tail page. Its own evidence points only at the tail, so the
    // first page is requested again solely because the failed refresh never banked what it chased.
    await act(async () => {
      render({ ...baseSession, messageCount: 12, lastEventAt: now + 2_000 },
        [settledTool("child-1", 1), startedTool("child-140", 2)]);
    });
    await advance(1_200);
    assert.deepEqual(cursors.slice(4), [0, 100],
      "the unspent first-page evidence is retried alongside the tail page the new change points at");
  } finally {
    await act(async () => { root.unmount(); });
    container.remove();
  }
});

/**
 * The backstop is a count of idle-cadence refreshes, not a timer: every
 * `REGISTRY_SWEEP_EVERY_IDLE_REFRESHES`th idle refresh reads every loaded page, whatever the skip
 * rules say, so a predicate that is ever wrong costs bounded staleness. Active-tier refreshes are
 * roster changes, and neither count toward it nor sweep — the Nth of those stays targeted.
 *
 * Only the wall clock the panel reads is advanced, a cadence floor at a time, so each refresh falls
 * due immediately while timers keep running in real time.
 */
test("the Nth idle refresh sweeps every loaded page, and the Nth active refresh does not", async () => {
  const entry = (index: number): ChildSessionRegistryEntry => ({
    toolCallId: `child-${index}`, name: `Child ${index}`,
    status: index === 1 ? "in_progress" : "completed",
    lifecycle: index === 1 ? "running" : "completed",
    sourceSeq: index, startedAt: now - 30_000, lastActivityAt: now - 20_000,
    ...(index === 1 ? {} : { completedAt: now - 20_000 }),
    toolCount: 1,
  });
  const all = Array.from({ length: 150 }, (_value, index) => entry(index + 1));
  const cursors: number[] = [];
  const childSessions = async (
    _id: string, _epoch: number, after = 0, limit = 50,
  ): Promise<ChildSessionRegistryPage> => {
    cursors.push(after);
    const eligible = all.filter((child) => child.sourceSeq > after);
    const children = eligible.slice(0, limit);
    const truncated = eligible.length > children.length;
    return { children, attentionOwners: [], unidentifiedChildren: 0, eventEpoch: 0,
      nextAfter: truncated ? children.at(-1)!.sourceSeq : null, truncated };
  };
  const client: ApiClient = { ...api, childSessions };
  const happyContainer = domWindow.document.createElement("div");
  domWindow.document.body.append(happyContainer);
  const container = happyContainer as unknown as HTMLDivElement;
  const root = createRoot(container);
  const render = (session: SessionView, items: TimelineItem[]) =>
    root.render(<ApiProvider client={client}><FeedbackProvider><StoreProvider connection={connection}>
      <AgentsPanel session={session} items={items} runnerOnline runnerProtocolVersion={PROTOCOL_VERSION}
        requestedId={null} onSelect={() => {}} parentTurnEventIds={new Map()} onOpenParentTurn={() => {}} />
    </StoreProvider></FeedbackProvider></ApiProvider>);
  const realNow = Date.now;
  let skew = 0;
  Date.now = () => realNow() + skew;
  let messageCount = 10;

  try {
    await act(async () => { render(baseSession, [startedTool("child-1", 1)]); });
    await advance(50);
    for (let page = 1; page < 3; page += 1) {
      const loadMore = Array.from(container.querySelectorAll("button"))
        .find((button) => button.textContent === "Load More Recorded Workers")!;
      await act(async () => { (loadMore as HTMLButtonElement).click(); });
      await advance(60);
    }
    assert.deepEqual(cursors, [0, 50, 100], "three pages loaded");

    // Active tier: N roster changes in a row — `child-1` flips between running and settled. Each
    // reads its own page and the tail; none sweeps, and none counts toward the backstop.
    for (let step = 1; step <= REGISTRY_SWEEP_EVERY_IDLE_REFRESHES; step += 1) {
      skew += 1_000;
      messageCount += 1;
      const row = step % 2 === 1 ? settledTool("child-1", 1) : startedTool("child-1", 1);
      await act(async () => { render({ ...baseSession, messageCount, lastEventAt: now + messageCount }, [row]); });
      await advance(150);
    }
    // The row as the last active step left it, so the idle steps below leave the roster alone.
    const lastRow = REGISTRY_SWEEP_EVERY_IDLE_REFRESHES % 2 === 1 ? settledTool("child-1", 1) : startedTool("child-1", 1);
    assert.deepEqual(cursors.slice(3), Array.from({ length: REGISTRY_SWEEP_EVERY_IDLE_REFRESHES }, () => [0, 100]).flat(),
      "the Nth active refresh is as targeted as the first");

    // Idle tier: transcript progress with the roster unchanged. The first N - 1 read only the tail;
    // the Nth sweeps every loaded page from the control plane's own cursors.
    const beforeIdle = cursors.length;
    for (let step = 1; step <= REGISTRY_SWEEP_EVERY_IDLE_REFRESHES; step += 1) {
      skew += 15_000;
      messageCount += 1;
      await act(async () => { render({ ...baseSession, messageCount, lastEventAt: now + messageCount }, [lastRow]); });
      await advance(150);
    }
    assert.deepEqual(cursors.slice(beforeIdle), [
      ...Array.from({ length: REGISTRY_SWEEP_EVERY_IDLE_REFRESHES - 1 }, () => 100),
      0, 50, 100,
    ], "idle refreshes read the tail until the Nth, which reads every loaded page");
  } finally {
    Date.now = realNow;
    await act(async () => { root.unmount(); });
    container.remove();
  }
});
