import "./test-dom-events.js";
import assert from "node:assert/strict";
import { after, before, test } from "node:test";
import React, { act } from "react";
import { createRoot } from "react-dom/client";
import { Window } from "happy-dom";
import { PROTOCOL_VERSION } from "@wollipog/protocol";
import { createApiClient } from "../api.js";
import { CONTROL_PLANE_HTTP } from "../config.js";
import { ApiProvider } from "../api-context.js";
import type { ApiTransport } from "../api-transport.js";
import type { DesktopUpdateSetting, DesktopUpdateStatus } from "../desktop-updates.js";
import type { InstanceRuntime } from "../instance-runtime.js";
import { browserInstanceManager, InstancesContextProvider } from "../instances-context.js";
import { checkFailureReason, updateBlockState } from "./AboutSettingsPanel.js";
import { AboutPanel } from "./SettingsView.js";

const domWindow = new Window({ url: "http://localhost/settings/about" });
const previous = new Map<string, unknown>();
const copied: string[] = [];
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
  Object.defineProperty(domWindow.navigator, "clipboard", {
    configurable: true,
    value: { writeText: async (text: string) => { copied.push(text); } },
  });
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
    prereleaseUpdates: false,
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
    savingPrerelease: false,
    failure: null,
    check: () => clicks.push("check"),
    install: () => clicks.push("install"),
    openRelease: () => clicks.push("open"),
    toggleAutomatic: () => clicks.push("automatic"),
    togglePrerelease: () => clicks.push("prerelease"),
    ...overrides,
    clicks,
  };
}

const available = { state: "available" as const, version: "0.28.0", releaseUrl: "https://example.test/v0.28.0", checkedAt: 1 };
const RELEASE_REASON = "This app was installed from a .deb package. Install the new package from the release page.";
const CHECK_FAILURE = "Could not check for updates: error sending request for url (https://github.com)";

/** Every state the issue lists, as the shell's hook reports it. */
const STATES: Record<string, { update: DesktopUpdateSetting; title: string; description: string | null; actions: string[] }> = {
  "not checked": { update: setting(), title: "Not Checked Yet", description: null, actions: ["Check for Updates"] },
  checking: { update: setting({ checking: true }), title: "Not Checked Yet", description: null, actions: ["Check for Updates"] },
  current: {
    update: setting({ status: status({ lastCheck: { state: "current", checkedAt: Date.UTC(2026, 8, 23, 12) } }) }),
    title: "Wollipog 0.27.0 Is Up to Date",
    description: "on the stable channel.",
    actions: ["Check Again"],
  },
  available: {
    update: setting({ status: status({ lastCheck: available }) }),
    title: "Wollipog 0.28.0 Is Available",
    description: "Installing restarts Wollipog.",
    actions: ["Check Again", "Install and Restart"],
  },
  "release page only": {
    update: setting({ status: status({ lastCheck: available, install: { mode: "releasePage", reason: RELEASE_REASON } }) }),
    title: "Wollipog 0.28.0 Is Available",
    description: RELEASE_REASON,
    actions: ["Check Again", "Open Release Page"],
  },
  installing: {
    update: setting({ installing: true, status: status({ lastCheck: available }) }),
    title: "Installing Wollipog 0.28.0",
    description: "Downloading and verifying. Wollipog restarts when it's installed.",
    actions: [],
  },
  off: {
    update: setting({ status: status({ checksAllowed: false }) }),
    title: "Update Checks Are Off",
    description: "This installation turns update checks off.",
    actions: ["Show Details"],
  },
  failed: {
    update: setting({ failure: { action: "check", message: CHECK_FAILURE } }),
    title: "Couldn't Check for Updates",
    description: "Wollipog couldn't reach the release server. Check the connection, then try again.",
    actions: ["Show Details", "Retry"],
  },
};

