import assert from "node:assert/strict";
import test from "node:test";
import React, { act } from "react";
import { createRoot } from "react-dom/client";
import { Window } from "happy-dom";
import type { RunnerView } from "@wollipog/protocol";
import { setHideAccountEmails } from "../account-email-privacy.js";
import { api, type ApiClient } from "../api.js";
import { ApiProvider } from "../api-context.js";
import { assertNoDomNode } from "../dom-test-assertions.js";
import { installDomTestCleanup } from "../dom-test-cleanup.js";
import { relativeTime } from "../format.js";
import type { RunnerSkillsResponse } from "../skills.js";
import { MachineSkillsSection } from "./MachineSkillsSection.js";

const domWindow = new Window({ url: "http://localhost/" });
installDomTestCleanup(domWindow);
for (const [name, value] of Object.entries({
  window: domWindow, document: domWindow.document, navigator: domWindow.navigator, localStorage: domWindow.localStorage,
  HTMLElement: domWindow.HTMLElement, Node: domWindow.Node, React, IS_REACT_ACT_ENVIRONMENT: true,
})) Object.defineProperty(globalThis, name, { configurable: true, writable: true, value });

const labels = (scope: Element) => [...scope.querySelectorAll(".machine-skills-label")].map((label) => label.textContent);
const surfaces = (scope: Element) => [...scope.querySelectorAll<HTMLElement>(".surface")];
/** Each row's title, its meta in order, then its second line. */
const rows = (surface: Element) => [...surface.querySelectorAll(".row.row-2")].map((row) => [
  row.querySelector(".row-title")?.textContent,
  ...[...row.querySelectorAll(".row-line > :not(.row-title)")].map((meta) => meta.textContent),
  ...[...row.querySelectorAll(".row-sub")].map((line) => line.textContent),
]);

const runner = {
  runnerId: "runner-1", hostname: "runner-1", displayName: "Build Machine", os: "linux", version: "1", status: "online",
  agents: [{ id: "claude-main", name: "Claude Code", command: "claude", args: [], env: {}, driver: "claude-code", available: true }],
  providerAccounts: [{ id: "acct-work", label: "Work Account", provider: "claude", authStatus: "authenticated" }],
  workspaces: [], connectedAt: 1, lastSeen: 1, protocolVersion: 200,
} as RunnerView;

const reported = (removalReporting: RunnerSkillsResponse["removalReporting"], removals = true): RunnerSkillsResponse => ({
  removalReporting,
  desired: [],
  reported: {
    unmanaged: [{ agentId: "claude-main", name: "local-notes", description: "Scratch skill", providerAccountId: "acct-work" }],
    removals: removals ? [
      { path: "~/.claude/skills/code-review", reason: "No longer in the desired skill list." },
      { path: "~/.codex/skills/deleted-skill", reason: "The canonical location it routes through is conflicted.", providerAccountId: "acct-work" },
    ] : [],
    removalsUpdatedAt: 1_699_999_000_000,
    updatedAt: 1_700_000_000_000,
  },
});

