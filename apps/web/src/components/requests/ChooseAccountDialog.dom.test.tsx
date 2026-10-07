import assert from "node:assert/strict";
import test from "node:test";
import React, { act } from "react";
import { createRoot } from "react-dom/client";
import { Window } from "happy-dom";
import {
  RUNNER_CAPABILITY_MIN_PROTOCOL,
  type PendingApproval,
  type ProviderAccountDefinition,
  type ProviderAuthenticationAccountOption,
  type RunnerView,
  type SessionView,
} from "@wollipog/protocol";
import { api, ApiError, type ApiClient } from "../../api.js";
import { ApiProvider } from "../../api-context.js";
import { assertNoDomNode } from "../../dom-test-assertions.js";
import { installDomTestCleanup } from "../../dom-test-cleanup.js";
import { ChooseAccountDialog, type ChooseAccountResult } from "./ChooseAccountDialog.js";

const domWindow = new Window({ url: "http://localhost/session/session-auth" });
installDomTestCleanup(domWindow);
domWindow.localStorage.setItem("wollipog.hide-account-emails", "true");
for (const [name, value] of Object.entries({
  window: domWindow,
  document: domWindow.document,
  navigator: domWindow.navigator,
  localStorage: domWindow.localStorage,
  HTMLElement: domWindow.HTMLElement,
  HTMLButtonElement: domWindow.HTMLButtonElement,
  HTMLInputElement: domWindow.HTMLInputElement,
  Element: domWindow.Element,
  Node: domWindow.Node,
  Event: domWindow.Event,
  MouseEvent: domWindow.MouseEvent,
  KeyboardEvent: domWindow.KeyboardEvent,
  FocusEvent: domWindow.FocusEvent,
  getComputedStyle: domWindow.getComputedStyle.bind(domWindow),
  requestAnimationFrame: domWindow.requestAnimationFrame.bind(domWindow),
  cancelAnimationFrame: domWindow.cancelAnimationFrame.bind(domWindow),
  React,
  IS_REACT_ACT_ENVIRONMENT: true,
})) Object.defineProperty(globalThis, name, { configurable: true, writable: true, value });

const tick = () => new Promise<void>((resolve) => domWindow.setTimeout(resolve, 0));
/** What has focus, as a short description: comparing DOM nodes directly makes a failure unreadable. */
function focused(): string {
  const active = domWindow.document.activeElement as unknown as HTMLElement | null;
  if (active?.tagName === "INPUT" && active.getAttribute("type") === "radio") {
    const title = active.closest(".choice-row")?.querySelector(".choice-row-title")?.firstChild?.textContent;
    return `radio ${title}`;
  }
  return `${active?.tagName.toLowerCase()} ${active?.textContent?.trim() ?? ""}`.trim();
}
const CARD = "provider-auth:recovery-1";

const approval: PendingApproval = {
  kind: "authentication",
  requestId: CARD,
  title: "Authentication Required — Claude Code",
  options: [
    { optionId: "auth:accept-current", name: "Use Current Account", kind: "allow_once" },
    { optionId: "auth:revalidate", name: "Recheck Authentication", kind: "allow_once" },
  ],
};

const session = {
  id: "session-auth",
  runnerId: "runner-1",
  title: "Session",
  status: "input_required",
  driver: "claude-code",
  providerAccountId: "claude-work",
  providerAccountLabel: "Claude Work",
  pendingApproval: approval,
} as SessionView;

type Option = ProviderAuthenticationAccountOption;
const WORK: Option = { id: "claude-work", label: "Claude Work", authStatus: "authenticated", availability: "current" };
const PERSONAL: Option = { id: "claude-personal", label: "Claude Personal", authStatus: "authenticated", availability: "available" };
const OLD: Option = { id: "claude-old", label: "Claude Old", authStatus: "unauthenticated", availability: "sign_in_required" };
const MAYBE: Option = { id: "claude-maybe", label: "Claude Maybe", authStatus: "unknown", availability: "status_unknown" };

function inventory(options: readonly Option[]): ProviderAccountDefinition[] {
  return options.map((option) => ({ id: option.id, label: option.label, provider: "claude", authStatus: option.authStatus }));
}

function runner(options: readonly Option[], overrides: Partial<RunnerView> = {}): RunnerView {
  return {
    runnerId: "runner-1",
    protocolVersion: RUNNER_CAPABILITY_MIN_PROTOCOL.providerAuthenticationAccountRecovery,
    canManage: true,
    providerAccounts: inventory(options),
    providerLogins: [],
    ...overrides,
  } as unknown as RunnerView;
}

