import assert from "node:assert/strict";
import test from "node:test";
import React, { act } from "react";
import { createRoot } from "react-dom/client";
import { Window } from "happy-dom";
import {
  DESKTOP_UPDATE_CHECKED,
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
  assert.equal(unlistened, 1, "the subscription is released with the hook");
});
