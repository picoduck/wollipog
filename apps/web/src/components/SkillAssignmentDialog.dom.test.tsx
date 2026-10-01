import assert from "node:assert/strict";
import test from "node:test";
import React, { act } from "react";
import { createRoot } from "react-dom/client";
import { Window } from "happy-dom";
import { PROTOCOL_VERSION, type RunnerView } from "@wollipog/protocol";
import { AddAssignmentDialog, type AddAssignmentInput, type AddAssignmentVariant } from "./SkillAssignmentDialog.js";
import { installDomTestCleanup } from "../dom-test-cleanup.js";

const domWindow = new Window({ url: "http://localhost/" });
installDomTestCleanup(domWindow);
Object.defineProperty(domWindow, "matchMedia", {
  configurable: true,
  value: (query: string) => ({ matches: false, media: query, addEventListener() {}, removeEventListener() {} }),
});
for (const [name, value] of Object.entries({
  window: domWindow,
  document: domWindow.document,
  navigator: domWindow.navigator,
  HTMLElement: domWindow.HTMLElement,
  HTMLButtonElement: domWindow.HTMLButtonElement,
  HTMLInputElement: domWindow.HTMLInputElement,
  Node: domWindow.Node,
  Event: domWindow.Event,
  MouseEvent: domWindow.MouseEvent,
  KeyboardEvent: domWindow.KeyboardEvent,
  requestAnimationFrame: domWindow.requestAnimationFrame.bind(domWindow),
  cancelAnimationFrame: domWindow.cancelAnimationFrame.bind(domWindow),
  React,
  IS_REACT_ACT_ENVIRONMENT: true,
})) Object.defineProperty(globalThis, name, { configurable: true, writable: true, value });

const document = domWindow.document as unknown as Document;
const settle = async () => {
  for (let i = 0; i < 5; i += 1) await act(async () => { await new Promise((resolve) => domWindow.setTimeout(resolve, 0)); });
};

const agent = (id: string, name: string, driver: "claude-code" | "codex" | "codex-app-server" | "pi" | "acp") =>
  ({ id, name, command: id, args: [], env: {}, driver, available: true });
const runner: RunnerView = {
  runnerId: "runner-1", hostname: "build", os: "linux", version: "1", status: "online", displayName: "Build Machine",
  agents: [
    agent("claude", "Claude", "claude-code"),
    agent("codex-review", "Codex Review", "codex"),
    agent("pi", "Pi Agent", "pi"),
    agent("gemini", "Gemini", "acp"),
  ],
  workspaces: [], connectedAt: 1, lastSeen: 1, protocolVersion: PROTOCOL_VERSION,
};
const claudeOnly: RunnerView = { ...runner, runnerId: "runner-2", status: "offline", displayName: "Laptop", agents: [agent("claude", "Claude", "claude-code")] };

async function mount(variant: AddAssignmentVariant = { variant: "skill" }, error: string | null = null) {
  const created: AddAssignmentInput[] = [];
  const host = document.createElement("div");
  document.body.append(host);
  const root = createRoot(host);
  await act(async () => root.render(
    <AddAssignmentDialog {...variant} runners={[runner, claudeOnly]}
      machineLabels={new Map([["runner-1", "Build Machine"], ["runner-2", "Laptop"]])}
      busy={false} error={error} onClose={() => undefined} onCreate={async (input) => { created.push(input); }} />,
  ));
  const dialog = document.querySelector<HTMLElement>('[role="dialog"]')!;
  return { dialog, created, unmount: async () => { await act(async () => root.unmount()); host.remove(); } };
}

function button(scope: ParentNode, name: string): HTMLButtonElement {
  const found = [...scope.querySelectorAll<HTMLButtonElement>("button")]
    .find((candidate) => (candidate.getAttribute("aria-label") ?? candidate.textContent?.trim()) === name);
  assert.ok(found, `a button named ${name}`);
  return found;
}

function selectField(dialog: HTMLElement, label: string): HTMLElement {
  const field = [...dialog.querySelectorAll<HTMLElement>(".field")]
    .find((candidate) => candidate.querySelector(".field-head")?.textContent === label);
  assert.ok(field, `a ${label} field`);
  return field;
}

/** Open a Select and read its list: section labels as "# Label", options as "Label — Description". */
async function openList(field: HTMLElement): Promise<string[]> {
  await act(async () => field.querySelector<HTMLButtonElement>(".ui-select-trigger")!.click());
  const list = field.querySelector('[role="listbox"]')!;
  return [...list.querySelectorAll(".menu-label, [role=\"option\"]")].map((node) => node.classList.contains("menu-label")
    ? `# ${node.textContent}`
    : [node.querySelector(".ui-select-option-body > span")?.textContent, node.querySelector(".ui-select-option-desc")?.textContent]
      .filter(Boolean).join(" — "));
}

async function choose(field: HTMLElement, label: string) {
  if (!field.querySelector('[role="listbox"]')) await openList(field);
  const option = [...field.querySelectorAll<HTMLButtonElement>('[role="option"]')]
    .find((candidate) => candidate.querySelector(".ui-select-option-body > span")?.textContent === label)!;
  await act(async () => option.click());
}

