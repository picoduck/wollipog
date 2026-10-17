import assert from "node:assert/strict";
import { test } from "node:test";
import React, { act } from "react";
import { createRoot } from "react-dom/client";
import { Window } from "happy-dom";
import { RUNNER_CAPABILITY_MIN_PROTOCOL, type ProviderAccountDefinition, type RunnerView } from "@wollipog/protocol";
import { ApiError, type ApiClient } from "../api.js";
import { ApiProvider } from "../api-context.js";
import { assertNoDomNode } from "../dom-test-assertions.js";
import { FeedbackProvider } from "./FeedbackProvider.js";
import { ProviderAccountsSection, providerProfileErrorMessage } from "./ProviderAccountsSection.js";

const domWindow = new Window({ url: "http://localhost/" });
for (const [name, value] of Object.entries({
  window: domWindow, document: domWindow.document, navigator: domWindow.navigator, localStorage: domWindow.localStorage,
  HTMLElement: domWindow.HTMLElement, HTMLButtonElement: domWindow.HTMLButtonElement, HTMLInputElement: domWindow.HTMLInputElement,
  Element: domWindow.Element, Node: domWindow.Node, Event: domWindow.Event, MouseEvent: domWindow.MouseEvent,
  requestAnimationFrame: domWindow.requestAnimationFrame.bind(domWindow), cancelAnimationFrame: domWindow.cancelAnimationFrame.bind(domWindow),
  getComputedStyle: domWindow.getComputedStyle.bind(domWindow), React, IS_REACT_ACT_ENVIRONMENT: true,
})) Object.defineProperty(globalThis, name, { configurable: true, writable: true, value });

const PROFILES = RUNNER_CAPABILITY_MIN_PROTOCOL.providerProfiles;
const CAPABILITY_REFUSAL = "This machine needs a newer runner for provider profiles. Update and restart the runner.";

const ACCOUNTS: ProviderAccountDefinition[] = [
  { id: "granted", label: "Granted Work", provider: "claude", authStatus: "authenticated", profile: { id: "p1", access: "granted" } },
  { id: "pending", label: "Pending Work", provider: "claude", authStatus: "authenticated", profile: { id: "p2", access: "pending" } },
  { id: "other", label: "Other Work", provider: "codex", authStatus: "authenticated", profile: { id: "p3", access: "not_granted" } },
  { id: "legacy", label: "Legacy Work", provider: "codex", authStatus: "authenticated" },
];

function runnerView(overrides: Partial<RunnerView> = {}): RunnerView {
  return {
    runnerId: "runner-1", hostname: "host", os: "linux", version: "1", status: "online", agents: [], lastSeen: 0,
    protocolVersion: PROFILES, canManage: true, providerAccounts: ACCOUNTS, ...overrides,
  } as RunnerView;
}

type Call = { kind: "adopt" | "revoke"; accountId: string; force?: boolean };

function client(handlers: {
  adopt?: (accountId: string) => Promise<unknown>;
  revoke?: (accountId: string, force: boolean) => Promise<unknown>;
} = {}) {
  const calls: Call[] = [];
  const value = {
    adoptProviderProfile: async (_runnerId: string, accountId: string) => {
      calls.push({ kind: "adopt", accountId });
      return handlers.adopt ? handlers.adopt(accountId) : { status: "active", profileId: "p", grantId: "g" };
    },
    revokeProviderProfileAccess: async (_runnerId: string, accountId: string, force = false) => {
      calls.push({ kind: "revoke", accountId, force });
      return handlers.revoke ? handlers.revoke(accountId, force)
        : { revoked: true, grantIds: ["g"], markerUpdated: true, runnerNotified: true, forced: force };
    },
  } as unknown as ApiClient;
  return { client: value, calls };
}

