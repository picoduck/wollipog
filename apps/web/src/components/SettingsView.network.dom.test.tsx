import "./test-dom-events.js";
import assert from "node:assert/strict";
import { after, test } from "node:test";
import React, { act } from "react";
import { createRoot } from "react-dom/client";
import { Window } from "happy-dom";
import type { TailnetAccessSetting } from "../tailnet-access.js";
import type { View } from "../navigation.js";
import type { InstanceManager } from "../instances-context.js";
import { assertNoDomNode } from "../dom-test-assertions.js";

/**
 * Settings › Network (#3027): which Wollipog this window talks to, and the desktop app's Tailnet
 * Access in each state the shell reports.
 */

let phone = false;
// Served by its Wollipog server, as a browser on another device is: the address this window uses is
// its own origin, which is what Connected To must show.
const SERVER = "https://wollipog.example.test";
const domWindow = new Window({ url: `${SERVER}/settings/network` });
(domWindow as unknown as { __WOLLIPOG_SAME_ORIGIN__: number }).__WOLLIPOG_SAME_ORIGIN__ = 1;
Object.defineProperty(domWindow, "matchMedia", {
  configurable: true,
  writable: true,
  value: (query: string) => ({
    get matches() { return query === "(max-width: 760px)" && phone; },
    media: query, onchange: null,
    addEventListener() {}, removeEventListener() {}, addListener() {}, removeListener() {},
    dispatchEvent: () => false,
  }),
});
const copied: string[] = [];
Object.defineProperty(domWindow.navigator, "clipboard", {
  configurable: true,
  value: { writeText: async (text: string) => { copied.push(text); } },
});

// The globals are in place BEFORE the panel's modules load: the dashboard's own address is read once,
// at import, from the window it was served into.
const previous = new Map<string, unknown>();
const globals = {
  window: domWindow,
  document: domWindow.document,
  navigator: domWindow.navigator,
  HTMLElement: domWindow.HTMLElement,
  HTMLButtonElement: domWindow.HTMLButtonElement,
  Node: domWindow.Node,
  React,
  IS_REACT_ACT_ENVIRONMENT: true,
};
for (const [name, value] of Object.entries(globals)) {
  previous.set(name, (globalThis as Record<string, unknown>)[name]);
  Object.defineProperty(globalThis, name, { configurable: true, writable: true, value });
}
const { NetworkPanel } = await import("./SettingsView.js");
const { browserInstanceManager, InstancesContextProvider } = await import("../instances-context.js");

after(() => {
  for (const [name, value] of previous) {
    Object.defineProperty(globalThis, name, { configurable: true, writable: true, value });
  }
});

function tailnet(overrides: Partial<TailnetAccessSetting> = {}): TailnetAccessSetting {
  return {
    status: { available: true, enabled: false, managed: true },
    loading: false,
    desktop: true,
    busy: false,
    error: null,
    toggle: () => undefined,
    retry: () => undefined,
    ...overrides,
  };
}

const BROWSER = tailnet({ status: null, desktop: false });

/** The desktop app with more than one instance allowed, connected to a saved remote server. */
const desktopInstances: InstanceManager = {
  ...browserInstanceManager,
  desktopMultiInstance: true,
  activeProfile: {
    id: "studio",
    serverInstanceId: "studio",
    kind: "remote",
    label: "Home Studio",
    origin: "https://studio.example.ts.net",
    createdAt: "",
  },
};

async function render(
  setting: TailnetAccessSetting,
  { instances = browserInstanceManager }: { instances?: InstanceManager } = {},
) {
  const container = domWindow.document.createElement("div") as unknown as HTMLDivElement;
  document.body.append(container);
  const root = createRoot(container);
  const navigated: View[] = [];
  const draw = (next: TailnetAccessSetting) => act(async () => root.render(
    <InstancesContextProvider value={instances}>
      <NetworkPanel tailnet={next} onNavigate={(view) => navigated.push(view)} />
    </InstancesContextProvider>,
  ));
  await draw(setting);
  return {
    container,
    navigated,
    rerender: draw,
    text: () => container.textContent ?? "",
    row: (title: string) => [...container.querySelectorAll<HTMLElement>(".setting-row")]
      .find((row) => row.querySelector(".setting-row-title")?.textContent === title),
    button: (name: string) => [...container.querySelectorAll<HTMLButtonElement>("button")]
      .find((button) => (button.getAttribute("aria-label") ?? button.textContent) === name),
    switch: () => container.querySelector<HTMLButtonElement>('[role="switch"]'),
    async unmount() {
      await act(async () => root.unmount());
      container.remove();
    },
  };
}

