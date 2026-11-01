import { fireDomEvent } from "./test-dom-events.js";
import assert from "node:assert/strict";
import { afterEach, test } from "node:test";
import React, { act } from "react";
import { createRoot } from "react-dom/client";
import { Window } from "happy-dom";
import type { IdentityAdministrationView, RunnerView, UiSnapshotMessage } from "@wollipog/protocol";
import { api, type ApiClient } from "../api.js";
import { ApiProvider } from "../api-context.js";
import { assertNoDomNode } from "../dom-test-assertions.js";
import { installDomTestCleanup } from "../dom-test-cleanup.js";
import { browserInstanceManager, InstancesContextProvider, type InstanceManager } from "../instances-context.js";
import type { LocalRunnerStatus } from "../local-runner.js";
import type { View, ViewNavigation } from "../navigation.js";
import { StoreProvider } from "../store.js";
import { UI_SOCKET_OPEN, type UiConnectionRuntime, type UiSocket } from "../ui-transport.js";
import { FeedbackProvider } from "./FeedbackProvider.js";
import { RunnersView } from "./RunnersView.js";

/**
 * The Connections frame (#2984): one header for every tab, one Add Machine menu, and an empty
 * Machines tab that offers the ways to connect. Dialogs and menus are portalled, so the tests read
 * the document body.
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

const runner: RunnerView = {
  runnerId: "runner-1",
  hostname: "runner-host",
  os: "linux",
  version: "1",
  status: "online",
  agents: [],
  workspaces: [],
  connectedAt: 1,
  lastSeen: 1,
  protocolVersion: 63,
};

function snapshot(runners: RunnerView[]): UiSnapshotMessage {
  return {
    type: "snapshot",
    capabilities: { sessionSubscriptions: false, boundedDelivery: false, paginatedSessionHistory: false, projects: true },
    runners, boxes: [], projects: [], sessions: [], runs: [], pods: [],
  };
}

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

const identity = (role: "owner" | "admin" | "member" | "viewer") =>
  ({ context: { role }, organizations: [], memberships: [], teams: [] }) as unknown as IdentityAdministrationView;

/** The desktop app's bundled runner, as `local-runner.ts` reads it through Tauri. */
function installDesktopRunner(status: LocalRunnerStatus) {
  Object.defineProperty(globalThis, "isTauri", { configurable: true, writable: true, value: true });
  Object.defineProperty(domWindow, "__TAURI_INTERNALS__", {
    configurable: true,
    writable: true,
    value: { invoke: async (command: string) => command === "local_runner_status" ? status : null },
  });
}

afterEach(async () => {
  Reflect.deleteProperty(globalThis, "isTauri");
  Reflect.deleteProperty(domWindow, "__TAURI_INTERNALS__");
  await act(async () => domWindow.happyDOM.setWindowSize({ width: 1440, height: 900 }));
});

const multiInstance: InstanceManager = {
  ...browserInstanceManager,
  desktopMultiInstance: true,
  registry: {
    profiles: [
      browserInstanceManager.activeProfile,
      { ...browserInstanceManager.activeProfile, id: "remote-1", kind: "remote", label: "Build Box" },
    ],
    activeInstanceId: "local",
  },
};

let sequence = 0;