async function render(props: { runner?: RunnerView; online?: boolean; canManageProfiles?: boolean; api?: ApiClient }) {
  const container = domWindow.document.createElement("div") as unknown as HTMLDivElement;
  domWindow.document.body.append(container as never);
  const root = createRoot(container);
  const settle = () => act(async () => { for (let index = 0; index < 5; index += 1) await new Promise((resolve) => setTimeout(resolve, 0)); });
  await act(async () => root.render(
    <ApiProvider client={props.api ?? client().client}>
      <FeedbackProvider>
        <ProviderAccountsSection runner={props.runner ?? runnerView()} online={props.online ?? true}
          canManageProfiles={props.canManageProfiles ?? true} />
      </FeedbackProvider>
    </ApiProvider>,
  ));
  await settle();
  const dialog = () => domWindow.document.body.querySelector('[role="dialog"]') as unknown as HTMLElement | null;
  const row = (label: string) => {
    const match = [...container.querySelectorAll<HTMLElement>(".agent-row")].find((candidate) => candidate.textContent?.includes(label));
    assert.ok(match, `expected a row for ${label}`);
    return match;
  };
  const buttons = (scope: HTMLElement) => [...scope.querySelectorAll<HTMLButtonElement>("button")].map((button) => button.textContent?.trim());
  const button = (scope: HTMLElement, name: string) => {
    const match = [...scope.querySelectorAll<HTMLButtonElement>("button")].find((candidate) => candidate.textContent?.trim() === name);
    assert.ok(match, `expected ${name}`);
    return match;
  };
  return {
    container, dialog, row, buttons, button, settle,
    badges: (label: string) => [...row(label).querySelectorAll(".agent-row-meta .atag")].map((tag) => tag.textContent),
    error: () => container.querySelector('.form-error[role="alert"]')?.textContent ?? null,
    unmount: async () => { await act(async () => root.unmount()); container.remove(); },
  };
}

test("each profile access state has its badge, and a legacy HOME has none", async () => {
  const ui = await render({ canManageProfiles: false });
  try {
    assert.deepEqual(ui.badges("Granted Work"), ["Claude", "Logged In", "Profile"]);
    assert.deepEqual(ui.badges("Pending Work"), ["Claude", "Logged In", "Grant Pending"]);
    assert.deepEqual(ui.badges("Other Work"), ["Codex", "Logged In", "Not Granted"]);
    assert.deepEqual(ui.badges("Legacy Work"), ["Codex", "Logged In"]);
    assert.equal(ui.row("Granted Work").querySelector(".atag.ctx")?.textContent, "Profile");
    assert.equal(ui.row("Other Work").querySelector(".atag.broken")?.textContent, "Not Granted");
  } finally {
    await ui.unmount();
  }
});

test("Owners and Admins get Adopt as Profile and Revoke Access by access state on a v225 runner", async () => {
  const ui = await render({});
  try {
    const profileButtons = (label: string) => ui.buttons(ui.row(label)).filter((name) => name === "Adopt as Profile" || name === "Revoke Access");
    assert.deepEqual(profileButtons("Granted Work"), ["Revoke Access"]);
    assert.deepEqual(profileButtons("Pending Work"), ["Adopt as Profile", "Revoke Access"], "a pending grant can be retried or revoked");
    assert.deepEqual(profileButtons("Other Work"), ["Adopt as Profile"]);
    assert.deepEqual(profileButtons("Legacy Work"), ["Adopt as Profile"]);
  } finally {
    await ui.unmount();
  }
});

test("a member with manage rights, or a runner below v225, gets no profile actions", async () => {
  for (const props of [
    { canManageProfiles: false },
    { runner: runnerView({ protocolVersion: PROFILES - 1 }) },
  ]) {
    const ui = await render(props);
    try {
      const names = ui.buttons(ui.container);
      assert.ok(!names.includes("Adopt as Profile"), JSON.stringify(props));
      assert.ok(!names.includes("Revoke Access"), JSON.stringify(props));
      assert.ok(names.includes("Remove"), "account removal is still offered to a manager");
    } finally {
      await ui.unmount();
    }
  }
});

test("offline, adoption waits for the Machine while revocation stays available", async () => {
  const ui = await render({ online: false, runner: runnerView({ status: "offline" }) });
  try {
    assert.equal(ui.button(ui.row("Legacy Work"), "Adopt as Profile").disabled, true);
    assert.equal(ui.button(ui.row("Granted Work"), "Revoke Access").disabled, false);
  } finally {
    await ui.unmount();
  }
});