interface Rendered {
  dialog: () => HTMLElement | null;
  button: (name: string) => HTMLButtonElement | undefined;
  radio: (name: string) => HTMLInputElement | undefined;
  row: (name: string) => HTMLElement | undefined;
  results: ChooseAccountResult[];
  selections: unknown[];
  signIns: unknown[];
  connections: () => number;
  /** The server's list from now on, and the dashboard's inventory with it. */
  setAccounts: (next: readonly Option[], runnerOverrides?: Partial<RunnerView>) => Promise<void>;
  /** The server's list from now on, without a render: what the dialog's next refetch reads. */
  setListed: (next: readonly Option[]) => void;
  unmount: () => Promise<void>;
}

async function renderDialog({
  accounts = [WORK, PERSONAL, OLD, MAYBE] as readonly Option[],
  runnerOverrides = {} as Partial<RunnerView>,
  select,
}: {
  accounts?: readonly Option[];
  runnerOverrides?: Partial<RunnerView>;
  select?: (providerAccountId: string) => Promise<void>;
} = {}): Promise<Rendered> {
  let listed = accounts;
  const results: ChooseAccountResult[] = [];
  const selections: unknown[] = [];
  const signIns: unknown[] = [];
  let connections = 0;
  const client = {
    ...api,
    authenticationAccounts: async () => ({ accounts: [...listed] }),
    selectAuthenticationAccount: async (_id: string, input: { providerAccountId: string }) => {
      selections.push(input);
      await select?.(input.providerAccountId);
      return { accepted: true as const };
    },
    startProviderLogin: async (_runnerId: string, input: unknown) => {
      signIns.push(input);
      return {} as never;
    },
  } as unknown as ApiClient;
  const container = domWindow.document.createElement("div") as unknown as HTMLDivElement;
  domWindow.document.body.append(container as never);
  const root = createRoot(container);
  const draw = async (currentRunner: RunnerView) => {
    await act(async () => {
      root.render(
        <ApiProvider client={client}>
          <ChooseAccountDialog
            session={session}
            approval={approval}
            runner={currentRunner}
            runnerOnline
            provider="Claude Code"
            machineName="studio-mac"
            onDone={(result) => results.push(result)}
            onOpenConnections={() => { connections += 1; }}
          />
        </ApiProvider>,
      );
      await tick();
      await tick();
    });
  };
  await draw(runner(listed, runnerOverrides));
  const dialog = () => domWindow.document.querySelector('[role="dialog"]') as unknown as HTMLElement | null;
  const rows = () => [...(dialog()?.querySelectorAll<HTMLElement>(".choice-row") ?? [])];
  return {
    dialog,
    button: (name) => [...(dialog()?.querySelectorAll<HTMLButtonElement>("button") ?? [])]
      .find((button) => (button.getAttribute("aria-label") ?? button.textContent?.trim()) === name),
    radio: (name) => rows().find((row) => row.querySelector(".choice-row-title")?.firstChild?.textContent === name)
      ?.querySelector<HTMLInputElement>('input[type="radio"]') ?? undefined,
    row: (name) => rows().find((row) => row.querySelector(".choice-row-title")?.firstChild?.textContent === name),
    results,
    selections,
    signIns,
    connections: () => connections,
    setListed: (next) => { listed = next; },
    setAccounts: async (next, overrides = runnerOverrides) => {
      listed = next;
      await draw(runner(next, overrides));
    },
    unmount: async () => { await act(async () => root.unmount()); container.remove(); },
  };
}

