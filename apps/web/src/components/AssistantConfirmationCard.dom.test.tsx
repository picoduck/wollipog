import assert from "node:assert/strict";
import test from "node:test";
import React, { act } from "react";
import { createRoot } from "react-dom/client";
import { Window } from "happy-dom";
import type { AssistantOwnerConfirmation, AssistantThread, ControlPlaneToUi } from "@wollipog/protocol";
import { api, ApiError, type ApiClient } from "../api.js";
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
  id, threadId: "thr_1", operation: "session_archive", title, summary: "Archives it.", target: { kind: "session", id: "s", label: "Prototype" },
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

async function flush(delay = 0) {
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, delay));
    await Promise.resolve();
  });
}

test("approvals follow thread events and are read again when the connection returns", async () => {
  let listed = [thread([request("aoc_1", "Archive Session")])];
  let reads = 0;
  // While `hold` is set, a read answers with the list as it was when it started, once released.
  let hold = false;
  const releases: Array<() => void> = [];
  const failures: Array<() => void> = [];
  const client = { ...api, assistantConfirmationThreads: () => {
    reads += 1;
    const snapshot = { threads: listed };
    return hold ? new Promise((resolve, reject) => {
      releases.push(() => resolve(snapshot));
      failures.push(() => reject(new Error("socket closed")));
    }) : Promise.resolve(snapshot);
  } } as unknown as ApiClient;
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

  const event = async (changed: AssistantThread) => {
    listed = [changed];
    await act(async () => socket.push({ type: "assistant_thread_upsert", userId: "u", thread: changed }));
    await flush();
  };

  // A thread event that changes its pending requests reads the list again.
  await event(thread([request("aoc_1", "Archive Session"), request("aoc_2", "Stop Session")]));
  assert.equal(reads, 2);
  assert.deepEqual(titles(), ["Archive Session", "Stop Session"]);
  // Thread activity that leaves them unchanged does not.
  await event(thread([request("aoc_2", "Stop Session"), request("aoc_1", "Archive Session")]));
  assert.equal(reads, 2);

  // While disconnected, the owner answers both elsewhere and a new request arrives; no event reaches
  // this dashboard. Reconnecting reads the list again, dropping the stale rows.
  await act(async () => actions!.dispatch({ type: "conn", conn: "offline" }));
  listed = [thread([request("aoc_3", "Close Shell")])];
  await act(async () => actions!.dispatch({ type: "conn", conn: "online" }));
  await flush();
  assert.equal(reads, 3);
  assert.deepEqual(titles(), ["Close Shell"]);

  // Reads that answer out of order: only the most recently started one is shown, so an older
  // read's late answer, or its failure, never replaces newer state.
  hold = true;
  await event(thread([request("aoc_3", "Close Shell"), request("aoc_4", "Delete Automation")]));
  await event(thread([request("aoc_3", "Close Shell")]));
  assert.equal(reads, 5);
  await act(async () => releases[1]!());
  await flush();
  assert.deepEqual(titles(), ["Close Shell"]);
  await act(async () => releases[0]!());
  await flush();
  assert.deepEqual(titles(), ["Close Shell"], "the older read's answer is discarded");
  // A read that fails is retried on its own: thread activity that leaves the pending requests
  // unchanged starts no read, so without the retry the new request would stay hidden.
  await event(thread([request("aoc_5", "Remove Skill")]));
  const failedAt = reads;
  await act(async () => failures[2]!());
  await flush();
  assert.deepEqual(titles(), ["Close Shell"]);
  hold = false;
  await event(thread([request("aoc_5", "Remove Skill")]));
  assert.equal(reads, failedAt, "unchanged activity starts no read");
  await flush(2_100);
  assert.equal(reads, failedAt + 1);
  assert.deepEqual(titles(), ["Remove Skill"]);
  await act(async () => root.unmount());
});

test("a control plane without the Thread API is read once and not retried", async () => {
  let reads = 0;
  const client = { ...api, assistantConfirmationThreads: async () => { reads += 1; throw new ApiError("not found", 404); } } as unknown as ApiClient;
  const socket = new FakeSocket();
  const connection: UiConnectionRuntime = { instanceId: "no-threads", runtimeKey: "no-threads:1", createSocket: () => socket, close() {} };
  const navigation: ViewNavigation = { current: () => ({ name: "session", id: "s_thread" }), push() {}, listen: () => () => {} };
  const container = domWindow.document.createElement("div") as unknown as HTMLDivElement;
  domWindow.document.body.append(container as never);
  const root = createRoot(container);
  await act(async () => root.render(
    <ApiProvider client={client}>
      <StoreProvider connection={connection} navigation={navigation}><AssistantConfirmationsNotice /></StoreProvider>
    </ApiProvider>,
  ));
  await act(async () => socket.push({ type: "session_removed", sessionId: "none" }));
  await flush(2_100);
  assert.equal(reads, 1);
  assert.equal(container.querySelector(".request-card"), null);
  await act(async () => root.unmount());
});

test("a read still in flight when the Inbox unmounts is never retried", async () => {
  let reads = 0;
  let fail: (() => void) | undefined;
  const client = { ...api, assistantConfirmationThreads: () => {
    reads += 1;
    return new Promise((_resolve, reject) => { fail = () => reject(new Error("socket closed")); });
  } } as unknown as ApiClient;
  const socket = new FakeSocket();
  const connection: UiConnectionRuntime = { instanceId: "unmounted", runtimeKey: "unmounted:1", createSocket: () => socket, close() {} };
  const navigation: ViewNavigation = { current: () => ({ name: "session", id: "s_thread" }), push() {}, listen: () => () => {} };
  const container = domWindow.document.createElement("div") as unknown as HTMLDivElement;
  domWindow.document.body.append(container as never);
  const root = createRoot(container);
  await act(async () => root.render(
    <ApiProvider client={client}>
      <StoreProvider connection={connection} navigation={navigation}><AssistantConfirmationsNotice /></StoreProvider>
    </ApiProvider>,
  ));
  await act(async () => socket.push({ type: "session_removed", sessionId: "none" }));
  await flush();
  assert.equal(reads, 1);
  await act(async () => root.unmount());
  await act(async () => fail!());
  await flush(2_100);
  assert.equal(reads, 1, "nothing retries after unmount");
});
