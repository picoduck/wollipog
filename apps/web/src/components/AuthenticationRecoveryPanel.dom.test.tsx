import assert from "node:assert/strict";
import test from "node:test";
import React, { act } from "react";
import { createRoot } from "react-dom/client";
import { Window } from "happy-dom";
import {
  RUNNER_CAPABILITY_MIN_PROTOCOL,
  type PendingApproval,
  type ProviderAuthenticationAccountOption,
  type ProviderAuthenticationCurrentIdentity,
  type RunnerView,
  type SessionView,
} from "@wollipog/protocol";
import { api, ApiError, type ApiClient } from "../api.js";
import { ApiProvider } from "../api-context.js";
import {
  AuthenticationRecoveryPanel,
  authenticationAccountChoiceApplies,
  authenticationRecoveryPanelApplies,
} from "./AuthenticationRecoveryPanel.js";
import { textBefore } from "../dom-test-assertions.js";

const domWindow = new Window({ url: "http://localhost/session/session-auth" });
domWindow.localStorage.setItem("wollipog.hide-account-emails", "true");
for (const [name, value] of Object.entries({
  window: domWindow,
  document: domWindow.document,
  navigator: domWindow.navigator,
  HTMLElement: domWindow.HTMLElement,
  HTMLButtonElement: domWindow.HTMLButtonElement,
  Element: domWindow.Element,
  Node: domWindow.Node,
  Event: domWindow.Event,
  MouseEvent: domWindow.MouseEvent,
  KeyboardEvent: domWindow.KeyboardEvent,
  getComputedStyle: domWindow.getComputedStyle.bind(domWindow),
  React,
  IS_REACT_ACT_ENVIRONMENT: true,
})) Object.defineProperty(globalThis, name, { configurable: true, writable: true, value });

const tick = () => new Promise<void>((resolve) => domWindow.setTimeout(resolve, 0));
const EMAIL = "person@example.test";
const CARD = "provider-auth:recovery-1";

const approval: PendingApproval = {
  kind: "authentication",
  requestId: CARD,
  title: "Authentication Required — Claude Code",
  options: [{ optionId: "auth:revalidate", name: "Recheck Authentication", kind: "allow_once" }],
};

function session(overrides: Partial<SessionView> = {}): SessionView {
  return {
    id: "session-auth",
    runnerId: "runner-1",
    title: "Session",
    status: "input_required",
    driver: "claude-code",
    providerAccountId: "claude-work",
    providerAccountLabel: "Claude Work",
    pendingApproval: approval,
    ...overrides,
  } as SessionView;
}

function runner(overrides: Partial<RunnerView> = {}): RunnerView {
  return {
    runnerId: "runner-1",
    protocolVersion: RUNNER_CAPABILITY_MIN_PROTOCOL.providerAuthenticationAccountRecovery,
    canManage: true,
    providerAccounts: [],
    providerLogins: [],
    ...overrides,
  } as unknown as RunnerView;
}

const accounts: ProviderAuthenticationAccountOption[] = [
  { id: "claude-work", label: "Claude Work", authStatus: "authenticated", availability: "current" },
  { id: "claude-personal", label: "Claude Personal", authStatus: "authenticated", availability: "available" },
  { id: "claude-old", label: "Claude Old", authStatus: "unauthenticated", availability: "sign_in_required" },
  { id: "claude-maybe", label: "Claude Maybe", authStatus: "unknown", availability: "status_unknown" },
];

function client(options: {
  identity?: ProviderAuthenticationCurrentIdentity;
  select?: (input: { requestId: string; providerAccountId: string; expectedProviderAccountId: string }) => Promise<void>;
} = {}) {
  const calls = { identity: 0, accounts: 0, selections: [] as unknown[], signIns: [] as unknown[] };
  const value = {
    ...api,
    authenticationCurrentIdentity: async (_id: string, requestId: string) => {
      assert.equal(requestId, CARD);
      calls.identity += 1;
      return {
        identity: options.identity ??
          { status: "authenticated" as const, emailSupported: true, email: EMAIL, observedAt: Date.now() - 2 * 60_000 },
      };
    },
    authenticationAccounts: async () => {
      calls.accounts += 1;
      return { accounts };
    },
    selectAuthenticationAccount: async (
      _id: string,
      input: { requestId: string; providerAccountId: string; expectedProviderAccountId: string },
    ) => {
      calls.selections.push(input);
      await options.select?.(input);
      return { accepted: true as const };
    },
    startProviderLogin: async (_runnerId: string, input: unknown) => {
      calls.signIns.push(input);
      return {} as never;
    },
  } as ApiClient;
  return { value, calls };
}

