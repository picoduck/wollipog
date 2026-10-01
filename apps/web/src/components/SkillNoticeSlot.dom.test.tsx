import assert from "node:assert/strict";
import test from "node:test";
import React, { act } from "react";
import { createRoot } from "react-dom/client";
import { Window } from "happy-dom";
import { PROTOCOL_VERSION, type RunnerView } from "@wollipog/protocol";
import type { RunnerSkillsResponse, SkillSummary } from "../skills.js";
import type { SkillRule } from "../skill-assignment-matrix.js";
import { SkillNoticeSlot, listText, skillNoticeItem, type SkillNoticeSlotProps } from "./SkillNoticeSlot.js";
import { assertNoDomNode } from "../dom-test-assertions.js";
import { installDomTestCleanup } from "../dom-test-cleanup.js";

const domWindow = new Window({ url: "http://localhost/" });
installDomTestCleanup(domWindow);
for (const [name, value] of Object.entries({
  window: domWindow,
  document: domWindow.document,
  navigator: domWindow.navigator,
  Element: domWindow.Element,
  HTMLElement: domWindow.HTMLElement,
  HTMLButtonElement: domWindow.HTMLButtonElement,
  Node: domWindow.Node,
  Event: domWindow.Event,
  MouseEvent: domWindow.MouseEvent,
  KeyboardEvent: domWindow.KeyboardEvent,
  React,
  IS_REACT_ACT_ENVIRONMENT: true,
})) Object.defineProperty(globalThis, name, { configurable: true, writable: true, value });

const agents = [
  { id: "claude", name: "Claude Code", command: "claude", args: [], env: {}, driver: "claude-code" as const },
  { id: "codex", name: "Codex", command: "codex", args: [], env: {}, driver: "codex" as const },
  { id: "pi", name: "Pi", command: "pi", args: [], env: {}, driver: "pi" as const },
];
const studio: RunnerView = {
  runnerId: "studio", hostname: "studio", os: "linux", version: "1", status: "online", displayName: "Studio Workstation",
  agents, workspaces: [], connectedAt: 1, lastSeen: 1, protocolVersion: PROTOCOL_VERSION,
};
const machineLabels = new Map([["studio", "Studio Workstation"]]);
const digest = "d".repeat(64);
const skill = (overrides: Partial<SkillSummary> = {}): SkillSummary => ({
  id: "skill-1", name: "collect", latestVersion: { id: "v3", digest, versionNumber: 3, createdAt: 1 }, ...overrides,
} as SkillSummary);
const manualRule: SkillRule = { id: "rule-1", scopeKind: "instance", runnerId: null, agentSelector: { kind: "all" }, enabled: true, invocation: "manual" };
const manualEverywhere: RunnerSkillsResponse = {
  desired: [{ name: "collect", versionDigest: digest, targets: agents.map((agent) => ({ agentId: agent.id, invocation: "manual" as const })) }],
  reported: null,
};
const edited: RunnerSkillsResponse = {
  desired: [{ name: "collect", versionDigest: digest, targets: [{ agentId: "claude", invocation: "manual" }] }],
  reported: { deployed: [], drift: [{ name: "collect", digest, variant: "manual", observedDigest: "e".repeat(64), held: true }] },
};
const editedAndSkipping: RunnerSkillsResponse = { ...manualEverywhere, reported: edited.reported };
const recommended = { builtIn: { release: "0.29.0", heldUpdate: null }, recommendation: { dismissed: false }, assignmentCount: 0 };

