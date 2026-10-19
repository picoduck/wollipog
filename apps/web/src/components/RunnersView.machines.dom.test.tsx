import { fireDomEvent } from "./test-dom-events.js";
import assert from "node:assert/strict";
import { afterEach, test } from "node:test";
import React, { act } from "react";
import { createRoot } from "react-dom/client";
import { Window } from "happy-dom";
import type { BoxView, IdentityAdministrationView, RunnerView, UiSnapshotMessage } from "@wollipog/protocol";
import { api, type ApiClient } from "../api.js";
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
const detailName = (body: HTMLElement) => detail(body).querySelector(".runner-id h2")?.textContent;

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

test("with no selection the first row is selected in place, and the detail shows its card", async () => {
  const view = await mount();
  try {
    assert.deepEqual(view.history.replaced, [{ name: "runners", section: "machines", machineId: "zeta" }]);
    assert.equal(view.history.pushed.length, 0, "the default selection adds no history entry");
    assert.equal(viewPath(view.history.current()), `/connections/machines/~${encodeResourceId("zeta")}`);
    assert.equal(detailName(view.body), "Zeta");
    assert.ok(row(view.body, "Zeta").classList.contains("is-selected"));
    assert.equal(row(view.body, "Zeta").getAttribute("aria-current"), "true");
    assert.equal(view.body.querySelectorAll(".row.is-selected").length, 1);
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
    // Then the first row is the default detail again.
    assert.equal(detailName(view.body), "Zeta");
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
    assert.deepEqual(view.history.replaced.at(-1), { name: "runners", section: "machines", machineId: "old" },
      "the first row shown is the default selection");

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
    assert.deepEqual([...stale.querySelectorAll(".row-title")].map((title) => title.textContent), ["Zeta", "Alpha", "Beta"]);
    assert.equal(detailName(view.body), "Zeta", "the selected machine stays open");
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
    assert.ok(detail(view.body).querySelector(".box-card"), "an SSH machine's detail is its box card");
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
    assert.match(detail(view.body).querySelector(".box-card .status")?.textContent ?? "", /Bootstrapping/);
  } finally {
    await view.unmount();
  }
});

/*
 * The selection's state machine (#2985). The route is the only selection, and every state is derived
 * from it and the live machines; nothing tracks a deletion in flight. The route changes by:
 *   a deep link or reload            → that machine, or Machine Not Found, never replaced;
 *   no selection, wider than a phone → the first row shown, in place (`replace`);
 *   a row or Show All Machines       → pushed, so Back and Forward retrace it;
 *   Connect via SSH                  → the new machine, pushed, waiting until its box arrives;
 *   the shown machine leaving        → the list, in place (deleted here or anywhere), then the first
 *                                      row or No Machines Yet;
 *   a phone                          → never selects by itself; Back leaves the detail route.
 * A delete request and the stream's removal can arrive in any order, and nothing depends on it.
 */

async function deleteSelectedMachine(view: Awaited<ReturnType<typeof mount>>, name: string) {
  const card = detail(view.body).querySelector(".runner-card")!;
  await act(async () => [...card.querySelectorAll<HTMLButtonElement>("button")]
    .find((button) => button.textContent?.trim() === "Manage")!.click());
  const dialog = [...view.body.querySelectorAll<HTMLElement>('[role="dialog"]')]
    .find((candidate) => candidate.textContent?.includes(`Manage ${name}`))!;
  assert.ok(dialog, `Manage ${name} opens`);
  await act(async () => [...dialog.querySelectorAll<HTMLButtonElement>("button")]
    .find((button) => button.textContent?.trim() === "Delete Machine")!.click());
  await settle();
  const confirmation = [...view.body.querySelectorAll<HTMLElement>('[role="alertdialog"], [role="dialog"]')]
    .find((candidate) => candidate !== dialog && candidate.textContent?.includes("permanently deleted"))!;
  assert.ok(confirmation, "the deletion asks first");
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
const removed = (runnerId: string) => ({ type: "runner_removed", runnerId }) as never;
const upserted = (value: RunnerView) => ({ type: "runner_upsert", runner: value }) as never;

test("deleting the only machine ends on No Machines Yet, whichever arrives first, the response or the removal", async () => {
  for (const order of ["response first", "removal first"] as const) {
    const request = deferred();
    const view = await mount({ runners: [offlineOnly], client: { removeRunner: () => request.promise } as Partial<ApiClient> });
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

test("deleting the selected one of two selects the other in place once it is removed", async () => {
  const other = runner("other", { displayName: "Other" });
  const view = await mount({ runners: [offlineOnly, other], client: { removeRunner: async () => {} } as Partial<ApiClient> });
  try {
    assert.equal(detailName(view.body), "Solo", "the offline machine sorts first and is the default selection");
    await deleteSelectedMachine(view, "Solo");
    await view.push(removed("solo"));
    assert.deepEqual(view.history.current(), { name: "runners", section: "machines", machineId: "other" });
    assert.equal(view.history.entries.length, 1);
    assert.deepEqual(rowNames(view.body), ["Other"]);
    assert.equal(detailName(view.body), "Other");
  } finally {
    await view.unmount();
  }
});

test("deleting the only SSH machine ends on No Machines Yet, whichever arrives first, the response or box_removed", async () => {
  const box: BoxView = { boxId: "box-solo", runnerId: "box-solo-runner", displayName: "Solo Box", sshTarget: "me@solo", status: "offline", lastError: null, createdAt: 1 };
  for (const order of ["response first", "removal first"] as const) {
    const request = deferred();
    const view = await mount({ runners: [], boxes: [box], client: { removeBox: () => request.promise } as Partial<ApiClient> });
    try {
      assert.ok(detail(view.body).querySelector(".box-card"));
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
  const view = await mount({ runners: [offlineOnly, other], client: { removeRunner: () => request.promise } as Partial<ApiClient> });
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
  const view = await mount({ runners: [offlineOnly] });
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
  const view = await mount({ runners: [offlineOnly], client: { removeRunner: async () => { throw new Error("runner is busy"); } } as Partial<ApiClient> });
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
    assert.deepEqual(view.history.current(), { name: "runners", section: "machines", machineId: "zeta" },
      "the list, then its first row, in place");
    assert.equal(view.history.entries.length, 3);
    await view.push(removed("alpha"));
    assert.equal(detailName(view.body), "Zeta", "a machine that is not open leaving changes nothing");
    await view.history.back();
    assert.deepEqual(view.history.current(), { name: "runners", section: "machines", machineId: "alpha" });
    assert.match(detail(view.body).textContent ?? "", /Machine Not Found/, "a route this page never showed live");
  } finally {
    await view.unmount();
  }
});

test("Back and Forward retrace pushed selections, and the default selection adds no entry", async () => {
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
    assert.equal(detailName(view.body), "Zeta", "the first entry is the replaced default selection");
    await view.history.forward();
    assert.equal(detailName(view.body), "Alpha");
    assert.equal(view.history.entries.length, 3, "retracing adds nothing");
  } finally {
    await view.unmount();
  }
});

test("a phone never selects by itself; widening the window selects the first row in place", async () => {
  await setWidth(390);
  const view = await mount();
  try {
    assert.deepEqual(view.history.current(), { name: "runners", section: "machines" });
    assertNoDomNode(view.body.querySelector(".master-detail[data-detail-open]"));
    await setWidth(1440);
    assert.deepEqual(view.history.current(), { name: "runners", section: "machines", machineId: "zeta" });
    assert.equal(view.history.entries.length, 1);
    assert.equal(detailName(view.body), "Zeta");
    // Narrowed again with a machine open, the phone shows it as the detail route.
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