async function mount({
  client = {},
  instances = browserInstanceManager,
  view = { name: "runners", section: "machines" },
  runners = [runner],
}: {
  client?: Partial<ApiClient>;
  instances?: InstanceManager;
  view?: View;
  runners?: RunnerView[] | null;
}) {
  const mountPoint = domWindow.document.createElement("div") as unknown as HTMLDivElement;
  domWindow.document.body.append(mountPoint as never);
  const body = domWindow.document.body as unknown as HTMLElement;
  const root = createRoot(mountPoint);
  const socket = new FakeSocket();
  const pushed: View[] = [];
  const replaced: View[] = [];
  const navigation: ViewNavigation = {
    current: () => view,
    push: (next) => { pushed.push(next); },
    replace: (next) => { replaced.push(next); },
    listen: () => () => {},
  };
  sequence += 1;
  const connection: UiConnectionRuntime = {
    instanceId: `runners-frame-${sequence}`,
    runtimeKey: `runners-frame-${sequence}:1`,
    createSocket: () => socket,
    close() {},
  };
  const render = (overrides: Partial<ApiClient>) => act(async () => {
    const apiClient = {
      ...api,
      getIdentity: async () => identity("owner"),
      sshConfigHosts: async () => ({ hosts: [] }),
      listSkills: async () => ({ skills: [] }),
      ...overrides,
    } as unknown as ApiClient;
    root.render(
      <ApiProvider client={apiClient}>
        <InstancesContextProvider value={instances}>
          <FeedbackProvider>
            <StoreProvider connection={connection} navigation={navigation}><RunnersView /></StoreProvider>
          </FeedbackProvider>
        </InstancesContextProvider>
      </ApiProvider>,
    );
  });
  await render(client);
  if (runners) await act(async () => { socket.push(snapshot(runners)); });
  await settle();
  return {
    body,
    pushed,
    replaced,
    /** A new API client, as an instance switch supplies: the view loads its permissions again. */
    swapClient: render,
    unmount: async () => { await act(async () => root.unmount()); mountPoint.remove(); },
  };
}

const settle = () => act(async () => { for (let index = 0; index < 5; index += 1) await Promise.resolve(); });

const header = (body: HTMLElement) => body.querySelector(".page-header")!;
const tabLabels = (body: HTMLElement) => [...body.querySelectorAll('[role="tab"]')].map((tab) => tab.textContent);
const addMachine = (body: HTMLElement) => header(body).querySelector<HTMLButtonElement>(".page-primary");
const menuItems = (menu: Element) => [...menu.querySelectorAll<HTMLButtonElement>('[role="menuitem"]')];
const dialogTitle = (body: HTMLElement) => body.querySelector('[role="dialog"] h2, [role="dialog"] .modal-title')?.textContent;

async function press(target: Element, key: string) {
  await act(async () => {
    target.dispatchEvent(new domWindow.KeyboardEvent("keydown", { key, bubbles: true }) as unknown as Event);
  });
}

async function openAddMachine(body: HTMLElement): Promise<Element> {
  const trigger = addMachine(body);
  assert.ok(trigger, "the header offers Add Machine");
  await act(async () => trigger.click());
  const menu = body.querySelector('[role="menu"][aria-label="Add Machine"]');
  assert.ok(menu, "Add Machine opens its menu");
  return menu;
}

test("Connections has one header named for the page, its tabs in order, and no count line under them", async () => {
  const view = await mount({});
  try {
    const { body } = view;
    assert.deepEqual([...body.querySelectorAll("h1")].map((h1) => h1.textContent), ["Connections"]);
    assertNoDomNode(header(body).querySelector(".page-desc"), "Connections has no description (#1945)");
    const tablist = header(body).querySelector('.page-tabs [role="tablist"]');
    assert.equal(tablist?.getAttribute("aria-label"), "Connections");
    assert.deepEqual(tabLabels(body), ["Machines 1", "People and Devices"]);
    assertNoDomNode(body.querySelector(".connections-panel > .toolbar"), "the tab's count is not said twice");
    assert.doesNotMatch(body.textContent ?? "", /\b1 Machine\b|dashboard/);
    // The Machines tab is a master-detail that fills the column (#2985).
    assert.equal(body.querySelector(".page")?.className, "page full fill");
  } finally {
    await view.unmount();
  }

  const desktop = await mount({ instances: multiInstance });
  try {
    assert.deepEqual(tabLabels(desktop.body), ["Machines 1", "Instances 2", "People and Devices"]);
    // The People and Devices tab supplies no header actions here; its own work fills the slot.
    await act(async () => fireDomEvent.click([...desktop.body.querySelectorAll('[role="tab"]')][2] as never));
    assert.deepEqual(desktop.pushed, [{ name: "runners", section: "people" }]);
  } finally {
    await desktop.unmount();
  }
});

