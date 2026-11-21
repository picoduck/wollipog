import assert from "node:assert/strict";
import { test } from "node:test";
import React, { act } from "react";
import { createRoot } from "react-dom/client";
import { Window } from "happy-dom";
import { ANTIGRAVITY_AGENT_ID, PROTOCOL_VERSION, RUNNER_CAPABILITY_MIN_PROTOCOL, type AgentDefinition, type AntigravitySetupView, type RunnerView } from "@wollipog/protocol";
import { api, type ApiClient } from "../api.js";
import { ApiProvider } from "../api-context.js";
import { assertNoDomNode } from "../dom-test-assertions.js";
import { installDomTestCleanup } from "../dom-test-cleanup.js";
import { FeedbackProvider } from "./FeedbackProvider.js";
import { fireDomEvent } from "./test-dom-events.js";
import { MachineAgentsSection } from "./MachineAgentsSection.js";

/** Google Antigravity setup in a machine's Agents section (#4780). */

const domWindow = new Window({ url: "http://localhost/", width: 1440, height: 900 });
installDomTestCleanup(domWindow);
for (const [name, value] of Object.entries({
  window: domWindow,
  document: domWindow.document,
  navigator: domWindow.navigator,
  localStorage: domWindow.localStorage,
  HTMLElement: domWindow.HTMLElement,
  HTMLButtonElement: domWindow.HTMLButtonElement,
  HTMLInputElement: domWindow.HTMLInputElement,
  HTMLFormElement: domWindow.HTMLFormElement,
  Node: domWindow.Node,
  Event: domWindow.Event,
  MouseEvent: domWindow.MouseEvent,
  KeyboardEvent: domWindow.KeyboardEvent,
  FocusEvent: domWindow.FocusEvent,
  MutationObserver: domWindow.MutationObserver,
  requestAnimationFrame: domWindow.requestAnimationFrame.bind(domWindow),
  cancelAnimationFrame: domWindow.cancelAnimationFrame.bind(domWindow),
  getComputedStyle: domWindow.getComputedStyle.bind(domWindow),
  React,
  IS_REACT_ACT_ENVIRONMENT: true,
  ResizeObserver: class { observe() {} unobserve() {} disconnect() {} },
})) Object.defineProperty(globalThis, name, { configurable: true, writable: true, value });

const NOW = Date.now();
const executable = { path: "/home/fixture/.local/bin/agy", version: "1.4.2" };
const setup = (overrides: Partial<AntigravitySetupView>): AntigravitySetupView => ({
  version: 1, status: "sign_in_required", checkedAt: NOW, executable, credentialStore: "shared_os_keyring", ...overrides,
});

function runner(antigravitySetup: AntigravitySetupView | undefined, overrides: Partial<RunnerView> = {}): RunnerView {
  return {
    runnerId: "studio", displayName: "Studio Mac", hostname: "studio.local", os: "linux", version: "1", status: "online",
    agents: [], workspaces: [], connectedAt: 1, lastSeen: 1, protocolVersion: PROTOCOL_VERSION, agentsRefreshed: true,
    canManage: true, ...(antigravitySetup ? { antigravitySetup } : {}), ...overrides,
  };
}

async function mount(view: RunnerView, client: Partial<ApiClient> = {}, antigravitySetup = true) {
  const mountPoint = domWindow.document.createElement("div");
  domWindow.document.body.appendChild(mountPoint);
  const root = createRoot(mountPoint as unknown as HTMLElement);
  await act(async () => {
    root.render(
      <ApiProvider client={{ ...api, ...client } as ApiClient}>
        <FeedbackProvider>
          <MachineAgentsSection runner={view} online={view.status === "online"} machineName="Studio Mac" canFindSessions
            antigravitySetup={antigravitySetup} />
        </FeedbackProvider>
      </ApiProvider>,
    );
  });
  const body = domWindow.document.body as unknown as HTMLElement;
  return { body, unmount: async () => { await act(async () => root.unmount()); mountPoint.remove(); } };
}

