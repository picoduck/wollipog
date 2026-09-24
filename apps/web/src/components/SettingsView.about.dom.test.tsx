import "./test-dom-events.js";
import assert from "node:assert/strict";
import { after, before, test } from "node:test";
import React, { act } from "react";
import { createRoot } from "react-dom/client";
import { Window } from "happy-dom";
import { createApiClient } from "../api.js";
import { ApiProvider } from "../api-context.js";
import type { ApiTransport } from "../api-transport.js";
import type { DesktopUpdateSetting, DesktopUpdateStatus } from "../desktop-updates.js";
import { AboutPanel } from "./SettingsView.js";

const domWindow = new Window({ url: "http://localhost/settings/about" });
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

before(() => {
  for (const [name, value] of Object.entries(globals)) {
    previous.set(name, (globalThis as Record<string, unknown>)[name]);
    Object.defineProperty(globalThis, name, { configurable: true, writable: true, value });
  }
});

after(() => {
  for (const [name, value] of previous) {
    Object.defineProperty(globalThis, name, { configurable: true, writable: true, value });
  }
});

function transport(instance: Response | (() => Response)): ApiTransport {
  return {
    instanceId: "about-fixture",
    publicOrigin: "http://localhost",
    close() {},
    async request(path) {
      assert.equal(path, "/api/instance");
      return typeof instance === "function" ? instance() : instance.clone();
    },
  };
}

const instanceResponse = () => new Response(JSON.stringify({
  service: "wollipog-control-plane",
  instanceId: "00000000-0000-4000-8000-000000000000",
  displayName: "Remote",
  apiVersion: 1,
  appVersion: "0.26.0",
  capabilities: [],
}), { status: 200, headers: { "content-type": "application/json" } });

function status(overrides: Partial<DesktopUpdateStatus> = {}): DesktopUpdateStatus {
  return {
    currentVersion: "0.27.0",
    install: { mode: "inPlace" },
    automaticChecks: true,
    checksAllowed: true,
    releasesUrl: "https://github.com/picoduck/wollipog/releases",
    lastCheck: null,
    ...overrides,
  };
}

function setting(overrides: Partial<DesktopUpdateSetting> = {}): DesktopUpdateSetting & { clicks: string[] } {
  const clicks: string[] = [];
  return {
    desktop: true,
    status: status(),
    loading: false,
    checking: false,
    installing: false,
    savingAutomatic: false,
    heldSessions: null,
    error: null,
    check: () => clicks.push("check"),
    install: () => clicks.push("install"),
    dismissHold: () => clicks.push("dismiss"),
    openRelease: () => clicks.push("open"),
    toggleAutomatic: () => clicks.push("automatic"),
    ...overrides,
    clicks,
  };
}

async function render(update: DesktopUpdateSetting | undefined, api: ApiTransport = transport(instanceResponse)) {
  const container = domWindow.document.createElement("div") as unknown as HTMLDivElement;
  domWindow.document.body.append(container as never);
  const root = createRoot(container);
  await act(async () => {
    root.render(<ApiProvider client={createApiClient(api)}><AboutPanel update={update} /></ApiProvider>);
  });
  await act(async () => { await new Promise((resolve) => setTimeout(resolve, 0)); });
  return {
    container,
    text: () => container.textContent ?? "",
    button: (name: string) => [...container.querySelectorAll<HTMLButtonElement>("button")].find((candidate) => candidate.textContent === name),
    unmount: async () => { await act(async () => root.unmount()); container.remove(); },
  };
}

function versions(container: HTMLElement): Record<string, string> {
  const terms = [...container.querySelectorAll("dt")].map((node) => node.textContent ?? "");
  const values = [...container.querySelectorAll("dd")].map((node) => node.textContent ?? "");
  return Object.fromEntries(terms.map((term, index) => [term, values[index] ?? ""]));
}

