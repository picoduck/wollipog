import assert from "node:assert/strict";
import { after, before, test } from "node:test";
import React, { act, useState } from "react";
import { createRoot } from "react-dom/client";
import { Window } from "happy-dom";
import { PROTOCOL_VERSION, removePendingRequest, type SessionView } from "@wollipog/protocol";
import { api, type ApiClient } from "../api.js";
import { ApiProvider } from "../api-context.js";
import { StoreProvider } from "../store.js";
import { FeedbackProvider } from "./FeedbackProvider.js";
import { UI_SOCKET_OPEN, type UiConnectionRuntime } from "../ui-transport.js";
import type { TimelineItem } from "../timeline.js";
import { installDomTestCleanup } from "../dom-test-cleanup.js";
import { assertNoDomNode } from "../dom-test-assertions.js";
import { AgentsPanel } from "./AgentsPanel.js";
import { WORKER_DETAIL_COPY, workerTokensLabel } from "./WorkerDetail.js";

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
  instanceId: "worker-detail", runtimeKey: "worker-detail",
  createSocket: () => ({ readyState: UI_SOCKET_OPEN, onopen: null, onmessage: null,
    onclose: null, onerror: null, send() {}, close() {} }), close() {},
};

const now = Date.now();
const session = {
  id: "lead", runnerId: "runner", workspaceId: null, agentId: null, title: "Lead", status: "running",
  driver: "claude-code", runId: null, archived: false, createdAt: now - 60_000, updatedAt: now, lastEventAt: now,
  messageCount: 10, eventEpoch: 0, pendingApproval: null, worktreePath: "/work/repo",
} as unknown as SessionView;
const agent = (id: string, index: number, extra: Partial<Extract<TimelineItem, { kind: "tool_call" }>> = {}): TimelineItem => ({
  kind: "tool_call", id: index, toolCallId: id, title: `Agent: ${id}`, text: "", toolKind: "agent",
  status: "in_progress", startedAt: now - 30_000, ...extra,
});
const items: TimelineItem[] = [
  agent("audit", 1, { title: "Audit Storage", subagentRollup: { inputTokens: 400, outputTokens: 200 } }),
  agent("parser", 2, { title: "Inspect Parser", parentToolUseId: "audit", subagentRollup: { inputTokens: 100, outputTokens: 40 } }),
  { kind: "agent_message", id: 3, text: "The parser tests are ready to run.", parentToolUseId: "parser", createdAt: now - 10_000 },
  agent("docs", 4, { title: "Review Documentation", status: "completed", completedAt: now - 5_000 }),
];
const text = (element: Element | null | undefined) => element?.textContent?.trim() ?? "";
const focused = () => domWindow.document.activeElement as unknown as Element | null;

/** AgentsPanel outside the side panel, where pages keep a stack of their own. Approving a request
 * removes it from the session, as the control plane would. */
function Harness({ initial, runnerOnline = true, requestedId = null, focusRequest, focusPendingRequest, onOpenInBackgroundWork, list = items,
  childSessions, onSession }: {
  initial: SessionView;
  runnerOnline?: boolean;
  requestedId?: string | null;
  focusRequest?: number;
  focusPendingRequest?: boolean;
  onOpenInBackgroundWork?: (jobId: string) => void;
  list?: TimelineItem[];
  /** The durable child registry; by default an older control plane without one. */
  childSessions?: ApiClient["childSessions"];
  /** Hands the test a way to change the session, as a live update would. */
  onSession?: (set: (session: SessionView) => void) => void;
}) {
  const [current, setCurrent] = useState(initial);
  onSession?.(setCurrent);
  const [selected, setSelected] = useState<string | null>(requestedId);
  const [focus, setFocus] = useState(focusRequest);
  const client: ApiClient = {
    ...api,
    childSessions: childSessions ?? (async () => { throw new Error("registry unavailable"); }),
    approve: async (_sessionId, { requestId }) => {
      const next = { ...current, pendingApproval: removePendingRequest(current.pendingApproval, requestId) };
      setCurrent(next);
      return next;
    },
  };
  return <ApiProvider client={client}><FeedbackProvider><StoreProvider connection={connection}>
    <AgentsPanel session={current} items={list} runnerOnline={runnerOnline} runnerProtocolVersion={PROTOCOL_VERSION}
      requestedId={selected} onSelect={setSelected} focusRequest={focus} focusPendingRequest={focusPendingRequest}
      onFocusRequestHandled={() => setFocus(undefined)} onOpenInBackgroundWork={onOpenInBackgroundWork}
      parentTurns={new Map()} onViewTurn={() => {}} />
  </StoreProvider></FeedbackProvider></ApiProvider>;
}

