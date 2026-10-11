import assert from "node:assert/strict";
import { after, before, test } from "node:test";
import React, { act, useState } from "react";
import { createRoot } from "react-dom/client";
import { Window } from "happy-dom";
import { PROTOCOL_VERSION, removePendingRequest, type ChildSessionRegistryPage, type SessionView, type UiSnapshotMessage } from "@wollipog/protocol";
import { api, ApiError, type ApiClient } from "../api.js";
import { ApiProvider } from "../api-context.js";
import { StoreProvider, useStoreSelector } from "../store.js";
import { FeedbackProvider } from "./FeedbackProvider.js";
import { UI_SOCKET_OPEN, type UiConnectionRuntime } from "../ui-transport.js";
import type { AttentionTarget } from "../navigation.js";
import type { TimelineItem } from "../timeline.js";
import { installDomTestCleanup } from "../dom-test-cleanup.js";
import { assertNoDomNode } from "../dom-test-assertions.js";
import { AgentsPanel } from "./AgentsPanel.js";
import { WORKER_DETAIL_COPY } from "./WorkerDetail.js";

/**
 * The Agents tab's one notice slot (#2861): the attention notice that counts who needs the person,
 * with Review in Session, and every other condition as one ranked entry behind "+N More".
 */

const domWindow = new Window({ url: "http://localhost/" });
const globals: Record<string, unknown> = {
  window: domWindow,
  document: domWindow.document,
  navigator: domWindow.navigator,
  localStorage: domWindow.localStorage,
  HTMLElement: domWindow.HTMLElement,
  HTMLButtonElement: domWindow.HTMLButtonElement,
  Element: domWindow.Element,
  Node: domWindow.Node,
  Event: domWindow.Event,
  MouseEvent: domWindow.MouseEvent,
  KeyboardEvent: domWindow.KeyboardEvent,
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
  instanceId: "agents-notices", runtimeKey: "agents-notices",
  createSocket: () => ({ readyState: UI_SOCKET_OPEN, onopen: null, onmessage: null,
    onclose: null, onerror: null, send() {}, close() {} }), close() {},
};

const now = Date.now();
let sessionSeq = 0;
/** Each test its own session id, so the slot's per-session info dismissals never leak between tests. */
const baseSession = () => ({
  id: `lead-${++sessionSeq}`, runnerId: "build-box", workspaceId: null, agentId: null, title: "Lead", status: "running",
  driver: "claude-code", runId: null, archived: false, createdAt: now - 60_000, updatedAt: now, lastEventAt: now,
  messageCount: 10, eventEpoch: 0, pendingApproval: null, worktreePath: "/work/repo",
}) as unknown as SessionView;
const agent = (id: string, index: number, title: string): TimelineItem => ({
  kind: "tool_call", id: index, toolCallId: id, title, text: "", toolKind: "agent", status: "in_progress", startedAt: now - 30_000,
});
const items: TimelineItem[] = [agent("audit", 1, "Audit Storage"), agent("parser", 2, "Inspect Parser"), agent("docs", 3, "Review Docs")];
const allow = [{ optionId: "yes", name: "Allow", kind: "allow_once" }];
const permission = (requestId: string, ownerToolUseId?: string) =>
  ({ requestId, ...(ownerToolUseId ? { ownerToolUseId } : {}), title: "Bash: npm test -- storage", options: allow });
const question = (requestId: string, ownerToolUseId?: string) => ({ requestId, ...(ownerToolUseId ? { ownerToolUseId } : {}),
  kind: "question", title: "Which scope?", options: [], questions: [{ id: "scope", question: "Which scope?", options: [{ label: "All" }] }] });
const asking = (...requests: object[]) => ({ ...baseSession(), status: "input_required",
  pendingApproval: { ...requests[0], ...(requests.length > 1 ? { additionalRequests: requests.slice(1) } : {}) } }) as unknown as SessionView;

const text = (element: Element | null | undefined) => element?.textContent?.trim() ?? "";
const focused = () => domWindow.document.activeElement as unknown as Element | null;
const settle = async (ms = 10) => act(async () => { await new Promise((resolve) => setTimeout(resolve, ms)); });

