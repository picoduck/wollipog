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
import { AuthenticationRecoveryPanel, authenticationRecoveryPanelApplies } from "./AuthenticationRecoveryPanel.js";

const domWindow = new Window({ url: "http://localhost/session/session-auth" });
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
          { status: "authenticated" as const, emailSupported: true, email: EMAIL, observedAt: Date.UTC(2026, 8, 23, 17, 4) },
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

test("the card keeps the provider email hidden until revealed and never calls the label verified", async () => {
  const api = client();
  const view = await render(
    <AuthenticationRecoveryPanel session={session()} approval={approval} runner={runner()} runnerOnline />,
    api.value,
  );
  try {
    assert.equal(api.calls.identity, 1);
    assert.equal(view.container.innerHTML.includes(EMAIL), false, "the hidden email is absent from text and attributes");
    const text = view.container.textContent ?? "";
    assert.match(text, /Provider-Reported Account/);
    assert.match(text, /Configured Account/);
    assert.match(text, /Claude Work/);
    assert.match(text, /A label chosen on this Machine\. The provider has not verified it\./);

    const reveal = view.button("Show Current Account Email");
    assert.ok(reveal);
    await act(async () => { reveal.click(); await tick(); });
    assert.match(view.container.textContent ?? "", new RegExp(EMAIL.replace(".", "\\.")));
    const hide = view.button("Hide Current Account Email");
    assert.ok(hide);
    await act(async () => { hide.click(); await tick(); });
    assert.equal(view.container.innerHTML.includes(EMAIL), false);
  } finally {
    await view.cleanup();
  }
});

test("the card says when the provider supplied no email instead of inferring one", async () => {
  const api = client({ identity: { status: "authenticated", emailSupported: true, email: null, observedAt: 1 } });
  const view = await render(
    <AuthenticationRecoveryPanel session={session()} approval={approval} runner={runner()} runnerOnline />,
    api.value,
  );
  try {
    assert.match(view.container.textContent ?? "",
      /Claude Code did not supply an account email, so its identity cannot be displayed\./);
    assert.equal(view.button("Show Current Account Email"), undefined);
  } finally {
    await view.cleanup();
  }
});

test("every other account stays visible with its status and next action, and selection names the card", async () => {
  const api = client();
  const view = await render(
    <AuthenticationRecoveryPanel session={session()} approval={approval} runner={runner()} runnerOnline />,
    api.value,
  );
  try {
    const rows = [...view.container.querySelectorAll<HTMLElement>(".auth-recovery-account")];
    assert.deepEqual(rows.map((row) => row.dataset.availability), ["available", "sign_in_required", "status_unknown"],
      "the current account is not offered as an alternative");
    assert.match(rows[0]!.textContent ?? "", /Claude Personal.*Signed In/);
    assert.match(rows[1]!.textContent ?? "", /Claude Old.*Sign-In Required.*signed out/);
    assert.match(rows[2]!.textContent ?? "", /Claude Maybe.*Status Unknown/);
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
  } finally {
    await view.cleanup();
  }
});

test("a viewer who cannot manage the Machine is told who can sign the account in", async () => {
  const api = client();
  const view = await render(
    <AuthenticationRecoveryPanel session={session()} approval={approval} runner={runner({ canManage: false })} runnerOnline />,
    api.value,
  );
  try {
    const row = view.container.querySelector<HTMLElement>('[data-availability="sign_in_required"]');
    assert.match(row?.textContent ?? "", /Ask a Machine owner or organization admin to sign in to it/);
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
    await act(async () => { view.button("Show Current Account Email")!.click(); await tick(); });
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
    <AuthenticationRecoveryPanel session={session()} approval={approval} runner={runner()} runnerOnline />,
    api.value,
  );
  try {
    await act(async () => { view.button("Use Claude Personal")!.click(); await tick(); await tick(); });
    assert.match(view.container.querySelector('[role="alert"]')?.textContent ?? "", /configured account changed/);
    assert.equal(api.calls.identity, 2);
  } finally {
    await view.cleanup();
  }
});

test("offline and older runners keep the card usable with clear guidance and no identity request", async () => {
  const offline = client();
  const offlineView = await render(
    <AuthenticationRecoveryPanel session={session()} approval={approval} runner={runner()} runnerOnline={false} />,
    offline.value,
  );
  try {
    assert.match(offlineView.container.textContent ?? "", /The runner is offline/);
    assert.equal(offline.calls.identity + offline.calls.accounts, 0);
  } finally {
    await offlineView.cleanup();
  }

  const older = client();
  const olderView = await render(
    <AuthenticationRecoveryPanel
      session={session()}
      approval={approval}
      runner={runner({ protocolVersion: RUNNER_CAPABILITY_MIN_PROTOCOL.providerAuthenticationAccountRecovery - 1 })}
      runnerOnline
    />,
    older.value,
  );
  try {
    assert.match(olderView.container.textContent ?? "", /Update and restart the runner, or use this card's other actions\./);
    assert.equal(older.calls.identity + older.calls.accounts, 0);
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
