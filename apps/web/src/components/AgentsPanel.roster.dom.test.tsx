import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { after, before, test } from "node:test";
import React, { act } from "react";
import { createRoot } from "react-dom/client";
import { Window } from "happy-dom";
import { PROTOCOL_VERSION, type SessionView } from "@wollipog/protocol";
import { api, type ApiClient } from "../api.js";
import { ApiProvider } from "../api-context.js";
import { StoreProvider } from "../store.js";
import { FeedbackProvider } from "./FeedbackProvider.js";
import { UI_SOCKET_OPEN, type UiConnectionRuntime } from "../ui-transport.js";
import type { TimelineItem } from "../timeline.js";
import { installDomTestCleanup } from "../dom-test-cleanup.js";
import { assertNoDomNode } from "../dom-test-assertions.js";
import { subagentStatusContext, type WorkerRow } from "../worker-roster.js";
import { AgentsPanel, groupWorkerRows, memberMetadata } from "./AgentsPanel.js";
import { subagentStatusMeta } from "./EventTimeline.js";

const domWindow = new Window({ url: "http://localhost/" });
const globals: Record<string, unknown> = {
  window: domWindow,
  document: domWindow.document,
  navigator: domWindow.navigator,
  localStorage: domWindow.localStorage,
  HTMLElement: domWindow.HTMLElement,
  ResizeObserver: domWindow.ResizeObserver,
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
installDomTestCleanup(domWindow);

const connection: UiConnectionRuntime = {
  instanceId: "agents-roster", runtimeKey: "agents-roster",
  createSocket: () => ({ readyState: UI_SOCKET_OPEN, onopen: null, onmessage: null,
    onclose: null, onerror: null, send() {}, close() {} }), close() {},
};
// An older control plane with no child registry: the roster is the transcript's own projection.
const client: ApiClient = { ...api, childSessions: async () => { throw new Error("registry unavailable"); } };

const now = Date.now();
const session = {
  id: "lead", runnerId: "runner", workspaceId: null, agentId: null, title: "Lead", status: "running",
  runId: null, archived: false, createdAt: now - 60_000, updatedAt: now, lastEventAt: now, messageCount: 10,
  eventEpoch: 0, pendingApproval: null,
} as unknown as SessionView;
const agent = (id: string, index: number, extra: Partial<Extract<TimelineItem, { kind: "tool_call" }>> = {}): TimelineItem => ({
  kind: "tool_call", id: index, toolCallId: id, title: `Agent: ${id}`, text: "", toolKind: "agent",
  status: "in_progress", startedAt: now - 30_000, ...extra,
});

async function mount(items: TimelineItem[], options: { session?: SessionView; runnerOnline?: boolean } = {}) {
  const happyContainer = domWindow.document.createElement("div");
  domWindow.document.body.append(happyContainer);
  const container = happyContainer as unknown as HTMLDivElement;
  const root = createRoot(container);
  await act(async () => root.render(<ApiProvider client={client}><FeedbackProvider><StoreProvider connection={connection}>
    <AgentsPanel session={options.session ?? session} items={items} runnerOnline={options.runnerOnline ?? true}
      runnerProtocolVersion={PROTOCOL_VERSION} requestedId={null} onSelect={() => {}}
      parentTurnEventIds={new Map()} onOpenParentTurn={() => {}} />
  </StoreProvider></FeedbackProvider></ApiProvider>));
  await act(async () => { await new Promise((resolve) => setTimeout(resolve, 10)); });
  return {
    container,
    async unmount() { await act(async () => root.unmount()); container.remove(); },
  };
}

const text = (element: Element | null | undefined) => element?.textContent ?? "";
const radios = (container: HTMLElement) =>
  [...container.querySelectorAll('[aria-label="Worker Filter"] [role="radio"]')].map((radio) => radio.getAttribute("aria-label"));

test("120 workers list 50 under one heading, with a list foot that shows 50 more (#2857)", async () => {
  const panel = await mount(Array.from({ length: 120 }, (_, index) => agent(`worker-${index + 1}`, index + 1)));
  try {
    const { container } = panel;
    assert.deepEqual(radios(container), ["Active, 120", "History, 0", "All, 120"]);
    assert.doesNotMatch(text(container.querySelector('[aria-label="Worker Filter"]')), /Loaded/);
    assert.ok(container.querySelector(".seg.block"), "the filter fills the panel width");
    assert.deepEqual([...container.querySelectorAll(".group-label")].map(text), ["Subagents120"]);
    assert.equal(container.querySelectorAll('[role="listitem"]').length, 50);
    assert.equal(text(container.querySelector(".list-foot .worker-list-count")), "Showing 50 of 120");
    const more = container.querySelector<HTMLButtonElement>(".list-foot button")!;
    assert.equal(text(more), "Show 50 More");
    assert.ok(more.classList.contains("btn") && more.classList.contains("sm") && more.classList.contains("ghost"));
    await act(async () => more.click());
    assert.equal(container.querySelectorAll('[role="listitem"]').length, 100);
    assert.equal(text(container.querySelector(".list-foot .worker-list-count")), "Showing 100 of 120");
    await act(async () => container.querySelector<HTMLButtonElement>(".list-foot button")!.click());
    assert.equal(container.querySelectorAll('[role="listitem"]').length, 120);
    assertNoDomNode(container.querySelector(".list-foot"), "nothing more to show");
  } finally {
    await panel.unmount();
  }
});

test("a row is two lines with one badge, its activity and a chevron, and no token, model or effort", async () => {
  const items: TimelineItem[] = [
    agent("parser", 1, { title: "Agent: Inspect Parser", subagentRollup: { inputTokens: 900, outputTokens: 100 } }),
    { kind: "tool_call", id: 2, toolCallId: "npm", parentToolUseId: "parser", title: "$ npm test", text: "",
      toolKind: "execute", status: "in_progress", startedAt: now - 5_000 },
  ];
  const panel = await mount(items);
  try {
    const { container } = panel;
    const row = container.querySelector<HTMLButtonElement>(".worker-row")!;
    assert.ok(row.classList.contains("row") && row.classList.contains("row-2"));
    assert.equal(text(row.querySelector(".row-title")), "Inspect Parser");
    assert.deepEqual([...row.querySelectorAll(".status")].map(text), ["Running"], "one status badge");
    assert.equal(text(row.querySelector(".row-sub")), "Running npm test");
    assert.match(text(row.querySelector(".row-trail")), /^\d+s$/);
    assert.ok(row.querySelector(".row-icon svg"), "a trailing chevron: the row opens a page here");
    assert.equal(row.getAttribute("title"), null, "only a row that opens another session has a tooltip");
    assert.doesNotMatch(text(container.querySelector(".agents-list")), /Tokens|Tool Use|Subagent ·|Depth|medium|high/);
    assertNoDomNode(container.querySelector("[style*='padding-left']"), "no inline indent");
  } finally {
    await panel.unmount();
  }
});

test("no classless button remains in the roster", async () => {
  const panel = await mount([agent("done", 1, { status: "completed", completedAt: now })],
    { session: { ...session, pendingApproval: { requestId: "ask", ownerToolUseId: "missing", title: "Choose", options: [] } } as SessionView });
  try {
    const buttons = [...panel.container.querySelectorAll("button")];
    assert.ok(buttons.length > 0);
    assert.deepEqual(buttons.filter((button) => !button.className.trim()).map((button) => button.outerHTML), []);
  } finally {
    await panel.unmount();
  }
  const source = readFileSync(new URL("./AgentsPanel.tsx", import.meta.url), "utf8");
  assert.doesNotMatch(source, /<button(?![^>]*className)[^>]*>/, "every <button> in AgentsPanel.tsx carries a class");
});

test("an empty Active says so and offers History; History and All have their own sentences", async () => {
  const panel = await mount([agent("done", 1, { status: "completed", completedAt: now })]);
  try {
    const { container } = panel;
    assert.equal(text(container.querySelector(".state-title")), "No Active Workers");
    assert.equal(text(container.querySelector(".state-body")), "Workers this session starts appear here.");
    const show = [...container.querySelectorAll<HTMLButtonElement>(".state button")].find((button) => text(button) === "Show History")!;
    assert.ok(show.classList.contains("ghost") && show.classList.contains("sm"));
    await act(async () => show.click());
    assert.equal(container.querySelector('[role="radio"][aria-checked="true"]')?.getAttribute("aria-label"), "History, 1");
    assertNoDomNode(container.querySelector(".state"));
    assert.equal(text(container.querySelector(".worker-row .status")), "Completed");
  } finally {
    await panel.unmount();
  }
  const empty = await mount([]);
  try {
    assert.equal(text(empty.container.querySelector(".state-title")), "No Active Workers");
    assertNoDomNode(empty.container.querySelector(".state button"), "Show History only when History has rows");
    const history = empty.container.querySelector<HTMLButtonElement>('[role="radio"][aria-label="History, 0"]')!;
    await act(async () => history.click());
    assert.equal(text(empty.container.querySelector(".state-title")), "No Worker History");
    assert.equal(text(empty.container.querySelector(".state-body")), "Workers that finish, fail or stop move here.");
  } finally {
    await empty.unmount();
  }
});

test("with the runner offline, Active still lists every worker, each Unverified", async () => {
  const panel = await mount([agent("one", 1), agent("two", 2)], { runnerOnline: false });
  try {
    assert.deepEqual(radios(panel.container), ["Active, 2", "History, 0", "All, 2"]);
    assert.deepEqual([...panel.container.querySelectorAll(".worker-row .status")].map(text), ["Unverified", "Unverified"]);
    assert.ok(panel.container.querySelector(".worker-row .status.hollow"), "a hollow dot");
  } finally {
    await panel.unmount();
  }
});

test("a nested worker indents once under its parent, and the roster and transcript read one word", async () => {
  const asking = { ...session, status: "input_required",
    pendingApproval: { requestId: "ask", ownerToolUseId: "child", title: "Edit: src/auth/parser.ts", options: [] } } as unknown as SessionView;
  const items = [agent("lead-agent", 1), agent("child", 2, { parentToolUseId: "lead-agent" }), agent("grandchild", 3, { parentToolUseId: "child" })];
  const panel = await mount(items, { session: asking });
  try {
    const listed = [...panel.container.querySelectorAll('[role="listitem"]')];
    assert.deepEqual(listed.map((item) => item.className), [
      "worker-row-item", "worker-row-item nested", "worker-row-item nested nested-last"]);
    const badges = listed.map((item) => text(item.querySelector(".status")));
    assert.deepEqual(badges, ["Running", "Approval Required", "Running"]);
    assert.equal(text(listed[1]!.querySelector(".row-sub")), "Waiting to edit src/auth/parser.ts");
    const context = subagentStatusContext(asking, true);
    assert.deepEqual(items.map((item) => subagentStatusMeta(item as Extract<TimelineItem, { kind: "tool_call" }>, context).label), badges,
      "the transcript's agent rows read the roster's words");
  } finally {
    await panel.unmount();
  }
});

test("members sit under their pod's or run's title, workflow members under Workflow when the run is not loaded", () => {
  const workflow = [{ nodeStates: [{ nodeId: "review", sessionId: "wf", status: "running", attemptCount: 1 }] }] as never;
  const pod = memberMetadata({ runId: null }, undefined, { id: "p1", title: "Parser Pod",
    members: [{ sessionId: "m1", role: "worker" }] } as never, []);
  assert.deepEqual(pod.get("m1")?.group, { id: "pod:p1", name: "Parser Pod" });
  const run = memberMetadata({ runId: "r1" }, { title: "Release Audit", sessionIds: ["a", "b"] }, undefined, workflow);
  assert.deepEqual(run.get("a"), { group: { id: "run:r1", name: "Release Audit" }, runTitle: "Release Audit" });
  assert.equal(run.get("wf")?.group?.name, "Release Audit");
  assert.equal(memberMetadata({ runId: "r1" }, undefined, undefined, workflow).get("wf")?.group?.name, "Workflow");
});

test("groups keep their first row's order, count every filtered row, and page across groups", () => {
  const row = (id: string, group: string, parentId?: string): WorkerRow => ({ id, name: id, group: { id: group, name: group },
    state: "running", activity: "", target: { kind: "subagent", id }, depth: parentId ? 1 : 0, ...(parentId ? { parentId } : {}) });
  const rows = [row("a", "Subagents"), row("j", "Background Jobs"), row("c", "Subagents", "a"), row("b", "Subagents")];
  const { groups, shown } = groupWorkerRows(rows, 3);
  assert.equal(shown, 3);
  assert.deepEqual(groups.map((group) => [group.group.name, group.count, group.rows.map((entry) => entry.row.id)]),
    [["Subagents", 3, ["a", "c", "b"]]], "a group with no row inside the limit has no heading yet");
  assert.deepEqual(groupWorkerRows(rows, 50).groups.map((group) => group.group.name), ["Subagents", "Background Jobs"]);
  assert.deepEqual(groups[0]!.rows.map((entry) => [entry.nested, entry.lastNested]), [[false, false], [true, true], [false, false]]);
  const orphan = groupWorkerRows([row("c", "Subagents", "hidden")], 50).groups[0]!.rows[0]!;
  assert.equal(orphan.nested, false, "a child whose parent the filter hides stands on its own");
});
