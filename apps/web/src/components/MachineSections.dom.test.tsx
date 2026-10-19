import { fireDomEvent } from "./test-dom-events.js";
import assert from "node:assert/strict";
import { test } from "node:test";
import React, { act } from "react";
import { createRoot } from "react-dom/client";
import { Window } from "happy-dom";
import { PROTOCOL_VERSION, type IdentityAdministrationView, type RunnerView, type UiSnapshotMessage } from "@wollipog/protocol";
import { api, type ApiClient } from "../api.js";
import { ApiProvider } from "../api-context.js";
import { assertNoDomNode } from "../dom-test-assertions.js";
import { installDomTestCleanup } from "../dom-test-cleanup.js";
import { browserInstanceManager, InstancesContextProvider } from "../instances-context.js";
import type { View, ViewNavigation } from "../navigation.js";
import { StoreProvider } from "../store.js";
import { UI_SOCKET_OPEN, type UiConnectionRuntime, type UiSocket } from "../ui-transport.js";
import { workspaceNameFromPath } from "./AddWorkspaceDialog.js";
import { FeedbackProvider } from "./FeedbackProvider.js";
import { capacityBlockerSentence, capacityMetaItems, CAPACITY_WAITING } from "./MachineCapacitySection.js";
import { connectionFacts } from "./MachineDetail.js";
import { ADD_WORKSPACE_NO_BROWSING, ADD_WORKSPACE_OFFLINE } from "./MachineWorkspacesSection.js";
import { RunnersView } from "./RunnersView.js";

/**
 * A machine's Capacity, Workspaces and Skills on This Machine sections (#2989), through the real
 * Machines tab: the meter and its meta line, Add Workspace…, and what left Machine Settings.
 */

const domWindow = new Window({ url: "http://localhost/", width: 1440, height: 900 });
installDomTestCleanup(domWindow);
for (const [name, value] of Object.entries({
  window: domWindow,
  document: domWindow.document,
  navigator: domWindow.navigator,
  localStorage: domWindow.localStorage,
  HTMLElement: domWindow.HTMLElement,
  HTMLButtonElement: domWindow.HTMLButtonElement,
  HTMLInputElement: domWindow.HTMLInputElement,
  HTMLSelectElement: domWindow.HTMLSelectElement,
  HTMLTextAreaElement: domWindow.HTMLTextAreaElement,
  Node: domWindow.Node,
  Event: domWindow.Event,
  InputEvent: domWindow.InputEvent,
  MouseEvent: domWindow.MouseEvent,
  KeyboardEvent: domWindow.KeyboardEvent,
  FocusEvent: domWindow.FocusEvent,
  MutationObserver: domWindow.MutationObserver,
  requestAnimationFrame: domWindow.requestAnimationFrame.bind(domWindow),
  cancelAnimationFrame: domWindow.cancelAnimationFrame.bind(domWindow),
  getComputedStyle: domWindow.getComputedStyle.bind(domWindow),
  React,
  IS_REACT_ACT_ENVIRONMENT: true,
  ResizeObserver: class { observe() {} unobserve() {} disconnect() {} },
})) Object.defineProperty(globalThis, name, { configurable: true, writable: true, value });

const live = (configuredUnits: number, usedUnits: number, extra: Partial<NonNullable<RunnerView["capacity"]>> = {}) => ({
  configuredUnits, usedUnits, availableUnits: Math.max(0, configuredUnits - usedUnits), queuedSessions: 0,
  revision: 1, authority: "control_plane", ...extra,
}) as RunnerView["capacity"];

function runner(runnerId: string, overrides: Partial<RunnerView> = {}): RunnerView {
  return {
    runnerId,
    hostname: `${runnerId}.local`,
    displayName: "Studio Mac",
    os: "linux",
    version: "0.42.0",
    status: "online",
    agents: [],
    workspaces: [],
    connectedAt: 1,
    lastSeen: Date.now(),
    protocolVersion: PROTOCOL_VERSION,
    canManage: true,
    ...overrides,
  };
}