test("in a browser Network shows the server this window uses, with Copy and the foot line", async () => {
  const view = await render(BROWSER);
  try {
    const connected = view.row("Connected To");
    assert.ok(connected, "Connected To is a row");
    assert.equal(connected.querySelector(".setting-row-desc")?.textContent, "The Wollipog server this window uses.");
    const value = connected.querySelector(".setting-row-value-text");
    assert.equal(value?.textContent, SERVER, "the address this window was served from");
    assert.ok(value?.classList.contains("is-mono"), "an address is mono (§11.3)");
    assert.ok(view.button("Copy Address")?.classList.contains("icon-btn"), "Copy is an .icon-btn named Copy Address");

    assert.equal(
      view.container.querySelector(".settings-group-foot")?.textContent,
      "Tailnet access is turned on in the Wollipog desktop app, on the machine that runs the server.",
    );
    const groupTitles = [...view.container.querySelectorAll(".settings-group-title")].map((title) => title.textContent);
    assert.deepEqual(groupTitles, ["Connection"], "a browser has no Tailnet group");
    assert.equal(view.container.querySelector(".settings-group-scope")?.textContent, "This Window");
    assertNoDomNode(view.switch(), "nothing to switch in a browser");
    assert.equal(view.row("Manage Instances"), undefined, "a browser has no Instances to manage");
    for (const words of [/not built yet/i, /instance menu/i, /control plane/i, /port \d+/i]) {
      assert.doesNotMatch(view.text(), words);
    }
  } finally {
    await view.unmount();
  }
});

test("Copy Address puts the address on the clipboard and confirms with its icon", async () => {
  copied.length = 0;
  const view = await render(BROWSER);
  try {
    const copy = view.button("Copy Address")!;
    assertNoDomNode(copy.querySelector(".copy-status-icon-copied"));
    await act(async () => { copy.click(); });
    assert.deepEqual(copied, [SERVER], "copied only when asked, and only the address");
    assert.ok(copy.querySelector(".copy-status-icon-copied"), "the icon turns into the check");
    assert.ok(copy.classList.contains("copy-status-copied"));
  } finally {
    await view.unmount();
  }
});

test("in the desktop app Manage Instances opens Connections › Instances, and copies the remote address", async () => {
  copied.length = 0;
  phone = false;
  const view = await render(tailnet(), { instances: desktopInstances });
  try {
    assert.equal(view.row("Connected To")?.querySelector(".setting-row-value-text")?.textContent, "https://studio.example.ts.net");
    await act(async () => { view.button("Copy Address")!.click(); });
    assert.deepEqual(copied, ["https://studio.example.ts.net"]);

    const manage = view.row("Manage Instances");
    assert.ok(manage, "Manage Instances shows where Connections › Instances exists");
    assert.equal(manage.tagName, "BUTTON", "the whole row is the link");
    assert.equal(manage.querySelector(".setting-row-desc")?.textContent, "Add, rename or switch Wollipog servers.");
    assert.equal(manage.querySelector(".setting-row-link-word")?.textContent, "Connections");
    await act(async () => { manage.click(); });
    assert.deepEqual(view.navigated, [{ name: "runners", section: "instances" }]);
  } finally {
    await view.unmount();
  }
});