const row = (body: HTMLElement) => body.querySelector<HTMLButtonElement>('ul[aria-label="Agent Setup"] button.row');
const dialog = (body: HTMLElement) => body.querySelector<HTMLElement>('[role="dialog"]');
const buttonNamed = (scope: Element, name: string) =>
  [...scope.querySelectorAll<HTMLButtonElement>("button")].find((button) => button.textContent?.trim() === name) ?? null;

async function openSetup(body: HTMLElement): Promise<HTMLElement> {
  await act(async () => row(body)!.click());
  const opened = dialog(body);
  assert.ok(opened, "the setup dialog opens");
  return opened!;
}

test("only people who may manage the machine see the setup row, and it says Antigravity is not in New Session yet", async () => {
  const hidden = await mount(runner(setup({}), { canManage: false }));
  try { assertNoDomNode(row(hidden.body), "setup row"); } finally { await hidden.unmount(); }
  // Account Setup reuses the Agents section for provider accounts and leaves setup out.
  const accountSetup = await mount(runner(setup({})), {}, false);
  try { assertNoDomNode(row(accountSetup.body), "setup row in Account Setup"); } finally { await accountSetup.unmount(); }
  const shown = await mount(runner(setup({})));
  try {
    const setupRow = row(shown.body)!;
    assert.equal(setupRow.querySelector(".row-title")?.textContent, "Google Antigravity");
    assert.equal(setupRow.querySelector(".status")?.textContent, "Sign-In Required");
    assert.match(setupRow.querySelector(".row-sub")?.textContent ?? "", /^Not in New Session/u);
    const opened = await openSetup(shown.body);
    assert.match(opened.textContent ?? "", /SessionsAvailable in New Session once setup is ready\./u);
  } finally { await shown.unmount(); }
});

test("a ready setup says whether its runner offers Antigravity in New Session, and the agent is not listed twice", async () => {
  const antigravity: AgentDefinition = { id: ANTIGRAVITY_AGENT_ID, name: "Google Antigravity", command: executable.path, args: ["acp"],
    env: {}, driver: "acp", source: "discovered", available: true, authStatus: "authenticated" };
  const ready = setup({ status: "ready", models: [{ id: "fixture-pro", name: "Fixture Pro" }] });
  const offered = await mount(runner(ready, { agents: [antigravity] }));
  try {
    assert.match(row(offered.body)!.querySelector(".row-sub")?.textContent ?? "", /^Available in New Session/u);
    const agentRows = [...offered.body.querySelectorAll('ul[aria-label="Agents"] .row-title')].map((title) => title.textContent);
    assert.equal(agentRows.includes("Google Antigravity"), false, "the setup row stands for the agent");
    assert.equal(offered.body.textContent?.includes("No Agents Ready"), false, "it still counts as a ready agent");
    assert.match((await openSetup(offered.body)).textContent ?? "", /SessionsAvailable in New Session\./u);
  } finally { await offered.unmount(); }

  // A runner from before Antigravity sessions reports a ready setup but no agent.
  const older = await mount(runner(ready));
  try {
    assert.match(row(older.body)!.querySelector(".row-sub")?.textContent ?? "", /^Setup Only/u);
    assert.match((await openSetup(older.body)).textContent ?? "", /Update Wollipog on Studio Mac to start Antigravity sessions\./u);
  } finally { await older.unmount(); }

  // An operator-configured agent that uses the id is its own agent, listed beside the setup row, and
  // says nothing about the setup's sessions whether it is available or not.
  for (const available of [true, false]) {
    const configured = await mount(runner(ready, { agents: [{ ...antigravity, source: "config", name: "Operator Wrapper", available }] }));
    try {
      const agentRows = [...configured.body.querySelectorAll('ul[aria-label="Agents"] .row-title')].map((title) => title.textContent);
      assert.ok(agentRows.includes("Operator Wrapper"));
      assert.match(row(configured.body)!.querySelector(".row-sub")?.textContent ?? "", /^Setup Only/u);
      const opened = (await openSetup(configured.body)).textContent ?? "";
      assert.doesNotMatch(opened, /Available in New Session\.|network access|Update Wollipog/u);
      assert.match(opened, /A configured agent on Studio Mac already uses the Google Antigravity agent id/u);
    } finally { await configured.unmount(); }
  }

  // Without the setup row (Account Setup), the advertised agent is listed like any other.
  const accountSetup = await mount(runner(ready, { agents: [antigravity] }), {}, false);
  try {
    const agentRows = [...accountSetup.body.querySelectorAll('ul[aria-label="Agents"] .row-title')].map((title) => title.textContent);
    assert.ok(agentRows.includes("Google Antigravity"));
  } finally { await accountSetup.unmount(); }
});