async function render(update: DesktopUpdateSetting | undefined, api: ApiTransport = transport(instanceResponse)) {
  const container = domWindow.document.createElement("div") as unknown as HTMLDivElement;
  domWindow.document.body.append(container as never);
  const root = createRoot(container);
  await act(async () => {
    root.render(<ApiProvider client={createApiClient(api)}><AboutPanel update={update} /></ApiProvider>);
  });
  await act(async () => { await new Promise((resolve) => setTimeout(resolve, 0)); });
  const block = () => container.querySelector<HTMLElement>(".update-block");
  return {
    container,
    text: () => container.textContent ?? "",
    block,
    blockButtons: () => [...(block()?.querySelectorAll<HTMLButtonElement>("button") ?? [])],
    button: (name: string) => [...container.querySelectorAll<HTMLButtonElement>("button")].find((candidate) => candidate.textContent === name),
    unmount: async () => { await act(async () => root.unmount()); container.remove(); },
  };
}

/** The value-row titles and values, in order. */
function versions(container: HTMLElement): Record<string, string> {
  return Object.fromEntries([...container.querySelectorAll(".setting-row-value")].map((row) => [
    row.querySelector(".setting-row-title")?.textContent ?? "",
    row.querySelector(".setting-row-value-text")?.textContent ?? "",
  ]));
}

/** No visible text names the protocol, the old "Control Plane" or an environment variable (§17.2). */
function assertNoSystemWords(text: string, where: string) {
  assert.doesNotMatch(text, /Protocol/u, `${where}: the protocol number is copied, never shown`);
  assert.doesNotMatch(text, /Control Plane/iu, `${where}: the server is called the server`);
  assert.doesNotMatch(text, /\b[A-Z][A-Z0-9]*_[A-Z0-9_]+\b/u, `${where}: no environment variable name`);
}

test("About opens with Wollipog's name and the desktop app's version, and lists versions as rows", async () => {
  const view = await render(setting());
  const identity = view.container.querySelector(".about-identity")!;
  assert.ok(identity, "the identity header leads the panel");
  assert.equal(view.container.firstElementChild, identity, "it is the panel's first child");
  assert.equal(identity.querySelector("img")?.getAttribute("src"), "/icons/icon-192.png");
  assert.equal(identity.querySelector(".about-identity-name")?.textContent, "Wollipog");
  assert.equal(identity.querySelector(".about-identity-version")?.textContent, "Version 0.27.0");
  assert.deepEqual(versions(view.container), { "Desktop App": "0.27.0", Server: "0.26.0" });
  // A plain browser window has no instance runtime: the server is the API origin the build was configured with.
  assert.ok(view.text().includes(`The Wollipog server at ${CONTROL_PLANE_HTTP}.`));
  assert.equal(view.container.querySelectorAll("dl, dt, dd").length, 0, "no definition list outside the row grid");
  const titles = [...view.container.querySelectorAll(".settings-group-title")].map((node) => node.textContent);
  assert.deepEqual(titles, ["Versions", "Updates"]);
  await view.unmount();
});

test("every update state shows its title, description and actions, and no system words", async () => {
  for (const [name, expected] of Object.entries(STATES)) {
    const view = await render(expected.update);
    assert.equal(view.block()?.querySelector(".update-block-title")?.textContent, expected.title, `${name}: title`);
    const description = view.block()?.querySelector(".update-block-desc")?.textContent ?? null;
    if (expected.description === null) assert.equal(description, null, `${name}: no description`);
    else assert.ok(description?.includes(expected.description), `${name}: description "${description}"`);
    assert.deepEqual(view.blockButtons().map((button) => button.textContent), expected.actions, `${name}: actions in order`);
    // A button never sits inside a sentence: actions live in their own row after the text.
    assert.equal(view.block()?.querySelectorAll(".update-block-text button").length, 0, `${name}: no button inside the text`);
    assertNoSystemWords(view.text(), name);
    await view.unmount();
  }
});

test("checking keeps the button's label and marks it busy", async () => {
  const view = await render(STATES.checking!.update);
  const button = view.button("Check for Updates")!;
  assert.equal(button.getAttribute("aria-busy"), "true");
  assert.equal(button.getAttribute("aria-disabled"), "true");
  await view.unmount();
});

test("the failed state's Retry checks again, and Show Details reveals the shell's whole message", async () => {
  const update = STATES.failed!.update as DesktopUpdateSetting & { clicks: string[] };
  const view = await render(update);
  assert.doesNotMatch(view.text(), /error sending request/u, "the raw failure waits behind Show Details");
  await act(async () => view.button("Show Details")!.click());
  assert.match(view.text(), /error sending request for url/u);
  assert.equal(view.button("Hide Details")!.getAttribute("aria-expanded"), "true");
  await act(async () => view.button("Retry")!.click());
  assert.deepEqual(update.clicks, ["check"]);
  await view.unmount();
});

