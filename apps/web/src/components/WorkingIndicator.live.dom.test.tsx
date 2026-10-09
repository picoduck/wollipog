import assert from "node:assert/strict";
import test from "node:test";
import React, { act } from "react";
import { createRoot } from "react-dom/client";
import { Window } from "happy-dom";
import type { ControlPlaneToUi, SessionView } from "@wollipog/protocol";
import type { ActiveTurnProgress } from "../turn-progress.js";
import { StoreProvider } from "../store.js";
import type { UiConnectionRuntime, UiSocket } from "../ui-transport.js";
import { installDomTestCleanup } from "../dom-test-cleanup.js";
import { assertNoDomNode } from "../dom-test-assertions.js";
import { WorkingIndicator } from "./WorkingIndicator.js";

/**
 * A chunk that only lengthens the reply does not render the session view that derives `progress`
 * (#2763), so the working indicator reads the session's heartbeat itself: new output ends a
 * silence at once, not when the view next renders.
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

const NOW = 10_000_000;

test("output after a silence ends it at once, from the session's own heartbeat", async () => {
  const socket = new FakeSocket();
  const connection: UiConnectionRuntime = {
    instanceId: "working-live", runtimeKey: "working-live:1", createSocket: () => socket, close() {},
  };
  const session = {
    id: "s1", title: "Silent", status: "running", eventEpoch: 0, messageCount: 1,
    workspaceId: null, agentId: null, driver: "codex", useWorktree: false, archived: false, createdAt: 1, updatedAt: 1,
  } as SessionView;
  // Derived three minutes before now, and not derived again: the view did not render since.
  const progress: ActiveTurnProgress = {
    turnEventId: 1, turnStartedAt: NOW - 240_000, lastActivityAt: NOW - 180_000, completedTools: 0, failedTools: 0,
  };
  const container = domWindow.document.createElement("div") as unknown as HTMLDivElement;
  domWindow.document.body.append(container as never);
  const root = createRoot(container);
  const note = () => container.querySelector(".tl-working-note");
  try {
    await act(async () => root.render(
      <StoreProvider connection={connection}>
        <WorkingIndicator progress={progress} now={NOW} liveActivitySessionId="s1" />
      </StoreProvider>,
    ));
    await act(async () => socket.push({ type: "snapshot", runners: [], boxes: [], sessions: [session], runs: [], pods: [] }));
    assert.equal(note()?.textContent, "No new output for 3m");

    await act(async () => socket.push({
      type: "session_event",
      event: { id: 2, sessionId: "s1", seq: 2, ts: NOW, payload: { kind: "agent_message", text: "More" } },
    }));
    assertNoDomNode(note(), "the chunk ends the silence without new progress");
  } finally {
    await act(async () => root.unmount());
    container.remove();
  }
});
