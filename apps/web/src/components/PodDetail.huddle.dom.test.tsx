import { fireDomEvent } from "./test-dom-events.js";
import assert from "node:assert/strict";
import { describe, test } from "node:test";
import React, { act } from "react";
import { createRoot } from "react-dom/client";
import { Window } from "happy-dom";
import type {
  PodContextEntry,
  PodOrchestrationState,
  PodReconciliation,
  PodView,
  RelayPodRequest,
  RelayPodResult,
  RunnerView,
  SessionView,
  UiSnapshotMessage,
} from "@wollipog/protocol";
import { api, type ApiClient } from "../api.js";
import { ApiProvider } from "../api-context.js";
import type { View, ViewNavigation } from "../navigation.js";
import { StoreProvider, useStoreSelector } from "../store.js";
import { UI_SOCKET_OPEN, type UiConnectionRuntime, type UiSocket } from "../ui-transport.js";
import { FeedbackProvider } from "./FeedbackProvider.js";
import { PodDetail } from "./PodsView.js";
import { installDomTestCleanup } from "../dom-test-cleanup.js";
import { assertNoDomNode } from "../dom-test-assertions.js";
import { ViewerIdentityContext, type ViewerIdentity } from "../resolver-identity.js";

/**
 * The pod page's layout (#2981): member columns beside the Huddle, its log and one relay composer,
 * the results of a relay and Retry Failed, a closed pod, and Huddle and member tabs on a phone.
 */
const domWindow = new Window({ url: "http://localhost/", width: 1440, height: 900 });
installDomTestCleanup(domWindow);
for (const [name, value] of Object.entries({
  window: domWindow, document: domWindow.document, navigator: domWindow.navigator,
  localStorage: domWindow.localStorage, Element: domWindow.Element, HTMLElement: domWindow.HTMLElement,
  HTMLButtonElement: domWindow.HTMLButtonElement, HTMLInputElement: domWindow.HTMLInputElement,
  HTMLSelectElement: domWindow.HTMLSelectElement, HTMLTextAreaElement: domWindow.HTMLTextAreaElement,
  Node: domWindow.Node, Event: domWindow.Event, InputEvent: domWindow.InputEvent, MouseEvent: domWindow.MouseEvent,
  KeyboardEvent: domWindow.KeyboardEvent, FocusEvent: domWindow.FocusEvent, MutationObserver: domWindow.MutationObserver,
  requestAnimationFrame: domWindow.requestAnimationFrame.bind(domWindow),
  cancelAnimationFrame: domWindow.cancelAnimationFrame.bind(domWindow),
  getComputedStyle: domWindow.getComputedStyle.bind(domWindow),
  React, IS_REACT_ACT_ENVIRONMENT: true,
  ResizeObserver: class { observe() {} unobserve() {} disconnect() {} },
})) Object.defineProperty(globalThis, name, { configurable: true, writable: true, value });

const runner = {
  runnerId: "runner-pods", hostname: "runner-host", os: "linux", version: "1", status: "online",
  agents: [{ id: "codex", name: "Codex", command: "codex", args: [], env: {}, driver: "codex", available: true }],
  workspaces: [], connectedAt: 1, lastSeen: 1, protocolVersion: 141,
} as RunnerView;

function session(id: string, title: string, agentName: string, patch: Partial<SessionView> = {}): SessionView {
  return {
    id, runnerId: runner.runnerId, workspaceId: "workspace", workspaceName: "Workspace", projectId: null,
    agentId: agentName.toLowerCase(), agentName, title, status: "idle", column: "review",
    runId: null, useWorktree: true, worktreePath: `/worktrees/${id}`, archived: false, createdAt: 1, updatedAt: 1,
    lastEventAt: null, messageCount: 0, eventEpoch: 0, preview: null, pendingApproval: null,
    driver: "claude-code", model: null, effort: null, permissionMode: null,
    tokensIn: 0, tokensOut: 0, costUsd: 0, adopted: false,
    ...patch,
  } as SessionView;
}