/** Renders, then lets a test swap the update state the way the shell's hook would. */
async function renderLive(initial: DesktopUpdateSetting) {
  const container = domWindow.document.createElement("div") as unknown as HTMLDivElement;
  domWindow.document.body.append(container as never);
  const root = createRoot(container);
  const client = createApiClient(transport(instanceResponse));
  const show = async (update: DesktopUpdateSetting) => {
    await act(async () => { root.render(<ApiProvider client={client}><AboutPanel update={update} /></ApiProvider>); });
  };
  await show(initial);
  await act(async () => { await new Promise((resolve) => setTimeout(resolve, 0)); });
  return {
    container,
    show,
    alert: () => container.querySelector(".update-block [role='alert']")?.textContent ?? null,
    button: (name: string) => [...container.querySelectorAll<HTMLButtonElement>("button")].find((candidate) => candidate.textContent === name),
    unmount: async () => { await act(async () => root.unmount()); container.remove(); },
  };
}

test("the pressed check button keeps focus while its answer changes the block", async () => {
  const failed = { action: "check" as const, message: CHECK_FAILURE };
  for (const before of [setting(), setting({ status: status({ lastCheck: available }) })]) {
    const view = await renderLive(before);
    const pressed = view.button(before.status?.lastCheck ? "Check Again" : "Check for Updates")!;
    pressed.focus();
    await view.show({ ...before, checking: true });
    assert.equal(domWindow.document.activeElement, pressed as never, "busy keeps the same button");
    await view.show({ ...before, checking: false, failure: failed });
    assert.equal(view.button("Retry"), pressed, "the check button is the same element, now Retry");
    assert.equal(domWindow.document.activeElement, pressed as never, "and keeps focus");
    await view.unmount();
  }
});

test("a pressed button that goes away hands focus to the block, not the page", async () => {
  const view = await renderLive(setting({ status: status({ lastCheck: available }) }));
  const install = view.button("Install and Restart")!;
  install.focus();
  await view.show(setting({ installing: true, status: status({ lastCheck: available }) }));
  assert.equal(install.isConnected, false);
  assert.equal(domWindow.document.activeElement, view.container.querySelector(".update-block-title") as never);
  await view.unmount();
});

test("Retry on a failed install or release page hands focus to the block before its notice goes", async () => {
  for (const action of ["install", "openRelease"] as const) {
    const failed = setting({ status: status({ lastCheck: available }), failure: { action, message: "denied" } });
    const view = await renderLive(failed);
    const retry = view.button("Retry")!;
    retry.focus();
    await act(async () => retry.click());
    assert.deepEqual(failed.clicks, [action === "install" ? "install" : "open"]);
    // The hook clears the failure as the retry starts, which removes the notice and its Retry.
    await view.show(setting({ status: status({ lastCheck: available }), installing: action === "install" }));
    assert.equal(retry.isConnected, false);
    assert.equal(domWindow.document.activeElement, view.container.querySelector(".update-block-title") as never, action);
    await view.unmount();
  }
});

test("Try Again on a failed switch keeps focus on that switch while it saves and once it settles", async () => {
  const titles = { automatic: "Check for Updates Automatically", prerelease: "Pre-Release Updates" };
  for (const [action, saving] of [["automatic", "savingAutomatic"], ["prerelease", "savingPrerelease"]] as const) {
    for (const settled of [setting(), setting({ failure: { action, message: "denied again" } })]) {
      const failed = setting({ failure: { action, message: "denied" } });
      const view = await renderLive(failed);
      const named = () => [...view.container.querySelectorAll<HTMLButtonElement>('[role="switch"]')]
        .find((control) => domWindow.document.getElementById(control.getAttribute("aria-labelledby")!)?.textContent === titles[action]);
      const tryAgain = view.button("Try Again")!;
      tryAgain.focus();
      await act(async () => tryAgain.click());
      assert.deepEqual(failed.clicks, [action], "Try Again repeats the change itself");
      // The hook clears the failure and saves: Try Again goes, and the switch is busy until it lands.
      await view.show(setting({ [saving]: true }));
      assert.equal(tryAgain.isConnected, false);
      assert.equal(named()?.getAttribute("aria-busy"), "true");
      assert.ok(domWindow.document.activeElement === (named() as never), `${action}: the busy switch holds focus, not the page`);
      await view.show(settled);
      assert.ok(domWindow.document.activeElement === (named() as never),
        `${action}: focus stays on the switch after ${settled.failure ? "a second failure" : "the save lands"}`);
      await view.unmount();
    }
  }
});