async function open(response: () => Promise<RunnerSkillsResponse>, view: RunnerView = runner) {
  let reads = 0;
  const client = { ...api, runnerSkills: async () => { reads += 1; return response(); } } as unknown as ApiClient;
  const container = domWindow.document.createElement("div") as unknown as HTMLDivElement;
  domWindow.document.body.append(container as never);
  const root = createRoot(container);
  await act(async () => root.render(<ApiProvider client={client}><MachineSkillsSection runner={view} /></ApiProvider>));
  const details = container.querySelector("details");
  const toggle = async (state: boolean) => {
    await act(async () => {
      details!.open = state;
      details!.dispatchEvent(new domWindow.Event("toggle") as never);
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
  };
  return {
    container, details, toggle, reads: () => reads,
    unmount: async () => { await act(async () => root.unmount()); container.remove(); },
  };
}

test("Skills on This Machine reads the machine when opened and lists every removal with agent names", async () => {
  const view = await open(async () => reported("supported"));
  try {
    assert.equal(view.details?.querySelector("summary")?.textContent, "Skills on This Machine");
    assert.equal(view.reads(), 0, "nothing is read until it is opened");
    await view.toggle(true);
    assert.equal(view.reads(), 1);
    const text = view.container.textContent ?? "";
    assert.deepEqual(labels(view.container), ["Unmanaged Skills", "Recent Link Removals"]);
    assertNoDomNode(view.container.querySelector("h5"), "section labels, not h5 groups");
    assert.doesNotMatch(text, /[·—]/u, "meta sits 12px apart, never dot- or dash-joined");
    const [unmanaged, removals] = surfaces(view.container);
    assert.deepEqual(rows(unmanaged!), [["local-notes", "Claude Code", "Work Account", "Scratch skill"]]);
    assert.equal(unmanaged!.querySelector(".row-title")?.getAttribute("title"), "local-notes",
      "a truncated name keeps its full text as a tooltip, as the description does (#3526)");
    assert.doesNotMatch(text, /claude-main|acct-work/, "the agent's name and the account's label, never their ids");
    assert.match(text, /can then be adopted with an explicit recovery-aware confirmation/);
    // The machine's whole history: every skill's, including one the library no longer has.
    assert.deepEqual(rows(removals!), [
      ["~/.claude/skills/code-review", "No longer in the desired skill list."],
      ["~/.codex/skills/deleted-skill", "Work Account", "The canonical location it routes through is conflicted."],
    ]);
    assert.equal(view.container.querySelector(".machine-skills-reported")?.textContent, `Reported ${relativeTime(1_699_999_000_000)}`,
      "the removal history's own time, relative, not the newer inventory's");
    await view.toggle(false);
    await view.toggle(true);
    assert.equal(view.reads(), 2, "each opening reads the machine's latest report");
  } finally { await view.unmount(); }
});

test("removal reporting says what the runner can and cannot report", async () => {
  for (const [reporting, expected] of [
    ["unsupported", /This runner version cannot report new managed link removals\./],
    ["supported", /No managed link removals have been reported\./],
  ] as const) {
    const view = await open(async () => reported(reporting, false));
    try {
      await view.toggle(true);
      assert.match(view.container.textContent ?? "", expected);
    } finally { await view.unmount(); }
  }
  // An unknown capability claims nothing.
  const unknown = await open(async () => reported("unknown", false));
  try {
    await unknown.toggle(true);
    assert.doesNotMatch(unknown.container.textContent ?? "", /Recent Link Removals/);
  } finally { await unknown.unmount(); }
});

test("a failed read is a danger notice whose Retry reads again, as does the next open; a runner without skills shows nothing", async () => {
  let fail = true;
  const view = await open(async () => { if (fail) throw new Error("HTTP 503"); return reported("supported"); });
  try {
    await view.toggle(true);
    const notice = view.container.querySelector<HTMLElement>('.notice.t-danger.compact[role="alert"]')!;
    assert.match(notice.textContent ?? "", /Couldn't Load Skills on This Machine/);
    assert.doesNotMatch(notice.textContent ?? "", /close and reopen/i, "Retry, not close and reopen");
    fail = false;
    const retry = [...notice.querySelectorAll("button")].find((button) => button.textContent === "Retry")!;
    await act(async () => {
      retry.click();
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
    assert.equal(view.reads(), 2, "Retry reads again");
    assert.match(view.container.textContent ?? "", /local-notes/);
    assertNoDomNode(view.container.querySelector(".notice.t-danger"), "the notice goes once the read succeeds");
    fail = true;
    await view.toggle(false);
    await view.toggle(true);
    assert.equal(view.reads(), 3, "the next opening reads too");
  } finally { await view.unmount(); }
  const old = await open(async () => reported("supported"), { ...runner, protocolVersion: 1 });
  try {
    assertNoDomNode(old.details);
  } finally { await old.unmount(); }
});

test("a machine that hasn't reported yet says so, and a later opening shows its first report (CR-2.2)", async () => {
  let report: RunnerSkillsResponse = { removalReporting: "supported", desired: [], reported: null };
  const view = await open(async () => report);
  try {
    await view.toggle(true);
    const text = view.container.textContent ?? "";
    assert.match(text, /This machine hasn't reported its skills yet\./);
    assert.doesNotMatch(text, /reports no unmanaged skills|No managed link removals/);
    report = reported("supported");
    await view.toggle(false);
    await view.toggle(true);
    assert.match(view.container.textContent ?? "", /local-notes/);
    assert.doesNotMatch(view.container.textContent ?? "", /hasn't reported/);
  } finally { await view.unmount(); }
});

test("an account label that is an email is masked under Hide Account Emails, and shown when it is off", async () => {
  const emailRunner = {
    ...runner,
    providerAccounts: [{ id: "acct-work", label: "ada@example.com", provider: "claude", authStatus: "authenticated" }],
  } as RunnerView;
  for (const hide of [true, false]) {
    setHideAccountEmails(hide, domWindow as never);
    const view = await open(async () => reported("supported"), emailRunner);
    try {
      await view.toggle(true);
      const text = view.container.textContent ?? "";
      if (hide) {
        assert.doesNotMatch(text, /ada@example\.com/, "the email is not in the DOM while hidden");
        assert.match(text, /AccountEmail Hidden/, "the mask follows its visible lead");
        // A reveal lasts until the disclosure closes (review CR-1.1).
        const reveal = view.container.querySelector<HTMLButtonElement>('button[aria-label="Show Account Email"]')!;
        assert.ok(reveal, "the mask has its reveal control");
        await act(async () => reveal.click());
        assert.match(view.container.textContent ?? "", /ada@example\.com/, "revealed");
        await view.toggle(false);
        await view.toggle(true);
        assert.doesNotMatch(view.container.textContent ?? "", /ada@example\.com/, "closing hides it again");
        assert.ok(view.container.querySelector('button[aria-label="Show Account Email"]'), "masked again on reopening");
      } else {
        assert.match(text, /ada@example\.com/);
      }
    } finally {
      await view.unmount();
      setHideAccountEmails(false, domWindow as never);
    }
  }
});
