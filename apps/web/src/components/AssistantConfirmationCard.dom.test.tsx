import assert from "node:assert/strict";
import test from "node:test";
import React, { act } from "react";
import { createRoot } from "react-dom/client";
import { Window } from "happy-dom";
import type { AssistantOwnerConfirmation, AssistantThread, ControlPlaneToUi } from "@wollipog/protocol";
import { api, type ApiClient } from "../api.js";
import { ApiProvider } from "../api-context.js";
import type { ViewNavigation } from "../navigation.js";
import { StoreProvider, useStoreActions } from "../store.js";
import { UI_SOCKET_OPEN, type UiConnectionRuntime, type UiSocket } from "../ui-transport.js";
import { installDomTestCleanup } from "../dom-test-cleanup.js";
import { AssistantConfirmationsNotice } from "./AssistantConfirmationCard.js";

/** The Inbox's Assistant Approvals follow thread events, and read the list again on reconnect (#4665). */

const domWindow = new Window({ url: "http://localhost/" });
installDomTestCleanup(domWindow);
for (const [name, value] of Object.entries({
  window: domWindow,
  document: domWindow.document,
  navigator: domWindow.navigator,
  localStorage: domWindow.localStorage,
  Element: domWindow.Element,
  HTMLElement: domWindow.HTMLElement,
  Node: domWindow.Node,
  Event: domWindow.Event,
  CustomEvent: domWindow.CustomEvent,
  MouseEvent: domWindow.MouseEvent,
  KeyboardEvent: domWindow.KeyboardEvent,
  MutationObserver: domWindow.MutationObserver,
  React,
  IS_REACT_ACT_ENVIRONMENT: true,
  ResizeObserver: class { observe() {} unobserve() {} disconnect() {} },
  requestAnimationFrame: (callback: FrameRequestCallback) => setTimeout(() => callback(0), 0) as unknown as number,
  cancelAnimationFrame: (id: number) => clearTimeout(id as unknown as NodeJS.Timeout),
})) Object.defineProperty(globalThis, name, { configurable: true, writable: true, value });

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

const request = (id: string, title: string): AssistantOwnerConfirmation => ({
  id, threadId: "thr_1", operation: "session_archive", title, target: { kind: "session", id: "s", label: "Prototype" },
  impact: [], arguments: [{ label: "sessionId", value: "s" }], status: "pending", createdAt: 1, expiresAt: Date.now() + 3_600_000, resolvedAt: null,
});
const thread = (confirmations: AssistantOwnerConfirmation[]): AssistantThread => ({
  id: "thr_1", assistant: "wollipog", title: "Cleanup", harness: "codex", sessionId: "s_thread", status: confirmations.length ? "needs_you" : "done",
  access: { level: "full_access", destructive: "ask" }, connectionId: null, launchedSessionIds: [], confirmations, lastActivityAt: 1, createdAt: 1, archivedAt: null,
});

type StoreActions = ReturnType<typeof useStoreActions>;
function ActionsProbe({ onActions }: { onActions: (actions: StoreActions) => void }) {
  onActions(useStoreActions());
  return null;
}

async function flush() {
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 0));
    await Promise.resolve();
  });
}

test("approvals follow thread events and are read again when the connection returns", async () => {
  let listed = [thread([request("aoc_1", "Archive Session")])];
  let reads = 0;
  const client = { ...api, assistantConfirmationThreads: async () => { reads += 1; return { threads: listed }; } } as unknown as ApiClient;
  const socket = new FakeSocket();
  const connection: UiConnectionRuntime = { instanceId: "confirmations", runtimeKey: "confirmations:1", createSocket: () => socket, close() {} };
  const navigation: ViewNavigation = { current: () => ({ name: "session", id: "s_thread" }), push() {}, listen: () => () => {} };
  let actions: StoreActions | undefined;
  const container = domWindow.document.createElement("div") as unknown as HTMLDivElement;
  domWindow.document.body.append(container as never);
  const root = createRoot(container);
  await act(async () => root.render(
    <ApiProvider client={client}>
      <StoreProvider connection={connection} navigation={navigation}>
        <ActionsProbe onActions={(current) => { actions = current; }} />
        <AssistantConfirmationsNotice />
      </StoreProvider>
    </ApiProvider>,
  ));
  const titles = () => [...container.querySelectorAll(".request-card-title")].map((node) => node.textContent);
  // The first frame brings the connection online, which reads the list.
  await act(async () => socket.push({ type: "session_removed", sessionId: "none" }));
  await flush();
  assert.deepEqual(titles(), ["Archive Session"]);
  assert.equal(reads, 1);

  // A live event replaces the thread.
  await act(async () => socket.push({ type: "assistant_thread_upsert", userId: "u", thread: thread([request("aoc_1", "Archive Session"), request("aoc_2", "Stop Session")]) }));
  await flush();
  assert.deepEqual(titles(), ["Archive Session", "Stop Session"]);

  // While disconnected, the owner answers both elsewhere and a new request arrives; no event reaches
  // this dashboard. Reconnecting reads the list again, dropping the stale rows.
  await act(async () => actions!.dispatch({ type: "conn", conn: "offline" }));
  listed = [thread([request("aoc_3", "Close Shell")])];
  await act(async () => actions!.dispatch({ type: "conn", conn: "online" }));
  await flush();
  assert.equal(reads, 2);
  assert.deepEqual(titles(), ["Close Shell"]);
  await act(async () => root.unmount());
});
