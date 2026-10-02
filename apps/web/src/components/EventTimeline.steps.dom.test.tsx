import assert from "node:assert/strict";
import { test } from "node:test";
import React, { act } from "react";
import { createRoot, type Root } from "react-dom/client";
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

const t0 = Date.UTC(2026, 9, 2, 12, 0, 0);
const run = (id: number, title: string, status: string, startedAt: number, seconds: number, text = ""): TimelineItem => ({
  kind: "tool_call", id, toolCallId: `call-${id}`, title, toolKind: "execute", status, text,
  startedAt, lastActivityAt: startedAt + seconds * 1_000, completedAt: startedAt + seconds * 1_000,
});

/** A settled turn: four commands, one of them failed, and one edit, over 26 seconds. */
const settledTurn: TimelineItem[] = [
  { kind: "user_message", id: 1, text: "Fix the header", createdAt: t0 },
  run(2, "Bash: npm ci", "completed", t0 + 1_000, 4),
  { ...run(3, "Read: /repo/src/components/Header.tsx", "completed", t0 + 5_000, 1), toolKind: "read" } as TimelineItem,
  { kind: "file_edit", id: 4, path: "/repo/src/components/Header.tsx", diff: "--- a/x\n+++ b/x\n@@ -1 +1,2 @@\n-old\n+new\n+more" },
  run(5, "Bash: npm test", "failed", t0 + 7_000, 6, "Exit code 1\n> vitest run\nPASS src/a.test.ts\nFAIL src/header.test.ts\nError: expected 2 to be 3"),
  run(6, "Bash: npm run lint", "completed", t0 + 14_000, 13),
  { kind: "agent_message", id: 7, text: "The header is fixed; one test still fails.", createdAt: t0 + 28_000 },
];

test("a settled run of work is one ledger line with its failures counted in the danger colour", async () => {
  const { container, root } = await mount();
  await act(async () => root.render(<EventTimeline items={settledTurn} workspaceRoot="/repo" />));

  const trigger = container.querySelector<HTMLButtonElement>(".tl-work > .disclosure-trigger");
  assert.ok(trigger);
  assert.equal(trigger.getAttribute("aria-expanded"), "false", "the work starts collapsed");
  assert.equal(trigger.querySelector(".tl-work-title")?.textContent, "Worked for 26s");
  const meta = [...trigger.querySelectorAll(".tl-work-meta > span")];
  assert.deepEqual(meta.map((item) => item.textContent), ["4 Commands", "1 Edit", "1 Failed"]);
  assert.ok(meta[2]!.classList.contains("tl-work-failed"), "the failure count takes the danger colour");
  assert.ok(meta[2]!.querySelector("svg.lucide-circle-alert"), "with the alert icon");

  await act(async () => root.render(<EventTimeline
    items={settledTurn.map((item) => item.kind === "tool_call" ? { ...item, status: "completed" } : item)}
    workspaceRoot="/repo"
  />));
  assert.deepEqual([...container.querySelectorAll(".tl-work-meta > span")].map((item) => item.textContent),
    ["4 Commands", "1 Edit"], "no failure item and no zero counts");
  assert.doesNotMatch(container.querySelector(".tl-work")?.textContent ?? "", /\b0 /);
});

test("the last run of work reads Working while the turn runs, and its time once something follows it", async () => {
  const { container, root } = await mount();
  const running = settledTurn.slice(0, 3);
  await act(async () => root.render(<EventTimeline items={running} sessionActive />));
  assert.equal(container.querySelector(".tl-work-title")?.textContent, "Working");
  await openWork(container);
  assert.equal(container.querySelector(".tl-work-title")?.textContent, "Working", "its own open steps do not settle it");
  await act(async () => root.render(<EventTimeline items={settledTurn} sessionActive />));
  assert.equal(container.querySelector(".tl-work-title")?.textContent, "Worked for 26s");
});

