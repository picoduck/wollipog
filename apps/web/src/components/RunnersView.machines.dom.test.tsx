import { fireDomEvent } from "./test-dom-events.js";
import assert from "node:assert/strict";
import { afterEach, test } from "node:test";
import React, { act } from "react";
import { createRoot } from "react-dom/client";
import { Window } from "happy-dom";
import type { BoxView, IdentityAdministrationView, RunnerView, UiSnapshotMessage } from "@wollipog/protocol";
import { api, ApiError, type ApiClient } from "../api.js";
import { ApiProvider } from "../api-context.js";
import { assertNoDomNode } from "../dom-test-assertions.js";
import { installDomTestCleanup } from "../dom-test-cleanup.js";
import { browserInstanceManager, InstancesContextProvider } from "../instances-context.js";
import { encodeResourceId, viewFromPath, viewPath, type View, type ViewNavigation } from "../navigation.js";
import { StoreProvider } from "../store.js";
import { UI_SOCKET_OPEN, type UiConnectionRuntime, type UiSocket } from "../ui-transport.js";
import { FeedbackProvider } from "./FeedbackProvider.js";
import { RunnersView } from "./RunnersView.js";

/**
 * The Machines tab as a master-detail (#2985): rows sorted by what needs the person beside the
 * selected machine, the selection in the URL, and list and detail routes on a phone. Dialogs are
 * portalled, so the tests read the document body.
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

function runner(runnerId: string, overrides: Partial<RunnerView> = {}): RunnerView {
  return {
    runnerId,
    hostname: `${runnerId}-host`,
    os: "linux",
    version: "1",
    status: "online",
    agents: [],
    workspaces: [],
    connectedAt: 1,
    lastSeen: 1,
    ...overrides,
  };
}

const zeta = runner("zeta", { displayName: "Zeta", status: "offline" });
const alpha = runner("alpha", { displayName: "Alpha", capacity: { configuredUnits: 40, usedUnits: 29, revision: 1, authority: "control_plane" } as RunnerView["capacity"] });
const beta = runner("beta", { displayName: "Beta" });

function snapshot(runners: RunnerView[], boxes: BoxView[] = []): UiSnapshotMessage {
  return {
    type: "snapshot",
    capabilities: { sessionSubscriptions: false, boundedDelivery: false, paginatedSessionHistory: false, projects: true },
    runners, boxes, projects: [], sessions: [], runs: [], pods: [],
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

const identity = { context: { role: "owner" }, organizations: [], memberships: [], teams: [] } as unknown as IdentityAdministrationView;

/** A browser history in memory: pushes and replacements are recorded, and Back is real. */
class MemoryHistory implements ViewNavigation {
  readonly entries: View[];
  index = 0;
  readonly pushed: View[] = [];
  readonly replaced: View[] = [];
  private listener: ((view: View) => void) | null = null;
  constructor(initial: View) { this.entries = [initial]; }
  current() { return this.entries[this.index]!; }
  push(view: View) {
    this.entries.splice(this.index + 1, Infinity, view);
    this.index += 1;
    this.pushed.push(view);
  }
  replace(view: View) {
    this.entries[this.index] = view;
    this.replaced.push(view);
  }
  listen(onView: (view: View) => void) {
    this.listener = onView;
    return () => { this.listener = null; };
  }
  async back() {
    this.index -= 1;
    await act(async () => this.listener?.(this.entries[this.index]!));
    await settle();
  }
  async forward() {
    this.index += 1;
    await act(async () => this.listener?.(this.entries[this.index]!));
    await settle();
  }
}

let sequence = 0;

async function mount({ view = { name: "runners", section: "machines" }, runners = [zeta, alpha, beta], boxes = [], client: overrides = {} }: {
  view?: View;
  runners?: RunnerView[] | null;
  boxes?: BoxView[];
  client?: Partial<ApiClient>;
} = {}) {
  const mountPoint = domWindow.document.createElement("div") as unknown as HTMLDivElement;
  domWindow.document.body.append(mountPoint as never);
  const body = domWindow.document.body as unknown as HTMLElement;
  const root = createRoot(mountPoint);
  const socket = new FakeSocket();
  const history = new MemoryHistory(view);
  sequence += 1;
  const connection: UiConnectionRuntime = {
    instanceId: `runners-machines-${sequence}`,
    runtimeKey: `runners-machines-${sequence}:1`,
    createSocket: () => socket,
    close() {},
  };
  const client = {
    ...api,
    getIdentity: async () => identity,
    sshConfigHosts: async () => ({ hosts: [] }),
    listSkills: async () => ({ skills: [] }),
    ...overrides,
  } as unknown as ApiClient;
  await act(async () => {
    root.render(
      <ApiProvider client={client}>
        <InstancesContextProvider value={browserInstanceManager}>
          <FeedbackProvider>
            <StoreProvider connection={connection} navigation={history}><RunnersView /></StoreProvider>
          </FeedbackProvider>
        </InstancesContextProvider>
      </ApiProvider>,
    );
  });
  if (runners) await act(async () => { socket.push(snapshot(runners, boxes)); });
  await settle();
  return {
    body,
    history,
    socket,
    push: async (message: UiSnapshotMessage | { type: "box_upsert"; box: BoxView }) => {
      await act(async () => socket.push(message as UiSnapshotMessage));
      await settle();
    },
    disconnect: async () => { await act(async () => socket.onclose?.({ code: 1006 })); await settle(); },
    unmount: async () => { await act(async () => root.unmount()); mountPoint.remove(); },
  };
}

const settle = () => act(async () => { for (let index = 0; index < 5; index += 1) await Promise.resolve(); });

