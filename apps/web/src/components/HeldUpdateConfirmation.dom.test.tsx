import "./test-dom-events.js";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test, { after, afterEach } from "node:test";
import { fileURLToPath } from "node:url";
import React, { act } from "react";
import { createRoot } from "react-dom/client";
import { Window } from "happy-dom";
import type { SessionStatus } from "@wollipog/protocol";
import { createApiClient } from "../api.js";
import { ApiProvider } from "../api-context.js";
import type { ApiTransport } from "../api-transport.js";
import { createCloseGuardLinks, type CloseGuardLinks } from "../desktop-close-guard.js";
import {
  heldUpdateMessage,
  useDesktopUpdateSetting,
  type DesktopUpdateOutcome,
  type DesktopUpdateRuntime,
  type DesktopUpdateStatus,
} from "../desktop-updates.js";
import { assertNoDomNode } from "../dom-test-assertions.js";
import { DesktopUpdateNotifier } from "./DesktopUpdateNotifier.js";
import { FeedbackProvider } from "./FeedbackProvider.js";
import { AboutPanel } from "./SettingsView.js";

/**
 * #1975: installing a desktop update over running work is one decision, asked by one confirmation,
 * wherever the install starts. These mount the real FeedbackProvider with a fake shell, and start the
 * install from both surfaces that can: the update toast and Settings › About.
 */

const domWindow = new Window({ url: "http://localhost/settings/about" });
// The notifier's recheck is a repeating timer. Every mount is unmounted after its test, pass or fail,
// and the window aborts whatever is left once the file is done. An abort between tests is not used:
// it intermittently kept the next mount's zero-delay check from firing.
const unmounts: Array<() => Promise<void>> = [];
afterEach(async () => {
  while (unmounts.length) await unmounts.pop()!();
});
after(async () => { await domWindow.happyDOM.abort(); });

for (const [name, value] of Object.entries({
  window: domWindow,
  document: domWindow.document,
  navigator: domWindow.navigator,
  HTMLElement: domWindow.HTMLElement,
  HTMLButtonElement: domWindow.HTMLButtonElement,
  Node: domWindow.Node,
  Event: domWindow.Event,
  KeyboardEvent: domWindow.KeyboardEvent,
  MouseEvent: domWindow.MouseEvent,
  React,
  IS_REACT_ACT_ENVIRONMENT: true,
})) Object.defineProperty(globalThis, name, { configurable: true, writable: true, value });

const document = domWindow.document as unknown as Document;
const tick = () => new Promise<void>((resolve) => setTimeout(resolve, 0));
const settle = async () => { await act(async () => { await tick(); await tick(); }); };
/** Wait for what the page should show, rather than for a guess at how long the fake shell takes. */
async function until(what: string, ready: () => unknown) {
  for (let waited = 0; !ready(); waited += 5) {
    assert.ok(waited < 2_000, `timed out waiting for ${what}`);
    await act(async () => { await new Promise((resolve) => setTimeout(resolve, 5)); });
  }
}

const VERSION = "0.29.0";
const RELEASE_URL = `https://github.com/picoduck/wollipog/releases/tag/v${VERSION}`;
const SESSIONS: Record<string, { title: string; status: SessionStatus }> = {
  s_rounding: { title: "Fix the invoice rounding bug", status: "running" },
  s_migration: { title: "Review the migration plan", status: "input_required" },
};
const HELD: DesktopUpdateOutcome = { outcome: "heldForWork", sessions: 2, sessionIds: ["s_rounding", "s_migration"] };

const status: DesktopUpdateStatus = {
  currentVersion: "0.28.2",
  install: { mode: "inPlace" },
  automaticChecks: true,
  checksAllowed: true,
  releasesUrl: "https://github.com/picoduck/wollipog/releases",
  lastCheck: { state: "available", version: VERSION, releaseUrl: RELEASE_URL, checkedAt: 1 },
};

interface Shell {
  desktop: DesktopUpdateRuntime;
  links: CloseGuardLinks;
  /** The `confirmed` argument of every install request. */
  installs: boolean[];
}

/** Unconfirmed installs are held for two sessions; confirmed ones answer from `confirmed`. */
function shell(confirmed: () => Promise<DesktopUpdateOutcome> = () => new Promise(() => undefined)): Shell {
  const links = createCloseGuardLinks();
  links.provide({ session: (id) => SESSIONS[id] ?? null });
  const installs: boolean[] = [];
  return {
    installs,
    links,
    desktop: {
      isTauri: () => true,
      invoke: async <T,>(command: string, args?: Record<string, unknown>): Promise<T> => {
        if (command === "desktop_update_status") return status as T;
        if (command === "check_for_desktop_update") return status.lastCheck as T;
        if (command === "install_desktop_update") {
          installs.push(args?.confirmed === true);
          return (args?.confirmed === true ? confirmed() : Promise.resolve(HELD)) as Promise<T>;
        }
        throw new Error(`unexpected ${command}`);
      },
      listen: async () => () => undefined,
    },
  };
}