/** A fact's value, by its Title Case label. */
function fact(container: HTMLElement, label: string): HTMLElement | null {
  const term = [...container.querySelectorAll("dt")].find((dt) => dt.textContent === label);
  return (term?.nextElementSibling as HTMLElement | null) ?? null;
}

async function render(element: React.ReactElement, apiClient: ApiClient) {
  const container = domWindow.document.createElement("div") as unknown as HTMLDivElement;
  domWindow.document.body.append(container as never);
  const root = createRoot(container);
  const draw = async (next: React.ReactElement) => {
    await act(async () => {
      root.render(<ApiProvider client={apiClient}>{next}</ApiProvider>);
      await tick();
      await tick();
    });
  };
  await draw(element);
  return {
    container,
    draw,
    button: (name: string) => [...container.querySelectorAll<HTMLButtonElement>("button")]
      .find((button) => (button.getAttribute("aria-label") ?? button.textContent?.trim()) === name),
    cleanup: async () => {
      await act(async () => root.unmount());
      container.remove();
    },
  };
}

test("the facts keep the provider email hidden until Show Email, which reveals only Signed In Now", async () => {
  const api = client();
  const view = await render(
    <AuthenticationRecoveryPanel
      session={session({ providerAccountLabel: "work@example.test" })}
      approval={approval}
      runner={runner()}
      runnerOnline
    />,
    api.value,
  );
  try {
    assert.equal(api.calls.identity, 1);
    assert.equal(view.container.innerHTML.includes(EMAIL), false, "the hidden email is absent from text and attributes");
    assert.equal(view.container.innerHTML.includes("work@example.test"), false, "so is an email-shaped session label");
    assert.deepEqual([...view.container.querySelectorAll("dt")].map((dt) => dt.textContent),
      ["This Session Uses", "Signed In Now", "Last Checked"]);
    // The configured label is never presented as verified: its help says so.
    assert.match(fact(view.container, "This Session Uses")!.textContent ?? "",
      /A name chosen on this machine; the provider has not confirmed it\./);
    assert.equal(fact(view.container, "Last Checked")!.textContent, "2m ago");
    assert.equal(view.container.querySelector("[title]")?.outerHTML ?? null, null, "no title tooltips");

    const reveal = view.button("Show Email");
    assert.ok(reveal);
    await act(async () => { reveal.click(); await tick(); });
    assert.equal(fact(view.container, "Signed In Now")!.textContent?.includes(EMAIL), true);
    assert.equal(view.container.innerHTML.includes("work@example.test"), false, "Show Email reveals only Signed In Now");
    const hide = view.button("Hide Email");
    assert.ok(hide);
    await act(async () => { hide.click(); await tick(); });
    assert.equal(view.container.innerHTML.includes(EMAIL), false);
  } finally {
    await view.cleanup();
  }
});

test("Signed In Now says what the provider reported instead of inferring an account", async () => {
  const cases: Array<[ProviderAuthenticationCurrentIdentity, string]> = [
    [{ status: "authenticated", emailSupported: true, email: null, observedAt: 1 }, "Claude Code didn't supply an account email."],
    [{ status: "authenticated", emailSupported: false, email: null, observedAt: 1 }, "Claude Code doesn't report an account email."],
    [{ status: "unauthenticated", emailSupported: true, email: null, observedAt: 1 }, "No account"],
    [{ status: "unknown", emailSupported: true, email: null, observedAt: 1 }, "Claude Code couldn't confirm the account."],
  ];
  for (const [identity, expected] of cases) {
    const api = client({ identity });
    const view = await render(
      <AuthenticationRecoveryPanel session={session()} approval={approval} runner={runner()} runnerOnline />,
      api.value,
    );
    try {
      assert.equal(fact(view.container, "Signed In Now")!.textContent, expected);
      assert.equal(view.button("Show Email"), undefined);
    } finally {
      await view.cleanup();
    }
  }
});