const busy = runner("studio", {
  capacity: live(40, 30, {
    queuedSessions: 2,
    dimensions: {
      activeTurns: { used: 3, limit: 8, available: 5 },
      residentProcessUnits: { used: 30, limit: 40, available: 10 },
      retainedSessions: { used: 5, limit: null, available: null },
      parkedSessions: 1,
      idleProcessPolicy: "park_when_needed",
    },
    blockers: [
      { kind: "agent_quota", description: "claude is using 4 of 4 provider slots", usedUnits: 4, limitUnits: 4, requiredUnits: 1, waitingSessions: 2, agentId: "claude" },
      { kind: "runner_capacity", description: "Runner Capacity is 30 of 40 units used; this session needs 12", usedUnits: 30, limitUnits: 40, requiredUnits: 12, waitingSessions: 1 },
    ],
  }),
  workspaces: [
    { id: "home", name: "Home", path: "/home/ada" },
    { id: "deep", name: "Storefront", path: "/home/ada/src/clients/acme/very/deeply/nested/folders/acme-storefront" },
  ],
});

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

const snapshot = (runners: RunnerView[]): UiSnapshotMessage => ({
  type: "snapshot",
  capabilities: { sessionSubscriptions: false, boundedDelivery: false, paginatedSessionHistory: false, projects: true },
  runners, boxes: [], projects: [], sessions: [], runs: [], pods: [],
});
const navigation = (view: View): ViewNavigation => ({ current: () => view, push() {}, replace() {}, listen: () => () => {} });
const settle = () => act(async () => { for (let index = 0; index < 8; index += 1) await new Promise((resolve) => setTimeout(resolve, 0)); });
let sequence = 0;

async function mount(machine: RunnerView, { role = "owner", client: overrides = {} }: {
  role?: "owner" | "member" | "viewer";
  client?: Partial<ApiClient>;
} = {}) {
  const mountPoint = domWindow.document.createElement("div") as unknown as HTMLDivElement;
  domWindow.document.body.append(mountPoint as never);
  const root = createRoot(mountPoint);
  const socket = new FakeSocket();
  sequence += 1;
  const connection: UiConnectionRuntime = {
    instanceId: `machine-sections-${sequence}`,
    runtimeKey: `machine-sections-${sequence}:1`,
    createSocket: () => socket,
    close() {},
  };
  const identity = { context: { role }, organizations: [], memberships: [], teams: [] } as unknown as IdentityAdministrationView;
  const client = {
    ...api,
    getIdentity: async () => identity,
    listSkills: async () => ({ skills: [] }),
    runnerSkills: async () => ({ removalReporting: "supported", desired: [], reported: { unmanaged: [], removals: [] } }),
    ...overrides,
  } as unknown as ApiClient;
  await act(async () => {
    root.render(
      <ApiProvider client={client}>
        <InstancesContextProvider value={browserInstanceManager}>
          <FeedbackProvider>
            <StoreProvider connection={connection} navigation={navigation({ name: "runners", section: "machines", machineId: machine.runnerId })}>
              <RunnersView />
            </StoreProvider>
          </FeedbackProvider>
        </InstancesContextProvider>
      </ApiProvider>,
    );
  });
  await act(async () => { socket.push(snapshot([machine])); });
  await settle();
  const body = domWindow.document.body as unknown as HTMLElement;
  return {
    body,
    detail: () => body.querySelector<HTMLElement>("article.machine-detail")!,
    push: async (next: RunnerView) => { await act(async () => { socket.push(snapshot([next])); }); await settle(); },
    unmount: async () => { await act(async () => root.unmount()); mountPoint.remove(); },
  };
}

const buttonNamed = (scope: Element, name: string) =>
  [...scope.querySelectorAll<HTMLButtonElement>("button")].find((button) => button.textContent?.trim() === name) ?? null;
const sectionNamed = (scope: Element, title: string) =>
  [...scope.querySelectorAll<HTMLElement>("section.section")].find((section) =>
    section.querySelector(".section-title")?.firstChild?.textContent?.trim() === title ||
    section.getAttribute("aria-label") === title);