async function mount(element: React.ReactElement) {
  const happyContainer = domWindow.document.createElement("div");
  domWindow.document.body.append(happyContainer);
  const container = happyContainer as unknown as HTMLDivElement;
  const root = createRoot(container);
  await act(async () => root.render(element));
  await act(async () => { await new Promise((resolve) => setTimeout(resolve, 10)); });
  return {
    container,
    row: (name: string) => [...container.querySelectorAll<HTMLButtonElement>(".agents-list .worker-row")]
      .find((row) => text(row.querySelector(".row-title")) === name)!,
    async click(element: Element | null | undefined) {
      assert.ok(element, "the control is on screen");
      await act(async () => (element as HTMLElement).click());
      await act(async () => { await new Promise((resolve) => setTimeout(resolve, 0)); });
    },
    async unmount() { await act(async () => root.unmount()); container.remove(); },
  };
}

const asking = {
  ...session, status: "input_required",
  pendingApproval: {
    requestId: "primary", title: "Bash: rm -rf build", options: [{ optionId: "yes", name: "Allow", kind: "allow_once" }],
    additionalRequests: [{
      requestId: "parser-run", ownerToolUseId: "parser", title: "Bash: npm test -- storage",
      options: [{ optionId: "yes", name: "Allow", kind: "allow_once" }],
    }],
  },
} as unknown as SessionView;

test("a worker's page shows the same badge as its row in every state the roster draws", async () => {
  const cases: { session: SessionView; online: boolean; name: string; filter?: string }[] = [
    { session, online: true, name: "Audit Storage" },
    { session: asking, online: true, name: "Inspect Parser" },
    { session, online: false, name: "Audit Storage" },
    { session, online: true, name: "Review Documentation", filter: "History, 1" },
    { session: { ...session, status: "failed" } as SessionView, online: true, name: "Audit Storage", filter: "History, 3" },
  ];
  const badges: string[] = [];
  for (const entry of cases) {
    const panel = await mount(<Harness initial={entry.session} runnerOnline={entry.online} />);
    try {
      if (entry.filter) await panel.click(panel.container.querySelector(`[role="radio"][aria-label="${entry.filter}"]`));
      const row = panel.row(entry.name);
      const badge = text(row.querySelector(".status"));
      await panel.click(row);
      assert.equal(text(panel.container.querySelector(".agents-page .worker-detail-head .status")), badge,
        `${entry.name}'s page reads "${badge}" as its row does`);
      badges.push(badge);
    } finally {
      await panel.unmount();
    }
  }
  assert.deepEqual(badges, ["Running", "Approval Required", "Unverified", "Completed", "Lost"]);
});

