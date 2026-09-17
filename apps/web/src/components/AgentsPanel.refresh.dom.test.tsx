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
