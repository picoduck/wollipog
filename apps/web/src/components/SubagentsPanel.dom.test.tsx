import assert from "node:assert/strict";
import { after, before, test } from "node:test";
import React, { act, useState } from "react";
import { createRoot } from "react-dom/client";
import { Window } from "happy-dom";
import type { SessionView } from "@wollipog/protocol";
import type { TimelineItem } from "../timeline.js";
import { EventTimeline } from "./EventTimeline.js";
import { SubagentsPanel, subagentEmptyMessage, subagentOutputLabel } from "./SubagentsPanel.js";

const domWindow = new Window({ url: "http://localhost/" });
const VIEWPORT_HEIGHT = 1200;
const ROW_HEIGHT = 72;
Object.defineProperty(domWindow.Element.prototype, "getBoundingClientRect", {
  configurable: true,
  value(this: Element) {
    const height = this.classList?.contains("subagent-output") ? VIEWPORT_HEIGHT : ROW_HEIGHT;
    return { x: 0, y: 0, top: 0, left: 0, right: 800, bottom: height, width: 800, height, toJSON: () => ({}) };
  },
});
for (const [name, value] of [["clientHeight", VIEWPORT_HEIGHT], ["offsetHeight", ROW_HEIGHT]] as const) {
  Object.defineProperty(domWindow.HTMLElement.prototype, name, { configurable: true, get: () => value });
}
const globals: Record<string, unknown> = {
  window: domWindow,
  document: domWindow.document,
  navigator: domWindow.navigator,
  HTMLElement: domWindow.HTMLElement,
  Node: domWindow.Node,
  Event: domWindow.Event,
  MouseEvent: domWindow.MouseEvent,
  ResizeObserver: class { observe() {} unobserve() {} disconnect() {} },
  requestAnimationFrame: domWindow.requestAnimationFrame.bind(domWindow),
  cancelAnimationFrame: domWindow.cancelAnimationFrame.bind(domWindow),
  React,
  IS_REACT_ACT_ENVIRONMENT: true,
};
const prior = Object.fromEntries(
  Object.keys(globals).map((name) => [name, (globalThis as Record<string, unknown>)[name]]),
);

before(() => {
  for (const [name, value] of Object.entries(globals)) {
    Object.defineProperty(globalThis, name, { configurable: true, writable: true, value });
  }
});

after(() => {
  for (const [name, value] of Object.entries(prior)) {
    Object.defineProperty(globalThis, name, { configurable: true, writable: true, value });
  }
  domWindow.close();
});

const session = {
  id: "session-1",
  runnerId: "runner-1",
  driver: "claude-code",
  status: "running",
  adopted: false,
  eventEpoch: 2,
} as SessionView;

const items: TimelineItem[] = [
  { kind: "tool_call", id: 1, toolCallId: "outer", title: "Agent: Audit Storage", text: "", toolKind: "agent", status: "in_progress", startedAt: 100 },
  { kind: "agent_message", id: 2, text: "Outer Output", parentToolUseId: "outer", createdAt: 120 },
  { kind: "tool_call", id: 3, toolCallId: "inner", title: "Agent: Inspect Parser", text: "", toolKind: "agent", status: "failed", parentToolUseId: "outer", startedAt: 130, completedAt: 140 },
  { kind: "agent_message", id: 4, text: "Inner Output", parentToolUseId: "inner", createdAt: 135 },
  { kind: "tool_call", id: 5, toolCallId: "deep", title: "Agent: Check Edge Case", text: "", toolKind: "agent", status: "completed", parentToolUseId: "inner", startedAt: 136, completedAt: 139 },
  { kind: "agent_message", id: 6, text: "Deep Output", parentToolUseId: "deep", createdAt: 138 },
];