test("Adopt as Profile explains the strict grant and adopts after confirmation", async () => {
  const api = client();
  const ui = await render({ api: api.client });
  try {
    await act(async () => { ui.button(ui.row("Legacy Work"), "Adopt as Profile").click(); });
    await ui.settle();
    const dialog = ui.dialog();
    assert.ok(dialog);
    const text = dialog.textContent ?? "";
    assert.match(text, /Adopt as Profile/);
    assert.match(text, /only control planes granted this profile can use this account's HOME/);
    assert.match(text, /other control planes that share this Machine's account lose access to it/);
    assert.match(text, /Existing sessions keep working as before; new sessions record the profile\./);
    assert.match(text, /Legacy Work/);
    await act(async () => { ui.button(dialog, "Cancel").click(); });
    await ui.settle();
    assert.deepEqual(api.calls, [], "Cancel adopts nothing");

    await act(async () => { ui.button(ui.row("Legacy Work"), "Adopt as Profile").click(); });
    await ui.settle();
    await act(async () => { ui.button(ui.dialog()!, "Adopt as Profile").click(); });
    await ui.settle();
    assert.deepEqual(api.calls, [{ kind: "adopt", accountId: "legacy" }]);
    assert.match(domWindow.document.body.textContent ?? "", /Account adopted as a profile\./);
    assert.equal(ui.error(), null);
  } finally {
    await ui.unmount();
  }
});

test("while adoption runs its button shows the spinner and the other actions wait", async () => {
  let finish!: () => void;
  const api = client({ adopt: () => new Promise((resolve) => { finish = () => resolve({ status: "active", profileId: "p", grantId: "g" }); }) });
  const ui = await render({ api: api.client });
  try {
    await act(async () => { ui.button(ui.row("Legacy Work"), "Adopt as Profile").click(); });
    await ui.settle();
    await act(async () => { ui.button(ui.dialog()!, "Adopt as Profile").click(); });
    await ui.settle();
    const busy = ui.button(ui.row("Legacy Work"), "Adopt as Profile");
    assert.equal(busy.getAttribute("aria-busy"), "true");
    assert.ok(ui.row("Legacy Work").textContent?.includes("Authorizing…"), "the progress is announced");
    assert.equal(ui.button(ui.row("Granted Work"), "Revoke Access").disabled, true);
    await act(async () => { finish(); });
    await ui.settle();
    assert.equal(ui.button(ui.row("Legacy Work"), "Adopt as Profile").getAttribute("aria-busy"), null);
  } finally {
    await ui.unmount();
  }
});

test("Revoke Access confirms, and active sessions get a second confirmation that forces it", async () => {
  const api = client({
    revoke: async (_accountId, force) => {
      if (!force) {
        throw new ApiError("this provider profile has 3 active sessions", 409, "PROVIDER_PROFILE_HAS_ACTIVE_SESSIONS", {
          code: "PROVIDER_PROFILE_HAS_ACTIVE_SESSIONS",
          activeSessions: [{ id: "s1", title: "Fix rounding", status: "running" }, { id: "s2", title: "Ship docs", status: "idle" }],
          activeSessionCount: 3,
        });
      }
      return { revoked: true, grantIds: ["g"], markerUpdated: true, runnerNotified: true, forced: true };
    },
  });
  const ui = await render({ api: api.client });
  try {
    await act(async () => { ui.button(ui.row("Granted Work"), "Revoke Access").click(); });
    await ui.settle();
    const first = ui.dialog()!;
    assert.match(first.textContent ?? "", /This control plane stops using this account's profile, and sessions that use it cannot restart until access is granted again\./);
    assert.match(first.textContent ?? "", /Other control planes' access is not affected\./);
    assert.equal(ui.button(first, "Revoke Access").className, "btn danger");
    await act(async () => { ui.button(first, "Revoke Access").click(); });
    await ui.settle();

    const second = ui.dialog()!;
    assert.match(second.textContent ?? "", /Revoke Access from Active Sessions/);
    assert.match(second.textContent ?? "", /3 active sessions use this account's profile\. Revoking access stops them from restarting/);
    assert.match(second.textContent ?? "", /Fix rounding/);
    assert.match(second.textContent ?? "", /Ship docs/);
    assert.match(second.textContent ?? "", /1 more/, "the session the server counted but did not list");
    assert.deepEqual(api.calls, [{ kind: "revoke", accountId: "granted", force: false }]);
    await act(async () => { ui.button(second, "Revoke Access").click(); });
    await ui.settle();
    assert.deepEqual(api.calls, [
      { kind: "revoke", accountId: "granted", force: false },
      { kind: "revoke", accountId: "granted", force: true },
    ]);
    assert.match(domWindow.document.body.textContent ?? "", /Access revoked\./);
    assert.equal(ui.error(), null);
  } finally {
    await ui.unmount();
  }
});

test("declining the force confirmation revokes nothing more", async () => {
  const api = client({
    revoke: async () => {
      throw new ApiError("conflict", 409, "PROVIDER_PROFILE_HAS_ACTIVE_SESSIONS", { activeSessionCount: 1, activeSessions: [] });
    },
  });
  const ui = await render({ api: api.client });
  try {
    await act(async () => { ui.button(ui.row("Pending Work"), "Revoke Access").click(); });
    await ui.settle();
    await act(async () => { ui.button(ui.dialog()!, "Revoke Access").click(); });
    await ui.settle();
    assert.match(ui.dialog()!.textContent ?? "", /1 active session uses this account's profile\./);
    await act(async () => { ui.button(ui.dialog()!, "Cancel").click(); });
    await ui.settle();
    assertNoDomNode(ui.dialog());
    assert.deepEqual(api.calls, [{ kind: "revoke", accountId: "pending", force: false }]);
    assert.equal(ui.error(), null);
    assert.equal(ui.button(ui.row("Pending Work"), "Revoke Access").disabled, false);
  } finally {
    await ui.unmount();
  }
});

test("a capability refusal and an adoption timeout are shown in the section's alert", async () => {
  for (const [failure, expected] of [
    [new ApiError(CAPABILITY_REFUSAL, 409, undefined, { error: CAPABILITY_REFUSAL, requiredRunnerProtocolVersion: PROFILES }), CAPABILITY_REFUSAL],
    [new ApiError("runner request timed out", 504, undefined, { status: "pending", grantId: "g" }),
      "The Machine did not confirm the adoption in time. It completes when the Machine reports the account again."],
  ] as const) {
    const api = client({ adopt: async () => { throw failure; } });
    const ui = await render({ api: api.client });
    try {
      await act(async () => { ui.button(ui.row("Other Work"), "Adopt as Profile").click(); });
      await ui.settle();
      await act(async () => { ui.button(ui.dialog()!, "Adopt as Profile").click(); });
      await ui.settle();
      assert.equal(ui.error(), expected);
    } finally {
      await ui.unmount();
    }
  }
});

test("coded adoption refusals read as sentences, and uncoded ones keep the runner's detail", () => {
  const adopt = (status: number, code?: string, message = "raw runner text") =>
    providerProfileErrorMessage(new ApiError(message, status, code), "adopt");
  assert.match(adopt(409, "PROFILE_EXISTS"), /^This account's HOME already has a profile record/);
  assert.match(adopt(409, "HOME_IN_USE"), /^Another runner or control plane is using this account's HOME\./);
  assert.match(adopt(409, "UNSUPPORTED_HOME"), /Windows Machines and WSL account homes are not supported\.$/);
  assert.equal(adopt(409, "PROVIDER_PROFILE_GRANT_REVOKED"), "Access was revoked while the account was being adopted. Adopt it again to grant access.");
  assert.equal(adopt(409, "PROVIDER_PROFILE_ADOPTION_FAILED", "The configuration could not be written."),
    "The Machine could not adopt this account. Adopt it again to retry. The configuration could not be written.");
  assert.equal(adopt(409, "PROVIDER_PROFILE_ADOPTION_FAILED", "The provider profile could not be adopted."),
    "The Machine could not adopt this account. Adopt it again to retry.");
  assert.equal(adopt(409, undefined, "runner is offline"), "The Machine is offline. Adopting an account needs the Machine to be online.");
  assert.equal(providerProfileErrorMessage(new ApiError("This provider account has no profile access to revoke.", 404), "revoke"),
    "This provider account has no profile access to revoke.");
});