test("the accounts are radio rows with their state in the provider-account vocabulary, the current one left out", async () => {
  const view = await renderDialog();
  try {
    const dialog = view.dialog()!;
    const title = domWindow.document.getElementById(dialog.getAttribute("aria-labelledby")!)!;
    assert.equal(title.textContent, "Choose Another Account");
    assert.match(dialog.textContent ?? "", /Continue this session with another Claude Code account on studio-mac\./);
    assert.equal(dialog.querySelector(".section-title")?.textContent, "Accounts");
    const group = dialog.querySelector<HTMLElement>('[role="radiogroup"][aria-label="Accounts"]')!;
    assert.deepEqual([...group.querySelectorAll(".choice-row")].map((row) => [
      row.querySelector(".choice-row-title")!.firstChild!.textContent,
      row.querySelector(".choice-row-status")?.textContent,
    ]), [
      ["Claude Personal", "Signed In"],
      ["Claude Old", "Sign-In Required"],
      ["Claude Maybe", "Status Unknown"],
    ]);
    assert.deepEqual([...group.querySelectorAll(".choice-row-status .status")].map((badge) =>
      [...badge.classList].filter((name) => name.startsWith("t-") || name === "inline")),
    [["t-success", "inline"], ["t-warning", "inline"], ["t-neutral", "inline"]]);
    assertNoDomNode(dialog.querySelector(".atag"));
    assert.equal(dialog.querySelectorAll(".primary").length, 1, "Use Account is the dialog's one primary");

    assert.equal(view.radio("Claude Personal")!.checked, true, "the first signed-in account is chosen");
    assert.equal(view.button("Use Account")!.disabled, false);
    await act(async () => { view.radio("Claude Maybe")!.click(); await tick(); });
    assert.ok(view.button("Check and Use"), "an account whose state is unknown is checked first");
    await act(async () => { view.radio("Claude Personal")!.click(); await tick(); });
    await act(async () => { view.button("Use Account")!.click(); await tick(); await tick(); });
    assert.deepEqual(view.selections, [{
      requestId: CARD,
      providerAccountId: "claude-personal",
      expectedProviderAccountId: "claude-work",
    }]);
    assert.deepEqual(view.results, [{ kind: "selected" }]);
  } finally {
    await view.unmount();
  }
});

test("the primary follows the chosen row: Use Account, Check and Use, or waiting with its reason for a signed-out one", async () => {
  const view = await renderDialog();
  try {
    const primary = () => view.dialog()!.querySelector<HTMLButtonElement>(".btn.primary")!;
    const reason = () => {
      const id = primary().getAttribute("aria-describedby");
      return id ? domWindow.document.getElementById(id)?.textContent : null;
    };
    assert.equal(primary().textContent?.trim(), "Use Account", "a Signed In account is used as it is");
    assert.equal(primary().disabled, false);
    assert.equal(reason(), null);

    await act(async () => { view.radio("Claude Maybe")!.click(); await tick(); });
    assert.equal(primary().textContent?.trim(), "Check and Use", "a Status Unknown account is checked first");
    assert.equal(primary().disabled, false);

    await act(async () => { view.radio("Claude Old")!.click(); await tick(); });
    assert.equal(primary().textContent?.trim(), "Use Account", "a Sign-In Required account is not invited to Check and Use");
    assert.equal(primary().disabled, true, "it waits until the account is signed in");
    assert.equal(reason(), "This account is signed out. Sign in to it first, then use it.");
    await act(async () => { primary().click(); await tick(); });
    assert.deepEqual(view.selections, [], "nothing is sent for a signed-out account");
  } finally {
    await view.unmount();
  }

  const viewer = await renderDialog({ runnerOverrides: { canManage: false } });
  try {
    await act(async () => { viewer.radio("Claude Old")!.click(); await tick(); });
    const primary = viewer.dialog()!.querySelector<HTMLButtonElement>(".btn.primary")!;
    assert.equal(primary.disabled, true);
    assert.equal(domWindow.document.getElementById(primary.getAttribute("aria-describedby")!)?.textContent,
      "This account is signed out. A machine owner or organization admin must sign in to it first.");
  } finally {
    await viewer.unmount();
  }
});

test("a signed-out account offers Sign In in its trailing slot, outside the row's label, to someone who may start it", async () => {
  const view = await renderDialog();
  try {
    const row = view.row("Claude Old")!;
    const signIn = row.querySelector<HTMLButtonElement>(".choice-row-action button")!;
    assert.equal(signIn.textContent?.trim(), "Sign In");
    assert.equal(signIn.getAttribute("aria-label"), "Sign In to Claude Old");
    assertNoDomNode(signIn.closest("label"), "a label holds no second control");
    await act(async () => { signIn.click(); await tick(); });
    assert.deepEqual(view.signIns, [{ accountId: "claude-old" }]);
    assert.equal(view.radio("Claude Old")!.checked, false, "Sign In does not choose the row");
  } finally {
    await view.unmount();
  }

  const viewer = await renderDialog({ runnerOverrides: { canManage: false } });
  try {
    const row = viewer.row("Claude Old")!;
    assertNoDomNode(row.querySelector(".choice-row-action"));
    assert.equal(row.querySelector(".choice-row-desc")?.textContent,
      "Ask a machine owner or organization admin to sign in to this account.");
  } finally {
    await viewer.unmount();
  }
});