const list = (body: HTMLElement) => body.querySelector<HTMLElement>('aside.master-detail-list[aria-label="Machines"]')!;
const rows = (body: HTMLElement) => [...list(body).querySelectorAll<HTMLButtonElement>("button.row.row-2")];
const rowNames = (body: HTMLElement) => rows(body).map((row) => row.querySelector(".row-title")?.textContent);
const row = (body: HTMLElement, name: string) => rows(body).find((item) => item.querySelector(".row-title")?.textContent === name)!;
const detail = (body: HTMLElement) => body.querySelector<HTMLElement>(".master-detail-detail")!;
/** The open machine (#2988), named on every width: a phone's detail has no title of its own. */
const machineDetail = (body: HTMLElement) => detail(body).querySelector<HTMLElement>("article.machine-detail");
const detailName = (body: HTMLElement) => machineDetail(body)?.getAttribute("aria-label");
/** The All Machines row (#2986) and the overview it opens. */
const allMachinesRow = (body: HTMLElement) => list(body).querySelector<HTMLButtonElement>("button.row.machine-list-overview");
const overview = (body: HTMLElement) => detail(body).querySelector<HTMLElement>(".machines-overview");
/** Desktop and compact widths with nothing selected: the overview, under the selected All Machines row. */
function assertOverviewShown(body: HTMLElement, message?: string) {
  assert.ok(overview(body), message ?? "the detail is the All Machines overview");
  assert.ok(allMachinesRow(body)?.classList.contains("is-selected"), "All Machines is selected");
  assert.equal(body.querySelectorAll(".row.is-selected").length, 1, "and no machine is");
}

async function setWidth(width: number) {
  await act(async () => domWindow.happyDOM.setWindowSize({ width, height: 900 }));
  await settle();
}

afterEach(async () => {
  await setWidth(1440);
});

test("the Machines tab is a list beside the detail in a fill page, with no card grid", async () => {
  const view = await mount();
  try {
    const page = view.body.querySelector(".page")!;
    assert.equal(page.className, "page full fill");
    assertNoDomNode(view.body.querySelector(".runner-grid"));
    const pane = list(view.body);
    assert.equal(pane.getAttribute("data-focus-zone"), "list");
    assert.equal(detail(view.body).getAttribute("data-focus-zone"), "main");
    assert.ok(pane.parentElement?.classList.contains("master-detail"));
    // Eight or fewer: neither the filter nor the group labels.
    assertNoDomNode(pane.querySelector('input[aria-label="Filter Machines"]'));
    assert.equal(pane.querySelectorAll(".group-label").length, 0);
  } finally {
    await view.unmount();
  }
});

test("rows are sorted by what needs the person, each with exactly one badge and its meta", async () => {
  const view = await mount();
  try {
    assert.deepEqual(rowNames(view.body), ["Zeta", "Alpha", "Beta"]);
    for (const item of rows(view.body)) {
      assert.equal(item.querySelectorAll(".status").length, 1, `${item.textContent} shows one badge`);
    }
    assert.equal(row(view.body, "Zeta").querySelector(".status")?.textContent, "Offline");
    assert.equal(row(view.body, "Alpha").querySelector(".status")?.textContent, "Online");
    assert.equal(row(view.body, "Alpha").querySelector(".row-title")?.getAttribute("title"), "Alpha");
    assert.deepEqual([...row(view.body, "Alpha").querySelectorAll(".machine-row-meta > span")].map((span) => span.textContent),
      ["Native Runner", "29 of 40 Units"]);
    assert.deepEqual([...row(view.body, "Beta").querySelectorAll(".machine-row-meta > span")].map((span) => span.textContent),
      ["Native Runner"], "no capacity is shown where none is reported");
  } finally {
    await view.unmount();
  }
});

test("at 1440px with no selection, All Machines is selected and the detail is the overview; no machine is auto-selected (#2986)", async () => {
  const view = await mount();
  try {
    assert.equal(view.history.replaced.length, 0, "nothing replaces the route");
    assert.equal(view.history.pushed.length, 0);
    assert.equal(viewPath(view.history.current()), "/connections/machines");
    assertNoDomNode(detail(view.body).querySelector(".runner-card"), "no machine's detail");
    assertOverviewShown(view.body);
    const all = allMachinesRow(view.body)!;
    assert.equal(list(view.body).querySelector(".master-detail-list-body button.row"), all, "All Machines is the list's first row");
    assert.equal(all.getAttribute("aria-current"), "true");
    assert.ok(!all.classList.contains("row-2"), "a single-line row");
    assert.equal(all.querySelector(".row-title")?.textContent, "All Machines");
    assert.equal(all.querySelector(".row-trail")?.textContent, "3", "the machine count as plain trailing text");
    assert.ok(all.querySelector(".row-icon svg"), "after its icon");
    assert.equal(overview(view.body)!.querySelector("h2")?.textContent, "All Machines");

    // A machine's row opens it; All Machines comes back to the overview.
    await act(async () => row(view.body, "Alpha").click());
    await settle();
    assert.equal(detailName(view.body), "Alpha");
    assert.ok(!allMachinesRow(view.body)!.classList.contains("is-selected"));
    await act(async () => allMachinesRow(view.body)!.click());
    await settle();
    assert.deepEqual(view.history.current(), { name: "runners", section: "machines" });
    assertOverviewShown(view.body);
  } finally {
    await view.unmount();
  }
});

test("a machine's URL opens it directly, selecting a row changes the URL, and Back returns to the previous one", async () => {
  // A reload reads the route from the address bar.
  const reloaded = viewFromPath(viewPath({ name: "runners", section: "machines", machineId: "beta" }))!;
  const view = await mount({ view: reloaded });
  try {
    assert.equal(detailName(view.body), "Beta");
    assert.ok(row(view.body, "Beta").classList.contains("is-selected"));
    assert.equal(view.history.replaced.length, 0, "a deep link is not replaced by the first row");

    const scroller = detail(view.body);
    scroller.scrollTop = 120;
    await act(async () => row(view.body, "Alpha").click());
    await settle();
    assert.deepEqual(view.history.pushed, [{ name: "runners", section: "machines", machineId: "alpha" }]);
    assert.equal(detailName(view.body), "Alpha");
    assert.equal(scroller.scrollTop, 0, "each selection starts the detail at its top");

    await view.history.back();
    assert.equal(detailName(view.body), "Beta");
    assert.ok(row(view.body, "Beta").classList.contains("is-selected"));
  } finally {
    await view.unmount();
  }
});

