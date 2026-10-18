import assert from "node:assert/strict";
import test from "node:test";
import React, { act } from "react";
import { createRoot } from "react-dom/client";
import { Window } from "happy-dom";
import {
  PROTOCOL_VERSION,
  type ProjectLocationView,
  type ProjectView,
  type RunnerView,
  type UiSnapshotMessage,
  type WorktreeSetupConfigStatus,
} from "@wollipog/protocol";
import { api, type ApiClient } from "../api.js";
import { ApiProvider } from "../api-context.js";
import type { ViewNavigation } from "../navigation.js";
import { StoreProvider, useStoreSelector } from "../store.js";
import { UI_SOCKET_OPEN, type UiConnectionRuntime, type UiSocket } from "../ui-transport.js";
import { FeedbackContext, type ToastOptions } from "./FeedbackProvider.js";
import { ProjectsView } from "./ProjectsView.js";
import type { NewSessionPreset } from "./NewSessionDialog.js";
import { assertNoDomNode } from "../dom-test-assertions.js";
import { installDomTestCleanup } from "../dom-test-cleanup.js";

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
  InputEvent: domWindow.InputEvent,
  React,
  IS_REACT_ACT_ENVIRONMENT: true,
})) Object.defineProperty(globalThis, name, { configurable: true, writable: true, value });

const runner: RunnerView = {
  runnerId: "runner-1",
  hostname: "runner-host",
  os: "linux",
  version: "1",
  status: "online",
  displayName: "Build Machine",
  agents: [],
  workspaces: [
    { id: "workspace-1", name: "Checkout", path: "/repos/alpha" },
    { id: "workspace-2", name: "Docs", path: "/repos/docs" },
  ],
  connectedAt: 1,
  lastSeen: 1,
  protocolVersion: PROTOCOL_VERSION,
};
const offlineRunner: RunnerView = {
  ...runner,
  runnerId: "runner-2",
  displayName: "Studio Mac",
  status: "offline",
  workspaces: [{ id: "workspace-3", name: "Remote", path: "/repos/remote" }],
};

class FakeSocket implements UiSocket {
  readonly readyState = UI_SOCKET_OPEN;
  onopen: (() => void) | null = null;
  onmessage: ((event: { data: string }) => void) | null = null;
  onclose: ((event: { code: number }) => void) | null = null;
  onerror: (() => void) | null = null;
  send() {}
  close() {}
  push(message: UiSnapshotMessage) {
    this.onmessage?.({ data: JSON.stringify(message) });
  }
}

const navigation: ViewNavigation = { current: () => ({ name: "projects", id: "alpha" }), push() {}, listen: () => () => {} };
const toasts: { message: string; options?: ToastOptions }[] = [];
const feedback = {
  confirm: async () => true,
  showToast: (message: string, options?: ToastOptions) => { toasts.push({ message, options }); return -1; },
  showUndo: () => -1,
  dismissToast: () => undefined,
};
const newSessionPresets: (NewSessionPreset | undefined)[] = [];

function location(options: Partial<ProjectLocationView> = {}): ProjectLocationView {
  return {
    id: "location-1", projectId: "alpha", runnerId: "runner-1", workspaceId: "workspace-1", name: "Checkout",
    path: "/repos/alpha", source: "managed", availability: "available", isDefault: true, createdAt: 1, updatedAt: 1,
    totalSessionCount: 3,
    ...options,
  };
}

function project(locations: ProjectLocationView[], options: Partial<ProjectView> = {}): ProjectView {
  return {
    id: "alpha", name: "Alpha", hidden: false, locations, activeSessionCount: 0, unarchivedSessionCount: 3,
    totalSessionCount: 3, createdAt: 1, updatedAt: 1, ...options,
  };
}

/** The default and a second location on the build machine, and one on the offline machine. */
const threeLocations = () => [
  location(),
  location({ id: "location-2", workspaceId: "workspace-2", name: "Docs", path: "/repos/docs", isDefault: false, totalSessionCount: 1 }),
  location({
    id: "location-3", runnerId: "runner-2", workspaceId: "workspace-3", name: "Remote", path: "/repos/remote",
    isDefault: false, availability: "runner_offline", totalSessionCount: 0,
  }),
];

