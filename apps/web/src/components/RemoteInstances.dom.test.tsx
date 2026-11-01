import { fireDomEvent } from "./test-dom-events.js";
import assert from "node:assert/strict";
import test from "node:test";
import React, { act } from "react";
import { createRoot } from "react-dom/client";
import { Window } from "happy-dom";
import type { InstanceProfile } from "../desktop-instances.js";
import {
  ActiveInstanceConnectionProvider,
  InstancesContextProvider,
  type InstanceManager,
} from "../instances-context.js";
import { FeedbackProvider } from "./FeedbackProvider.js";
import { InstanceSelector } from "./InstanceSelector.js";
import { Rail } from "./Rail.js";
import { assertNoDomNode } from "../dom-test-assertions.js";

const domWindow = new Window({ url: "http://localhost/connections/instances" });
for (const [name, value] of Object.entries({
  window: domWindow,
  document: domWindow.document,
  navigator: domWindow.navigator,
  HTMLElement: domWindow.HTMLElement,
  HTMLButtonElement: domWindow.HTMLButtonElement,
  HTMLInputElement: domWindow.HTMLInputElement,
  Node: domWindow.Node,
  Event: domWindow.Event,
  PointerEvent: domWindow.PointerEvent,
  KeyboardEvent: domWindow.KeyboardEvent,
  IS_REACT_ACT_ENVIRONMENT: true,
})) Object.defineProperty(globalThis, name, { configurable: true, writable: true, value });

const local: InstanceProfile = {
  id: "local",
  serverInstanceId: "local",
  kind: "local",
  label: "This Machine",
  origin: "http://127.0.0.1:4317",
  createdAt: "",
};
const remote: InstanceProfile = {
  id: "e9df4628-0ed8-4a42-a608-62d52ed94b74",
  serverInstanceId: "60c2e80c-24a2-48da-9428-eea738e89979",
  kind: "remote",
  label: "Home Workstation",
  origin: "https://remote.example.test",
  createdAt: "2026-07-20T00:00:00Z",
  lastConnectedAt: "2026-07-21T00:00:00Z",
};

function manager(overrides: Partial<InstanceManager> = {}): InstanceManager {
  return {
    desktopMultiInstance: true,
    registry: { profiles: [local, remote], activeInstanceId: "local" },
    activeProfile: local,
    runtime: null,
    navigation: undefined,
    phase: "ready",
    error: null,
    statusByProfile: {
      local: { availability: "online" },
      [remote.id]: { availability: "authentication-required", message: "Generate a new pairing link locally." },
    },
    async switchInstance() {},
    async retryActive() {},
    async addInstance() {},
    async editInstance() {},
    async repairInstance() {},
    async removeInstance() {},
    manageInstances() {},
    openInstanceDialog() {},
    async goToThisMachine() {},
    reportActiveStatus() {},
    ...overrides,
  };
}

function mount(element: React.ReactElement) {
  const happyContainer = domWindow.document.createElement("div");
  domWindow.document.body.append(happyContainer);
  const mountPoint = happyContainer as unknown as HTMLDivElement;
  // Dialogs are portalled to <body>, so the test queries the body.
  const container = domWindow.document.body as unknown as HTMLDivElement;
  const root = createRoot(mountPoint);
  return { container, mountPoint, root, render: () => act(async () => { root.render(element); }) };
}

const tick = () => new Promise<void>((resolve) => domWindow.setTimeout(resolve, 0));