test("Add Machine is one menu of two-line methods; each opens its dialog, and Escape returns focus", async () => {
  const view = await mount({});
  try {
    const { body } = view;
    assert.equal(header(body).querySelectorAll("button.page-action").length, 0, "no secondaries beside it");
    const trigger = addMachine(body)!;
    assert.equal(trigger.textContent, "Add Machine");
    let menu = await openAddMachine(body);
    // The web app offers no local setup: SSH and a manual install.
    assert.deepEqual(menuItems(menu).map((item) =>
      [item.querySelector(".menu-text")?.textContent, item.querySelector(".menu-desc")?.textContent]), [
      ["Connect via SSH…", "Wollipog installs and starts the runner for you over SSH."],
      ["Install Manually…", "Run the runner yourself on any machine with Node.js."],
    ]);
    await press(menu, "Escape");
    assert.ok(body.querySelector('[role="menu"]') === null, "Escape closes the menu");
    await act(async () => { await new Promise((resolve) => domWindow.setTimeout(resolve, 5)); });
    assert.ok(domWindow.document.activeElement === (trigger as never), "and returns focus to Add Machine");

    menu = await openAddMachine(body);
    await act(async () => menuItems(menu)[0]!.click());
    assert.equal(body.querySelector('[role="dialog"]')?.getAttribute("aria-label") ?? dialogTitle(body), "Connect via SSH");
  } finally {
    await view.unmount();
  }

  const manual = await mount({});
  try {
    const menu = await openAddMachine(manual.body);
    await act(async () => menuItems(menu)[1]!.click());
    assert.equal(dialogTitle(manual.body), "Install Manually");
  } finally {
    await manual.unmount();
  }

  // The desktop app with its bundled runner leads with This Machine; an enabled but offline runner
  // reconnects instead.
  installDesktopRunner({ available: true, enabled: true, running: false, runnerId: "this-machine" });
  const desktop = await mount({});
  try {
    const menu = await openAddMachine(desktop.body);
    assert.deepEqual(menuItems(menu).map((item) => item.querySelector(".menu-text")?.textContent),
      ["Reconnect This Machine…", "Connect via SSH…", "Install Manually…"]);
    assert.equal(menuItems(menu)[0]!.querySelector(".menu-desc")?.textContent, "Use the runner built into the Wollipog desktop app.");
    await act(async () => menuItems(menu)[0]!.click());
    assert.match(desktop.body.querySelector('[role="dialog"]')?.textContent ?? "", /This Machine/);
  } finally {
    await desktop.unmount();
  }
});

test("only owners and admins see Add Machine", async () => {
  for (const [role, offered] of [["owner", true], ["admin", true], ["member", false], ["viewer", false]] as const) {
    const view = await mount({ client: { getIdentity: async () => identity(role) } });
    try {
      assert.equal(Boolean(addMachine(view.body)), offered, `${role}: Add Machine ${offered ? "shown" : "hidden"}`);
    } finally {
      await view.unmount();
    }
  }
});

