import { fireDomEvent } from "./test-dom-events.js";
import assert from "node:assert/strict";
import test from "node:test";
import React, { act } from "react";
import { createRoot } from "react-dom/client";
import { Window } from "happy-dom";
import type {
  PodOrchestrationState,
  PodReconciliation,
  PodView,
  RunnerView,
  SessionView,
  StartPodOrchestrationRequest,
  UiSnapshotMessage,
  UpdatePodOrchestrationRequest,
} from "@wollipog/protocol";
import { api, type ApiClient } from "../api.js";
import { ApiProvider } from "../api-context.js";
import type { ViewNavigation } from "../navigation.js";
import { StoreProvider } from "../store.js";
import { UI_SOCKET_OPEN, type UiConnectionRuntime, type UiSocket } from "../ui-transport.js";
import { FeedbackProvider } from "./FeedbackProvider.js";
import { PodDetail } from "./PodsView.js";
import { MANUAL_ONLY_HELP } from "./PodAutomaticTurnsDialog.js";
import { installDomTestCleanup } from "../dom-test-cleanup.js";
import { assertNoDomNode } from "../dom-test-assertions.js";

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

function session(id: string, title: string, patch: Partial<SessionView> = {}): SessionView {
  return {
    id, runnerId: runner.runnerId, workspaceId: "workspace", workspaceName: "Workspace", projectId: null,
    agentId: "codex", agentName: "Codex", title, status: "idle", column: "review",
    runId: null, useWorktree: true, worktreePath: `/worktrees/${id}`, archived: false, createdAt: 1, updatedAt: 1,
    lastEventAt: null, messageCount: 0, eventEpoch: 0, preview: null, pendingApproval: null,
    driver: "codex-app-server", model: null, effort: null, permissionMode: null,
    tokensIn: 0, tokensOut: 0, costUsd: 0, adopted: false,
    ...patch,
  } as SessionView;
}

const POLICY = { mode: "manual", contextTokenBudget: 4_096, summaryTokenBudget: 512, maxTurns: 12, maxRepeatedOutputs: 2 } as const;

function pod(state: Partial<PodOrchestrationState> = {}, reconciliations: PodReconciliation[] = []): PodView {
  return {
    id: "pod-1", title: "Migration Pod", objective: "Migrate call sites", status: "active", createdAt: 1, updatedAt: 1,
    members: [
      { sessionId: "lead", joinedAt: 1, role: "lead", contextTokenBudget: null, lastContextSeq: 0 },
      { sessionId: "worker", joinedAt: 1, role: "worker", contextTokenBudget: null, lastContextSeq: 0 },
    ],
    orchestration: { policy: { ...POLICY }, state: { status: "idle", turnsUsed: 0, updatedAt: 1, ...state } },
    reconciliations,
  };
}

const sessions = (patch: Record<string, Partial<SessionView>> = {}) => [
  session("lead", "Lead: plan the migration", patch.lead),
  session("worker", "Worker: migrate call sites", patch.worker),
];

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
const settle = () => act(async () => { for (let index = 0; index < 8; index += 1) await new Promise((resolve) => setTimeout(resolve, 0)); });
const body = () => domWindow.document.body as unknown as HTMLElement;
let sequence = 0;

async function mount(pods: PodView[], members: SessionView[], overrides: Partial<ApiClient> = {}) {
  const container = domWindow.document.createElement("div") as unknown as HTMLDivElement;
  domWindow.document.body.append(container as never);
  const root = createRoot(container);
  const socket = new FakeSocket();
  sequence += 1;
  const connection: UiConnectionRuntime = {
    instanceId: `pod-dialogs-${sequence}`, runtimeKey: `pod-dialogs-${sequence}:1`, createSocket: () => socket, close() {},
  };
  const client = {
    ...api,
    getSessionEventPage: pending,
    podContext: async () => ({ entries: [] }),
    git: async () => ({ status: { hasChanges: false } }),
    ...overrides,
  } as unknown as ApiClient;
  const navigation: ViewNavigation = { current: () => ({ name: "pod", id: "pod-1" }), push() {}, listen: () => () => {} };
  await act(async () => root.render(
    <ApiProvider client={client}>
      <FeedbackProvider>
        <StoreProvider connection={connection} navigation={navigation}>
          <PodDetail podId="pod-1" />
        </StoreProvider>
      </FeedbackProvider>
    </ApiProvider>,
  ));
  await act(async () => socket.push({
    type: "snapshot",
    capabilities: { sessionSubscriptions: false, boundedDelivery: false, paginatedSessionHistory: false, projects: true },
    runners: [runner], boxes: [], projects: [], runs: [], pods, sessions: members,
  }));
  await settle();
  return {
    container,
    push: async (next: PodView) => {
      await act(async () => socket.push({
        type: "snapshot",
        capabilities: { sessionSubscriptions: false, boundedDelivery: false, paginatedSessionHistory: false, projects: true },
        runners: [runner], boxes: [], projects: [], runs: [], pods: [next], sessions: members,
      }));
      await settle();
    },
    unmount: async () => {
      await act(async () => root.unmount());
      container.remove();
    },
  };
}