test("a machine id that no longer exists is Machine Not Found, whose Show All Machines returns to the list", async () => {
  const view = await mount({ view: { name: "runners", section: "machines", machineId: "gone" } });
  try {
    const state = detail(view.body).querySelector(".state")!;
    assert.match(state.textContent ?? "", /Machine Not Found/);
    assert.match(state.textContent ?? "", /It may have been deleted\./);
    assert.equal(view.body.querySelectorAll(".row.is-selected").length, 0);
    const showAll = [...state.querySelectorAll("button")].find((button) => button.textContent === "Show All Machines")!;
    await act(async () => showAll.click());
    await settle();
    assert.deepEqual(view.history.pushed, [{ name: "runners", section: "machines" }]);
    // Then the overview is the default detail again.
    assertOverviewShown(view.body);
  } finally {
    await view.unmount();
  }
});

test("with nine machines the list filters and groups under Needs Attention, Online and Offline; with eight it does neither", async () => {
  const many = [
    runner("old", { displayName: "Old Laptop", protocolVersion: 1 }),
    runner("down", { displayName: "Downstairs", status: "offline" }),
    ...["Build A", "Build B", "Build C", "Build D", "Build E", "Studio"].map((name) => runner(name.toLowerCase().replace(" ", "-"), { displayName: name })),
  ];
  const nine = [...many, runner("gpu", { displayName: "GPU Box" })];
  const eight = await mount({ runners: many });
  try {
    assert.equal(rows(eight.body).length, 8);
    assertNoDomNode(list(eight.body).querySelector('input[aria-label="Filter Machines"]'));
    assert.equal(list(eight.body).querySelectorAll(".group-label").length, 0);
  } finally {
    await eight.unmount();
  }

  const view = await mount({ runners: nine });
  try {
    const labels = () => [...list(view.body).querySelectorAll(".group-label")].map((label) => label.firstChild?.textContent);
    const counts = () => [...list(view.body).querySelectorAll(".group-label > .count")].map((count) => count.textContent);
    assert.deepEqual(labels(), ["Needs Attention", "Online", "Offline"]);
    assert.deepEqual(counts(), ["1", "7", "1"]);
    assert.deepEqual(rowNames(view.body), ["Old Laptop", "Build A", "Build B", "Build C", "Build D", "Build E", "GPU Box", "Studio", "Downstairs"]);
    assert.equal(view.history.replaced.length, 0, "nothing is selected by itself");
    assert.equal(list(view.body).querySelector(".master-detail-list-body button.row"), allMachinesRow(view.body),
      "All Machines leads the groups");

    const filter = list(view.body).querySelector<HTMLInputElement>('input[aria-label="Filter Machines"]')!;
    assert.equal(filter.closest(".input-affix")?.parentElement?.classList.contains("master-detail-list-head"), true);
    await act(async () => fireDomEvent.change(filter, { target: { value: "BUILD" } }));
    assert.deepEqual(rowNames(view.body), ["Build A", "Build B", "Build C", "Build D", "Build E"]);
    assert.deepEqual(labels(), ["Online"]);
    assert.deepEqual(counts(), ["5"]);

    await act(async () => fireDomEvent.change(filter, { target: { value: "nothing" } }));
    assert.equal(rows(view.body).length, 0);
    const empty = list(view.body).querySelector(".machine-list-no-results")!;
    assert.match(empty.textContent ?? "", /No machines match “nothing”\./);
    await act(async () => [...empty.querySelectorAll("button")].find((button) => button.textContent === "Clear Filter")!.click());
    assert.equal(rows(view.body).length, 9);
  } finally {
    await view.unmount();
  }
});

test("before the first snapshot the list shows skeleton rows and the detail its skeleton, never No Machines", async () => {
  const view = await mount({ runners: null });
  try {
    assert.equal(list(view.body).querySelectorAll(".skeleton .row.row-2.machine-row-skeleton").length, 3);
    assert.ok(detail(view.body).querySelector(".detail-skeleton"));
    assert.doesNotMatch(view.body.textContent ?? "", /No Machines/);
    const tab = () => view.body.querySelector("#connections-machines-tab")?.textContent;
    assert.equal(tab(), "Machines", "no zero count while loading (§12.3)");
    await view.push(snapshot([alpha]));
    assert.deepEqual(rowNames(view.body), ["Alpha"]);
    assert.equal(tab(), "Machines 1");
  } finally {
    await view.unmount();
  }
});

test("disconnected with machines, the rows stay, dimmed under Reconnecting…; with none, the Reconnecting… state", async () => {
  const view = await mount();
  try {
    await view.disconnect();
    const notice = list(view.body).querySelector(".master-detail-list-head .notice")!;
    assert.equal(notice.textContent, "Reconnecting…");
    assertNoDomNode(notice.closest(".is-stale"), "the line is never dimmed itself");
    const stale = list(view.body).querySelector(".is-stale")!;
    assert.ok(stale, "the last-known rows are dimmed");
    assert.deepEqual([...stale.querySelectorAll(".row-title")].map((title) => title.textContent),
      ["All Machines", "Zeta", "Alpha", "Beta"]);
    assert.ok(overview(view.body)?.closest(".is-stale"), "the last-known overview is dimmed too");
    await act(async () => row(view.body, "Zeta").click());
    await settle();
    assert.equal(detailName(view.body), "Zeta", "a last-known machine still opens");
  } finally {
    await view.unmount();
  }

  const empty = await mount({ runners: [] });
  try {
    await empty.disconnect();
    const state = empty.body.querySelector(".master-detail-state .state")!;
    assert.match(state.textContent ?? "", /Reconnecting…/);
    assert.doesNotMatch(empty.body.textContent ?? "", /No Machines Yet/);
  } finally {
    await empty.unmount();
  }
});