test("the page's facts name the worker's kind, its parent as a link, and its tokens with the nested total", async () => {
  const panel = await mount(<Harness initial={session} />);
  try {
    await panel.click(panel.row("Audit Storage"));
    const page = panel.container.querySelector(".agents-page .worker-detail")!;
    assert.equal(page.getAttribute("aria-label"), "Audit Storage");
    const facts = [...page.querySelectorAll(".worker-detail-meta > li")].map(text);
    assert.equal(facts[0], "Subagent");
    assert.match(facts[1]!, /^Started /);
    assert.ok(facts.includes("600 Tokens, 740 With Nested"), `the tokens fact counts its nested worker: ${facts.join(" | ")}`);
    assert.equal(facts[facts.indexOf("600 Tokens, 740 With Nested") + 1], "Excludes Cached Input",
      "Claude counts only uncached input, and the page says so beside the count (#3086)");
    assert.equal(facts.some((fact) => fact.startsWith("In ")), false, "a top-level worker has no parent link");

    // Nested Workers lists its child as a roster row, which opens the child's own page.
    const nested = page.querySelector('[role="list"][aria-label="Nested Workers"]')!;
    assert.equal(text(page.querySelector(".worker-detail-section .group-label")), "Nested Workers1");
    const child = nested.querySelector<HTMLButtonElement>(".worker-row")!;
    assert.equal(text(child.querySelector(".row-title")), "Inspect Parser");
    assert.equal(child.dataset.panelPageKey, "subagent:parser");
    await panel.click(child);
    const childPage = panel.container.querySelector(".agents-page .worker-detail")!;
    assert.equal(childPage.getAttribute("aria-label"), "Inspect Parser");
    const parentLink = childPage.querySelector<HTMLButtonElement>(".worker-detail-meta .link")!;
    assert.equal(text(parentLink.closest("li")), "In Audit Storage");
    assert.ok(text(childPage).includes("The parser tests are ready to run."), "Activity shows the worker's own output");
    await panel.click(parentLink);
    assert.equal(panel.container.querySelector(".agents-page .worker-detail")?.getAttribute("aria-label"), "Audit Storage");
  } finally {
    await panel.unmount();
  }
});

test("a waiting worker's page says what it wants and answers its request there; the session's own never shows", async () => {
  // The worker's request first, so the attention notice's Review in Session opens it.
  const workerFirst = { ...asking, pendingApproval: { ...asking.pendingApproval!.additionalRequests![0]!,
    additionalRequests: [{ ...asking.pendingApproval!, additionalRequests: undefined }] } } as SessionView;
  const panel = await mount(<Harness initial={workerFirst} />);
  try {
    // Review in Session sends the worker's request to its page, with focus on the request.
    const review = [...panel.container.querySelectorAll<HTMLButtonElement>(".panel-notice-slot button")]
      .find((button) => text(button) === "Review in Session");
    await panel.click(review);
    const page = panel.container.querySelector(".agents-page .worker-detail")!;
    assert.ok(panel.container.querySelector<HTMLElement>(".agents-panel")!.hidden, "the roster waits under the page");
    assert.equal(text(page.querySelector(".notice")), "Wants to run npm test -- storage and is waiting for your approval.");
    const request = page.querySelector<HTMLElement>(`[role="region"][aria-label="${WORKER_DETAIL_COPY.request}"]`)!;
    assert.equal(request.dataset.sessionRequestId, "parser-run");
    assert.ok(focused() === (request as unknown as Element), "focus lands on the request");
    assert.equal(page.querySelectorAll("[data-session-request-id]").length, 1, "only the worker's own request is on its page");

    const allow = [...request.querySelectorAll<HTMLButtonElement>("button")].find((button) => text(button) === "Allow")!;
    allow.focus();
    await panel.click(allow);
    assertNoDomNode(page.querySelector(`[aria-label="${WORKER_DETAIL_COPY.request}"]`), "answering resolves the request here");
    assertNoDomNode(page.querySelector(".notice"));
    assert.ok(focused() === (page as unknown as Element), "focus stays on the page");
    assert.equal(text(page.querySelector(".worker-detail-head .status")), "Running");
  } finally {
    await panel.unmount();
  }

  // The parent worker's page never carries the session's own request, which stays on its dock.
  const parent = await mount(<Harness initial={asking} />);
  try {
    await parent.click(parent.row("Audit Storage"));
    assertNoDomNode(parent.container.querySelector(".agents-page [data-session-request-id]"));
  } finally {
    await parent.unmount();
  }
});