const buttonNamed = (scope: ParentNode, name: string) =>
  [...scope.querySelectorAll<HTMLButtonElement>("button")].find((button) => button.textContent?.trim() === name) ?? null;

async function openMenu() {
  await act(async () => body().querySelector<HTMLButtonElement>('.detail-bar button[aria-label="More Actions"]')!.click());
  const menu = body().querySelector<HTMLElement>('[role="menu"][aria-label="More Actions"]');
  assert.ok(menu, "⋯ opens");
  return menu;
}

const menuItems = (menu: HTMLElement) => [...menu.querySelectorAll<HTMLButtonElement>('[role="menuitem"]')];
const itemLabel = (item: HTMLElement) => item.querySelector(".menu-text")?.textContent;
const itemNamed = (menu: HTMLElement, label: string) => menuItems(menu).find((item) => itemLabel(item) === label)!;

async function openDialog(label: string, title: string) {
  const menu = await openMenu();
  await act(async () => itemNamed(menu, label).click());
  await settle();
  const dialog = [...body().querySelectorAll<HTMLElement>('[role="dialog"]')]
    .find((candidate) => candidate.querySelector("h2")?.textContent?.trim() === title);
  assert.ok(dialog, `${title} opens`);
  return dialog;
}

async function chooseOption(dialog: HTMLElement, label: string, option: string) {
  const trigger = dialog.querySelector<HTMLButtonElement>(`[aria-label^="${label}:"]`);
  assert.ok(trigger, `${label} select`);
  await act(async () => trigger.click());
  const choice = [...body().querySelectorAll<HTMLElement>('[role="option"]')].find((candidate) => candidate.textContent?.startsWith(option));
  assert.ok(choice, `${option} in ${label}`);
  await act(async () => choice.click());
  await settle();
}

const optionLabels = async (dialog: HTMLElement, label: string) => {
  await act(async () => dialog.querySelector<HTMLButtonElement>(`[aria-label^="${label}:"]`)!.click());
  // An option is named by its label alone; a description is its accessible description.
  const labels = [...body().querySelectorAll<HTMLElement>('[role="option"]')].map((option) => {
    const labelId = option.getAttribute("aria-labelledby");
    return (labelId ? domWindow.document.getElementById(labelId)?.textContent : null) ?? option.textContent ?? "";
  });
  await act(async () => fireDomEvent.keyDown(body().querySelector('[role="listbox"]')!, { key: "Escape" }));
  return labels;
};

const radio = (dialog: HTMLElement, title: string) =>
  [...dialog.querySelectorAll<HTMLInputElement>('input[type="radio"]')].find((input) => input.closest("label")?.textContent?.includes(title))!;

function typeInto(input: HTMLInputElement | HTMLTextAreaElement, value: string) {
  const proto = input instanceof domWindow.HTMLTextAreaElement ? domWindow.HTMLTextAreaElement.prototype : domWindow.HTMLInputElement.prototype;
  Object.getOwnPropertyDescriptor(proto, "value")?.set?.call(input, value);
  fireDomEvent.change(input, { target: input });
}

const numberInput = (dialog: HTMLElement, label: string) => {
  const field = [...dialog.querySelectorAll("label")].find((candidate) => candidate.textContent === label);
  assert.ok(field, `${label} field`);
  return dialog.querySelector<HTMLInputElement>(`#${CSS.escape(field.getAttribute("for")!)}`)!;
};

// happy-dom has no CSS.escape.
const CSS = { escape: (value: string) => value.replace(/[^\w-]/gu, (character) => `\\${character}`) };