const dialogNamed = (body: HTMLElement, title: string) => [...body.querySelectorAll<HTMLElement>('[role="dialog"]')]
  .find((dialog) => dialog.querySelector("h2, h3, .modal-title")?.textContent?.trim() === title);
const sectionOrder = (detail: HTMLElement) => [...detail.querySelectorAll<HTMLElement>(".machine-detail-sections > section.section")]
  .map((section) => section.getAttribute("aria-label") ?? section.querySelector(".section-title")?.firstChild?.textContent?.trim());

async function type(input: HTMLInputElement, value: string) {
  await act(async () => {
    input.value = value;
    fireDomEvent.change(input);
  });
}

test("Capacity shows the units in use beside a warning meter from 75%, a meta line without dots, and one notice of blockers", async () => {
  const view = await mount(busy);
  try {
    const capacity = sectionNamed(view.detail(), "Capacity")!;
    assert.ok(capacity, "Capacity is a section");
    assert.equal(capacity.querySelector(".machine-capacity-figure")?.textContent, "30 of 40 units in use");
    const meter = capacity.querySelector<HTMLElement>(".meter")!;
    assert.ok(meter.classList.contains("t-warning"), "30 of 40 is 75%: warning");
    assert.equal(meter.getAttribute("role"), "progressbar");
    assert.equal(meter.getAttribute("aria-valuenow"), "30");
    assert.equal(meter.getAttribute("aria-valuemax"), "40");
    assert.equal(meter.querySelector("span")?.getAttribute("style"), "width: 75%;");
    const meta = [...capacity.querySelectorAll(".machine-capacity-meta > li")].map((item) => item.textContent);
    assert.deepEqual(meta, ["Active Turns 3 of 8", "Queued 2", "Idle Resumable 5", "Parked 1"]);
    assert.doesNotMatch(capacity.textContent ?? "", /·/u, "no middle dots");
    const notices = capacity.querySelectorAll(".notice");
    assert.equal(notices.length, 1, "one notice for every blocker");
    assert.ok(notices[0]!.classList.contains("t-warning") && notices[0]!.classList.contains("compact"));
    assert.deepEqual([...notices[0]!.querySelectorAll("p")].map((line) => line.textContent), [
      "Claude is using 4 of 4 provider slots. 2 sessions waiting.",
      "Runner Capacity is 30 of 40 units used; this session needs 12. 1 session waiting.",
    ]);
    assert.deepEqual(sectionOrder(view.detail()).filter((title) => title !== undefined),
      ["Capacity", "Agents", "Provider Accounts", "Workspaces", "Skills on This Machine"],
      "Capacity first, then Agents and Provider Accounts (#2995), then Workspaces and Skills");
  } finally {
    await view.unmount();
  }
});

test("below 75% the meter is neutral; before a report, or offline, Capacity is waiting", async () => {
  const calm = await mount(runner("calm", { capacity: live(40, 29) }));
  try {
    const capacity = sectionNamed(calm.detail(), "Capacity")!;
    assert.equal(capacity.querySelector(".machine-capacity-figure")?.textContent, "29 of 40 units in use");
    assert.ok(!capacity.querySelector(".meter")!.classList.contains("t-warning"));
    assertNoDomNode(capacity.querySelector(".machine-capacity-meta"), "no meta line without dimensions");
    assertNoDomNode(capacity.querySelector(".notice"), "no notice without blockers");
  } finally {
    await calm.unmount();
  }
  for (const machine of [
    runner("fresh", { capacity: { configuredUnits: 40, revision: 1, authority: "control_plane" } }),
    runner("away", { status: "offline", capacity: live(40, 12) }),
  ]) {
    const view = await mount(machine);
    try {
      const capacity = sectionNamed(view.detail(), "Capacity")!;
      assert.equal(capacity.querySelector(".machine-section-state")?.textContent, CAPACITY_WAITING, machine.runnerId);
      assertNoDomNode(capacity.querySelector(".meter"), `${machine.runnerId}: no meter`);
    } finally {
      await view.unmount();
    }
  }
});