test("an SSH machine is one row named by its box, and connecting one selects it while it arrives", async () => {
  const box: BoxView = { boxId: "box-1", runnerId: "box-runner", displayName: "Build Box", sshTarget: "me@build", status: "bootstrapping", lastError: null, createdAt: 1 };
  const view = await mount({ runners: [alpha], boxes: [box] });
  try {
    assert.deepEqual(rowNames(view.body), ["Alpha", "Build Box"]);
    assert.equal(row(view.body, "Build Box").querySelector(".status")?.textContent, "Bootstrapping");
    assert.deepEqual([...row(view.body, "Build Box").querySelectorAll(".machine-row-meta > span")].map((span) => span.textContent), ["SSH"]);
    await act(async () => row(view.body, "Build Box").click());
    await settle();
    assert.equal(machineDetail(view.body)?.dataset.kind, "ssh", "an SSH machine's detail is the same detail, as SSH");
  } finally {
    await view.unmount();
  }
});

/** happy-dom has no layout: the list's scroller reports a height, so its position is recorded. */
function stubListLayout() {
  const proto = domWindow.HTMLElement.prototype as unknown as Record<string, unknown>;
  const prior = Object.getOwnPropertyDescriptor(proto, "clientHeight");
  Object.defineProperty(proto, "clientHeight", { configurable: true, get(this: HTMLElement) {
    return this.classList?.contains("master-detail-list-body") && this.closest("[data-detail-open]") === null ? 400 : 0;
  } });
  return () => {
    if (prior) Object.defineProperty(proto, "clientHeight", prior);
    else delete proto.clientHeight;
  };
}

test("on a phone, a row opens the detail route under Back and the machine's name, and Back returns to the list where it was", async () => {
  const restore = stubListLayout();
  await setWidth(390);
  const view = await mount();
  try {
    assert.equal(view.history.replaced.length, 0, "a phone selects nothing by itself");
    // The list route is the overview: no All Machines row, and no overview beside it (#2986).
    assertNoDomNode(allMachinesRow(view.body), "no All Machines row at 390px");
    assertNoDomNode(view.body.querySelector(".machines-overview"));
    assert.deepEqual(rowNames(view.body), ["Zeta", "Alpha", "Beta"], "/connections/machines shows the list");
    assert.ok(view.body.querySelector('.page-header [role="tablist"][aria-label="Connections"]'), "the list route keeps the tabs");
    assertNoDomNode(view.body.querySelector(".detail-bar"));
    assert.equal(view.body.querySelectorAll(".row.is-selected").length, 0);

    const body = list(view.body).querySelector<HTMLElement>(".master-detail-list-body")!;
    body.scrollTop = 180;
    await act(async () => body.dispatchEvent(new domWindow.Event("scroll") as unknown as Event));
    await act(async () => row(view.body, "Beta").click());
    await settle();
    assert.deepEqual(view.history.pushed, [{ name: "runners", section: "machines", machineId: "beta" }]);
    const bar = view.body.querySelector(".detail-bar")!;
    assert.ok(bar, "the detail route has a detail bar");
    assert.ok(bar.querySelector('button[aria-label="Back to Connections"]'));
    assert.match(bar.textContent ?? "", /Beta/);
    assertNoDomNode(view.body.querySelector('[role="tablist"]'), "the tabs are hidden");
    assertNoDomNode(view.body.querySelector(".page-header"));
    assert.ok(view.body.querySelector(".master-detail[data-detail-open]"));

    // A hidden list reports no height, so a scroll event while it is hidden changes nothing.
    body.scrollTop = 0;
    await act(async () => body.dispatchEvent(new domWindow.Event("scroll") as unknown as Event));
    await act(async () => bar.querySelector<HTMLButtonElement>('button[aria-label="Back to Connections"]')!.click());
    await settle();
    assert.deepEqual(view.history.pushed.at(-1), { name: "runners", section: "machines" });
    assertNoDomNode(view.body.querySelector(".detail-bar"));
    assert.ok(view.body.querySelector('[role="tablist"]'));
    assert.equal(body.scrollTop, 180, "Back restores the list's scroll position");
    assert.equal(view.body.querySelectorAll(".row.is-selected").length, 0, "with no selected row");
  } finally {
    await view.unmount();
    restore();
  }
});

test("connecting the first machine leaves the empty state for its waiting detail, and an unknown id there is Not Found", async () => {
  const arriving: BoxView = { boxId: "box-first", runnerId: "box-first-runner", displayName: "First Box", sshTarget: "me@first", status: "bootstrapping", lastError: null, createdAt: 2 };
  const view = await mount({ runners: [], client: { addBox: async () => ({ box: arriving }) } as Partial<ApiClient> });
  try {
    const empty = view.body.querySelector(".connections-empty")!;
    assert.ok(empty, "no machines: the empty state spans both panes");
    await act(async () => [...empty.querySelectorAll<HTMLButtonElement>("button")]
      .find((button) => button.textContent === "Connect via SSH")!.click());
    const dialog = view.body.querySelector<HTMLElement>('[role="dialog"]')!;
    const label = [...dialog.querySelectorAll("label")].find((candidate) => candidate.textContent === "SSH Target")!;
    const target = domWindow.document.getElementById(label.htmlFor) as unknown as HTMLInputElement;
    await act(async () => fireDomEvent.change(target, { target: { value: "me@first" } }));
    await act(async () => [...dialog.querySelectorAll<HTMLButtonElement>("button")]
      .find((button) => button.textContent?.trim() === "Connect Machine")!.click());
    await settle();
    assert.deepEqual(view.history.pushed.at(-1), { name: "runners", section: "machines", machineId: "box-first-runner" });
    // The box has not streamed in yet.
    assertNoDomNode(view.body.querySelector(".connections-empty"), "No Machines Yet steps aside for the selection");
    assert.ok(detail(view.body).querySelector(".detail-skeleton"), "the detail waits for the new machine");
    assert.doesNotMatch(detail(view.body).textContent ?? "", /Machine Not Found/);
    assert.equal(rows(view.body).length, 0);
    assertNoDomNode(list(view.body).querySelector(".machine-list-no-results"), "an empty list is not a filter with no match");

    await view.push({ type: "box_upsert", box: arriving });
    assert.equal(detailName(view.body), "First Box");
    assert.ok(row(view.body, "First Box").classList.contains("is-selected"));
  } finally {
    await view.unmount();
  }

  const unknown = await mount({ runners: [], view: { name: "runners", section: "machines", machineId: "gone" } });
  try {
    assertNoDomNode(unknown.body.querySelector(".connections-empty"));
    assert.match(detail(unknown.body).textContent ?? "", /Machine Not Found/);
    await act(async () => [...detail(unknown.body).querySelectorAll("button")]
      .find((button) => button.textContent === "Show All Machines")!.click());
    await settle();
    assert.ok(unknown.body.querySelector(".connections-empty"), "Show All Machines returns to the empty state");
  } finally {
    await unknown.unmount();
  }
});