const members = (patch: Record<string, Partial<SessionView>> = {}) => [
  session("lead", "Lead: plan the migration", "Claude", patch.lead),
  session("worker", "Worker: migrate call sites", "Codex", patch.worker),
  session("reviewer", "Reviewer: check the sites", "Gemini", patch.reviewer),
];

function pod(patch: Partial<PodView> = {}, state: Partial<PodOrchestrationState> = {}): PodView {
  return {
    id: "pod-1", title: "Migration Pod", objective: "Migrate call sites", status: "active", createdAt: 1, updatedAt: 1,
    members: [
      { sessionId: "lead", joinedAt: 1, role: "lead", contextTokenBudget: null, lastContextSeq: 0 },
      { sessionId: "worker", joinedAt: 1, role: "worker", contextTokenBudget: null, lastContextSeq: 0 },
      { sessionId: "reviewer", joinedAt: 1, role: "reviewer", contextTokenBudget: null, lastContextSeq: 0 },
    ],
    orchestration: {
      policy: { mode: "manual", contextTokenBudget: 4_096, summaryTokenBudget: 512, maxTurns: 12, maxRepeatedOutputs: 2 },
      state: { status: "idle", turnsUsed: 0, updatedAt: 1, ...state },
    },
    reconciliations: [],
    ...patch,
  };
}

const NOW = Date.now();
function entry(seq: number, content: string, source: PodContextEntry["source"] = { kind: "human", actorId: "local" }): PodContextEntry {
  return { id: `entry-${seq}`, podId: "pod-1", seq, ts: NOW - (10 - seq) * 60_000, source, content };
}
const fromWorker = (seq: number, content: string) =>
  entry(seq, content, { kind: "session", sessionId: "worker", sessionTitle: "Worker: migrate call sites", agentLabel: "Codex", fromSeq: 1, toSeq: 2 });

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
/** A personal installation's viewer, so the person's own notes read "You". */
const soloViewer: ViewerIdentity = { userId: "local", shared: false, names: new Map() };
const settle = () => act(async () => { for (let index = 0; index < 8; index += 1) await new Promise((resolve) => setTimeout(resolve, 0)); });
const body = () => domWindow.document.body as unknown as HTMLElement;

/** The pod route as App renders it, with the member the URL names. */
function PodRoute() {
  const view = useStoreSelector((state) => state.view);
  return view.name === "pod" ? <PodDetail podId={view.id} member={view.member} /> : null;
}

async function setViewport(width: number, height: number) {
  await act(async () => {
    domWindow.happyDOM.setViewport({ width, height });
    domWindow.dispatchEvent(new domWindow.Event("resize"));
  });
}

let sequence = 0;
async function mount(pods: PodView[], sessions: SessionView[], overrides: Partial<ApiClient> = {}, opening: View = { name: "pod", id: "pod-1" }) {
  const container = domWindow.document.createElement("div") as unknown as HTMLDivElement;
  domWindow.document.body.append(container as never);
  const root = createRoot(container);
  // StrictMode opens the store's socket twice; the snapshot goes to the one still open.
  let socket = new FakeSocket();
  sequence += 1;
  const connection: UiConnectionRuntime = {
    instanceId: `pod-huddle-${sequence}`, runtimeKey: `pod-huddle-${sequence}:1`, createSocket: () => (socket = new FakeSocket()), close() {},
  };
  const client = {
    ...api,
    getSessionEventPage: pending,
    podContext: async () => ({ entries: [] }),
    ...overrides,
  } as unknown as ApiClient;
  const replaced: View[] = [];
  let current = opening;
  const navigation: ViewNavigation = {
    current: () => current,
    push(view) { current = view; },
    replace(view) { current = view; replaced.push(view); },
    listen: () => () => {},
  };
  await act(async () => root.render(
    <React.StrictMode>
      <ApiProvider client={client}>
        <FeedbackProvider>
          <ViewerIdentityContext.Provider value={soloViewer}>
            <StoreProvider connection={connection} navigation={navigation}>
              <PodRoute />
            </StoreProvider>
          </ViewerIdentityContext.Provider>
        </FeedbackProvider>
      </ApiProvider>
    </React.StrictMode>,
  ));
  await act(async () => socket.push({
    type: "snapshot",
    capabilities: { sessionSubscriptions: false, boundedDelivery: false, paginatedSessionHistory: false, projects: true },
    runners: [runner], boxes: [], projects: [], runs: [], pods, sessions,
  }));
  await settle();
  return {
    container,
    replaced,
    unmount: async () => {
      await act(async () => root.unmount());
      container.remove();
    },
  };
}