/** A store whose snapshot holds a pod: the lead `lead`, and members the test passes. */
const podConnection = (lead: SessionView, members: SessionView[]): UiConnectionRuntime => ({
  instanceId: "agents-notices-pod", runtimeKey: `agents-notices-pod-${lead.id}`,
  createSocket: () => {
    const socket = { readyState: UI_SOCKET_OPEN, onopen: null as (() => void) | null,
      onmessage: null as ((event: { data: string }) => void) | null, onclose: null, onerror: null, send() {}, close() {} };
    setTimeout(() => {
      socket.onopen?.();
      const snapshot = { type: "snapshot", runners: [], boxes: [], runs: [], sessions: members, pods: [{
        id: "pod-1", title: "Parser Rewrite Pod", objective: "", status: "active", createdAt: now, updatedAt: now,
        members: [lead, ...members].map((member, index) => ({ sessionId: member.id, joinedAt: now, role: index === 0 ? "lead" : "worker",
          contextTokenBudget: null, lastContextSeq: 0 })),
      }] } as unknown as UiSnapshotMessage;
      socket.onmessage?.({ data: JSON.stringify(snapshot) });
    }, 0);
    return socket;
  },
  close() {},
});

function ViewProbe({ onView }: { onView: (view: unknown) => void }) {
  onView(useStoreSelector((state) => state.view));
  return null;
}

function Harness({ initial, runnerOnline = true, childSessions, onOpenPrimaryRequest, earlierActivityUnloaded, attentionTarget,
  store = connection, onView }: {
  initial: SessionView;
  runnerOnline?: boolean;
  childSessions?: ApiClient["childSessions"];
  onOpenPrimaryRequest?: (requestId: string) => void;
  earlierActivityUnloaded?: boolean;
  attentionTarget?: AttentionTarget;
  store?: UiConnectionRuntime;
  onView?: (view: unknown) => void;
}) {
  const [current, setCurrent] = useState(initial);
  const [selected, setSelected] = useState<string | null>(null);
  const client: ApiClient = {
    ...api,
    childSessions: childSessions ?? (async () => { throw new Error("registry unavailable"); }),
    workflowInstances: async () => [],
    approve: async (_sessionId, { requestId }) => {
      const next = { ...current, pendingApproval: removePendingRequest(current.pendingApproval, requestId) };
      setCurrent(next);
      return next;
    },
  };
  return <ApiProvider client={client}><FeedbackProvider><StoreProvider connection={store}>
    {onView && <ViewProbe onView={onView} />}
    <AgentsPanel session={current} items={items} runnerOnline={runnerOnline} runnerProtocolVersion={PROTOCOL_VERSION}
      requestedId={selected} onSelect={setSelected} onOpenPrimaryRequest={onOpenPrimaryRequest}
      earlierActivityUnloaded={earlierActivityUnloaded} attentionTarget={attentionTarget}
      parentTurns={new Map()} onViewTurn={() => {}} />
  </StoreProvider></FeedbackProvider></ApiProvider>;
}

async function mount(element: React.ReactElement) {
  const happyContainer = domWindow.document.createElement("div");
  domWindow.document.body.append(happyContainer);
  const container = happyContainer as unknown as HTMLDivElement;
  const root = createRoot(container);
  await act(async () => root.render(element));
  await settle();
  const slot = () => container.querySelector<HTMLElement>(".panel-notice-slot");
  return {
    container,
    slot,
    shown: () => slot()?.dataset.noticeKey,
    sentence: () => text(slot()?.querySelector(".notice-body")),
    slotButtons: () => [...(slot()?.querySelectorAll<HTMLButtonElement>("button") ?? [])].map(text),
    rowBadges: () => [...container.querySelectorAll(".agents-list .worker-row")]
      .map((row) => `${text(row.querySelector(".row-title"))}: ${text(row.querySelector(".status"))}`),
    async click(element: Element | null | undefined) {
      assert.ok(element, "the control is on screen");
      await act(async () => (element as HTMLElement).click());
      await settle(0);
    },
    button: (name: string) => [...container.querySelectorAll<HTMLButtonElement>("button")].find((button) => text(button) === name),
    menuItems: () => [...domWindow.document.querySelectorAll('[role="menu"][aria-label="Panel Notices"] [role="menuitem"]')].map((item) => text(item as unknown as Element)),
    async unmount() { await act(async () => root.unmount()); container.remove(); },
  };
}