const transport: ApiTransport = {
  instanceId: "held-update-fixture",
  publicOrigin: "http://localhost",
  close() {},
  async request() {
    return new Response(JSON.stringify({ service: "wollipog-control-plane", appVersion: "0.28.2" }), {
      status: 200,
      headers: { "content-type": "application/json" },
    });
  },
};

function Settings({ s }: { s: Shell }) {
  const update = useDesktopUpdateSetting(s.desktop, s.links);
  return <ApiProvider client={createApiClient(transport)}><AboutPanel update={update} /></ApiProvider>;
}

async function mount(children: React.ReactNode) {
  const container = domWindow.document.createElement("div") as unknown as HTMLDivElement;
  domWindow.document.body.append(container as never);
  const root = createRoot(container);
  unmounts.push(async () => { await act(async () => root.unmount()); container.remove(); });
  await act(async () => { root.render(<FeedbackProvider>{children}</FeedbackProvider>); });
  await settle();
}

const dialog = () => document.querySelector<HTMLElement>('[role="dialog"]');
const footButtons = () => [...document.querySelectorAll<HTMLButtonElement>(".modal-foot > button")];
const footButton = (label: string) => footButtons().find((candidate) => candidate.textContent === label);
const installButton = (from: "toast" | "settings") => [...document.querySelectorAll<HTMLButtonElement>("button")]
  .find((candidate) => candidate.textContent === "Install and Restart" && (from === "toast") === Boolean(candidate.closest(".toast")));
const rowTitles = () => [...document.querySelectorAll(".confirmation-rows .row-title")].map((row) => row.textContent);

/** Start the install from the named surface, and wait for what the shell answers. */
async function startInstall(from: "toast" | "settings") {
  await until(`the ${from}'s Install and Restart`, () => installButton(from));
  await act(async () => { installButton(from)!.click(); });
  await until("the held-update dialog", dialog);
}

function assertTheHeldUpdateDialog() {
  const shown = dialog();
  assert.ok(shown, "a held install is a dialog");
  assert.equal(document.getElementById(shown.getAttribute("aria-labelledby")!)?.textContent, "Restart to Install Update");
  assert.equal(shown.querySelector(".confirmation-message")?.textContent,
    "Installing Wollipog 0.29.0 restarts the app, which stops 2 sessions that are still working. You can install later from Settings.");
  assert.deepEqual(rowTitles(), ["Fix the invoice rounding bug", "Review the migration plan"]);
  assert.deepEqual(footButtons().map((candidate) => [candidate.textContent, candidate.className]), [
    ["Install Later", "btn"],
    ["Restart Anyway", "btn danger"],
  ]);
  assert.equal(domWindow.document.activeElement, footButton("Install Later") as unknown, "the safe choice has focus");
  assert.equal(document.querySelectorAll(".toast.t-danger").length, 0, "a decision is never an error toast (§13.1)");
}

for (const from of ["toast", "settings"] as const) {
  test(`a held install from the ${from} opens Restart to Install Update, on Install Later`, async () => {
    const s = shell();
    await mount(from === "toast"
      ? <DesktopUpdateNotifier desktop={s.desktop} links={s.links} firstCheckDelayMs={0} recheckIntervalMs={60_000} />
      : <Settings s={s} />);
    await startInstall(from);
    assert.deepEqual(s.installs, [false], "the first request is never a confirmation");
    assertTheHeldUpdateDialog();
  });

  test(`from the ${from}, Restart Anyway sends one confirmed install and stays busy on its label`, async () => {
    const s = shell();
    await mount(from === "toast"
      ? <DesktopUpdateNotifier desktop={s.desktop} links={s.links} firstCheckDelayMs={0} recheckIntervalMs={60_000} />
      : <Settings s={s} />);
    await startInstall(from);
    const restart = footButton("Restart Anyway")!;
    await act(async () => { restart.click(); restart.click(); });
    await settle();
    assert.deepEqual(s.installs, [false, true], "exactly one confirmed install");
    assert.equal(restart.getAttribute("aria-busy"), "true");
    assert.equal(restart.textContent, "Restart Anyway", "the label stays while it runs (#1949)");
    assert.ok(restart.querySelector(".spinner, svg"), "beside a spinner");
    assert.equal(footButton("Install Later")!.disabled, true, "an install cannot be withdrawn once the shell has it");
  });

  test(`from the ${from}, Install Later and Escape send nothing and leave the update on offer`, async () => {
    const s = shell();
    await mount(<>
      {from === "toast" && <DesktopUpdateNotifier desktop={s.desktop} links={s.links} firstCheckDelayMs={0} recheckIntervalMs={60_000} />}
      <Settings s={s} />
    </>);
    await startInstall(from);
    await act(async () => { footButton("Install Later")!.click(); });
    await settle();
    assertNoDomNode(dialog());

    const settingsInstall = () => installButton("settings");
    assert.ok(settingsInstall(), "Settings › About still offers Install and Restart");
    assert.equal(settingsInstall()!.disabled, false);

    await startInstall("settings");
    assert.ok(dialog());
    await act(async () => { domWindow.dispatchEvent(new domWindow.KeyboardEvent("keydown", { key: "Escape" })); });
    await settle();
    assertNoDomNode(dialog());
    assert.equal(s.installs.includes(true), false, "no confirmed install was sent");
    assert.ok(settingsInstall());
  });
}