const huddle = (scope: ParentNode = body()) => {
  const found = scope.querySelector<HTMLElement>(".pod-huddle");
  assert.ok(found, "the Huddle is rendered");
  return found;
};
const buttonNamed = (scope: ParentNode, name: string | RegExp) =>
  [...scope.querySelectorAll<HTMLButtonElement>("button")]
    .find((button) => typeof name === "string" ? button.textContent?.trim() === name : name.test(button.textContent?.trim() ?? "")) ?? null;
const entryBox = (text: string) => {
  const row = [...huddle().querySelectorAll<HTMLElement>(".pod-huddle-entry")].find((candidate) => candidate.textContent?.includes(text));
  assert.ok(row, `the entry "${text}" is listed`);
  return row.querySelector<HTMLInputElement>('input[type="checkbox"]')!;
};
const relayToBox = (label: string) => {
  const group = huddle().querySelector<HTMLElement>(".pod-recipients")!;
  const box = [...group.querySelectorAll<HTMLLabelElement>("label.checkbox")].find((candidate) => candidate.textContent === label);
  assert.ok(box, `Relay To lists ${label}`);
  return box.querySelector<HTMLInputElement>('input[type="checkbox"]')!;
};
const toastText = () => [...body().querySelectorAll(".toast")].map((toast) => toast.textContent).join(" ");

function typeInto(field: HTMLTextAreaElement, value: string) {
  Object.getOwnPropertyDescriptor(domWindow.HTMLTextAreaElement.prototype, "value")?.set?.call(field, value);
  fireDomEvent.change(field, { target: field });
}

test("the pod page lays out the objective and the member columns beside the Huddle, with no relay or log panel above them", async () => {
  const view = await mount([pod()], members(), {
    podContext: async () => ({ entries: [entry(1, "Use the retry helper everywhere."), fromWorker(2, "Call sites migrated.")] }),
  });
  try {
    const layout = view.container.querySelector(".pod-layout");
    assert.ok(layout, "the desktop layout");
    assert.equal(layout.querySelector(".pod-objective")?.textContent, "Migrate call sites");
    const columns = [...layout.querySelectorAll<HTMLElement>('.compare[aria-label="Members"] > .compare-member')];
    assert.deepEqual(columns.map((column) => column.querySelector(".compare-member-agent")?.textContent), ["Claude", "Codex", "Gemini"]);
    assertNoDomNode(view.container.querySelector(".compare-grid"), "no .compare-grid");
    assertNoDomNode(view.container.querySelector('[style*="grid-template-columns"]'), "no inline grid template");
    assertNoDomNode(view.container.querySelector('[class*="pod-relay"]'), "no relay panel");
    assertNoDomNode(view.container.querySelector('[class*="pod-context"], [class*="pod-receipt"]'), "no context panel or receipt spans");
    assert.equal([...view.container.querySelectorAll("select")].filter((select) => !select.closest(".pod-member-setting")).length, 0,
      "no Add Member select");
    for (const column of columns) {
      assert.equal(column.querySelectorAll('input[type="checkbox"]').length, 0, "no Relay checkbox in a member column");
    }
    assert.doesNotMatch(view.container.textContent ?? "", /Manual collaboration pod|Append-only|Relay to Selected/u);

    const aside = huddle(view.container);
    assert.equal(aside.tagName, "ASIDE");
    assert.equal(aside.getAttribute("aria-label"), "Huddle");
    assert.equal(aside.querySelector(".pod-huddle-title")?.textContent, "Huddle");
    assert.equal(aside.querySelector(".pod-huddle-head .count")?.textContent, "2");
    assertNoDomNode(buttonNamed(aside, "Load Earlier"), "no Load Earlier without older entries");
    // Newest last, each named by its source and with its time in words.
    const rows = [...aside.querySelectorAll(".pod-huddle-entry")];
    assert.deepEqual(rows.map((row) => row.querySelector(".pod-huddle-entry-source")?.textContent), ["You", "Worker · Codex"]);
    assert.deepEqual(rows.map((row) => row.querySelector("time")?.textContent), ["9m ago", "8m ago"]);
    assert.equal(rows[1]!.querySelector('input[type="checkbox"]')!.getAttribute("aria-label"), "Include in Next Relay: Worker · Codex, 8m ago");
    // The composer is last in the panel, after the log.
    assert.equal(aside.lastElementChild?.className, "pod-composer");
    assert.equal(aside.querySelector<HTMLTextAreaElement>("textarea")!.placeholder, "Write a note for the huddle…");
  } finally {
    await view.unmount();
  }
});

