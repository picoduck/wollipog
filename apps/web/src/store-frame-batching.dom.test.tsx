import { fireDomEvent } from "./components/test-dom-events.js";
import assert from "node:assert/strict";
import test from "node:test";
import React, { act, useState } from "react";
import { createRoot } from "react-dom/client";
import { Window } from "happy-dom";
import type { ControlPlaneToUi, SessionEvent, SessionView } from "@wollipog/protocol";
import type { ViewNavigation } from "./navigation.js";
import { notifier } from "./notify.js";
import { animationFramePublishScheduler, setDefaultPublishScheduler, StoreProvider, useStoreSelector } from "./store.js";
import type { UiConnectionRuntime, UiSocket } from "./ui-transport.js";
import { installDomTestCleanup } from "./dom-test-cleanup.js";

/**
 * The dashboard publishes the socket frames of one animation frame as one store update (#2763):
 * what renders between a frame and its animation frame is the whole previous state, a hidden tab
 * (which gets no animation frames) publishes at once, and leaving or losing the socket publishes
 * whatever was waiting.
 */

const domWindow = new Window({ url: "http://localhost/" });
installDomTestCleanup(domWindow);
// This file exercises the batching, so it publishes on (hand-cranked) animation frames.
setDefaultPublishScheduler(animationFramePublishScheduler);
let visibility: DocumentVisibilityState = "visible";
Object.defineProperty(domWindow.document, "visibilityState", { configurable: true, get: () => visibility });
// Animation frames run only when a test says so.
const animationFrames = new Map<number, FrameRequestCallback>();
let nextFrame = 1;
domWindow.requestAnimationFrame = ((callback: FrameRequestCallback) => {
  const handle = nextFrame++;
  animationFrames.set(handle, callback);
  return handle;
}) as unknown as typeof domWindow.requestAnimationFrame;
domWindow.cancelAnimationFrame = ((handle: number) => { animationFrames.delete(handle); }) as unknown as typeof domWindow.cancelAnimationFrame;
for (const [name, value] of Object.entries({
  window: domWindow,
  document: domWindow.document,
  navigator: domWindow.navigator,
  localStorage: domWindow.localStorage,
  HTMLElement: domWindow.HTMLElement,
  HTMLInputElement: domWindow.HTMLInputElement,
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

const session = (patch: Partial<SessionView> = {}): SessionView => ({
  id: "s1", title: "Streaming", status: "running", eventEpoch: 0, messageCount: 0,
  workspaceId: null, agentId: null, driver: "codex", useWorktree: false, archived: false, createdAt: 1, updatedAt: 1,
  ...patch,
} as SessionView);
const event = (seq: number): SessionEvent => ({
  id: seq, sessionId: "s1", seq, ts: seq, payload: { kind: "agent_message", text: `chunk ${seq}` },
});

let renders = 0;

/** Shows the event count beside the session's own count of them, and keeps a local draft. */
function Probe() {
  const events = useStoreSelector((state) => state.events.get("s1")?.length ?? 0);
  const counted = useStoreSelector((state) => state.sessions.get("s1")?.messageCount ?? 0);
  const conn = useStoreSelector((state) => state.conn);
  const [draft, setDraft] = useState("");
  renders += 1;
  return (
    <div>
      <output data-testid="probe">{`${events}/${counted}/${conn}`}</output>
      <input aria-label="Draft" value={draft} onChange={(change) => setDraft(change.target.value)} />
    </div>
  );
}

async function mount() {
  const socket = new FakeSocket();
  const connection: UiConnectionRuntime = {
    instanceId: "batching",
    runtimeKey: `batching:${Math.random()}`,
    createSocket: () => socket,
    close() {},
  };
  const navigation: ViewNavigation = {
    current: () => ({ name: "session", id: "s1" }),
    push() {},
    listen: () => () => {},
  };
  const container = domWindow.document.createElement("div") as unknown as HTMLDivElement;
  domWindow.document.body.append(container as never);
  const root = createRoot(container);
  await act(async () => {
    root.render(<StoreProvider connection={connection} navigation={navigation}><Probe /></StoreProvider>);
  });
  await act(async () => socket.push({
    type: "snapshot", runners: [], boxes: [], sessions: [session()], runs: [], pods: [],
  }));
  return {
    socket,
    shown: () => container.querySelector('[data-testid="probe"]')!.textContent,
    input: () => container.querySelector("input") as unknown as HTMLInputElement,
    push: (message: ControlPlaneToUi) => act(async () => socket.push(message)),
    async frame() {
      await act(async () => {
        const due = [...animationFrames.values()];
        animationFrames.clear();
        for (const callback of due) callback(performance.now());
      });
    },
    async unmount() {
      await act(async () => root.unmount());
      container.remove();
    },
  };
}

test("frames received within one animation frame render once, when the frame runs", async () => {
  visibility = "visible";
  const view = await mount();
  try {
    assert.equal(view.shown(), "0/0/online");
    const before = renders;
    await view.push({ type: "session_event", event: event(1) });
    await view.push({ type: "session_event", event: event(2) });
    await view.push({ type: "session_upsert", session: session({ messageCount: 2 }) });
    assert.equal(renders, before, "nothing renders before the animation frame");
    assert.equal(view.shown(), "0/0/online");
    assert.equal(animationFrames.size, 1, "the batch waits for one animation frame");

    await view.frame();
    assert.equal(view.shown(), "2/2/online");
    assert.equal(renders, before + 1, "the three frames render as one commit");
  } finally {
    await view.unmount();
  }
});

test("a keystroke between a frame and its animation frame renders one consistent snapshot", async () => {
  visibility = "visible";
  const view = await mount();
  try {
    await view.push({ type: "session_event", event: event(1) });
    await view.push({ type: "session_upsert", session: session({ messageCount: 1 }) });
    await view.push({ type: "session_event", event: event(2) });
    await act(async () => { fireDomEvent.change(view.input(), { target: { value: "h" } }); });
    assert.equal(view.input().value, "h", "the keystroke renders at once");
    assert.equal(view.shown(), "0/0/online",
      "and shows the published state whole: neither the events nor the upsert counting them");

    await view.frame();
    assert.equal(view.shown(), "2/1/online");
    assert.equal(view.input().value, "h");
  } finally {
    await view.unmount();
  }
});

test("hiding the tab publishes waiting frames, and a hidden tab publishes each frame at once", async () => {
  visibility = "visible";
  const view = await mount();
  try {
    await view.push({ type: "session_event", event: event(1) });
    assert.equal(view.shown(), "0/0/online");
    visibility = "hidden";
    await act(async () => { domWindow.document.dispatchEvent(new domWindow.Event("visibilitychange")); });
    assert.equal(view.shown(), "1/0/online", "background tabs get no animation frames, so hiding publishes");
    assert.equal(animationFrames.size, 0, "and cancels the frame it was waiting for");

    await view.push({ type: "session_event", event: event(2) });
    assert.equal(view.shown(), "2/0/online", "a hidden tab publishes each frame at once");
    assert.equal(animationFrames.size, 0);

    visibility = "visible";
    await act(async () => { domWindow.document.dispatchEvent(new domWindow.Event("visibilitychange")); });
    await view.push({ type: "session_event", event: event(3) });
    assert.equal(view.shown(), "2/0/online", "a visible tab batches again");
    await view.frame();
    assert.equal(view.shown(), "3/0/online");
  } finally {
    visibility = "visible";
    await view.unmount();
  }
});

test("leaving the page or losing the socket publishes what was waiting", async () => {
  visibility = "visible";
  const view = await mount();
  try {
    await view.push({ type: "session_event", event: event(1) });
    await act(async () => { domWindow.dispatchEvent(new domWindow.Event("pagehide")); });
    assert.equal(view.shown(), "1/0/online", "pagehide publishes");

    await view.push({ type: "session_event", event: event(2) });
    await act(async () => { view.socket.onclose?.({ code: 1006 }); });
    assert.equal(view.shown(), "2/0/offline", "a closed socket publishes its last frames with the offline state");
  } finally {
    await view.unmount();
  }
});

test("a frame whose animation frame never comes is published by the fallback timer", async () => {
  visibility = "visible";
  const view = await mount();
  try {
    await view.push({ type: "session_event", event: event(1) });
    assert.equal(view.shown(), "0/0/online");
    await act(async () => new Promise((resolve) => setTimeout(resolve, 150)));
    assert.equal(view.shown(), "1/0/online");
    assert.equal(animationFrames.size, 0, "the fallback cancels the animation frame");
  } finally {
    await view.unmount();
  }
});

test("a status that lasts less than one frame still raises its desktop notification", async () => {
  visibility = "visible";
  const shown: string[] = [];
  const show = notifier.show;
  notifier.show = (payload) => { shown.push(payload.title); };
  const view = await mount();
  try {
    await view.push({ type: "session_upsert", session: session({ status: "idle" }) });
    await view.push({ type: "session_upsert", session: session({ status: "running" }) });
    await view.frame();
    assert.deepEqual(shown, ["Streaming is awaiting a prompt"]);
  } finally {
    notifier.show = show;
    await view.unmount();
  }
});