test("connecting a machine over SSH selects it, and its detail waits for it rather than saying Not Found (#2987)", async () => {
  const arriving: BoxView = { boxId: "box-new", runnerId: "box-new-runner", displayName: "Golf Sim", sshTarget: "me@golf", status: "bootstrapping", lastError: null, createdAt: 2 };
  const view = await mount({ client: { addBox: async () => ({ box: arriving }) } as Partial<ApiClient> });
  try {
    await act(async () => view.body.querySelector<HTMLButtonElement>(".page-header .page-primary")!.click());
    const menu = view.body.querySelector('[role="menu"][aria-label="Add Machine"]')!;
    await act(async () => [...menu.querySelectorAll<HTMLButtonElement>('[role="menuitem"]')]
      .find((item) => item.textContent?.includes("Connect via SSH…"))!.click());
    const dialog = view.body.querySelector<HTMLElement>('[role="dialog"]')!;
    const label = [...dialog.querySelectorAll("label")].find((candidate) => candidate.textContent === "SSH Target")!;
    const target = domWindow.document.getElementById(label.htmlFor) as unknown as HTMLInputElement;
    await act(async () => fireDomEvent.change(target, { target: { value: "me@golf" } }));
    await act(async () => [...dialog.querySelectorAll<HTMLButtonElement>("button")]
      .find((button) => button.textContent?.trim() === "Connect Machine")!.click());
    await settle();
    assert.deepEqual(view.history.pushed.at(-1), { name: "runners", section: "machines", machineId: "box-new-runner" });
    assertNoDomNode(view.body.querySelector('[role="dialog"]'), "the dialog closed");
    assert.doesNotMatch(detail(view.body).textContent ?? "", /Machine Not Found/);
    assert.ok(detail(view.body).querySelector(".detail-skeleton"), "the detail waits for the new machine");

    await view.push({ type: "box_upsert", box: arriving });
    assert.ok(row(view.body, "Golf Sim").classList.contains("is-selected"));
    assert.equal(detailName(view.body), "Golf Sim");
    assert.match(machineDetail(view.body)?.querySelector(".machine-detail-status")?.textContent ?? "", /Bootstrapping/);
  } finally {
    await view.unmount();
  }
});

/*
 * The selection's state machine (#2985). The route is the only selection, and every state is derived
 * from it and the live machines; nothing tracks a deletion in flight. The route changes by:
 *   a deep link or reload            → that machine, or Machine Not Found, never replaced;
 *   no selection                     → nothing is selected: the All Machines overview beside the
 *                                      list (#2986), or a phone's list;
 *   a row, All Machines or Show All  → pushed, so Back and Forward retrace it;
 *   Connect via SSH                  → the new machine, pushed, waiting until its box arrives;
 *   the shown machine leaving        → the list, in place (deleted here or anywhere), then the
 *                                      overview or No Machines Yet;
 *   a phone                          → never selects by itself; Back leaves the detail route.
 * A delete request and the stream's removal can arrive in any order, and nothing depends on it.
 */

/** Delete Machine… from ⋯ Machine Actions: the detail's on a desktop, the detail bar's on a phone. */
async function deleteSelectedMachine(view: Awaited<ReturnType<typeof mount>>, name: string) {
  await act(async () => view.body.querySelector<HTMLButtonElement>('button[aria-label="Machine Actions"]')!.click());
  const menu = view.body.querySelector<HTMLElement>('[role="menu"][aria-label="Machine Actions"]')!;
  await act(async () => [...menu.querySelectorAll<HTMLButtonElement>('[role="menuitem"]')]
    .find((item) => item.textContent?.includes("Delete Machine…"))!.click());
  await settle();
  const confirmation = [...view.body.querySelectorAll<HTMLElement>('[role="alertdialog"], [role="dialog"]')]
    .find((candidate) => candidate.textContent?.includes(`deleted from Wollipog`))!;
  assert.ok(confirmation, "the deletion asks first");
  assert.match(confirmation.textContent ?? "", new RegExp(name));
  await act(async () => [...confirmation.querySelectorAll<HTMLButtonElement>("button")]
    .find((button) => button.textContent?.trim() === "Delete Machine")!.click());
  await settle();
}

/** A promise the test resolves, standing in for a delete request still in flight. */
function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => { resolve = done; });
  return { promise, resolve: async () => { await act(async () => { resolve(); await promise; }); await settle(); } };
}

const offlineOnly = runner("solo", { displayName: "Solo", status: "offline" });
/** A machine's own route, as its row or a link opens it. */
const machineView = (machineId: string): View => ({ name: "runners", section: "machines", machineId });
const removed = (runnerId: string) => ({ type: "runner_removed", runnerId }) as never;
const upserted = (value: RunnerView) => ({ type: "runner_upsert", runner: value }) as never;

