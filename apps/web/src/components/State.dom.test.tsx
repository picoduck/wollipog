import assert from "node:assert/strict";
import test from "node:test";
import React, { act } from "react";
import { createRoot } from "react-dom/client";
import { Window } from "happy-dom";
import type { RunnerView, SessionView, UiSnapshotMessage } from "@wollipog/protocol";
import type { ViewNavigation } from "../navigation.js";
import { StoreProvider, useStoreSelector } from "../store.js";
import { UI_SOCKET_OPEN, type UiConnectionRuntime, type UiSocket } from "../ui-transport.js";
import { installDomTestCleanup } from "../dom-test-cleanup.js";
import { Board } from "./Board.js";
import { State, stateVariant } from "./State.js";

/**
 * docs/design-system.md §12: offline, loading, error, empty and no results are mutually exclusive in
 * that order, so a list never claims to be empty while it is still loading or disconnected.
 */

const domWindow = new Window({ url: "http://localhost/" });
installDomTestCleanup(domWindow);
for (const [name, value] of Object.entries({
  window: domWindow,
  document: domWindow.document,
  navigator: domWindow.navigator,
  localStorage: domWindow.localStorage,
  HTMLElement: domWindow.HTMLElement,
  Node: domWindow.Node,
  Event: domWindow.Event,
  React,
  IS_REACT_ACT_ENVIRONMENT: true,
  ResizeObserver: class { observe() {} unobserve() {} disconnect() {} },
})) Object.defineProperty(globalThis, name, { configurable: true, writable: true, value });

test("the state priority is offline, loading, error, empty, then no results", () => {
  assert.equal(stateVariant({ offline: true, loading: true, error: true, empty: true, noResults: true }), "offline");
  assert.equal(stateVariant({ loading: true, error: true, empty: true }), "loading");
  assert.equal(stateVariant({ error: true, empty: true, noResults: true }), "error");
  assert.equal(stateVariant({ empty: true, noResults: true }), "empty");
  assert.equal(stateVariant({ noResults: true }), "no-results");
  assert.equal(stateVariant({}), null);
});

test("an empty state is top-left, carries its next step, and has no card or success glyph", async () => {
  const container = domWindow.document.createElement("div") as unknown as HTMLDivElement;
  domWindow.document.body.append(container as never);
  const root = createRoot(container);
  try {
    await act(async () => root.render(
      <State title="No Skills Yet" headingLevel={3} actions={<button type="button">New Skill</button>}>
        Skills teach an agent a repeatable task.
      </State>,
    ));
    const state = container.querySelector(".state")!;
    assert.equal(state.querySelector("h3.state-title")?.textContent, "No Skills Yet");
    assert.equal(state.querySelector(".state-body")?.textContent, "Skills teach an agent a repeatable task.");
    assert.equal(state.querySelector(".actions button")?.textContent, "New Skill");
    assert.doesNotMatch(state.textContent ?? "", /✓/);

    await act(async () => root.render(<State variant="error" title="Couldn't Load Skills">The request failed.</State>));
    const error = container.querySelector(".notice.t-danger[role=\"alert\"]");
    assert.ok(error, "an error state is a danger notice in the content's place (§12.4)");
    assert.equal(container.querySelector(".state"), null);
  } finally {
    await act(async () => root.unmount());
    container.remove();
  }
});

class FakeSocket implements UiSocket {
  readonly readyState = UI_SOCKET_OPEN;
  onopen: (() => void) | null = null;
  onmessage: ((event: { data: string }) => void) | null = null;
  onclose: ((event: { code: number }) => void) | null = null;
  onerror: (() => void) | null = null;
  send() {}
  close() {}
  push(message: UiSnapshotMessage) { this.onmessage?.({ data: JSON.stringify(message) }); }
  drop() { this.onclose?.({ code: 1006 }); }
}

const navigation: ViewNavigation = { current: () => ({ name: "inbox" }), push() {}, listen: () => () => {} };
const runner = { runnerId: "runner-1", hostname: "host", os: "linux", version: "1", status: "online", agents: [], workspaces: [],
  connectedAt: 1, lastSeen: 1, protocolVersion: 63 } as unknown as RunnerView;
const emptySnapshot = {
  type: "snapshot",
  capabilities: { sessionSubscriptions: false, boundedDelivery: false, paginatedSessionHistory: false, projects: true },
  runners: [runner], boxes: [], projects: [], sessions: [] as SessionView[], runs: [], pods: [],
} as unknown as UiSnapshotMessage;

function BoardHarness() {
  const sessions = useStoreSelector((state) => state.sessions);
  const scoped = React.useMemo(() => [...sessions.values()], [sessions]);
  return <Board sessions={scoped} searchActive={false} onShowAll={() => {}} onNewSession={() => {}} onSessionMenu={() => {}} />;
}

test("a board whose snapshot has not loaded says Loading, and a disconnected one says so, never No Sessions Yet", async () => {
  const container = domWindow.document.createElement("div") as unknown as HTMLDivElement;
  domWindow.document.body.append(container as never);
  const root = createRoot(container);
  const socket = new FakeSocket();
  const connection: UiConnectionRuntime = {
    instanceId: "state-dom-test",
    runtimeKey: "state-dom-test:1",
    createSocket: () => socket,
    close() {},
  };
  try {
    await act(async () => root.render(
      <StoreProvider connection={connection} navigation={navigation}><BoardHarness /></StoreProvider>,
    ));
    const text = () => container.textContent ?? "";
    assert.ok(container.querySelector(".state.loading"), "no snapshot yet: the list is loading");
    assert.match(text(), /Loading sessions…/);
    assert.doesNotMatch(text(), /No Sessions Yet/);

    await act(async () => socket.push(emptySnapshot));
    assert.match(text(), /No Sessions Yet/, "an authoritative empty snapshot is the only thing that says so");
    assert.equal(container.querySelector(".state.loading"), null);

    await act(async () => socket.drop());
    assert.ok(container.querySelector(".state.offline"), "a dropped connection is offline, whatever loaded before");
    assert.match(text(), /Reconnecting…/);
    assert.doesNotMatch(text(), /No Sessions Yet/);
  } finally {
    await act(async () => root.unmount());
    container.remove();
  }
});