test("a failed check is announced as it arrives", async () => {
  const view = await renderLive(setting());
  assert.equal(view.alert(), "", "the alert region is there before anything fails");
  await view.show(setting({ failure: { action: "check", message: CHECK_FAILURE } }));
  assert.equal(view.alert(), "Couldn't check for updates. Wollipog couldn't reach the release server. Check the connection, then try again.");
  await view.show(setting({ status: status({ lastCheck: { state: "current", checkedAt: 2 } }) }));
  assert.equal(view.alert(), "", "and cleared when a check succeeds");
  await view.unmount();
});

test("a retry that fails with the same words is announced again", async () => {
  const failure = { action: "check" as const, message: CHECK_FAILURE };
  const view = await renderLive(setting({ failure }));
  const said = view.alert();
  assert.ok(said);
  // The hook keeps the failure up while Retry runs; the alert empties so the next one is a change.
  await view.show(setting({ failure, checking: true }));
  assert.equal(view.alert(), "");
  await view.show(setting({ failure }));
  assert.equal(view.alert(), said);
  await view.unmount();
});

test("details opened for one failure start collapsed for the next", async () => {
  const failure = { action: "check" as const, message: CHECK_FAILURE };
  const view = await renderLive(setting({ failure }));
  await act(async () => view.button("Show Details")!.click());
  assert.ok(view.container.querySelector(".update-block-details"));
  // A success in between, then the same failure again.
  await view.show(setting({ status: status({ lastCheck: { state: "current", checkedAt: 2 } }) }));
  await view.show(setting({ failure }));
  assert.equal(view.container.querySelectorAll(".update-block-details").length, 0, "collapsed after a success");
  assert.ok(view.button("Show Details"));
  // And a different failure replacing an open one.
  await act(async () => view.button("Show Details")!.click());
  await view.show(setting({ failure: { action: "check", message: "The update check timed out. Try again later." } }));
  assert.equal(view.container.querySelectorAll(".update-block-details").length, 0, "collapsed for a new failure");
  await view.unmount();
});

test("turned-off checks keep the environment variable behind Show Details", async () => {
  const view = await render(STATES.off!.update);
  assert.equal(view.button("Check for Updates"), undefined);
  const automatic = view.container.querySelector<HTMLButtonElement>('[role="switch"]')!;
  assert.equal(automatic.disabled, true);
  assert.equal(automatic.getAttribute("aria-checked"), "false");
  await act(async () => view.button("Show Details")!.click());
  assert.match(view.text(), /WOLLIPOG_DISABLE_UPDATE_CHECK/u, "the reason is one click away");
  await view.unmount();
});

test("an available release puts the primary Install and Restart last, or points at its page", async () => {
  let update = setting({ status: status({ lastCheck: available }) });
  let view = await render(update);
  const last = view.blockButtons().at(-1)!;
  assert.equal(last.textContent, "Install and Restart");
  assert.ok(last.classList.contains("primary"), "the one primary");
  assert.equal(view.block()!.querySelectorAll(".btn.primary").length, 1);
  assert.ok(view.button("Check Again")!.classList.contains("ghost"));
  await act(async () => last.click());
  assert.deepEqual(update.clicks, ["install"]);
  assert.equal(view.button("Open Release Page"), undefined);
  await view.unmount();

  update = setting({ status: status({ lastCheck: available, install: { mode: "releasePage", reason: RELEASE_REASON } }) });
  view = await render(update);
  assert.equal(view.button("Install and Restart"), undefined, "a package-manager install is never replaced in place");
  const open = view.blockButtons().at(-1)!;
  assert.equal(open.textContent, "Open Release Page");
  assert.ok(open.querySelector("svg"), "with an external-link icon");
  await act(async () => open.click());
  assert.deepEqual(update.clicks, ["open"]);
  await view.unmount();
});

