import assert from "node:assert/strict";
import test from "node:test";
import React, { act } from "react";
import { createRoot } from "react-dom/client";
import { Window } from "happy-dom";
import type { RunnerView } from "@wollipog/protocol";
import { api, type ApiClient } from "../api.js";
import { ApiProvider } from "../api-context.js";
import { assertNoDomNode } from "../dom-test-assertions.js";
import { installDomTestCleanup } from "../dom-test-cleanup.js";
import type { RunnerSkillsResponse } from "../skills.js";
import { MachineSkillsSection } from "./MachineSkillsSection.js";

const domWindow = new Window({ url: "http://localhost/" });
installDomTestCleanup(domWindow);
for (const [name, value] of Object.entries({
  window: domWindow, document: domWindow.document, navigator: domWindow.navigator,
  HTMLElement: domWindow.HTMLElement, Node: domWindow.Node, React, IS_REACT_ACT_ENVIRONMENT: true,
})) Object.defineProperty(globalThis, name, { configurable: true, writable: true, value });

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
    assert.match(text, /Unmanaged Skills/);
    assert.match(text, /local-notes · Work Account · Claude Code — Scratch skill/);
    assert.doesNotMatch(text, /claude-main|acct-work/, "the agent's name and the account's label, never their ids");
    assert.match(text, /can then be adopted with an explicit recovery-aware confirmation/);
    assert.match(text, /Recent Link Removals/);
    // The machine's whole history: every skill's, including one the library no longer has.
    assert.match(text, /~\/\.claude\/skills\/code-review — No longer in the desired skill list\./);
    assert.match(text, /~\/\.codex\/skills\/deleted-skill · Work Account — The canonical location/);
    assert.match(text, new RegExp(`Reported ${new Date(1_699_999_000_000).toLocaleString().replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}`),
      "the removal history's own timestamp, not the newer inventory's");
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

test("a failed read says so and retries on the next open; a runner without skills shows nothing", async () => {
  let fail = true;
  const view = await open(async () => { if (fail) throw new Error("HTTP 503"); return reported("supported"); });
  try {
    await view.toggle(true);
    assert.match(view.container.querySelector('[role="alert"]')?.textContent ?? "", /could not be loaded/);
    fail = false;
    await view.toggle(false);
    await view.toggle(true);
    assert.match(view.container.textContent ?? "", /local-notes/);
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