test("a request preserved across a restart, or with no listed owner, is still answered in the roster", async () => {
  const orphaned = { ...session, status: "input_required", pendingApproval: {
    requestId: "gone-run", ownerToolUseId: "gone", title: "Bash: ls", options: [{ optionId: "yes", name: "Allow", kind: "allow_once" }],
  } } as unknown as SessionView;
  const panel = await mount(<Harness initial={orphaned} />);
  try {
    assert.equal(text(panel.container.querySelector(".panel-notice-slot .notice-body")), "A subagent is waiting for your approval.");
    await panel.click([...panel.container.querySelectorAll(".panel-notice-slot button")].find((button) => text(button) === "Review in Session"));
    assertNoDomNode(panel.container.querySelector(".agents-page"));
    assert.ok(panel.container.querySelector('[aria-label="Selected Worker Request"] [data-session-request-id], [aria-label="Selected Worker Request"][data-session-request-id]'));
  } finally {
    await panel.unmount();
  }
});

test("the transcript's Open can land on the worker's pending request rather than its title (#2861)", async () => {
  const panel = await mount(<Harness initial={asking} requestedId="parser" focusRequest={3} focusPendingRequest />);
  try {
    const request = panel.container.querySelector(`.agents-page [aria-label="${WORKER_DETAIL_COPY.request}"]`)!;
    assert.ok(focused() === request, "focus lands on the pending request");
  } finally {
    await panel.unmount();
  }
});

test("a worker that cannot be shown says why, with Back to Agents", async () => {
  const duplicate: TimelineItem[] = [
    { kind: "tool_call", id: 101, toolCallId: "duplicate", title: "First Agent", text: "", toolKind: "agent", status: "completed" },
    { kind: "tool_call", id: 102, toolCallId: "duplicate", title: "Second Agent", text: "", toolKind: "agent", status: "completed" },
  ];
  const ambiguous = await mount(<Harness initial={session} list={duplicate} requestedId="duplicate" focusRequest={1} />);
  try {
    const state = ambiguous.container.querySelector(".agents-page .state")!;
    assert.equal(text(state.querySelector(".state-title")), "Can't Show This Worker");
    assert.equal(text(state.querySelector(".state-body")), WORKER_DETAIL_COPY.ambiguous);
    await ambiguous.click([...state.querySelectorAll("button")].find((button) => text(button) === "Back to Agents"));
    assertNoDomNode(ambiguous.container.querySelector(".agents-page"));
    assert.equal(ambiguous.container.querySelector<HTMLElement>(".agents-panel")!.hidden, false);
  } finally {
    await ambiguous.unmount();
  }
  const missing = await mount(<Harness initial={session} requestedId="expired-agent" focusRequest={1} />);
  try {
    assert.equal(text(missing.container.querySelector(".agents-page .state-body")), WORKER_DETAIL_COPY.missing);
  } finally {
    await missing.unmount();
  }
});

test("Activity says plainly when there is no output, and a Codex worker says why there is only a summary", async () => {
  const quiet = [agent("quiet", 1, { title: "Quiet Worker" })];
  const claude = await mount(<Harness initial={session} list={quiet} />);
  try {
    await claude.click(claude.row("Quiet Worker"));
    assert.equal(text(claude.container.querySelector(".agents-page .worker-detail-note")), WORKER_DETAIL_COPY.empty);
  } finally {
    await claude.unmount();
  }
  const codex = await mount(<Harness initial={{ ...session, driver: "codex" } as SessionView} list={quiet} />);
  try {
    await codex.click(codex.row("Quiet Worker"));
    const notice = codex.container.querySelector(".agents-page .notice")!;
    assert.equal(text(notice), WORKER_DETAIL_COPY.codex);
    assert.match(notice.className, /neutral/);
  } finally {
    await codex.unmount();
  }
});