test("every step is one quiet row: an icon, a verb and its object, one trailing fact and a status", async () => {
  const { container, root } = await mount();
  const items: TimelineItem[] = [
    ...settledTurn.slice(0, 6),
    { kind: "agent_thought", id: 8, text: "Check the **header** test.", createdAt: t0 + 27_000, completedAt: t0 + 29_000 },
    { kind: "tool_call", id: 9, toolCallId: "web", title: "WebFetch: https://example.com", toolKind: "fetch", status: "completed", text: "", startedAt: t0, completedAt: t0 + 2_000 },
  ];
  await act(async () => root.render(<EventTimeline items={items} workspaceRoot="/repo" />));
  await openWork(container);

  const steps = [...container.querySelectorAll<HTMLElement>(".tl-step")];
  assert.equal(steps.length, 7);
  const pictographic = /\p{Extended_Pictographic}/u;
  for (const step of steps) {
    const head = step.querySelector(".tl-step-head")!;
    assert.doesNotMatch(head.textContent ?? "", pictographic, "no emoji in any step row");
    assert.equal(step.querySelectorAll(".tl-step-icon > svg").length, 1, "one 16px icon");
    assert.equal(step.querySelector(".tl-step-icon > svg")?.getAttribute("width"), "16");
    assert.equal(head.querySelectorAll(":scope > .tl-step-status, :scope > .tl-step-done").length, 1, "one status");
    assert.ok(head.querySelectorAll(":scope > .tl-step-trail").length <= 1, "at most one trailing fact");
    const visible = [...head.childNodes].filter((node) => !(node as Element).classList?.contains("tl-step-trail"))
      .map((node) => node.textContent).join(" ");
    assert.doesNotMatch(visible, /Started|Last Activity|Recorded/);
  }
  const titled = (verb: string) => steps.find((step) => step.querySelector(".tl-step-title")?.textContent?.startsWith(verb));
  const trail = (step: HTMLElement | undefined) => [...step!.querySelector(".tl-step-trail")!.childNodes]
    .filter((node) => node.nodeType === 3).map((node) => node.textContent).join("");
  assert.equal(titled("Run npm ci")?.querySelector(".tl-step-object")?.textContent, "npm ci");
  assert.equal(trail(titled("Run npm ci")), "4.0s");
  assert.equal(trail(titled("Edit")), "+2 −1", "an edit's fact is its line count");
  assert.equal(titled("Thought for 2.0s")?.tagName, "DETAILS", "a thought is a step titled by its duration");
  assert.equal(titled("Fetch")?.querySelector(".tl-step-object")?.textContent, "https://example.com");
  assert.ok(titled("Fetch")?.querySelector("svg.lucide-globe"));
  assert.ok(titled("Run npm ci")?.querySelector("svg.lucide-terminal"));
  assert.ok(titled("Read")?.querySelector("svg.lucide-book-open"));
  assert.ok(titled("Edit")?.querySelector("svg.lucide-file-pen"));
  assert.ok(titled("Thought")?.querySelector("svg.lucide-brain"));

  const thought = titled("Thought")!;
  await act(async () => thought.querySelector<HTMLElement>("summary")!.click());
  assert.equal(thought.querySelector(".tl-step-body .tl-step-prose strong")?.textContent, "header", "its text sits in the step body");
});

