import assert from "node:assert/strict";
import test from "node:test";
import React, { act } from "react";
import { createRoot } from "react-dom/client";
import { Window } from "happy-dom";
import type {
  PendingApproval,
  ProviderAccountDefinition,
  SessionProviderAccountOption,
  SessionProviderAccountUnavailable,
  SessionView,
} from "@wollipog/protocol";
import { api, type ApiClient } from "../api.js";
import { ApiProvider } from "../api-context.js";
import { SwitchAccountDialog } from "./SwitchAccountDialog.js";
import { assertNoDomNode } from "../dom-test-assertions.js";

const domWindow = new Window({ url: "http://localhost/session/session-switch" });
domWindow.localStorage.setItem("wollipog.hide-account-emails", "true");
for (const [name, value] of Object.entries({
  window: domWindow,
  document: domWindow.document,
  navigator: domWindow.navigator,
  HTMLElement: domWindow.HTMLElement,
  HTMLButtonElement: domWindow.HTMLButtonElement,
  HTMLInputElement: domWindow.HTMLInputElement,
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

const SESSION = {
  id: "session-switch",
  driver: "claude-code",
  providerAccountId: "current",
  providerAccountLabel: "current.me@example.com",
  pendingApproval: null,
} as Pick<SessionView, "id" | "driver" | "providerAccountId" | "providerAccountLabel" | "pendingApproval">;

function option(id: string, label: string, overrides: Partial<SessionProviderAccountOption> = {}): SessionProviderAccountOption {
  return {
    id,
    label,
    authStatus: "authenticated",
    usageState: "available",
    freshness: "fresh",
    buckets: [
      { id: "five-hour", label: "5-Hour", remainingPercent: 78 },
      { id: "weekly", label: "Weekly", usedPercent: 61 },
    ],
    ...overrides,
  };
}

function machineAccount(id: string, label: string, overrides: Partial<ProviderAccountDefinition> = {}): ProviderAccountDefinition {
  return { id, label, provider: "claude", authStatus: "authenticated", ...overrides };
}

const OTHERS = [option("work", "work.me@example.com"), option("spare", "spare.me@example.org")];
const ALIASED = { ...SESSION, providerAccountLabel: "Current" };
const MACHINE = [
  machineAccount("current", "current.me@example.com"),
  machineAccount("work", "work.me@example.com"),
  machineAccount("spare", "spare.me@example.org"),
];

interface Rendered {
  body: HTMLElement;
  switches: string[];
  closed: () => number;
  switched: boolean[];
  connections: () => number;
  finish: (outcome: { ok: boolean; message?: string }) => void;
  rerender: (session: typeof SESSION) => Promise<void>;
  unmount: () => Promise<void>;
}

async function renderDialog({
  session = SESSION,
  accounts = OTHERS,
  machineAccounts = MACHINE as readonly ProviderAccountDefinition[] | undefined,
  deferSwitch = false,
  load,
  unavailable,
}: {
  session?: typeof SESSION;
  accounts?: SessionProviderAccountOption[];
  /** The endpoint's unavailable accounts (#2276); absent, as from an older control plane, by default. */
  unavailable?: SessionProviderAccountUnavailable[];
  machineAccounts?: readonly ProviderAccountDefinition[];
  deferSwitch?: boolean;
  /** Answers the account-list request; the call number counts from 1. Defaults to `accounts`. */
  load?: (call: number) => Promise<SessionProviderAccountOption[]>;
} = {}): Promise<Rendered> {
  let loads = 0;
  const switches: string[] = [];
  const switched: boolean[] = [];
  let closes = 0;
  let connections = 0;
  let settle: ((outcome: { ok: boolean; message?: string }) => void) | null = null;
  const client = {
    ...api,
    sessionProviderAccounts: async () => ({
      accounts: load ? await load(++loads) : accounts,
      ...(unavailable ? { unavailable } : {}),
    }),
    switchSessionProviderAccount: (_id: string, providerAccountId: string) => {
      switches.push(providerAccountId);
      if (!deferSwitch) return Promise.resolve({ accepted: true as const, scheduled: false });
      return new Promise((resolve, reject) => {
        settle = ({ ok, message }) => ok
          ? resolve({ accepted: true as const, scheduled: true })
          : reject(new Error(message ?? "account switch failed"));
      });
    },
  } as ApiClient;
  const mountPoint = domWindow.document.createElement("div") as unknown as HTMLDivElement;
  domWindow.document.body.append(mountPoint as never);
  const root = createRoot(mountPoint);
  const render = (current: typeof SESSION) => root.render(
    <ApiProvider client={client}>
      <SwitchAccountDialog
        session={current}
        machineName="build-box"
        {...(machineAccounts ? { machineAccounts } : {})}
        onClose={() => { closes += 1; }}
        onSwitched={(scheduled) => switched.push(scheduled)}
        onOpenConnections={() => { connections += 1; }}
      />
    </ApiProvider>,
  );
  await act(async () => { render(session); });
  await act(async () => { await tick(); await tick(); });
  return {
    body: domWindow.document.body as unknown as HTMLElement,
    switches,
    switched,
    closed: () => closes,
    connections: () => connections,
    finish: (outcome) => {
      assert.ok(settle, "a switch is in flight");
      settle(outcome);
    },
    rerender: async (next) => {
      await act(async () => { render(next); });
      await act(async () => { await tick(); await tick(); });
    },
    unmount: async () => {
      await act(async () => root.unmount());
      mountPoint.remove();
    },
  };
}

function rows(body: HTMLElement): HTMLElement[] {
  return [...body.querySelectorAll<HTMLElement>(".account-rows .choice-row")];
}

/** A row's title is its first text; the "Current" chip follows it on the same line. */
function rowTitle(row: HTMLElement): string | null | undefined {
  return row.querySelector(".choice-row-title")?.firstChild?.textContent;
}

function radio(row: HTMLElement): HTMLInputElement {
  const input = row.querySelector<HTMLInputElement>('input[type="radio"]');
  assert.ok(input);
  return input;
}

function button(body: HTMLElement, name: string): HTMLButtonElement | undefined {
  return [...body.querySelectorAll<HTMLButtonElement>("button")]
    .find((candidate) => candidate.textContent?.trim() === name || candidate.getAttribute("aria-label") === name);
}

test("the session's account leads the list as a disabled row with a Current chip, and no sentence names an account", async () => {
  const view = await renderDialog();
  try {
    const [current, ...others] = rows(view.body);
    assert.ok(current);
    assert.equal(rowTitle(current), "Hidden Account");
    assert.equal(current.querySelector(".choice-row-status")?.textContent, "Current");
    assert.equal(current.classList.contains("is-disabled"), true);
    assert.equal(radio(current).getAttribute("aria-disabled"), "true");
    assert.deepEqual(others.map(rowTitle), ["Hidden Account 1", "Hidden Account 2"]);
    assert.equal(radio(others[0]!).checked, true, "the first account that can take over is chosen");

    assert.ok(view.body.textContent?.includes("Continue this conversation with another Claude account on build-box."));
    const rule = view.body.querySelector(".switch-account-rule");
    assert.equal(rule?.textContent,
      "A turn that is running finishes on the current account. Queued messages go to the new one.");
    // No sentence carries an identifier or a reveal control: the only reveal is the Accounts head's.
    assertNoDomNode(view.body.querySelector(".pid"), "no inline masked identifier");
    assert.equal(view.body.querySelectorAll(".pid-toggle").length, 1);
    assert.ok(view.body.querySelector(".switch-account-accounts > .section-head .pid-toggle"));
    assert.equal(view.body.querySelector(".switch-account-accounts > .section-head .section-title")?.textContent, "Accounts");
    assert.equal(view.body.innerHTML.includes("@example."), false, "no identifier is in the DOM before a reveal");
  } finally {
    await view.unmount();
  }
});

test("a removed current account reads Removed Account with no meters, and switching still works", async () => {
  const view = await renderDialog({
    machineAccounts: MACHINE.filter((account) => account.id !== "current"),
  });
  try {
    const [current, ...others] = rows(view.body);
    assert.ok(current);
    assert.equal(rowTitle(current), "Removed Account");
    assert.equal(current.querySelector(".choice-row-status")?.textContent, "Current");
    assert.equal(current.querySelector(".choice-row-desc")?.textContent,
      "Removed from build-box. This session keeps its sign-in until you switch.");
    assertNoDomNode(current.querySelector('[role="progressbar"]'), "a removed account has no meters");
    assert.deepEqual(others.map(rowTitle), ["Hidden Account 1", "Hidden Account 2"], "the others are numbered from 1");

    const showEmails = button(view.body, "Show Emails");
    assert.ok(showEmails);
    await act(async () => { showEmails.click(); });
    assert.equal(rowTitle(rows(view.body)[0]!), "Removed Account", "the stored label is never shown, even revealed");
    assert.equal(view.body.innerHTML.includes("current.me@example.com"), false);

    const primary = button(view.body, "Switch Account");
    assert.ok(primary);
    assert.equal(primary.disabled, false);
    await act(async () => { primary.click(); await tick(); });
    assert.deepEqual(view.switches, ["work"]);
    assert.deepEqual(view.switched, [false]);
    assert.equal(view.closed(), 1);
  } finally {
    await view.unmount();
  }
});

test("without the machine's account list, the current account is never called removed", async () => {
  const view = await renderDialog({ machineAccounts: undefined });
  try {
    assert.equal(rowTitle(rows(view.body)[0]!), "Hidden Account");
  } finally {
    await view.unmount();
  }
});

test("each listed account shows one meter per usage window, warning under 25%, and Last Known when stale", async () => {
  const view = await renderDialog({
    session: ALIASED,
    accounts: [
      option("work", "Work"),
      option("spare", "Spare", {
        freshness: "stale",
        buckets: [
          { id: "five-hour", label: "5-Hour", remainingPercent: 24.4 },
          { id: "weekly", label: "Weekly", usedPercent: 74.6 },
        ],
      }),
    ],
    machineAccounts: [machineAccount("current", "Current"), machineAccount("work", "Work"), machineAccount("spare", "Spare")],
  });
  try {
    const [, work, spare] = rows(view.body);
    assert.ok(work && spare);
    const windows = (row: HTMLElement) => [...row.querySelectorAll(".account-usage-text")].map((node) => node.textContent);
    assert.deepEqual(windows(work), ["5-Hour · 78% left", "Weekly · 39% left"]);
    assert.deepEqual(windows(spare), ["5-Hour · 24% left", "Weekly · 25% left"]);
    const meters = (row: HTMLElement) => [...row.querySelectorAll<HTMLElement>(".meter")];
    assert.equal(meters(work).length, 2);
    assert.deepEqual(meters(work).map((meter) => meter.classList.contains("t-warning")), [false, false]);
    assert.deepEqual(meters(spare).map((meter) => meter.classList.contains("t-warning")), [true, false],
      "only the window with less than a quarter left takes the warning tone");
    assert.equal(meters(spare)[0]!.getAttribute("role"), "progressbar");
    assert.equal(meters(spare)[0]!.getAttribute("aria-valuenow"), "24");
    assert.equal(meters(spare)[0]!.getAttribute("aria-label"), "5-Hour Left");
    assert.equal((meters(spare)[0]!.firstElementChild as HTMLElement).style.width, "24%");
    assertNoDomNode(work.querySelector(".account-usage-stale"), "fresh usage is not marked");
    assert.equal(spare.querySelector(".account-usage-stale")?.textContent, "Last Known");
    assertNoDomNode(view.body.querySelector(".switch-account-accounts > .section-head .pid-toggle"), "aliases need no reveal");
  } finally {
    await view.unmount();
  }
});

test("Show Emails reveals every row's label and Hide Emails masks them again", async () => {
  const view = await renderDialog();
  try {
    const show = button(view.body, "Show Emails");
    assert.ok(show);
    assert.equal(show.classList.contains("btn"), true);
    assert.equal(show.classList.contains("sm"), true);
    assert.equal(show.classList.contains("ghost"), true);
    await act(async () => { show.click(); });
    assert.deepEqual(rows(view.body).map(rowTitle),
      ["current.me@example.com", "work.me@example.com", "spare.me@example.org"]);
    const hide = button(view.body, "Hide Emails");
    assert.ok(hide);
    await act(async () => { hide.click(); });
    assert.deepEqual(rows(view.body).map(rowTitle), ["Hidden Account", "Hidden Account 1", "Hidden Account 2"]);
    assert.equal(view.body.innerHTML.includes("@example."), false);
  } finally {
    await view.unmount();
  }
});

test("a session blocked on authentication is not promised that queued messages move", async () => {
  const authentication: PendingApproval = {
    kind: "authentication",
    requestId: "provider-auth:1",
    title: "Authentication Required — Claude Code",
    options: [],
  };
  const view = await renderDialog({ session: { ...SESSION, pendingApproval: authentication } });
  try {
    assert.equal(view.body.querySelector(".switch-account-rule")?.textContent,
      "A turn that is running finishes on the current account.");
    assert.equal(view.body.textContent?.includes("Queued messages go to the new one."), false);
  } finally {
    await view.unmount();
  }
});

test("with no other account on the machine, the dialog offers Open Connections and a single Done", async () => {
  const view = await renderDialog({ accounts: [], machineAccounts: [MACHINE[0]!] });
  try {
    assert.equal(view.body.querySelector(".state-title")?.textContent, "No Other Accounts");
    assert.ok(view.body.textContent?.includes("Sign in to another Claude account on build-box, then switch here."));
    assertNoDomNode(view.body.querySelector(".account-rows"), "no list");
    const footer = view.body.querySelector(".modal-foot");
    assert.ok(footer);
    assert.deepEqual([...footer.querySelectorAll("button")].map((node) => node.textContent?.trim()), ["Done"]);
    const open = button(view.body, "Open Connections");
    assert.ok(open);
    await act(async () => { open.click(); });
    assert.equal(view.connections(), 1);
    assert.equal(view.closed(), 1);
  } finally {
    await view.unmount();
  }
});

test("from an older control plane with no unavailable list, accounts it did not offer are disabled rows with derived reasons", async () => {
  const view = await renderDialog({
    session: ALIASED,
    accounts: [option("work", "Work")],
    machineAccounts: [
      machineAccount("current", "Current"),
      machineAccount("work", "Work"),
      machineAccount("signed-out", "Signed Out", { authStatus: "unauthenticated" }),
      machineAccount("unknown", "Unknown", { authStatus: "unknown" }),
      machineAccount("drained", "Drained"),
      machineAccount("other-provider", "Codex Account", { provider: "codex" }),
    ],
  });
  try {
    const all = rows(view.body);
    assert.deepEqual(all.map(rowTitle), ["Current", "Work", "Signed Out", "Unknown", "Drained"],
      "another provider's account is not listed");
    const [, work, signedOut, unknown, drained] = all;
    assert.equal(work!.classList.contains("is-disabled"), false);
    assert.equal(radio(work!).checked, true);
    const reason = (row: HTMLElement) => row.querySelector(".choice-row-reason")?.textContent;
    assert.equal(reason(signedOut!), "Signed out on build-box.");
    assert.equal(reason(unknown!), "Sign-in status unknown on build-box.");
    assert.equal(reason(drained!), "No usage headroom reported.");
    for (const row of [signedOut!, unknown!, drained!]) {
      assert.equal(row.classList.contains("is-disabled"), true);
      assert.equal(radio(row).getAttribute("aria-disabled"), "true");
    }
    assertNoDomNode(view.body.querySelector(".switch-account-reason"), "an account can take over");
  } finally {
    await view.unmount();
  }
});

test("the endpoint's unavailable list and reasons are preferred, so exhausted and unknown usage read differently", async () => {
  const resetsAt = Date.now() + 3 * 3_600_000 - 60_000;
  const view = await renderDialog({
    session: ALIASED,
    accounts: [option("work", "Work")],
    unavailable: [
      { id: "drained", label: "Drained", reason: "usage_exhausted",
        exhaustedWindow: { id: "weekly", label: "Weekly", remainingPercent: 0, resetsAt } },
      { id: "unread", label: "Unread", reason: "usage_unknown" },
      { id: "spent", label: "Spent", reason: "usage_exhausted" },
      { id: "signed-out", label: "Signed Out", reason: "signed_out" },
      { id: "unknown", label: "Unknown", reason: "sign_in_unknown" },
      { id: "future", label: "Future", reason: "a_newer_reason" as SessionProviderAccountUnavailable["reason"] },
    ],
    // The dashboard's inventory differs from the endpoint's; the endpoint wins.
    machineAccounts: [
      machineAccount("current", "Current"),
      machineAccount("work", "Work"),
      machineAccount("drained", "Drained"),
      machineAccount("stray", "Stray"),
    ],
  });
  try {
    const all = rows(view.body);
    assert.deepEqual(all.map(rowTitle), ["Current", "Work", "Drained", "Unread", "Spent", "Signed Out", "Unknown", "Future"],
      "an account only the dashboard lists is not added");
    const reason = (row: HTMLElement) => row.querySelector(".choice-row-reason")?.textContent;
    const [, work, drained, unread, spent, signedOut, unknown, future] = all;
    assert.equal(work!.classList.contains("is-disabled"), false);
    assert.equal(radio(work!).checked, true);
    assert.equal(reason(drained!), "The Weekly window is used up and resets in 3 hours.");
    assert.equal(reason(unread!), "No current usage reading is available.");
    assert.equal(reason(spent!), "A usage window is used up.");
    assert.equal(reason(signedOut!), "Signed out on build-box.");
    assert.equal(reason(unknown!), "Sign-in status unknown on build-box.");
    assert.equal(reason(future!), "Not available for this session right now.");
    for (const row of [drained!, unread!, spent!, signedOut!, unknown!, future!]) {
      assert.equal(row.classList.contains("is-disabled"), true);
      assert.equal(radio(row).getAttribute("aria-disabled"), "true");
    }
  } finally {
    await view.unmount();
  }
});

test("an empty unavailable list is the endpoint's answer, not an older control plane's silence", async () => {
  const view = await renderDialog({
    session: ALIASED,
    accounts: [option("work", "Work")],
    unavailable: [],
    machineAccounts: [machineAccount("current", "Current"), machineAccount("work", "Work"), machineAccount("drained", "Drained")],
  });
  try {
    assert.deepEqual(rows(view.body).map(rowTitle), ["Current", "Work"]);
  } finally {
    await view.unmount();
  }
});

test("only unavailable accounts from the endpoint keep the primary disabled with the footer reason", async () => {
  const view = await renderDialog({
    session: ALIASED,
    accounts: [],
    unavailable: [{ id: "unread", label: "Unread", reason: "usage_unknown" }],
  });
  try {
    assert.deepEqual(rows(view.body).map(rowTitle), ["Current", "Unread"]);
    assert.equal(button(view.body, "Switch Account")?.disabled, true);
    assert.equal(view.body.querySelector(".modal-foot > .switch-account-reason")?.textContent,
      "None of these accounts can take over right now.");
  } finally {
    await view.unmount();
  }
});

test("with only unavailable accounts the primary stays disabled and the footer says why", async () => {
  const view = await renderDialog({
    session: ALIASED,
    accounts: [],
    machineAccounts: [machineAccount("current", "Current"), machineAccount("drained", "Drained")],
  });
  try {
    assertNoDomNode(view.body.querySelector(".state-title"), "the machine has another account, so this is not No Other Accounts");
    assert.deepEqual(rows(view.body).map(rowTitle), ["Current", "Drained"]);
    const primary = button(view.body, "Switch Account");
    assert.ok(primary);
    assert.equal(primary.disabled, true);
    const reason = view.body.querySelector(".modal-foot > .switch-account-reason");
    assert.equal(reason?.textContent, "None of these accounts can take over right now.");
    assert.equal(primary.getAttribute("aria-describedby"), reason?.id);
  } finally {
    await view.unmount();
  }
});

test("a failed switch being retried offers the current account itself, once and choosable", async () => {
  const view = await renderDialog({
    session: ALIASED,
    accounts: [option("current", "Current")],
    machineAccounts: [machineAccount("current", "Current")],
  });
  try {
    const all = rows(view.body);
    assert.equal(all.length, 1, "the current account is not listed twice");
    assert.equal(rowTitle(all[0]!), "Current");
    assert.equal(all[0]!.classList.contains("is-disabled"), false);
    assert.equal(radio(all[0]!).checked, true);
    assert.equal(all[0]!.querySelectorAll(".meter").length, 2);
    const primary = button(view.body, "Switch Account");
    await act(async () => { primary!.click(); await tick(); });
    assert.deepEqual(view.switches, ["current"]);
  } finally {
    await view.unmount();
  }
});

test("the primary keeps its label while switching, and a failure is a danger notice above the footer", async () => {
  const view = await renderDialog({ deferSwitch: true });
  try {
    const primary = button(view.body, "Switch Account");
    assert.ok(primary);
    await act(async () => { primary.click(); await tick(); });
    assert.equal(primary.textContent?.trim(), "Switch Account");
    assert.equal(primary.getAttribute("aria-busy"), "true");
    assert.ok(view.body.textContent?.includes("Switching the account…"));
    assert.equal(button(view.body, "Cancel")?.disabled, true);
    assert.deepEqual(view.switches, ["work"]);
    await act(async () => { primary.click(); await tick(); });
    assert.deepEqual(view.switches, ["work"], "a busy primary refuses another press");

    await act(async () => { view.finish({ ok: false, message: "that account is unavailable" }); await tick(); });
    const notice = view.body.querySelector('.modal-body .notice.t-danger[role="alert"]');
    assert.equal(notice?.textContent?.includes("that account is unavailable"), true);
    assert.equal(primary.getAttribute("aria-busy"), null);
    assert.equal(view.closed(), 0);
  } finally {
    await view.unmount();
  }
});

test("the current row keeps the label the session was bound with, even after the machine renamed it", async () => {
  const view = await renderDialog({
    session: { ...SESSION, providerAccountLabel: "Work (Bound)" },
    machineAccounts: [machineAccount("current", "Work (Renamed)"), ...MACHINE.slice(1)],
  });
  try {
    assert.equal(rowTitle(rows(view.body)[0]!), "Work (Bound)");
  } finally {
    await view.unmount();
  }
});

test("a new current account reloads the list, and a failed reload leaves nothing to submit", async () => {
  const view = await renderDialog({
    load: async (call) => {
      if (call === 1) return OTHERS;
      throw new Error("the runner is offline");
    },
  });
  try {
    assert.equal(radio(rows(view.body)[1]!).checked, true, "work is chosen from the first list");
    await view.rerender({ ...SESSION, providerAccountId: "work", providerAccountLabel: "work.me@example.com" });
    assert.equal(rows(view.body).length, 0, "the old rows are gone");
    assert.ok(view.body.querySelector('.notice.t-danger[role="alert"]')?.textContent?.includes("the runner is offline"));
    const primary = button(view.body, "Switch Account");
    assert.ok(primary);
    assert.equal(primary.disabled, true, "nothing chosen from the old list can be switched to");
    await act(async () => { primary.click(); await tick(); });
    assert.deepEqual(view.switches, []);
  } finally {
    await view.unmount();
  }
});

test("Cancel keeps its focus when a slow load turns it into Done", async () => {
  let answer: (accounts: SessionProviderAccountOption[]) => void = () => undefined;
  const view = await renderDialog({
    machineAccounts: [MACHINE[0]!],
    load: () => new Promise((resolve) => { answer = resolve; }),
  });
  try {
    const cancel = button(view.body, "Cancel");
    assert.ok(cancel);
    await act(async () => { cancel.focus(); });
    assert.ok(domWindow.document.activeElement === (cancel as unknown), "Cancel has focus while loading");
    await act(async () => { answer([]); await tick(); await tick(); });
    const done = button(view.body, "Done");
    assert.ok(done === cancel, "the dismiss button is the same element");
    assert.ok(domWindow.document.activeElement === (done as unknown), "focus stays on it");
  } finally {
    await view.unmount();
  }
});

test("focus on a row that a reload removes moves to Cancel instead of leaving the dialog", async () => {
  let answer: (accounts: SessionProviderAccountOption[]) => void = () => undefined;
  const view = await renderDialog({
    load: (call) => call === 1 ? Promise.resolve(OTHERS) : new Promise((resolve) => { answer = resolve; }),
  });
  try {
    const chosen = radio(rows(view.body)[1]!);
    await act(async () => { chosen.focus(); });
    assert.ok(domWindow.document.activeElement === (chosen as unknown));
    await view.rerender({ ...SESSION, providerAccountId: "work", providerAccountLabel: "work.me@example.com" });
    const cancel = button(view.body, "Cancel");
    assert.ok(cancel);
    assert.ok(domWindow.document.activeElement === (cancel as unknown), "lost focus is rescued to Cancel");
    await act(async () => { answer(OTHERS); await tick(); await tick(); });
    assert.ok(domWindow.document.activeElement === (cancel as unknown), "focus that is somewhere is not moved");
  } finally {
    await view.unmount();
  }
});

test("focus stays in the dialog when the account changes under a running switch and the primary goes", async () => {
  let answer: (accounts: SessionProviderAccountOption[]) => void = () => undefined;
  const view = await renderDialog({
    deferSwitch: true,
    machineAccounts: [MACHINE[1]!],
    load: (call) => call === 1 ? Promise.resolve([OTHERS[0]!]) : new Promise((resolve) => { answer = resolve; }),
  });
  try {
    const primary = button(view.body, "Switch Account");
    assert.ok(primary);
    await act(async () => { primary.focus(); primary.click(); await tick(); });
    assert.deepEqual(view.switches, ["work"]);
    // The runner reports the new account before the switch request returns, and the machine has
    // no other account to list.
    await view.rerender({ ...SESSION, providerAccountId: "work", providerAccountLabel: "work.me@example.com" });
    await act(async () => { answer([]); await tick(); await tick(); });
    assertNoDomNode(button(view.body, "Switch Account") ?? null, "the primary is gone");
    assert.equal(button(view.body, "Done")?.disabled, true, "dismissal waits for the switch");
    const dialog = view.body.querySelector('[role="dialog"]');
    assert.ok(dialog && domWindow.document.activeElement === (dialog as unknown), "focus is on the dialog, not <body>");
    await act(async () => { view.finish({ ok: true }); await tick(); });
    assert.equal(view.closed(), 1);
  } finally {
    await view.unmount();
  }
});