test("two subagents waiting for approval are one warning notice with Review in Session, and each row keeps its badge", async () => {
  const panel = await mount(<Harness initial={asking(permission("audit-run", "audit"), permission("parser-run", "parser"))} />);
  try {
    assert.equal(panel.shown(), "agents-attention");
    assert.equal(panel.sentence(), "2 workers are waiting for your approval.");
    assert.match(panel.slot()!.querySelector(".notice")!.className, /t-warning/);
    assert.deepEqual(panel.slotButtons(), ["Review in Session"], "one action, no per-request buttons");
    assert.deepEqual(panel.rowBadges().sort(), ["Audit Storage: Approval Required", "Inspect Parser: Approval Required", "Review Docs: Running"]);
    assertNoDomNode(panel.container.querySelector('[aria-label="Worker Attention"]'), "no Worker Attention list");
    for (const name of ["Show More Requests", "Open Request in Session"]) assert.equal(panel.button(name), undefined, name);
    assert.equal([...panel.container.querySelectorAll("button")].some((button) => /Approval Required/.test(text(button)) &&
      !button.classList.contains("worker-row")), false, "no request is a button of its own");
  } finally {
    await panel.unmount();
  }
});

test("one worker is named, and mixed kinds are counted by kind with the session first", async () => {
  const one = await mount(<Harness initial={asking(question("parser-ask", "parser"))} />);
  try {
    assert.equal(one.sentence(), "Inspect Parser has a question for you.");
    assert.deepEqual(one.rowBadges().filter((row) => row.startsWith("Inspect Parser")), ["Inspect Parser: Answer Required"]);
  } finally {
    await one.unmount();
  }
  const mixed = await mount(<Harness initial={asking(permission("audit-run", "audit"), permission("parser-run", "parser"),
    question("docs-ask", "docs"))} />);
  try {
    assert.equal(mixed.sentence(), "3 workers need you: 2 approvals, 1 answer.");
  } finally {
    await mixed.unmount();
  }
  const own = await mount(<Harness initial={asking(question("own-ask"))} />);
  try {
    assert.equal(own.sentence(), "The session has a question for you.");
  } finally {
    await own.unmount();
  }
});

test("Review in Session opens the session's own request in the request dock", async () => {
  const opened: string[] = [];
  const panel = await mount(<Harness initial={asking(question("own-ask"), permission("parser-run", "parser"))}
    onOpenPrimaryRequest={(requestId) => opened.push(requestId)} />);
  try {
    // The session's question outranks the worker's permission, by the request dock's priority rule.
    assert.equal(panel.sentence(), "The session and 1 worker need you: 1 answer, 1 approval.");
    await panel.click(panel.button("Review in Session"));
    assert.deepEqual(opened, ["own-ask"]);
    assertNoDomNode(panel.container.querySelector(".agents-page"), "no page is pushed for the session's own request");
  } finally {
    await panel.unmount();
  }
});

test("Review in Session pushes the owning subagent's page with its request card on top and focused", async () => {
  const opened: string[] = [];
  const panel = await mount(<Harness initial={asking(permission("parser-run", "parser"), permission("own-run"))}
    onOpenPrimaryRequest={(requestId) => opened.push(requestId)} />);
  try {
    await panel.click(panel.button("Review in Session"));
    const page = panel.container.querySelector(".agents-page .worker-detail")!;
    assert.equal(page.getAttribute("aria-label"), "Inspect Parser");
    const request = page.querySelector<HTMLElement>(`[role="region"][aria-label="${WORKER_DETAIL_COPY.request}"]`)!;
    assert.equal(request.dataset.sessionRequestId, "parser-run");
    assert.ok(focused() === (request as unknown as Element), "focus lands on the request card");
    assert.deepEqual(opened, [], "the dock is not asked");
    assert.ok(panel.slot(), "the notice stays above the page");
  } finally {
    await panel.unmount();
  }
});

test("offline, a registry error and earlier activity at once: only offline shows, and +2 More lists the other two", async () => {
  let calls = 0;
  const panel = await mount(<Harness initial={baseSession()} runnerOnline={false} earlierActivityUnloaded
    childSessions={async () => { calls += 1; throw new ApiError("child-session inventory changed", 409, "inventory_changed"); }} />);
  try {
    // The first read and its two automatic retries (200 ms, then 400 ms) all conflict.
    for (let wait = 0; wait < 20 && calls < 3; wait += 1) await settle(100);
    await settle(50);
    assert.equal(calls, 3);
    assert.equal(panel.shown(), "agents-runner-offline", "the offline notice leads the danger registry error");
    assert.equal(text(panel.slot()!.querySelector(".notice-title")), "Machine Offline");
    assert.equal(panel.sentence(), "build-box is offline. Workers are shown as Unverified until it reconnects.");
    const more = panel.slot()!.querySelector<HTMLButtonElement>(".session-notice-more")!;
    assert.equal(text(more), "+2 More");
    await panel.click(more);
    assert.deepEqual(panel.menuItems(), ["Couldn't Load Recorded Workers", "Earlier Activity Not Loaded"]);
  } finally {
    await panel.unmount();
  }
});