test("Change Limit… is for those who may change capacity, and opens Machine Settings in Capacity Limit without readouts or Workspaces", async () => {
  const viewer = await mount(runner("studio", { ...busy, canManage: false }), { role: "viewer" });
  try {
    assertNoDomNode(buttonNamed(sectionNamed(viewer.detail(), "Capacity")!, "Change Limit…"), "a viewer cannot change the limit");
  } finally {
    await viewer.unmount();
  }
  const view = await mount(busy);
  try {
    const change = buttonNamed(sectionNamed(view.detail(), "Capacity")!, "Change Limit…")!;
    assert.ok(change, "Change Limit…");
    await act(async () => change.click());
    await settle();
    const dialog = dialogNamed(view.body, "Machine Settings")!;
    assert.ok(dialog, "Machine Settings opens");
    const limit = dialog.querySelector<HTMLInputElement>('input[type="number"]');
    assert.ok(limit, "the limit's field is there");
    assert.ok((domWindow.document.activeElement as unknown) === limit, "with focus in Capacity Limit (#2991)");
    const headings = [...dialog.querySelectorAll("h3, legend")].map((heading) => heading.textContent);
    assert.ok(!headings.includes("Workspaces"), headings.join(", "));
    for (const label of ["Runner Capacity Usage", "Capacity Dimensions", "Current Capacity Bottlenecks", "Capacity Breakdown"]) {
      assertNoDomNode(dialog.querySelector(`[aria-label="${label}"]`), `no ${label} in Machine Settings`);
    }
    assertNoDomNode(dialog.querySelector(".meter"), "no meter in Machine Settings");
    assert.doesNotMatch(dialog.textContent ?? "", /Units Used|Waiting for live capacity|Add Workspace|No Workspaces/);
  } finally {
    await view.unmount();
  }
});

test("Workspaces lists each one with its folder's path truncated from the start, and says when there are none", async () => {
  const view = await mount(busy);
  try {
    const section = sectionNamed(view.detail(), "Workspaces")!;
    assert.equal(section.querySelector(".section-title .count")?.textContent, "2");
    const rows = [...section.querySelectorAll<HTMLElement>(".surface > .row")];
    assert.deepEqual(rows.map((row) => row.querySelector(".row-title")?.textContent), ["Home", "Storefront"]);
    const path = rows[1]!.querySelector<HTMLElement>(".machine-workspace-path")!;
    assert.equal(path.getAttribute("title"), busy.workspaces[1]!.path, "the full path is the tooltip");
    assert.equal(path.querySelector("bdi")?.textContent, busy.workspaces[1]!.path);
    assert.ok(rows[0]!.querySelector(".row-icon svg"), "a folder icon");
  } finally {
    await view.unmount();
  }
  const empty = await mount(runner("empty"));
  try {
    const section = sectionNamed(empty.detail(), "Workspaces")!;
    assert.equal(section.querySelector(".machine-section-state")?.textContent, "No workspaces yet.");
    assertNoDomNode(section.querySelector(".surface"));
  } finally {
    await empty.unmount();
  }
});

test("Add Workspace… is for owners and admins, and waits with its reason while the machine cannot browse folders", async () => {
  const member = await mount(busy, { role: "member" });
  try {
    assertNoDomNode(buttonNamed(sectionNamed(member.detail(), "Workspaces")!, "Add Workspace…"), "members do not add workspaces");
  } finally {
    await member.unmount();
  }
  for (const [machine, reason] of [
    [runner("away", { status: "offline" }), ADD_WORKSPACE_OFFLINE],
    [runner("old", { protocolVersion: 1 }), ADD_WORKSPACE_NO_BROWSING],
  ] as const) {
    const view = await mount(machine);
    try {
      const section = sectionNamed(view.detail(), "Workspaces")!;
      const add = buttonNamed(section, "Add Workspace…")!;
      assert.ok(add.disabled, `${machine.runnerId}: disabled`);
      const helper = section.querySelector<HTMLElement>(".section-note")!;
      assert.equal(helper.textContent, reason, "the reason is visible");
      assert.equal(add.getAttribute("aria-describedby"), helper.id);
    } finally {
      await view.unmount();
    }
  }
});

