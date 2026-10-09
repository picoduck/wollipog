import assert from "node:assert/strict";
import test from "node:test";
import React, { act, useState } from "react";
import { createRoot } from "react-dom/client";
import { Window } from "happy-dom";
import type { ControlPlaneToUi, SessionView } from "@wollipog/protocol";
import { StoreProvider, useStoreSelectorUnlessQuiet } from "./store.js";
import type { UiConnectionRuntime, UiSocket } from "./ui-transport.js";
import { installDomTestCleanup } from "./dom-test-cleanup.js";

/**
 * `useStoreSelectorUnlessQuiet` renders its component only for a change its predicate does not call
 * quiet, and any render for another reason reads the current value (#2763).
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
})) {
  Object.defineProperty(globalThis, name, { configurable: true, writable: true, value });
}

class FakeSocket implements UiSocket {
  readonly readyState = 0;
  onopen: (() => void) | null = null;
  onmessage: ((event: { data: string }) => void) | null = null;
  onclose: ((event: { code: number }) => void) | null = null;
  onerror: (() => void) | null = null;
  send() {}
  close() {}
  push(message: ControlPlaneToUi) { this.onmessage?.({ data: JSON.stringify(message) }); }
}

const session = (messageCount: number): SessionView => ({
  id: "s1", title: "Quiet", status: "running", eventEpoch: 0, messageCount,
  workspaceId: null, agentId: null, driver: "codex", useWorktree: false, archived: false, createdAt: 1, updatedAt: 1,
} as SessionView);

/** Same parity is quiet: an equivalence, so a run of quiet changes is quiet as a whole. */
const sameParity = (previous: number, next: number) => previous % 2 === next % 2;

let renders = 0;
let bump: () => void = () => {};

function Probe() {
  const count = useStoreSelectorUnlessQuiet((state) => state.sessions.get("s1")?.messageCount ?? 0, sameParity);
  const [, setLocal] = useState(0);
  bump = () => setLocal((value) => value + 1);
  renders += 1;
  return <output>{count}</output>;
}

test("quiet changes render nothing, and the next render for any reason reads the current value", async () => {
  const socket = new FakeSocket();
  const connection: UiConnectionRuntime = {
    instanceId: "quiet", runtimeKey: "quiet:1", createSocket: () => socket, close() {},
  };
  const container = domWindow.document.createElement("div") as unknown as HTMLDivElement;
  domWindow.document.body.append(container as never);
  const root = createRoot(container);
  const shown = () => container.querySelector("output")?.textContent;
  try {
    await act(async () => root.render(<StoreProvider connection={connection}><Probe /></StoreProvider>));
    await act(async () => socket.push({ type: "snapshot", runners: [], boxes: [], sessions: [session(0)], runs: [], pods: [] }));
    assert.equal(shown(), "0");
    const before = renders;

    await act(async () => socket.push({ type: "session_upsert", session: session(2) }));
    await act(async () => socket.push({ type: "session_upsert", session: session(4) }));
    assert.equal(renders, before, "changes the predicate calls quiet render nothing");
    assert.equal(shown(), "0");

    await act(async () => bump());
    assert.equal(shown(), "4", "a render for another reason reads the current value");

    await act(async () => socket.push({ type: "session_upsert", session: session(5) }));
    assert.equal(shown(), "5", "a change that is not quiet renders");
    await act(async () => socket.push({ type: "session_upsert", session: session(7) }));
    assert.equal(shown(), "5", "quiet again from the new value");
  } finally {
    await act(async () => root.unmount());
    container.remove();
  }
});