test("an empty log invites a note and a pod without an objective says so faintly", async () => {
  const view = await mount([pod({ objective: "" })], members());
  try {
    assert.equal(huddle().querySelector(".pod-huddle-empty")?.textContent, "No notes yet. Save a note, or share a member's latest answer.");
    const objective = view.container.querySelector(".pod-objective")!;
    assert.equal(objective.textContent, "No objective");
    assert.ok(objective.classList.contains("is-empty"));
  } finally {
    await view.unmount();
  }
});

test("two entries, two members and a note send one relayPod with them; success is a toast", async () => {
  const requests: RelayPodRequest[] = [];
  const view = await mount([pod()], members(), {
    podContext: async () => ({ entries: [entry(1, "First note."), fromWorker(2, "Second note."), entry(3, "Third note.")] }),
    relayPod: async (_id: string, request: RelayPodRequest) => {
      requests.push(request);
      return {
        pod: pod(), sessions: [],
        receipts: request.sessionIds!.map((sessionId) => ({ sessionId, status: "delivered" as const })),
        appendedEntry: entry(4, request.text ?? ""),
      } satisfies RelayPodResult;
    },
  });
  try {
    // Every member starts checked; uncheck the reviewer, then select two entries out of order.
    assert.equal(buttonNamed(huddle(), /^Relay/u)?.textContent, "Relay to 3");
    await act(async () => relayToBox("Reviewer · Gemini").click());
    await act(async () => entryBox("Third note.").click());
    // A click on the row, not its box, selects it too.
    await act(async () => huddle().querySelectorAll<HTMLElement>(".pod-huddle-text")[0]!.click());
    assert.ok(entryBox("First note.").checked, "the row's click checked its box");
    await act(async () => typeInto(huddle().querySelector("textarea")!, "  Please align on the helper.  "));
    const relay = buttonNamed(huddle(), "Relay to 2")!;
    assert.equal(relay.disabled, false);
    assert.ok(relay.classList.contains("primary"));
    await act(async () => relay.click());
    await settle();

    assert.equal(requests.length, 1, "one relayPod request");
    assert.deepEqual(requests[0], {
      text: "Please align on the helper.",
      sessionIds: ["lead", "worker"],
      contextEntryIds: ["entry-1", "entry-3"],
    }, "the entries in the log's order, the note and the two checked members");
    assert.match(toastText(), /Relayed to 2 members/u);
    assert.equal(huddle().querySelector("textarea")!.value, "", "the draft clears");
    assert.equal(huddle().querySelectorAll(".pod-huddle-entry.is-selected").length, 0, "the selection clears");
    assert.match(huddle().textContent ?? "", /Please align on the helper\./u, "the note joins the log");
    assertNoDomNode(huddle().querySelector('[role="alert"]'), "no failure notice");
  } finally {
    await view.unmount();
  }
});

/** A promise the test settles itself, so it can act while a request is in flight. */
function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((settle) => { resolve = settle; });
  return { promise, resolve };
}