test("Add Workspace fills the name from the folder, checks it on submit, registers it, closes, and the row arrives", async () => {
  const registered: Array<{ runnerId: string; name: string; path: string }> = [];
  let fail = false;
  const view = await mount(runner("studio"), {
    client: {
      listDirectory: async (_runnerId: string, path: string) => ({
        path: path || "/home/ada/acme-storefront",
        parent: "/home/ada",
        entries: [],
      }),
      registerMachineWorkspace: async (runnerId: string, body: { name: string; path: string }) => {
        if (fail) throw new Error("The folder is not readable by the runner.");
        registered.push({ runnerId, ...body });
        return { workspace: { id: "new", ...body } };
      },
    } as Partial<ApiClient>,
  });
  try {
    await act(async () => buttonNamed(sectionNamed(view.detail(), "Workspaces")!, "Add Workspace…")!.click());
    await settle();
    const dialog = dialogNamed(view.body, "Add Workspace")!;
    assert.ok(dialog, "the dialog opens");
    assert.equal(dialog.querySelector(".modal-desc")?.textContent, "Studio Mac", "the machine's name is its description");
    const name = dialog.querySelector<HTMLInputElement>("input[autocomplete=off]")!;
    assert.equal(name.value, "acme-storefront", "filled from the folder's name");

    await type(name, "  ");
    await act(async () => buttonNamed(dialog, "Add Workspace")!.click());
    await settle();
    assert.equal(name.getAttribute("aria-invalid"), "true");
    assert.equal(dialog.querySelector(".field-error")?.textContent, "Enter a workspace name.");
    assert.equal(registered.length, 0, "nothing is sent with an empty name");

    fail = true;
    await type(name, "Storefront");
    await act(async () => buttonNamed(dialog, "Add Workspace")!.click());
    await settle();
    const failure = dialog.querySelector<HTMLElement>('.notice.t-danger[role="alert"]')!;
    assert.match(failure.textContent ?? "", /Couldn't Add the Workspace.*not readable/u);
    assert.ok(dialogNamed(view.body, "Add Workspace"), "a failure keeps the dialog open");

    fail = false;
    await act(async () => buttonNamed(dialog, "Add Workspace")!.click());
    await settle();
    assert.deepEqual(registered, [{ runnerId: "studio", name: "Storefront", path: "/home/ada/acme-storefront" }]);
    assertNoDomNode(dialogNamed(view.body, "Add Workspace") ?? null, "the dialog closes");

    await view.push(runner("studio", { workspaces: [{ id: "new", name: "Storefront", path: "/home/ada/acme-storefront" }] }));
    const rows = [...sectionNamed(view.detail(), "Workspaces")!.querySelectorAll(".surface > .row .row-title")];
    assert.deepEqual(rows.map((row) => row.textContent), ["Storefront"], "the row comes with the snapshot");
  } finally {
    await view.unmount();
  }
});

test("the meta items, blocker sentences, folder names and Connection Details' Idle Processes row", () => {
  assert.deepEqual(capacityMetaItems(busy.capacity).map((item) => `${item.label} ${item.value}`),
    ["Active Turns 3 of 8", "Queued 2", "Idle Resumable 5", "Parked 1"]);
  assert.deepEqual(capacityMetaItems(live(4, 1)), []);
  assert.equal(capacityBlockerSentence({ description: "Already a sentence.", waitingSessions: 0 }), "Already a sentence.");
  assert.equal(capacityBlockerSentence({ description: "slots are full" }), "Slots are full.");
  assert.equal(workspaceNameFromPath("/home/ada/acme-storefront/"), "acme-storefront");
  assert.equal(workspaceNameFromPath("C:\\Users\\ada\\repo"), "repo");
  const idle = (machine: RunnerView) => connectionFacts(machine, undefined, machine.runnerId).find((fact) => fact.label === "Idle Processes")!;
  assert.equal(idle(busy).value, "Park When Needed");
  assert.ok(idle(busy).extra, "it points at runner.config.json");
  assert.equal(idle(runner("plain")).value, null, "Not available without a report");
});