test("master-detail list is labelled, Title Case, depth-aware, and keeps selection in panel state", async () => {
  const happyContainer = domWindow.document.createElement("div");
  domWindow.document.body.append(happyContainer);
  const container = happyContainer as unknown as HTMLDivElement;
  const root = createRoot(container);
  function Harness() {
    const [selected, setSelected] = useState<string | null>(null);
    return <SubagentsPanel session={session} items={items} runnerOnline requestedId={selected} onSelect={setSelected} />;
  }
  try {
    await act(async () => root.render(<Harness />));
    await act(async () => { await new Promise((resolve) => setTimeout(resolve, 25)); });
    assert.ok(container.querySelector('[role="list"][aria-label="Subagents"]'));
    const rows = [...container.querySelectorAll<HTMLButtonElement>(".subagent-list-row")];
    assert.equal(rows.length, 3);
    assert.match(rows[0]!.textContent ?? "", /Running/);
    assert.match(rows[1]!.textContent ?? "", /Failed/);
    assert.match(rows[1]!.getAttribute("style") ?? "", /padding-left: 30px/);
    assert.match(rows[2]!.getAttribute("style") ?? "", /padding-left: 30px/, "deeper descendants keep a bounded one-level indent");
    assert.match(rows[2]!.textContent ?? "", /Depth 3/);
    assert.equal(rows[0]!.getAttribute("aria-current"), "true", "the active agent is the default selection");
    assert.equal(container.querySelectorAll('[aria-label="Subagent Activity"]').length, 1,
      "the focusable scroller and its timeline do not duplicate the same accessible name");
    assert.ok(container.querySelector('[role="list"][aria-label="Subagent Activity"]'));
    const firstOutput = container.querySelector<HTMLElement>(".subagent-output")!;
    assert.match(firstOutput.textContent ?? "", /Outer Output/);
    const workDisclosure = firstOutput.querySelector<HTMLButtonElement>(".tl-work > .tl-disclosure");
    if (workDisclosure?.getAttribute("aria-expanded") === "false") {
      await act(async () => workDisclosure.click());
    }
    assert.match(firstOutput.textContent ?? "", /Inner Output/,
      "the selected root renders output from its nested subtree");
    assert.equal(firstOutput.tabIndex, 0, "the independently scrolling activity region is keyboard reachable");
    firstOutput.scrollTop = 73;

    await act(async () => rows[1]!.click());
    assert.equal(container.querySelectorAll<HTMLButtonElement>(".subagent-list-row")[1]!.getAttribute("aria-current"), "true");
    assert.match(container.querySelector(".subagent-detail-meta")?.textContent ?? "", /Failed · Subagent Activity/);
    const secondOutput = container.querySelector<HTMLElement>(".subagent-output")!;
    assert.doesNotMatch(secondOutput.textContent ?? "", /Outer Output/,
      "selecting a nested agent excludes its parent output");
    assert.match(secondOutput.textContent ?? "", /Inner Output/);
    assert.notEqual(secondOutput, firstOutput, "a different subagent remounts its output scroller");
    assert.equal(secondOutput.scrollTop, 0, "a different subagent starts at the top instead of inheriting scroll offset");
    assert.notEqual(domWindow.document.activeElement, container.querySelector(".subagent-detail"),
      "ordinary list selection keeps focus ownership with the list instead of forcing a panel jump");
  } finally {
    await act(async () => root.unmount());
    container.remove();
  }
});

test("output copy stays neutral about follow-tail while distinguishing current and recorded activity", () => {
  assert.equal(subagentOutputLabel({ availability: "live", lifecycle: "running" }, true), "Current Activity");
  assert.equal(subagentOutputLabel({ availability: "live", lifecycle: "completed" }, true), "Subagent Activity");
  assert.equal(subagentOutputLabel({ availability: "live", lifecycle: "running" }, false), "Subagent Activity");
  assert.equal(subagentOutputLabel({ availability: "recorded", lifecycle: "completed" }, false), "Recorded Activity");
});

test("an external Open request focuses and names the selected subagent transcript region", async () => {
  const happyContainer = domWindow.document.createElement("div");
  domWindow.document.body.append(happyContainer);
  const container = happyContainer as unknown as HTMLDivElement;
  const root = createRoot(container);
  const handled: number[] = [];
  try {
    await act(async () => root.render(
      <SubagentsPanel
        session={session}
        items={items}
        runnerOnline
        requestedId="inner"
        focusRequest={4}
        onFocusRequestHandled={(request) => handled.push(request)}
        onSelect={() => {}}
      />,
    ));
    const detail = container.querySelector<HTMLElement>(".subagent-detail")!;
    assert.equal(domWindow.document.activeElement, detail);
    assert.equal(detail.getAttribute("role"), "region");
    assert.equal(detail.tabIndex, -1);
    const label = domWindow.document.getElementById(detail.getAttribute("aria-labelledby")!);
    const description = domWindow.document.getElementById(detail.getAttribute("aria-describedby")!);
    assert.equal(label?.textContent, "Agent: Inspect Parser");
    assert.match(description?.textContent ?? "", /Failed · Subagent Activity/);
    assert.deepEqual(handled, [4]);
  } finally {
    await act(async () => root.unmount());
    container.remove();
  }
});

