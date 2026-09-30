import { fireDomEvent } from "./test-dom-events.js";
import assert from "node:assert/strict";
import test from "node:test";
import React, { act } from "react";
import { createRoot } from "react-dom/client";
import { Window } from "happy-dom";
import type { InstanceProfile } from "../desktop-instances.js";
import {
  InstancesContextProvider,
  type InstanceManager,
} from "../instances-context.js";
import { FeedbackProvider } from "./FeedbackProvider.js";
import { InstanceSelector } from "./InstanceSelector.js";
import { InstancesPanel } from "./InstancesPanel.js";
import { Rail } from "./Rail.js";
import { RemoteInstanceDialog } from "./RemoteInstanceDialog.js";
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
    async addAndSwitch() {},
    async editInstance() {},
    async repairInstance() {},
    async removeInstance() {},
    manageInstances() {},
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
  const value = manager({
    async switchInstance(profileId) { switched.push(profileId); },
    manageInstances() { managed += 1; },
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
    assert.equal(rows[1]!.querySelector(".status")?.textContent, "Sign-In Required");
    assert.ok(rows[1]!.querySelector(".status")?.classList.contains("t-warning"));
    const describedBy = rows[1]!.getAttribute("aria-describedby")!.split(" ");
    assert.ok(describedBy.some((id) => domWindow.document.getElementById(id)?.textContent === "Sign-In Required"),
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
    const dialog = mounted.container.querySelector<HTMLElement>('[role="dialog"]');
    assert.match(dialog?.textContent ?? "", /Add Remote Instance/, "Add Remote Instance… opens the existing add dialog");
    const cancel = Array.from(dialog!.querySelectorAll<HTMLButtonElement>("button"))
      .find((button) => button.textContent === "Cancel")!;
    await act(async () => { cancel.click(); await tick(); });
    await act(async () => { await new Promise<void>((resolve) => domWindow.requestAnimationFrame(() => resolve())); await tick(); });
    assert.ok(domWindow.document.activeElement === (trigger as never),
      `closing the add dialog returns focus to the tile, not ${domWindow.document.activeElement?.outerHTML.slice(0, 80)}`);

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
      name: "remote sign-in",
      value: manager({ activeProfile: remote }),
      tone: "t-warning",
      hollow: false,
      detail: "Sign-in required",
    },
    // The instance manager still records Online a moment after the socket drops; the banner wins.
    { name: "banner offline", value: manager(), connection: "reconnecting", tone: "t-neutral", hollow: true, detail: "Reconnecting…" },
    { name: "banner sign-in", value: manager(), connection: "sign-in-required", tone: "t-warning", hollow: false, detail: "Sign-in required" },
  ];
  for (const example of cases) {
    const mounted = mount(
      <InstancesContextProvider value={example.value}>
        <InstanceSelector connection={example.connection ?? null} />
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
        onlineConnections={1}
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
      onlineConnections={0}
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

test("instances panel keeps This Machine immutable and makes credential recovery explicit", async () => {
  const mounted = mount(
    <InstancesContextProvider value={manager()}>
      <FeedbackProvider><InstancesPanel /></FeedbackProvider>
    </InstancesContextProvider>,
  );
  await mounted.render();
  try {
    assert.match(mounted.container.textContent ?? "", /2 Instances/);
    // Instances share the machine vocabulary (docs/design-system.md §11.2): a missing credential
    // needs the user to sign in again.
    assert.match(mounted.container.textContent ?? "", /Sign-In Required/);
    assert.equal(
      Array.from(mounted.container.querySelectorAll("button")).filter((button) => button.textContent === "Remove").length,
      1,
      "the immutable local profile has no remove action",
    );
    const rePair = Array.from(mounted.container.querySelectorAll<HTMLButtonElement>("button"))
      .find((button) => button.textContent?.trim() === "Re-Pair")!;
    await act(async () => { rePair.click(); });
    assert.equal(mounted.container.querySelector('[role="dialog"] h2')?.textContent, "Re-Pair Instance");
  } finally {
    await act(async () => { mounted.root.unmount(); });
    mounted.mountPoint.remove();
  }
});

test("add dialog submits a canonical token-free origin and clears the pairing credential", async () => {
  const calls: Array<{ label: string; origin: string; token: string }> = [];
  const mounted = mount(
    <InstancesContextProvider value={manager({
      async addAndSwitch(input) { calls.push(input); },
    })}>
      <RemoteInstanceDialog mode="add" onClose={() => {}} />
    </InstancesContextProvider>,
  );
  await mounted.render();
  try {
    const inputs = mounted.container.querySelectorAll<HTMLInputElement>("input");
    await act(async () => {
      inputs[0]!.value = "Remote A";
      fireDomEvent.change(inputs[0]!);
      inputs[1]!.value = "https://REMOTE.example.test/#pair=abcdefghijklmnop";
      fireDomEvent.change(inputs[1]!);
    });
    const submit = Array.from(mounted.container.querySelectorAll<HTMLButtonElement>("button"))
      .find((button) => button.textContent === "Add and Switch")!;
    await act(async () => { submit.click(); await tick(); });
    assert.deepEqual(calls, [{
      label: "Remote A",
      origin: "https://remote.example.test",
      token: "abcdefghijklmnop",
    }]);
    assert.equal(inputs[1]!.value, "");
    assert.doesNotMatch(mounted.container.textContent ?? "", /abcdefghijklmnop/);
  } finally {
    await act(async () => { mounted.root.unmount(); });
    mounted.mountPoint.remove();
  }
});

test("re-pair rejects a link for a different saved address before invoking native repair", async () => {
  let repairs = 0;
  const mounted = mount(
    <InstancesContextProvider value={manager({
      async repairInstance() { repairs += 1; },
    })}>
      <RemoteInstanceDialog mode="repair" profile={remote} onClose={() => {}} />
    </InstancesContextProvider>,
  );
  await mounted.render();
  try {
    const input = mounted.container.querySelector<HTMLInputElement>('input[type="password"]')!;
    await act(async () => {
      input.value = "https://other.example.test/#pair=abcdefghijklmnop";
      fireDomEvent.change(input);
    });
    const submit = Array.from(mounted.container.querySelectorAll<HTMLButtonElement>("button"))
      .find((button) => button.textContent === "Re-Pair")!;
    await act(async () => { submit.click(); await tick(); });
    assert.equal(repairs, 0);
    assert.match(mounted.container.querySelector('[role="alert"]')?.textContent ?? "", /different server address/);
  } finally {
    await act(async () => { mounted.root.unmount(); });
    mounted.mountPoint.remove();
  }
});

test("changing an instance address requires a matching fresh pairing link", async () => {
  const edits: Array<{ profileId: string; label: string; origin: string; token?: string }> = [];
  const mounted = mount(
    <InstancesContextProvider value={manager({
      async editInstance(input) { edits.push(input); },
    })}>
      <RemoteInstanceDialog mode="edit" profile={remote} onClose={() => {}} />
    </InstancesContextProvider>,
  );
  await mounted.render();
  try {
    const address = Array.from(mounted.container.querySelectorAll<HTMLInputElement>("input"))
      .find((input) => input.previousElementSibling?.textContent === "Server Address")!;
    await act(async () => {
      address.value = "https://new.example.test";
      fireDomEvent.change(address);
    });
    const pairing = Array.from(mounted.container.querySelectorAll<HTMLInputElement>('input[type="password"]'))[0]!;
    await act(async () => {
      pairing.value = "https://new.example.test/#pair=abcdefghijklmnop";
      fireDomEvent.change(pairing);
    });
    const submit = Array.from(mounted.container.querySelectorAll<HTMLButtonElement>("button"))
      .find((button) => button.textContent === "Save Changes")!;
    await act(async () => { submit.click(); await tick(); });
    assert.deepEqual(edits, [{
      profileId: remote.id,
      label: remote.label,
      origin: "https://new.example.test",
      token: "abcdefghijklmnop",
    }]);
  } finally {
    await act(async () => { mounted.root.unmount(); });
    mounted.mountPoint.remove();
  }
});
