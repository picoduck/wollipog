import assert from "node:assert/strict";
import test from "node:test";
import React, { act } from "react";
import { createRoot } from "react-dom/client";
import { Window } from "happy-dom";
import { PROTOCOL_VERSION, type RunnerView } from "@wollipog/protocol";
import type { RunnerSkillsResponse, SkillGroupView, SkillSummary } from "../skills.js";
import { SkillList, type SkillListProps } from "./SkillList.js";
import { assertNoDomNode } from "../dom-test-assertions.js";
import { installDomTestCleanup } from "../dom-test-cleanup.js";

const domWindow = new Window({ url: "http://localhost/" });
installDomTestCleanup(domWindow);
for (const [name, value] of Object.entries({
  window: domWindow,
  document: domWindow.document,
  navigator: domWindow.navigator,
  HTMLElement: domWindow.HTMLElement,
  HTMLButtonElement: domWindow.HTMLButtonElement,
  HTMLInputElement: domWindow.HTMLInputElement,
  Node: domWindow.Node,
  Event: domWindow.Event,
  InputEvent: domWindow.InputEvent,
  MouseEvent: domWindow.MouseEvent,
  KeyboardEvent: domWindow.KeyboardEvent,
  requestAnimationFrame: domWindow.requestAnimationFrame.bind(domWindow),
  cancelAnimationFrame: domWindow.cancelAnimationFrame.bind(domWindow),
  React,
  IS_REACT_ACT_ENVIRONMENT: true,
})) Object.defineProperty(globalThis, name, { configurable: true, writable: true, value });

const agent = { id: "claude", name: "Claude", command: "claude", args: [], env: {}, driver: "claude-code" as const, available: true };
const runner = {
  runnerId: "runner-1", hostname: "build", os: "linux", version: "1", status: "online", displayName: "Build Machine",
  agents: [agent], workspaces: [], connectedAt: 1, lastSeen: 1, protocolVersion: PROTOCOL_VERSION,
} as unknown as RunnerView;
const target = (name: string) => ({ name, versionDigest: "d1", targets: [{ agentId: "claude", invocation: "agent" as const }] });
/** deploy-bot fails to link; notes-helper is linked and edited; code-review is linked. */
const machine: RunnerSkillsResponse = {
  desired: [target("deploy-bot"), target("notes-helper"), target("code-review")],
  reported: {
    deployed: [
      { name: "deploy-bot", digest: "d1", links: [{ agentId: "claude", status: "error", detail: "EACCES" }] },
      { name: "notes-helper", digest: "d1", links: [{ agentId: "claude", status: "linked" }] },
      { name: "code-review", digest: "d1", links: [{ agentId: "claude", status: "linked" }] },
    ],
    // deploy-bot is also edited: Error outranks it.
    drift: [{ name: "notes-helper", digest: "d1", variant: "agent", held: false }, { name: "deploy-bot", digest: "d1", variant: "agent", held: false }],
  },
};
const LONG = `${"Plans a campaign of child sessions and waits for each one to report. ".repeat(14)}Then it reconciles the\nmerge queue.`;
const gitSource = { url: "https://example.test/skills.git", ref: "main", subdirectory: "", path: "", commit: "c1" };
const skills: SkillSummary[] = [
  { id: "s1", name: "orchestrate-issues", description: LONG, builtIn: { release: "0.29.0", heldUpdate: null },
    recommendation: { dismissed: false }, assignmentCount: 0 },
  { id: "s2", name: "deploy-bot", description: "Ships builds", assignmentCount: 1, groupId: "g1" },
  { id: "s3", name: "notes-helper", description: "Writes\nrelease notes", assignmentCount: 1 },
  { id: "s4", name: "code-review", description: null, assignmentCount: 1, groupId: "g1" },
  { id: "s5", name: "qa", description: "QA", assignmentCount: 0 },
  { id: "s6", name: "lint-rules", description: "Keeps lint rules current", assignmentCount: 2, gitSource,
    gitAutoUpdate: { enabled: true, held: { commit: "c2", reason: "scripts", scriptPaths: ["x.sh"], heldAt: 1 } } },
];
const groups: SkillGroupView[] = [{ id: "g1", name: "Platform Team", sortOrder: 1 }];