test("the slot shows the most urgent item: an error, then an edited copy, then a held update, then the recommendation", () => {
  const item = (s: SkillSummary, machine: RunnerSkillsResponse | undefined, rules: SkillRule[] = [manualRule]) =>
    skillNoticeItem(s, [studio], { studio: machine }, rules)?.kind ?? null;
  assert.equal(item(skill(), editedAndSkipping), "manual-only", "an error hides an edited copy");
  assert.equal(item(skill(), edited, [{ ...manualRule, agentSelector: { kind: "driver", driver: "claude-code" } }]), "edited",
    "once the error is fixed the edited copy takes the slot");
  const failing: RunnerSkillsResponse = {
    ...edited, reported: { ...edited.reported!, deployed: [{ name: "collect", digest, links: [{ agentId: "claude", status: "error", detail: "Permission denied" }] }] },
  };
  assert.equal(item(skill(), failing), "deployment-error", "a machine's own error outranks an edited copy");
  assert.equal(item(skill(), { ...failing, desired: manualEverywhere.desired }), "manual-only", "a rule that skips agents outranks a machine error");
  const gitHeld = { enabled: true, held: { commit: "c".repeat(40), reason: "scripts" as const, scriptPaths: ["a.sh"], heldAt: 1 } };
  assert.equal(item(skill({ gitAutoUpdate: gitHeld, ...recommended }), edited), "edited");
  assert.equal(item(skill({ gitAutoUpdate: gitHeld }), undefined), "git-held");
  assert.equal(item(skill({ gitAutoUpdate: { ...gitHeld, enabled: false } }), undefined), null, "turning off updates drops the hold");
  assert.equal(item(skill({ ...recommended, builtIn: { release: "0.29.0", heldUpdate: { release: "0.30.0", digest } } }), undefined),
    "built-in-held", "a recommendation never hides a held update");
  assert.equal(item(skill(recommended), undefined), "recommended");
  assert.equal(item(skill({ ...recommended, assignmentCount: 1 }), undefined), null);
  assert.equal(item(skill(), undefined), null);
});

test("listText joins names and counts the rest", () => {
  assert.equal(listText([]), "");
  assert.equal(listText(["Codex"]), "Codex");
  assert.equal(listText(["Codex", "Pi"]), "Codex and Pi");
  assert.equal(listText(["A", "B", "C"]), "A, B and 1 more");
  assert.equal(listText(["A", "B", "C"], 3), "A, B and C");
});

async function mount(overrides: Partial<SkillNoticeSlotProps<SkillRule>> = {}) {
  const calls: string[] = [];
  const props: SkillNoticeSlotProps<SkillRule> = {
    skill: skill(),
    runners: [studio],
    machineLabels,
    machineSkills: { studio: manualEverywhere },
    rules: [manualRule],
    busy: false,
    syncingRunnerId: null,
    onSwitchToAgentInvocable: (rule) => calls.push(`switch:${rule.id}`),
    onLimitToClaudeCode: (rule) => calls.push(`limit:${rule.id}`),
    onEditGroups: () => calls.push("groups"),
    onSync: (runnerId) => calls.push(`sync:${runnerId}`),
    onReviewEdit: (runnerId, entry) => calls.push(`review-edit:${runnerId}:${entry.variant}`),
    onRestore: (runner, entry) => calls.push(`restore:${runner.runnerId}:${entry.variant}`),
    onReviewGitUpdate: () => calls.push("review-git"),
    onReviewBuiltInUpdate: () => calls.push("review-built-in"),
    onAssign: (runnerId) => calls.push(`assign:${runnerId}`),
    onChooseAgents: () => calls.push("choose-agents"),
    onDismissRecommendation: () => calls.push("dismiss"),
    ...overrides,
  };
  const host = document.createElement("div");
  document.body.append(host);
  const root = createRoot(host);
  await act(async () => { root.render(<SkillNoticeSlot {...props} />); });
  const notices = () => [...document.querySelectorAll<HTMLElement>(".skill-notice-slot .notice")];
  const notice = () => {
    assert.equal(notices().length, 1, "the slot holds exactly one notice");
    return notices()[0]!;
  };
  const actions = () => [...notice().querySelectorAll<HTMLButtonElement>(".notice-actions > button")];
  const action = (label: string) => actions().find((button) => button.textContent === label)!;
  const menuItem = (label: string) => [...document.querySelectorAll<HTMLButtonElement>('[role="menu"] [role="menuitem"]')]
    .find((item) => item.querySelector(".menu-text")?.textContent === label);
  return {
    calls, notice, actions, action, menuItem,
    body: () => notice().querySelector(".notice-body > p")?.textContent,
    async click(target: HTMLElement | undefined) {
      assert.ok(target);
      await act(async () => { target.click(); });
    },
    async unmount() { await act(async () => root.unmount()); host.remove(); },
  };
}