/** A matchMedia that answers width queries for `width` and says no to everything else. */
function stubWidth(width: number): () => void {
  const prior = domWindow.matchMedia;
  domWindow.matchMedia = ((query: string) => {
    const min = /min-width:\s*(\d+)px/.exec(query);
    const max = /max-width:\s*(\d+)px/.exec(query);
    const widthQuery = Boolean(min || max) && !/height|pointer|hover/.test(query);
    return {
      matches: widthQuery && (!min || width >= Number(min[1])) && (!max || width <= Number(max[1])),
      media: query,
      onchange: null,
      addEventListener() {},
      removeEventListener() {},
      addListener() {},
      removeListener() {},
      dispatchEvent: () => false,
    };
  }) as never;
  return () => { domWindow.matchMedia = prior; };
}

/** Each location's setup-file answer, by location id; a missing one never settles. */
type SetupAnswers = Record<string, WorktreeSetupConfigStatus | Error | undefined>;

async function render(projects: ProjectView[], options: {
  setup?: SetupAnswers;
  runners?: RunnerView[];
  client?: Partial<ApiClient>;
  setupCapability?: boolean;
} = {}) {
  toasts.length = 0;
  const setupCalls: string[] = [];
  const client = {
    ...api,
    projectLocationWorktreeSetup: async (_projectId: string, locationId: string) => {
      setupCalls.push(locationId);
      const answer = options.setup?.[locationId];
      if (answer instanceof Error) throw answer;
      if (!answer) return new Promise(() => {});
      return { locationId, status: answer };
    },
    ...options.client,
  } as ApiClient;
  const mountPoint = domWindow.document.createElement("div") as unknown as HTMLDivElement;
  domWindow.document.body.append(mountPoint as never);
  const root = createRoot(mountPoint);
  const socket = new FakeSocket();
  const connection: UiConnectionRuntime = {
    instanceId: "locations-1", runtimeKey: "locations-1:1", createSocket: () => socket, close() {},
  };
  function Route() {
    const view = useStoreSelector((state) => state.view);
    return <ProjectsView selectedProjectId={view.name === "projects" ? view.id : undefined}
      onNewSession={(preset) => { newSessionPresets.push(preset); }} />;
  }
  await act(async () => {
    root.render(
      <ApiProvider client={client}>
        <FeedbackContext.Provider value={feedback as never}>
          <StoreProvider connection={connection} navigation={navigation}>
            <Route />
          </StoreProvider>
        </FeedbackContext.Provider>
      </ApiProvider>,
    );
  });
  await act(async () => {
    socket.push({
      type: "snapshot",
      capabilities: {
        sessionSubscriptions: false, boundedDelivery: false, paginatedSessionHistory: false, projects: true,
        worktreeSetupConfig: options.setupCapability ?? true,
      },
      runners: options.runners ?? [runner, offlineRunner],
      boxes: [], sessions: [], runs: [], pods: [], projects,
    } as UiSnapshotMessage);
  });
  await settle();
  return { body: domWindow.document.body as unknown as HTMLElement, setupCalls };
}

const settle = async () => { await act(async () => { await new Promise((resolve) => setTimeout(resolve, 20)); }); };
const text = (element: Element | null | undefined) => element?.textContent?.replace(/\s+/g, " ").trim() ?? "";
const locationsSection = (body: HTMLElement) => [...body.querySelectorAll(".project-detail > section")]
  .find((section) => text(section.querySelector(".section-title")) === "Locations")!;
const locationRow = (body: HTMLElement, name: string) => [...body.querySelectorAll<HTMLElement>(".project-location")]
  .find((row) => text(row.querySelector(".project-location-name")) === name)!;

async function openMenu(row: HTMLElement, name: string) {
  const more = row.querySelector<HTMLButtonElement>(`button[aria-label="${name} Actions"]`);
  assert.ok(more, "⋯ is named for the location it acts on");
  await act(async () => more!.click());
  const menu = domWindow.document.querySelector(`[role="menu"][aria-label="${name} Actions"]`) as unknown as HTMLElement;
  assert.ok(menu, `${name} Actions menu`);
  return menu;
}

const menuItems = (menu: Element) => [...menu.querySelectorAll<HTMLButtonElement>(".menu-item")].map((item) => ({
  label: text(item.querySelector(".menu-text")),
  reason: item.querySelector(".menu-desc") ? text(item.querySelector(".menu-desc")) : null,
  disabled: item.disabled,
}));