test("deleting the only machine ends on No Machines Yet, whichever arrives first, the response or the removal", async () => {
  for (const order of ["response first", "removal first"] as const) {
    const request = deferred();
    const view = await mount({ view: machineView("solo"), runners: [offlineOnly], client: { removeRunner: () => request.promise } as Partial<ApiClient> });
    try {
      assert.equal(detailName(view.body), "Solo");
      await deleteSelectedMachine(view, "Solo");
      if (order === "response first") {
        await request.resolve();
        // Until the stream removes it, the machine is still there, and so is its detail.
        assert.equal(detailName(view.body), "Solo", order);
        await view.push(removed("solo"));
      } else {
        await view.push(removed("solo"));
        await request.resolve();
      }
      assert.deepEqual(view.history.current(), { name: "runners", section: "machines" }, `${order}: the list, in place`);
      assert.equal(view.history.entries.length, 1, `${order}: Back cannot return to the deleted machine`);
      assert.ok(view.body.querySelector(".connections-empty"), `${order}: No Machines Yet`);
      assert.doesNotMatch(view.body.textContent ?? "", /Machine Not Found/);
    } finally {
      await view.unmount();
    }
  }
});

test("deleting the selected one of two returns to the overview in place once it is removed", async () => {
  const other = runner("other", { displayName: "Other" });
  const view = await mount({ view: machineView("solo"), runners: [offlineOnly, other], client: { removeRunner: async () => {} } as Partial<ApiClient> });
  try {
    assert.equal(detailName(view.body), "Solo");
    await deleteSelectedMachine(view, "Solo");
    await view.push(removed("solo"));
    assert.deepEqual(view.history.current(), { name: "runners", section: "machines" });
    assert.equal(view.history.entries.length, 1);
    assert.deepEqual(rowNames(view.body), ["Other"]);
    assertOverviewShown(view.body);
  } finally {
    await view.unmount();
  }
});

test("deleting the only SSH machine ends on No Machines Yet, whichever arrives first, the response or box_removed", async () => {
  const box: BoxView = { boxId: "box-solo", runnerId: "box-solo-runner", displayName: "Solo Box", sshTarget: "me@solo", status: "offline", lastError: null, createdAt: 1 };
  for (const order of ["response first", "removal first"] as const) {
    const request = deferred();
    const view = await mount({ view: machineView("box-solo-runner"), runners: [], boxes: [box], client: { removeBox: () => request.promise } as Partial<ApiClient> });
    try {
      assert.equal(machineDetail(view.body)?.dataset.kind, "ssh");
      await deleteSelectedMachine(view, "Solo Box");
      if (order === "response first") await request.resolve();
      await view.push({ type: "box_removed", boxId: "box-solo" } as never);
      if (order === "removal first") await request.resolve();
      assert.deepEqual(view.history.current(), { name: "runners", section: "machines" }, order);
      assert.ok(view.body.querySelector(".connections-empty"), `${order}: No Machines Yet`);
    } finally {
      await view.unmount();
    }
  }
});

test("a machine removed and registered again while its deletion is in flight stays listed and selectable", async () => {
  const request = deferred();
  const other = runner("other", { displayName: "Other" });
  const view = await mount({ view: machineView("solo"), runners: [offlineOnly, other], client: { removeRunner: () => request.promise } as Partial<ApiClient> });
  try {
    await deleteSelectedMachine(view, "Solo");
    await view.push(removed("solo"));
    await view.push(upserted({ ...offlineOnly, status: "online" }));
    await request.resolve();
    assert.deepEqual(rowNames(view.body).sort(), ["Other", "Solo"]);
    await act(async () => row(view.body, "Solo").click());
    await settle();
    assert.equal(detailName(view.body), "Solo");
  } finally {
    await view.unmount();
  }
});

test("a removal and a registration in one delivery never leave the selected machine", async () => {
  const view = await mount({ view: machineView("solo"), runners: [offlineOnly] });
  try {
    await act(async () => {
      view.socket.push(removed("solo"));
      view.socket.push(upserted({ ...offlineOnly, status: "online" }));
    });
    await settle();
    assert.deepEqual(view.history.current(), { name: "runners", section: "machines", machineId: "solo" });
    assert.equal(detailName(view.body), "Solo");
  } finally {
    await view.unmount();
  }
});

test("a failed deletion keeps the machine selected and listed", async () => {
  const view = await mount({ view: machineView("solo"), runners: [offlineOnly], client: { removeRunner: async () => { throw new Error("runner is busy"); } } as Partial<ApiClient> });
  try {
    await deleteSelectedMachine(view, "Solo");
    assert.deepEqual(view.history.current(), { name: "runners", section: "machines", machineId: "solo" });
    assert.deepEqual(rowNames(view.body), ["Solo"]);
    assert.match(view.body.textContent ?? "", /runner is busy/);
  } finally {
    await view.unmount();
  }
});

test("a machine deleted elsewhere while open returns to the list; Back to its old entry is Machine Not Found", async () => {
  const view = await mount();
  try {
    await act(async () => row(view.body, "Alpha").click());
    await settle();
    await act(async () => row(view.body, "Beta").click());
    await settle();
    await view.push(removed("beta"));
    assert.deepEqual(view.history.current(), { name: "runners", section: "machines" }, "the list, in place");
    assert.equal(view.history.entries.length, 3);
    assertOverviewShown(view.body);
    await view.push(removed("alpha"));
    assertOverviewShown(view.body, "a machine that is not open leaving changes nothing");
    await view.history.back();
    assert.deepEqual(view.history.current(), { name: "runners", section: "machines", machineId: "alpha" });
    assert.match(detail(view.body).textContent ?? "", /Machine Not Found/, "a route this page never showed live");
  } finally {
    await view.unmount();
  }
});

test("Back and Forward retrace pushed selections, and the overview adds no entry", async () => {
  const view = await mount();
  try {
    assert.equal(view.history.entries.length, 1);
    await act(async () => row(view.body, "Alpha").click());
    await settle();
    await act(async () => row(view.body, "Beta").click());
    await settle();
    assert.equal(view.history.entries.length, 3);
    await view.history.back();
    assert.equal(detailName(view.body), "Alpha");
    await view.history.back();
    assertOverviewShown(view.body, "the first entry is the overview");
    await view.history.forward();
    assert.equal(detailName(view.body), "Alpha");
    assert.equal(view.history.entries.length, 3, "retracing adds nothing");
  } finally {
    await view.unmount();
  }
});

