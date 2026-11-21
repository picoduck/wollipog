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

  // An operator-configured agent that uses the id is its own agent, listed beside the setup row.
  const configured = await mount(runner(ready, { agents: [{ ...antigravity, source: "config", name: "Operator Wrapper" }] }));
  try {
    const agentRows = [...configured.body.querySelectorAll('ul[aria-label="Agents"] .row-title')].map((title) => title.textContent);
    assert.ok(agentRows.includes("Operator Wrapper"));
  } finally { await configured.unmount(); }

  // Without the setup row (Account Setup), the advertised agent is listed like any other.
  const accountSetup = await mount(runner(ready, { agents: [antigravity] }), {}, false);
  try {
    const agentRows = [...accountSetup.body.querySelectorAll('ul[aria-label="Agents"] .row-title')].map((title) => title.textContent);
    assert.ok(agentRows.includes("Google Antigravity"));
  } finally { await accountSetup.unmount(); }
});

test("a missing runtime shows Google's install command and never offers to install it", async () => {
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