test("Manage Instances is absent on a phone and where only one instance is allowed", async () => {
  phone = true;
  const onPhone = await render(tailnet(), { instances: desktopInstances });
  try {
    assert.equal(onPhone.row("Manage Instances"), undefined, "a phone's Connections has no Instances tab");
    assert.ok(onPhone.row("Connected To"));
  } finally {
    await onPhone.unmount();
    phone = false;
  }
  const single = await render(tailnet());
  try {
    assert.equal(single.row("Manage Instances"), undefined);
  } finally {
    await single.unmount();
  }
});

test("Tailnet Access is a noun-titled switch whose sentence follows its value", async () => {
  const view = await render(tailnet());
  try {
    const groupTitles = [...view.container.querySelectorAll(".settings-group-title")].map((title) => title.textContent);
    assert.deepEqual(groupTitles, ["Connection", "Tailnet"]);
    assert.deepEqual([...view.container.querySelectorAll(".settings-group-scope")].map((scope) => scope.textContent),
      ["This Window", "This Machine"]);
    assertNoDomNode(view.container.querySelector(".settings-group-foot"), "the desktop app needs no pointer to itself");
    const control = view.switch()!;
    assert.equal(control.querySelector(".setting-row-title")?.textContent, "Tailnet Access");
    assert.equal(control.getAttribute("aria-checked"), "false");
    assert.equal(control.querySelector(".setting-row-desc")?.textContent, "Let paired browsers reach this machine through Tailscale.");
    await view.rerender(tailnet({ status: { available: true, enabled: true, managed: true } }));
    assert.equal(view.switch()!.getAttribute("aria-checked"), "true");
    assert.equal(view.switch()!.querySelector(".setting-row-desc")?.textContent,
      "Paired browsers can connect through this machine's Tailscale address.");
  } finally {
    await view.unmount();
  }
});

test("toggling shows the restart while the switch keeps its confirmed value", async () => {
  let toggles = 0;
  const view = await render(tailnet({ toggle: () => { toggles += 1; } }));
  try {
    await act(async () => { view.switch()!.click(); });
    assert.equal(toggles, 1, "the switch drives the desktop command");
    // The shell reports the write in flight; the status is still the confirmed OFF.
    await view.rerender(tailnet({ busy: true }));
    const control = view.switch()!;
    assert.equal(control.getAttribute("aria-checked"), "false", "the switch keeps its confirmed value");
    assert.equal(control.getAttribute("aria-busy"), "true");
    assert.ok(control.disabled, "a busy switch cannot be pressed again");
    const busyLine = control.querySelector(".setting-row-desc-slot.is-busy > .setting-row-desc:last-child");
    assert.equal(busyLine?.textContent, "Restarting Wollipog on this machine…");
    // What a screen reader hears is the restart, not the hidden on/off sentence it covers.
    const describedBy = control.getAttribute("aria-describedby");
    assert.ok(describedBy, "the busy switch is described");
    assert.equal(document.getElementById(describedBy)?.textContent, "Restarting Wollipog on this machine…");
    await view.rerender(tailnet({ status: { available: true, enabled: true, managed: true } }));
    assert.equal(document.getElementById(view.switch()!.getAttribute("aria-describedby")!)?.textContent,
      "Paired browsers can connect through this machine's Tailscale address.", "settled, the sentence follows the value");
  } finally {
    await view.unmount();
  }
});

