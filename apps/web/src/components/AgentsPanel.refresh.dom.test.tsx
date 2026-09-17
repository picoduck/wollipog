import assert from "node:assert/strict";
import { after, before, test } from "node:test";
import React, { act } from "react";
import { createRoot } from "react-dom/client";
import { Window } from "happy-dom";
import { PROTOCOL_VERSION, type ChildSessionRegistryPage, type SessionView } from "@wollipog/protocol";
import { api, type ApiClient } from "../api.js";
import { ApiProvider } from "../api-context.js";
import { StoreProvider } from "../store.js";
import { FeedbackProvider } from "./FeedbackProvider.js";
import { UI_SOCKET_OPEN, type UiConnectionRuntime } from "../ui-transport.js";
import type { TimelineItem } from "../timeline.js";
import { installDomTestCleanup } from "../dom-test-cleanup.js";
import { AgentsPanel } from "./AgentsPanel.js";

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