test("a background job opens the shared Job Detail page under its roster name, with Open in Background Work", async () => {
  const withJob = { ...session, backgroundWorkState: "running", backgroundWorkTracking: "managed", backgroundJobsAvailable: true,
    backgroundJobs: [{ id: "job-monitor-7be210", parentTurnId: "turn-1", launchType: "monitor", registeredAt: now - 60_000,
      lastObservedAt: now, sourcePresent: true }] } as unknown as SessionView;
  const opened: string[] = [];
  const panel = await mount(<Harness initial={withJob} onOpenInBackgroundWork={(jobId) => opened.push(jobId)} />);
  try {
    const row = panel.row("Monitor Job 7be210");
    assert.ok(row, "the job is listed under its roster name");
    await panel.click(row);
    assert.ok(panel.container.querySelector('.agents-page .job-detail[aria-label="Monitor Job 7be210"]'));
    assertNoDomNode(panel.container.querySelector(".background-work-panel"), "no Background Work list renders inside Agents");
    await panel.click([...panel.container.querySelectorAll(".agents-page button")].find((button) => text(button) === "Open in Background Work"));
    assert.deepEqual(opened, ["job-monitor-7be210"]);
  } finally {
    await panel.unmount();
  }
});

test("the tokens fact adds the nested total only when nested workers add to it", () => {
  assert.equal(workerTokensLabel(600, 740), "600 Tokens, 740 With Nested");
  assert.equal(workerTokensLabel(600, 600), "600 Tokens");
  assert.equal(workerTokensLabel(1200, undefined), "1,200 Tokens");
  assert.equal(workerTokensLabel(undefined, undefined), null);
});

test("a transcript worker past the registry's first page still opens its page, before Show More lists it", async () => {
  const many: TimelineItem[] = Array.from({ length: 51 }, (_, index) => agent(`worker-${index + 1}`, index + 1,
    { title: `Worker ${index + 1}` }));
  const firstPage: ApiClient["childSessions"] = async () => ({
    children: Array.from({ length: 50 }, (_, index) => ({ toolCallId: `worker-${index + 1}`, name: `Worker ${index + 1}`,
      status: "in_progress", lifecycle: "running", sourceSeq: index + 1, startedAt: now - 30_000, lastActivityAt: now, toolCount: 0 })),
    attentionOwners: [], unidentifiedChildren: 0, eventEpoch: 0, nextAfter: 50, truncated: true,
  }) as unknown as Awaited<ReturnType<ApiClient["childSessions"]>>;
  const panel = await mount(<Harness initial={session} list={many} childSessions={firstPage} requestedId="worker-51" focusRequest={1} />);
  try {
    assertNoDomNode(panel.container.querySelector('.agents-panel [data-panel-page-key="subagent:worker-51"]'),
      "the registry has not listed it yet");
    const page = panel.container.querySelector(".agents-page .worker-detail");
    assert.equal(page?.getAttribute("aria-label"), "Worker 51");
    assert.equal(text(page?.querySelector(".worker-detail-head .status")), "Running");
  } finally {
    await panel.unmount();
  }
});

test("Activity's list follows everything above it as the page's own child, so its virtual scroller sees them move", async () => {
  const panel = await mount(<Harness initial={asking} requestedId="parser" focusRequest={1} />);
  try {
    const page = panel.container.querySelector(".agents-page .worker-detail")!;
    const children = [...page.children];
    const list = page.querySelector(":scope > .timeline");
    assert.ok(list, "the activity list is a direct child of the page");
    assert.ok(children.indexOf(page.querySelector(":scope > .worker-detail-request")!) < children.indexOf(list),
      "the request comes before it");
  } finally {
    await panel.unmount();
  }
});

