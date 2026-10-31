import assert from "node:assert/strict";
import { test } from "node:test";
import React, { act } from "react";
import { createRoot } from "react-dom/client";
import { Window } from "happy-dom";
import {
  RUNNER_CAPABILITY_MIN_PROTOCOL,
  type AgentDefinition,
  type ProviderAccountDefinition,
  type ProviderHomeLeaseInspection,
  type ProviderLoginView,
  type RunnerView,
} from "@wollipog/protocol";
import { HIDE_ACCOUNT_EMAILS_STORAGE_KEY, setHideAccountEmails } from "../account-email-privacy.js";
import { ApiError, type ApiClient } from "../api.js";
import { ApiProvider } from "../api-context.js";
import { assertNoDomNode } from "../dom-test-assertions.js";
import type { MachineAccountsIntent } from "../navigation.js";
import { FeedbackProvider } from "./FeedbackProvider.js";
import { ProviderAccountsSection, providerAccountRemovalRefusal, providerProfileErrorMessage, PROFILES_UNSUPPORTED_ON_WINDOWS } from "./ProviderAccountsSection.js";

const domWindow = new Window({ url: "http://localhost/" });
for (const [name, value] of Object.entries({
  window: domWindow, document: domWindow.document, navigator: domWindow.navigator, localStorage: domWindow.localStorage,
  HTMLElement: domWindow.HTMLElement, HTMLButtonElement: domWindow.HTMLButtonElement, HTMLInputElement: domWindow.HTMLInputElement,
  Element: domWindow.Element, Node: domWindow.Node, Event: domWindow.Event, MouseEvent: domWindow.MouseEvent,
  KeyboardEvent: domWindow.KeyboardEvent,
  requestAnimationFrame: domWindow.requestAnimationFrame.bind(domWindow), cancelAnimationFrame: domWindow.cancelAnimationFrame.bind(domWindow),
  getComputedStyle: domWindow.getComputedStyle.bind(domWindow), React, IS_REACT_ACT_ENVIRONMENT: true,
})) Object.defineProperty(globalThis, name, { configurable: true, writable: true, value });

const PROFILES = RUNNER_CAPABILITY_MIN_PROTOCOL.providerProfiles;
const REMOVAL = RUNNER_CAPABILITY_MIN_PROTOCOL.providerAccountRemoval;
const CAPABILITY_REFUSAL = "This machine needs a newer runner for provider profiles. Update and restart the runner.";

const ACCOUNTS: ProviderAccountDefinition[] = [
  { id: "granted", label: "Granted Work", provider: "claude", authStatus: "authenticated", profile: { id: "p1", access: "granted" } },
  { id: "pending", label: "Pending Work", provider: "claude", authStatus: "authenticated", profile: { id: "p2", access: "pending" } },
  { id: "other", label: "Other Work", provider: "codex", authStatus: "authenticated", profile: { id: "p3", access: "not_granted" } },
  { id: "legacy", label: "Legacy Work", provider: "codex", authStatus: "authenticated" },
];

const SIGN_IN_ACCOUNTS: ProviderAccountDefinition[] = [
  { id: "work", label: "Work", provider: "claude", authStatus: "authenticated" },
  { id: "personal", label: "Personal", provider: "claude", authStatus: "unauthenticated" },
  { id: "mystery", label: "Mystery", provider: "codex", authStatus: "unknown" },
];

const runningLogin = (accountId: string, label: string): ProviderLoginView => ({
  operationId: `login-${accountId}`, accountId, label, provider: "claude", status: "waiting_for_provider", startedAt: 1,
});

function runnerView(overrides: Partial<RunnerView> = {}): RunnerView {
  return {
    runnerId: "runner-1", hostname: "host", os: "linux", version: "1", status: "online", agents: [], lastSeen: 0,
    protocolVersion: PROFILES, canManage: true, providerAccounts: ACCOUNTS, ...overrides,
  } as RunnerView;
}

type Call =
  | { kind: "adopt" | "revoke"; accountId: string; force?: boolean }
  | { kind: "remove"; accountId: string }
  | { kind: "login"; body: unknown }
  | { kind: "cancel"; operationId: string }
  | { kind: "dismiss"; operationId: string };

function client(handlers: {
  adopt?: (accountId: string) => Promise<unknown>;
  revoke?: (accountId: string, force: boolean) => Promise<unknown>;
  remove?: (accountId: string) => Promise<unknown>;
  login?: (body: unknown) => Promise<unknown>;
  cancel?: (operationId: string) => Promise<unknown>;
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
    removeProviderAccount: async (_runnerId: string, accountId: string) => {
      calls.push({ kind: "remove", accountId });
      return handlers.remove ? handlers.remove(accountId) : { removed: true, credentialsRetained: false };
    },
    cancelProviderLogin: async (_runnerId: string, operationId: string) => {
      calls.push({ kind: "cancel", operationId });
      return handlers.cancel ? handlers.cancel(operationId) : { login: runningLogin("work", "Work") };
    },
    dismissProviderLoginNotice: async (_runnerId: string, operationId: string) => {
      calls.push({ kind: "dismiss", operationId });
      return { dismissed: true };
    },
    startProviderLogin: async (_runnerId: string, body: unknown) => {
      calls.push({ kind: "login", body });
      return handlers.login ? handlers.login(body) : { login: runningLogin("new", "New") };
    },
  } as unknown as ApiClient;
  return { client: value, calls };
}

type RenderProps = {
  runner?: RunnerView; online?: boolean; canManageProfiles?: boolean; api?: ApiClient; machineName?: string;
  intent?: MachineAccountsIntent;
  profileAccessKnown?: boolean;
};

async function render(props: RenderProps) {
  const container = domWindow.document.createElement("div") as unknown as HTMLDivElement;
  domWindow.document.body.append(container as never);
  const root = createRoot(container);
  const settle = () => act(async () => { for (let index = 0; index < 5; index += 1) await new Promise((resolve) => setTimeout(resolve, 0)); });
  const apiClient = props.api ?? client().client;
  const draw = (next: RenderProps) => root.render(
    <ApiProvider client={apiClient}>
      <FeedbackProvider>
        <ProviderAccountsSection runner={next.runner ?? runnerView()} online={next.online ?? true}
          machineName={next.machineName ?? "Studio Mac"} canManageProfiles={next.canManageProfiles ?? true} intent={next.intent}
          profileAccessKnown={next.profileAccessKnown ?? true} />
      </FeedbackProvider>
    </ApiProvider>,
  );
  await act(async () => draw(props));
  await settle();
  const body = domWindow.document.body as unknown as HTMLElement;
  const dialog = () => body.querySelector('[role="dialog"]') as HTMLElement | null;
  const rows = () => [...container.querySelectorAll<HTMLElement>(".provider-accounts-list > .row")];
  const row = (label: string) => {
    const match = rows().find((candidate) => candidate.querySelector(".row-title")?.textContent?.includes(label));
    assert.ok(match, `expected a row for ${label}`);
    return match;
  };
  const buttons = (scope: HTMLElement) => [...scope.querySelectorAll<HTMLButtonElement>("button")].map((button) => button.textContent?.trim());
  const button = (scope: HTMLElement, name: string) => {
    const match = [...scope.querySelectorAll<HTMLButtonElement>("button")].find((candidate) => candidate.textContent?.trim() === name);
    assert.ok(match, `expected ${name}`);
    return match;
  };
  const more = (label: string) => row(label).querySelector<HTMLButtonElement>('button[aria-label^="More Actions for"]');
  const menu = () => body.querySelector<HTMLElement>('[role="menu"]');
  const openMenu = async (label: string) => {
    const trigger = more(label);
    assert.ok(trigger, `expected ⋯ on ${label}`);
    await act(async () => { trigger.click(); });
    await settle();
    const opened = menu();
    assert.ok(opened, `expected ${label}'s menu`);
    return opened;
  };
  /** Each item's label and, when it has one, its second line. */
  const menuItems = (scope: HTMLElement) => [...scope.querySelectorAll<HTMLButtonElement>(".menu-item")].map((item) => ({
    label: item.querySelector(".menu-text")?.textContent ?? "",
    disabled: item.disabled,
    reason: item.querySelector(".menu-desc")?.textContent ?? null,
  }));
  const choose = async (label: string, item: string) => {
    const opened = await openMenu(label);
    const match = [...opened.querySelectorAll<HTMLButtonElement>(".menu-item")].find((candidate) =>
      candidate.querySelector(".menu-text")?.textContent === item);
    assert.ok(match, `expected ${item} in ${label}'s menu`);
    await act(async () => { match.click(); });
    await settle();
  };
  const closeMenu = async () => {
    const backdrop = body.querySelector<HTMLElement>(".menu-backdrop");
    await act(async () => { backdrop?.click(); });
    await settle();
  };
  const toasts = () => [...body.querySelectorAll<HTMLElement>(".toast")].map((toast) => toast.textContent ?? "");
  return {
    container, body, dialog, rows, row, buttons, button, more, menu, openMenu, menuItems, choose, closeMenu, toasts, settle,
    /** Draws the section again with changed props, as a new runner snapshot would. */
    rerender: async (next: RenderProps) => { await act(async () => draw({ ...props, ...next })); await settle(); },
    badge: (label: string) => row(label).querySelector<HTMLElement>(".status"),
    sub: (label: string) => [...row(label).querySelectorAll(".provider-account-sub > span")].map((part) => part.textContent),
    notice: () => container.querySelector<HTMLElement>('.notice[role="alert"]'),
    error: () => container.querySelector('.notice[role="alert"] .notice-body')?.textContent ?? null,
    unmount: async () => {
      await act(async () => root.unmount());
      container.remove();
      for (const node of [...body.querySelectorAll(".toast-stack, .toast")]) node.remove();
    },
  };
}

async function withHiddenEmails(run: () => Promise<void>) {
  domWindow.localStorage.setItem(HIDE_ACCOUNT_EMAILS_STORAGE_KEY, "true");
  try {
    await run();
  } finally {
    domWindow.localStorage.removeItem(HIDE_ACCOUNT_EMAILS_STORAGE_KEY);
  }
}

// --- Section and statuses (#2995) ---