test("removing the chosen account while the dialog is open names it in a notice, clears the choice and disables Use Account", async () => {
  const view = await renderDialog({ accounts: [WORK, PERSONAL, MAYBE] });
  try {
    assert.equal(view.radio("Claude Personal")!.checked, true);
    await view.setAccounts([WORK, MAYBE]);
    assert.equal(view.row("Claude Personal"), undefined, "the removed account leaves the list");
    const notice = view.dialog()!.querySelector<HTMLElement>(".notice")!;
    assert.equal(notice.textContent?.trim(), "Claude Personal was removed from studio-mac, so it's no longer listed.");
    assert.ok(notice.classList.contains("compact"));
    assert.ok(notice.querySelector(".notice-icon svg"), "with the UserX icon");
    assert.equal(view.radio("Claude Maybe")!.checked, false, "nothing is chosen in its place");
    assert.equal(view.button("Use Account")!.disabled, true, "Use Account waits for another choice");
    await act(async () => { view.radio("Claude Maybe")!.click(); await tick(); });
    assert.equal(view.button("Check and Use")!.disabled, false, "another choice enables it again");
  } finally {
    await view.unmount();
  }
});

test("a removed account's name stays masked in the removal sentence, even once emails are shown", async () => {
  const email = "jordan.personal@example.net";
  const view = await renderDialog({ accounts: [WORK, { ...PERSONAL, label: email }, MAYBE] });
  try {
    assert.equal(view.dialog()!.innerHTML.includes(email), false, "masked until Show Emails");
    await act(async () => { view.button("Show Emails")!.click(); await tick(); });
    assert.ok(view.row(email), "Show Emails reveals the row's label");
    await view.setAccounts([WORK, MAYBE]);
    const notice = view.dialog()!.querySelector<HTMLElement>(".notice")!;
    assert.equal(notice.textContent?.trim(), "Hidden Account was removed from studio-mac, so it's no longer listed.");
    assert.equal(view.dialog()!.innerHTML.includes(email), false, "no sentence carries the identifier");
  } finally {
    await view.unmount();
  }
});

test("masked rows keep their numbers when one is removed, and the sentence names it by its row's title", async () => {
  const view = await renderDialog({
    accounts: [WORK, { ...PERSONAL, label: "alex@example.test" }, { ...OLD, label: "blair@example.test" }, MAYBE],
  });
  try {
    assert.ok(view.row("Hidden Account 1"));
    assert.ok(view.row("Hidden Account 2"));
    await view.setAccounts([WORK, { ...OLD, label: "blair@example.test" }, MAYBE]);
    assert.equal(view.dialog()!.querySelector(".notice")?.textContent?.trim(),
      "Hidden Account 1 was removed from studio-mac, so it's no longer listed.");
    assert.ok(view.row("Hidden Account 2"), "the row left is not renumbered");
    assert.equal(view.row("Hidden Account 1"), undefined);
    assert.ok(view.button("Sign In to Hidden Account 2"), "its Sign In is named by the same title");
  } finally {
    await view.unmount();
  }
});

test("an account_unavailable refusal for an account removed since the list loaded uses the removal sentence", async () => {
  let view: Rendered | null = null;
  view = await renderDialog({
    accounts: [WORK, PERSONAL, MAYBE],
    select: async () => {
      // The Machine dropped it between the list and the choice; the dashboard has not heard yet.
      await view!.setAccounts([WORK, MAYBE], { providerAccounts: inventory([WORK, PERSONAL, MAYBE]) } as Partial<RunnerView>);
      throw new ApiError("provider account 'claude-personal' is not configured", 409, "account_unavailable");
    },
  });
  try {
    await act(async () => { view.button("Use Account")!.click(); await tick(); await tick(); await tick(); });
    const dialog = view.dialog()!;
    assert.equal(dialog.querySelector(".notice")?.textContent?.trim(),
      "Claude Personal was removed from studio-mac, so it's no longer listed.");
    assert.doesNotMatch(dialog.textContent ?? "", /not configured/);
    assert.equal(view.row("Claude Personal"), undefined);
    assertNoDomNode(dialog.querySelector(".field-error"), "a removal is not a row's error");
    assert.deepEqual(view.results, []);
    await act(async () => { view.button("Cancel")!.click(); await tick(); });
    assert.deepEqual(view.results, [{ kind: "cancelled", refusal: "Claude Personal was removed from studio-mac, so it's no longer listed." }]);
  } finally {
    await view.unmount();
  }
});