test("the current state names the channel the build follows", async () => {
  const view = await render(setting({
    status: status({ prereleaseUpdates: true, lastCheck: { state: "current", checkedAt: Date.UTC(2026, 8, 23, 12) } }),
  }));
  assert.match(view.block()!.textContent ?? "", /on the pre-release channel\./u);
  await view.unmount();
});

test("Copy Version Info copies both versions, the protocol number and the server address", async () => {
  copied.length = 0;
  const view = await render(setting());
  await act(async () => view.button("Copy Version Info")!.click());
  assert.equal(copied.length, 1);
  const text = copied[0]!;
  assert.match(text, /0\.27\.0/u, "the app version");
  assert.match(text, /0\.26\.0/u, "the server version");
  assert.match(text, new RegExp(`Protocol: ${PROTOCOL_VERSION}\\b`, "u"), "the protocol number");
  assert.ok(text.includes(`Server Address: ${CONTROL_PLANE_HTTP}`), "the server address");
  // It confirms with its icon, in place.
  const button = view.container.querySelector(".settings-group-action .btn")!;
  assert.ok(button.classList.contains("copy-status-copied"));
  await view.unmount();
});

test("the server address is the API origin this window's requests go to, not the dashboard's", async () => {
  // A split deployment: the dashboard at one origin, the server it talks to at another.
  const manager = {
    ...browserInstanceManager,
    activeProfile: { ...browserInstanceManager.activeProfile, origin: "http://dashboard.test:5173" },
    runtime: { instanceId: "local", publicOrigin: "http://api.test:4317" } as InstanceRuntime,
  };
  copied.length = 0;
  const container = domWindow.document.createElement("div") as unknown as HTMLDivElement;
  domWindow.document.body.append(container as never);
  const root = createRoot(container);
  await act(async () => {
    root.render(
      <InstancesContextProvider value={manager}>
        <ApiProvider client={createApiClient(transport(instanceResponse))}><AboutPanel update={setting()} /></ApiProvider>
      </InstancesContextProvider>,
    );
  });
  await act(async () => { await new Promise((resolve) => setTimeout(resolve, 0)); });
  assert.match(container.textContent ?? "", /The Wollipog server at http:\/\/api\.test:4317\./u);
  assert.doesNotMatch(container.textContent ?? "", /dashboard\.test/u);
  const copy = [...container.querySelectorAll<HTMLButtonElement>("button")].find((button) => button.textContent === "Copy Version Info")!;
  await act(async () => copy.click());
  assert.match(copied[0] ?? "", /Server Address: http:\/\/api\.test:4317$/mu);
  await act(async () => root.unmount());
  container.remove();
});