test("the empty Machines tab owns the create actions: three method rows for an owner, a sentence for a viewer", async () => {
  // The web app: no local setup, so SSH is the primary.
  const web = await mount({ runners: [] });
  try {
    const { body } = web;
    assertNoDomNode(addMachine(body), "the header hides Add Machine while the state offers it");
    const state = body.querySelector(".state.connections-empty")!;
    assert.equal(state.querySelector(".state-title")?.textContent, "No Machines Yet");
    assert.equal(state.querySelector(".state-body")?.textContent,
      "Wollipog runs agents on machines you connect. Choose how to connect the first one.");
    assert.ok(state.querySelector(".state-icon svg"));
    const rows = [...body.querySelectorAll(".connections-empty .surface > .row.row-2")];
    assert.deepEqual(rows.map((row) => [
      row.querySelector(".row-title")?.textContent,
      row.querySelector(".row-sub")?.textContent,
      row.querySelector("button")?.textContent,
      row.querySelector("button")?.className,
    ]), [
      ["Over SSH", "Wollipog installs and starts the runner for you over SSH.", "Connect via SSH", "btn primary"],
      ["Manual Install", "Run the runner yourself on any machine with Node.js.", "Install Manually", "btn"],
    ]);
    assert.ok(rows.every((row) => row.querySelector(".row-icon svg")), "each method has its icon");
    await act(async () => rows[1]!.querySelector("button")!.click());
    assert.equal(dialogTitle(body), "Install Manually", "each row opens its dialog");
  } finally {
    await web.unmount();
  }

  // The desktop app with a bundled runner: This Machine is the primary.
  installDesktopRunner({ available: true, enabled: false, running: false, runnerId: null });
  const desktop = await mount({ runners: [] });
  try {
    const buttons = [...desktop.body.querySelectorAll(".connections-empty .row button")];
    assert.deepEqual(buttons.map((button) => [button.textContent, button.className]), [
      ["Set Up This Machine", "btn primary"],
      ["Connect via SSH", "btn"],
      ["Install Manually", "btn"],
    ]);
    assert.equal(desktop.body.querySelector(".connections-empty .row .row-title")?.textContent, "This Machine");
  } finally {
    await desktop.unmount();
  }

  const viewer = await mount({ runners: [], client: { getIdentity: async () => identity("viewer") } });
  try {
    assert.equal(viewer.body.querySelector(".connections-empty .state-body")?.textContent,
      "Ask an organization owner or admin to connect a machine.");
    assertNoDomNode(viewer.body.querySelector(".connections-empty .surface"), "a viewer gets no rows");
    assertNoDomNode(addMachine(viewer.body));
  } finally {
    await viewer.unmount();
  }

  // Before the first snapshot an empty list proves nothing: the tab is loading, and the header keeps
  // Add Machine.
  const loading = await mount({ runners: null });
  try {
    // Skeleton rows say so (#2985).
    assert.equal(loading.body.querySelector(".master-detail-list .skeleton .sr-only")?.textContent, "Loading machines");
    assertNoDomNode(loading.body.querySelector(".connections-empty"));
    assert.ok(addMachine(loading.body));
  } finally {
    await loading.unmount();
  }
});

test("the Instances tab is a 960px page of rows whose header's one primary is Add Remote Instance…", async () => {
  const opened: Parameters<InstanceManager["openInstanceDialog"]>[0][] = [];
  const view = await mount({
    instances: { ...multiInstance, openInstanceDialog(options) { opened.push(options); } },
    view: { name: "runners", section: "instances" },
  });
  try {
    const { body } = view;
    assert.equal(body.querySelector(".page")?.className, "page", "the shared 960px page, as People and Devices");
    const panel = body.querySelector("#connections-instances-panel")!;
    assert.ok(panel.querySelector(":scope > .surface.instance-list"), "one surface of rows");
    assertNoDomNode(panel.querySelector(".toolbar"), "no count toolbar: the tab carries the count");
    const primary = header(body).querySelector<HTMLButtonElement>(".page-primary")!;
    assert.equal(primary.textContent, "Add Remote Instance…");
    assert.equal(body.querySelectorAll(".btn.primary").length, 1, "the page's only primary");
    await act(async () => primary.click());
    assert.equal(opened.length, 1);
    assert.equal(opened[0]!.mode, "add");
    assert.ok(opened[0]!.returnFocus === (primary as never), "the dialog returns focus to it");
  } finally {
    await view.unmount();
  }
});

