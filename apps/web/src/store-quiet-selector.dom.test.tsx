import assert from "node:assert/strict";
import test from "node:test";
import React, { act, useState } from "react";
import { createRoot } from "react-dom/client";
import { Window } from "happy-dom";
import type { ControlPlaneToUi, SessionView } from "@wollipog/protocol";
import {
  sessionEqualIgnoringStreaming, StoreProvider, useLiveSession, useSessionChanges, useStoreSelector, useStoreSelectorUnlessQuiet,
} from "./store.js";
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

let parentRenders = 0;

function LiveCount({ session: rendered }: { session: SessionView }) {
  const live = useLiveSession(rendered);
  return <output data-live="">{live.messageCount}</output>;
}

function SessionParent() {
  const selected = useStoreSelector((state) => state.sessions.get("s1"), sessionEqualIgnoringStreaming);
  parentRenders += 1;
  return selected ? <><span data-title="">{selected.title}</span><LiveCount session={selected} /></> : null;
}

test("a view that ignores streaming fields keeps showing them live through useLiveSession (#2872)", async () => {
  const socket = new FakeSocket();
  const connection: UiConnectionRuntime = {
    instanceId: "live", runtimeKey: "live:1", createSocket: () => socket, close() {},
  };
  const container = domWindow.document.createElement("div") as unknown as HTMLDivElement;
  domWindow.document.body.append(container as never);
  const root = createRoot(container);
  const live = () => container.querySelector("[data-live]")?.textContent;
  try {
    await act(async () => root.render(<StoreProvider connection={connection}><SessionParent /></StoreProvider>));
    await act(async () => socket.push({ type: "snapshot", runners: [], boxes: [], sessions: [session(0)], runs: [], pods: [] }));
    assert.equal(live(), "0");
    const before = parentRenders;

    await act(async () => socket.push({ type: "session_upsert", session: { ...session(3), preview: "streamed", lastEventAt: 9 } }));
    assert.equal(parentRenders, before, "a streaming-only upsert does not render the view");
    assert.equal(live(), "3", "the part that shows the count does");

    await act(async () => socket.push({ type: "session_upsert", session: { ...session(4), title: "Renamed" } }));
    assert.ok(parentRenders > before, "any other change renders the view");
    assert.equal(container.querySelector("[data-title]")?.textContent, "Renamed");
    assert.equal(live(), "4");
  } finally {
    await act(async () => root.unmount());
    container.remove();
  }
});

test("useLiveSession shows the session it was given where no store is mounted", async () => {
  const container = domWindow.document.createElement("div") as unknown as HTMLDivElement;
  domWindow.document.body.append(container as never);
  const root = createRoot(container);
  try {
    await act(async () => root.render(<LiveCount session={session(7)} />));
    assert.equal(container.querySelector("[data-live]")?.textContent, "7");
  } finally {
    await act(async () => root.unmount());
    container.remove();
  }
});

let ageRenders = 0;
/** An age read from the clock as it renders, as the session view's panels show them. */
function Age({ sessionId }: { sessionId: string }) {
  useSessionChanges(sessionId);
  ageRenders += 1;
  return null;
}

test("useSessionChanges renders its caller for a streaming-only upsert of its session alone (#2872)", async () => {
  const socket = new FakeSocket();
  const connection: UiConnectionRuntime = {
    instanceId: "changes", runtimeKey: "changes:1", createSocket: () => socket, close() {},
  };
  const container = domWindow.document.createElement("div") as unknown as HTMLDivElement;
  domWindow.document.body.append(container as never);
  const root = createRoot(container);
  try {
    await act(async () => root.render(<StoreProvider connection={connection}><Age sessionId="s1" /></StoreProvider>));
    const other = { ...session(0), id: "s2" };
    await act(async () => socket.push({ type: "snapshot", runners: [], boxes: [], sessions: [session(0), other], runs: [], pods: [] }));
    const before = ageRenders;
    await act(async () => socket.push({ type: "session_upsert", session: { ...session(0), lastEventAt: 9, updatedAt: 9 } }));
    assert.equal(ageRenders, before + 1, "its session's paced upsert renders it, as it rendered the whole view");
    await act(async () => socket.push({ type: "session_upsert", session: { ...other, lastEventAt: 9, updatedAt: 9 } }));
    assert.equal(ageRenders, before + 1, "another session's does not");
  } finally {
    await act(async () => root.unmount());
    container.remove();
  }
});