async function mount(overrides: Partial<SkillListProps> = {}) {
  const mountPoint = domWindow.document.createElement("div") as unknown as HTMLDivElement;
  domWindow.document.body.append(mountPoint as never);
  const root = createRoot(mountPoint);
  const selected: string[] = [];
  let orphansOpened = 0;
  const props: SkillListProps = {
    skills, groups, runners: [runner], machineSkills: { "runner-1": machine }, selectedId: null,
    onSelect: (id) => { selected.push(id); },
    orphans: { shown: false, count: 0, selected: false, onOpen: () => { orphansOpened += 1; } },
    ...overrides,
  };
  await act(async () => root.render(<SkillList {...props} />));
  // The menu is portalled to <body>.
  const body = domWindow.document.body as unknown as HTMLElement;
  const rows = () => [...mountPoint.querySelectorAll<HTMLButtonElement>(".skill-row")];
  const row = (name: string) => rows().find((candidate) => candidate.querySelector(".row-title")?.textContent === name);
  return {
    list: mountPoint,
    body,
    selected,
    orphansOpened: () => orphansOpened,
    names: () => rows().map((candidate) => candidate.querySelector(".row-title")?.textContent),
    groupLabels: () => [...mountPoint.querySelectorAll(".skill-list-group-title")].map((title) => title.firstChild?.textContent),
    row,
    badges: (name: string) => [...(row(name)?.querySelectorAll(".status") ?? [])].map((badge) => ({
      label: badge.textContent, flag: badge.classList.contains("no-dot"), tone: [...badge.classList].find((name) => name.startsWith("t-")),
    })),
    async type(value: string) {
      const input = mountPoint.querySelector<HTMLInputElement>('input[type="search"]')!;
      const setter = Object.getOwnPropertyDescriptor(domWindow.HTMLInputElement.prototype, "value")!.set!;
      await act(async () => {
        input.focus();
        setter.call(input, value);
        input.dispatchEvent(new domWindow.InputEvent("input", { bubbles: true, data: value }) as never);
        // React reads a happy-dom value change only once a key event follows it.
        input.dispatchEvent(new domWindow.KeyboardEvent("keyup", { bubbles: true }) as never);
      });
    },
    async click(element: Element | undefined | null) {
      assert.ok(element);
      await act(async () => (element as HTMLElement).click());
    },
    async choose(label: string) {
      const trigger = mountPoint.querySelector<HTMLButtonElement>('button[aria-label="View Options"]')!;
      await act(async () => trigger.click());
      const item = [...body.querySelectorAll<HTMLButtonElement>('[role="menu"] [role="menuitemradio"]')]
        .find((candidate) => candidate.textContent === label);
      assert.ok(item, `${label} is a View Options choice`);
      await act(async () => item.click());
    },
    async unmount() {
      await act(async () => root.unmount());
      mountPoint.remove();
    },
  };
}

test("rows are two-line rows: a one-line description, No description when missing, none when it repeats the name", async () => {
  const view = await mount();
  try {
    assert.ok(view.list.querySelectorAll(".skill-row").length === skills.length);
    assert.ok([...view.list.querySelectorAll(".skill-row")].every((row) => row.matches("button.row.row-2")),
      "every skill row is a two-line row, whatever its description");
    assert.equal(view.row("notes-helper")!.querySelector(".row-sub")?.textContent, "Writes release notes", "line breaks collapse");
    assert.equal(view.row("orchestrate-issues")!.querySelector(".row-sub")?.textContent, LONG.replace(/\s+/g, " "),
      "the row holds the full text and CSS draws the ellipsis; nothing expands it");
    assert.equal(view.row("orchestrate-issues")!.getAttribute("title"), null);
    const missing = view.row("code-review")!.querySelector(".row-sub")!;
    assert.equal(missing.textContent, "No description");
    assert.ok(missing.classList.contains("is-empty"));
    assertNoDomNode(view.row("qa")!.querySelector(".row-sub"), "a description equal to the name is not shown");
  } finally {
    await view.unmount();
  }
});