test("the instance menu switches, adds and manages, and keeps focus on the tile", async () => {
  const switched: string[] = [];
  let managed = 0;
  const opened: Parameters<InstanceManager["openInstanceDialog"]>[0][] = [];
  const value = manager({
    async switchInstance(profileId) { switched.push(profileId); },
    manageInstances() { managed += 1; },
    openInstanceDialog(options) { opened.push(options); },
  });
  const mounted = mount(
    <InstancesContextProvider value={value}><FeedbackProvider><InstanceSelector /></FeedbackProvider></InstancesContextProvider>,
  );
  await mounted.render();
  try {
    const trigger = mounted.container.querySelector<HTMLButtonElement>('[aria-label="Switch Instance: This Machine"]')!;
    assert.ok(trigger, "the accessible name holds the visible name in the same form");
    assert.equal(trigger.querySelector(".instance-monogram.tile")?.textContent, "TM");
    await act(async () => { trigger.click(); });
    const menu = mounted.container.querySelector<HTMLElement>('[role="menu"]')!;
    const rows = Array.from(menu.querySelectorAll<HTMLButtonElement>('[role="menuitemradio"]'));
    assert.deepEqual(rows.map((row) => row.querySelector(".menu-text")?.textContent), ["This Machine", "Home Workstation"]);
    assert.deepEqual(rows.map((row) => row.querySelector(".instance-monogram")?.textContent), ["TM", "HW"]);
    assert.deepEqual(rows.map((row) => row.querySelector(".menu-desc")?.textContent), ["On this machine", remote.origin]);
    assert.equal(rows[0]!.getAttribute("aria-checked"), "true");
    assert.ok(rows[0]!.querySelector(".menu-check"), "the current instance has a trailing check");
    assert.ok(!rows[1]!.querySelector(".menu-check"));
    // Status is text, not colour alone: the online local row has none, the remote one says why.
    assertNoDomNode(rows[0]!.querySelector(".status"));
    assert.equal(rows[1]!.querySelector(".status")?.textContent, "Pairing Required");
    assert.ok(rows[1]!.querySelector(".status")?.classList.contains("t-warning"));
    const describedBy = rows[1]!.getAttribute("aria-describedby")!.split(" ");
    assert.ok(describedBy.some((id) => domWindow.document.getElementById(id)?.textContent === "Pairing Required"),
      "a screen reader hears the status the row shows");
    // A "Remote" section label precedes the remote profiles; the local one has none.
    const labels = Array.from(menu.querySelectorAll(".menu-label")).map((label) => label.textContent);
    assert.deepEqual(labels, ["Remote"]);
    assert.ok(menu.querySelector(".menu-label")!.compareDocumentPosition(rows[1]! as never) & 4, "the label precedes the row");

    await act(async () => { rows[1]!.click(); await tick(); });
    assert.deepEqual(switched, [remote.id]);

    await act(async () => { trigger.click(); });
    const actions = Array.from(mounted.container.querySelectorAll<HTMLButtonElement>('[role="menuitem"]'));
    assert.deepEqual(actions.map((item) => item.textContent), ["Add Remote Instance…", "Manage Instances"]);
    assert.ok(actions.every((item) => item.querySelector(".menu-icon svg")), "each action has its own icon");
    await act(async () => { actions[1]!.click(); });
    assert.equal(managed, 1);

    await act(async () => { trigger.click(); });
    const add = Array.from(mounted.container.querySelectorAll<HTMLButtonElement>('[role="menuitem"]'))
      .find((item) => item.textContent === "Add Remote Instance…")!;
    await act(async () => { add.click(); await tick(); });
    assertNoDomNode(domWindow.document.querySelector('[role="menu"]'));
    // The provider's one dialog opens (#3003), told to return focus to the tile: the row is gone.
    assert.equal(opened.length, 1);
    assert.equal(opened[0]!.mode, "add");
    assert.ok(opened[0]!.returnFocus === (trigger as never), "the dialog returns focus to the tile, not the row");
    assert.ok(domWindow.document.activeElement === (trigger as never), "the tile holds focus while the dialog opens");

    // Dismissing through the shared backdrop hands focus back to the tile: the backdrop takes
    // the click, so nothing underneath it would otherwise receive focus.
    await act(async () => { trigger.click(); });
    await act(async () => {
      (domWindow.document.querySelector(".menu-backdrop") as unknown as HTMLElement).click();
      await tick();
    });
    assertNoDomNode(domWindow.document.querySelector('[role="menu"]'));
    // Identity, not assert.equal: a failed diff of two DOM nodes serialises the whole tree.
    assert.ok(domWindow.document.activeElement === (trigger as never), "focus returns to the tile, not <body>");
  } finally {
    await act(async () => { mounted.root.unmount(); });
    mounted.mountPoint.remove();
  }
});

