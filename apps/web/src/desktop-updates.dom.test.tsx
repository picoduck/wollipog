import assert from "node:assert/strict";
import test from "node:test";
import React, { act } from "react";
import { createRoot } from "react-dom/client";
import { Window } from "happy-dom";
import {
  DESKTOP_UPDATE_CHECKED,
  DESKTOP_UPDATE_CHANNEL_CHANGED,
  useDesktopUpdateSetting,
  type DesktopUpdateRuntime,
  type DesktopUpdateSetting,
  type DesktopUpdateStatus,
} from "./desktop-updates.js";

const domWindow = new Window({ url: "http://localhost/" });
for (const [name, value] of Object.entries({
  window: domWindow,
  document: domWindow.document,
  navigator: domWindow.navigator,
  HTMLElement: domWindow.HTMLElement,
  Node: domWindow.Node,
  React,
  IS_REACT_ACT_ENVIRONMENT: true,
})) Object.defineProperty(globalThis, name, { configurable: true, writable: true, value });

const status: DesktopUpdateStatus = {
  currentVersion: "0.27.0",
  install: { mode: "inPlace" },
  automaticChecks: true,
  checksAllowed: true,
  releasesUrl: "https://github.com/picoduck/wollipog/releases",
  lastCheck: null,
};

test("a check that finishes while the first status read is in flight is not overwritten by it", async () => {
  const handlers = new Map<string, (payload: unknown) => void>();
  let resolveStatus: (value: DesktopUpdateStatus) => void = () => undefined;
  const desktop: DesktopUpdateRuntime = {
    isTauri: () => true,
    invoke: <T,>() => new Promise<T>((resolve) => { resolveStatus = resolve as (value: DesktopUpdateStatus) => void; }),
    listen: async (event, handler) => {
      handlers.set(event, handler);
      return () => undefined;
    },
  };
  let latest: DesktopUpdateSetting | undefined;
  function Probe() {
    latest = useDesktopUpdateSetting(desktop);
    return null;
  }
  const container = domWindow.document.createElement("div") as unknown as HTMLDivElement;
  domWindow.document.body.append(container as never);
  const root = createRoot(container);
  await act(async () => { root.render(<Probe />); });
  // Subscribed before the read was even sent.
  assert.ok(handlers.has(DESKTOP_UPDATE_CHECKED));
  const available = { state: "available", version: "0.28.0", releaseUrl: "https://example.test", checkedAt: 5 };
  await act(async () => { handlers.get(DESKTOP_UPDATE_CHECKED)!(available); });
  await act(async () => { resolveStatus({ ...status, lastCheck: null }); });
  assert.deepEqual(latest?.status?.lastCheck, available, "the older snapshot must not win");
  await act(async () => root.unmount());
  container.remove();
});

test("a background check that finishes after Settings loaded still reaches Settings", async () => {
  const handlers = new Map<string, (payload: unknown) => void>();
  let unlistened = 0;
  const desktop: DesktopUpdateRuntime = {
    isTauri: () => true,
    invoke: async <T,>() => status as T,
    listen: async (event, handler) => {
      handlers.set(event, handler);
      return () => { unlistened += 1; };
    },
  };
  let latest: DesktopUpdateSetting | undefined;
  function Probe() {
    latest = useDesktopUpdateSetting(desktop);
    return null;
  }
  const container = domWindow.document.createElement("div") as unknown as HTMLDivElement;
  domWindow.document.body.append(container as never);
  const root = createRoot(container);
  await act(async () => { root.render(<Probe />); });
  assert.equal(latest?.status?.lastCheck, null);
  assert.ok(handlers.has(DESKTOP_UPDATE_CHECKED), "the hook must listen for the shell's check event");

  const available = { state: "available", version: "0.28.0", releaseUrl: "https://example.test", checkedAt: 2 };
  await act(async () => { handlers.get(DESKTOP_UPDATE_CHECKED)!(available); });
  assert.deepEqual(latest?.status?.lastCheck, available);

  await act(async () => root.unmount());
  container.remove();
  assert.equal(unlistened, 2, "both subscriptions are released with the hook");
});

test("switching channels clears the offer and ignores an old-channel check arriving later", async () => {
  const handlers = new Map<string, (payload: unknown) => void>();
  const commands: Array<{ command: string; args?: Record<string, unknown> }> = [];
  const prerelease = { state: "available" as const, version: "0.28.0-rc.1", releaseUrl: "https://example.test", checkedAt: 5, prereleaseUpdates: true };
  const before = { ...status, prereleaseUpdates: true, lastCheck: prerelease };
  const after = { ...status, prereleaseUpdates: false, lastCheck: null };
  let finishCheck: (value: typeof prerelease) => void = () => undefined;
  const desktop: DesktopUpdateRuntime = {
    isTauri: () => true,
    invoke: async <T,>(command: string, args?: Record<string, unknown>) => {
      commands.push({ command, args });
      if (command === "desktop_update_status") return before as T;
      if (command === "check_for_desktop_update") return new Promise<T>((resolve) => { finishCheck = resolve as typeof finishCheck; });
      if (command === "set_prerelease_updates") return after as T;
      throw new Error(command);
    },
    listen: async (event, handler) => { handlers.set(event, handler); return () => undefined; },
  };
  let latest: DesktopUpdateSetting | undefined;
  function Probe() { latest = useDesktopUpdateSetting(desktop); return null; }
  const container = domWindow.document.createElement("div") as unknown as HTMLDivElement;
  domWindow.document.body.append(container as never);
  const root = createRoot(container);
  await act(async () => root.render(<Probe />));
  await act(async () => latest!.togglePrerelease());
  assert.deepEqual(commands.at(-1), { command: "set_prerelease_updates", args: { enabled: false } });
  assert.equal(latest!.status!.lastCheck, null);
  // A second window changes the channel while the first window's earlier check is in flight.
  await act(async () => handlers.get(DESKTOP_UPDATE_CHANNEL_CHANGED)!(before));
  await act(async () => latest!.check());
  await act(async () => handlers.get(DESKTOP_UPDATE_CHANNEL_CHANGED)!(after));
  await act(async () => {
    finishCheck(prerelease);
    handlers.get(DESKTOP_UPDATE_CHECKED)!(prerelease);
  });
  assert.equal(latest!.status!.prereleaseUpdates, false);
  assert.equal(latest!.status!.lastCheck, null);
  await act(async () => root.unmount());
  container.remove();
});