test("a Manual Only rule's error names the skipped agents and offers both fixes from a menu on its own button", async () => {
  const view = await mount();
  assert.equal(view.notice().classList.contains("t-danger"), true);
  assert.equal(view.notice().querySelector(".notice-title")?.textContent, "Codex and Pi Can't Run Manual-Only Skills");
  assert.equal(view.body(), "They're skipped on Studio Workstation. Switch the assignment to Agent Invocable, or limit it to Claude Code.");
  assert.deepEqual(view.actions().map((button) => button.textContent), ["Change Invocation…"]);
  const trigger = view.action("Change Invocation…");
  assert.equal(trigger.getAttribute("aria-haspopup"), "menu");
  assert.equal(trigger.getAttribute("aria-expanded"), "false");

  await view.click(trigger);
  assert.equal(trigger.getAttribute("aria-expanded"), "true");
  const menu = document.getElementById(trigger.getAttribute("aria-controls")!);
  assert.equal(menu?.getAttribute("role"), "menu", "the menu is the one this button controls");
  assert.deepEqual([...menu!.querySelectorAll('[role="menuitem"]')].map((item) => [
    item.querySelector(".menu-text")?.textContent, item.querySelector(".menu-desc")?.textContent,
  ]), [
    ["Switch to Agent Invocable", "Agents run it on their own, so Codex and Pi can use it too."],
    ["Limit to Claude Code", "Stays Manual Only, and the rule covers Claude Code only."],
  ]);
  await view.click(view.menuItem("Switch to Agent Invocable"));
  assertNoDomNode(document.querySelector('[role="menu"]'), "choosing closes the menu");
  assert.equal(document.activeElement, trigger, "and returns focus to its button");
  await view.click(trigger);
  await view.click(view.menuItem("Limit to Claude Code"));
  assert.deepEqual(view.calls, ["switch:rule-1", "limit:rule-1"]);
  await view.unmount();

  // One agent on two machines reads in the singular.
  const laptop = { ...studio, runnerId: "laptop", displayName: "Laptop" };
  const single: RunnerSkillsResponse = { desired: [{ name: "collect", versionDigest: digest, targets: [{ agentId: "codex", invocation: "manual" }] }], reported: null };
  const two = await mount({ runners: [studio, laptop], machineLabels: new Map([["studio", "Studio Workstation"], ["laptop", "Laptop"]]),
    machineSkills: { studio: single, laptop: single } });
  assert.equal(two.notice().querySelector(".notice-title")?.textContent, "Codex Can't Run Manual-Only Skills");
  assert.match(two.body() ?? "", /^It's skipped on Studio Workstation and Laptop\./);
  await two.unmount();
});

test("a group's Manual Only rule sends the person to Groups, and an unread rule offers no guess", async () => {
  const group = await mount({ rules: [{ ...manualRule, groupId: "group-1" }] });
  assert.equal(group.body(), "They're skipped on Studio Workstation. Switch the group's assignment to Agent Invocable, or limit it to Claude Code.");
  assert.deepEqual(group.actions().map((button) => button.textContent), ["Edit in Groups…"]);
  await group.click(group.action("Edit in Groups…"));
  assert.deepEqual(group.calls, ["groups"]);
  await group.unmount();

  const unknown = await mount({ rules: [] });
  assert.equal(unknown.notice().querySelector(".notice-title")?.textContent, "Codex and Pi Can't Run Manual-Only Skills");
  assert.deepEqual(unknown.actions(), []);
  await unknown.unmount();
});

test("a machine's own deployment error keeps its words behind Show Details and offers Sync Now", async () => {
  const failing: RunnerSkillsResponse = {
    desired: [{ name: "collect", versionDigest: digest, targets: [{ agentId: "claude", invocation: "agent" }] }],
    reported: { deployed: [{ name: "collect", digest, links: [{ agentId: "claude", status: "error", detail: "Permission denied on ~/.claude/skills." }] }] },
  };
  const view = await mount({ machineSkills: { studio: failing } });
  assert.equal(view.notice().querySelector(".notice-title")?.textContent, "Couldn't Deploy to Studio Workstation");
  assert.equal(view.body(), "Studio Workstation reported an error for this skill. It may not reach every agent there.");
  assert.doesNotMatch(view.notice().textContent ?? "", /Permission denied/, "the machine's words wait behind Show Details");
  await view.click(view.action("Show Details"));
  assert.match(view.notice().textContent ?? "", /Permission denied on ~\/\.claude\/skills\./);
  await view.click(view.action("Sync Now"));
  assert.deepEqual(view.calls, ["sync:studio"]);
  await view.unmount();

  const offline = await mount({ runners: [{ ...studio, status: "offline" }], machineSkills: { studio: failing } });
  const sync = offline.action("Sync Now");
  assert.equal(sync.disabled, true);
  const reason = document.getElementById(sync.getAttribute("aria-describedby")!);
  assert.equal(reason?.textContent, "Studio Workstation is offline.", "a visible reason the button names");
  await offline.unmount();
});

test("an edited copy names whose copy differs and offers Review Edit… and Restore Library Version…", async () => {
  const view = await mount({ machineSkills: { studio: edited } });
  assert.equal(view.notice().classList.contains("t-warning"), true);
  assert.equal(view.notice().querySelector(".notice-title")?.textContent, "Studio Workstation Has an Edited Copy");
  assert.equal(view.body(), "Claude Code's copy differs from v3. Updates on that machine wait until you import the edit or restore v3.");
  await view.click(view.action("Review Edit…"));
  await view.click(view.action("Restore Library Version…"));
  assert.deepEqual(view.calls, ["review-edit:studio:manual", "restore:studio:manual"]);
  await view.unmount();

  // An older runner cannot resolve it here, and says why.
  const old = await mount({ runners: [{ ...studio, protocolVersion: 1 }], machineSkills: { studio: edited } });
  assert.equal(old.action("Review Edit…").disabled, true);
  assert.equal(old.action("Restore Library Version…").disabled, true);
  assert.equal(document.getElementById(old.action("Restore Library Version…").getAttribute("aria-describedby")!)?.textContent,
    "Update this machine's runner to resolve edited copies here.");
  await old.unmount();
});

test("a held Git update names its commit and files and opens the review", async () => {
  const held = { commit: "c3d4e5f6a7b8".padEnd(40, "0"), reason: "scripts" as const, scriptPaths: ["scripts/collect.sh", "tool.py"], heldAt: 1 };
  const view = await mount({ skill: skill({ gitAutoUpdate: { enabled: true, held } }), machineSkills: {} });
  assert.equal(view.notice().querySelector(".notice-title")?.textContent, "Update Held for Review");
  assert.equal(view.body(), "Commit c3d4e5f6a7b8 adds or changes scripts/collect.sh and tool.py. Review it before it deploys.");
  await view.click(view.action("Review Update…"));
  assert.deepEqual(view.calls, ["review-git"]);
  await view.unmount();
});

test("no notice in the slot has more than two action buttons plus one menu button", async () => {
  const held = { commit: "c".repeat(40), reason: "local_changes" as const, scriptPaths: [], heldAt: 1 };
  const cases: Array<Partial<SkillNoticeSlotProps<SkillRule>>> = [
    {},
    { machineSkills: { studio: edited } },
    { skill: skill({ gitAutoUpdate: { enabled: true, held } }), machineSkills: {} },
    { skill: skill({ ...recommended, builtIn: { release: "0.29.0", heldUpdate: { release: "0.30.0", digest } } }), machineSkills: {} },
    { skill: skill(recommended), machineSkills: {} },
  ];
  for (const overrides of cases) {
    const view = await mount(overrides);
    const buttons = view.actions().filter((button) => !button.classList.contains("notice-details-toggle"));
    const menus = buttons.filter((button) => button.getAttribute("aria-haspopup") === "menu");
    assert.ok(menus.length <= 1 && buttons.length - menus.length <= 2, view.notice().querySelector(".notice-title")?.textContent ?? "");
    await view.unmount();
  }
});