test("the tile's dot and tooltip say the active instance's status, and agree with the banner", async () => {
  const cases: Array<{
    name: string;
    value: InstanceManager;
    connection?: "reconnecting" | "sign-in-required";
    tone: string;
    hollow: boolean;
    detail: string;
  }> = [
    { name: "online", value: manager(), tone: "t-success", hollow: false, detail: "Online" },
    {
      name: "connecting",
      value: manager({ statusByProfile: {}, phase: "opening" }),
      tone: "t-info",
      hollow: false,
      detail: "Connecting",
    },
    {
      name: "remote offline",
      value: manager({ activeProfile: remote, statusByProfile: { [remote.id]: { availability: "offline" } } }),
      tone: "t-neutral",
      hollow: true,
      detail: "Offline",
    },
    {
      name: "remote pairing",
      value: manager({ activeProfile: remote }),
      tone: "t-warning",
      hollow: false,
      detail: "Pairing required",
    },
    // The instance manager still records Online a moment after the socket drops; the banner wins.
    { name: "banner offline", value: manager(), connection: "reconnecting", tone: "t-neutral", hollow: true, detail: "Offline" },
    { name: "banner pairing", value: manager(), connection: "sign-in-required", tone: "t-warning", hollow: false, detail: "Pairing required" },
    {
      name: "remote update",
      value: manager({ activeProfile: remote, statusByProfile: { [remote.id]: { availability: "incompatible" } } }),
      tone: "t-warning",
      hollow: false,
      detail: "Update required",
    },
    // Not tried in this session and not opening: never "Saved".
    {
      name: "nothing recorded",
      value: manager({ statusByProfile: {}, phase: "missing" }),
      tone: "t-neutral",
      hollow: true,
      detail: "Offline",
    },
  ];
  for (const example of cases) {
    const mounted = mount(
      <InstancesContextProvider value={example.value}>
        <ActiveInstanceConnectionProvider value={example.connection ?? null}>
          <InstanceSelector />
        </ActiveInstanceConnectionProvider>
      </InstancesContextProvider>,
    );
    await mounted.render();
    try {
      const trigger = mounted.mountPoint.querySelector<HTMLButtonElement>(".instance-tile-trigger")!;
      const dot = trigger.querySelector(".instance-tile-dot")!;
      assert.ok(dot.classList.contains(example.tone), `${example.name}: ${dot.className}`);
      assert.equal(dot.classList.contains("hollow"), example.hollow, example.name);
      assert.equal(trigger.getAttribute("data-rail-tip"), example.value.activeProfile.label, example.name);
      assert.equal(trigger.getAttribute("data-rail-detail"), example.detail, `${example.name}: sentence case`);
      const status = domWindow.document.getElementById(trigger.getAttribute("aria-describedby")!);
      assert.ok(status?.textContent, `${example.name}: the status is the tile's description`);
      assert.ok(!dot.classList.contains("t-success") || !example.connection, "never Online beside the banner");
    } finally {
      await act(async () => { mounted.root.unmount(); });
      mounted.mountPoint.remove();
    }
  }
});

