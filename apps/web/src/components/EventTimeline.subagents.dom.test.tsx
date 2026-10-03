import assert from "node:assert/strict";
import { test } from "node:test";
import React, { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { Window } from "happy-dom";
import type { TimelineItem } from "../timeline.js";
import { assertNoDomNode } from "../dom-test-assertions.js";
import { installDomTestCleanup } from "../dom-test-cleanup.js";
import { EventTimeline } from "./EventTimeline.js";

const domWindow = new Window({ url: "http://localhost/" });
for (const [name, value] of Object.entries({
  window: domWindow,
  document: domWindow.document,
  navigator: domWindow.navigator,
  HTMLElement: domWindow.HTMLElement,
  Node: domWindow.Node,
  React,
  IS_REACT_ACT_ENVIRONMENT: true,
})) Object.defineProperty(globalThis, name, { configurable: true, writable: true, value });

const { cleanup } = installDomTestCleanup(domWindow);

async function mount(): Promise<{ container: HTMLDivElement; root: Root }> {
  const container = domWindow.document.createElement("div") as unknown as HTMLDivElement;
  domWindow.document.body.append(container as never);
  const root = createRoot(container);
  cleanup(async () => {
    await act(async () => { root.unmount(); });
    container.remove();
  });
  return { container, root };
}

async function openWork(container: HTMLElement) {
  for (const disclosure of container.querySelectorAll<HTMLButtonElement>(".tl-work > .disclosure-trigger")) {
    if (disclosure.getAttribute("aria-expanded") !== "true") await act(async () => disclosure.click());
  }
}

const agent = (id: number, toolCallId: string, title: string, status: string, extra: Partial<TimelineItem> = {}): TimelineItem => ({
  kind: "tool_call", id, toolCallId, title, toolKind: "agent", status, text: "", ...extra,
} as TimelineItem);
const read = (id: number, path: string, parentToolUseId: string): TimelineItem => ({
  kind: "tool_call", id, toolCallId: `read-${id}`, title: `Read: ${path}`, toolKind: "read", status: "completed", text: "", parentToolUseId,
});

/** One turn that spawned a running and a completed agent; the running one spawned a failed agent. */
const turn: TimelineItem[] = [
  { kind: "user_message", id: 1, text: "Audit the release" },
  agent(2, "audit", "Coordinate Release Audit", "in_progress", { subagentLifecycle: "running", subagentRole: "explorer" }),
  read(3, "release.json", "audit"),
  agent(4, "gates", "Agent: Check Compatibility Gates", "failed", { parentToolUseId: "audit", text: "Agent failed: quota exhausted" }),
  read(5, "gates.ts", "gates"),
  agent(6, "notes", "Draft Release Notes", "completed"),
  read(7, "CHANGELOG.md", "notes"),
  read(8, "README.md", "notes"),
];

const agentRow = (container: HTMLElement, name: string) =>
  [...container.querySelectorAll<HTMLElement>(".tl-agent")].find((row) => row.querySelector(".tl-agent-name")?.textContent === name);

test("each spawned agent is one row named after its spawning call, with its step count and status", async () => {
  const { container, root } = await mount();
  await act(async () => root.render(<EventTimeline items={turn} sessionActive />));
  await openWork(container);

  const rows = [...container.querySelectorAll<HTMLElement>(".tl-agent")];
  assert.deepEqual(rows.map((row) => row.querySelector(".tl-agent-name")?.textContent), [
    "Coordinate Release Audit",
    "Check Compatibility Gates",
    "Draft Release Notes",
  ]);
  assert.deepEqual(rows.map((row) => row.querySelector(".tl-agent-meta")?.textContent), ["Explorer2 Steps", "1 Step", "2 Steps"],
    "the role, when the provider gave one, then the step count");
  assert.doesNotMatch(container.textContent ?? "", /Agent · \d+ Step/, "no row reads \"Agent · 1 Step\"");
  assert.equal(container.querySelector("svg.lucide-bot, .tl-agent .tl-step-icon svg") != null, true, "the row carries the Bot icon");

  const stepTitles = [...container.querySelectorAll(".tl-step-title")].map((title) => title.textContent);
  for (const name of ["Coordinate Release Audit", "Check Compatibility Gates", "Draft Release Notes"]) {
    assert.equal(stepTitles.some((title) => title?.includes(name)), false, `no separate tool row repeats "${name}"`);
  }
  assert.equal(container.textContent?.includes("⑃"), false, "the ⑃ glyph is gone");

  const toggle = agentRow(container, "Coordinate Release Audit")!.querySelector<HTMLButtonElement>("button[aria-expanded]")!;
  assert.ok(toggle.matches(".disclosure-trigger"), "the disclosure is a §5.5 trigger button");
  assert.equal(toggle.getAttribute("aria-label"), "Coordinate Release Audit · Explorer · 2 Steps · Running",
    "the disclosure's accessible name starts with the visible name");
});

test("a running agent shows a pulsing Running badge; completed and failed agents show inline statuses", async () => {
  const { container, root } = await mount();
  await act(async () => root.render(<EventTimeline items={turn} sessionActive />));
  await openWork(container);

  const running = agentRow(container, "Coordinate Release Audit")!.querySelector(".tl-agent-status")!;
  assert.equal(running.textContent, "Running");
  assert.ok(running.matches(".status.t-info.pulse"), "an info badge whose dot pulses");
  assert.equal(running.matches(".inline"), false, "Running is a pill, not inline");

  const completed = agentRow(container, "Draft Release Notes")!.querySelector(".tl-agent-status")!;
  assert.equal(completed.textContent, "Completed");
  assert.ok(completed.matches(".status.inline.t-success"));
  assert.equal(completed.matches(".pulse"), false);

  const failed = agentRow(container, "Check Compatibility Gates")!.querySelector(".tl-agent-status")!;
  assert.equal(failed.textContent, "Failed");
  assert.ok(failed.matches(".status.inline.t-danger"));
});

test("Open is a small ghost button beside the disclosure whose name starts with its label", async () => {
  const opened: string[] = [];
  const { container, root } = await mount();
  await act(async () => root.render(<EventTimeline items={turn} sessionActive onOpenSubagent={(id) => opened.push(id)} />));
  await openWork(container);

  const row = agentRow(container, "Draft Release Notes")!;
  const toggle = row.querySelector<HTMLButtonElement>(".tl-agent-toggle")!;
  const open = row.querySelector<HTMLButtonElement>(":scope > .btn.sm.ghost")!;
  assert.ok(open, "Open is the disclosure's sibling, a .btn.sm.ghost");
  assert.equal(open.textContent, "Open");
  assert.equal(open.getAttribute("aria-label"), "Open Draft Release Notes");
  await act(async () => open.click());
  assert.deepEqual(opened, ["notes"], "Open keeps its handler: it opens this agent in the Agents panel");
  assert.equal(toggle.getAttribute("aria-expanded"), "true", "Open does not toggle the disclosure");

  await act(async () => root.render(<EventTimeline items={turn} sessionActive />));
  assertNoDomNode(container.querySelector(".tl-agent .btn"), "no Open without a handler");
});

test("a nested agent's steps sit on the work rule, with no inline margin on any agent row", async () => {
  const { container, root } = await mount();
  await act(async () => root.render(<EventTimeline items={turn} sessionActive />));
  await openWork(container);
  const rules = (element: Element | null) => {
    let count = 0;
    for (let node = element?.parentElement; node && node !== container; node = node.parentElement) {
      if (node.classList.contains("tl-work-rule")) count += 1;
    }
    return count;
  };
  const audit = agentRow(container, "Coordinate Release Audit")!;
  const gates = agentRow(container, "Check Compatibility Gates")!;
  assert.equal(rules(audit), 1, "a top-level agent sits on its work group's rule");
  assert.equal(rules(gates), 2, "a nested agent sits on its parent agent's rule");
  // Open the nested agent, which starts closed below the first level.
  await act(async () => gates.querySelector<HTMLButtonElement>(".tl-agent-toggle")!.click());
  const step = (path: string) => [...container.querySelectorAll(".tl-step")]
    .find((candidate) => candidate.querySelector(".tl-step-object")?.textContent === path) ?? null;
  assert.equal(rules(step("release.json")), 2, "an agent's step sits one rule in, as a work group's child does");
  assert.equal(rules(step("gates.ts")), 3, "a nested agent's step adds exactly one rule");
  for (const element of container.querySelectorAll(".tl-agent, .tl-agent *")) {
    assert.doesNotMatch(element.getAttribute("style") ?? "", /margin/, "no subagent row has an inline margin");
  }
  assert.equal(container.querySelectorAll("[style*='margin']").length, 0);
});

test("the hidden call's output follows the agent's steps as one collapsed Output row", async () => {
  const { container, root } = await mount();
  await act(async () => root.render(<EventTimeline items={turn} sessionActive />));
  await openWork(container);
  const gates = agentRow(container, "Check Compatibility Gates")!;
  await act(async () => gates.querySelector<HTMLButtonElement>(".tl-agent-toggle")!.click());

  const outputs = [...container.querySelectorAll<HTMLDetailsElement>("details.tl-step")]
    .filter((step) => step.querySelector(".tl-step-title")?.textContent === "Output");
  assert.equal(outputs.length, 1, "only the agent whose call reported output has an Output row");
  const output = outputs[0]!;
  assert.equal(output.querySelector("summary")?.getAttribute("aria-label"), "Output of Check Compatibility Gates");
  assert.equal(output.open, false, "the output starts collapsed, as a step's output does");
  const order = [...container.querySelectorAll(".tl-agent-name, .tl-step-object, details.tl-step > summary .tl-step-title")]
    .map((element) => element.textContent);
  assert.deepEqual(order.slice(order.indexOf("Check Compatibility Gates"), order.indexOf("Check Compatibility Gates") + 3),
    ["Check Compatibility Gates", "gates.ts", "Output"], "the output comes after the agent's steps");
  await act(async () => output.querySelector<HTMLElement>("summary")!.click());
  assert.equal(output.querySelector(".tl-step-error")?.textContent, "Agent failed: quota exhausted",
    "a failed agent's reason reads in the danger colour");
});