test("Add Assignment names agent types plainly, under Agent Types, and the chosen machine's agents under On This Machine", async () => {
  const view = await mount();
  try {
    const { dialog } = view;
    assert.equal(dialog.querySelector("h2")?.textContent, "Add Assignment");
    assert.match(dialog.textContent ?? "", /Choose where this skill is deployed\./);
    assert.deepEqual([...dialog.querySelectorAll(".field-head")].map((head) => head.firstElementChild?.textContent),
      ["Machine", "Agents", "Invocation"]);

    const agents = selectField(dialog, "Agents");
    assert.deepEqual(await openList(agents), [
      "All Agents — Every agent that can use skills",
      "# Agent Types",
      "Claude Code — On any machine",
      "Codex (Command Line) — On any machine",
      "Codex (App Server) — On any machine",
      "Pi — On any machine",
    ]);
    const group = agents.querySelector('[role="group"]')!;
    assert.equal(document.getElementById(group.getAttribute("aria-labelledby")!)?.textContent, "Agent Types");
    assert.doesNotMatch(dialog.textContent ?? "", /Native|Non-Interactive|Pi RPC/);
    await choose(agents, "Codex (Command Line)");

    const machine = selectField(dialog, "Machine");
    assert.deepEqual(await openList(machine), [
      "All Machines — Every machine, including ones connected later",
      "Build Machine — 3 agents can use skills",
      "Laptop — Offline · 1 agent can use skills",
    ]);
    await choose(machine, "Build Machine");
    const list = await openList(agents);
    assert.deepEqual(list.slice(list.indexOf("# On This Machine")), [
      "# On This Machine",
      "Claude — Claude Code",
      "Codex Review — Codex (Command Line)",
      "Pi Agent — Pi",
    ], "only agents skills can reach, each with its type");
    assert.equal(list[2], "Claude Code — Any agent of this type on this machine");
    assert.doesNotMatch(dialog.textContent ?? "", /Native|Non-Interactive|Pi RPC/);
    await choose(agents, "Codex Review");

    await act(async () => button(dialog, "Add Assignment").click());
    await settle();
    assert.deepEqual(view.created, [{
      scopeKind: "runner", runnerId: "runner-1", agentSelector: { kind: "agent", agentId: "codex-review" }, invocation: "agent",
    }]);
  } finally {
    await view.unmount();
  }
});

test("Manual Only names, before the rule is added, the chosen machine's agents that can't run it", async () => {
  const view = await mount();
  try {
    const { dialog } = view;
    const invocation = selectField(dialog, "Invocation");
    const radios = [...invocation.querySelectorAll<HTMLButtonElement>('[role="radio"]')];
    assert.deepEqual(radios.map((radio) => radio.textContent), ["Agent Invocable", "Manual Only"]);
    assert.ok(invocation.querySelector(".seg.block"), "a full-width segmented control");
    const helper = () => invocation.querySelector(".field-helper")?.textContent;
    const warning = () => invocation.querySelector(".field-warn")?.textContent ?? null;
    assert.equal(helper(), "Agents use the skill on their own whenever a task calls for it.");

    await act(async () => radios[1]!.click());
    assert.equal(helper(), "Only a person can start the skill, and only Claude Code agents support it.");
    assert.equal(warning(), null, "All Machines with All Agents names no one");

    await choose(selectField(dialog, "Machine"), "Build Machine");
    assert.equal(warning(), "Codex Review and Pi Agent can't run manual-only skills, so this assignment will show them as unsupported.");
    const description = document.getElementById(radios[1]!.getAttribute("aria-describedby")!)?.textContent ?? "";
    assert.match(description, /Codex Review and Pi Agent can't run/, "the Manual Only option announces it too");

    await choose(selectField(dialog, "Agents"), "Claude Code");
    assert.equal(warning(), null, "Claude Code alone runs manual-only skills");
    await choose(selectField(dialog, "Agents"), "Pi Agent");
    assert.equal(warning(), "Pi Agent can't run manual-only skills, so this assignment will show it as unsupported.");

    await choose(selectField(dialog, "Machine"), "All Machines");
    await choose(selectField(dialog, "Agents"), "Codex (App Server)");
    assert.equal(warning(), "Codex (App Server) agents can't run manual-only skills, so this assignment will show them as unsupported.");

    await act(async () => button(dialog, "Add Assignment").click());
    await settle();
    assert.deepEqual(view.created, [{ scopeKind: "instance", agentSelector: { kind: "driver", driver: "codex-app-server" }, invocation: "manual" }]);
  } finally {
    await view.unmount();
  }
});

test("opened from Manage Groups the dialog is Add Group Assignment, and no sentence reads as a skill name", async () => {
  const view = await mount({ variant: "group", groupName: "Review Pack" });
  try {
    const { dialog } = view;
    assert.equal(dialog.querySelector("h2")?.textContent, "Add Group Assignment");
    assert.match(dialog.textContent ?? "", /Every skill in Review Pack, now and later, is deployed here\./);
    assert.doesNotMatch(dialog.textContent ?? "", /all current and future members of/);
  } finally {
    await view.unmount();
  }
});

test("a server error is a danger notice at the end of the body, above the footer", async () => {
  const view = await mount({ variant: "skill" }, "HTTP 409: an identical assignment exists");
  try {
    const notice = view.dialog.querySelector(".form")!.lastElementChild!;
    assert.equal(notice.getAttribute("role"), "alert");
    assert.match(notice.textContent ?? "", /Couldn't Add the Assignment.*identical assignment/);
  } finally {
    await view.unmount();
  }
});