test("each account has one status: Signed In in the success tone inline, Sign-In Required in warning, Status Unknown neutral", async () => {
  const ui = await render({ runner: runnerView({ providerAccounts: SIGN_IN_ACCOUNTS }) });
  try {
    const heading = ui.container.querySelector(".section-title");
    assert.equal(heading?.textContent, "Provider Accounts 3");
    assert.equal(ui.badge("Work")?.textContent, "Signed In");
    assert.match(ui.badge("Work")!.className, /\bt-success\b/);
    assert.match(ui.badge("Work")!.className, /\binline\b/);
    assert.equal(ui.badge("Personal")?.textContent, "Sign-In Required");
    assert.match(ui.badge("Personal")!.className, /\bt-warning\b/);
    assert.equal(ui.badge("Mystery")?.textContent, "Status Unknown");
    assert.match(ui.badge("Mystery")!.className, /\bt-neutral\b/);
    for (const label of ["Work", "Personal", "Mystery"]) {
      assert.equal(ui.row(label).querySelectorAll(".status").length, 1, `${label} has one badge`);
      assert.ok(ui.row(label).classList.contains("row-2"));
    }
    assert.deepEqual(ui.sub("Work"), ["Claude"]);
    assert.deepEqual(ui.sub("Mystery"), ["Codex"]);
    const text = ui.container.textContent ?? "";
    assert.doesNotMatch(text, /Logged In|Login Required|Login Unknown/);
    assert.equal(ui.container.querySelectorAll(".atag, .agent-row, .form-error").length, 0);
    assert.doesNotMatch(text, /Sign in to Claude or Codex on this machine/, "the intro shows only without accounts");
  } finally {
    await ui.unmount();
  }
});

test("a running sign-in reads Signing In with a pulse, and a new account's sign-in has a row of its own", async () => {
  const ui = await render({
    runner: runnerView({
      providerAccounts: SIGN_IN_ACCOUNTS,
      providerLogins: [runningLogin("work", "Work"), runningLogin("studio", "Studio")],
    }),
  });
  try {
    assert.equal(ui.badge("Work")?.textContent, "Signing In");
    assert.match(ui.badge("Work")!.className, /\bt-info\b.*\bpulse\b/);
    assert.equal(ui.badge("Studio")?.textContent, "Signing In");
    assert.equal(ui.container.querySelector(".section-title")?.textContent, "Provider Accounts 3", "the count is accounts");
    assert.equal(ui.container.querySelectorAll(".provider-account-expansion .signin").length, 2, "each row expands into its own steps");
  } finally {
    await ui.unmount();
  }
});

test("a running retry wins over an earlier failure the control plane kept for the same account", async () => {
  const failed: ProviderLoginView = {
    operationId: "login-failed", accountId: "personal", label: "Personal", provider: "claude", status: "failed",
    error: "The sign-in attempt failed.", startedAt: 1,
  };
  const retry: ProviderLoginView = {
    operationId: "login-retry", accountId: "personal", label: "Personal", provider: "claude", status: "awaiting_code",
    expectsCode: true, verificationUrl: "https://claude.ai/oauth/authorize?retry", startedAt: 2,
  };
  const api = client();
  const ui = await render({
    runner: runnerView({ providerAccounts: SIGN_IN_ACCOUNTS, providerLogins: [failed, retry] }), api: api.client, canManageProfiles: false,
  });
  try {
    assert.equal(ui.badge("Personal")?.textContent, "Signing In");
    const steps = [...ui.container.querySelectorAll<HTMLElement>(".provider-account-expansion .signin")];
    assert.equal(steps.length, 1, "the row shows one sign-in");
    assert.match(steps[0]!.textContent ?? "", /Paste the Code It Shows/);
    assert.doesNotMatch(steps[0]!.textContent ?? "", /The sign-in attempt failed\./);
    await act(async () => { ui.button(ui.row("Personal"), "Cancel").click(); });
    await ui.settle();
    assert.deepEqual(api.calls, [{ kind: "cancel", operationId: "login-retry" }]);
  } finally {
    await ui.unmount();
  }
});

test("with no accounts the section shows its intro and Add Account…; offline, Add Account… is disabled with the reason", async () => {
  const ui = await render({ runner: runnerView({ providerAccounts: [] }), online: false });
  try {
    assert.match(ui.container.textContent ?? "", /Sign in to Claude or Codex on this machine without opening a shell\./);
    const add = ui.button(ui.container, "Add Account…");
    assert.equal(add.disabled, true);
    const reason = ui.container.querySelector(`#${add.getAttribute("aria-describedby")}`);
    assert.equal(reason?.textContent, "This machine is offline.");
    assertNoDomNode(ui.container.querySelector(".surface"));
  } finally {
    await ui.unmount();
  }
});