test("a phone never selects by itself; widening the window shows the overview beside the list", async () => {
  await setWidth(390);
  const view = await mount();
  try {
    assert.deepEqual(view.history.current(), { name: "runners", section: "machines" });
    assertNoDomNode(view.body.querySelector(".master-detail[data-detail-open]"));
    await setWidth(1440);
    assert.deepEqual(view.history.current(), { name: "runners", section: "machines" });
    assert.equal(view.history.entries.length, 1);
    assertOverviewShown(view.body);
    // Narrowed again with a machine open, the phone shows it as the detail route.
    await act(async () => row(view.body, "Zeta").click());
    await settle();
    await setWidth(390);
    assert.ok(view.body.querySelector(".detail-bar"));
    assert.ok(view.body.querySelector(".master-detail[data-detail-open]"));
  } finally {
    await view.unmount();
  }
});

test("on a phone, deleting the open machine returns to the list route without it", async () => {
  await setWidth(390);
  const other = runner("other", { displayName: "Other" });
  const view = await mount({
    view: { name: "runners", section: "machines", machineId: "solo" },
    runners: [offlineOnly, other],
    client: { removeRunner: async () => {} } as Partial<ApiClient>,
  });
  try {
    assert.ok(view.body.querySelector(".detail-bar"));
    await deleteSelectedMachine(view, "Solo");
    await view.push(removed("solo"));
    assert.deepEqual(view.history.current(), { name: "runners", section: "machines" });
    assertNoDomNode(view.body.querySelector(".detail-bar"));
    assert.deepEqual(rowNames(view.body), ["Other"]);
    assert.equal(view.body.querySelectorAll(".row.is-selected").length, 0);
  } finally {
    await view.unmount();
  }
});

test("on a phone, a machine removed after leaving its detail is Machine Not Found when Back returns to it", async () => {
  await setWidth(390);
  const view = await mount();
  try {
    await act(async () => row(view.body, "Alpha").click());
    await settle();
    assert.equal(detailName(view.body), "Alpha");
    await act(async () => view.body.querySelector<HTMLButtonElement>('.detail-bar button[aria-label="Back to Connections"]')!.click());
    await settle();
    assert.deepEqual(view.history.current(), { name: "runners", section: "machines" });
    await view.push(removed("alpha"));
    await view.history.back();
    assert.deepEqual(view.history.current(), { name: "runners", section: "machines", machineId: "alpha" },
      "the entry is kept, not replaced by the list");
    assert.match(detail(view.body).textContent ?? "", /Machine Not Found/);
    assert.ok(view.body.querySelector(".detail-bar"), "the detail route, under Back");
  } finally {
    await view.unmount();
  }
});

/* The All Machines overview (#2986): which machine needs the person, and where there is room. */

const viewer = { context: { role: "viewer" }, organizations: [], memberships: [], teams: [] } as unknown as IdentityAdministrationView;
const section = (body: HTMLElement, title: string) => [...overview(body)!.querySelectorAll<HTMLElement>("section")]
  .find((candidate) => candidate.querySelector(".section-title")?.firstChild?.textContent === title)!;
const attentionRows = (body: HTMLElement) => [...section(body, "Needs Attention").querySelectorAll<HTMLElement>(".surface > .row")];
const capacityRows = (body: HTMLElement) => [...section(body, "Capacity").querySelectorAll<HTMLElement>(".surface > .row")];
const capacityRow = (body: HTMLElement, name: string) => capacityRows(body).find((item) => item.querySelector(".row-title")?.textContent === name)!;
const units = (configuredUnits: number, usedUnits: number, queuedSessions = 0) =>
  ({ configuredUnits, usedUnits, queuedSessions, revision: 1, authority: "control_plane" }) as RunnerView["capacity"];

/** One offline native runner, one outdated SSH machine and two online machines (#2986 AC2). */
const downstairs = runner("downstairs", { displayName: "Downstairs", status: "offline", lastSeen: Date.now() - 4 * 60_000 });
const buildBox: BoxView = { boxId: "box-build", runnerId: "build", displayName: "Build Box", sshTarget: "me@build", status: "online", lastError: null, createdAt: 1 };
const buildRunner = runner("build", { protocolVersion: 1 });
const studio = runner("studio", { displayName: "Studio", capacity: units(40, 30, 3) });
const laptop = runner("laptop", { displayName: "Laptop", capacity: units(40, 14) });
const attentionFleet = { runners: [downstairs, buildRunner, studio, laptop], boxes: [buildBox] };

test("Needs Attention lists the offline runner and the outdated SSH machine in list order, with each one's action for an owner", async () => {
  const view = await mount(attentionFleet);
  try {
    assert.equal(overview(view.body)!.querySelector(".machines-overview-summary")?.textContent,
      "4 machines, 3 online. 44 of 80 units in use on the online machines.");
    const title = section(view.body, "Needs Attention").querySelector(".section-title")!;
    assert.equal(title.querySelector(".machines-overview-count")?.textContent, "2");
    const items = attentionRows(view.body);
    assert.deepEqual(items.map((item) => item.querySelector(".row-title")?.textContent), ["Build Box", "Downstairs"],
      "the list's order, and only the machines that need the person");
    assert.deepEqual(items.map((item) => item.querySelector(".status")?.textContent), ["Update Required", "Offline"]);
    assert.deepEqual(items.map((item) => item.querySelector(".row-sub")?.textContent), [
      "Its runner is out of date.",
      "Last seen 4m ago. Repair its connection to run agents there again.",
    ]);
    assert.deepEqual(items.map((item) => item.querySelector("button")?.textContent), ["Review", "Repair Connection…"]);
    assert.equal(items[1]!.querySelector("button")?.getAttribute("aria-label"), "Repair Connection to Downstairs…");

    await act(async () => items[0]!.querySelector("button")!.click());
    await settle();
    assert.deepEqual(view.history.current(), machineView("build"), "Review opens the machine");
  } finally {
    await view.unmount();
  }
});