test("a row shows at most one status, only when the skill needs the user, and Built-In as a flag", async () => {
  const view = await mount();
  try {
    assert.deepEqual(view.badges("orchestrate-issues"), [{ label: "Built-In", flag: true, tone: "t-neutral" }],
      "a healthy, recommended built-in skill has the flag and no status");
    assert.deepEqual(view.badges("deploy-bot"), [{ label: "Error", flag: false, tone: "t-danger" }], "Error outranks Edited");
    assert.deepEqual(view.badges("notes-helper"), [{ label: "Edited", flag: false, tone: "t-warning" }]);
    assert.deepEqual(view.badges("lint-rules"), [{ label: "Update Held", flag: false, tone: "t-warning" }]);
    assert.deepEqual(view.badges("code-review"), []);
    assert.equal(view.row("deploy-bot")!.querySelector(".status")?.classList.contains("skill-row-status"), true);
    assertNoDomNode([...view.list.querySelectorAll(".status")].find((badge) => badge.textContent === "Recommended") ?? null,
      "Recommended is a group, not a badge");
  } finally {
    await view.unmount();
  }
});

test("groups read Recommended, No Group, then named groups, with plain counts and no retired labels", async () => {
  const view = await mount();
  try {
    assert.deepEqual(view.groupLabels(), ["Recommended", "No Group", "Platform Team"]);
    assert.deepEqual([...view.list.querySelectorAll(".skill-list-group-count")].map((count) => count.textContent), ["1", "3", "2"]);
    assert.deepEqual(view.names(), ["orchestrate-issues", "lint-rules", "notes-helper", "qa", "code-review", "deploy-bot"]);
    assert.doesNotMatch(view.list.textContent ?? "", /Ungrouped|All Skills/);
  } finally {
    await view.unmount();
  }
});

test("the filter matches words past the ellipsis, and no match is a no-results row with Clear Search", async () => {
  const view = await mount();
  try {
    await view.type("reconciles");
    assert.deepEqual(view.names(), ["orchestrate-issues"], "a word only in the hidden part of the description matches");
    await view.type("the merge");
    assert.deepEqual(view.names(), ["orchestrate-issues"], "a line break matches as a space");
    await view.type("terr");
    assert.deepEqual(view.names(), []);
    const state = view.list.querySelector(".state.no-results")!;
    assert.equal(state.getAttribute("role"), "status");
    assert.equal(state.querySelector(".state-body")?.textContent, "No skills match “terr”.");
    assert.ok(state.querySelector(".state-body svg"), "the Search icon leads the sentence");
    const clear = [...state.querySelectorAll("button")].find((button) => button.textContent === "Clear Search");
    assert.equal(clear?.className, "btn sm");
    await view.click(clear);
    assert.equal(view.names().length, skills.length);
    assert.equal(view.list.querySelector<HTMLInputElement>('input[type="search"]')!.value, "");
  } finally {
    await view.unmount();
  }
});

test("View Options holds Show and Group By, checks the current choice, and narrows or flattens the list", async () => {
  const view = await mount();
  try {
    const trigger = view.list.querySelector<HTMLButtonElement>('button[aria-label="View Options"]')!;
    assert.equal(trigger.getAttribute("title"), "View Options");
    assert.equal(trigger.getAttribute("aria-haspopup"), "menu");
    await view.click(trigger);
    const menu = view.body.querySelector('[role="menu"][aria-label="View Options"]')!;
    assert.deepEqual([...menu.querySelectorAll(".menu-label")].map((label) => label.textContent), ["Show", "Group By"]);
    const items = [...menu.querySelectorAll('[role="menuitemradio"]')];
    assert.deepEqual(items.map((item) => item.textContent),
      ["All Skills", "Needs Attention", "Imported from Git", "Built-In", "Not Assigned", "Group", "None"]);
    assert.deepEqual(items.filter((item) => item.getAttribute("aria-checked") === "true").map((item) => item.textContent), ["All Skills", "Group"]);
    assert.ok(items.find((item) => item.textContent === "All Skills")!.querySelector(".menu-check"));
    await view.click(view.body.querySelector(".menu-backdrop"));

    await view.choose("Needs Attention");
    assertNoDomNode(view.body.querySelector('[role="menu"]'), "a choice closes the menu");
    assert.deepEqual(view.names(), ["lint-rules", "notes-helper", "deploy-bot"]);
    assert.ok(view.names().every((name) => view.badges(name!).some((badge) => !badge.flag)), "only skills with a status badge");
    await view.choose("Imported from Git");
    assert.deepEqual(view.names(), ["lint-rules"]);
    await view.choose("Built-In");
    assert.deepEqual(view.names(), ["orchestrate-issues"]);
    await view.choose("Not Assigned");
    assert.deepEqual(view.names(), ["orchestrate-issues", "qa"]);
    await view.choose("All Skills");

    await view.choose("None");
    assert.deepEqual(view.groupLabels(), [], "one flat list has no group labels");
    assert.deepEqual(view.names(), ["code-review", "deploy-bot", "lint-rules", "notes-helper", "orchestrate-issues", "qa"]);
    await view.choose("Group");
    assert.deepEqual(view.groupLabels(), ["Recommended", "No Group", "Platform Team"]);
  } finally {
    await view.unmount();
  }
});