test("at 1440px a location is one two-line row: name, Default, status; machine, path, setup; count, New Session Here and ⋯", async () => {
  newSessionPresets.length = 0;
  const { body } = await render([project(threeLocations())], { setup: { "location-1": { status: "valid", hash: "abc" } } });
  const section = locationsSection(body);
  const surface = section.querySelector("ul.surface.project-locations");
  assert.ok(surface, "the rows share one surface");
  assert.equal(surface!.querySelectorAll(":scope > li.project-location").length, 3);
  const row = locationRow(body, "Checkout");
  const line = row.querySelector(".row.row-2")!;
  assert.ok(line.querySelector(".row-icon svg"), "the machine's icon leads the row");
  assert.equal(text(row.querySelector(".project-location-default")), "Default");
  assert.equal(row.querySelector(".project-location-default")!.classList.contains("status"), false, "Default is quiet text, not a pill");
  assert.equal(text(row.querySelector(".row-line .status")), "Available");
  assert.deepEqual([...row.querySelectorAll(".project-location-meta > span")].map(text),
    ["Build Machine", "/repos/alpha", "Setup file ready"]);
  assert.equal(row.querySelector(".project-location-path")!.getAttribute("title"), "/repos/alpha", "the full path is its tooltip");
  assert.equal(text(row.querySelector(".project-location-count")), "3 Sessions");
  const buttons = [...line.querySelectorAll<HTMLButtonElement>(":scope > button, :scope > .overflow-menu > button")];
  assert.deepEqual(buttons.map((button) => button.getAttribute("aria-label") ?? text(button)), ["New Session Here", "Checkout Actions"]);
  assert.ok(buttons[0]!.classList.contains("sm"));
  assert.ok(buttons[1]!.classList.contains("icon-btn") && buttons[1]!.classList.contains("sm"), "⋯ is a small icon button");
  await act(async () => buttons[0]!.click());
  assert.deepEqual(newSessionPresets.at(-1), { runnerId: "runner-1", workspaceId: "workspace-1", projectId: "alpha", projectLocationId: "location-1" });
  // One session reads in the singular.
  assert.equal(text(locationRow(body, "Docs").querySelector(".project-location-count")), "1 Session");
});

test("no location row holds a Select, Review Access Change, Native Runner or Setup Status:", async () => {
  const { body } = await render([project(threeLocations())], { setup: { "location-1": { status: "absent" } } });
  for (const row of body.querySelectorAll(".project-location")) {
    assertNoDomNode(row.querySelector("select, [aria-haspopup=listbox], .access-scope-readout"), "no access field in a row");
    assert.doesNotMatch(text(row), /Review Access Change|Native Runner|Setup Status:/);
  }
});

test("⋯ lists its items in order, Remove Location… last after a separator, and Make Default says it already is", async () => {
  const { body } = await render([project(threeLocations())], { setup: { "location-1": { status: "absent" } } });
  const menu = await openMenu(locationRow(body, "Checkout"), "Checkout");
  assert.deepEqual(menuItems(menu), [
    { label: "Reveal in File Manager", reason: null, disabled: false },
    { label: "Copy Path", reason: null, disabled: false },
    { label: "Make Default", reason: "Already the default.", disabled: true },
    { label: "Create Starter Setup File", reason: null, disabled: false },
    { label: "Remove Location…", reason: null, disabled: false },
  ]);
  const children = [...menu.children];
  const remove = children.findIndex((child) => text(child.querySelector(".menu-text") ?? child) === "Remove Location…");
  assert.equal(remove, children.length - 1, "Remove Location… is last");
  assert.ok(children[remove - 1]!.matches(".menu-sep, [role=separator]"), "after a separator");
  assert.ok(children[remove]!.classList.contains("danger"), "in danger text");
});

test("a location that can't host a session has no New Session Here, and Make Default and Reveal say why", async () => {
  const { body } = await render([project(threeLocations())]);
  const row = locationRow(body, "Remote");
  assert.equal(text(row.querySelector(".row-line .status")), "Runner Offline");
  assert.equal([...row.querySelectorAll("button")].some((button) => text(button) === "New Session Here"), false);
  assert.deepEqual(menuItems(await openMenu(row, "Remote")), [
    { label: "Reveal in File Manager", reason: "The machine is offline.", disabled: true },
    { label: "Copy Path", reason: null, disabled: false },
    { label: "Make Default", reason: "The machine is offline.", disabled: true },
    { label: "Remove Location…", reason: null, disabled: false },
  ]);
  assertNoDomNode(row.querySelector(".project-location-setup"), "no setup status while offline");
});