test("a viewer sees the statuses only, with the sentence saying who can manage accounts", async () => {
  const ui = await render({
    runner: runnerView({ providerAccounts: SIGN_IN_ACCOUNTS, canManage: false }), canManageProfiles: false,
  });
  try {
    assert.equal(ui.buttons(ui.container).length, 0, "no Add Account…, Sign In or ⋯");
    assert.match(ui.container.textContent ?? "", /Only this machine's owner or an organization admin can add or remove its accounts\./);
    assert.equal(ui.badge("Personal")?.textContent, "Sign-In Required");
  } finally {
    await ui.unmount();
  }
});

// --- Signing in inside the row (#2996) ---

const ended = (accountId: string, label: string, status: "failed" | "timed_out", error: string): ProviderLoginView => ({
  operationId: `login-${accountId}-ended`, accountId, label, provider: "claude", status, error, startedAt: 1,
});
const DUPLICATE = "This Claude account is already on this Machine. The duplicate sign-in was discarded.";

test("while Work signs in, Work appears once, expanded, with Signing In, Cancel and a disabled Remove Account…; no card below the list", async () => {
  const api = client();
  const ui = await render({
    runner: runnerView({
      providerAccounts: SIGN_IN_ACCOUNTS,
      providerLogins: [{ ...runningLogin("work", "Work"), provider: "codex", userCode: "WOLL-IPOGS",
        verificationUrl: "https://auth.openai.com/codex/device" }],
    }),
    api: api.client, canManageProfiles: false,
  });
  try {
    assert.equal(ui.rows().filter((row) => row.querySelector(".row-title")?.textContent === "Work").length, 1, "Work is listed once");
    assert.equal(ui.badge("Work")?.textContent, "Signing In");
    const expansion = ui.row("Work").nextElementSibling as HTMLElement;
    assert.ok(expansion.classList.contains("provider-account-expansion"), "the steps expand Work's own row");
    assert.ok(expansion.parentElement?.classList.contains("surface"), "inside the accounts surface");
    assert.deepEqual([...expansion.querySelectorAll("ol.steps > li")].length, 2);
    assert.equal(ui.container.querySelectorAll("article, .provider-login-card").length, 0, "no separate card");
    assertNoDomNode(ui.container.querySelector(".provider-accounts-list")?.nextElementSibling ?? null, "nothing renders below the list");
    const cancel = ui.button(ui.row("Work"), "Cancel");
    assert.match(cancel.className, /\bbtn sm ghost\b/);
    const work = await ui.openMenu("Work");
    assert.deepEqual(ui.menuItems(work).filter((item) => item.label === "Remove Account…"),
      [{ label: "Remove Account…", disabled: true, reason: "A sign-in is running. Cancel it first." }]);
    await ui.closeMenu();
    await act(async () => { cancel.click(); });
    await ui.settle();
    assert.deepEqual(api.calls, [{ kind: "cancel", operationId: "login-work" }]);
  } finally {
    await ui.unmount();
  }
});

test("a sign-in whose label is a hidden email reads Signing In to Codex with Email hidden as line 2", async () => {
  await withHiddenEmails(async () => {
    const ui = await render({
      runner: runnerView({
        providerAccounts: SIGN_IN_ACCOUNTS,
        providerLogins: [{ ...runningLogin("new", "morgan@example.com"), provider: "codex", userCode: "WOLL-IPOGS",
          verificationUrl: "https://auth.openai.com/codex/device" }],
      }),
    });
    try {
      const row = ui.rows().at(-1)!;
      assert.equal(row.querySelector(".row-title")?.textContent, "Signing In to Codex");
      assert.deepEqual([...row.querySelectorAll(".provider-account-sub > span")].map((part) => part.textContent), ["Email hidden"]);
      assert.doesNotMatch(ui.container.innerHTML, /morgan@example\.com/);
    } finally {
      await ui.unmount();
    }
  });
});

test("a failed sign-in ends in the row with Sign-In Failed, Try Again and Dismiss, and the row returns to its status", async () => {
  const api = client();
  const ui = await render({
    runner: runnerView({
      providerAccounts: SIGN_IN_ACCOUNTS,
      providerLogins: [ended("personal", "Personal", "failed", "The provider did not confirm authentication.")],
    }),
    api: api.client, canManageProfiles: false,
  });
  try {
    assert.equal(ui.badge("Personal")?.textContent, "Sign-In Required");
    const expansion = ui.row("Personal").nextElementSibling as HTMLElement;
    assert.equal(expansion.querySelector(".notice-title")?.textContent, "Sign-In Failed");
    assert.equal(expansion.querySelector(".notice-body")?.textContent, "The provider did not confirm authentication.");
    assert.deepEqual(ui.buttons(expansion), ["Try Again", "Dismiss"]);
    assert.ok(!ui.buttons(ui.row("Personal")).includes("Sign In"), "Try Again is the one way to sign in again here");
    await act(async () => { ui.button(expansion, "Try Again").click(); });
    await ui.settle();
    assert.deepEqual(api.calls, [
      { kind: "login", body: { accountId: "personal" } },
      { kind: "dismiss", operationId: "login-personal-ended" },
    ]);
  } finally {
    await ui.unmount();
  }
});

test("a timed-out sign-in for a new account offers Start Again with the same provider and label, and Dismiss", async () => {
  const api = client();
  const ui = await render({
    runner: runnerView({
      providerAccounts: SIGN_IN_ACCOUNTS,
      providerLogins: [ended("studio-1a2b3c4d", "Studio", "timed_out", "Sign-in timed out before the provider confirmed authentication.")],
    }),
    api: api.client,
  });
  try {
    const row = ui.row("Studio");
    assertNoDomNode(row.querySelector(".status"), "a new account that did not land has no status");
    const expansion = row.nextElementSibling as HTMLElement;
    assert.equal(expansion.querySelector(".notice-title")?.textContent, "Sign-In Timed Out");
    assert.match(expansion.querySelector(".notice")!.className, /\bt-neutral\b/);
    assert.deepEqual(ui.buttons(expansion), ["Start Again", "Dismiss"]);
    await act(async () => { ui.button(expansion, "Start Again").click(); });
    await ui.settle();
    assert.deepEqual(api.calls[0], { kind: "login", body: { provider: "claude", label: "Studio" } });
  } finally {
    await ui.unmount();
  }
});

test("a v253 duplicate-account ending is Not Added with Dismiss only by its failure code, even with a reworded sentence (#3519)", async () => {
  const cases: [string, ProviderLoginView, boolean][] = [
    ["code, reworded sentence", { ...ended("work-2-1a2b3c4d", "Work 2", "failed",
      "That Claude login belongs to an account this machine already has; nothing was added."),
    failureCode: "account_already_on_machine" }, true],
    // What the control plane stores for a newer runner's code beside today's sentence (db.test.ts).
    ["unrecognized code, today's sentence", { ...ended("work-2-1a2b3c4d", "Work 2", "failed", DUPLICATE),
      failureCode: "unrecognized" }, false],
    ["unknown code, today's sentence", { ...ended("work-2-1a2b3c4d", "Work 2", "failed", DUPLICATE),
      failureCode: "some_future_code" as ProviderLoginView["failureCode"] }, false],
  ];
  for (const [name, login, duplicate] of cases) {
    const ui = await render({ runner: runnerView({ providerAccounts: SIGN_IN_ACCOUNTS, providerLogins: [login] }) });
    try {
      const expansion = ui.row("Work 2").nextElementSibling as HTMLElement;
      if (duplicate) {
        assert.equal(ui.badge("Work 2")?.textContent, "Not Added", name);
        assert.equal(expansion.querySelector(".notice-title")?.textContent, "Already on This Machine", name);
        assert.deepEqual(ui.buttons(expansion), ["Dismiss"], name);
      } else {
        assert.notEqual(ui.badge("Work 2")?.textContent, "Not Added", name);
        assert.equal(expansion.querySelector(".notice-title")?.textContent, "Sign-In Failed", name);
        assert.ok(ui.buttons(expansion).includes("Try Again"), name);
      }
    } finally {
      await ui.unmount();
    }
  }
});

test("a new account already on this machine reads Already on This Machine and Not Added; Dismiss removes the row and adds nothing", async () => {
  const api = client();
  const duplicate = ended("work-2-1a2b3c4d", "Work 2", "failed", DUPLICATE);
  const ui = await render({ runner: runnerView({ providerAccounts: SIGN_IN_ACCOUNTS, providerLogins: [duplicate] }), api: api.client });
  try {
    const badge = ui.badge("Work 2")!;
    assert.equal(badge.textContent, "Not Added");
    assert.match(badge.className, /\bt-neutral\b.*\bhollow\b/);
    const expansion = ui.row("Work 2").nextElementSibling as HTMLElement;
    assert.equal(expansion.querySelector(".notice-title")?.textContent, "Already on This Machine");
    assert.deepEqual(ui.buttons(expansion), ["Dismiss"]);
    assert.equal(ui.container.querySelector(".section-title")?.textContent, "Provider Accounts 3", "no account was added");
    await act(async () => { ui.button(expansion, "Dismiss").click(); });
    await ui.settle();
    assert.deepEqual(api.calls, [{ kind: "dismiss", operationId: duplicate.operationId }]);
  } finally {
    await ui.unmount();
  }
  // The dismissal is per person and durable (#2487): the next snapshot no longer lists the sign-in.
  const after = await render({ runner: runnerView({ providerAccounts: SIGN_IN_ACCOUNTS, providerLogins: [] }) });
  try {
    assert.ok(!after.rows().some((row) => row.textContent?.includes("Work 2")), "the row is gone");
    assert.equal(after.rows().length, 3);
  } finally {
    await after.unmount();
  }
});

test("a Cancel the machine refuses is a compact notice naming the account", async () => {
  const api = client({ cancel: async () => { throw new ApiError("runner is offline", 409); } });
  const ui = await render({
    runner: runnerView({ providerAccounts: SIGN_IN_ACCOUNTS, providerLogins: [runningLogin("work", "Work")] }), api: api.client,
  });
  try {
    await act(async () => { ui.button(ui.row("Work"), "Cancel").click(); });
    await ui.settle();
    assert.equal(ui.notice()?.querySelector(".notice-title")?.textContent, "Couldn't Cancel Signing In to Work");
    assert.equal(ui.error(), "runner is offline");
  } finally {
    await ui.unmount();
  }
});

// --- Row actions ---

test("a manager's ⋯ starts with the label, offers Sign In Again… on signed-in rows, and ends with Remove Account…", async () => {
  const ui = await render({ runner: runnerView({ providerAccounts: SIGN_IN_ACCOUNTS }), canManageProfiles: false });
  try {
    assert.deepEqual(ui.buttons(ui.row("Personal")).filter((name) => name === "Sign In"), ["Sign In"]);
    assert.deepEqual(ui.buttons(ui.row("Work")).filter((name) => name === "Sign In"), []);
    assert.equal(ui.more("Work")?.getAttribute("aria-label"), "More Actions for Work");
    const work = await ui.openMenu("Work");
    assert.equal(work.querySelector(".menu-label")?.textContent, "Work");
    assert.deepEqual(ui.menuItems(work).map((item) => item.label), ["Sign In Again…", "Remove Account…"]);
    assert.ok(work.querySelector(".menu-sep"), "a separator before Remove Account…");
    assert.ok(work.querySelector(".menu-item.danger")?.textContent?.includes("Remove Account…"));
    await ui.closeMenu();
    const personal = await ui.openMenu("Personal");
    assert.deepEqual(ui.menuItems(personal).map((item) => item.label), ["Remove Account…"]);
    assertNoDomNode(personal.querySelector(".menu-sep"));
    await ui.closeMenu();
  } finally {
    await ui.unmount();
  }
});

test("on a runner without removal a sign-in-required row has no ⋯, and a viewer has none at all", async () => {
  const older = await render({
    runner: runnerView({ providerAccounts: SIGN_IN_ACCOUNTS, protocolVersion: REMOVAL - 1 }), canManageProfiles: false,
  });
  try {
    assertNoDomNode(older.more("Personal"));
    const work = await older.openMenu("Work");
    assert.deepEqual(older.menuItems(work).map((item) => item.label), ["Sign In Again…"]);
    await older.closeMenu();
  } finally {
    await older.unmount();
  }
  const viewer = await render({ runner: runnerView({ providerAccounts: SIGN_IN_ACCOUNTS, canManage: false }) });
  try {
    for (const label of ["Work", "Personal", "Mystery"]) assertNoDomNode(viewer.more(label));
  } finally {
    await viewer.unmount();
  }
});

test("while Work's sign-in runs, its Remove Account… is disabled with the reason and Personal's stays enabled", async () => {
  const ui = await render({
    runner: runnerView({ providerAccounts: SIGN_IN_ACCOUNTS, providerLogins: [runningLogin("work", "Work")] }), canManageProfiles: false,
  });
  try {
    const work = await ui.openMenu("Work");
    assert.deepEqual(ui.menuItems(work), [
      { label: "Remove Account…", disabled: true, reason: "A sign-in is running. Cancel it first." },
    ]);
    await ui.closeMenu();
    const personal = await ui.openMenu("Personal");
    assert.deepEqual(ui.menuItems(personal), [{ label: "Remove Account…", disabled: false, reason: null }]);
    await ui.closeMenu();
  } finally {
    await ui.unmount();
  }
});

test("offline, Sign In Again… and Remove Account… say the machine is offline", async () => {
  const ui = await render({ runner: runnerView({ providerAccounts: SIGN_IN_ACCOUNTS }), online: false, canManageProfiles: false });
  try {
    const work = await ui.openMenu("Work");
    assert.deepEqual(ui.menuItems(work), [
      { label: "Sign In Again…", disabled: true, reason: "This machine is offline." },
      { label: "Remove Account…", disabled: true, reason: "This machine is offline." },
    ]);
    await ui.closeMenu();
    assert.equal(ui.button(ui.row("Personal"), "Sign In").disabled, true);
  } finally {
    await ui.unmount();
  }
});

test("Sign In and Sign In Again… start the account's sign-in", async () => {
  const api = client();
  const ui = await render({ runner: runnerView({ providerAccounts: SIGN_IN_ACCOUNTS }), api: api.client, canManageProfiles: false });
  try {
    await act(async () => { ui.button(ui.row("Personal"), "Sign In").click(); });
    await ui.settle();
    await ui.choose("Work", "Sign In Again…");
    assert.deepEqual(api.calls, [{ kind: "login", body: { accountId: "personal" } }, { kind: "login", body: { accountId: "work" } }]);
  } finally {
    await ui.unmount();
  }
});

// --- Removal ---

test("the removal confirmation names the account, the provider and the machine, and focuses Cancel", async () => {
  const api = client();
  const ui = await render({ runner: runnerView({ providerAccounts: SIGN_IN_ACCOUNTS }), api: api.client, canManageProfiles: false });
  try {
    await ui.choose("Work", "Remove Account…");
    const dialog = ui.dialog()!;
    assert.equal(dialog.querySelector(".modal-title, h2")?.textContent, "Remove Account");
    assert.equal(dialog.querySelector(".confirmation-message")?.textContent,
      "Work (Claude) is removed from Studio Mac, and the sign-in Wollipog stored for it is deleted. " +
      "Sessions still using it keep working, and the Claude account itself isn't affected.");
    assert.equal((domWindow.document.activeElement as unknown as HTMLElement | null)?.textContent, "Cancel");
    assertNoDomNode(dialog.querySelector(".provider-account-remove-target"));
    await act(async () => { ui.button(dialog, "Cancel").click(); });
    await ui.settle();
    assert.deepEqual(api.calls, []);
  } finally {
    await ui.unmount();
  }
});

test("under Hide Account Emails an email label stays masked in the row, the menu, the confirmation and the refusal", async () => {
  await withHiddenEmails(async () => {
    const email = "me@example.com";
    const api = client({ remove: async () => { throw new ApiError("Agent 'policy' uses this account as its default in the runner configuration. Change that setting before removing the account.", 409); } });
    const ui = await render({
      runner: runnerView({ providerAccounts: [{ id: "mail", label: email, provider: "claude", authStatus: "authenticated" }] }),
      api: api.client, canManageProfiles: false,
    });
    try {
      const row = ui.rows()[0]!;
      assert.doesNotMatch(row.textContent ?? "", /example\.com/);
      const trigger = row.querySelector('button[aria-label^="More Actions for"]')!;
      assert.equal(trigger.getAttribute("aria-label"), "More Actions for Hidden Account");
      await act(async () => { (trigger as HTMLButtonElement).click(); });
      await ui.settle();
      assert.doesNotMatch(ui.menu()?.textContent ?? "", /example\.com/);
      assert.doesNotMatch(ui.menu()?.getAttribute("aria-label") ?? "", /example\.com/);
      const remove = [...ui.menu()!.querySelectorAll<HTMLButtonElement>(".menu-item")].find((item) => item.textContent?.includes("Remove Account…"))!;
      await act(async () => { remove.click(); });
      await ui.settle();
      const dialog = ui.dialog()!;
      assert.doesNotMatch(dialog.textContent ?? "", /example\.com/);
      assert.ok(dialog.querySelector(".pid"), "the label is a masked, revealable identifier");
      await act(async () => { ui.button(dialog, "Remove Account").click(); });
      await ui.settle();
      assert.doesNotMatch(ui.notice()?.textContent ?? "", /example\.com/);
      assert.ok(ui.notice()?.querySelector(".pid"));
    } finally {
      await ui.unmount();
    }
  });
});

for (const [item, title] of [
  ["Adopt as Profile…", "Adopt as Profile"],
  ["Revoke Access…", "Revoke Access"],
  ["Remove Account…", "Remove Account"],
] as const) {
  test(`${title}: the label stays a live identifier, masked when the preference turns on and revealable when it is on`, async () => {
    const email = "me@example.com";
    const runner = runnerView({
      providerAccounts: [{ id: "mail", label: email, provider: "claude", authStatus: "authenticated", profile: { id: "p", access: "pending" } }],
    });
    const openConfirmation = async (ui: Awaited<ReturnType<typeof render>>) => {
      const trigger = ui.rows()[0]!.querySelector<HTMLButtonElement>('button[aria-label^="More Actions for"]')!;
      await act(async () => { trigger.click(); });
      await ui.settle();
      const match = [...ui.menu()!.querySelectorAll<HTMLButtonElement>(".menu-item")].find((candidate) =>
        candidate.querySelector(".menu-text")?.textContent === item)!;
      await act(async () => { match.click(); });
      await ui.settle();
      const dialog = ui.dialog()!;
      assert.equal(dialog.querySelector(".modal-title, h2")?.textContent, title);
      return dialog;
    };

    // Opened with the preference off, then turned on in Settings while the dialog is open.
    const shown = await render({ runner });
    try {
      const dialog = await openConfirmation(shown);
      assert.match(dialog.textContent ?? "", /me@example\.com/);
      await act(async () => { setHideAccountEmails(true); });
      await shown.settle();
      assert.doesNotMatch(dialog.innerHTML, /example\.com/, "the whole confirmation drops the email");
      await act(async () => { shown.button(dialog, "Cancel").click(); });
      await shown.settle();
    } finally {
      await shown.unmount();
      await act(async () => { setHideAccountEmails(false); });
    }

    // Opened with the preference on: masked, and the explicit reveal still works.
    await withHiddenEmails(async () => {
      const hidden = await render({ runner });
      try {
        const dialog = await openConfirmation(hidden);
        assert.doesNotMatch(dialog.innerHTML, /example\.com/);
        const reveal = dialog.querySelector<HTMLButtonElement>('button[aria-label="Show Account Email"]');
        assert.ok(reveal, "the masked label can be revealed");
        await act(async () => { reveal.click(); });
        await hidden.settle();
        assert.match(dialog.textContent ?? "", /me@example\.com/);
        await act(async () => { hidden.button(dialog, "Cancel").click(); });
        await hidden.settle();
      } finally {
        await hidden.unmount();
      }
    });
  });
}

test("a removal that kept credentials says so in the toast's detail line; otherwise the toast is one line", async () => {
  for (const [credentialsRetained, expected] of [
    [true, "Account removed.Its credentials were kept because a session on this machine still uses them."],
    [false, "Account removed."],
  ] as const) {
    const api = client({ remove: async () => ({ removed: true, credentialsRetained }) });
    const ui = await render({ runner: runnerView({ providerAccounts: SIGN_IN_ACCOUNTS }), api: api.client, canManageProfiles: false });
    try {
      await ui.choose("Personal", "Remove Account…");
      await act(async () => { ui.button(ui.dialog()!, "Remove Account").click(); });
      await ui.settle();
      assert.deepEqual(api.calls, [{ kind: "remove", accountId: "personal" }]);
      const toast = [...ui.body.querySelectorAll<HTMLElement>(".toast")].find((candidate) => candidate.textContent?.includes("Account removed."));
      assert.ok(toast);
      const message = toast.querySelector(".toast-message")?.textContent ?? "";
      const detail = toast.querySelector(".toast-detail")?.textContent ?? "";
      assert.equal(message + detail, expected);
    } finally {
      await ui.unmount();
    }
  }
});

test("while one account is removed only its ⋯ is busy; the other rows stay usable", async () => {
  let finish!: () => void;
  const api = client({ remove: () => new Promise((resolve) => { finish = () => resolve({ removed: true, credentialsRetained: false }); }) });
  const ui = await render({ runner: runnerView({ providerAccounts: SIGN_IN_ACCOUNTS }), api: api.client, canManageProfiles: false });
  try {
    await ui.choose("Work", "Remove Account…");
    await act(async () => { ui.button(ui.dialog()!, "Remove Account").click(); });
    await ui.settle();
    assert.equal(ui.more("Work")?.getAttribute("aria-busy"), "true");
    assert.equal(ui.more("Mystery")?.disabled, false);
    assert.equal(ui.button(ui.row("Personal"), "Sign In").disabled, false);
    await act(async () => { finish(); });
    await ui.settle();
    assert.equal(ui.more("Work")?.getAttribute("aria-busy"), null);
  } finally {
    await ui.unmount();
  }
});

test("an agent-default refusal is a notice naming the agent's display name, not its id", async () => {
  const agents = [{ id: "policy-claude", name: "Policy Claude", driver: "claude-code", source: "configured" }] as unknown as AgentDefinition[];
  const api = client({
    remove: async () => {
      throw new ApiError("Agent 'policy-claude' uses this account as its default in the runner configuration. " +
        "Change that setting before removing the account.", 409);
    },
  });
  const ui = await render({ runner: runnerView({ providerAccounts: SIGN_IN_ACCOUNTS, agents }), api: api.client, canManageProfiles: false });
  try {
    await ui.choose("Work", "Remove Account…");
    await act(async () => { ui.button(ui.dialog()!, "Remove Account").click(); });
    await ui.settle();
    const notice = ui.notice()!;
    assert.equal(notice.querySelector(".notice-title")?.textContent, "Couldn't Remove Work");
    assert.equal(ui.error(), "Policy Claude uses this account as its default in this machine's runner configuration. " +
      "Change that setting, then remove the account.");
    assert.doesNotMatch(notice.textContent ?? "", /policy-claude/);
    // Between the title and the rows.
    const order = [...ui.container.querySelectorAll(".section-head, .notice, .surface")].map((node) => node.className.split(" ")[0]);
    assert.deepEqual(order, ["section-head", "notice", "surface"]);
    await act(async () => { ui.button(notice, "Dismiss").click(); });
    await ui.settle();
    assertNoDomNode(ui.notice());
  } finally {
    await ui.unmount();
  }
});

test("removal refusals read as one sentence, the raw error behind Show Details", () => {
  assert.deepEqual(providerAccountRemovalRefusal(new ApiError(
    "A sign-in is running for this account. Cancel it before removing the account.", 409), []),
  { body: "A sign-in is running for this account. Cancel it, then remove the account." });
  assert.deepEqual(providerAccountRemovalRefusal(new ApiError("Agent 'gone' uses this account as its default in the runner configuration. x", 409), []),
    { body: "gone uses this account as its default in this machine's runner configuration. Change that setting, then remove the account." });
  assert.deepEqual(providerAccountRemovalRefusal(new ApiError("runner is offline", 409), []), { body: "This machine is offline." });
  assert.deepEqual(providerAccountRemovalRefusal(new ApiError("The account could not be removed. The HOME is locked.", 409), []),
    { body: "The account could not be removed.", details: "The account could not be removed. The HOME is locked. (HTTP 409)" });
});

// --- Add Account ---

async function openAdd(ui: Awaited<ReturnType<typeof render>>) {
  await act(async () => { ui.button(ui.container, "Add Account…").click(); });
  await ui.settle();
  const dialog = ui.dialog()!;
  assert.ok(dialog);
  const labelFor = [...dialog.querySelectorAll("label")].find((label) => label.textContent === "Account Label")!;
  const input = dialog.querySelector<HTMLInputElement>(`#${labelFor.getAttribute("for")}`)!;
  const type = async (value: string) => {
    await act(async () => {
      input.focus();
      Object.getOwnPropertyDescriptor(domWindow.HTMLInputElement.prototype, "value")!.set!.call(input, value);
      input.dispatchEvent(new domWindow.InputEvent("input", { bubbles: true }) as unknown as Event);
      // react-dom loads before these globals exist, so it detects changes on keyup.
      input.dispatchEvent(new domWindow.KeyboardEvent("keyup", { bubbles: true }) as unknown as Event);
    });
  };
  const submit = async () => {
    await act(async () => { ui.button(dialog, "Start Sign-In").click(); });
    await ui.settle();
  };
  const fieldError = () => dialog.querySelector(".field-error")?.textContent ?? null;
  return { dialog, input, type, submit, fieldError };
}

test("Add Account refuses an empty label on submit and a duplicate label under the field without a request", async () => {
  const api = client();
  const ui = await render({ runner: runnerView({ providerAccounts: SIGN_IN_ACCOUNTS }), api: api.client, canManageProfiles: false });
  try {
    const add = await openAdd(ui);
    assert.equal(add.dialog.querySelector(".modal-desc")?.textContent, "Studio Mac");
    assert.ok(add.dialog.querySelector('[role="radiogroup"]'), "Provider is a segmented control");
    assert.equal(ui.button(add.dialog, "Start Sign-In").disabled, false, "Start Sign-In stays enabled");
    await add.submit();
    assert.equal(add.fieldError(), "Enter a label, such as Work or Personal.");
    await add.type("  work ");
    assert.equal(add.fieldError(), null, "changing the label clears the error");
    await add.submit();
    assert.equal(add.fieldError(),
      "A Claude account named Work is already on this machine. Choose another label, or use Sign In Again on that account.");
    assert.equal(add.input.getAttribute("aria-invalid"), "true");
    assert.equal(domWindow.document.activeElement, add.input as never, "focus returns to the field");
    assert.deepEqual(api.calls, [], "no request was sent");
    assert.ok(ui.dialog(), "the dialog stays open");
    // The same label for the other provider is not a duplicate.
    const codex = [...add.dialog.querySelectorAll<HTMLElement>('[role="radio"]')].find((radio) => radio.textContent === "Codex")!;
    await act(async () => { codex.click(); });
    await ui.settle();
    assert.equal(add.fieldError(), null, "changing the provider clears the error");
    await add.submit();
    assert.deepEqual(api.calls, [{ kind: "login", body: { provider: "codex", label: "work" } }]);
    assertNoDomNode(ui.dialog(), "success closes the dialog");
  } finally {
    await ui.unmount();
  }
});

test("Add Account maps the runner's duplicate refusals to the field, and other failures to a notice above the footer", async () => {
  for (const [message, expected] of [
    ["A Claude account with this label is already on this Machine. Use Sign In on that account to refresh its login.",
      "A Claude account named Team is already on this machine. Choose another label, or use Sign In Again on that account."],
    ["A sign-in for an account with this label is already running.", "A sign-in for a Claude account named Team is already running."],
  ] as const) {
    const api = client({ login: async () => { throw new ApiError(message, 409); } });
    const ui = await render({ runner: runnerView({ providerAccounts: SIGN_IN_ACCOUNTS }), api: api.client, canManageProfiles: false });
    try {
      const add = await openAdd(ui);
      await add.type("Team");
      await add.submit();
      assert.equal(add.fieldError(), expected);
      assertNoDomNode(add.dialog.querySelector(".notice"));
    } finally {
      await ui.unmount();
    }
  }
  const api = client({ login: async () => { throw new ApiError("The runner did not answer.", 504); } });
  const ui = await render({ runner: runnerView({ providerAccounts: SIGN_IN_ACCOUNTS }), api: api.client, canManageProfiles: false });
  try {
    const add = await openAdd(ui);
    await add.type("Team");
    await add.submit();
    assert.equal(add.fieldError(), null);
    const notice = add.dialog.querySelector<HTMLElement>('.notice[role="alert"]')!;
    assert.equal(notice.querySelector(".notice-title")?.textContent, "Couldn't Start the Sign-In");
    assert.match(notice.textContent ?? "", /The runner did not answer\./);
  } finally {
    await ui.unmount();
  }
});

test("a label held by a running new-account sign-in is refused without a request", async () => {
  const api = client();
  const ui = await render({
    runner: runnerView({ providerAccounts: SIGN_IN_ACCOUNTS, providerLogins: [runningLogin("studio", "Studio")] }),
    api: api.client, canManageProfiles: false,
  });
  try {
    const add = await openAdd(ui);
    await add.type("studio");
    await add.submit();
    assert.equal(add.fieldError(), "A sign-in for a Claude account named Studio is already running.");
    assert.deepEqual(api.calls, []);
  } finally {
    await ui.unmount();
  }
});

test("under Hide Account Emails a duplicate email label stays masked in the field error", async () => {
  await withHiddenEmails(async () => {
    const api = client();
    const ui = await render({
      runner: runnerView({ providerAccounts: [{ id: "mail", label: "me@example.com", provider: "claude", authStatus: "authenticated" }] }),
      api: api.client, canManageProfiles: false,
    });
    try {
      const add = await openAdd(ui);
      await add.type("ME@example.com");
      await add.submit();
      const error = add.dialog.querySelector(".field-error")!;
      assert.doesNotMatch(error.textContent ?? "", /example\.com/);
      assert.ok(error.querySelector(".pid"));
      assert.deepEqual(api.calls, []);
    } finally {
      await ui.unmount();
    }
  });
});

// --- Provider profiles (#3239), now line-2 meta and ⋯ items ---

test("each profile access state is line-2 meta after the provider, and a legacy HOME has none", async () => {
  const ui = await render({ canManageProfiles: false });
  try {
    assert.deepEqual(ui.sub("Granted Work"), ["Claude", "Profile"]);
    assert.deepEqual(ui.sub("Pending Work"), ["Claude", "Grant Pending"]);
    assert.deepEqual(ui.sub("Other Work"), ["Codex", "Not Granted"]);
    assert.deepEqual(ui.sub("Legacy Work"), ["Codex"]);
    for (const label of ["Granted Work", "Other Work"]) assert.equal(ui.badge(label)?.textContent, "Signed In");
  } finally {
    await ui.unmount();
  }
});

const profileItems = async (ui: Awaited<ReturnType<typeof render>>, label: string) => {
  const opened = await ui.openMenu(label);
  const names = ui.menuItems(opened).map((item) => item.label).filter((name) => name === "Adopt as Profile…" || name === "Revoke Access…");
  await ui.closeMenu();
  return names;
};

test("Owners and Admins get Adopt as Profile… and Revoke Access… by access state on a v225 runner", async () => {
  const ui = await render({});
  try {
    assert.deepEqual(await profileItems(ui, "Granted Work"), ["Revoke Access…"]);
    assert.deepEqual(await profileItems(ui, "Pending Work"), ["Adopt as Profile…", "Revoke Access…"], "a pending grant can be retried or revoked");
    assert.deepEqual(await profileItems(ui, "Other Work"), ["Adopt as Profile…"]);
    assert.deepEqual(await profileItems(ui, "Legacy Work"), ["Adopt as Profile…"]);
    const opened = await ui.openMenu("Pending Work");
    assert.deepEqual(ui.menuItems(opened).map((item) => item.label),
      ["Sign In Again…", "Adopt as Profile…", "Revoke Access…", "Remove Account…"], "Remove Account… stays last");
    await ui.closeMenu();
  } finally {
    await ui.unmount();
  }
});

test("a Windows Machine explains that its accounts can't be adopted, and still offers Revoke Access… (#3240)", async () => {
  const ui = await render({ runner: runnerView({ os: "windows" }) });
  try {
    const opened = await ui.openMenu("Legacy Work");
    assert.deepEqual(ui.menuItems(opened).filter((item) => item.label === "Adopt as Profile…"),
      [{ label: "Adopt as Profile…", disabled: true, reason: PROFILES_UNSUPPORTED_ON_WINDOWS }]);
    await ui.closeMenu();
    assert.deepEqual(await profileItems(ui, "Granted Work"), ["Revoke Access…"]);
  } finally {
    await ui.unmount();
  }
});

test("a menu whose every item is unavailable takes focus and closes on Escape (#3240)", async () => {
  // While Work signs in on a Windows Machine, Adopt as Profile… and Remove Account… are both disabled.
  const ui = await render({
    runner: runnerView({
      os: "windows",
      providerAccounts: SIGN_IN_ACCOUNTS,
      providerLogins: [{ ...runningLogin("work", "Work"), provider: "codex", userCode: "WOLL-IPOGS",
        verificationUrl: "https://auth.openai.com/codex/device" }],
    }),
  });
  try {
    const opened = await ui.openMenu("Work");
    assert.ok(ui.menuItems(opened).every((item) => item.disabled), JSON.stringify(ui.menuItems(opened)));
    // A browser focuses the menu only when it is focusable; happy-dom focuses it either way.
    assert.equal(opened.getAttribute("tabindex"), "-1", "the menu itself can take focus");
    assert.ok((domWindow.document.activeElement as unknown) === opened, "the menu itself takes focus");
    await act(async () => {
      opened.dispatchEvent(new domWindow.KeyboardEvent("keydown", { key: "Escape", bubbles: true }) as unknown as Event);
    });
    await ui.settle();
    assertNoDomNode(ui.menu(), "Escape closes the menu");
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
      const opened = await ui.openMenu("Legacy Work");
      const names = ui.menuItems(opened).map((item) => item.label);
      await ui.closeMenu();
      assert.ok(!names.includes("Adopt as Profile…"), JSON.stringify(props));
      assert.ok(!names.includes("Revoke Access…"), JSON.stringify(props));
      assert.ok(names.includes("Remove Account…"), "account removal is still offered to a manager");
    } finally {
      await ui.unmount();
    }
  }
});