test("Couldn't Load Recorded Workers retries from the stored cursor, with its cause behind Show Details", async () => {
  const reads: number[] = [];
  let conflicts = 0;
  const first: ChildSessionRegistryPage = {
    children: [{ toolCallId: "audit", name: "Audit Storage", status: "in_progress", lifecycle: "running", sourceSeq: 1,
      startedAt: now - 30_000, lastActivityAt: now, toolCount: 0 }],
    attentionOwners: [], unidentifiedChildren: 0, eventEpoch: 0, nextAfter: 1, truncated: true,
  };
  const panel = await mount(<Harness initial={baseSession()} childSessions={async (_id, _epoch, after = 0) => {
    reads.push(after);
    if (after === 0) return first;
    if (conflicts < 3) { conflicts += 1; throw new ApiError("child-session inventory changed", 409, "inventory_changed"); }
    return { ...first, children: [], nextAfter: null, truncated: false };
  }} />);
  try {
    await panel.click(panel.button("Show 50 More"));
    for (let wait = 0; wait < 20 && conflicts < 3; wait += 1) await settle(100);
    await settle(50);
    assert.equal(panel.shown(), "agents-registry-error");
    assert.equal(text(panel.slot()!.querySelector(".notice-title")), "Couldn't Load Recorded Workers");
    assert.match(panel.slot()!.querySelector(".notice")!.className, /t-danger/);
    await panel.click(panel.button("Show Details"));
    assert.match(text(panel.slot()!.querySelector(".code-well")), /child-session inventory changed/);
    const before = reads.length;
    await panel.click(panel.button("Retry"));
    await settle(20);
    assert.deepEqual(reads.slice(before, before + 1), [1], "Retry reads the page the cursor stopped at, not the first");
    assertNoDomNode(panel.slot(), "the notice clears once the page loads");
  } finally {
    await panel.unmount();
  }
});

test("offline: the offline notice leads, the request count stays with no action, and the rows read Unverified", async () => {
  const panel = await mount(<Harness initial={asking(permission("audit-run", "audit"), question("parser-ask", "parser"))}
    runnerOnline={false} onOpenPrimaryRequest={() => assert.fail("nothing opens offline")} />);
  try {
    assert.equal(panel.shown(), "agents-runner-offline");
    assert.deepEqual(panel.rowBadges().sort(), ["Audit Storage: Unverified", "Inspect Parser: Unverified", "Review Docs: Unverified"]);
    assert.equal(panel.button("Review in Session"), undefined, "no attention action while offline");
    await panel.click(panel.slot()!.querySelector(".session-notice-more"));
    assert.deepEqual(panel.menuItems(), ["Requests Waiting"]);
    await panel.click(domWindow.document.querySelector('[role="menu"][aria-label="Panel Notices"] [role="menuitem"]') as unknown as Element);
    assert.equal(panel.shown(), "agents-attention");
    assert.equal(panel.sentence(), "2 requests are waiting. You can answer them when build-box reconnects.");
    assert.deepEqual(panel.slotButtons(), ["+1 More"], "the attention notice offers no action that can't work offline");
  } finally {
    await panel.unmount();
  }
});

test("no Agents text mentions background-job inventory or detached work", async () => {
  const untracked = { ...baseSession(), backgroundWorkTracking: "untracked", backgroundJobsTruncated: true,
    backgroundJobsAvailable: true, backgroundJobs: [] } as unknown as SessionView;
  const panel = await mount(<Harness initial={untracked} />);
  try {
    assert.doesNotMatch(text(panel.container), /inventory|detached|background-job history/i);
  } finally {
    await panel.unmount();
  }
});