test("a viewer's ⋯ offers only what changes nothing: no Make Default, Change Location Access… or Remove Location…", async () => {
  const { body } = await render([project(threeLocations(), { canManage: false })], { setup: { "location-1": { status: "absent" } } });
  for (const name of ["Checkout", "Docs", "Remote"]) {
    const labels = menuItems(await openMenu(locationRow(body, name), name)).map((item) => item.label);
    assert.deepEqual(labels, ["Reveal in File Manager", "Copy Path"], name);
    await act(async () => { domWindow.document.dispatchEvent(new domWindow.KeyboardEvent("keydown", { key: "Escape", bubbles: true })); });
  }
});

test("at 834px New Session Here moves into ⋯, the count hides and the path follows the machine and setup status", async () => {
  const restore = stubWidth(834);
  try {
    newSessionPresets.length = 0;
    const { body } = await render([project(threeLocations())], { setup: { "location-1": { status: "valid", hash: "abc" } } });
    const row = locationRow(body, "Checkout");
    assert.equal([...row.querySelectorAll("button")].some((button) => text(button) === "New Session Here"), false);
    assertNoDomNode(row.querySelector(".project-location-count"), "the count hides under 1100px");
    assert.deepEqual([...row.querySelectorAll(".project-location-meta > span")].map(text),
      ["Build Machine", "Setup file ready", "/repos/alpha"]);
    const menu = await openMenu(row, "Checkout");
    assert.deepEqual(menuItems(menu).map((item) => item.label).slice(0, 3), ["New Session Here", "Reveal in File Manager", "Copy Path"]);
    await act(async () => menu.querySelector<HTMLButtonElement>(".menu-item")!.click());
    assert.equal(newSessionPresets.at(-1)?.projectLocationId, "location-1");
    const offline = menuItems(await openMenu(locationRow(body, "Remote"), "Remote"))[0];
    assert.deepEqual(offline, { label: "New Session Here", reason: "The machine is offline.", disabled: true });
  } finally {
    restore();
  }
});

test("at 390px Reveal in File Manager is absent from ⋯", async () => {
  const restore = stubWidth(390);
  try {
    const { body } = await render([project(threeLocations())], { setup: { "location-1": { status: "valid", hash: "abc" } } });
    const labels = menuItems(await openMenu(locationRow(body, "Checkout"), "Checkout")).map((item) => item.label);
    assert.deepEqual(labels, ["New Session Here", "Copy Path", "Make Default", "Remove Location…"]);
  } finally {
    restore();
  }
});

test("setup status reads No setup file, Setup file ready, Checking setup… or the update sentence", async () => {
  const oldRunner: RunnerView = {
    ...runner, runnerId: "runner-old", displayName: "Old Laptop", protocolVersion: 100,
    workspaces: [{ id: "workspace-old", name: "Legacy", path: "/repos/legacy" }],
  };
  const locations = [
    location(),
    location({ id: "location-2", workspaceId: "workspace-2", name: "Docs", path: "/repos/docs", isDefault: false }),
    location({ id: "location-pending", workspaceId: "workspace-2", name: "Pending", path: "/repos/pending", isDefault: false }),
    location({ id: "location-old", runnerId: "runner-old", workspaceId: "workspace-old", name: "Legacy", path: "/repos/legacy", isDefault: false }),
  ];
  const { body, setupCalls } = await render([project(locations)], {
    runners: [runner, oldRunner],
    setup: { "location-1": { status: "absent" }, "location-2": { status: "valid", hash: "abc" } },
  });
  const setup = (name: string) => text(locationRow(body, name).querySelector(".project-location-setup"));
  assert.equal(setup("Checkout"), "No setup file");
  assert.equal(setup("Docs"), "Setup file ready");
  assert.equal(setup("Pending"), "Checking setup…");
  assert.ok(locationRow(body, "Pending").querySelector(".project-location-setup .spinner"), "with a spinner");
  assert.equal(setup("Legacy"), "Update Wollipog on Old Laptop to check setup");
  assert.equal(setupCalls.includes("location-old"), false, "an old runner isn't asked");
  for (const name of ["Checkout", "Docs", "Pending", "Legacy"]) assertNoDomNode(locationRow(body, name).querySelector(".notice"));
});