test("offline, adoption waits for the Machine while revocation stays available", async () => {
  const ui = await render({ online: false, runner: runnerView({ status: "offline" }) });
  try {
    const legacy = await ui.openMenu("Legacy Work");
    assert.deepEqual(ui.menuItems(legacy).find((item) => item.label === "Adopt as Profile…"),
      { label: "Adopt as Profile…", disabled: true, reason: "This machine is offline." });
    await ui.closeMenu();
    const granted = await ui.openMenu("Granted Work");
    assert.equal(ui.menuItems(granted).find((item) => item.label === "Revoke Access…")?.disabled, false);
    await ui.closeMenu();
  } finally {
    await ui.unmount();
  }
});

test("Adopt as Profile explains the strict grant and adopts after confirmation", async () => {
  const api = client();
  const ui = await render({ api: api.client });
  try {
    await ui.choose("Legacy Work", "Adopt as Profile…");
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

    await ui.choose("Legacy Work", "Adopt as Profile…");
    await act(async () => { ui.button(ui.dialog()!, "Adopt as Profile").click(); });
    await ui.settle();
    assert.deepEqual(api.calls, [{ kind: "adopt", accountId: "legacy" }]);
    assert.match(domWindow.document.body.textContent ?? "", /Account adopted as a profile\./);
    assert.equal(ui.error(), null);
  } finally {
    await ui.unmount();
  }
});

