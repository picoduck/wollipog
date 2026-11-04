import { fireDomEvent } from "./test-dom-events.js";
import assert from "node:assert/strict";
import test, { describe } from "node:test";
import React, { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { Window } from "happy-dom";
import type {
  PodArbitrationMode,
  PodContextEntry,
  PodOrchestrationStatus,
  PodReconciliation,
  PodView,
  RunnerView,
  SessionView,
  UiSnapshotMessage,
} from "@wollipog/protocol";
import { api, type ApiClient } from "../api.js";
import { ApiProvider } from "../api-context.js";
import { viewTitle, type View, type ViewNavigation } from "../navigation.js";
import { StoreProvider, useStoreSelector } from "../store.js";
import { UI_SOCKET_OPEN, type UiConnectionRuntime, type UiSocket } from "../ui-transport.js";
import { FeedbackContext } from "./FeedbackProvider.js";
import { NewPodDialog } from "./NewPodDialog.js";
import { PodDetail, PodsView } from "./PodsView.js";
import { installDomTestCleanup } from "../dom-test-cleanup.js";
import { assertNoDomNode } from "../dom-test-assertions.js";

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

function type(textarea: HTMLTextAreaElement, value: string): void {
  Object.getOwnPropertyDescriptor(domWindow.HTMLTextAreaElement.prototype, "value")?.set?.call(textarea, value);
  fireDomEvent.change(textarea, { target: textarea });
}

test("a direct pod-to-pod route change starts from the new pod's own draft, errors and relay results", async () => {
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
    relayPod: async () => ({
      pod: podA, sessions: [],
      receipts: [{ sessionId: "a1", status: "delivered" }, { sessionId: "a2", status: "failed", error: "runner went offline" }],
    }),
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

    const huddle = () => section(container, "Huddle");
    const relayField = () => huddle().querySelector("textarea") as HTMLTextAreaElement;
    const contextBox = () => huddle().querySelector('.pod-huddle-entry input[type="checkbox"]') as HTMLInputElement;
    const failureNotice = () => [...huddle().querySelectorAll('[role="alert"]')]
      .find((notice) => notice.textContent?.includes("Couldn't Relay to Every Member"));

    // Relay once so pod A has a member that missed it, then leave a failed note and a selected
    // entry behind. Automatic turns keep their draft in their own dialog.
    await act(async () => contextBox().click());
    await act(async () => type(relayField(), "Relayed from pod A"));
    await act(async () => buttonNamed(huddle(), /^Relay to 2$/u).click());
    assert.ok(failureNotice(), "pod A shows each member's result");
    await act(async () => contextBox().click());
    await act(async () => type(relayField(), "Pod A draft"));
    await act(async () => buttonNamed(huddle(), /^Save Note$/u).click());

    assert.equal(relayField().value, "Pod A draft");
    assert.match(huddle().textContent ?? "", /The note wasn't saved\./u);
    assert.equal(huddle().querySelectorAll(".pod-huddle-entry.is-selected").length, 1);

    await act(async () => navigation.jumpTo(podB.id));
    await act(async () => { await new Promise((resolve) => setTimeout(resolve, 0)); });

    assert.equal(container.querySelector(".detail-bar-title")?.textContent, "Pod B");
    assert.equal(relayField().value, "");
    assert.doesNotMatch(huddle().textContent ?? "", /The note wasn't saved/u);
    assert.equal(failureNotice(), undefined, "no results carry over");
    assert.equal(huddle().querySelectorAll(".pod-huddle-entry.is-selected").length, 0);
  } finally {
    await act(async () => root.unmount());
    container.remove();
  }
});

interface PodsListFixture {
  container: HTMLDivElement;
  socket: FakeSocket;
  /** Every view the list asked to open. */
  opened: View[];
  unmount: () => Promise<void>;
}

/** Mounts the Pods list with a socket the test drives: nothing arrives until it says so. */
async function mountPodsList(drive: (socket: FakeSocket) => void): Promise<PodsListFixture> {
  const container = domWindow.document.createElement("div") as unknown as HTMLDivElement;
  domWindow.document.body.append(container as never);
  const root = createRoot(container);
  const socket = new FakeSocket();
  const connection: UiConnectionRuntime = {
    instanceId: "pods-list", runtimeKey: "pods-list:1",
    createSocket: (() => { let first = true; return () => { if (!first) return new FakeSocket(); first = false; return socket; }; })(),
    close() {},
  };
  const opened: View[] = [];
  const navigation: ViewNavigation = { current: () => ({ name: "pods" }), push: (view) => { opened.push(view); }, listen: () => () => {} };
  await act(async () => root.render(
    <ApiProvider client={api}>
      <StoreProvider connection={connection} navigation={navigation}>
        <PodsView onNewPod={() => {}} />
      </StoreProvider>
    </ApiProvider>,
  ));
  await act(async () => drive(socket));
  return {
    container, socket, opened,
    unmount: async () => {
      await act(async () => root.unmount());
      container.remove();
    },
  };
}

/** Renders the Pods list once and reads what it offers. */
async function renderPodsList(
  drive: (socket: FakeSocket) => void,
): Promise<{ text: string; createButton: boolean; headerCreateButton: boolean; newPodButtons: number }> {
  const fixture = await mountPodsList(drive);
  try {
    const { container } = fixture;
    return {
      text: container.textContent ?? "",
      createButton: [...container.querySelectorAll(".state .actions button")].some((button) => button.textContent === "New Pod"),
      headerCreateButton: [...container.querySelectorAll(".page-header button")].some((button) => button.textContent === "New Pod"),
      newPodButtons: [...container.querySelectorAll("button")].filter((button) => button.textContent === "New Pod").length,
    };
  } finally {
    await fixture.unmount();
  }
}

const snapshotWithPods = (pods: PodView[], sessions: SessionView[] = []): UiSnapshotMessage => ({
  type: "snapshot",
  capabilities: { sessionSubscriptions: false, boundedDelivery: false, paginatedSessionHistory: false, projects: true },
  runners: [runner], boxes: [], projects: [], sessions, runs: [], pods,
});

test("before the first snapshot the Pods list is loading, not empty", async () => {
  const list = await renderPodsList(() => {});
  assert.match(list.text, /Loading Pods…/u);
  assert.doesNotMatch(list.text, /No Pods Yet/u);
  assert.equal(list.createButton, false);
  // The header keeps New Pod until the empty state can offer it.
  assert.equal(list.headerCreateButton, true);
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

test("with no pods after the snapshot, exactly one New Pod renders, in the empty state", async () => {
  const empty = await renderPodsList((socket) => socket.push(snapshotWithPods([])));
  assert.match(empty.text, /No Pods Yet/u);
  assert.match(empty.text, /Group two or more sessions so their agents can share notes and merge each other's work\./u);
  assert.doesNotMatch(empty.text, /runners/u, "the body does not talk about runners");
  assert.equal(empty.createButton, true);
  assert.equal(empty.headerCreateButton, false, "the empty state owns the one create action");
  assert.equal(empty.newPodButtons, 1);

  const listed = await renderPodsList((socket) => socket.push(snapshotWithPods([podA])));
  assert.match(listed.text, /Pod A/u);
  assert.doesNotMatch(listed.text, /No Pods Yet|Loading/u);
  assert.equal(listed.headerCreateButton, true);
  assert.equal(listed.newPodButtons, 1);
});

describe("Pods list rows (#2979)", () => {
  const minute = 60_000;
  const member = (sessionId: string) => ({ sessionId, joinedAt: 1, role: "worker" as const, contextTokenBudget: null, lastContextSeq: 0 });
  const orchestration = (mode: PodArbitrationMode, status: PodOrchestrationStatus, turnsUsed = 0) => ({
    policy: { mode, contextTokenBudget: 8_192, summaryTokenBudget: 1_024, maxTurns: 12, maxRepeatedOutputs: 2 },
    state: { status, turnsUsed, updatedAt: 1 },
  });
  const idle: PodView = {
    id: "pod_idle_3f1a", title: "Idle pod", objective: "Tighten the retry helper", status: "active",
    members: [member("s_idle_1"), member("s_idle_2"), member("s_idle_3")],
    orchestration: orchestration("round_robin", "idle"), createdAt: 1, updatedAt: Date.now() - 2 * 60 * minute,
  };
  const turns: PodView = {
    id: "pod_turns_7b2c", title: "Turns pod", objective: "", status: "active",
    members: [member("s_turns_1"), member("s_turns_2")],
    orchestration: orchestration("lead_driven", "running", 3), createdAt: 1, updatedAt: Date.now() - 5 * minute,
  };
  const manual: PodView = {
    id: "pod_manual_0d4e", title: "Manual pod", objective: "", status: "active",
    members: [member("s_manual_1"), member("s_manual_2")], createdAt: 1, updatedAt: Date.now() - 30 * minute,
  };
  const closed: PodView = {
    id: "pod_closed_91aa", title: "Closed pod", objective: "Ship the parser", status: "closed",
    members: [member("s_closed_1"), member("s_closed_2")],
    orchestration: orchestration("event_triggered", "stopped", 4), createdAt: 1, updatedAt: Date.now() - minute,
  };
  const pods = [idle, turns, manual, closed];
  const sessions = pods.flatMap((candidate) => candidate.members.map((entry) => session(entry.sessionId)));
  const ids = [...pods.map((candidate) => candidate.id), ...sessions.map((candidate) => candidate.id), runner.runnerId];

  const rowNamed = (container: HTMLDivElement, title: string) =>
    [...container.querySelectorAll<HTMLButtonElement>(".surface > .row.row-2")].find((row) => row.querySelector(".row-title")?.textContent === title)!;
  const meta = (row: Element) => [...row.querySelectorAll(".list-row-meta > span")].map((span) => span.textContent);
  const badge = (container: HTMLDivElement, title: string) => rowNamed(container, title).querySelector(".status");
  const loaded = (list: PodView[] = pods, members: SessionView[] = sessions) =>
    mountPodsList((socket) => socket.push(snapshotWithPods(list, members)));

  test("each row is one two-line row with the pods icon, the title, plain meta and the last update, and no ids", async () => {
    const fixture = await loaded();
    try {
      const rows = [...fixture.container.querySelectorAll<HTMLButtonElement>(".surface > .row")];
      assert.equal(rows.length, 4);
      for (const row of rows) {
        assert.ok(row.classList.contains("row-2"), "a 56px two-line row (§5.2)");
        assert.ok(row.querySelector(".row-icon svg"), "a leading 16px icon");
        assert.ok(row.querySelectorAll(".status").length <= 1, "at most one badge");
        assert.ok(row.querySelector(".row-trail > time[datetime]"), "the last update trails");
        assert.doesNotMatch(row.querySelector(".list-row-meta")?.textContent ?? "", /·/u, "meta is spaced, not dotted");
        for (const id of ids) assert.ok(!row.outerHTML.includes(id), `no row carries ${id}`);
      }
      // Open pods by last update, then closed pods, even one updated more recently.
      assert.deepEqual(rows.map((row) => row.querySelector(".row-title")?.textContent), [turns.title, manual.title, idle.title, closed.title]);

      assert.deepEqual(meta(rowNamed(fixture.container, idle.title)), ["3 members", "Round robin", "Tighten the retry helper"]);
      assert.equal(rowNamed(fixture.container, idle.title).querySelector(".row-trail time")?.textContent, "2h ago");
      assert.deepEqual(meta(rowNamed(fixture.container, turns.title)), ["2 members", "Lead decides", "turn 3 of 12", "No objective"]);
      // A pod from a control plane without orchestration is relayed by hand.
      assert.deepEqual(meta(rowNamed(fixture.container, manual.title)), ["2 members", "Manual relay", "No objective"]);
      assert.deepEqual(meta(rowNamed(fixture.container, closed.title)), ["2 members", "When a member finishes", "Ship the parser"]);
      assert.ok(rowNamed(fixture.container, manual.title).querySelector(".list-row-fill > .pod-row-no-objective"),
        "No objective is faint, not content");
      assertNoDomNode(rowNamed(fixture.container, idle.title).querySelector(".pod-row-no-objective"), "a real objective is not faint");
      assert.doesNotMatch(fixture.container.textContent ?? "", /Manual collaboration pod|Members|Round Robin|Lead Decides/u);
    } finally {
      await fixture.unmount();
    }
  });

  test("an idle open pod shows no badge, running turns show Running, and a closed pod shows Closed", async () => {
    const fixture = await loaded();
    try {
      assertNoDomNode(badge(fixture.container, idle.title), "an idle open pod: no badge");
      assertNoDomNode(badge(fixture.container, manual.title), "an idle manual pod: no badge");
      const running = badge(fixture.container, turns.title);
      assert.equal(running?.textContent, "Running");
      assert.ok(running?.classList.contains("t-info"));
      assert.ok(running?.classList.contains("pulse"));
      const shut = badge(fixture.container, closed.title);
      assert.equal(shut?.textContent, "Closed");
      assert.ok(shut?.classList.contains("t-neutral"));
      assert.doesNotMatch(fixture.container.textContent ?? "", /Active/u, "no row says Active");

      // A member's own turn is something happening too.
      const working = sessions.map((candidate) => candidate.id === "s_manual_2" ? { ...candidate, status: "running" } as SessionView : candidate);
      await act(async () => fixture.socket.push(snapshotWithPods(pods, working)));
      assert.equal(badge(fixture.container, manual.title)?.textContent, "Running");
      assert.deepEqual(meta(rowNamed(fixture.container, manual.title)), ["2 members", "Manual relay", "No objective"],
        "no turn count without automatic turns");
    } finally {
      await fixture.unmount();
    }
  });

  test("the newest merge's conflict or failure is the badge, and a later applied merge clears it", async () => {
    const receipt = (reconciliationId: string, status: PodReconciliation["status"]): PodReconciliation => ({
      reconciliationId, podId: idle.id, sourceSessionId: "s_idle_1", targetSessionId: "s_idle_2", actorId: "local", status, createdAt: 1,
    });
    const fixture = await loaded([{ ...idle, reconciliations: [receipt("r2", "conflicted"), receipt("r1", "applied")] }, turns]);
    try {
      assert.equal(badge(fixture.container, idle.title)?.textContent, "Conflicted");
      assert.ok(badge(fixture.container, idle.title)?.classList.contains("t-warning"));
      await act(async () => fixture.socket.push(snapshotWithPods([
        { ...idle, reconciliations: [receipt("r3", "failed"), receipt("r2", "conflicted")] },
        { ...turns, reconciliations: [receipt("r4", "conflicted")] },
      ], sessions)));
      assert.equal(badge(fixture.container, idle.title)?.textContent, "Failed");
      assert.ok(badge(fixture.container, idle.title)?.classList.contains("t-danger"));
      assert.equal(badge(fixture.container, turns.title)?.textContent, "Conflicted", "a conflict needs the person more than running turns");
      await act(async () => fixture.socket.push(snapshotWithPods([
        { ...idle, reconciliations: [receipt("r5", "applied"), receipt("r3", "failed")] },
      ], sessions)));
      assertNoDomNode(badge(fixture.container, idle.title), "an applied merge clears the earlier failure");
    } finally {
      await fixture.unmount();
    }
  });

  test("offline with pods loaded, the rows stay dimmed under Reconnecting… and still open their pod", async () => {
    const fixture = await loaded();
    try {
      await act(async () => fixture.socket.onclose?.({ code: 1006 }));
      const page = fixture.container.querySelector(".page")!;
      const line = page.querySelector('[role="status"]');
      assert.equal(line?.textContent, "Reconnecting…");
      const stale = page.querySelector(".is-stale");
      assert.ok(stale, "the rows are wrapped in StaleContent");
      assert.equal(line!.compareDocumentPosition(stale!) & domWindow.Node.DOCUMENT_POSITION_FOLLOWING, domWindow.Node.DOCUMENT_POSITION_FOLLOWING,
        "the line sits above the rows");
      assert.ok(!stale!.contains(line), "the line is not dimmed with them");
      assert.equal(stale!.querySelectorAll(".row").length, 4);
      assert.doesNotMatch(page.textContent ?? "", /No Pods Yet|Unavailable/u, "never an empty state");
      assert.equal(badge(fixture.container, turns.title)?.textContent, "Running", "last-known status stays");
      await act(async () => rowNamed(fixture.container, closed.title).click());
      assert.deepEqual(fixture.opened.at(-1), { name: "pod", id: closed.id });
    } finally {
      await fixture.unmount();
    }
  });
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