test("an invalid setup file adds a danger notice under the row with the message, and the raw text behind Show Details", async () => {
  const error = "Unexpected token } in JSON at position 41\n  at .wollipog.json:3:7";
  const { body } = await render([project([location()])], { setup: { "location-1": { status: "invalid", error } } });
  const row = locationRow(body, "Checkout");
  assert.equal(text(row.querySelector(".project-location-setup")), "Setup file has an error");
  const notice = row.querySelector(".row + .notice.t-danger.compact");
  assert.ok(notice, "a compact danger notice under the row");
  assert.match(text(notice), /^The setup file can't be used: Unexpected token } in JSON at position 41/);
  assert.doesNotMatch(text(notice), /wollipog\.json:3:7/, "the raw text waits behind Show Details");
  const toggle = [...notice!.querySelectorAll<HTMLButtonElement>("button")].find((button) => text(button) === "Show Details")!;
  await act(async () => toggle.click());
  assert.match(text(notice), /at \.wollipog\.json:3:7/);
  assert.equal(menuItems(await openMenu(row, "Checkout")).some((item) => item.label === "Create Starter Setup File"), false);
});

test("Create Starter Setup File confirms with a toast and the row reads the status back as Setup file ready", async () => {
  const setup: SetupAnswers = { "location-1": { status: "absent" } };
  let generated = 0;
  let dismissed = 0;
  const { body, setupCalls } = await render([project([location()])], {
    setup,
    client: {
      generateProjectLocationWorktreeSetup: async (_projectId: string, locationId: string) => {
        generated += 1;
        setup["location-1"] = { status: "valid", hash: "new" };
        return { locationId, status: { status: "absent" }, path: ".wollipog.json", detected: [] };
      },
      dismissWorktreeSetupNotice: async () => { dismissed += 1; return { dismissed: true as const }; },
    },
  });
  const row = locationRow(body, "Checkout");
  assert.equal(text(row.querySelector(".project-location-setup")), "No setup file");
  const menu = await openMenu(row, "Checkout");
  const create = [...menu.querySelectorAll<HTMLButtonElement>(".menu-item")].find((item) => text(item) === "Create Starter Setup File")!;
  await act(async () => create.click());
  await settle();
  assert.equal(generated, 1);
  assert.deepEqual(toasts.at(-1), { message: "Setup file created for Checkout.", options: { tone: "success" } });
  // The POST's own answer said absent; the row shows what it read back afterwards.
  assert.equal(setupCalls.filter((id) => id === "location-1").length, 2, "the status is read again");
  assert.equal(text(row.querySelector(".project-location-setup")), "Setup file ready");
  assert.equal(dismissed, 1);
});

test("a failed Create Starter Setup File is an error toast with the reason", async () => {
  const { body } = await render([project([location()])], {
    setup: { "location-1": { status: "absent" } },
    client: { generateProjectLocationWorktreeSetup: async () => { throw new Error("EACCES: permission denied"); } },
  });
  const menu = await openMenu(locationRow(body, "Checkout"), "Checkout");
  const create = [...menu.querySelectorAll<HTMLButtonElement>(".menu-item")].find((item) => text(item) === "Create Starter Setup File")!;
  await act(async () => create.click());
  await settle();
  assert.deepEqual(toasts.at(-1), { message: "Couldn't create the setup file.", options: { tone: "error", detail: "EACCES: permission denied" } });
  assert.equal(text(locationRow(body, "Checkout").querySelector(".project-location-setup")), "No setup file");
});

test("with no locations the section is one inline row with Add Location…, and the head has none", async () => {
  const { body } = await render([project([])]);
  const section = locationsSection(body);
  assertNoDomNode(section.querySelector(".section-head .actions"), "the head's Add Location… steps aside");
  const rows = section.querySelectorAll(".surface > .row");
  assert.equal(rows.length, 1, "one inline row");
  assert.equal(text(rows[0]!.querySelector(".project-locations-empty-text")),
    "Add the folder on one of your machines where this project's sessions run.");
  assert.deepEqual([...rows[0]!.querySelectorAll("button")].map(text), ["Add Location…"],
    "Open Connections waits until no machine is online");
  assert.ok(rows[0]!.querySelector("button")!.classList.contains("sm"));
});

test("with no locations and no machine online, the row also offers Open Connections", async () => {
  const { body } = await render([project([])], { runners: [{ ...runner, status: "offline" }, offlineRunner] });
  const row = locationsSection(body).querySelector(".surface > .row")!;
  assert.deepEqual([...row.querySelectorAll("button")].map(text), ["Add Location…", "Open Connections"]);
});

test("a project with locations keeps Add Location… in the section head", async () => {
  const { body } = await render([project([location()])], { setup: { "location-1": { status: "valid", hash: "abc" } } });
  assert.equal(text(locationsSection(body).querySelector(".section-head .actions button")), "Add Location…");
});