test("the pod page has no orchestration or merge panel; ⋯ lists Automatic Turns…, Merge Work…, Copy Link, then Close Pod… after a separator", async () => {
  const view = await mount([pod()], sessions());
  try {
    for (const retired of [".pod-orchestration", ".pod-reconcile", '[aria-label="Pod Orchestration Policy"]', '[aria-label="Pod Worktree Reconciliation"]']) {
      assertNoDomNode(view.container.querySelector(retired), `no ${retired}`);
    }
    assert.doesNotMatch(view.container.textContent ?? "", /Policy Saved|Start Automatic Cycle|Reconcile Committed Work/u);
    const menu = await openMenu();
    assert.deepEqual(menuItems(menu).map(itemLabel), ["Automatic Turns…", "Merge Work…", "Copy Link", "Close Pod…"]);
    const close = itemNamed(menu, "Close Pod…");
    assert.equal(close.previousElementSibling?.getAttribute("role"), "separator", "Close Pod… follows a separator");
  } finally {
    await view.unmount();
  }
});

test("a closed pod or a running merge disables the dialogs' items with their reason", async () => {
  const closed = await mount([{ ...pod(), status: "closed" }], sessions());
  try {
    const menu = await openMenu();
    assert.deepEqual(menuItems(menu).map(itemLabel), ["Automatic Turns…", "Merge Work…", "Copy Link"]);
    for (const label of ["Automatic Turns…", "Merge Work…"]) {
      const item = itemNamed(menu, label);
      assert.equal(item.disabled || item.getAttribute("aria-disabled") === "true", true, label);
      assert.match(item.textContent ?? "", /This pod is closed\./u);
    }
  } finally {
    await closed.unmount();
  }
  const merging = await mount([pod({}, [{
    reconciliationId: "r-run", podId: "pod-1", sourceSessionId: "worker", targetSessionId: "lead", actorId: "local",
    status: "running", createdAt: 1,
  }])], sessions());
  try {
    const menu = await openMenu();
    for (const label of ["Automatic Turns…", "Merge Work…", "Close Pod…"]) {
      assert.match(itemNamed(menu, label).textContent ?? "", /Available when the merge finishes\./u, label);
    }
  } finally {
    await merging.unmount();
  }
});

test("Automatic Turns saves the same policy request, and Save and Start also starts turns", async () => {
  const updates: UpdatePodOrchestrationRequest[] = [];
  const starts: StartPodOrchestrationRequest[] = [];
  const view = await mount([pod()], sessions(), {
    updatePodOrchestration: async (_id: string, request: UpdatePodOrchestrationRequest) => { updates.push(request); return { pod: pod() }; },
    startPodOrchestration: async (_id: string, request: StartPodOrchestrationRequest) => { starts.push(request); return { pod: pod() }; },
  } as Partial<ApiClient>);
  try {
    let dialog = await openDialog("Automatic Turns…", "Automatic Turns");
    assert.match(dialog.textContent ?? "", /Let members take turns without you relaying each step\./u);
    // Manual Only: nothing to start, and the help line says why.
    assert.equal(radio(dialog, "Manual Only").checked, true);
    assertNoDomNode(buttonNamed(dialog, "Save and Start"), "no start control in Manual Only");
    assert.match(dialog.textContent ?? "", new RegExp(MANUAL_ONLY_HELP));
    assert.equal(buttonNamed(dialog, "Save")!.classList.contains("primary"), true, "Save is the primary");

    // Unit fields: 96px, the unit in the help, and no retired label.
    for (const [label, help] of [["Turn Limit", "Turns"], ["Stop After Repeated Answers", "Identical answers in a row"], ["Summary Length", "In tokens"]] as const) {
      const input = numberInput(dialog, label);
      assert.equal(input.classList.contains("w-xs"), true, `${label} is .w-xs`);
      assert.equal(domWindow.document.getElementById(input.getAttribute("aria-describedby")!)?.textContent, help);
    }
    const labels = [...dialog.querySelectorAll(".field-head label, .field > span")].map((label) => label.textContent ?? "");
    assert.deepEqual(labels.filter((label) => /Cap|Tokens|Arbitration/u.test(label)), []);

    await act(async () => radio(dialog, "Round Robin").click());
    assert.equal(buttonNamed(dialog, "Save and Start")!.classList.contains("primary"), true);
    assert.equal(buttonNamed(dialog, "Save")!.classList.contains("primary"), false);
    // Members by agent and task, never the role twice.
    assert.deepEqual(await optionLabels(dialog, "First Member"), ["Lead · Codex App Server: plan the migration", "Worker · Codex App Server: migrate call sites"]);
    await chooseOption(dialog, "First Member", "Worker · Codex App Server");
    await act(async () => typeInto(numberInput(dialog, "Turn Limit"), "20"));
    await act(async () => typeInto(dialog.querySelector("textarea")!, "Start with the parser."));
    await act(async () => buttonNamed(dialog, "Save and Start")!.click());
    await settle();

    assert.deepEqual(updates, [{ mode: "round_robin", contextTokenBudget: 4_096, summaryTokenBudget: 512, maxTurns: 20, maxRepeatedOutputs: 2 }]);
    assert.deepEqual(starts, [{ instruction: "Start with the parser.", firstSessionId: "worker" }]);
    assertNoDomNode(body().querySelector('[role="dialog"]'), "the dialog closes");

    // Save alone sends the request and starts nothing.
    dialog = await openDialog("Automatic Turns…", "Automatic Turns");
    await act(async () => radio(dialog, "Lead Decides").click());
    await act(async () => buttonNamed(dialog, "Save")!.click());
    await settle();
    assert.deepEqual(updates.at(-1), { mode: "lead_driven", contextTokenBudget: 4_096, summaryTokenBudget: 512, maxTurns: 12, maxRepeatedOutputs: 2 });
    assert.equal(starts.length, 1);
  } finally {
    await view.unmount();
  }
});