test("opening a nested agent from the selected output transfers focus to the new detail", async () => {
  const happyContainer = domWindow.document.createElement("div");
  domWindow.document.body.append(happyContainer);
  const container = happyContainer as unknown as HTMLDivElement;
  const root = createRoot(container);
  function Harness() {
    const [selected, setSelected] = useState<string | null>("outer");
    return <SubagentsPanel session={session} items={items} runnerOnline requestedId={selected} onSelect={setSelected} />;
  }
  try {
    await act(async () => root.render(<Harness />));
    await act(async () => { await new Promise((resolve) => setTimeout(resolve, 25)); });
    const workDisclosure = container.querySelector<HTMLButtonElement>(".subagent-output .tl-work > .tl-disclosure");
    if (workDisclosure?.getAttribute("aria-expanded") === "false") {
      await act(async () => workDisclosure.click());
    }
    const open = container.querySelector<HTMLButtonElement>(".subagent-output .subagent-open")!;
    assert.ok(open, "the selected root exposes its nested agent action");
    open.focus();
    await act(async () => open.click());
    const detail = container.querySelector<HTMLElement>(".subagent-detail")!;
    assert.equal(container.querySelector(".subagent-detail-title")?.textContent, "Agent: Inspect Parser");
    assert.equal(domWindow.document.activeElement, detail);
    assert.notEqual(domWindow.document.activeElement, domWindow.document.body);
  } finally {
    await act(async () => root.unmount());
    container.remove();
  }
});

test("automatic selection stays put while concurrent root activity advances and moves only when removed", async () => {
  const happyContainer = domWindow.document.createElement("div");
  domWindow.document.body.append(happyContainer);
  const container = happyContainer as unknown as HTMLDivElement;
  const root = createRoot(container);
  const first: TimelineItem[] = [
    { kind: "tool_call", id: 10, toolCallId: "first", title: "First Agent", text: "", toolKind: "agent", status: "in_progress", startedAt: 100 },
    { kind: "tool_call", id: 11, toolCallId: "second", title: "Second Agent", text: "", toolKind: "agent", status: "in_progress", startedAt: 90 },
  ];
  try {
    await act(async () => root.render(
      <SubagentsPanel session={session} items={first} runnerOnline requestedId={null} onSelect={() => {}} />,
    ));
    assert.match(container.querySelector(".subagent-detail-title")?.textContent ?? "", /First Agent/);
    const advanced = [
      ...first,
      { kind: "agent_message", id: 12, text: "newer activity", parentToolUseId: "second", createdAt: 500 } as TimelineItem,
    ];
    await act(async () => root.render(
      <SubagentsPanel session={session} items={advanced} runnerOnline requestedId={null} onSelect={() => {}} />,
    ));
    assert.match(container.querySelector(".subagent-detail-title")?.textContent ?? "", /First Agent/,
      "new chunks from another concurrent root do not steal the detail pane");
    await act(async () => root.render(
      <SubagentsPanel session={session} items={advanced.slice(1)} runnerOnline requestedId={null} onSelect={() => {}} />,
    ));
    assert.match(container.querySelector(".subagent-detail-title")?.textContent ?? "", /Second Agent/,
      "the automatic selection advances after its descriptor disappears");
  } finally {
    await act(async () => root.unmount());
    container.remove();
  }
});

