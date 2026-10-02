import assert from "node:assert/strict";
import { test } from "node:test";
import React, { act } from "react";
import { createRoot } from "react-dom/client";
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

test("skill rows show the skill name without expansion and carry the Skills glyph, not a generic tool's", async () => {
  const happyContainer = domWindow.document.createElement("div");
  domWindow.document.body.append(happyContainer);
  const container = happyContainer as unknown as HTMLDivElement;
  const root = createRoot(container);
  cleanup(async () => {
    await act(async () => { root.unmount(); });
    container.remove();
  });

  const items: TimelineItem[] = [
    { kind: "tool_call", id: 1, toolCallId: "bare-skill", title: "Skill: codex-review", toolKind: "skill", status: "completed", text: "" },
    { kind: "tool_call", id: 2, toolCallId: "skill-output", title: "Skill: deploy-check staging", toolKind: "skill", status: "completed", text: "Loaded" },
    { kind: "tool_call", id: 3, toolCallId: "generic", title: "Custom", toolKind: "other", status: "completed", text: "" },
  ];
  await act(async () => { root.render(<EventTimeline items={items} />); });
  for (const disclosure of container.querySelectorAll<HTMLButtonElement>(".tl-work > .disclosure-trigger")) {
    await act(async () => disclosure.click());
  }

  const rows = [...container.querySelectorAll<HTMLElement>(".tl-step")];
  const glyph = (row: HTMLElement) => row.querySelector(".tl-step-icon svg")?.getAttribute("class") ?? "";
  assert.deepEqual(rows.map((row) => [
    row.querySelector(".tl-step-title")?.textContent,
    row.querySelector(".tl-step-object")?.textContent ?? null,
  ]), [
    ["Skill codex-review", "codex-review"],
    ["Skill deploy-check staging", "deploy-check staging"],
    ["Custom", null],
  ]);
  assert.match(glyph(rows[0]!), /lucide-wand-sparkles/, "a skill uses the Skills glyph");
  assert.equal(glyph(rows[1]!), glyph(rows[0]!));
  assert.match(glyph(rows[2]!), /lucide-hammer/, "any other tool uses the generic tool glyph");
  const outputRow = rows[1]!;
  assert.equal(outputRow.tagName, "DETAILS", "a skill with output keeps the ordinary disclosure");
  assert.equal(outputRow.hasAttribute("open"), false, "the name is readable while the output stays collapsed");
  assert.equal(outputRow.querySelector("summary")?.getAttribute("aria-label"), "Skill: deploy-check staging · Completed");
});

test("step statuses follow §11.2: Running, Failed and Pending inline, Completed a check with no label", async () => {
  const happyContainer = domWindow.document.createElement("div");
  domWindow.document.body.append(happyContainer);
  const container = happyContainer as unknown as HTMLDivElement;
  const root = createRoot(container);
  cleanup(async () => {
    await act(async () => { root.unmount(); });
    container.remove();
  });

  const items: TimelineItem[] = [
    { kind: "tool_call", id: 1, toolCallId: "running", title: "Run Tests", toolKind: "command", status: "in_progress", text: "" },
    { kind: "tool_call", id: 2, toolCallId: "failed", title: "Build", toolKind: "command", status: "failed", text: "exit 1" },
    { kind: "tool_call", id: 3, toolCallId: "done", title: "Lint", toolKind: "command", status: "completed", text: "" },
    { kind: "tool_call", id: 4, toolCallId: "queued", title: "Deploy", toolKind: "command", status: "pending", text: "" },
  ];
  await act(async () => { root.render(<EventTimeline items={items} />); });
  for (const disclosure of container.querySelectorAll<HTMLButtonElement>(".tl-work > .disclosure-trigger")) {
    await act(async () => disclosure.click());
  }

  // docs/design-system.md §11.2: a dense step row takes the inline status, never a pill.
  const badges = [...container.querySelectorAll<HTMLElement>(".tl-step .status")].map((badge) => [
    badge.textContent,
    [...badge.classList].filter((name) => name.startsWith("t-")).join(" "),
    badge.classList.contains("inline"),
    badge.classList.contains("pulse"),
  ]);
  assert.deepEqual(badges, [
    ["Running", "t-info", true, true],
    ["Failed", "t-danger", true, false],
    ["Pending", "t-neutral", true, false],
  ]);
  const done = container.querySelectorAll(".tl-step-done");
  assert.equal(done.length, 1, "Completed is a check");
  assert.ok(done[0]!.querySelector("svg.lucide-check"));
  assert.equal(done[0]!.querySelector(".sr-only")?.textContent, "Completed", "its label is for assistive technology only");
  assertNoDomNode(container.querySelector(".tool-status"), "the retired pill recipe is gone");
  assert.equal(container.querySelector('.tl-step summary')?.getAttribute("aria-label"), "Build · Failed");
});
