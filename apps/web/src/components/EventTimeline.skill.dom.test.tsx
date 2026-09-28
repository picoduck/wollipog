import assert from "node:assert/strict";
import { test } from "node:test";
import React, { act } from "react";
import { createRoot } from "react-dom/client";
import { Window } from "happy-dom";
import type { TimelineItem } from "../timeline.js";
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

test("skill rows show the skill name without expansion and are styled apart from generic tools", async () => {
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
  for (const disclosure of container.querySelectorAll<HTMLButtonElement>(".tl-work > .tl-disclosure")) {
    await act(async () => disclosure.click());
  }

  const rows = [...container.querySelectorAll<HTMLElement>(".tl-tool")];
  assert.deepEqual(rows.map((row) => [
    row.querySelector(".tool-title")?.textContent,
    row.querySelector(".tool-kind")?.textContent,
    row.classList.contains("tl-tool-skill"),
  ]), [
    ["Skill: codex-review", "🧩", true],
    ["Skill: deploy-check staging", "🧩", true],
    ["Custom", "🔧", false],
  ]);
  const outputRow = rows[1]!;
  assert.equal(outputRow.tagName, "DETAILS", "a skill with output keeps the ordinary disclosure");
  assert.equal(outputRow.hasAttribute("open"), false, "the name is readable while the output stays collapsed");
  assert.equal(outputRow.querySelector("summary")?.getAttribute("aria-label"), "Skill: deploy-check staging · Completed");
});

test("tool rows carry the shared status badge: Running, Failed and Pending as badges, Completed inline", async () => {
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
  for (const disclosure of container.querySelectorAll<HTMLButtonElement>(".tl-work > .tl-disclosure")) {
    await act(async () => disclosure.click());
  }

  // docs/design-system.md §11.2 and §19.2: the uppercase tool pill is the one `.status` recipe.
  const badges = [...container.querySelectorAll<HTMLElement>(".tl-tool .status")].map((badge) => [
    badge.textContent,
    [...badge.classList].filter((name) => name.startsWith("t-")).join(" "),
    badge.classList.contains("inline"),
  ]);
  assert.deepEqual(badges, [
    ["Running", "t-info", false],
    ["Failed", "t-danger", false],
    ["Completed", "t-success", true],
    ["Pending", "t-neutral", false],
  ]);
  assert.equal(container.querySelector(".tool-status"), null, "the retired pill recipe is gone");
  assert.equal(container.querySelector('.tl-tool summary')?.getAttribute("aria-label"), "Build · Failed");
});