test("a failed write shows the failure in place of the description with Try Again", async () => {
  let retries = 0;
  const view = await render(tailnet({
    error: "Tailscale refused the change.",
    retry: () => { retries += 1; },
  }));
  try {
    const failure = view.container.querySelector(".setting-row-failure");
    assert.match(failure?.textContent ?? "", /^Couldn't change Tailnet Access\. Try Again$/);
    assert.equal(failure?.querySelector("[title]")?.getAttribute("title"), "Tailscale refused the change.",
      "the shell's own words stay available");
    assert.equal(view.switch()!.getAttribute("aria-checked"), "false", "still the confirmed value");
    assert.match(view.container.querySelector('[role="status"]')?.textContent ?? "", /Couldn't change Tailnet Access\./);
    await act(async () => { view.button("Try Again")!.click(); });
    assert.equal(retries, 1);
  } finally {
    await view.unmount();
  }
});

test("with Tailscale missing the switch is disabled and says why in visible text", async () => {
  const view = await render(tailnet({ status: { available: false, enabled: false, managed: true } }));
  try {
    const control = view.switch()!;
    assert.ok(control.disabled);
    const reason = control.querySelector(".setting-row-desc");
    assert.equal(reason?.textContent, "Tailscale isn't installed or running on this machine.");
    assert.equal(control.getAttribute("aria-describedby"), reason?.id, "the reason is the switch's description");
  } finally {
    await view.unmount();
  }
});

test("another server on this machine's port disables the switch without naming the port", async () => {
  const view = await render(tailnet({ status: { available: true, enabled: false, managed: false } }));
  try {
    assert.ok(view.switch()!.disabled);
    assert.equal(view.switch()!.querySelector(".setting-row-desc")?.textContent,
      "Unavailable because another Wollipog server is using this machine's port.");
    assert.doesNotMatch(view.text(), /control plane|\d{4}/i);
  } finally {
    await view.unmount();
  }
});

test("an unknown value is never announced as a switch: checking, then a failed read with Try Again", async () => {
  let retries = 0;
  const view = await render(tailnet({ status: null, loading: true }));
  try {
    assertNoDomNode(view.switch(), "checking is not OFF");
    assert.equal(view.row("Tailnet Access")?.getAttribute("aria-busy"), "true");
    assert.match(view.row("Tailnet Access")?.textContent ?? "", /Checking for Tailscale…/);

    await view.rerender(tailnet({ status: null, error: "The desktop shell did not answer.", retry: () => { retries += 1; } }));
    assertNoDomNode(view.switch(), "a failed read is not OFF either");
    const failure = view.row("Tailnet Access")?.querySelector(".setting-row-failure");
    assert.match(failure?.textContent ?? "", /^Couldn't check for Tailscale\. Try Again$/);
    const tryAgain = view.button("Try Again")!;
    tryAgain.focus();
    await act(async () => { tryAgain.click(); });
    assert.equal(retries, 1);
    // Try Again is about to be replaced by the checking line, so focus stays in the row.
    assert.ok(document.activeElement?.classList.contains("setting-row-frame"));
    await view.rerender(tailnet({ status: null, loading: true }));
    assert.ok(document.activeElement?.classList.contains("setting-row-frame"), "and survives checking");
    // The read succeeds: the frame becomes the switch, and focus goes with it.
    await view.rerender(tailnet());
    assert.equal(document.activeElement, view.switch(), "focus is handed to the switch, not dropped to <body>");
  } finally {
    await view.unmount();
  }
});

test("a re-read that returns a disabled switch keeps focus in the row", async () => {
  // A disabled button cannot be focused, so handing focus to the switch would drop it to <body>.
  for (const status of [
    { available: true, enabled: false, managed: false },
    { available: false, enabled: false, managed: true },
  ]) {
    const view = await render(tailnet({ status: null, error: "The desktop shell did not answer." }));
    try {
      await act(async () => { view.button("Try Again")!.click(); });
      await view.rerender(tailnet({ status: null, loading: true }));
      await view.rerender(tailnet({ status }));
      assert.ok(view.switch()!.disabled);
      const active = document.activeElement;
      assert.notEqual(active, document.body, `focus survives a re-read that returns ${JSON.stringify(status)}`);
      assert.ok(active?.contains(view.switch()), "it is the row's frame around the disabled switch");
    } finally {
      await view.unmount();
    }
  }
});

test("a re-read that succeeds leaves focus alone if the user moved it elsewhere", async () => {
  const outside = document.createElement("button");
  document.body.append(outside);
  const view = await render(tailnet({ status: null, error: "The desktop shell did not answer." }));
  try {
    await act(async () => { view.button("Try Again")!.click(); });
    await view.rerender(tailnet({ status: null, loading: true }));
    outside.focus();
    await view.rerender(tailnet());
    assert.equal(document.activeElement, outside);
  } finally {
    await view.unmount();
    outside.remove();
  }
});
