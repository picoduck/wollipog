import assert from "node:assert/strict";
import test from "node:test";
import React, { act } from "react";
import { createRoot } from "react-dom/client";
import { Simulate } from "react-dom/test-utils";
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
  const container = happyContainer as unknown as HTMLDivElement;
  const root = createRoot(container);
  return { container, root, render: () => act(async () => { root.render(element); }) };
}

const tick = () => new Promise<void>((resolve) => domWindow.setTimeout(resolve, 0));

test("instance selector remains keyboard-managed and exposes switching plus management", async () => {
  const switched: string[] = [];
  let managed = 0;
  const value = manager({
    async switchInstance(profileId) { switched.push(profileId); },
    manageInstances() { managed += 1; },
  });
  const mounted = mount(
    <InstancesContextProvider value={value}><InstanceSelector /></InstancesContextProvider>,
  );
  await mounted.render();
  try {
    const trigger = mounted.container.querySelector<HTMLButtonElement>(
      '[aria-label="Switch Instance, Current This Machine"]',
    )!;
    await act(async () => { trigger.click(); });
    const menu = mounted.container.querySelector<HTMLElement>('[role="menu"]')!;
    assert.equal(menu.querySelectorAll('[role="menuitemradio"]').length, 2);
    assert.equal(menu.querySelector('[aria-checked="true"]')?.textContent?.includes("This Machine"), true);
    const remoteItem = Array.from(menu.querySelectorAll<HTMLButtonElement>('[role="menuitemradio"]'))
      .find((button) => button.textContent?.includes("Home Workstation"))!;
    await act(async () => { remoteItem.click(); await tick(); });
    assert.deepEqual(switched, [remote.id]);

    await act(async () => { trigger.click(); });
    const manage = Array.from(mounted.container.querySelectorAll<HTMLButtonElement>('[role="menuitem"]'))
      .find((button) => button.textContent === "Manage Instances")!;
    await act(async () => { manage.click(); });
    assert.equal(managed, 1);
  } finally {
    await act(async () => { mounted.root.unmount(); });
    mounted.container.remove();
  }
});

test("compact instance selector stays bottom-anchored inside the real desktop Rail", async () => {
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
        onNewSession={() => undefined}
        instanceControl={<InstanceSelector compact />}
        settingsControl={<button type="button">Settings</button>}
      />
    </InstancesContextProvider>,
  );
  await mounted.render();
  try {
    const rail = mounted.container.querySelector(".app-rail");
    const trigger = rail?.querySelector<HTMLButtonElement>(
      '[aria-label="Switch Instance, Current This Machine"]',
    );
    assert.ok(trigger, "the compact selector is mounted through Rail.instanceControl");
    trigger.getBoundingClientRect = () => ({
      top: 548,
      right: 55,
      bottom: 592,
      left: 11,
      width: 44,
      height: 44,
      x: 11,
      y: 548,
      toJSON: () => ({}),
    });

    await act(async () => { trigger.click(); });
    const menu = rail?.querySelector<HTMLElement>('[role="menu"][aria-label="Switch Instance"]');
    assert.ok(menu);
    assert.equal(menu.style.position, "fixed");
    assert.equal(menu.style.top, "auto");
    assert.equal(menu.style.bottom, "98px");
    assert.equal(menu.style.left, "11px");
    assert.equal(menu.style.width, "260px");
    assert.equal(menu.style.maxHeight, "176px", "two profiles right-size the menu maximum");
  } finally {
    await act(async () => { mounted.root.unmount(); });
    mounted.container.remove();
    Object.defineProperty(domWindow, "innerWidth", { configurable: true, value: priorWidth });
    Object.defineProperty(domWindow, "innerHeight", { configurable: true, value: priorHeight });
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
    assert.match(mounted.container.textContent ?? "", /Authentication Required/);
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
    mounted.container.remove();
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
      Simulate.change(inputs[0]!);
      inputs[1]!.value = "https://REMOTE.example.test/#pair=abcdefghijklmnop";
      Simulate.change(inputs[1]!);
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
    mounted.container.remove();
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
      Simulate.change(input);
    });
    const submit = Array.from(mounted.container.querySelectorAll<HTMLButtonElement>("button"))
      .find((button) => button.textContent === "Re-Pair")!;
    await act(async () => { submit.click(); await tick(); });
    assert.equal(repairs, 0);
    assert.match(mounted.container.querySelector('[role="alert"]')?.textContent ?? "", /different server address/);
  } finally {
    await act(async () => { mounted.root.unmount(); });
    mounted.container.remove();
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
      Simulate.change(address);
    });
    const pairing = Array.from(mounted.container.querySelectorAll<HTMLInputElement>('input[type="password"]'))[0]!;
    await act(async () => {
      pairing.value = "https://new.example.test/#pair=abcdefghijklmnop";
      Simulate.change(pairing);
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
    mounted.container.remove();
  }
});