test("an edit made while Save Note or Relay is in flight survives the request; an unchanged draft clears (CR-1.1)", async () => {
  const saving = deferred<{ entry: PodContextEntry; created: boolean; pod: PodView }>();
  const relaying = deferred<RelayPodResult>();
  const view = await mount([pod()], members(), {
    podContext: async () => ({ entries: [entry(1, "First note."), entry(2, "Second note.")] }),
    appendPodContext: () => saving.promise,
    relayPod: () => relaying.promise,
  });
  const field = () => huddle().querySelector("textarea")!;
  try {
    // Save Note: submit A, type B while it saves, then let it save A.
    await act(async () => typeInto(field(), "Draft A"));
    await act(async () => buttonNamed(huddle(), "Save Note")!.click());
    assert.equal(field().disabled, false, "the field stays editable while the note saves");
    await act(async () => typeInto(field(), "Draft B"));
    await act(async () => saving.resolve({ entry: entry(3, "Draft A"), created: true, pod: pod() }));
    await settle();
    assert.equal(field().value, "Draft B", "the newer draft was never saved, so it stays");

    // Relay: submit B with the first entry, then type C and select the second entry while it runs.
    await act(async () => entryBox("First note.").click());
    await act(async () => buttonNamed(huddle(), "Relay to 3")!.click());
    await act(async () => typeInto(field(), "Draft C"));
    await act(async () => entryBox("Second note.").click());
    await act(async () => relaying.resolve({
      pod: pod(), sessions: [],
      receipts: ["lead", "worker", "reviewer"].map((sessionId) => ({ sessionId, status: "delivered" as const })),
      appendedEntry: entry(4, "Draft B"),
    }));
    await settle();
    assert.equal(field().value, "Draft C", "the newer draft was never relayed, so it stays");
    assert.equal(entryBox("First note.").checked, false, "the relayed entry clears");
    assert.equal(entryBox("Second note.").checked, true, "an entry selected while relaying stays selected");
  } finally {
    await view.unmount();
  }

  const unchanged = await mount([pod()], members(), {
    appendPodContext: async () => ({ entry: entry(1, "Saved as typed"), created: true, pod: pod() }),
  });
  try {
    await act(async () => typeInto(huddle().querySelector("textarea")!, "Saved as typed"));
    await act(async () => buttonNamed(huddle(), "Save Note")!.click());
    await settle();
    assert.equal(huddle().querySelector("textarea")!.value, "", "a draft left as it was sent clears");
  } finally {
    await unchanged.unmount();
  }
});

test("Relay is disabled with its reason while automatic turns run, and when there is nothing to relay", async () => {
  const view = await mount([pod({}, { status: "running", runId: "run-1", turnsUsed: 2, currentSessionId: "worker" })], members(), {
    podContext: async () => ({ entries: [entry(1, "First note.")] }),
  });
  try {
    await act(async () => typeInto(huddle().querySelector("textarea")!, "A note"));
    const relay = buttonNamed(huddle(), "Relay to 3")!;
    assert.equal(relay.disabled, true);
    const reason = huddle().querySelector(".pod-composer-reason")!;
    assert.equal(reason.textContent, "Automatic turns are running.");
    assert.equal(relay.getAttribute("aria-describedby"), reason.id);
    assert.equal(buttonNamed(huddle(), "Save Note")!.disabled, false, "a note can still be saved");
  } finally {
    await view.unmount();
  }

  const idle = await mount([pod()], members());
  try {
    assert.equal(buttonNamed(huddle(), "Relay to 3")!.disabled, true);
    assert.equal(huddle().querySelector(".pod-composer-reason")?.textContent, "Write a note or select entries to relay.");
    await act(async () => typeInto(huddle().querySelector("textarea")!, "A note"));
    assert.equal(buttonNamed(huddle(), "Relay to 3")!.disabled, false);
    assertNoDomNode(huddle().querySelector(".pod-composer-reason"), "no reason once the relay can go");
  } finally {
    await idle.unmount();
  }
});