test("Automatic Turns owns its draft: Cancel discards it and reopening shows the saved policy", async () => {
  const view = await mount([pod()], sessions());
  try {
    let dialog = await openDialog("Automatic Turns…", "Automatic Turns");
    await act(async () => radio(dialog, "Round Robin").click());
    await act(async () => typeInto(numberInput(dialog, "Turn Limit"), "40"));
    await act(async () => buttonNamed(dialog, "Cancel")!.click());
    await settle();
    dialog = await openDialog("Automatic Turns…", "Automatic Turns");
    assert.equal(radio(dialog, "Manual Only").checked, true);
    assert.equal(numberInput(dialog, "Turn Limit").value, "12");
  } finally {
    await view.unmount();
  }
});

test("an out-of-range number shows its error under the field, focuses it and sends nothing", async () => {
  const updates: UpdatePodOrchestrationRequest[] = [];
  const view = await mount([pod()], sessions(), {
    updatePodOrchestration: async (_id: string, request: UpdatePodOrchestrationRequest) => { updates.push(request); return { pod: pod() }; },
  } as Partial<ApiClient>);
  try {
    const dialog = await openDialog("Automatic Turns…", "Automatic Turns");
    const limit = numberInput(dialog, "Turn Limit");
    await act(async () => typeInto(limit, "0"));
    await act(async () => buttonNamed(dialog, "Save")!.click());
    await settle();
    assert.deepEqual(updates, []);
    assert.equal(limit.getAttribute("aria-invalid"), "true");
    assert.equal(domWindow.document.getElementById(limit.getAttribute("aria-describedby")!)?.textContent, "Enter a whole number from 1 to 100.");
    assert.equal(domWindow.document.activeElement, limit as never);
  } finally {
    await view.unmount();
  }
});

test("while turns run, one banner shows the turn count and Stop Automatic Turns calls stopPodOrchestration", async () => {
  const stops: string[] = [];
  const running = pod({ status: "running", runId: "run-1", turnsUsed: 3, currentSessionId: "worker" });
  const view = await mount([running], sessions(), {
    stopPodOrchestration: async (id: string) => { stops.push(id); return { pod: running }; },
  } as Partial<ApiClient>);
  try {
    const banners = view.container.querySelectorAll(".pod-turns-banner");
    assert.equal(banners.length, 1);
    assert.match(banners[0]!.textContent ?? "", /Automatic turns are running · Turn 3 of 12 · Worker is up/u);
    await act(async () => buttonNamed(banners[0]!, "Stop Automatic Turns")!.click());
    await settle();
    assert.deepEqual(stops, ["pod-1"]);
    const menu = await openMenu();
    assert.match(itemNamed(menu, "Automatic Turns…").textContent ?? "", /Stop automatic turns to change them\./u);
  } finally {
    await view.unmount();
  }
});

test("turns that stop for a reason say why once, in a neutral banner that dismisses", async () => {
  const view = await mount([pod({ status: "stopped", runId: "run-2", turnsUsed: 12, stopReason: "max_turns", updatedAt: 5 })], sessions());
  try {
    const banner = view.container.querySelector<HTMLElement>(".pod-turns-banner");
    assert.ok(banner);
    assert.equal(banner.classList.contains("t-neutral"), true);
    assert.match(banner.textContent ?? "", /Automatic turns stopped: the turn limit was reached\./u);
    await act(async () => banner.querySelector<HTMLButtonElement>('button[aria-label="Dismiss"]')!.click());
    assertNoDomNode(view.container.querySelector(".pod-turns-banner"));
    // A person's own Stop needs no banner.
    await view.push(pod({ status: "stopped", runId: "run-3", stopReason: "stopped_by_human", updatedAt: 6 }));
    assertNoDomNode(view.container.querySelector(".pod-turns-banner"));
  } finally {
    await view.unmount();
  }
});