test("while adoption runs only that row's ⋯ is busy; the other rows stay usable", async () => {
  let finish!: () => void;
  const api = client({ adopt: () => new Promise((resolve) => { finish = () => resolve({ status: "active", profileId: "p", grantId: "g" }); }) });
  const ui = await render({ api: api.client });
  try {
    await ui.choose("Legacy Work", "Adopt as Profile…");
    await act(async () => { ui.button(ui.dialog()!, "Adopt as Profile").click(); });
    await ui.settle();
    assert.equal(ui.more("Legacy Work")?.getAttribute("aria-busy"), "true");
    assert.equal(ui.more("Granted Work")?.disabled, false);
    await act(async () => { finish(); });
    await ui.settle();
    assert.equal(ui.more("Legacy Work")?.getAttribute("aria-busy"), null);
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
    await ui.choose("Granted Work", "Revoke Access…");
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
    await ui.choose("Pending Work", "Revoke Access…");
    await act(async () => { ui.button(ui.dialog()!, "Revoke Access").click(); });
    await ui.settle();
    assert.match(ui.dialog()!.textContent ?? "", /1 active session uses this account's profile\./);
    await act(async () => { ui.button(ui.dialog()!, "Cancel").click(); });
    await ui.settle();
    assertNoDomNode(ui.dialog());
    assert.deepEqual(api.calls, [{ kind: "revoke", accountId: "pending", force: false }]);
    assert.equal(ui.error(), null);
    assert.equal(ui.more("Pending Work")?.disabled, false);
  } finally {
    await ui.unmount();
  }
});

test("a capability refusal and an adoption timeout are shown in the section's notice", async () => {
  for (const [failure, expected] of [
    [new ApiError(CAPABILITY_REFUSAL, 409, undefined, { error: CAPABILITY_REFUSAL, requiredRunnerProtocolVersion: PROFILES }), CAPABILITY_REFUSAL],
    [new ApiError("runner request timed out", 504, undefined, { status: "pending", grantId: "g" }),
      "The Machine did not confirm the adoption in time. It completes when the Machine reports the account again."],
  ] as const) {
    const api = client({ adopt: async () => { throw failure; } });
    const ui = await render({ api: api.client });
    try {
      await ui.choose("Other Work", "Adopt as Profile…");
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

// Stale lease recovery (#3241).
const LEASE_RECOVERY = RUNNER_CAPABILITY_MIN_PROTOCOL.providerHomeLeaseRecovery;
const TIP = "c".repeat(64);
const NO_REBOOT = "Wollipog can't safely unlock this account until this machine has restarted. Save your work, restart the machine, then recover the account in Connections.";

function leaseClient(options: { recover?: (accountId: string, tip: string) => Promise<unknown> } = {}) {
  const inspected: string[] = [];
  const recovered: Array<{ accountId: string; tip: string }> = [];
  const state: Record<string, ProviderHomeLeaseInspection> = {
    granted: { state: "released" },
    pending: { state: "stale", tipHash: TIP, createdAt: "2026-08-19T00:00:00.000Z", sameHost: true, hasEvidence: false, refusal: null },
    other: { state: "stale", tipHash: "d".repeat(64), createdAt: "2026-10-18T09:00:00.000Z", sameHost: true, hasEvidence: false, refusal: "NO_REBOOT_PROOF" },
    legacy: { state: "none" },
  };
  const value = {
    ...client().client,
    inspectProviderHomeLease: async (_runnerId: string, accountId: string) => { inspected.push(accountId); return state[accountId]; },
    recoverProviderHomeLease: async (_runnerId: string, accountId: string, tip: string) => {
      recovered.push({ accountId, tip });
      if (options.recover) return options.recover(accountId, tip);
      state[accountId] = { state: "released" };
      return { status: "recovered", authorizationId: "a" };
    },
  } as unknown as ApiClient;
  return { client: value, inspected, recovered, state };
}

test("authorized account diagnostics name the blocker and do not disable another usable account", async () => {
  const api = leaseClient();
  Object.assign(api.state.other!, { cause: "process_uninspectable_not_delegated",
    blockingProcess: { pid: 4242, startTime: "987654", kind: "uninspectable", cgroupMembership: "unavailable" } });
  const ui = await render({ api: api.client, runner: runnerView({ protocolVersion: 235 }) });
  try {
    const title = ui.row("Other Work").querySelector(".provider-account-lease")?.getAttribute("title") ?? "";
    assert.match(title, /can't check a running program/);
    assert.match(title, /save your work and restart the machine/);
    assert.doesNotMatch(title, /lease|journal|systemd|delegat|PID|cgroup|start time|fallback/iu);
    const menu = await ui.openMenu("Other Work");
    assert.equal(ui.menuItems(menu).find(item => item.label === "Recover Account…")?.reason, title);
    await ui.closeMenu();
    await ui.choose("Other Work", "View Recovery Details…");
    const details = ui.dialog()!;
    assert.match(details.textContent ?? "", /process_uninspectable_not_delegated/);
    assert.match(details.textContent ?? "", /PID 4242, start time 987654, uninspectable process, cgroup membership unavailable/);
    assert.match(details.textContent ?? "", /Keep the account's files and lease journal intact/);
    assert.deepEqual(api.recovered, [], "viewing diagnostics never attempts recovery");
    await act(async () => { ui.button(details, "Close").click(); });
    await ui.settle();
    const usable = await ui.openMenu("Pending Work");
    assert.equal(ui.menuItems(usable).find(item => item.label === "Recover Account…")?.disabled, false);
  } finally { await ui.unmount(); }
});

test("an Owner or Admin sees a stale lease as line-2 meta, with Recover Account… enabled only where it can proceed", async () => {
  const api = leaseClient();
  const ui = await render({ api: api.client, runner: runnerView({ protocolVersion: LEASE_RECOVERY }) });
  try {
    assert.deepEqual([...api.inspected].sort(), ["granted", "legacy", "other", "pending"]);
    assert.deepEqual(ui.sub("Pending Work"), ["Claude", "Grant Pending", "Recovery Needed"]);
    assert.deepEqual(ui.sub("Other Work"), ["Codex", "Not Granted", "Recovery Needed"]);
    assert.equal(ui.row("Other Work").querySelector(".provider-account-lease")?.getAttribute("title"), NO_REBOOT,
      "the reason a recovery would be refused is the label's tooltip");
    assert.match(ui.row("Pending Work").querySelector(".provider-account-lease")?.getAttribute("title") ?? "", /Choose Recover Account/);
    assert.deepEqual(ui.sub("Granted Work"), ["Claude", "Profile"]);
    assert.deepEqual(ui.sub("Legacy Work"), ["Codex"]);

    const pending = await ui.openMenu("Pending Work");
    assert.deepEqual(ui.menuItems(pending).find((item) => item.label === "Recover Account…"), { label: "Recover Account…", disabled: false, reason: null });
    await ui.closeMenu();
    const other = await ui.openMenu("Other Work");
    assert.deepEqual(ui.menuItems(other).find((item) => item.label === "Recover Account…"), { label: "Recover Account…", disabled: true, reason: NO_REBOOT });
    await ui.closeMenu();
    const granted = await ui.openMenu("Granted Work");
    assert.ok(!ui.menuItems(granted).some((item) => item.label === "Recover Account…"));
    await ui.closeMenu();
  } finally {
    await ui.unmount();
  }
});

test("a row that is signing in and has a stale lease keeps both: the sign-in's head and steps, and the lease on line 2 (#2996, #3241)", async () => {
  const signingIn = { providerLogins: [runningLogin("pending", "Pending Work")] };
  const api = leaseClient();
  const ui = await render({ api: api.client, runner: runnerView({ protocolVersion: LEASE_RECOVERY, ...signingIn }) });
  try {
    assert.equal(ui.badge("Pending Work")?.textContent, "Signing In");
    assert.deepEqual(ui.sub("Pending Work"), ["Claude", "Grant Pending", "Recovery Needed"]);
    assert.ok(ui.buttons(ui.row("Pending Work")).includes("Cancel"));
    assert.ok((ui.row("Pending Work").nextElementSibling as HTMLElement).querySelector(".signin"), "the sign-in expands the row");
    const menu = await ui.openMenu("Pending Work");
    const items = ui.menuItems(menu);
    assert.deepEqual(items.find((item) => item.label === "Recover Account…"), { label: "Recover Account…", disabled: false, reason: null });
    assert.deepEqual(items.find((item) => item.label === "Remove Account…"),
      { label: "Remove Account…", disabled: true, reason: "A sign-in is running. Cancel it first." });
    await ui.closeMenu();
  } finally {
    await ui.unmount();
  }
  await withHiddenEmails(async () => {
    const accounts = ACCOUNTS.map((account) => account.id === "pending" ? { ...account, label: "pending@example.com" } : account);
    const hidden = await render({
      api: leaseClient().client,
      runner: runnerView({ protocolVersion: LEASE_RECOVERY, providerAccounts: accounts,
        providerLogins: [runningLogin("pending", "pending@example.com")] }),
    });
    try {
      assert.deepEqual(hidden.sub("Signing In to Claude"), ["Email hidden", "Recovery Needed"],
        "the provider and profile give way to Email hidden, and the lease stays");
      assert.doesNotMatch(hidden.container.innerHTML, /pending@example\.com/);
    } finally {
      await hidden.unmount();
    }
  });
});

test("Recover Account… confirms with the account and record time, recovers the inspected record, and inspects again", async () => {
  const api = leaseClient();
  const ui = await render({ api: api.client, runner: runnerView({ protocolVersion: LEASE_RECOVERY }) });
  try {
    await ui.choose("Pending Work", "Recover Account…");
    const dialog = ui.dialog();
    assert.ok(dialog);
    const text = dialog.textContent ?? "";
    assert.match(text, /Recover Account/);
    assert.match(text, /An earlier Wollipog runner left this account locked\./);
    assert.match(text, /Pending Work/);
    assert.match(text, /Locked since/);
    await act(async () => { ui.button(dialog, "Cancel").click(); });
    await ui.settle();
    assert.deepEqual(api.recovered, [], "Cancel recovers nothing");

    await ui.choose("Pending Work", "Recover Account…");
    await act(async () => { ui.button(ui.dialog()!, "Recover Account").click(); });
    await ui.settle();
    assert.deepEqual(api.recovered, [{ accountId: "pending", tip: TIP }], "the exact inspected record is named");
    assert.match(domWindow.document.body.textContent ?? "", /Account unlocked\./);
    assert.deepEqual(ui.sub("Pending Work"), ["Claude", "Grant Pending"], "the account is inspected again after recovery");
    assert.equal(ui.error(), null);
  } finally {
    await ui.unmount();
  }
});

test("a refused recovery is the section's notice, and nothing is inspected without the access, capability or connection", async () => {
  const refused = leaseClient({ recover: async () => { throw new ApiError("lease changed", 409, "TIP_CHANGED"); } });
  const ui = await render({ api: refused.client, runner: runnerView({ protocolVersion: LEASE_RECOVERY }) });
  try {
    await ui.choose("Pending Work", "Recover Account…");
    await act(async () => { ui.button(ui.dialog()!, "Recover Account").click(); });
    await ui.settle();
    assert.match(ui.notice()?.textContent ?? "", /Couldn't Recover the Lease for Pending Work/);
    assert.equal(ui.error(), "The account lock changed after it was checked. Reopen this machine to check it again.");
  } finally {
    await ui.unmount();
  }
  for (const props of [
    { canManageProfiles: false, runner: runnerView({ protocolVersion: LEASE_RECOVERY }) },
    { runner: runnerView({ protocolVersion: LEASE_RECOVERY, canManage: false }) },
    { runner: runnerView({ protocolVersion: LEASE_RECOVERY - 1 }) },
    { online: false, runner: runnerView({ protocolVersion: LEASE_RECOVERY, status: "offline" }) },
  ]) {
    const api = leaseClient();
    const view = await render({ ...props, api: api.client });
    try {
      assert.deepEqual(api.inspected, [], JSON.stringify(props));
      assert.ok(!(view.sub("Pending Work").includes("Recovery Needed")));
    } finally {
      await view.unmount();
    }
  }
  const recover = (status: number, code?: string, message = "x") => providerProfileErrorMessage(new ApiError(message, status, code), "recover");
  assert.equal(recover(504), "The machine did not confirm the recovery in time. Reopen this machine to check the lease before retrying.");
  assert.equal(recover(409, "NO_REBOOT_PROOF"), NO_REBOOT);
  assert.equal(recover(409, "PROVIDER_HOME_LEASE_RECOVERY_FAILED"),
    "The machine could not confirm the recovery. Reopen this machine to check the lease before retrying.");
  assert.equal(recover(409, undefined, "runner is offline"), "The machine is offline. Recovering a lease needs the machine to be online.");
});

test("authorized recovery details respect hidden account emails", async () => {
  await withHiddenEmails(async () => {
    const api = leaseClient();
    Object.assign(api.state.other!, { cause: "process_uninspectable", blockingProcess: {
      pid: 4242, kind: "uninspectable", cgroupMembership: "unavailable",
    } });
    const ui = await render({ api: api.client, runner: runnerView({ protocolVersion: 235,
      providerAccounts: ACCOUNTS.map(account => account.id === "other" ? { ...account, label: "private@example.com" } : account),
    }) });
    try {
      const buttons = [...ui.container.querySelectorAll<HTMLButtonElement>("button[aria-label^='More Actions for']")];
      const hidden = buttons.find(button => button.getAttribute("aria-label") === "More Actions for Hidden Account");
      assert.ok(hidden);
      await act(async () => { hidden.click(); });
      await ui.settle();
      const details = [...ui.menu()!.querySelectorAll<HTMLButtonElement>("[role='menuitem']")].find(item => item.textContent === "View Recovery Details…");
      assert.ok(details);
      await act(async () => { details.click(); });
      await ui.settle();
      assert.doesNotMatch(ui.dialog()?.textContent ?? "", /private@example\.com/);
      assert.match(ui.dialog()?.textContent ?? "", /PID 4242/);
    } finally { await ui.unmount(); }
  });
});

// --- Set Up Managed Profile and Recover Existing Profile from a refused session (#3240) ---

async function typeAccountLabel(dialog: HTMLElement, value: string) {
  const labelFor = [...dialog.querySelectorAll("label")].find((label) => label.textContent === "Account Label")!;
  const input = dialog.querySelector<HTMLInputElement>(`#${labelFor.getAttribute("for")}`)!;
  await act(async () => {
    input.focus();
    Object.getOwnPropertyDescriptor(domWindow.HTMLInputElement.prototype, "value")!.set!.call(input, value);
    input.dispatchEvent(new domWindow.InputEvent("input", { bubbles: true }) as unknown as Event);
    // react-dom loads before these globals exist, so it detects changes on keyup.
    input.dispatchEvent(new domWindow.KeyboardEvent("keyup", { bubbles: true }) as unknown as Event);
  });
}

const selectedProvider = (dialog: HTMLElement) =>
  dialog.querySelector('[role="radio"][aria-checked="true"]')?.textContent?.trim();

test("Set Up Managed Profile opens Add Account for the refused session's provider, once per activation", async () => {
  const api = client({ login: async () => ({ login: { ...runningLogin("codex-new", "Codex New"), provider: "codex" } }) });
  const intent: MachineAccountsIntent = { kind: "add_account", provider: "codex", activationId: 1 };
  const ui = await render({ api: api.client, intent });
  try {
    const dialog = ui.dialog()!;
    assert.ok(dialog, "Add Account opens on arrival");
    assert.equal(selectedProvider(dialog), "Codex");
    await act(async () => { ui.button(dialog, "Cancel").click(); });
    await ui.settle();
    await ui.rerender({ intent });
    assertNoDomNode(ui.dialog(), "the same activation does not open it again");
    await ui.rerender({ intent: { ...intent, activationId: 2 } });
    assert.ok(ui.dialog(), "a new activation opens it again");
  } finally {
    await ui.unmount();
  }
});

test("Set Up Managed Profile on an offline Machine opens nothing and the section says why", async () => {
  const ui = await render({ online: false, intent: { kind: "add_account", provider: "claude", activationId: 1 } });
  try {
    assertNoDomNode(ui.dialog());
    assert.match(ui.container.textContent ?? "", /This machine is offline\./);
  } finally {
    await ui.unmount();
  }
});

test("once the sign-in it started records its account, an Owner can use it for new sessions", async () => {
  const saved: unknown[] = [];
  const base = client({ login: async () => ({ login: { ...runningLogin("codex-new", "Codex New"), provider: "codex" } }) });
  const api = {
    ...base.client,
    updateMachineProviderAccountDefault: async (runnerId: string, provider: string, body: unknown) => {
      saved.push({ runnerId, provider, body });
      return { providerAccountDefault: { provider, accountId: "codex-new", revision: 4 } };
    },
  } as unknown as ApiClient;
  const defaults = [{ provider: "codex" as const, accountId: null, revision: 3 }];
  const ui = await render({ api, runner: runnerView({ providerAccountDefaults: defaults }),
    intent: { kind: "add_account", provider: "codex", activationId: 1 } });
  try {
    const dialog = ui.dialog()!;
    await typeAccountLabel(dialog, "Codex New");
    await act(async () => { ui.button(dialog, "Start Sign-In").click(); });
    await ui.settle();
    assert.deepEqual(base.calls.filter((call) => call.kind === "login").map((call) => call.body), [{ provider: "codex", label: "Codex New" }]);
    assertNoDomNode(ui.container.querySelector('[aria-label="Use for New Sessions"]'), "not offered before the account exists");

    await ui.rerender({ runner: runnerView({ providerAccountDefaults: defaults, providerAccounts: [...ACCOUNTS,
      { id: "codex-new", label: "Codex New", provider: "codex", authStatus: "authenticated", profile: { id: "p9", access: "granted" } }] }) });
    const offer = ui.container.querySelector<HTMLElement>('[aria-label="Use for New Sessions"]');
    assert.ok(offer, "offered once the sign-in recorded the account");
    assert.match(offer.textContent ?? "", /New Codex sessions on this machine that don't choose an account will use it\./);
    await act(async () => { ui.button(offer, "Use for New Sessions").click(); });
    await ui.settle();
    assert.deepEqual(saved, [{ runnerId: "runner-1", provider: "codex", body: { accountId: "codex-new", expectedRevision: 3 } }]);
    assertNoDomNode(ui.container.querySelector('[aria-label="Use for New Sessions"]'), "the offer ends once saved");
  } finally {
    await ui.unmount();
  }
});

test("Use for New Sessions is not offered to a member who can add accounts but not save Machine defaults", async () => {
  const api = client({ login: async () => ({ login: { ...runningLogin("codex-new", "Codex New"), provider: "codex" } }) });
  const ui = await render({ api: api.client, canManageProfiles: false, intent: { kind: "add_account", provider: "codex", activationId: 1 } });
  try {
    const dialog = ui.dialog()!;
    await typeAccountLabel(dialog, "Codex New");
    await act(async () => { ui.button(dialog, "Start Sign-In").click(); });
    await ui.settle();
    assert.equal(api.calls.filter((call) => call.kind === "login").length, 1, "the member's sign-in started");
    await ui.rerender({ runner: runnerView({ providerAccounts: [...ACCOUNTS,
      { id: "codex-new", label: "Codex New", provider: "codex", authStatus: "authenticated" }] }) });
    assertNoDomNode(ui.container.querySelector('[aria-label="Use for New Sessions"]'));
  } finally {
    await ui.unmount();
  }
});

async function confirmDialog(ui: Awaited<ReturnType<typeof render>>, label: string) {
  const dialog = ui.dialog()!;
  assert.ok(dialog, "a confirmation opens");
  await act(async () => { ui.button(dialog, label).click(); });
  await ui.settle();
}

/** The lease client, with adoption recorded in the same order as recovery. */
function recoveringClient(options: Parameters<typeof leaseClient>[0] = {}) {
  const api = leaseClient(options);
  const order: string[] = [];
  const client = {
    ...api.client,
    adoptProviderProfile: async (_runnerId: string, accountId: string) => {
      order.push(`adopt:${accountId}`);
      return { status: "active", profileId: "p2", grantId: "g" };
    },
    recoverProviderHomeLease: async (runnerId: string, accountId: string, tip: string) => {
      order.push(`recover:${accountId}`);
      return (api.client as unknown as { recoverProviderHomeLease: (r: string, a: string, t: string) => Promise<unknown> })
        .recoverProviderHomeLease(runnerId, accountId, tip);
    },
  } as unknown as ApiClient;
  return { ...api, client, order };
}

test("Recover Existing Profile unlocks a stale lease, then adopts the profile, in one confirmation", async () => {
  const api = recoveringClient();
  const ui = await render({ api: api.client, runner: runnerView({ protocolVersion: LEASE_RECOVERY }),
    intent: { kind: "recover_profile", accountId: "pending", activationId: 1 } });
  try {
    const dialog = ui.dialog()!;
    assert.match(dialog.textContent ?? "", /Recover Existing Profile/);
    assert.match(dialog.textContent ?? "", /unlocks it only after checking that no earlier session is still using it, then adopts it/);
    assert.match(dialog.textContent ?? "", /Locked since/);
    await confirmDialog(ui, "Recover Existing Profile");
    // Adoption takes the HOME's lease, so another runner's stale lease is recovered first.
    assert.deepEqual(api.order, ["recover:pending", "adopt:pending"]);
    assert.deepEqual(api.recovered, [{ accountId: "pending", tip: TIP }]);
    assert.ok(ui.toasts().some((toast) => toast.includes("Profile recovered.")), ui.toasts().join("|"));
  } finally {
    await ui.unmount();
  }
});

test("Recover Existing Profile recovers exactly the lock its confirmation showed", async () => {
  const api = recoveringClient({ recover: async (_accountId, tip) => {
    if (tip !== TIP) return { status: "recovered", authorizationId: "a" };
    throw new ApiError("The lease changed", 409, "TIP_CHANGED");
  } });
  const ui = await render({ api: api.client, runner: runnerView({ protocolVersion: LEASE_RECOVERY }),
    intent: { kind: "recover_profile", accountId: "pending", activationId: 1 } });
  try {
    // While the confirmation is open, another stale record replaces the one it shows.
    api.state.pending = { ...api.state.pending!, tipHash: "e".repeat(64) };
    await confirmDialog(ui, "Recover Existing Profile");
    assert.deepEqual(api.recovered, [{ accountId: "pending", tip: TIP }], "only the confirmed record is authorized");
    assert.deepEqual(api.order, ["recover:pending"], "nothing is adopted once the recovery is refused");
    assert.match(ui.error() ?? "", /changed after it was checked/);
    assert.ok(!ui.toasts().some((toast) => /recovered|unlocked|adopted/iu.test(toast)), ui.toasts().join("|"));
  } finally {
    await ui.unmount();
  }
});

test("Recover Existing Profile explains a lock the runner refuses to recover, before asking and without adopting", async () => {
  const api = recoveringClient();
  const ui = await render({ api: api.client, runner: runnerView({ protocolVersion: LEASE_RECOVERY }),
    intent: { kind: "recover_profile", accountId: "other", activationId: 1 } });
  try {
    assertNoDomNode(ui.dialog(), "nothing to confirm");
    assert.deepEqual(api.order, []);
    assert.match(ui.error() ?? "", /until this machine has restarted/);
  } finally {
    await ui.unmount();
  }
});

for (const [label, inspect, expected] of [
  ["an inspection that fails", async () => { throw new Error("offline"); }, /couldn't check whether this account is locked/],
  ["an unverifiable lease", async () => ({ state: "unverifiable" as const }), /could not check whether this account is still in use/],
] as const) {
  test(`Recover Existing Profile reports ${label} instead of success`, async () => {
    const api = recoveringClient();
    const client = { ...api.client, inspectProviderHomeLease: inspect } as unknown as ApiClient;
    const ui = await render({ api: client, runner: runnerView({ protocolVersion: LEASE_RECOVERY }),
      intent: { kind: "recover_profile", accountId: "granted", activationId: 1 } });
    try {
      assertNoDomNode(ui.dialog());
      assert.deepEqual(api.order, []);
      assert.match(ui.error() ?? "", expected);
      assert.ok(!ui.toasts().some((toast) => /can already be used|unlocked|recovered/iu.test(toast)), ui.toasts().join("|"));
    } finally {
      await ui.unmount();
    }
  });
}

test("Recover Existing Profile waits for the viewer's permissions instead of refusing on the way", async () => {
  const api = recoveringClient();
  const intent: MachineAccountsIntent = { kind: "recover_profile", accountId: "pending", activationId: 1 };
  const ui = await render({ api: api.client, runner: runnerView({ protocolVersion: LEASE_RECOVERY }),
    canManageProfiles: false, profileAccessKnown: false, intent });
  try {
    assertNoDomNode(ui.dialog());
    assertNoDomNode(ui.notice(), "no refusal while the identity is still loading");
    await ui.rerender({ canManageProfiles: true, profileAccessKnown: true, intent });
    assert.ok(ui.dialog(), "it opens once the identity says the viewer is an Owner");
  } finally {
    await ui.unmount();
  }
});

test("Recover Existing Profile is refused with its reason for a viewer who isn't an Owner or Admin", async () => {
  const api = leaseClient();
  const ui = await render({ api: api.client, canManageProfiles: false, runner: runnerView({ protocolVersion: LEASE_RECOVERY }),
    intent: { kind: "recover_profile", accountId: "pending", activationId: 1 } });
  try {
    assertNoDomNode(ui.dialog());
    assert.equal(ui.error(), "Only an Owner or Admin can recover an account's profile.");
  } finally {
    await ui.unmount();
  }
});

test("Recover Existing Profile waits for the account it names to be listed", async () => {
  const api = leaseClient();
  const intent: MachineAccountsIntent = { kind: "recover_profile", accountId: "pending", activationId: 1 };
  const ui = await render({ api: api.client, runner: runnerView({ protocolVersion: LEASE_RECOVERY, providerAccounts: [] }), intent });
  try {
    assertNoDomNode(ui.dialog(), "nothing opens before the account is listed");
    await ui.rerender({ runner: runnerView({ protocolVersion: LEASE_RECOVERY }), intent });
    assert.ok(ui.dialog(), "it opens once the account arrives");
  } finally {
    await ui.unmount();
  }
});

// --- Copy an existing sign-in (#3719) ---

const IMPORT_RUNTIME = { dataDir: "/data", worktreeRoot: "/data/worktrees", maxConcurrentSessions: 4,
  providerCredentialImport: { version: 1 as const, providers: ["codex" as const] } };
const IMPORTING = RUNNER_CAPABILITY_MIN_PROTOCOL.providerCredentialImport;

function importClient(imported?: (body: unknown) => Promise<unknown>) {
  const base = client();
  const imports: unknown[] = [];
  const value = Object.assign(base.client, {
    importProviderCredential: async (_runnerId: string, body: unknown) => {
      imports.push(body);
      return imported ? imported(body) : { accountId: "copied-1", profileId: "p-new", grantId: "g-new" };
    },
    inspectProviderHomeLease: async () => ({ state: "none" }),
    updateMachineProviderAccountDefault: async () => ({}),
  }) as ApiClient;
  return { client: value, calls: base.calls, imports };
}

async function chooseRadio(ui: Awaited<ReturnType<typeof render>>, scope: HTMLElement, name: string) {
  const radio = [...scope.querySelectorAll<HTMLElement>('[role="radio"], input[type="radio"]')].find((candidate) =>
    (candidate.textContent || candidate.closest("label")?.textContent || "").includes(name));
  assert.ok(radio, `expected the ${name} choice`);
  await act(async () => { radio.click(); });
  await ui.settle();
}

const dialogs = () => [...(domWindow.document.body as unknown as HTMLElement).querySelectorAll<HTMLElement>('[role="dialog"]')];

test("an Owner can copy a Codex API-key sign-in after a confirmation naming the source and the new profile", async () => {
  const api = importClient();
  const ui = await render({ runner: runnerView({ protocolVersion: IMPORTING, runtime: IMPORT_RUNTIME }), api: api.client });
  try {
    const add = await openAdd(ui);
    assert.equal(add.dialog.textContent?.includes("Sign-In Method"), false, "Claude offers no copy");
    assert.match(add.dialog.textContent ?? "", /Copying an existing Claude sign-in isn't available/);
    await chooseRadio(ui, add.dialog, "Codex");
    await chooseRadio(ui, add.dialog, "Copy Existing Sign-In");
    const sources = [...add.dialog.querySelectorAll<HTMLElement>(".choice-list .choice-row, .choice-list label")]
      .map((row) => row.textContent?.trim());
    assert.ok(sources.some((text) => text?.includes("This Machine's Codex Sign-In")), JSON.stringify(sources));
    assert.ok(sources.some((text) => text?.includes("Legacy Work")), "configured Codex accounts are sources");
    assert.ok(!sources.some((text) => text?.includes("Granted Work")), "Claude accounts are not");
    await chooseRadio(ui, add.dialog, "Legacy Work");
    await add.type("Copied");
    await act(async () => { ui.button(add.dialog, "Copy Sign-In").click(); });
    await ui.settle();
    const confirmation = dialogs().at(-1)!;
    assert.notEqual(confirmation, add.dialog);
    assert.match(confirmation.textContent ?? "", /Only the API key is copied from Legacy Work into the new profile Copied on Studio Mac/);
    assert.match(confirmation.textContent ?? "", /Copy From/);
    assert.match(confirmation.textContent ?? "", /New Profile/);
    assert.deepEqual(api.imports, [], "nothing is sent before the confirmation");
    await act(async () => { ui.button(confirmation, "Copy Sign-In").click(); });
    await ui.settle();
    assert.deepEqual(api.imports, [{ provider: "codex", label: "Copied", source: { kind: "account", accountId: "legacy" }, sourceLabel: "Legacy Work" }]);
    assert.deepEqual(api.calls, [], "no sign-in started");
    assert.ok(ui.toasts().some((toast) => toast.includes("Sign-in copied to the new profile.")));
    assertNoDomNode(ui.dialog(), "success closes the dialog");
  } finally {
    await ui.unmount();
  }
});

test("declining the copy confirmation sends nothing, and a runner refusal is a notice in the dialog", async () => {
  const api = importClient(async () => { throw new ApiError("Only a Codex sign-in that uses an API key stored in auth.json can be copied.", 409); });
  const ui = await render({ runner: runnerView({ protocolVersion: IMPORTING, runtime: IMPORT_RUNTIME }), api: api.client });
  try {
    const add = await openAdd(ui);
    await chooseRadio(ui, add.dialog, "Codex");
    await chooseRadio(ui, add.dialog, "Copy Existing Sign-In");
    await add.type("Copied");
    await act(async () => { ui.button(add.dialog, "Copy Sign-In").click(); });
    await ui.settle();
    await act(async () => { ui.button(dialogs().at(-1)!, "Cancel").click(); });
    await ui.settle();
    assert.deepEqual(api.imports, []);
    assert.ok(ui.dialog(), "Add Account stays open");
    await act(async () => { ui.button(add.dialog, "Copy Sign-In").click(); });
    await ui.settle();
    await act(async () => { ui.button(dialogs().at(-1)!, "Copy Sign-In").click(); });
    await ui.settle();
    assert.deepEqual(api.imports, [{ provider: "codex", label: "Copied", source: { kind: "default_home" }, sourceLabel: "This Machine's Codex Sign-In" }]);
    const notice = add.dialog.querySelector<HTMLElement>('.notice[role="alert"]')!;
    assert.equal(notice.querySelector(".notice-title")?.textContent, "Couldn't Copy the Sign-In");
    assert.match(notice.textContent ?? "", /uses an API key stored in auth\.json/);
  } finally {
    await ui.unmount();
  }
});

test("where copying isn't available an Owner sees why, and a member sees only the sign-in", async () => {
  for (const [runner, reason] of [
    [runnerView({ os: "windows", protocolVersion: IMPORTING }), /isn't available on Windows machines/],
    [runnerView({ protocolVersion: IMPORTING - 1 }), /Update this machine's runner to copy an existing sign-in/],
    [runnerView({ protocolVersion: IMPORTING }), /runs inside WSL or a container/],
  ] as const) {
    const ui = await render({ runner, api: importClient().client });
    try {
      const add = await openAdd(ui);
      await chooseRadio(ui, add.dialog, "Codex");
      assert.equal(add.dialog.textContent?.includes("Sign-In Method"), false);
      assert.match(add.dialog.textContent ?? "", reason);
      assert.ok(ui.button(add.dialog, "Start Sign-In"));
    } finally {
      await ui.unmount();
    }
  }
  const ui = await render({ runner: runnerView({ protocolVersion: IMPORTING, runtime: IMPORT_RUNTIME }), api: importClient().client, canManageProfiles: false });
  try {
    const add = await openAdd(ui);
    await chooseRadio(ui, add.dialog, "Codex");
    assert.equal(add.dialog.textContent?.includes("Sign-In Method"), false);
    assert.equal(add.dialog.textContent?.includes("Copying an existing"), false, "members are not told about copying");
  } finally {
    await ui.unmount();
  }
});