test("a stale attention link is one info notice, and the aggregate link focuses the attention notice", async () => {
  const stale = await mount(<Harness initial={asking(permission("parser-run", "parser"))} attentionTarget={{ eventEpoch: 7, requestId: "parser-run" }} />);
  try {
    await stale.click(stale.slot()!.querySelector(".session-notice-more"));
    assert.deepEqual(stale.menuItems(), ["Attention Link Out of Date"]);
  } finally {
    await stale.unmount();
  }
  const aggregate = await mount(<Harness initial={asking(permission("parser-run", "parser"))} attentionTarget={{ eventEpoch: 0 }} />);
  try {
    await settle(40);
    assert.ok(focused() === (aggregate.slot() as unknown as Element), "focus lands on the notice slot");
    assert.equal(aggregate.shown(), "agents-attention");
  } finally {
    await aggregate.unmount();
  }
});

test("a pod member waiting on the person is counted, and Review in Session opens its session after this session's requests", async () => {
  const lead = asking(permission("parser-run", "parser"));
  const reviewer = { ...baseSession(), id: "member-review", title: "Parser Reviewer", status: "input_required",
    pendingApproval: permission("lint") } as unknown as SessionView;
  let view: unknown;
  const both = await mount(<Harness initial={lead} store={podConnection(lead, [reviewer])} onView={(next) => { view = next; }} />);
  try {
    await settle(20);
    assert.ok(both.rowBadges().includes("Parser Reviewer: Approval Required"), "the member's row reads its attention word");
    assert.equal(both.sentence(), "2 workers are waiting for your approval.", "the notice counts the member as its row does");
    await both.click(both.button("Review in Session"));
    assert.equal(both.container.querySelector(".agents-page .worker-detail")?.getAttribute("aria-label"), "Inspect Parser",
      "this session's own request comes first");
  } finally {
    await both.unmount();
  }
  const alone = { ...baseSession() } as SessionView;
  const memberOnly = await mount(<Harness initial={alone} store={podConnection(alone, [reviewer])} onView={(next) => { view = next; }} />);
  try {
    await settle(20);
    assert.equal(memberOnly.sentence(), "Parser Reviewer is waiting for your approval.");
    await memberOnly.click(memberOnly.button("Review in Session"));
    assert.deepEqual(view, { name: "session", id: "member-review" }, "a member's request is answered in its own session");
  } finally {
    await memberOnly.unmount();
  }
});

test("Review in Session on a request no page carries gives the roster back while a worker page is open (#2861 review)", async () => {
  const orphan = { requestId: "gone-run", ownerToolUseId: "gone", title: "Bash: ls", options: allow };
  const panel = await mount(<Harness initial={asking(orphan)} />);
  try {
    const row = [...panel.container.querySelectorAll(".agents-list .worker-row")].find((candidate) => text(candidate.querySelector(".row-title")) === "Inspect Parser");
    await panel.click(row);
    assert.ok(panel.container.querySelector(".agents-page"), "a worker page is open");
    await panel.click(panel.button("Review in Session"));
    await settle(20);
    assertNoDomNode(panel.container.querySelector(".agents-page"), "the page gives way to the roster");
    const card = panel.container.querySelector<HTMLElement>('[role="region"][aria-label="Selected Worker Request"]')!;
    assert.equal(card.dataset.sessionRequestId, "gone-run");
    assertNoDomNode(card.closest("[hidden]"), "the card is not inside a hidden roster");
    assert.ok(focused() === (card as unknown as Element), "focus lands on the request card");
  } finally {
    await panel.unmount();
  }
});

test("offline, a waiting member sharing the machine stays counted with no action (#2861 review)", async () => {
  const lead = { ...baseSession() } as SessionView;
  const reviewer = { ...baseSession(), id: "member-offline", runnerId: lead.runnerId, title: "Parser Reviewer", status: "input_required",
    pendingApproval: { ...permission("lint"), additionalRequests: [permission("format")] } } as unknown as SessionView;
  const panel = await mount(<Harness initial={lead} runnerOnline={false} store={podConnection(lead, [reviewer])} />);
  try {
    await settle(20);
    assert.ok(panel.rowBadges().includes("Parser Reviewer: Unverified"));
    assert.equal(panel.shown(), "agents-runner-offline");
    await panel.click(panel.slot()!.querySelector(".session-notice-more"));
    assert.deepEqual(panel.menuItems(), ["Requests Waiting"]);
    await panel.click(domWindow.document.querySelector('[role="menu"][aria-label="Panel Notices"] [role="menuitem"]') as unknown as Element);
    assert.equal(panel.sentence(), "2 requests are waiting. You can answer them when build-box reconnects.",
      "every request the member holds is counted, not the member once");
    assert.equal(panel.button("Review in Session"), undefined);
  } finally {
    await panel.unmount();
  }
});