test("Merge is disabled with the specific reason when a member is running or has uncommitted work; options never repeat the role", async () => {
  const busyMember = await mount([pod()], sessions({ worker: { status: "running" } }));
  try {
    const dialog = await openDialog("Merge Work…", "Merge Work");
    assert.deepEqual(await optionLabels(dialog, "From"), ["Lead · Codex App Server", "Worker · Codex App Server"]);
    assert.match(dialog.textContent ?? "", /Both members must be idle with committed work on the same machine and folder\. If the merge conflicts, Into is left unchanged\./u);
    const merge = buttonNamed(dialog, "Merge")!;
    assert.equal(merge.disabled, true);
    assert.equal(domWindow.document.getElementById(merge.getAttribute("aria-describedby")!)?.textContent, "Worker is running. Merge when it's idle.");
  } finally {
    await busyMember.unmount();
  }
  const dirty = await mount([pod()], sessions(), {
    git: async (sessionId: string) => ({ status: { hasChanges: sessionId === "worker" } }),
  } as unknown as Partial<ApiClient>);
  try {
    const dialog = await openDialog("Merge Work…", "Merge Work");
    await settle();
    const merge = buttonNamed(dialog, "Merge")!;
    assert.equal(merge.disabled, true);
    assert.equal(domWindow.document.getElementById(merge.getAttribute("aria-describedby")!)?.textContent,
      "Worker has uncommitted changes. Commit them first.");
  } finally {
    await dirty.unmount();
  }
});

test("Merge merges From into Into when the rule holds", async () => {
  const merges: unknown[] = [];
  const view = await mount([pod()], sessions(), {
    reconcilePod: async (_id: string, request: unknown) => { merges.push(request); return { pod: pod(), reconciliation: {} }; },
  } as unknown as Partial<ApiClient>);
  try {
    const dialog = await openDialog("Merge Work…", "Merge Work");
    await settle();
    const merge = buttonNamed(dialog, "Merge")!;
    assert.equal(merge.disabled, false);
    await act(async () => merge.click());
    await settle();
    assert.deepEqual(merges, [{ sourceSessionId: "worker", targetSessionId: "lead" }]);
    assert.ok(buttonNamed(dialog, "Done"), "after a merge the dialog stays open on its result");
  } finally {
    await view.unmount();
  }
});

test("Recent Merges name the members in words with an inline status, and keep heads and paths behind Show Details", async () => {
  const conflicted: PodReconciliation = {
    reconciliationId: "r-1", podId: "pod-1", sourceSessionId: "worker", targetSessionId: "lead", actorId: "local",
    status: "conflicted", sourceHead: "aaaaaaaaaaaaaaaa", targetHead: "bbbbbbbbbbbbbbbb", mergeBase: "cccccccccccccccc",
    conflictPaths: ["src/parser.ts"], createdAt: Date.now() - 60_000, completedAt: Date.now() - 60_000,
  };
  const applied: PodReconciliation = {
    ...conflicted, reconciliationId: "r-2", status: "already_applied", conflictPaths: undefined, sourceSessionId: "lead", targetSessionId: "worker",
  };
  const view = await mount([pod({}, [conflicted, applied])], sessions());
  try {
    const dialog = await openDialog("Merge Work…", "Merge Work");
    const rows = [...dialog.querySelectorAll<HTMLElement>(".pod-merge-row")];
    assert.deepEqual(rows.map((row) => row.querySelector(".row-title")?.textContent), ["Worker into Lead", "Lead into Worker"]);
    assert.deepEqual(rows.map((row) => row.querySelector(".status")?.textContent), ["Conflicted", "Already Up to Date"]);
    assert.doesNotMatch(dialog.textContent ?? "", /→/u);
    const details = rows[0]!.querySelector("details.disclosure")!;
    assert.equal(details.hasAttribute("open"), false, "details start closed");
    assert.equal(details.querySelector("summary")?.textContent, "Show Details");
    assert.match(details.textContent ?? "", /aaaaaaaaaa/u);
    assert.match(details.textContent ?? "", /src\/parser\.ts/u);
    const outside = rows[0]!.querySelector(".row-line")!.textContent ?? "";
    assert.doesNotMatch(outside, /aaaaaaaaaa|src\/parser/u);
  } finally {
    await view.unmount();
  }
});