test("a request focus asked for a worker with no request is spent, so a request that arrives later does not take focus", async () => {
  let setSession!: (session: SessionView) => void;
  const panel = await mount(<Harness initial={session} requestedId="parser" focusRequest={1} focusPendingRequest
    onSession={(set) => { setSession = set; }} />);
  try {
    assertNoDomNode(panel.container.querySelector(`[aria-label="${WORKER_DETAIL_COPY.request}"]`));
    const outside = domWindow.document.createElement("button");
    domWindow.document.body.append(outside);
    outside.focus();
    await act(async () => setSession(asking));
    const request = panel.container.querySelector(`.agents-page [aria-label="${WORKER_DETAIL_COPY.request}"]`);
    assert.ok(request, "the request now shows on the page");
    assert.ok(focused() === (outside as unknown as Element), "focus stays where the person left it");
    outside.remove();
  } finally {
    await panel.unmount();
  }
});

const registryPage = (children: { id: string; name: string }[], nextAfter: number | null) => ({
  children: children.map((child, index) => ({ toolCallId: child.id, name: child.name, status: "in_progress", lifecycle: "running",
    sourceSeq: index + 1, startedAt: now - 30_000, lastActivityAt: now, toolCount: 0 })),
  attentionOwners: [], unidentifiedChildren: 0, eventEpoch: 0, nextAfter, truncated: nextAfter !== null,
}) as unknown as Awaited<ReturnType<ApiClient["childSessions"]>>;

test("a worker's page lists a transcript child the registry has not listed yet under Nested Workers", async () => {
  const many: TimelineItem[] = Array.from({ length: 51 }, (_, index) => agent(`worker-${index + 1}`, index + 1,
    { title: `Worker ${index + 1}`, ...(index === 50 ? { parentToolUseId: "worker-50" } : {}) }));
  const firstPage: ApiClient["childSessions"] = async () => registryPage(
    Array.from({ length: 50 }, (_, index) => ({ id: `worker-${index + 1}`, name: `Worker ${index + 1}` })), 50);
  const panel = await mount(<Harness initial={session} list={many} childSessions={firstPage} requestedId="worker-50" focusRequest={1} />);
  try {
    const page = panel.container.querySelector(".agents-page .worker-detail")!;
    assert.equal(page.getAttribute("aria-label"), "Worker 50");
    const child = page.querySelector<HTMLButtonElement>('[role="list"][aria-label="Nested Workers"] [data-panel-page-key="subagent:worker-51"]');
    assert.ok(child, "Nested Workers lists the transcript child");
    await panel.click(child);
    const childPage = panel.container.querySelector(".agents-page .worker-detail")!;
    assert.equal(childPage.getAttribute("aria-label"), "Worker 51");
    assert.equal(text(childPage.querySelector(".worker-detail-meta .link")), "Worker 50", "its parent link names the listed parent");
  } finally {
    await panel.unmount();
  }
});

test("a worker known only to the registry loads before its page shows, then its request takes the focus asked for", async () => {
  let release!: () => void;
  const registry: ApiClient["childSessions"] = () => new Promise((resolve) => {
    release = () => resolve(registryPage([{ id: "durable", name: "Durable Worker" }], null));
  });
  const waiting = { ...session, status: "input_required", pendingApproval: {
    requestId: "durable-run", ownerToolUseId: "durable", title: "Bash: npm test", options: [{ optionId: "yes", name: "Allow", kind: "allow_once" }],
  } } as unknown as SessionView;
  const panel = await mount(<Harness initial={waiting} list={[]} childSessions={registry} requestedId="durable" focusRequest={1}
    focusPendingRequest />);
  try {
    assert.equal(text(panel.container.querySelector(".agents-page .state")), WORKER_DETAIL_COPY.loading,
      "the page waits for the registry rather than calling the worker gone");
    await act(async () => { release(); await new Promise((resolve) => setTimeout(resolve, 10)); });
    const request = panel.container.querySelector(`.agents-page [aria-label="${WORKER_DETAIL_COPY.request}"]`);
    assert.ok(request, "the worker's request shows on its page");
    assert.ok(focused() === request, "and takes the focus asked for");
  } finally {
    await panel.unmount();
  }
});