test("the Versions group shows the real desktop and control-plane versions", async () => {
  const view = await render(setting());
  assert.deepEqual(Object.keys(versions(view.container)), ["Desktop App", "Control Plane", "Protocol"]);
  assert.equal(versions(view.container)["Desktop App"], "0.27.0");
  // The window may be connected to another server; its version is reported, not assumed.
  assert.equal(versions(view.container)["Control Plane"], "0.26.0");
  assert.doesNotMatch(view.text(), /updates itself/u, "the old claim was false and must be gone");
  await view.unmount();
});

test("a control plane that does not report a version says so", async () => {
  const view = await render(undefined, transport(() => new Response("{}", { status: 404 })));
  assert.equal(versions(view.container)["Control Plane"], "Not reported");
  // A browser: no desktop version, and updates belong to the control plane.
  assert.equal(versions(view.container)["Desktop App"], undefined);
  assert.match(view.text(), /updates when that control plane is upgraded/u);
  assert.equal(view.button("Check for Updates"), undefined);
  await view.unmount();
});

test("an available release installs in place, or points at its page when it cannot", async () => {
  const available = { state: "available" as const, version: "0.28.0", releaseUrl: "https://example.test/v0.28.0", checkedAt: 1 };
  let update = setting({ status: status({ lastCheck: available }) });
  let view = await render(update);
  assert.match(view.text(), /Wollipog 0\.28\.0 is available\. Installing restarts Wollipog/u);
  await act(async () => view.button("Install and Restart")!.click());
  assert.deepEqual(update.clicks, ["install"]);
  assert.equal(view.button("Open Release Page"), undefined);
  await view.unmount();

  update = setting({
    status: status({
      lastCheck: available,
      install: { mode: "releasePage", reason: "This app was installed from a .deb package. Install the new package from the release page." },
    }),
  });
  view = await render(update);
  assert.match(view.text(), /installed from a \.deb package/u);
  assert.equal(view.button("Install and Restart"), undefined, "a package-manager install is never replaced in place");
  await act(async () => view.button("Open Release Page")!.click());
  assert.deepEqual(update.clicks, ["open"]);
  await view.unmount();
});

test("a held install warns like closing does, and deferring is a choice", async () => {
  const update = setting({
    status: status({ lastCheck: { state: "available", version: "0.28.0", releaseUrl: "https://example.test", checkedAt: 1 } }),
    heldSessions: 1,
  });
  const view = await render(update);
  const alert = view.container.querySelector('[role="alert"]');
  assert.equal(alert?.textContent, "1 session still has work running. Installing restarts Wollipog and will stop it.");
  await act(async () => view.button("Not Now")!.click());
  await act(async () => view.button("Install Anyway")!.click());
  assert.deepEqual(update.clicks, ["dismiss", "install"]);
  await view.unmount();
});

test("checks can be run by hand, turned off, or disabled for the installation", async () => {
  let update = setting();
  let view = await render(update);
  assert.match(view.text(), /Not checked yet\./u);
  await act(async () => view.button("Check for Updates")!.click());
  const automatic = view.container.querySelector<HTMLButtonElement>('[role="switch"]')!;
  assert.equal(automatic.getAttribute("aria-checked"), "true");
  await act(async () => automatic.click());
  assert.deepEqual(update.clicks, ["check", "automatic"]);
  await view.unmount();

  update = setting({ status: status({ checksAllowed: false }) });
  view = await render(update);
  assert.match(view.text(), /turned off for this installation by WOLLIPOG_DISABLE_UPDATE_CHECK/u);
  assert.equal(view.button("Check for Updates"), undefined);
  const disabled = view.container.querySelector<HTMLButtonElement>('[role="switch"]')!;
  assert.equal(disabled.disabled, true);
  assert.equal(disabled.getAttribute("aria-checked"), "false");
  await view.unmount();

  update = setting({ status: status({ lastCheck: { state: "current", checkedAt: Date.UTC(2026, 8, 23, 12) } }) });
  view = await render(update);
  assert.match(view.text(), /Wollipog 0\.27\.0 is the latest release\. Checked /u);
  assert.ok(view.button("Check Again"));
  await view.unmount();
});