test("an edit names its workspace-relative path once", async () => {
  const { container, root } = await mount();
  const opened: string[] = [];
  await act(async () => root.render(<EventTimeline
    items={settledTurn}
    workspaceRoot="/repo/"
    onOpenSourceLocation={(location) => opened.push(location.path)}
  />));
  await openWork(container);
  const edit = [...container.querySelectorAll<HTMLElement>(".tl-step")].find((step) => step.textContent?.startsWith("Edit"))!;
  assert.equal(edit.querySelector(".tl-step-object")?.textContent, "src/components/Header.tsx");
  assert.doesNotMatch(edit.querySelector(".tl-step-head")?.textContent ?? "", /\/repo\//);
  assert.equal(edit.querySelector("summary")?.getAttribute("aria-label"), "Edit src/components/Header.tsx · +2 −1 · Completed");
  await act(async () => edit.querySelector<HTMLElement>("summary")!.click());
  await act(async () => edit.querySelector<HTMLButtonElement>(".tl-step-link")!.click());
  assert.deepEqual(opened, ["src/components/Header.tsx"], "a relative path can now open in the Files panel");
});

test("a failed step's body shows its exit code and error lines in the danger colour", async () => {
  const { container, root } = await mount();
  await act(async () => root.render(<EventTimeline items={settledTurn} />));
  await openWork(container);
  const failed = [...container.querySelectorAll<HTMLElement>("details.tl-step")].find((step) =>
    step.querySelector("summary")?.getAttribute("aria-label") === "Run npm test · Failed")!;
  assert.ok(failed);
  await act(async () => failed.querySelector<HTMLElement>("summary")!.click());
  const well = failed.querySelector(".tl-step-body > pre.tl-step-output");
  assert.ok(well, "the output sits in a neutral well");
  assert.deepEqual([...well.querySelectorAll(".tl-step-error")].map((line) => line.textContent?.trim()), [
    "Exit code 1",
    "FAIL src/header.test.ts",
    "Error: expected 2 to be 3",
  ]);
  assert.match(well.textContent ?? "", /PASS src\/a\.test\.ts/, "the rest of the output stays, in the neutral colour");
});

test("three failed attempts of one command fold into one row that lists each attempt", async () => {
  const { container, root } = await mount();
  const error = "Exit code 1\nError: compatibility marker mismatch";
  const items: TimelineItem[] = [
    run(1, "Bash: make validate", "failed", t0, 3, error),
    run(2, "Bash: make validate", "failed", t0 + 4_000, 3, error),
    run(3, "Bash: make validate", "failed", t0 + 8_000, 3, error),
  ];
  await act(async () => root.render(<EventTimeline items={items} />));
  assert.deepEqual([...container.querySelectorAll(".tl-work-meta > span")].map((item) => item.textContent), ["1 Command", "1 Failed"]);
  await openWork(container);
  const steps = container.querySelectorAll<HTMLElement>(".tl-step");
  assert.equal(steps.length, 1, "one row, not three identical failures");
  const step = steps[0]!;
  assert.equal([...step.querySelector(".tl-step-trail")!.childNodes].filter((node) => node.nodeType === 3)
    .map((node) => node.textContent).join(""), "3 Attempts");
  assert.equal(step.querySelector(".tl-step-head > .status")?.textContent, "Failed");
  assert.equal(step.querySelector("summary")?.getAttribute("aria-label"), "Run make validate · 3 Attempts · Failed");
  await act(async () => step.querySelector<HTMLElement>("summary")!.click());
  const attempts = [...step.querySelectorAll(".tl-step-attempt")];
  assert.deepEqual(attempts.map((attempt) => attempt.querySelector(".tl-step-attempt-head")?.textContent), [
    "Attempt 1Failed", "Attempt 2Failed", "Attempt 3Failed",
  ]);
  assert.ok(attempts.every((attempt) => attempt.querySelector(".tl-step-error")));
});

test("open work and nested agent steps sit on rules, never on inline margins", async () => {
  const { container, root } = await mount();
  const items: TimelineItem[] = [
    { kind: "tool_call", id: 1, toolCallId: "agent", title: "Task: audit", toolKind: "agent", status: "completed", text: "" },
    { kind: "tool_call", id: 2, toolCallId: "child", title: "Read: a.ts", toolKind: "read", status: "completed", text: "", parentToolUseId: "agent" },
  ];
  await act(async () => root.render(<EventTimeline items={items} />));
  await openWork(container);
  const depth = (element: Element | null) => {
    let count = 0;
    for (let node = element?.parentElement; node && node !== container; node = node.parentElement) {
      if (node.classList.contains("tl-work-rule")) count += 1;
    }
    return count;
  };
  const steps = [...container.querySelectorAll(".tl-step")];
  assert.deepEqual(steps.map(depth), [1, 2], "a nested agent's step adds one rule");
  assert.equal(depth(container.querySelector(".tl-subagent")), 1, "the agent's summary sits on its group's rule");
  assert.equal(container.querySelectorAll("[style*='margin']").length, 0, "no inline margin anywhere");
  assert.ok(container.querySelector(".tl-subagent svg.disclosure-chevron"), "the agent row uses the §5.5 chevron");
});