test("an unresolved requested id is explicit and never selects a different descriptor", async () => {
  const happyContainer = domWindow.document.createElement("div");
  domWindow.document.body.append(happyContainer);
  const container = happyContainer as unknown as HTMLDivElement;
  const root = createRoot(container);
  const handled: number[] = [];
  try {
    await act(async () => root.render(
      <SubagentsPanel
        session={session}
        items={items}
        runnerOnline
        requestedId="expired-agent"
        focusRequest={9}
        onFocusRequestHandled={(request) => handled.push(request)}
        onSelect={() => {}}
      />,
    ));
    const unavailable = container.querySelector<HTMLElement>(".subagent-selection-unavailable")!;
    assert.match(unavailable.textContent ?? "", /requested subagent is no longer available/);
    assert.equal(container.querySelector(".subagent-detail"), null);
    assert.equal(container.querySelector("[aria-current='true']"), null);
    assert.equal(domWindow.document.activeElement, unavailable);
    assert.deepEqual(handled, [9]);
  } finally {
    await act(async () => root.unmount());
    container.remove();
  }
});

test("a duplicate provider identity is reported as ambiguous instead of unavailable", async () => {
  const happyContainer = domWindow.document.createElement("div");
  domWindow.document.body.append(happyContainer);
  const container = happyContainer as unknown as HTMLDivElement;
  const root = createRoot(container);
  const duplicateItems: TimelineItem[] = [
    { kind: "tool_call", id: 101, toolCallId: "duplicate", title: "First Agent", text: "", toolKind: "agent", status: "completed" },
    { kind: "tool_call", id: 102, toolCallId: "duplicate", title: "Second Agent", text: "", toolKind: "agent", status: "completed" },
  ];
  try {
    await act(async () => root.render(
      <SubagentsPanel
        session={session}
        items={duplicateItems}
        runnerOnline
        requestedId="duplicate"
        onSelect={() => {}}
      />,
    ));
    const warning = container.querySelector<HTMLElement>(".subagent-selection-unavailable")!;
    assert.match(warning.textContent ?? "", /Multiple recorded subagents share this provider identity/);
    assert.doesNotMatch(warning.textContent ?? "", /no longer available/);
    assert.equal(container.querySelector(".subagent-detail"), null);
  } finally {
    await act(async () => root.unmount());
    container.remove();
  }
});

test("Codex empty copy distinguishes live unavailability from imported summaries", () => {
  assert.match(subagentEmptyMessage({ driver: "codex-app-server", status: "running" }, true), /does not currently expose live subagent identity/);
  assert.match(subagentEmptyMessage({ driver: "codex", status: "completed" }, false), /Recorded Codex transcripts retain subagent completion summaries/);
  assert.match(subagentEmptyMessage({ driver: "claude-code", status: "running" }, true), /No subagents have been recorded/);
});

test("transcript disclosure and Subagents panel action are separate accessible controls", async () => {
  const opened: string[] = [];
  const happyContainer = domWindow.document.createElement("div");
  domWindow.document.body.append(happyContainer);
  const container = happyContainer as unknown as HTMLDivElement;
  const root = createRoot(container);
  try {
    await act(async () => root.render(<EventTimeline items={items} onOpenSubagent={(id) => opened.push(id)} />));
    const worked = container.querySelector<HTMLButtonElement>(".tl-work > .tl-disclosure")!;
    await act(async () => worked.click());
    const toggle = container.querySelector<HTMLButtonElement>(".subagent-toggle")!;
    const open = container.querySelector<HTMLButtonElement>(".subagent-open")!;
    assert.ok(toggle);
    assert.ok(open);
    assert.equal(toggle.getAttribute("aria-expanded"), "true");
    assert.equal(open.getAttribute("aria-label"), "Open Agent in Subagents Panel");
    await act(async () => open.click());
    assert.deepEqual(opened, ["outer"]);
    assert.equal(toggle.getAttribute("aria-expanded"), "true", "opening the panel does not toggle transcript disclosure");
  } finally {
    await act(async () => root.unmount());
    container.remove();
  }
});

test("a bounded window explains unlisted subagents instead of claiming none were recorded", () => {
  // The spawning tool call this panel matches on can sit below the loaded window, so the
  // whole-session claim would be false while earlier turns are unloaded.
  assert.match(
    subagentEmptyMessage({ driver: "claude-code", status: "running" }, true, true),
    /Earlier activity in this session is not loaded/,
  );
  assert.match(
    subagentEmptyMessage({ driver: "codex", status: "completed" }, false, true),
    /Earlier activity in this session is not loaded/,
  );
  // With the whole history loaded the driver-specific explanations are authoritative again.
  assert.match(
    subagentEmptyMessage({ driver: "claude-code", status: "running" }, true, false),
    /No subagents have been recorded/,
  );
});
