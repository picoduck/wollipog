import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { fileURLToPath } from "node:url";
import React, { act } from "react";
import { createRoot } from "react-dom/client";
import { Window } from "happy-dom";
import { FeedbackContext, type ToastOptions } from "./FeedbackProvider.js";
import { DesktopUpdateNotifier } from "./DesktopUpdateNotifier.js";
import type { DesktopUpdateCheck, DesktopUpdateOutcome, DesktopUpdateRuntime, DesktopUpdateStatus } from "../desktop-updates.js";
import { installDomTestCleanup } from "../dom-test-cleanup.js";

const domWindow = new Window({ url: "http://localhost/" });
installDomTestCleanup(domWindow);
for (const [name, value] of Object.entries({
  window: domWindow,
  document: domWindow.document,
  navigator: domWindow.navigator,
  HTMLElement: domWindow.HTMLElement,
  Node: domWindow.Node,
  React,
  IS_REACT_ACT_ENVIRONMENT: true,
})) Object.defineProperty(globalThis, name, { configurable: true, writable: true, value });

const available: DesktopUpdateCheck = {
  state: "available",
  version: "0.28.0",
  releaseUrl: "https://github.com/picoduck/wollipog/releases/tag/v0.28.0",
  checkedAt: 1,
};

function status(mode: "inPlace" | "releasePage"): DesktopUpdateStatus {
  return {
    currentVersion: "0.27.0",
    install: mode === "inPlace" ? { mode } : { mode, reason: "This app was installed from a .deb package." },
    automaticChecks: true,
    checksAllowed: true,
    releasesUrl: "https://github.com/picoduck/wollipog/releases",
    lastCheck: available,
  };
}

function harness({
  isTauri = true,
  check = available as DesktopUpdateCheck | null,
  mode = "inPlace" as "inPlace" | "releasePage",
  installs = [] as DesktopUpdateOutcome[],
} = {}) {
  const calls: Array<{ command: string; args?: Record<string, unknown> }> = [];
  const toasts: Array<{ message: string } & ToastOptions> = [];
  const desktop: DesktopUpdateRuntime = {
    isTauri: () => isTauri,
    invoke: async <T,>(command: string, args?: Record<string, unknown>) => {
      calls.push({ command, args });
      if (command === "check_for_desktop_update") return check as T;
      if (command === "desktop_update_status") return status(mode) as T;
      if (command === "install_desktop_update") return (installs.shift() ?? { outcome: "restarting" }) as T;
      return undefined as T;
    },
  };
  return { calls, toasts, desktop };
}

async function mount(h: ReturnType<typeof harness>) {
  const container = domWindow.document.createElement("div") as unknown as HTMLDivElement;
  domWindow.document.body.append(container as never);
  const root = createRoot(container);
  const feedback = {
    confirm: async () => false,
    showToast: (message: string, options: ToastOptions = {}) => {
      h.toasts.push({ message, ...options });
      return h.toasts.length;
    },
    showUndo: () => -1,
    dismissToast: () => undefined,
  };
  await act(async () => {
    root.render(
      <FeedbackContext.Provider value={feedback as never}>
        <DesktopUpdateNotifier desktop={h.desktop} firstCheckDelayMs={0} recheckIntervalMs={60_000} />
      </FeedbackContext.Provider>,
    );
  });
  // Let the zero-delay timer and the awaited invokes settle.
  await act(async () => { await new Promise((resolve) => setTimeout(resolve, 10)); });
  return { unmount: async () => { await act(async () => root.unmount()); container.remove(); } };
}

test("a newer release is announced once, as an automatic check, with an install action", async () => {
  const h = harness();
  const { unmount } = await mount(h);
  assert.deepEqual(h.calls[0], { command: "check_for_desktop_update", args: { automatic: true } });
  assert.equal(h.toasts.length, 1);
  assert.equal(h.toasts[0]!.message, "Wollipog 0.28.0 is available.");
  assert.equal(h.toasts[0]!.durationMs, 0, "an update notice waits for the user");
  assert.equal(h.toasts[0]!.action?.label, "Install and Restart");
  await unmount();
});

test("installing while work is in flight turns into the warning, and its action confirms", async () => {
  const h = harness({ installs: [{ outcome: "heldForWork", sessions: 2 }, { outcome: "restarting" }] });
  const { unmount } = await mount(h);
  await act(async () => { await h.toasts[0]!.action!.run(); });
  assert.equal(h.toasts.length, 2);
  assert.equal(h.toasts[1]!.message, "2 sessions still have work running. Installing restarts Wollipog and will stop them.");
  assert.equal(h.toasts[1]!.tone, "error");
  assert.equal(h.toasts[1]!.durationMs, 0);
  assert.equal(h.toasts[1]!.action?.label, "Install Anyway");
  await act(async () => { await h.toasts[1]!.action!.run(); });
  assert.equal(h.calls.filter(({ command }) => command === "install_desktop_update").length, 2);
  assert.equal(h.toasts.length, 2, "a confirmed install restarts; it does not warn again");
  await unmount();
});

test("a package-manager install is pointed at the release page instead", async () => {
  const h = harness({ mode: "releasePage" });
  const { unmount } = await mount(h);
  assert.equal(h.toasts[0]!.action?.label, "Open Release Page");
  await act(async () => { await h.toasts[0]!.action!.run(); });
  assert.deepEqual(h.calls.at(-1), { command: "open_external_url", args: { url: available.releaseUrl } });
  assert.equal(h.calls.some(({ command }) => command === "install_desktop_update"), false);
  await unmount();
});

test("nothing is shown when the check is off, current, or in a browser", async () => {
  for (const h of [harness({ check: null }), harness({ check: { state: "current", checkedAt: 1 } })]) {
    const { unmount } = await mount(h);
    assert.equal(h.toasts.length, 0);
    await unmount();
  }
  const browser = harness({ isTauri: false });
  const { unmount } = await mount(browser);
  assert.equal(browser.calls.length, 0);
  await unmount();
});

test("the notifier is mounted beside the close guard, above the instance boundary", () => {
  const app = readFileSync(fileURLToPath(new URL("../App.tsx", import.meta.url)), "utf8");
  const desktopApp = app.slice(app.indexOf("function DesktopApp()"), app.indexOf("function DesktopInstanceBoundary()"));
  assert.ok(desktopApp.indexOf("<DesktopUpdateNotifier />") > 0, "a notifier that is never mounted checks nothing");
  assert.ok(desktopApp.indexOf("<DesktopUpdateNotifier />") < desktopApp.indexOf("<InstanceProvider>"));
});