test("a confirmed install the shell holds again asks again, with what the shell says now", async () => {
  // The shell's warning lasts 30 seconds. A dialog left open longer is held once more.
  const s = shell(async () => ({ outcome: "heldForWork", sessions: 1, sessionIds: ["s_migration"] }));
  await mount(<Settings s={s} />);
  await startInstall("settings");
  await act(async () => { footButton("Restart Anyway")!.click(); });
  await settle();
  assert.ok(dialog());
  assert.equal(dialog()!.querySelector(".confirmation-message")?.textContent,
    "Installing Wollipog 0.29.0 restarts the app, which stops 1 session that is still working. You can install later from Settings.");
  assert.deepEqual(rowTitles(), ["Review the migration plan"]);
  assert.deepEqual(s.installs, [false, true]);
});

test("a confirmed install that fails stays in the dialog, to try again or install later", async () => {
  const s = shell(async () => { throw new Error("The update could not be installed: disk full"); });
  await mount(<Settings s={s} />);
  await startInstall("settings");
  await act(async () => { footButton("Restart Anyway")!.click(); });
  await settle();
  assert.equal(dialog()!.querySelector('[role="alert"]')?.textContent, "The update could not be installed: disk full");
  assert.equal(footButton("Install Later")!.disabled, false);
  await act(async () => { footButton("Install Later")!.click(); });
  await settle();
  assertNoDomNode(dialog());
});

test("the update toast is information with a What's New link and exactly one action", async () => {
  const s = shell();
  await mount(<DesktopUpdateNotifier desktop={s.desktop} links={s.links} firstCheckDelayMs={0} recheckIntervalMs={60_000} />);
  await until("the update toast", () => document.querySelector(".toast"));
  const toast = document.querySelector<HTMLElement>(".toast")!;
  assert.ok(toast.classList.contains("t-info"));
  assert.equal(toast.querySelector(".toast-message")?.textContent, "Wollipog 0.29.0 is ready to install.");
  assert.equal(toast.querySelector(".toast-detail")?.textContent,
    "Restarting takes a few seconds. You can also install it later from Settings.");
  const link = toast.querySelector<HTMLAnchorElement>("a.toast-link")!;
  assert.equal(link.textContent, "What's New");
  assert.equal(link.getAttribute("href"), RELEASE_URL);
  assert.deepEqual([...toast.querySelectorAll("button")].map((candidate) => candidate.textContent || candidate.getAttribute("aria-label")),
    ["Install and Restart", "Dismiss Notification"]);
});

test("the held-update body counts one session, and never invents a count", () => {
  assert.equal(heldUpdateMessage("0.29.0", 1),
    "Installing Wollipog 0.29.0 restarts the app, which stops 1 session that is still working. You can install later from Settings.");
  assert.equal(heldUpdateMessage("0.29.0", 0),
    "Installing Wollipog 0.29.0 restarts the app and stops any turn that is still in progress. You can install later from Settings.");
  assert.equal(heldUpdateMessage(null, 3),
    "Installing the update restarts the app, which stops 3 sessions that are still working. You can install later from Settings.");
});

test("Settings › About no longer draws its own held state", () => {
  const settings = readFileSync(fileURLToPath(new URL("./SettingsView.tsx", import.meta.url)), "utf8");
  assert.doesNotMatch(settings, /Install Anyway/u);
  assert.doesNotMatch(settings, /Not Now/u);
});