test("a viewer's Needs Attention offers Review on every row", async () => {
  const view = await mount({ ...attentionFleet, client: { getIdentity: async () => viewer } });
  try {
    const items = attentionRows(view.body);
    assert.deepEqual(items.map((item) => item.querySelector("button")?.textContent), ["Review", "Review"]);
    assert.equal(items[1]!.querySelector(".row-sub")?.textContent,
      "Last seen 4m ago. Ask an organization owner or admin to repair its connection.");
  } finally {
    await view.unmount();
  }
});

test("with every machine online and current, Needs Attention is the one line \"Every machine is online and ready.\"", async () => {
  const view = await mount({ runners: [studio, laptop] });
  try {
    const needs = section(view.body, "Needs Attention");
    assertNoDomNode(needs.querySelector(".surface"));
    assertNoDomNode(needs.querySelector(".machines-overview-count"));
    const ok = needs.querySelector(".machines-overview-ok")!;
    assert.equal(ok.textContent, "Every machine is online and ready.");
    assert.ok(ok.querySelector(".machines-overview-dot"), "after a success dot");
  } finally {
    await view.unmount();
  }
});

test("Capacity compares machines with a meter each: warning from 75%, its name the level, Offline and Capacity Unknown", async () => {
  const view = await mount(attentionFleet);
  try {
    const head = section(view.body, "Capacity").querySelector(".section-head")!;
    assert.equal(head.querySelector(".machines-overview-columns")?.textContent, "Units in Use / Limit");
    const busy = capacityRow(view.body, "Studio");
    const meter = busy.querySelector<HTMLElement>(".meter")!;
    assert.equal(meter.className, "meter t-warning", "30 of 40 is the warning meter");
    assert.equal(meter.getAttribute("role"), "img");
    assert.equal(meter.getAttribute("aria-label"), "30 of 40 units in use");
    assert.equal(busy.querySelector(".machine-capacity-figures")?.textContent, "30 / 40");
    assert.equal(busy.querySelector(".machine-capacity-queued")?.textContent, "3 Queued");
    const calm = capacityRow(view.body, "Laptop");
    assert.equal(calm.querySelector(".meter")?.className, "meter", "14 of 40 is neutral");
    assertNoDomNode(calm.querySelector(".machine-capacity-queued"), "no Queued while nothing waits");

    const offline = capacityRow(view.body, "Downstairs");
    assert.equal(offline.querySelector<HTMLElement>(".meter > span")?.style.width, "0%", "an empty meter");
    assert.equal(offline.querySelector(".machine-capacity-figures")?.textContent, "Offline");
    assert.equal(capacityRow(view.body, "Build Box").querySelector(".machine-capacity-unknown")?.textContent, "Capacity Unknown");
    assert.equal(section(view.body, "Capacity").querySelector(".section-note")?.textContent,
      "A unit is one running agent process. An agent can be set to take more than one.");

    await act(async () => (calm as HTMLButtonElement).click());
    await settle();
    assert.deepEqual(view.history.current(), machineView("laptop"), "a Capacity row opens its machine");
  } finally {
    await view.unmount();
  }
});

test("with ten machines, Capacity shows eight rows and sums up the rest", async () => {
  const fleet = Array.from({ length: 10 }, (_, index) =>
    runner(`node-${index}`, { displayName: `Node ${index}`, capacity: units(16, index) }));
  const view = await mount({ runners: fleet });
  try {
    assert.equal(capacityRows(view.body).filter((item) => item.tagName === "BUTTON").length, 8);
    const rest = section(view.body, "Capacity").querySelector(".machine-capacity-rest")!;
    assert.equal(rest.querySelector(".row-title")?.textContent, "and 2 more machines");
    assert.equal(rest.querySelector(".machine-capacity-figures")?.textContent, "17 / 32", "Node 8 and Node 9");
  } finally {
    await view.unmount();
  }
});

test("Reconnect resolves an offline SSH machine, confirming first when it would interrupt sessions", async () => {
  const offlineBox: BoxView = { ...buildBox, status: "offline" };
  const calls: Array<[string, boolean]> = [];
  const view = await mount({
    runners: [studio],
    boxes: [offlineBox],
    client: {
      reconnectBox: async (boxId: string, force = false) => {
        calls.push([boxId, force]);
        if (!force) throw new ApiError("1 active session", 409, "BOX_HAS_ACTIVE_SESSIONS");
        return {} as never;
      },
    } as Partial<ApiClient>,
  });
  try {
    const item = attentionRows(view.body)[0]!;
    assert.equal(item.querySelector(".row-sub")?.textContent, "Offline. Reconnect to run agents there again.");
    const reconnect = item.querySelector<HTMLButtonElement>("button")!;
    assert.equal(reconnect.textContent, "Reconnect");
    await act(async () => reconnect.click());
    await settle();
    const confirmation = [...view.body.querySelectorAll<HTMLElement>('[role="alertdialog"], [role="dialog"]')]
      .find((candidate) => candidate.textContent?.includes("Interrupt Sessions and Reconnect"))!;
    assert.ok(confirmation, "the interruption asks first");
    await act(async () => [...confirmation.querySelectorAll<HTMLButtonElement>("button")]
      .find((button) => button.textContent?.trim() === "Interrupt Sessions and Reconnect")!.click());
    await settle();
    assert.deepEqual(calls, [["box-build", false], ["box-build", true]]);
  } finally {
    await view.unmount();
  }
});

test("on a desktop, a machine removed while another tab is open is Machine Not Found when Back returns to it", async () => {
  const view = await mount({ view: { name: "runners", section: "machines", machineId: "alpha" } });
  try {
    assert.equal(detailName(view.body), "Alpha");
    await act(async () => view.body.querySelector<HTMLButtonElement>("#connections-people-tab")!.click());
    await settle();
    assert.deepEqual(view.history.current(), { name: "runners", section: "people" });
    await view.push(removed("alpha"));
    await view.history.back();
    assert.deepEqual(view.history.current(), { name: "runners", section: "machines", machineId: "alpha" });
    assert.match(detail(view.body).textContent ?? "", /Machine Not Found/);
  } finally {
    await view.unmount();
  }
});