test("a failed install, release page or switch shows where it happened, with a way to try again", async () => {
  let update = setting({ status: status({ lastCheck: available }), failure: { action: "install", message: "The update install task failed: disk full" } });
  let view = await render(update);
  assert.match(view.text(), /Couldn't install the update\./u);
  await act(async () => view.button("Retry")!.click());
  assert.deepEqual(update.clicks, ["install"]);
  assert.equal(view.block()?.querySelector(".update-block-title")?.textContent, "Wollipog 0.28.0 Is Available",
    "the block still offers the update");
  await view.unmount();

  update = setting({ failure: { action: "automatic", message: "Saving the update setting failed: denied" } });
  view = await render(update);
  assert.match(view.text(), /Couldn't change automatic checks\./u);
  await act(async () => view.button("Try Again")!.click());
  assert.deepEqual(update.clicks, ["automatic"]);
  assert.equal(view.block()?.querySelector(".update-block-title")?.textContent, "Not Checked Yet");
  await view.unmount();
});

test("in a browser About has the foot line, no Updates group and no placeholder rows", async () => {
  const view = await render(undefined, transport(() => new Response("{}", { status: 404 })));
  assert.deepEqual(versions(view.container), { Server: "Not reported" });
  assert.equal(view.container.querySelector(".about-identity-version")?.textContent, "Version not reported");
  assert.match(view.text(), /This window updates when its Wollipog server is upgraded\./u);
  // Versions keeps its title and its Copy Version Info head action, as in the desktop app.
  assert.deepEqual([...view.container.querySelectorAll(".settings-group-title")].map((node) => node.textContent), ["Versions"]);
  assert.ok(view.container.querySelector(".settings-group-action")?.textContent?.includes("Copy Version Info"));
  assert.equal(view.container.querySelectorAll(".update-block").length, 0, "no Updates block");
  assert.doesNotMatch(view.text(), /Updates|Open-Source Licenses|THIRD-PARTY/u);
  assert.equal(view.button("Check for Updates"), undefined);
  assertNoSystemWords(view.text(), "browser");
  await view.unmount();

  const browser = await render(setting({ desktop: false, status: null }));
  assert.equal(browser.container.querySelector(".about-identity-version")?.textContent, "Version 0.26.0",
    "a browser names the server's version");
  assert.equal(browser.container.querySelectorAll(".update-block").length, 0, "no Updates block");
  await browser.unmount();
});

test("a desktop app whose status cannot be read says so in the block", async () => {
  const update = setting({ status: null, failure: { action: "read", message: "desktop_update_status failed: no answer" } });
  assert.equal(updateBlockState(update), "unreadable");
  const view = await render(update);
  assert.equal(view.block()?.querySelector(".update-block-title")?.textContent, "Couldn't Read the Update Status");
  assert.equal(versions(view.container)["Desktop App"], "Not reported");
  await view.unmount();
});

test("prerelease updates require an explicit switch and describe returning to stable", async () => {
  const update = setting();
  const view = await render(update);
  const toggle = [...view.container.querySelectorAll<HTMLButtonElement>('[role="switch"]')]
    .find((candidate) => candidate.textContent?.includes("Pre-Release Updates"))!;
  assert.ok(toggle);
  assert.equal(toggle.getAttribute("aria-checked"), "false");
  assert.match(view.text(), /does not downgrade Wollipog/u);
  await act(async () => toggle.click());
  assert.deepEqual(update.clicks, ["prerelease"]);
  await view.unmount();
  const oldShell = await render(setting({ status: status({ prereleaseUpdates: undefined }) }));
  assert.doesNotMatch(oldShell.text(), /Pre-Release Updates/u);
  await oldShell.unmount();
});

/** Every message the shell's update check can fail with (apps/desktop/src-tauri/src/updates.rs). */
const SHELL_CHECK_FAILURES: ReadonlyArray<[message: string, reason: RegExp]> = [
  ["Could not reach GitHub to discover releases.", /couldn't reach the release server/u],
  ["Could not check for updates: error sending request for url (https://github.com/picoduck/wollipog/releases/latest/download/latest.json)", /couldn't reach the release server/u],
  ["The update check timed out. Try again later.", /took too long to answer/u],
  ["Could not discover releases: GitHub returned HTTP 403.", /limiting requests/u],
  ["Could not discover releases: GitHub returned HTTP 429.", /limiting requests/u],
  ["Could not discover releases: GitHub returned HTTP 502.", /couldn't answer right now/u],
  ["Could not read GitHub releases.", /answer couldn't be used/u],
  ["GitHub release discovery exceeded the response size limit.", /answer couldn't be used/u],
  ["GitHub returned invalid release metadata.", /answer couldn't be used/u],
  ["GitHub release discovery exceeded the page limit.", /answer couldn't be used/u],
  ["The update manifest version does not match its release tag.", /answer couldn't be used/u],
  ["Could not prepare release discovery.", /couldn't set up the check/u],
  ["Could not prepare the update check: bad config", /couldn't set up the check/u],
  ["something the shell has never said", /couldn't finish the check/u],
];

test("a failed check names its cause in one sentence, never the title again", () => {
  for (const [message, reason] of SHELL_CHECK_FAILURES) {
    const sentence = checkFailureReason(message);
    assert.match(sentence, reason, message);
    // The title says the check failed; the sentence says why and what to do.
    assert.doesNotMatch(sentence, /check(?:ing)? for updates|could not/iu, `${message}: restates the title`);
    assert.notEqual(sentence, message, "the shell's words stay behind Show Details");
    assert.match(sentence, /^[A-Z][^.]*\.(?: [A-Z][^.]*\.)?$/u, `${message}: at most two short sentences`);
  }
});