test("on a phone there is no Instances tab, its route lands on Machines in place, and `+` opens the methods", async () => {
  await act(async () => domWindow.happyDOM.setWindowSize({ width: 390, height: 844 }));
  const view = await mount({ instances: multiInstance, view: { name: "runners", section: "instances" } });
  try {
    const { body } = view;
    assert.deepEqual(tabLabels(body), ["Machines 1", "People and Devices"]);
    assert.equal(body.querySelector('[role="tab"][aria-selected="true"]')?.textContent, "Machines 1");
    assert.ok(body.querySelector("#connections-machines-panel"));
    assert.deepEqual(view.replaced, [{ name: "runners", section: "machines" }], "a replace, so Back does not return to it");
    assert.deepEqual(view.pushed, []);
    // None of the Instances tab renders: its rows, its panel or its header primary (#3002).
    assertNoDomNode(body.querySelector("#connections-instances-panel, .instance-list, .instance-row"));
    assert.doesNotMatch(header(body).textContent ?? "", /Add Remote Instance/);
    const plus = addMachine(body)!;
    assert.equal(plus.textContent, "Add Machine", "the `+` is named Add Machine");
    const sheet = await openAddMachine(body);
    assert.ok(sheet.querySelector(".sheet-grabber"));
    assert.deepEqual(menuItems(sheet).map((item) => item.querySelector(".menu-text")?.textContent),
      ["Connect via SSH…", "Install Manually…"]);
  } finally {
    await view.unmount();
  }
});

test("a failed permission load is a danger notice with Retry, and a successful retry removes it", async () => {
  let attempts = 0;
  const view = await mount({
    client: {
      getIdentity: async () => {
        attempts += 1;
        if (attempts === 1) throw new Error("permission service unavailable");
        return identity("owner");
      },
    },
  });
  try {
    const { body } = view;
    const notice = body.querySelector("#connections-machines-panel > .notice.t-danger")!;
    assert.ok(notice, "the failure is a danger notice");
    assert.equal(notice.getAttribute("role"), "alert");
    assert.ok(notice.classList.contains("compact"));
    assert.equal(notice.querySelector(".notice-title")?.textContent, "Couldn't Load Machine Permissions");
    assert.doesNotMatch(notice.textContent ?? "", /permission service unavailable/, "the raw error waits behind Show Details");
    const details = [...notice.querySelectorAll("button")].find((button) => button.textContent === "Show Details")!;
    await act(async () => details.click());
    assert.match(notice.textContent ?? "", /permission service unavailable/);
    assertNoDomNode(body.querySelector(".connection-access-error"));
    assertNoDomNode(addMachine(body), "without permissions the header offers nothing");

    const retry = [...notice.querySelectorAll("button")].find((button) => button.textContent === "Retry")!;
    await act(async () => retry.click());
    await settle();
    assert.equal(attempts, 2, "Retry loads the permissions again");
    assertNoDomNode(body.querySelector("#connections-machines-panel > .notice"), "and the notice goes on success");
    assert.ok(addMachine(body));
  } finally {
    await view.unmount();
  }
});

test("an earlier permission load that fails after a later one succeeded does not bring the notice back", async () => {
  const loads: Array<{ resolve: (value: IdentityAdministrationView) => void; reject: (error: Error) => void }> = [];
  // Two loads in flight at once (a new API client here; React's development double effect does the
  // same), and the first answers last, with a failure.
  const getIdentity = () => new Promise<IdentityAdministrationView>((resolve, reject) => { loads.push({ resolve, reject }); });
  const view = await mount({ client: { getIdentity } });
  try {
    const { body } = view;
    await view.swapClient({ getIdentity });
    assert.equal(loads.length, 2);
    await act(async () => loads[1]!.resolve(identity("owner")));
    await settle();
    await act(async () => loads[0]!.reject(new Error("stale load failed")));
    await settle();
    assertNoDomNode(body.querySelector("#connections-machines-panel > .notice"));
    assert.ok(addMachine(body));
  } finally {
    await view.unmount();
  }
});