test("a relay that misses a member shows each member's result, and Retry Failed retries only that member", async () => {
  const requests: RelayPodRequest[] = [];
  const view = await mount([pod()], members(), {
    podContext: async () => ({ entries: [entry(1, "First note.")] }),
    relayPod: async (_id: string, request: RelayPodRequest) => {
      requests.push(request);
      const first = requests.length === 1;
      return {
        pod: pod(), sessions: [],
        receipts: request.sessionIds!.map((sessionId) => first && sessionId === "worker"
          ? { sessionId, status: "failed" as const, error: "runner went offline" }
          : { sessionId, status: "delivered" as const }),
        ...(request.text ? { appendedEntry: entry(2, request.text) } : {}),
      } satisfies RelayPodResult;
    },
  });
  try {
    await act(async () => entryBox("First note.").click());
    await act(async () => typeInto(huddle().querySelector("textarea")!, "Ship it"));
    await act(async () => buttonNamed(huddle(), "Relay to 3")!.click());
    await settle();

    const notice = huddle().querySelector<HTMLElement>('.pod-composer [role="alert"]');
    assert.ok(notice, "a danger notice in the composer");
    assert.ok(notice.classList.contains("danger") || notice.className.includes("danger"), "in the danger tone");
    assert.match(notice.textContent ?? "", /Couldn't Relay to Every Member/u);
    const results = [...notice.querySelectorAll(".pod-results > li")].map((row) => row.textContent);
    assert.deepEqual(results, [
      "Lead · ClaudeDelivered",
      "Worker · CodexDelivery Failedrunner went offline",
      "Reviewer · GeminiDelivered",
    ]);
    assert.doesNotMatch(toastText(), /Relayed/u, "no success toast");

    await act(async () => buttonNamed(notice, "Retry Failed")!.click());
    await settle();
    assert.equal(requests.length, 2);
    assert.deepEqual(requests[1], { contextEntryIds: ["entry-1", "entry-2"], sessionIds: ["worker"] },
      "only the failed member, with the note as the entry it became, so it is not logged twice");
    assertNoDomNode(huddle().querySelector('.pod-composer [role="alert"]'), "the notice clears once every member has it");
    assert.match(toastText(), /Relayed to 3 members/u);
  } finally {
    await view.unmount();
  }
});

test("a refused retry keeps the failed member, with the reason it was refused", async () => {
  let calls = 0;
  const view = await mount([pod()], members(), {
    relayPod: async (_id: string, request: RelayPodRequest) => {
      calls += 1;
      if (calls > 1) throw new Error("pod member 'worker' runner is offline");
      return {
        pod: pod(), sessions: [],
        receipts: request.sessionIds!.map((sessionId) => sessionId === "worker"
          ? { sessionId, status: "failed" as const, error: "socket closed" }
          : { sessionId, status: "delivered" as const }),
        appendedEntry: entry(1, request.text ?? ""),
      } satisfies RelayPodResult;
    },
  });
  try {
    await act(async () => typeInto(huddle().querySelector("textarea")!, "Ship it"));
    await act(async () => buttonNamed(huddle(), "Relay to 3")!.click());
    await settle();
    await act(async () => buttonNamed(huddle(), "Retry Failed")!.click());
    await settle();
    const notice = huddle().querySelector<HTMLElement>('.pod-composer [role="alert"]')!;
    assert.match(notice.textContent ?? "", /Worker · CodexDelivery Failedpod member 'worker' runner is offline/u);
    assert.ok(buttonNamed(notice, "Retry Failed"), "Retry Failed stays");
  } finally {
    await view.unmount();
  }
});

test("a relay the control plane refuses keeps the draft and says it didn't run", async () => {
  const view = await mount([pod()], members(), {
    relayPod: async () => { throw new Error("stop pod orchestration before sending a manual relay"); },
  });
  try {
    await act(async () => typeInto(huddle().querySelector("textarea")!, "Keep me"));
    await act(async () => buttonNamed(huddle(), "Relay to 3")!.click());
    await settle();
    assert.match(huddle().querySelector('.pod-composer [role="alert"]')?.textContent ?? "", /The relay didn't run\./u);
    assert.equal(huddle().querySelector("textarea")!.value, "Keep me");
  } finally {
    await view.unmount();
  }
});

test("Load Earlier loads older entries above the current ones and leaves the composer last", async () => {
  const pages: Array<number | undefined> = [];
  const view = await mount([pod()], members(), {
    podContext: async (_id: string, before?: number) => {
      pages.push(before);
      return before === undefined
        ? { entries: [entry(5, "Newer note.")], beforeSeq: 5 }
        : { entries: [entry(3, "Older note.")] };
    },
  });
  try {
    assert.equal(huddle().querySelector(".pod-huddle-head .count")?.textContent, "1+");
    const load = buttonNamed(huddle(), "Load Earlier")!;
    assert.ok(load.classList.contains("sm") && load.classList.contains("ghost"), "a small ghost button");
    await act(async () => load.click());
    await settle();
    assert.deepEqual(pages.slice(-1), [5], "asks for the entries before the oldest one");
    assert.deepEqual([...huddle().querySelectorAll(".pod-huddle-text")].map((text) => text.textContent), ["Older note.", "Newer note."]);
    assertNoDomNode(buttonNamed(huddle(), "Load Earlier"), "no Load Earlier once nothing is older");
    assert.equal(huddle().lastElementChild?.className, "pod-composer");
  } finally {
    await view.unmount();
  }
});

test("the bar's one badge reads Active, Running while a member's turn runs, and Closed", async () => {
  const badge = (container: HTMLElement) => container.querySelector(".detail-bar .status")?.textContent;
  const idle = await mount([pod()], members());
  try {
    assert.equal(badge(idle.container), "Active");
  } finally {
    await idle.unmount();
  }
  const running = await mount([pod()], members({ worker: { status: "running" } }));
  try {
    assert.equal(badge(running.container), "Running");
    assert.ok(running.container.querySelector(".detail-bar .status.pulse, .detail-bar .status [class*='pulse']"), "it pulses");
  } finally {
    await running.unmount();
  }
  const closed = await mount([pod({ status: "closed" })], members());
  try {
    assert.equal(badge(closed.container), "Closed");
  } finally {
    await closed.unmount();
  }
});

const merge = (patch: Partial<PodReconciliation>): PodReconciliation => ({
  reconciliationId: "merge-1", podId: "pod-1", sourceSessionId: "worker", targetSessionId: "lead", actorId: "local",
  status: "applied", sourceHead: "aaaaaaaaaaaaaaaa", targetHead: "bbbbbbbbbbbbbbbb", resultHead: "cccccccccccccccc",
  mergeBase: "dddddddddddddddd", createdAt: NOW - 120_000, completedAt: NOW - 110_000, ...patch,
} as PodReconciliation);

test("a closed pod disables the composer and keeps its Recent Merges readable, with no Merge action", async () => {
  const view = await mount([pod({ status: "closed", reconciliations: [merge({})] })], members(), {
    podContext: async () => ({ entries: [entry(1, "First note.")] }),
  });
  try {
    assert.equal(huddle().querySelector("textarea")!.disabled, true);
    assert.equal(entryBox("First note.").disabled, true);
    assert.equal(relayToBox("Worker · Codex").disabled, true);
    assert.equal(buttonNamed(huddle(), "Save Note")!.disabled, true);
    assert.equal(buttonNamed(huddle(), "Relay to 3")!.disabled, true);
    assert.equal(huddle().querySelector(".pod-composer-reason")?.textContent, "This pod is closed.");
    for (const share of [...view.container.querySelectorAll<HTMLButtonElement>(".pod-member-tools button")].filter((button) => button.textContent === "Share Latest")) {
      assert.equal(share.disabled, true, "a closed pod's log takes no more answers");
    }

    await act(async () => body().querySelector<HTMLButtonElement>('.detail-bar button[aria-label="More Actions"]')!.click());
    const menu = body().querySelector<HTMLElement>('[role="menu"][aria-label="More Actions"]')!;
    const labels = [...menu.querySelectorAll('[role="menuitem"] .menu-text')].map((item) => item.textContent);
    assert.deepEqual(labels, ["Automatic Turns…", "Recent Merges…", "Copy Link"]);
    const item = [...menu.querySelectorAll<HTMLElement>('[role="menuitem"]')].find((candidate) => candidate.textContent?.includes("Recent Merges…"))!;
    await act(async () => item.click());
    await settle();
    const dialog = [...body().querySelectorAll<HTMLElement>('[role="dialog"]')].find((candidate) => candidate.querySelector("h2")?.textContent === "Recent Merges");
    assert.ok(dialog, "Recent Merges opens");
    assert.match(dialog.querySelector(".pod-merge-row .row-title")?.textContent ?? "", /^Worker into Lead$/u);
    assert.match(dialog.querySelector(".pod-merge-row")?.textContent ?? "", /Merged/u);
    assert.ok(dialog.querySelector(".pod-merge-row details summary")?.textContent?.includes("Show Details"));
    assertNoDomNode(buttonNamed(dialog, "Merge"), "nothing can merge");
    assertNoDomNode(dialog.querySelector('[aria-label^="From:"], [aria-label^="Into:"]'), "no From or Into");
    assert.ok(buttonNamed(dialog, "Done"));
  } finally {
    await view.unmount();
  }
});

describe("a pod on a phone (#2981)", () => {
  test("the Huddle tab opens first, then one tab per member; a tab updates the URL and the URL's member opens selected", async () => {
    await setViewport(390, 844);
    const view = await mount([pod()], members({ worker: { status: "running" } }), {
      podContext: async () => ({ entries: [entry(1, "First note.")] }),
    });
    try {
      assertNoDomNode(view.container.querySelector(".pod-layout"), "no desktop layout on a phone");
      const tabs = () => [...view.container.querySelectorAll<HTMLElement>('[role="tablist"] [role="tab"]')];
      assert.deepEqual(tabs().map((tab) => tab.textContent), ["Huddle", "Claude, Awaiting Prompt", "Codex, Running", "Gemini, Awaiting Prompt"]);
      assert.ok(tabs().slice(1).every((tab) => tab.querySelector(".compare-tab-dot")), "each member tab has its status dot");
      assert.equal(tabs()[0]!.getAttribute("aria-selected"), "true", "the Huddle opens without a tab in the URL");
      const panel = huddle(view.container);
      assert.equal(panel.getAttribute("role"), "tabpanel");
      assert.equal(panel.getAttribute("aria-labelledby"), tabs()[0]!.id);
      assert.ok(panel.querySelector(".pod-composer textarea"), "the composer is on the Huddle tab");
      assertNoDomNode(view.container.querySelector(".compare-member"), "no member column on the Huddle tab");

      await act(async () => tabs()[2]!.click());
      await settle();
      assert.deepEqual(view.replaced.at(-1), { name: "pod", id: "pod-1", member: "worker" }, "the choice replaces the entry with ?member=");
      assert.equal(view.container.querySelector(".compare-member .compare-member-agent")?.textContent, "Codex");
      assertNoDomNode(view.container.querySelector(".pod-huddle"), "the Huddle is a tab of its own");

      await act(async () => { fireDomEvent.keyDown(tabs()[2]! as never, { key: "Home" }); });
      await settle();
      assert.deepEqual(view.replaced.at(-1), { name: "pod", id: "pod-1", tab: "huddle" }, "Home returns to the Huddle with ?tab=huddle");
      assert.equal(domWindow.document.activeElement?.id, tabs()[0]!.id);
    } finally {
      await view.unmount();
      await setViewport(1440, 900);
    }
  });

  test("reloading on a member tab keeps that member", async () => {
    await setViewport(390, 844);
    const view = await mount([pod()], members(), {}, { name: "pod", id: "pod-1", member: "reviewer" });
    try {
      const selected = view.container.querySelector('[role="tab"][aria-selected="true"]');
      assert.equal(selected?.textContent, "Gemini, Awaiting Prompt");
      const column = view.container.querySelector(".compare-member")!;
      assert.equal(column.getAttribute("role"), "tabpanel");
      assert.equal(column.querySelector(".compare-member-agent")?.textContent, "Gemini");
    } finally {
      await view.unmount();
      await setViewport(1440, 900);
    }
  });
});
