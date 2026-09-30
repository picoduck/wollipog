import { fireDomEvent } from "./test-dom-events.js";
import assert from "node:assert/strict";
import test from "node:test";
import React, { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { Window } from "happy-dom";
import type { PodContextEntry, PodView, RunnerView, SessionView, UiSnapshotMessage } from "@wollipog/protocol";
import { api, type ApiClient } from "../api.js";
import { ApiProvider } from "../api-context.js";
import { viewTitle, type View, type ViewNavigation } from "../navigation.js";
import { StoreProvider, useStoreSelector } from "../store.js";
import { UI_SOCKET_OPEN, type UiConnectionRuntime, type UiSocket } from "../ui-transport.js";
import { FeedbackContext } from "./FeedbackProvider.js";
import { NewPodDialog } from "./NewPodDialog.js";
import { PodDetail, PodsView } from "./PodsView.js";
import { installDomTestCleanup } from "../dom-test-cleanup.js";

const domWindow = new Window({ url: "http://localhost/" });
installDomTestCleanup(domWindow);
for (const [name, value] of Object.entries({
  window: domWindow, document: domWindow.document, navigator: domWindow.navigator,
  localStorage: domWindow.localStorage, Element: domWindow.Element, HTMLElement: domWindow.HTMLElement,
  HTMLSelectElement: domWindow.HTMLSelectElement, HTMLTextAreaElement: domWindow.HTMLTextAreaElement,
  Node: domWindow.Node, Event: domWindow.Event, MouseEvent: domWindow.MouseEvent,
  KeyboardEvent: domWindow.KeyboardEvent, MutationObserver: domWindow.MutationObserver,
  React, IS_REACT_ACT_ENVIRONMENT: true,
  ResizeObserver: class { observe() {} unobserve() {} disconnect() {} },
  requestAnimationFrame: (callback: FrameRequestCallback) => setTimeout(() => callback(0), 0) as unknown as number,
  cancelAnimationFrame: (id: number) => clearTimeout(id as unknown as NodeJS.Timeout),
})) Object.defineProperty(globalThis, name, { configurable: true, writable: true, value });

const runner = {
  runnerId: "runner-pods", hostname: "runner-host", os: "linux", version: "1", status: "online",
  agents: [{ id: "codex", name: "Codex", command: "codex", args: [], env: {}, driver: "codex", available: true }],
  workspaces: [], connectedAt: 1, lastSeen: 1, protocolVersion: 141,
} as RunnerView;

function session(id: string): SessionView {
  return {
    id, runnerId: runner.runnerId, workspaceId: null, workspaceName: null, projectId: null,
    agentId: "codex", agentName: "Codex", title: `Session ${id}`, status: "idle", column: "review",
    runId: null, useWorktree: true, worktreePath: `/worktrees/${id}`, archived: false, createdAt: 1, updatedAt: 1,
    lastEventAt: null, messageCount: 0, eventEpoch: 0, preview: null, pendingApproval: null,
    driver: "codex", model: null, effort: null, permissionMode: null,
    tokensIn: 0, tokensOut: 0, costUsd: 0, adopted: false,
  } as SessionView;
}

// Both pods carry the same (default) orchestration policy, so no policy value changes on the switch.
function pod(id: string, title: string, memberIds: string[]): PodView {
  return {
    id, title, objective: `${title} objective`, status: "active", createdAt: 1, updatedAt: 1,
    members: memberIds.map((sessionId) => ({ sessionId, joinedAt: 1, role: "worker", contextTokenBudget: null, lastContextSeq: 0 })),
  };
}

const podA = pod("pod-a", "Pod A", ["a1", "a2"]);
const podB = pod("pod-b", "Pod B", ["b1", "b2"]);
const contextA: PodContextEntry = {
  id: "context-a", podId: podA.id, seq: 1, ts: 1, source: { kind: "human", actorId: "local" }, content: "Pod A shared note",
};

class FakeSocket implements UiSocket {
  readonly readyState = UI_SOCKET_OPEN;
  onopen: (() => void) | null = null;
  onmessage: ((event: { data: string }) => void) | null = null;
  onclose: ((event: { code: number }) => void) | null = null;
  onerror: (() => void) | null = null;
  send() {}
  close() {}
  push(message: UiSnapshotMessage) { this.onmessage?.({ data: JSON.stringify(message) }); }
}

const pending = () => new Promise<never>(() => {});

/** Starts on pod A; `jumpTo` is a browser-history jump straight to another pod's detail. */
function historyNavigation(): ViewNavigation & { jumpTo: (podId: string) => void } {
  const listeners = new Set<(view: View) => void>();
  return {
    current: () => ({ name: "pod", id: podA.id }),
    push() {},
    listen: (onView) => { listeners.add(onView); return () => listeners.delete(onView); },
    jumpTo: (podId) => { for (const onView of listeners) onView({ name: "pod", id: podId }); },
  };
}

/** Renders the pod route the way App does: one PodDetail at a fixed tree position. */
function PodRoute() {
  const view = useStoreSelector((state) => state.view);
  return view.name === "pod" ? <PodDetail podId={view.id} /> : null;
}

const section = (container: HTMLDivElement, label: string) => {
  const found = container.querySelector(`[aria-label="${label}"]`);
  assert.ok(found, `${label} section is rendered`);
  return found as HTMLElement;
};

function buttonNamed(container: ParentNode, pattern: RegExp): HTMLButtonElement {
  const button = [...container.querySelectorAll("button")].find((candidate) => pattern.test(candidate.textContent?.trim() ?? ""));
  assert.ok(button, `${pattern} button is rendered`);
  return button as HTMLButtonElement;
}

function fieldSelect(container: ParentNode, label: string): HTMLSelectElement {
  const field = [...container.querySelectorAll("label")].find((candidate) =>
    candidate.querySelector(":scope > span")?.textContent === label);
  const select = field?.querySelector("select");
  assert.ok(select, `${label} select is rendered`);
  return select as HTMLSelectElement;
}

function choose(select: HTMLSelectElement, value: string): void {
  Object.getOwnPropertyDescriptor(domWindow.HTMLSelectElement.prototype, "value")?.set?.call(select, value);
  select.dispatchEvent(new domWindow.Event("change", { bubbles: true }) as never);
}

function type(textarea: HTMLTextAreaElement, value: string): void {
  Object.getOwnPropertyDescriptor(domWindow.HTMLTextAreaElement.prototype, "value")?.set?.call(textarea, value);
  fireDomEvent.change(textarea, { target: textarea });
}

test("a direct pod-to-pod route change starts from the new pod's own draft, errors, receipts and policy", async () => {
  const container = domWindow.document.createElement("div") as unknown as HTMLDivElement;
  domWindow.document.body.append(container as never);
  const root = createRoot(container);
  const socket = new FakeSocket();
  const connection: UiConnectionRuntime = {
    instanceId: "pods-view", runtimeKey: "pods-view:1", createSocket: () => socket, close() {},
  };
  const client = {
    ...api,
    getSessionEventPage: pending,
    podContext: async (id: string) => ({ entries: id === podA.id ? [contextA] : [] }),
    relayPod: async () => ({ pod: podA, sessions: [], receipts: [{ sessionId: "a1", status: "delivered" }] }),
    appendPodContext: async () => { throw new Error("Pod A note failed"); },
  } as unknown as ApiClient;
  const navigation = historyNavigation();
  try {
    await act(async () => root.render(
      <ApiProvider client={client}>
        <FeedbackContext.Provider value={{ confirm: async () => true, showToast: () => 0, dismissToast: () => {} } as never}>
          <StoreProvider connection={connection} navigation={navigation}>
            <PodRoute />
          </StoreProvider>
        </FeedbackContext.Provider>
      </ApiProvider>,
    ));
    await act(async () => socket.push({
      type: "snapshot",
      capabilities: { sessionSubscriptions: false, boundedDelivery: false, paginatedSessionHistory: false, projects: true },
      runners: [runner], boxes: [], projects: [], runs: [], pods: [podA, podB],
      sessions: ["a1", "a2", "b1", "b2", "spare"].map(session),
    }));
    await act(async () => { await new Promise((resolve) => setTimeout(resolve, 0)); });

    const relaySection = () => section(container, "Manual Pod Relay");
    const contextSection = () => section(container, "Shared Huddle Context");
    const policySection = () => section(container, "Pod Orchestration Policy");
    const relayField = () => relaySection().querySelector("textarea") as HTMLTextAreaElement;
    const contextBox = () => contextSection().querySelector('input[type="checkbox"]') as HTMLInputElement;

    // Relay once so pod A has delivery receipts, then leave a failed note, a selected context
    // entry, an unsaved arbitration change and an add-member choice behind.
    await act(async () => contextBox().click());
    await act(async () => type(relayField(), "Relayed from pod A"));
    await act(async () => buttonNamed(relaySection(), /^Relay to Selected$/u).click());
    assert.ok(relaySection().querySelector('[aria-label="Relay Delivery Receipts"]'), "pod A shows its receipts");
    await act(async () => contextBox().click());
    await act(async () => type(relayField(), "Pod A draft"));
    await act(async () => buttonNamed(relaySection(), /^Save Note$/u).click());
    await act(async () => choose(fieldSelect(policySection(), "Arbitration"), "round_robin"));
    await act(async () => choose(relaySection().querySelector(".pod-add-member select") as HTMLSelectElement, "spare"));

    assert.equal(relayField().value, "Pod A draft");
    assert.match(relaySection().textContent ?? "", /Pod A note failed/u);
    assert.match(contextSection().textContent ?? "", /1 Selected/u);
    assert.equal(fieldSelect(policySection(), "Arbitration").value, "round_robin");
    assert.equal(buttonNamed(policySection(), /^Save Policy$/u).disabled, false);
    assert.equal((relaySection().querySelector(".pod-add-member select") as HTMLSelectElement).value, "spare");

    await act(async () => navigation.jumpTo(podB.id));
    await act(async () => { await new Promise((resolve) => setTimeout(resolve, 0)); });

    assert.equal(container.querySelector(".detail-bar-title")?.textContent, "Pod B");
    assert.equal(relayField().value, "");
    assert.doesNotMatch(relaySection().textContent ?? "", /Pod A note failed/u);
    assert.equal(Boolean(relaySection().querySelector('[aria-label="Relay Delivery Receipts"]')), false, "no receipts carry over");
    assert.match(contextSection().textContent ?? "", /0 Selected/u);
    assert.equal(fieldSelect(policySection(), "Arbitration").value, "manual");
    assert.equal(buttonNamed(policySection(), /^Policy Saved$/u).disabled, true);
    assert.equal((relaySection().querySelector(".pod-add-member select") as HTMLSelectElement).value, "");
  } finally {
    await act(async () => root.unmount());
    container.remove();
  }
});

/** Renders the Pods list with a socket the test drives: nothing arrives until it says so. */
async function renderPodsList(drive: (socket: FakeSocket) => void): Promise<{ text: string; createButton: boolean }> {
  const container = domWindow.document.createElement("div") as unknown as HTMLDivElement;
  domWindow.document.body.append(container as never);
  const root = createRoot(container);
  const socket = new FakeSocket();
  const connection: UiConnectionRuntime = {
    instanceId: "pods-list", runtimeKey: "pods-list:1",
    createSocket: (() => { let first = true; return () => { if (!first) return new FakeSocket(); first = false; return socket; }; })(),
    close() {},
  };
  const navigation: ViewNavigation = { current: () => ({ name: "pods" }), push() {}, listen: () => () => {} };
  try {
    await act(async () => root.render(
      <ApiProvider client={api}>
        <StoreProvider connection={connection} navigation={navigation}>
          <PodsView onNewPod={() => {}} />
        </StoreProvider>
      </ApiProvider>,
    ));
    await act(async () => drive(socket));
    return {
      text: container.textContent ?? "",
      createButton: [...container.querySelectorAll(".state .actions button")].some((button) => button.textContent === "New Pod"),
    };
  } finally {
    await act(async () => root.unmount());
    container.remove();
  }
}

const snapshotWithPods = (pods: PodView[]): UiSnapshotMessage => ({
  type: "snapshot",
  capabilities: { sessionSubscriptions: false, boundedDelivery: false, paginatedSessionHistory: false, projects: true },
  runners: [runner], boxes: [], projects: [], sessions: [], runs: [], pods,
});

test("before the first snapshot the Pods list is loading, not empty", async () => {
  const list = await renderPodsList(() => {});
  assert.match(list.text, /Loading Pods…/u);
  assert.doesNotMatch(list.text, /No Pods Yet/u);
  assert.equal(list.createButton, false);
});

test("an offline or unpaired dashboard shows the Pods list as unavailable, not empty", async () => {
  const offline = await renderPodsList((socket) => socket.onclose?.({ code: 1006 }));
  assert.match(offline.text, /Pods Unavailable/u);
  assert.doesNotMatch(offline.text, /No Pods Yet/u);
  assert.equal(offline.createButton, false);

  const unauthorized = await renderPodsList((socket) => socket.onclose?.({ code: 1008 }));
  assert.match(unauthorized.text, /Pair to Load Pods/u);
  assert.equal(unauthorized.createButton, false);
});

test("a loaded pod titles its page by name and returns to Pods", async () => {
  const container = domWindow.document.createElement("div") as unknown as HTMLDivElement;
  domWindow.document.body.append(container as never);
  const root = createRoot(container);
  const socket = new FakeSocket();
  const connection: UiConnectionRuntime = {
    instanceId: "pod-title", runtimeKey: "pod-title:1", createSocket: () => socket, close() {},
  };
  const client = { ...api, getSessionEventPage: pending, podContext: async () => ({ entries: [] }) } as unknown as ApiClient;
  const navigation: ViewNavigation = { current: () => ({ name: "pod", id: podA.id }), push() {}, listen: () => () => {} };
  const heading = () => container.querySelector("h1#page-title")?.textContent;
  try {
    await act(async () => root.render(
      <ApiProvider client={client}>
        <StoreProvider connection={connection} navigation={navigation}>
          <PodRoute />
        </StoreProvider>
      </ApiProvider>,
    ));
    // Until the pod arrives, the generic noun is the only thing the page can say.
    assert.equal(heading(), "Pod");
    assert.equal(heading(), viewTitle({ name: "pod", id: podA.id }));

    await act(async () => socket.push(snapshotWithPods([podA])));
    assert.equal(heading(), "Pod A");
    assert.equal(heading(), viewTitle({ name: "pod", id: podA.id }, podA.title),
      "the page h1 and viewTitle() name the same pod");
    const back = container.querySelector(".detail-bar-back")!;
    assert.equal(back.getAttribute("aria-label"), "Back to Pods");
    assert.equal(back.getAttribute("title"), "Back to Pods");
  } finally {
    await act(async () => root.unmount());
    container.remove();
  }
});

test("only a loaded snapshot with no pods shows the empty state and its create action", async () => {
  const empty = await renderPodsList((socket) => socket.push(snapshotWithPods([])));
  assert.match(empty.text, /No Pods Yet/u);
  assert.equal(empty.createButton, true);

  const listed = await renderPodsList((socket) => socket.push(snapshotWithPods([podA])));
  assert.match(listed.text, /Pod A/u);
  assert.doesNotMatch(listed.text, /No Pods Yet|Loading/u);
});

test("the New Pod dialog confirms with Create Pod at every selection count and keeps it while creating", async () => {
  const container = domWindow.document.createElement("div") as unknown as HTMLDivElement;
  domWindow.document.body.append(container as never);
  const root = createRoot(container);
  const socket = new FakeSocket();
  const connection: UiConnectionRuntime = {
    instanceId: "new-pod", runtimeKey: "new-pod:1", createSocket: () => socket, close() {},
  };
  const client = { ...api, createPod: pending } as unknown as ApiClient;
  const navigation: ViewNavigation = { current: () => ({ name: "pods" }), push() {}, listen: () => () => {} };
  const dialog = () => domWindow.document.querySelector('[role="dialog"]') as unknown as HTMLElement;
  const confirm = () => buttonNamed(dialog(), /^Create Pod$/u);
  const sessionBox = (id: string) => [...dialog().querySelectorAll('input[type="checkbox"]')]
    .find((box) => box.closest("label")?.textContent?.includes(`Session ${id}`)) as HTMLInputElement;
  try {
    await act(async () => root.render(
      <ApiProvider client={client}>
        <StoreProvider connection={connection} navigation={navigation}>
          <NewPodDialog onClose={() => {}} />
        </StoreProvider>
      </ApiProvider>,
    ));
    await act(async () => socket.push({ ...snapshotWithPods([]), sessions: ["one", "two"].map(session) }));
    const titleField = dialog().querySelector("input:not([type])") as HTMLInputElement;
    await act(async () => fireDomEvent.change(titleField, { target: { value: "Release Pod" } }));

    // One verb across the "New Pod" trigger, the "New Pod" title and this confirm (§17.2), and no
    // count in the label, so it never reads "1 members".
    assert.equal(confirm().disabled, true, "0 selected");
    await act(async () => sessionBox("one").click());
    assert.equal(confirm().disabled, true, "1 selected");
    await act(async () => sessionBox("two").click());
    assert.equal(confirm().disabled, false, "2 selected");
    assert.doesNotMatch(dialog().textContent ?? "", /members/u);

    // Creating keeps the label and shows the spinner instead (§3.1), announcing progress aside.
    await act(async () => confirm().click());
    assert.equal(confirm().getAttribute("aria-busy"), "true");
    assert.equal(dialog().querySelector('[role="status"]')?.textContent, "Creating the pod…");
    assert.doesNotMatch(dialog().textContent ?? "", /Creating…/u);
  } finally {
    await act(async () => root.unmount());
    container.remove();
  }
});