test("a missing runtime without managed install support shows Google's install command and never offers to install it", async () => {
  let checks = 0;
  const view = await mount(runner(setup({ status: "missing_runtime", executable: undefined })),
    { checkAntigravitySetup: async () => { checks += 1; return {}; } });
  try {
    assert.equal(row(view.body)!.querySelector(".status")?.textContent, "Not Installed");
    const opened = await openSetup(view.body);
    assert.match(opened.textContent ?? "", /curl -fsSL https:\/\/antigravity\.google\/cli\/install\.sh \| bash/u);
    assert.match(opened.textContent ?? "", /Wollipog doesn’t install it for you|Wollipog doesn't install it for you/u);
    assertNoDomNode(buttonNamed(opened, "Install"), "an install button");
    assertNoDomNode(buttonNamed(opened, "Sign In with Google"), "a sign-in button");
    await act(async () => buttonNamed(opened, "Check Again")!.click());
    assert.equal(checks, 1);
  } finally { await view.unmount(); }
});

test("an older runner and an unsupported platform show terminal setup guidance without actions", async () => {
  for (const [view, badge, title] of [
    [runner(undefined, { protocolVersion: RUNNER_CAPABILITY_MIN_PROTOCOL.antigravitySetup - 1 }), "Update Runner", "Update This Runner"],
    [runner(setup({ status: "unsupported", failure: "unsupported_platform", executable: undefined }), { os: "windows" }), "Not Available", "Not Available on This Machine"],
  ] as const) {
    const mounted = await mount(view);
    try {
      assert.equal(row(mounted.body)!.querySelector(".status")?.textContent, badge);
      const opened = await openSetup(mounted.body);
      assert.match(opened.textContent ?? "", new RegExp(title, "u"));
      assert.match(opened.textContent ?? "", /agy acp --login/u);
      assertNoDomNode(buttonNamed(opened, "Check Again"), "Check Again");
      assertNoDomNode(buttonNamed(opened, "Sign In with Google"), "Sign In with Google");
    } finally { await mounted.unmount(); }
  }
});

test("a Windows runner gets Google's PowerShell command and never the bash one", async () => {
  for (const view of [
    runner(setup({ status: "unsupported", failure: "unsupported_platform", executable: undefined }), { os: "windows" }),
    runner(undefined, { os: "windows", protocolVersion: RUNNER_CAPABILITY_MIN_PROTOCOL.antigravitySetup - 1 }),
  ]) {
    const mounted = await mount(view);
    try {
      const opened = await openSetup(mounted.body);
      const text = opened.textContent ?? "";
      assert.doesNotMatch(text, /install\.sh|\| bash|terminal/u);
      assert.match(text, /irm https:\/\/antigravity\.google\/cli\/install\.ps1 \| iex/u);
      assert.match(text, /from PowerShell on this machine/u);
    } finally { await mounted.unmount(); }
  }
  // A Linux runner on an older protocol still gets the shell script.
  const linux = await mount(runner(undefined, { os: "linux", protocolVersion: RUNNER_CAPABILITY_MIN_PROTOCOL.antigravitySetup - 1 }));
  try {
    const opened = await openSetup(linux.body);
    assert.match(opened.textContent ?? "", /install\.sh \| bash/u);
    assert.doesNotMatch(opened.textContent ?? "", /install\.ps1/u);
  } finally { await linux.unmount(); }
});

test("a failed check names the executable it checked", async () => {
  const path = `/home/fixture/${"releases".repeat(25)}/bin/agy`;
  const view = await mount(runner(setup({ status: "verification_failed", failure: "session_check_failed", executable: { path } })));
  try {
    const opened = await openSetup(view.body);
    const notice = [...opened.querySelectorAll(".notice")].find((node) => node.textContent?.includes("Check Failed"));
    assert.ok(notice?.textContent?.includes(`Checked executable: ${path}`));
  } finally { await view.unmount(); }
});

test("sign-in required starts Google's remote sign-in", async () => {
  let started = 0;
  const view = await mount(runner(setup({})), { startAntigravitySignIn: async () => { started += 1; return {}; } });
  try {
    const opened = await openSetup(view.body);
    assert.match(opened.textContent ?? "", /Sign-In Required/u);
    assert.match(opened.textContent ?? "", /system keyring/u);
    assert.match(opened.textContent ?? "", /Available in New Session once setup is ready/u);
    await act(async () => buttonNamed(opened, "Sign In with Google")!.click());
    assert.equal(started, 1);
  } finally { await view.unmount(); }
});

test("a pending sign-in links to Google, submits the pasted code once, and offers Cancel", async () => {
  const operationId = "agy_login_fixture-1";
  const submitted: Array<[string, string]> = [];
  let cancelled = 0;
  const view = await mount(runner(setup({ signIn: {
    operationId, status: "awaiting_code", startedAt: NOW,
    verificationUrl: "https://accounts.google.com/o/oauth2/v2/auth?state=fixture",
  } })), {
    submitAntigravitySignInCode: async (_runnerId, id, code) => { submitted.push([id, code]); return {}; },
    cancelAntigravitySignIn: async () => { cancelled += 1; return {}; },
  });
  try {
    assert.equal(row(view.body)!.querySelector(".status")?.textContent, "Signing In");
    const opened = await openSetup(view.body);
    const link = [...opened.querySelectorAll<HTMLAnchorElement>("a")].find((anchor) => anchor.textContent?.includes("Open Google Sign-In"));
    assert.equal(link?.getAttribute("href"), "https://accounts.google.com/o/oauth2/v2/auth?state=fixture");
    assert.equal(link?.getAttribute("target"), "_blank");
    const input = opened.querySelector<HTMLInputElement>("input")!;
    assert.equal(input.type, "password");
    assert.equal(input.getAttribute("autocomplete"), "off");
    assert.equal(buttonNamed(opened, "Submit Code")?.disabled, true, "nothing to submit yet");
    await act(async () => fireDomEvent.change(input, { target: { value: "FIXTURE-CODE" } }));
    assert.equal(input.getAttribute("value"), null);
    assert.ok(!opened.outerHTML.includes("FIXTURE-CODE"), "the code is never written into the DOM");
    await act(async () => fireDomEvent.submit(opened.querySelector("form")!));
    assert.deepEqual(submitted, [[operationId, "FIXTURE-CODE"]]);
    assert.equal(input.value, "");
    await act(async () => buttonNamed(opened, "Cancel")!.click());
    assert.equal(cancelled, 1);
  } finally { await view.unmount(); }
});

test("a submitted code leaves the field at once, stays out of it while the request runs and after it fails", async () => {
  const sent: string[] = [];
  let reject!: (error: Error) => void;
  const view = await mount(runner(setup({ signIn: {
    operationId: "agy_login_fixture-2", status: "awaiting_code", startedAt: NOW,
    verificationUrl: "https://accounts.google.com/o/oauth2/v2/auth?state=fixture",
  } })), {
    submitAntigravitySignInCode: (_runnerId, _id, code) => {
      sent.push(code);
      return new Promise((_resolve, fail) => { reject = fail; });
    },
  });
  try {
    const opened = await openSetup(view.body);
    const input = opened.querySelector<HTMLInputElement>("input")!;
    await act(async () => fireDomEvent.change(input, { target: { value: "FIXTURE-HELD-CODE" } }));
    await act(async () => fireDomEvent.submit(opened.querySelector("form")!));
    assert.deepEqual(sent, ["FIXTURE-HELD-CODE"]);
    assert.equal(input.value, "", "the code is not in the live value while the request runs");
    await act(async () => reject(new Error("The sign-in is no longer waiting for an authorization code.")));
    assert.equal(input.value, "", "nor after it fails");
    assert.ok(!opened.outerHTML.includes("FIXTURE-HELD-CODE"));
    assert.match(opened.textContent ?? "", /Paste the code again\./u);
    assert.deepEqual(sent, ["FIXTURE-HELD-CODE"], "sent exactly once");
  } finally { await view.unmount(); }
});

test("a failed or expired sign-in never reads as success and offers Try Again", async () => {
  for (const [signIn, title] of [
    [{ operationId: "agy_login_x", status: "failed", startedAt: NOW, failure: "not_completed" }, "Sign-In Failed"],
    [{ operationId: "agy_login_x", status: "failed", startedAt: NOW, failure: "not_verified" }, "Sign-In Not Confirmed"],
    [{ operationId: "agy_login_x", status: "timed_out", startedAt: NOW }, "Sign-In Expired"],
  ] as const) {
    const view = await mount(runner(setup({ signIn })));
    try {
      assert.equal(row(view.body)!.querySelector(".status")?.textContent, "Sign-In Required");
      const opened = await openSetup(view.body);
      assert.match(opened.textContent ?? "", new RegExp(title, "u"));
      assert.ok(buttonNamed(opened, "Try Again"));
      assert.doesNotMatch(opened.textContent ?? "", /Signed In|Ready/u);
    } finally { await view.unmount(); }
  }
});

test("verification failure and ready read differently, and ready lists the account's models", async () => {
  const failed = await mount(runner(setup({ status: "verification_failed", failure: "handshake_failed" })));
  try {
    assert.equal(row(failed.body)!.querySelector(".status")?.textContent, "Check Failed");
    const opened = await openSetup(failed.body);
    assert.match(opened.textContent ?? "", /ACP server didn’t start|ACP server didn't start/u);
    assert.ok(buttonNamed(opened, "Check Again"));
  } finally { await failed.unmount(); }
  const ready = await mount(runner(setup({ status: "ready", models: [{ id: "a", name: "Fixture Pro" }, { id: "b", name: "Fixture Flash" }] })));
  try {
    const badge = row(ready.body)!.querySelector(".status")!;
    assert.equal(badge.textContent, "Ready");
    assert.ok(badge.classList.contains("inline"));
    const opened = await openSetup(ready.body);
    assert.match(opened.textContent ?? "", /Fixture Pro, Fixture Flash/u);
  } finally { await ready.unmount(); }
});

test("an offline machine keeps its last report but disables every action", async () => {
  const view = await mount(runner(setup({}), { status: "offline" }));
  try {
    const opened = await openSetup(view.body);
    assert.equal(buttonNamed(opened, "Sign In with Google")?.disabled, true);
    assert.equal(buttonNamed(opened, "Check Again")?.disabled, true);
  } finally { await view.unmount(); }
});

// Managed install (protocol v404).
const managedPath = "/srv/wollipog/antigravity-managed/current/agy";
const managedRelease = (version: string) => ({
  version, activatedAt: NOW, installerSha256: "0".repeat(64),
  manifestUrl: "https://fixture-updater.us-central1.run.app/manifests/linux_amd64.json",
  archiveUrl: `https://storage.googleapis.com/antigravity-public/${version}/cli.tar.gz`,
  archiveSha512: "0".repeat(128),
});
const managedReady = (managedInstall: Partial<NonNullable<AntigravitySetupView["managedInstall"]>>) => setup({
  status: "ready", models: [{ id: "a", name: "Fixture Pro" }],
  executable: { path: managedPath, version: "1.5.14", source: "managed" },
  managedInstall: { available: true, active: managedRelease("1.5.14"), pathExecutable: executable.path, ...managedInstall },
});
const failedOperation = (kind: "install" | "update", failure: "checksum_mismatch" | "validation_failed" | "access_check_failed" | "rollback_failed", targetVersion: string) => ({
  operationId: "agy_install_1", kind, status: "failed" as const, startedAt: NOW, finishedAt: NOW, failure, targetVersion,
});

test("a missing runtime offers the managed install beside Google's command, and Install starts it", async () => {
  let installs = 0;
  const view = await mount(runner(setup({ status: "missing_runtime", executable: undefined, managedInstall: { available: true } })),
    { installAntigravity: async () => { installs += 1; return {}; } });
  try {
    const opened = await openSetup(view.body);
    const text = opened.textContent ?? "";
    assert.match(text, /Wollipog can install Google.s latest release in its own folder/u);
    assert.doesNotMatch(text, /doesn.t install it for you/u);
    assert.match(text, /curl -fsSL https:\/\/antigravity\.google\/cli\/install\.sh \| bash/u);
    await act(async () => buttonNamed(opened, "Install Google Antigravity")!.click());
    assert.equal(installs, 1);
  } finally { await view.unmount(); }

  // A v403 runner, or a platform without a Google release, keeps the guidance only.
  for (const [report, overrides] of [
    [setup({ status: "missing_runtime", executable: undefined, managedInstall: { available: true } }),
      { protocolVersion: RUNNER_CAPABILITY_MIN_PROTOCOL.antigravityManagedInstall - 1 }],
    [setup({ status: "missing_runtime", executable: undefined, managedInstall: { available: false } }), {}],
  ] as const) {
    const guidance = await mount(runner(report, overrides));
    try {
      const opened = await openSetup(guidance.body);
      assertNoDomNode(buttonNamed(opened, "Install Google Antigravity"), "an install button");
      assert.match(opened.textContent ?? "", /doesn.t install it for you/u);
    } finally { await guidance.unmount(); }
  }
});

test("a running install or update shows its stage and offers no second install", async () => {
  const installing = await mount(runner(setup({ status: "missing_runtime", executable: undefined, managedInstall: { available: true,
    operation: { operationId: "agy_install_1", kind: "install", status: "running", stage: "downloading", startedAt: NOW, targetVersion: "1.5.14" } } })));
  try {
    assert.equal(row(installing.body)!.querySelector(".status")?.textContent, "Installing");
    const opened = await openSetup(installing.body);
    assert.match(opened.textContent ?? "", /Installing Google Antigravity/u);
    assert.match(opened.textContent ?? "", /Downloading Google.s release/u);
    assert.match(opened.textContent ?? "", /Version v1\.5\.14/u);
    assertNoDomNode(buttonNamed(opened, "Install Google Antigravity"), "a second install");
  } finally { await installing.unmount(); }
  const updating = await mount(runner(managedReady({ latest: { version: "1.6.0", checkedAt: NOW },
    operation: { operationId: "agy_install_1", kind: "update", status: "running", stage: "validating", startedAt: NOW, targetVersion: "1.6.0" } })));
  try {
    assert.equal(row(updating.body)!.querySelector(".status")?.textContent, "Updating");
    const opened = await openSetup(updating.body);
    assert.match(opened.textContent ?? "", /v1\.5\.14 stays active until the new version passes its checks/u);
    assertNoDomNode(buttonNamed(opened, "Update to v1.6.0"), "an update button while updating");
  } finally { await updating.unmount(); }
});

test("a failed install says nothing was installed and offers Try Again with the terminal fallback", async () => {
  let installs = 0;
  const view = await mount(runner(setup({ status: "missing_runtime", executable: undefined,
    managedInstall: { available: true, operation: failedOperation("install", "checksum_mismatch", "1.5.14") } })),
  { installAntigravity: async () => { installs += 1; return {}; } });
  try {
    const opened = await openSetup(view.body);
    const notice = opened.querySelector('[role="alert"]')!;
    assert.match(notice.textContent ?? "", /Install Failed/u);
    assert.match(notice.textContent ?? "", /didn.t match the checksum Google published.*Nothing was installed/u);
    assert.match(notice.textContent ?? "", /install\.sh/u);
    await act(async () => buttonNamed(opened, "Try Again")!.click());
    assert.equal(installs, 1);
  } finally { await view.unmount(); }
});

test("a failed update shows the last working version kept, with the managed copy and its fallback", async () => {
  const view = await mount(runner(managedReady({ latest: { version: "1.6.0", checkedAt: NOW },
    operation: failedOperation("update", "validation_failed", "1.6.0") })));
  try {
    assert.match(row(view.body)!.querySelector(".row-sub")?.textContent ?? "", /v1\.5\.14.*Managed/u);
    const opened = await openSetup(view.body);
    const text = opened.textContent ?? "";
    assert.match(text, /Signed In/u);
    assert.match(text, /Update Failed/u);
    assert.match(text, /Wollipog kept v1\.5\.14, the last working version, instead of v1\.6\.0/u);
    assert.ok(buttonNamed(opened, "Try Again"));
    // The failed notice replaces the update offer for the same release.
    assertNoDomNode(buttonNamed(opened, "Update to v1.6.0"), "a second update offer");
    assert.match(text, /Installed and updated by Wollipog from Connections/u);
    assert.match(text, /self-updater is off/u);
    assert.match(text, new RegExp(`used if the managed copy stops working: ${executable.path}`, "u"));
  } finally { await view.unmount(); }
});

test("an update rolled back after a failed access check names the version kept", async () => {
  const view = await mount(runner(managedReady({ latest: { version: "1.6.0", checkedAt: NOW },
    operation: failedOperation("update", "access_check_failed", "1.6.0") })));
  try {
    const opened = await openSetup(view.body);
    assert.match(opened.textContent ?? "", /didn.t pass Wollipog.s check with this machine.s sign-in, so Wollipog didn.t keep it/u);
    assert.match(opened.textContent ?? "", /Wollipog kept v1\.5\.14, the last working version, instead of v1\.6\.0/u);
  } finally { await view.unmount(); }
});

test("a first install stopped by a timed-out check doesn't claim the found copy works", async () => {
  const view = await mount(runner(setup({ status: "verification_failed", failure: "timed_out", executable: { ...executable, source: "path" },
    managedInstall: { available: true, pathExecutable: executable.path,
      operation: { operationId: "agy_install_1", kind: "install", status: "failed", startedAt: NOW, finishedAt: NOW, failure: "timed_out" } } })));
  try {
    const opened = await openSetup(view.body);
    const notice = [...opened.querySelectorAll('[role="alert"]')].find((node) => /Install Failed/u.test(node.textContent ?? ""));
    assert.match(notice?.textContent ?? "", /took too long, so nothing was changed/u);
    assert.doesNotMatch(opened.textContent ?? "", /keeps working/u);
  } finally { await view.unmount(); }
});

test("the row keeps Ready but shows a failed install or update beside it, and nothing otherwise", async () => {
  const cases: Array<[AntigravitySetupView, string, string | null]> = [
    [managedReady({ operation: failedOperation("update", "validation_failed", "1.6.0") }), "Ready", "Update Failed"],
    [setup({ status: "ready", models: [{ id: "a", name: "Fixture Pro" }], executable: { ...executable, source: "path" },
      managedInstall: { available: true, operation: failedOperation("install", "checksum_mismatch", "1.5.14") } }), "Ready", "Install Failed"],
    [setup({ status: "missing_runtime", executable: undefined,
      managedInstall: { available: true, operation: failedOperation("install", "checksum_mismatch", "1.5.14") } }), "Not Installed", "Install Failed"],
    [managedReady({}), "Ready", null],
    [managedReady({ operation: { operationId: "agy_install_1", kind: "update", status: "running", stage: "downloading", startedAt: NOW } }), "Updating", null],
  ];
  for (const [report, status, attention] of cases) {
    const view = await mount(runner(report));
    try {
      const setupRow = row(view.body)!;
      assert.equal(setupRow.querySelector(".machine-agent-status")?.textContent, status);
      const badges = [...setupRow.querySelectorAll(".row-sub .status")].map((badge) => badge.textContent);
      assert.deepEqual(badges, attention ? [attention] : [], JSON.stringify(report.managedInstall?.operation));
      if (attention) assert.ok(setupRow.querySelector(".row-sub .status")!.classList.contains("t-danger"));
    } finally { await view.unmount(); }
  }
});

test("an update whose rollback failed claims no kept version", async () => {
  const view = await mount(runner(managedReady({ active: managedRelease("1.6.0"), latest: { version: "1.6.0", checkedAt: NOW },
    operation: failedOperation("update", "rollback_failed", "1.6.0") })));
  try {
    const opened = await openSetup(view.body);
    const alert = opened.querySelector('[role="alert"]');
    assert.match(alert?.textContent ?? "", /Update Failed.*couldn.t restore the version before it yet/u);
    assert.doesNotMatch(opened.textContent ?? "", /Wollipog kept|keeps working/u);
  } finally { await view.unmount(); }
});

test("an update is offered only when Google's release is newer than the managed copy", async () => {
  let installs = 0;
  const newer = await mount(runner(managedReady({ latest: { version: "1.6.0", checkedAt: NOW } })),
    { installAntigravity: async () => { installs += 1; return {}; } });
  try {
    const opened = await openSetup(newer.body);
    assert.match(opened.textContent ?? "", /Google released v1\.6\.0\. This machine.s managed copy is v1\.5\.14/u);
    await act(async () => buttonNamed(opened, "Update to v1.6.0")!.click());
    assert.equal(installs, 1);
  } finally { await newer.unmount(); }
  const current = await mount(runner(managedReady({ latest: { version: "1.5.14", checkedAt: NOW } })));
  try {
    const opened = await openSetup(current.body);
    assert.doesNotMatch(opened.textContent ?? "", /Update Available/u);
    assertNoDomNode(buttonNamed(opened, "Install Managed Copy"), "a managed install offer beside a managed copy");
  } finally { await current.unmount(); }
});

test("a PATH copy keeps working and a managed copy can be installed beside it, but not during a sign-in", async () => {
  const pathCopy = { ...executable, source: "path" as const };
  const ready = await mount(runner(setup({ status: "ready", models: [{ id: "a", name: "Fixture Pro" }], executable: pathCopy,
    managedInstall: { available: true, pathExecutable: executable.path } })));
  try {
    const opened = await openSetup(ready.body);
    assert.match(opened.textContent ?? "", /SourceThe runner user.s PATH\./u);
    assert.equal(buttonNamed(opened, "Install Managed Copy")?.disabled, false);
  } finally { await ready.unmount(); }
  const fallback = await mount(runner(setup({ status: "ready", models: [{ id: "a", name: "Fixture Pro" }], executable: pathCopy,
    managedInstall: { available: true, active: managedRelease("1.5.14"), activeCheckFailed: true, pathExecutable: executable.path } })));
  try {
    const opened = await openSetup(fallback.body);
    assert.match(opened.textContent ?? "", /managed copy didn.t pass its version check, so this copy is in use/u);
  } finally { await fallback.unmount(); }
  // A managed install that failed beside the PATH copy says so, and the PATH copy keeps working.
  const failedBeside = await mount(runner(setup({ status: "ready", models: [{ id: "a", name: "Fixture Pro" }], executable: pathCopy,
    managedInstall: { available: true, pathExecutable: executable.path, operation: failedOperation("install", "checksum_mismatch", "1.5.14") } })));
  try {
    const opened = await openSetup(failedBeside.body);
    const alert = opened.querySelector('[role="alert"]');
    assert.match(alert?.textContent ?? "", /Install Failed.*didn.t match the checksum.*keeps working/u);
    assert.ok(buttonNamed(alert!, "Try Again"));
    assertNoDomNode(buttonNamed(opened, "Install Managed Copy"), "a second install offer beside Try Again");
  } finally { await failedBeside.unmount(); }
  const signingIn = await mount(runner(setup({ executable: pathCopy, managedInstall: { available: true },
    signIn: { operationId: "agy_login_1", status: "waiting_for_provider", startedAt: NOW } })));
  try {
    const opened = await openSetup(signingIn.body);
    // The sign-in step replaces the status notice; no install is offered while it runs.
    assertNoDomNode(buttonNamed(opened, "Install Managed Copy"), "an install during a sign-in");
  } finally { await signingIn.unmount(); }
});