test("the sentence under the facts names the situation and what the primary does", async () => {
  const extra = {
    different: [{ optionId: "auth:accept-current", name: "Use Current Account", kind: "allow_once" }],
    signedOut: [{ optionId: "auth:login", name: "Start Sign-In", kind: "allow_once" }],
    readOnly: [],
  } as const;
  const expected = {
    different: "Claude Code is signed in to a different account than this session uses. Use Current Account continues " +
      "this session with it.",
    signedOut: "Claude Code is signed out. Start Sign-In signs in on this machine, and the session continues.",
    readOnly: "Wollipog can't start a sign-in here. Sign in to Claude Code on the machine as the request details " +
      "describe, then choose Recheck Authentication.",
  };
  for (const key of ["different", "signedOut", "readOnly"] as const) {
    const request = { ...approval, options: [...extra[key], ...approval.options] } as PendingApproval;
    const view = await render(
      <AuthenticationRecoveryPanel session={session()} approval={request} runner={runner()} runnerOnline />,
      client().value,
    );
    try {
      assert.equal(view.container.querySelector(".sign-in-sentence")?.textContent, expected[key], key);
    } finally {
      await view.cleanup();
    }
  }
});

test("the sentence never claims a mismatch Signed In Now cannot show", async () => {
  const different = { ...approval, options: [
    { optionId: "auth:accept-current", name: "Use Current Account", kind: "allow_once" }, ...approval.options,
  ] } as PendingApproval;
  const older = await render(
    <AuthenticationRecoveryPanel session={session()} approval={different}
      runner={runner({ protocolVersion: RUNNER_CAPABILITY_MIN_PROTOCOL.providerAuthenticationAccountRecovery - 1 })}
      runnerOnline />,
    client().value,
  );
  try {
    assert.equal(older.container.querySelector(".sign-in-sentence")?.textContent,
      "This machine's runner can't tell which account Claude Code uses. Use Current Account continues this session " +
      "with whatever account Claude Code is signed in to.");
  } finally {
    await older.cleanup();
  }
  // While the check runs, the sentence says so; then it states only what Signed In Now shows.
  let resolve: (identity: ProviderAuthenticationCurrentIdentity) => void = () => undefined;
  const deferred = {
    ...client().value,
    authenticationCurrentIdentity: () => new Promise<{ identity: ProviderAuthenticationCurrentIdentity }>((done) => {
      resolve = (identity) => done({ identity });
    }),
  } as ApiClient;
  const checking = await render(
    <AuthenticationRecoveryPanel session={session()} approval={different} runner={runner()} runnerOnline />, deferred);
  try {
    assert.match(checking.container.querySelector(".sign-in-sentence")?.textContent ?? "",
      /^Checking which account Claude Code uses\. Use Current Account continues/);
    await act(async () => { resolve({ status: "authenticated", emailSupported: true, email: EMAIL, observedAt: 1 }); await tick(); });
    assert.match(checking.container.querySelector(".sign-in-sentence")?.textContent ?? "",
      /^Claude Code is signed in to a different account than this session uses\./, "an email shown: the mismatch is a fact");
  } finally {
    await checking.cleanup();
  }
  for (const identity of [
    { status: "unknown" as const, emailSupported: true, email: null, observedAt: 1 },
    { status: "unauthenticated" as const, emailSupported: true, email: null, observedAt: 1 },
    { status: "authenticated" as const, emailSupported: true, email: null, observedAt: 1 },
    { status: "authenticated" as const, emailSupported: false, email: null, observedAt: 1 },
  ]) {
    const view = await render(
      <AuthenticationRecoveryPanel session={session()} approval={different} runner={runner()} runnerOnline />,
      client({ identity }).value,
    );
    try {
      assert.match(view.container.querySelector(".sign-in-sentence")?.textContent ?? "",
        /^Wollipog couldn't check which account Claude Code uses\./, JSON.stringify(identity));
    } finally {
      await view.cleanup();
    }
  }
});

test("Check Again runs the recheck, then reads the identity again; it is absent without one", async () => {
  const api = client();
  const runs: string[] = [];
  const view = await render(
    <AuthenticationRecoveryPanel
      session={session()}
      approval={approval}
      runner={runner()}
      runnerOnline
      recheck={{ run: async () => { runs.push("auth:revalidate"); }, busy: false, disabled: false }}
    />,
    api.value,
  );
  try {
    const check = view.button("Check Again");
    assert.ok(check && fact(view.container, "Last Checked")!.contains(check), "Check Again is on the Last Checked fact");
    assert.ok(check.classList.contains("sm") && check.classList.contains("ghost"));
    await act(async () => { check.click(); await tick(); await tick(); });
    assert.deepEqual(runs, ["auth:revalidate"]);
    assert.equal(api.calls.identity, 2);
    await view.draw(<AuthenticationRecoveryPanel session={session()} approval={approval} runner={runner()} runnerOnline />);
    assert.equal(view.button("Check Again"), undefined, "Recheck Authentication is the card's primary instead");
  } finally {
    await view.cleanup();
  }
});

test("while a sign-in runs only the session's account is a fact, and the sign-in renders below", async () => {
  const api = client();
  const signingIn = { ...approval, title: "Signing In — Claude Code",
    options: [{ optionId: "auth:cancel", name: "Cancel Sign-In", kind: "reject_once" }] } as PendingApproval;
  const login = { operationId: "op-1", accountId: "claude-work", label: "Claude Work", provider: "claude",
    status: "awaiting_code", expectsCode: true, sessionId: "session-auth", startedAt: 1 };
  const view = await render(
    <AuthenticationRecoveryPanel session={session()} approval={signingIn}
      runner={runner({ providerLogins: [login] } as unknown as Partial<RunnerView>)} runnerOnline />,
    api.value,
  );
  try {
    assert.deepEqual([...view.container.querySelectorAll("dt")].map((dt) => dt.textContent), ["This Session Uses"]);
    assert.equal(api.calls.identity, 0);
    const card = view.container.querySelector<HTMLElement>(".provider-login-card");
    assert.ok(card);
    assert.equal(card.dataset.embedded, "true");
    assert.deepEqual([...card.querySelectorAll("button")].map((button) => button.textContent), ["Submit Code"],
      "the card's Cancel Sign-In is the only cancel");
    assert.equal(card.querySelector(".primary")?.outerHTML ?? null, null);
    assert.equal(card.querySelector(".provider-login-head")?.outerHTML ?? null, null,
      "This Session Uses already names the account; the sentence carries the status");
    assert.equal(view.container.querySelector(".sign-in-sentence")?.textContent,
      "Sign in to Claude Code with Open Provider Sign-In, then paste the authorization code here.");
  } finally {
    await view.cleanup();
  }
});

test("the other accounts list with their status and next action, and selection names the card", async () => {
  const api = client();
  const view = await render(
    <AuthenticationRecoveryPanel session={session()} approval={approval} runner={runner()} runnerOnline choosingAccount />,
    api.value,
  );
  try {
    const rows = [...view.container.querySelectorAll<HTMLElement>(".auth-recovery-account")];
    assert.deepEqual(rows.map((row) => row.dataset.availability), ["available", "sign_in_required", "status_unknown"],
      "the current account is not offered as an alternative");
    assert.match(rows[0]!.textContent ?? "", /Claude Personal.*Signed In/);
    assert.match(rows[1]!.textContent ?? "", /Claude Old.*Sign-In Required.*signed out/);
    assert.match(rows[2]!.textContent ?? "", /Claude Maybe.*Status Unknown/);
    assert.equal(view.container.querySelector(".atag")?.outerHTML ?? null, null);
    assert.equal(view.container.querySelector(".auth-recovery-account .primary")?.outerHTML ?? null, null,
      "the card's footer holds its one primary");
    assert.ok(view.button("Check and Use Claude Old"), "a signed-out account can still be rechecked");
    assert.ok(view.button("Check and Use Claude Maybe"));

    const signIn = [...rows[1]!.querySelectorAll<HTMLButtonElement>("button")]
      .find((button) => button.textContent?.trim() === "Sign In");
    assert.ok(signIn, "a Machine manager can start sign-in for a signed-out account from the card");
    await act(async () => { signIn.click(); await tick(); });
    assert.deepEqual(api.calls.signIns, [{ accountId: "claude-old" }]);

    const use = view.button("Use Claude Personal");
    assert.ok(use);
    await act(async () => { use.click(); await tick(); });
    assert.deepEqual(api.calls.selections, [{
      requestId: CARD,
      providerAccountId: "claude-personal",
      expectedProviderAccountId: "claude-work",
    }]);
  } finally {
    await view.cleanup();
  }
});

test("email-shaped account labels stay masked and are named by distinct hidden ordinals", async () => {
  const api = client();
  const emailLabels = { ...api.value, authenticationAccounts: async () => ({ accounts: [
    { id: "claude-work", label: "work@example.test", authStatus: "authenticated" as const, availability: "current" as const },
    { id: "claude-a", label: "alex@example.test", authStatus: "authenticated" as const, availability: "available" as const },
    { id: "claude-b", label: "blair@example.test", authStatus: "unknown" as const, availability: "status_unknown" as const },
  ] }) } as ApiClient;
  const view = await render(
    <AuthenticationRecoveryPanel
      session={session({ providerAccountLabel: "work@example.test" })}
      approval={approval}
      runner={runner()}
      runnerOnline
      choosingAccount
    />,
    emailLabels,
  );
  try {
    const html = view.container.innerHTML;
    for (const label of ["work@example.test", "alex@example.test", "blair@example.test"]) {
      assert.equal(html.includes(label), false, `${label} is absent before reveal`);
    }
    assert.ok(view.button("Use Hidden Account 1"));
    assert.ok(view.button("Check and Use Hidden Account 2"));

    // #1954: no mask stands alone. Each says what it hides and follows a visible label.
    const masks = [...view.container.querySelectorAll(".pid-mask")];
    assert.ok(masks.every((mask) => mask.textContent === "Email Hidden"));
    for (const label of ["This Session Uses", "Signed In Now"]) {
      const value = fact(view.container, label)!;
      assert.equal(textBefore(value.parentElement!, value.querySelector(".pid-mask")!), label);
    }
    const rows = [...view.container.querySelectorAll(".auth-recovery-account")];
    assert.equal(rows.length, 2);
    for (const row of rows) assert.equal(textBefore(row, row.querySelector(".pid-mask")!), "Account");
    assert.equal(masks.length, 4, "the reported email, the configured label, and both other accounts");
    assert.equal(view.container.querySelector("button[title]")?.outerHTML ?? null, null, "no button has a title");
  } finally {
    await view.cleanup();
  }
});

test("a viewer who cannot manage the Machine is told who can sign the account in", async () => {
  const api = client();
  const view = await render(
    <AuthenticationRecoveryPanel session={session()} approval={approval} runner={runner({ canManage: false })} runnerOnline
      choosingAccount />,
    api.value,
  );
  try {
    const row = view.container.querySelector<HTMLElement>('[data-availability="sign_in_required"]');
    assert.match(row?.textContent ?? "", /Ask a machine owner or organization admin to sign in to it/);
    assert.equal([...row!.querySelectorAll("button")].some((button) => button.textContent?.trim() === "Sign In"), false);
  } finally {
    await view.cleanup();
  }
});

test("an account change while the card is open discards the old identity and fetches it again", async () => {
  const api = client();
  const view = await render(
    <AuthenticationRecoveryPanel session={session()} approval={approval} runner={runner()} runnerOnline />,
    api.value,
  );
  try {
    await act(async () => { view.button("Show Email")!.click(); await tick(); });
    assert.ok(view.container.innerHTML.includes(EMAIL));
    await view.draw(
      <AuthenticationRecoveryPanel
        session={session({ providerAccountId: "claude-personal", providerAccountLabel: "Claude Personal" })}
        approval={approval}
        runner={runner()}
        runnerOnline
      />,
    );
    assert.equal(api.calls.identity, 2);
    assert.equal(view.container.innerHTML.includes(EMAIL), false, "a revealed email is hidden again for the new state");
  } finally {
    await view.cleanup();
  }
});

test("a refused selection explains itself and refreshes when the card or account changed", async () => {
  const api = client({
    select: async () => {
      throw new ApiError("The session's configured account changed while this card was open.", 409, "account_changed");
    },
  });
  const view = await render(
    <AuthenticationRecoveryPanel session={session()} approval={approval} runner={runner()} runnerOnline choosingAccount />,
    api.value,
  );
  try {
    await act(async () => { view.button("Use Claude Personal")!.click(); await tick(); await tick(); });
    const row = view.container.querySelector<HTMLElement>('[data-availability="available"]');
    assert.match(row?.querySelector('[role="alert"]')?.textContent ?? "", /configured account changed/,
      "the refusal renders in the chosen account's row, beside the control that was used");
    assert.equal(api.calls.identity, 2);
  } finally {
    await view.cleanup();
  }
});

test("offline and older runners keep the card usable with clear guidance and no identity request", async () => {
  const offline = client();
  const offlineView = await render(
    <AuthenticationRecoveryPanel session={session()} approval={approval} runner={runner()} runnerOnline={false} choosingAccount />,
    offline.value,
  );
  try {
    assert.equal(fact(offlineView.container, "Signed In Now")!.textContent, "Unknown while the runner is offline.");
    assert.match(offlineView.container.textContent ?? "", /The runner is offline\. Accounts will load when it reconnects\./);
    assert.equal(offline.calls.identity + offline.calls.accounts, 0);
  } finally {
    await offlineView.cleanup();
  }

  const older = client();
  const olderRunner = runner({ protocolVersion: RUNNER_CAPABILITY_MIN_PROTOCOL.providerAuthenticationAccountRecovery - 1 });
  const olderView = await render(
    <AuthenticationRecoveryPanel session={session()} approval={approval} runner={olderRunner} runnerOnline />,
    older.value,
  );
  try {
    assert.match(fact(olderView.container, "Signed In Now")!.textContent ?? "",
      /This machine's runner can't report the signed-in account\. Update and restart the runner to see it\./);
    assert.equal(fact(olderView.container, "Last Checked")!.textContent, "Not checked");
    assert.equal(older.calls.identity + older.calls.accounts, 0);
    assert.equal(authenticationAccountChoiceApplies(session(), approval, olderRunner), false,
      "an older runner cannot switch accounts, so the card offers no Choose Another Account…");
  } finally {
    await olderView.cleanup();
  }
});

test("the account panel applies only to open provider recovery, not to retained-message follow-ups", () => {
  assert.equal(authenticationRecoveryPanelApplies(session(), approval), true);
  assert.equal(authenticationRecoveryPanelApplies(session(), {
    ...approval,
    requestId: `${CARD}:retained-messages`,
  }), false);
  assert.equal(authenticationRecoveryPanelApplies(session({ driver: "acp" }), approval), false);
  assert.equal(authenticationRecoveryPanelApplies(session(), {
    ...approval,
    options: [{ optionId: "auth:dismiss", name: "Dismiss Recovery", kind: "reject_once" }],
  }), false, "a dismiss-only card from an unprobeable context has no runner recovery to act on");
});

test("Choose Another Account… applies only where the session can switch accounts", () => {
  assert.equal(authenticationAccountChoiceApplies(session(), approval, runner()), true);
  assert.equal(authenticationAccountChoiceApplies(session({ providerAccountId: undefined }), approval, runner()), false,
    "a session on the machine's default sign-in has no account to switch from (#1743)");
  assert.equal(authenticationAccountChoiceApplies(session(), {
    ...approval,
    options: [{ optionId: "auth:cancel", name: "Cancel Sign-In", kind: "reject_once" }],
  }, runner()), false, "not while a sign-in runs");
});