test("a Show choice with nothing in it says so and offers every skill again", async () => {
  const view = await mount({ skills: skills.filter((skill) => !skill.builtIn) });
  try {
    await view.choose("Built-In");
    const state = view.list.querySelector(".state.no-results")!;
    assert.equal(state.querySelector(".state-body")?.textContent, "No skills match the Built-In view.");
    await view.click([...state.querySelectorAll("button")].find((button) => button.textContent === "Show All Skills"));
    assert.equal(view.names().length, skills.length - 1);
  } finally {
    await view.unmount();
  }
});

test("Orphaned Copies ends the list with its count only while copies exist, and opens the pane", async () => {
  const hidden = await mount();
  try {
    assertNoDomNode(hidden.list.querySelector(".list-foot"), "nothing to show, no entry");
  } finally {
    await hidden.unmount();
  }
  const view = await mount({ orphans: { shown: true, count: 3, selected: false, onOpen: () => {} } });
  try {
    const body = view.list.querySelector(".master-detail-list-body")!;
    const foot = body.lastElementChild!;
    assert.ok(foot.matches(".list-foot"), "the entry follows the last group");
    const entry = foot.querySelector<HTMLButtonElement>("button.row")!;
    assert.equal(entry.querySelector(".row-title")?.textContent, "Orphaned Copies");
    const badge = entry.querySelector(".count-badge")!;
    assert.equal(badge.textContent, "3");
    assert.equal(badge.classList.contains("danger"), false, "the amber count badge");
    const description = domWindow.document.getElementById(entry.getAttribute("aria-describedby")!);
    assert.equal(description?.textContent, "3 copies", "the count is in the entry's description, not only in the aria-hidden badge");
  } finally {
    await view.unmount();
  }
  let opened = 0;
  const selected = await mount({ orphans: { shown: true, count: 1, selected: true, onOpen: () => { opened += 1; } } });
  try {
    const entry = selected.list.querySelector<HTMLButtonElement>(".list-foot button.row")!;
    assert.equal(entry.getAttribute("aria-current"), "true");
    assert.ok(entry.classList.contains("is-selected"));
    await selected.click(entry);
    assert.equal(opened, 1);
  } finally {
    await selected.unmount();
  }
});

test("while the library loads the list is skeleton rows only", async () => {
  const view = await mount({ skills: null, orphans: { shown: true, count: 2, selected: false, onOpen: () => {} } });
  try {
    const skeleton = view.list.querySelector(".master-detail-list-body > .skeleton")!;
    assert.equal(skeleton.getAttribute("role"), "status");
    assert.equal(skeleton.querySelectorAll(".row.row-2.skill-row-skeleton").length, 5);
    assert.deepEqual([...skeleton.querySelectorAll(".skill-row-skeleton")[0]!.querySelectorAll(".skeleton-bar")].map((bar) => bar.className),
      ["skeleton-bar title", "skeleton-bar"]);
    assertNoDomNode(view.list.querySelector(".list-foot"));
    assertNoDomNode(view.list.querySelector(".state"));
  } finally {
    await view.unmount();
  }
});

test("a row selects its skill and marks the selection", async () => {
  const view = await mount({ selectedId: "s3" });
  try {
    assert.equal(view.row("notes-helper")!.getAttribute("aria-current"), "true");
    assert.ok(view.row("notes-helper")!.classList.contains("is-selected"));
    assert.equal(view.list.querySelectorAll(".is-selected").length, 1);
    await view.click(view.row("qa"));
    assert.deepEqual(view.selected, ["s5"]);
  } finally {
    await view.unmount();
  }
});