test("the tile takes the brand's place in the desktop rail, and its menu flies out beside the rail", async () => {
  const priorWidth = domWindow.innerWidth;
  const priorHeight = domWindow.innerHeight;
  Object.defineProperty(domWindow, "innerWidth", { configurable: true, value: 1024 });
  Object.defineProperty(domWindow, "innerHeight", { configurable: true, value: 640 });
  const mounted = mount(
    <InstancesContextProvider value={manager()}>
      <Rail
        view={{ name: "inbox" }}
        blockedCount={0}
        stalledCount={0}
        onNavigate={() => undefined}
        instanceControl={<InstanceSelector />}
        settingsControl={<button type="button">Settings</button>}
      />
    </InstancesContextProvider>,
  );
  await mounted.render();
  try {
    const rail = mounted.container.querySelector<HTMLElement>(".app-rail")!;
    assertNoDomNode(rail.querySelector(".rail-brand"), "the tile replaces the brand");
    assert.equal(rail.firstElementChild?.className, "rail-instance", "the tile is at the top of the rail");
    const trigger = rail.querySelector<HTMLButtonElement>('[aria-label="Switch Instance: This Machine"]');
    assert.ok(trigger, "the tile is mounted through Rail.instanceControl");
    const tile = trigger.querySelector<HTMLElement>(".instance-monogram.tile")!;
    rail.getBoundingClientRect = () => ({
      top: 0, right: 64, bottom: 640, left: 0, width: 64, height: 640, x: 0, y: 0, toJSON: () => ({}),
    });
    tile.getBoundingClientRect = () => ({
      top: 10, right: 48, bottom: 42, left: 16, width: 32, height: 32, x: 16, y: 10, toJSON: () => ({}),
    });

    // The shared menu is placed from its own rendered size; happy-dom has no layout, so give the
    // surface the size a two-profile menu renders at.
    const surface = domWindow.HTMLElement.prototype as unknown as Record<string, unknown>;
    const priorScrollHeight = Object.getOwnPropertyDescriptor(surface, "scrollHeight");
    Object.defineProperty(surface, "scrollHeight", {
      configurable: true,
      get(this: HTMLElement) { return this.classList.contains("menu") ? 188 : 0; },
    });
    try {
      await act(async () => { trigger.click(); });
    } finally {
      if (priorScrollHeight) Object.defineProperty(surface, "scrollHeight", priorScrollHeight);
      else delete surface["scrollHeight"];
    }
    const menu = domWindow.document.querySelector('[role="menu"][aria-label="Switch Instance"]') as unknown as HTMLElement;
    assert.ok(menu);
    assert.ok(menu.classList.contains("menu"), "the shared menu surface, fixed by the stylesheet");
    assert.equal(menu.style.top, "10px", "top-aligned with the tile");
    assert.equal(menu.style.left, "68px", "4px beside the rail's edge, so it covers no rail item");
    assert.equal(menu.style.width, "300px");
    assert.equal(menu.style.maxHeight, "188px", "a short menu is not given more room than it uses");
  } finally {
    await act(async () => { mounted.root.unmount(); });
    mounted.mountPoint.remove();
    Object.defineProperty(domWindow, "innerWidth", { configurable: true, value: priorWidth });
    Object.defineProperty(domWindow, "innerHeight", { configurable: true, value: priorHeight });
  }
});

test("the browser build shows no tile, and the rail keeps its decorative brand", async () => {
  const mounted = mount(
    <InstancesContextProvider value={manager({ desktopMultiInstance: false })}>
      <InstanceSelector />
    </InstancesContextProvider>,
  );
  await mounted.render();
  try {
    assertNoDomNode(mounted.mountPoint.querySelector(".instance-selector"));
  } finally {
    await act(async () => { mounted.root.unmount(); });
    mounted.mountPoint.remove();
  }
  const rail = mount(
    <Rail
      view={{ name: "inbox" }}
      blockedCount={0}
      stalledCount={0}
      onNavigate={() => undefined}
      settingsControl={<button type="button">Settings</button>}
    />,
  );
  await rail.render();
  try {
    assert.equal(rail.mountPoint.querySelector(".rail-brand")?.getAttribute("aria-hidden"), "true");
    assertNoDomNode(rail.mountPoint.querySelector(".rail-instance"));
  } finally {
    await act(async () => { rail.root.unmount(); });
    rail.mountPoint.remove();
  }
});

test("a labelled tile shows the name and status beside the monogram and leaves the tooltip to the rail", async () => {
  const mounted = mount(
    <InstancesContextProvider value={manager({ activeProfile: remote })}>
      <InstanceSelector labelled />
    </InstancesContextProvider>,
  );
  await mounted.render();
  try {
    const trigger = mounted.mountPoint.querySelector<HTMLButtonElement>(".instance-tile-trigger")!;
    assert.equal(trigger.getAttribute("aria-label"), "Switch Instance: Home Workstation");
    assert.equal(trigger.querySelector(".instance-tile-name")?.textContent, "Home Workstation");
    const status = trigger.querySelector(".instance-tile-status")!;
    assert.equal(status.textContent, "Pairing Required");
    assert.equal(trigger.getAttribute("aria-describedby"), status.id, "the visible status is the description");
    assert.equal(trigger.getAttribute("data-rail-tip"), null, "the labelled rail shows no tooltip");
    assert.equal(trigger.getAttribute("data-rail-detail"), null);
  } finally {
    await act(async () => { mounted.root.unmount(); });
    mounted.mountPoint.remove();
  }
});