test("a refusal for an available account is a field error in its row, and focus moves to that row", async () => {
  const view = await renderDialog({
    select: async () => {
      throw new ApiError("The provider reports that this account is signed out. Sign in to it, then choose it again.", 409,
        "sign_in_required");
    },
  });
  try {
    await act(async () => { view.button("Use Account")!.click(); await tick(); await tick(); });
    const row = view.row("Claude Personal")!;
    const error = row.querySelector<HTMLElement>(".field-error")!;
    assert.equal(error.textContent, "This account is signed out. Sign in to it, then choose it again.");
    assert.equal(error.tagName, "SPAN", "phrasing content inside the row's label");
    const radio = view.radio("Claude Personal")!;
    assert.equal(radio.getAttribute("aria-invalid"), "true");
    assert.equal(radio.getAttribute("aria-describedby"), error.id, "the error is the row's description while it shows");
    assert.equal(focused(), "radio Claude Personal", "focus moves to the refused row, which announces the error");
    assertNoDomNode(row.querySelector(".choice-row-desc"), "the error takes the second line's place");
    // Choosing again clears it.
    await act(async () => { view.radio("Claude Maybe")!.click(); await tick(); });
    assertNoDomNode(view.dialog()!.querySelector(".field-error"));
  } finally {
    await view.unmount();
  }
});

test("a refused row keeps focus when its refetched state adds a Sign In action", async () => {
  let view: Rendered | null = null;
  view = await renderDialog({
    select: async () => {
      // The runner found the account signed out; the list the dialog reads next says so too.
      view!.setListed([WORK, { ...PERSONAL, authStatus: "unauthenticated", availability: "sign_in_required" }, MAYBE]);
      throw new ApiError("signed out", 409, "sign_in_required");
    },
  });
  try {
    await act(async () => { view.button("Use Account")!.click(); await tick(); await tick(); await tick(); });
    const row = view.row("Claude Personal")!;
    assert.ok(row.querySelector(".choice-row-action button"), "the refetched row now offers Sign In");
    assert.ok(row.querySelector(".field-error"), "and keeps its error");
    assert.equal(focused(), "radio Claude Personal",
      "focus stays on the refused row's radio rather than falling to Cancel");
  } finally {
    await view.unmount();
  }
});

test("not_resumable and account_changed close the dialog for the card to explain", async () => {
  for (const [code, expected] of [
    ["not_resumable", { kind: "cant_switch" }],
    ["account_changed", { kind: "card_changed", notice: "This session's account changed while you were choosing, so nothing was switched." }],
    ["recovery_changed", { kind: "card_changed", notice: "This sign-in request changed while the account was checked. Review the card, then choose again." }],
  ] as const) {
    const view = await renderDialog({ select: async () => { throw new ApiError("raw runner words", 409, code); } });
    try {
      await act(async () => { view.button("Use Account")!.click(); await tick(); await tick(); });
      assert.deepEqual(view.results, [expected], code);
    } finally {
      await view.unmount();
    }
  }
});

test("account labels stay masked until Show Emails, which reveals every row at once", async () => {
  const view = await renderDialog({
    accounts: [
      { ...WORK, label: "work@example.test" },
      { ...PERSONAL, label: "alex@example.test" },
      { ...MAYBE, label: "blair@example.test" },
    ],
  });
  try {
    const html = () => view.dialog()!.innerHTML;
    for (const label of ["work@example.test", "alex@example.test", "blair@example.test"]) {
      assert.equal(html().includes(label), false, `${label} is absent before reveal`);
    }
    assert.ok(view.row("Hidden Account 1"));
    assert.ok(view.row("Hidden Account 2"));
    await act(async () => { view.button("Show Emails")!.click(); await tick(); });
    assert.ok(view.row("alex@example.test"));
    assert.ok(view.row("blair@example.test"));
    assert.equal(html().includes("work@example.test"), false, "the current account is not listed");
    await act(async () => { view.button("Hide Emails")!.click(); await tick(); });
    assert.equal(html().includes("alex@example.test"), false);
  } finally {
    await view.unmount();
  }
});

test("with no other account the dialog says who can add one and offers Open Connections", async () => {
  const view = await renderDialog({ accounts: [WORK] });
  try {
    const dialog = view.dialog()!;
    assert.equal(dialog.querySelector(".state-title")?.textContent, "No Other Accounts");
    assert.match(dialog.textContent ?? "",
      /A machine owner or organization admin can add one in the machine's Provider Accounts section\./);
    assert.equal(view.button("Use Account"), undefined);
    assert.ok(view.button("Done"));
    await act(async () => { view.button("Open Connections")!.click(); await tick(); });
    assert.equal(view.connections(), 1);
    assert.deepEqual(view.results, [{ kind: "cancelled", refusal: null }]);
  } finally {
    await view.unmount();
  }
});
