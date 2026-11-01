import assert from "node:assert/strict";
import test from "node:test";
import React, { act } from "react";
import { createRoot } from "react-dom/client";
import { Window } from "happy-dom";
import type { InstanceProfile } from "../desktop-instances.js";
import { InstancesContextProvider, type InstanceManager } from "../instances-context.js";
import { RemoteInstanceBanner } from "./RemoteInstanceBanner.js";

/**
 * The remote instance banner (#3005): the instance's name and when it last connected, never its
 * address, with Retry or Re-Pair… and Open Instances. Re-Pair… opening the provider's dialog from
 * the banner, the list and the recovery screen is InstanceDialogEntryPoints.dom.test.tsx's.
 */

const domWindow = new Window({ url: "https://tauri.localhost/" });
for (const [name, value] of Object.entries({
  window: domWindow,
  document: domWindow.document,
  navigator: domWindow.navigator,
  HTMLElement: domWindow.HTMLElement,
  HTMLButtonElement: domWindow.HTMLButtonElement,
  Node: domWindow.Node,
  Event: domWindow.Event,
  React,
  IS_REACT_ACT_ENVIRONMENT: true,
})) Object.defineProperty(globalThis, name, { configurable: true, writable: true, value });

const local: InstanceProfile = { id: "local", serverInstanceId: "local", kind: "local", label: "This Machine", origin: "http://127.0.0.1:4317", createdAt: "" };
const studio: InstanceProfile = {
  id: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
  serverInstanceId: "11111111-1111-4111-8111-111111111111",
  kind: "remote",
  label: "Studio",
  origin: "https://studio.example.test:4317",
  createdAt: "2026-01-01T00:00:00Z",
};

function manager(profile: InstanceProfile, overrides: Partial<InstanceManager> = {}): InstanceManager {
  return {
    desktopMultiInstance: true,
    registry: { profiles: [local, profile], activeInstanceId: profile.id },
    activeProfile: profile,
    runtime: null,
    navigation: undefined,
    phase: "ready",
    error: null,
    statusByProfile: {},
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

async function mount(value: InstanceManager, authenticationRequired = false) {
  const host = domWindow.document.createElement("div") as unknown as HTMLDivElement;
  domWindow.document.body.append(host as never);
  const root = createRoot(host);
  await act(async () => {
    root.render(<InstancesContextProvider value={value}><RemoteInstanceBanner authenticationRequired={authenticationRequired} /></InstancesContextProvider>);
  });
  const banner = () => host.querySelector<HTMLElement>(".notice.page-banner")!;
  return {
    banner,
    sentence: () => banner().querySelector(".notice-body")?.textContent,
    buttons: () => [...banner().querySelectorAll<HTMLButtonElement>("button")],
    button: (name: string) => [...banner().querySelectorAll<HTMLButtonElement>("button")].find((button) => button.textContent?.trim() === name)!,
    async click(name: string) {
      await act(async () => { [...banner().querySelectorAll<HTMLButtonElement>("button")].find((button) => button.textContent?.trim() === name)!.click(); });
    },
    async dispose() {
      await act(async () => root.unmount());
      host.remove();
    },
  };
}

test("an unreachable remote names the instance and its last connection, never its address", async () => {
  let release!: () => void;
  let retries = 0;
  let opened = 0;
  const value = manager({ ...studio, lastConnectedAt: new Date(Date.now() - 5 * 3_600_000).toISOString() }, {
    retryActive: () => {
      retries += 1;
      return new Promise<void>((resolve) => { release = resolve; });
    },
    manageInstances: () => { opened += 1; },
  });
  const view = await mount(value);
  try {
    assert.equal(view.banner().getAttribute("role"), "status");
    assert.equal(view.sentence(), "Can't reach Studio. Last connected 5h ago.");
    assert.doesNotMatch(view.banner().textContent ?? "", /studio\.example\.test|https?:/u, "the address is the Instances row's");
    assert.deepEqual(view.buttons().map((button) => [button.textContent, button.className]), [
      ["Retry", "btn sm"],
      ["Open Instances", "btn sm ghost"],
    ]);

    await view.click("Retry");
    assert.equal(retries, 1);
    const retry = view.button("Retry");
    assert.equal(retry.getAttribute("aria-busy"), "true", "Retry keeps its label with a spinner");
    await view.click("Retry");
    assert.equal(retries, 1, "a busy Retry refuses another press");
    await act(async () => { release(); });
    assert.equal(view.button("Retry").getAttribute("aria-busy"), null);

    await view.click("Open Instances");
    assert.equal(opened, 1);
  } finally {
    await view.dispose();
  }

  const never = await mount(manager(studio));
  try {
    assert.equal(never.sentence(), "Can't reach Studio. Never connected.");
  } finally {
    await never.dispose();
  }
});

test("a rejected credential offers Re-Pair… for the active instance in place, and Open Instances", async () => {
  const opened: Array<{ mode: string; profileId?: string }> = [];
  let navigated = 0;
  const view = await mount(manager(studio, {
    openInstanceDialog: (request) => { opened.push({ mode: request.mode, ...("profileId" in request ? { profileId: request.profileId } : {}) }); },
    manageInstances: () => { navigated += 1; },
  }), true);
  try {
    assert.equal(view.sentence(), "Studio needs a new pairing before it can reconnect.");
    assert.deepEqual(view.buttons().map((button) => [button.textContent, button.className]), [
      ["Re-Pair…", "btn primary sm"],
      ["Open Instances", "btn sm ghost"],
    ]);
    assert.equal(view.button("Re-Pair…").getAttribute("aria-haspopup"), "dialog");
    await view.click("Re-Pair…");
    assert.deepEqual(opened, [{ mode: "repair", profileId: studio.id }]);
    assert.equal(navigated, 0, "Re-Pair… does not leave the page");
    assert.doesNotMatch(view.banner().textContent ?? "", /studio\.example\.test|token|credential/iu);
  } finally {
    await view.dispose();
  }
});
