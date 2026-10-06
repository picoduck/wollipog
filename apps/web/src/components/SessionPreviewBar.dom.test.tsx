import assert from "node:assert/strict";
import test from "node:test";
import React, { act } from "react";
import { createRoot } from "react-dom/client";
import { Window } from "happy-dom";
import type { ControlPlaneToUi, PendingApproval, ProjectView, RunnerView, SessionView } from "@wollipog/protocol";
import { api, type ApiClient } from "../api.js";
import { ApiProvider } from "../api-context.js";
import type { ViewNavigation } from "../navigation.js";
import { sessionStatusSummary } from "../status-meta.js";
import { StoreProvider } from "../store.js";
import { UI_SOCKET_OPEN, type UiConnectionRuntime, type UiSocket } from "../ui-transport.js";
import { FeedbackContext } from "./FeedbackProvider.js";
import { SessionDetail } from "./SessionDetail.js";
import { SessionPreviewBar } from "./SessionPreviewBar.js";
import { decideDockedRequest } from "./requests/request-reveal.js";
import { installDomTestCleanup } from "../dom-test-cleanup.js";

/**
 * #2210: the Sessions preview's detail bar. One status, the same one the session bar and the rows
 * choose (`sessionStatusSummary()`); quiet facts under it; the request at the top of the preview.
 */

const domWindow = new Window({ url: "http://localhost/" });
installDomTestCleanup(domWindow);
Object.defineProperty(domWindow.Element.prototype, "getBoundingClientRect", {
  configurable: true,
  value: () => ({ x: 0, y: 0, top: 0, left: 0, right: 1200, bottom: 72, width: 1200, height: 72, toJSON: () => ({}) }),
});
for (const [name, value] of Object.entries({
  window: domWindow, document: domWindow.document, navigator: domWindow.navigator,
  localStorage: domWindow.localStorage, Element: domWindow.Element, HTMLElement: domWindow.HTMLElement,
  HTMLButtonElement: domWindow.HTMLButtonElement, HTMLTextAreaElement: domWindow.HTMLTextAreaElement, Node: domWindow.Node, Event: domWindow.Event,
  MouseEvent: domWindow.MouseEvent, KeyboardEvent: domWindow.KeyboardEvent,
  MutationObserver: domWindow.MutationObserver, React, IS_REACT_ACT_ENVIRONMENT: true,
  getComputedStyle: domWindow.getComputedStyle.bind(domWindow),
  ResizeObserver: class { observe() {} unobserve() {} disconnect() {} },
  requestAnimationFrame: (callback: FrameRequestCallback) => setTimeout(() => callback(0), 0) as unknown as number,
  cancelAnimationFrame: (id: number) => clearTimeout(id as unknown as NodeJS.Timeout),
})) Object.defineProperty(globalThis, name, { configurable: true, writable: true, value });
Object.defineProperty(domWindow, "matchMedia", {
  configurable: true,
  value: (query: string) => ({
    matches: false, media: query, addEventListener() {}, removeEventListener() {}, addListener() {}, removeListener() {},
  }),
});

const RUNNER_ID = "runner-preview";

const runner = {
  runnerId: RUNNER_ID, hostname: "mac-studio.local", displayName: "Mac Studio", os: "macos", version: "1", status: "online",
  agents: [{ id: "claude", name: "Claude Code", command: "claude", args: [], env: {}, driver: "claude", available: true }],
  editors: [], workspaces: [], connectedAt: 1, lastSeen: 1, protocolVersion: 146,
} as unknown as RunnerView;

const project = {
  id: "payments", name: "Payments Service", hidden: false, locations: [], activeSessionCount: 0,
  unarchivedSessionCount: 1, totalSessionCount: 1, createdAt: 1, updatedAt: 1,
} as ProjectView;

function session(overrides: Partial<SessionView> = {}): SessionView {
  return {
    id: "previewed", runnerId: RUNNER_ID, workspaceId: null, workspaceName: "payments-workspace", projectId: project.id,
    projectName: project.name, agentId: "claude", agentName: "Claude Code", title: "Reconcile the Ledger", status: "idle",
    column: "review", runId: null, useWorktree: false, worktreePath: null, worktrees: [],
    archived: false, createdAt: 1, updatedAt: 1, lastEventAt: 1, messageCount: 0, eventEpoch: 0, preview: null,
    pendingApproval: null, driver: "claude", model: null, effort: null, permissionMode: null,
    tokensIn: 12_000, tokensOut: 3_400, costUsd: 4.27, adopted: false,
    ...overrides,
  } as unknown as SessionView;
}

function permission(requestId: string, title = "Run the Migration"): PendingApproval {
  return {
    requestId, kind: "permission", title,
    context: { toolName: "Bash", input: "psql ledger -f migrate.sql" },
    options: [
      { optionId: `${requestId}-allow`, name: "Allow Once", kind: "allow_once" },
      { optionId: `${requestId}-deny`, name: "Deny", kind: "reject_once" },
    ],
  };
}

function question(requestId: string): PendingApproval {
  return {
    requestId, kind: "question", title: "Agent Question", options: [],
    questions: [
      { id: "q1", question: "Which ledger should be reconciled first?", options: [{ label: "Payments" }, { label: "Refunds" }] },
      { id: "q2", question: "Should refunds be included?", options: [{ label: "Yes" }, { label: "No" }] },
    ],
  } as PendingApproval;
}

function withRequests(...requests: PendingApproval[]): PendingApproval {
  const [first, ...rest] = requests;
  return { ...first!, ...(rest.length > 0 ? { additionalRequests: rest } : {}) };
}

/** Every status the preview bar can show, seeded as the Sessions list would hold it. */
const SEEDED: Array<{ name: string; session: SessionView; runnerOnline?: boolean }> = [
  { name: "awaiting prompt", session: session() },
  { name: "queued", session: session({ status: "queued" }) },
  { name: "starting", session: session({ status: "starting" }) },
  { name: "running", session: session({ status: "running", activeTurnId: "turn-1" }) },
  { name: "completed", session: session({ status: "completed" }) },
  { name: "failed", session: session({ status: "failed" }) },
  { name: "stopped", session: session({ status: "stopped" }) },
  { name: "one approval", session: session({ status: "input_required", pendingApproval: permission("one") }) },
  { name: "three approvals", session: session({
    status: "input_required", pendingApproval: withRequests(permission("a"), permission("b"), permission("c")),
  }) },
  { name: "an approval and a question", session: session({
    status: "input_required", pendingApproval: withRequests(permission("p"), question("q")),
  }) },
  { name: "a question", session: session({ status: "input_required", pendingApproval: question("only") }) },
  { name: "an approval with background work on an offline machine", runnerOnline: false, session: session({
    status: "input_required", backgroundWorkState: "running", pendingApproval: permission("offline"),
  }) },
  { name: "background work while awaiting a prompt", session: session({ backgroundWorkState: "running" }) },
  { name: "background work lost", session: session({ backgroundWorkState: "orphaned" }) },
  { name: "a running session on an offline machine", runnerOnline: false, session: session({ status: "running" }) },
  { name: "a blocked background result", session: session({
    backgroundDeliveries: [{ parentTurnId: "turn-2", jobCount: 2, terminalCount: 1, watchdogState: "continuation_blocked" }],
  }) },
  { name: "archived at rest", session: session({ archived: true, status: "stopped" }) },
  { name: "a failed archive stop", session: session({ status: "running", archiveStatus: "stop_failed" }) },
];

function mount() {
  const container = domWindow.document.createElement("div") as unknown as HTMLDivElement;
  domWindow.document.body.append(container as never);
  return { container, root: createRoot(container) };
}

test("the preview bar shows exactly one status, the one sessionStatusSummary() ranks first, for every seeded status", async () => {
  const { container, root } = mount();
  try {
    for (const seeded of SEEDED) {
      const runnerOnline = seeded.runnerOnline ?? true;
      await act(async () => root.render(
        <SessionPreviewBar session={seeded.session} runnerOnline={runnerOnline} machineName="Mac Studio"
          agentLabel="Claude Code" archiveLabel="Archive" />,
      ));
      const { primary, more } = sessionStatusSummary(seeded.session, { runnerOnline });
      const bar = container.querySelector("header.session-preview-bar")!;
      const badges = [...bar.querySelectorAll(".status")];
      assert.equal(badges.length, 1, `${seeded.name}: exactly one status badge`);
      const badge = badges[0]!;
      assert.equal(badge.firstChild?.textContent, primary.meta.label, `${seeded.name}: the ranked badge`);
      assert.ok(badge.classList.contains(`t-${primary.meta.tone}`), `${seeded.name}: the ranked tone`);
      assert.equal(bar.querySelector(".session-status-more")?.textContent ?? null, more > 0 ? `+${more}` : null,
        `${seeded.name}: "+N" counts the other conditions that need the person`);
    }
  } finally {
    await act(async () => root.unmount());
    container.remove();
  }
});

test("the preview bar's +N and badge count read as words, and its facts carry their icons and names", async () => {
  const { container, root } = mount();
  try {
    const value = session({
      status: "input_required",
      pendingApproval: withRequests(permission("a"), question("q1"), question("q2")),
      useWorktree: true, worktreePath: "/repos/payments/.wt/ledger",
      worktrees: [{ id: "wt", path: "/repos/payments/.wt/ledger", branch: "fix/ledger-reconcile", source: "created" }],
    } as Partial<SessionView>);
    await act(async () => root.render(
      <SessionPreviewBar session={value} runnerOnline machineName="Mac Studio" agentLabel="Claude Code" archiveLabel="Archive" />,
    ));
    const status = container.querySelector(".session-preview-bar .detail-bar-status")!;
    assert.equal(status.textContent, "Answer Required2, 2 Requests+1 and 1 More");
    assert.equal(status.getAttribute("title"), "Answer Required and 1 more");
    const facts = [...container.querySelectorAll(".session-preview-facts > li")];
    assert.deepEqual(facts.map((fact) => fact.textContent), [
      "Machine: Mac Studio", "Branch: fix/ledger-reconcile", "Agent: Claude Code",
    ]);
    assert.ok(facts.every((fact) => fact.querySelector("svg[aria-hidden]") !== null), "each fact follows its icon");

    await act(async () => root.render(
      <SessionPreviewBar session={session()} runnerOnline machineName="Mac Studio" agentLabel="Claude Code" archiveLabel="Archive" />,
    ));
    assert.deepEqual([...container.querySelectorAll(".session-preview-facts > li")].map((fact) => fact.textContent), [
      "Machine: Mac Studio", "Agent: Claude Code",
    ], "no branch, no branch fact");
  } finally {
    await act(async () => root.unmount());
    container.remove();
  }
});

test("the preview bar's actions: Snooze and Archive icon buttons, ⋯ and Open Session with its Enter keycap", async () => {
  const { container, root } = mount();
  const calls: string[] = [];
  let menuRestore: (() => HTMLElement | null) | null = null;
  try {
    await act(async () => root.render(
      <SessionPreviewBar session={session({ status: "running" })} runnerOnline machineName="Mac Studio" agentLabel="Claude Code"
        archiveLabel="Archive and Stop"
        onSnooze={() => calls.push("snooze")}
        onArchive={() => calls.push("archive")}
        onSessionMenu={(_anchor, restore) => { calls.push("menu"); menuRestore = restore; }}
        onOpen={() => calls.push("open")} />,
    ));
    const buttons = [...container.querySelectorAll<HTMLButtonElement>(".session-preview-bar .detail-bar-actions > button")];
    assert.deepEqual(buttons.map((button) => [button.getAttribute("aria-label") ?? button.textContent, button.title]), [
      ["Snooze", "Snooze (H)"],
      ["Archive and Stop", "Archive and Stop (E)"],
      ["More Actions", "More Actions"],
      ["Open SessionEnter", "Open Session (Enter)"],
    ]);
    assert.deepEqual(buttons.slice(0, 3).map((button) => button.className), ["icon-btn", "icon-btn", "icon-btn"]);
    assert.equal(buttons[3]!.className, "btn session-preview-open", "Open Session is a .btn, not the primary");
    assert.equal(buttons[3]!.querySelector("kbd")?.getAttribute("aria-hidden"), "true", "the keycap is not in its name");
    assert.equal(container.querySelector(".session-preview-bar .detail-bar-back"), null, "the preview has no back button");
    for (const button of buttons) await act(async () => button.click());
    assert.deepEqual(calls, ["snooze", "archive", "menu", "open"]);
    assert.equal(menuRestore!(), buttons[2], "the menu hands focus back to ⋯");
  } finally {
    await act(async () => root.unmount());
    container.remove();
  }
});

class FakeSocket implements UiSocket {
  readonly readyState = UI_SOCKET_OPEN;
  onopen: (() => void) | null = null;
  onmessage: ((event: { data: string }) => void) | null = null;
  onclose: ((event: { code: number }) => void) | null = null;
  onerror: (() => void) | null = null;
  send() {}
  close() {}
  push(message: ControlPlaneToUi) { this.onmessage?.({ data: JSON.stringify(message) }); }
}

const settle = () => act(async () => { await new Promise((resolve) => setTimeout(resolve, 0)); });

async function renderPreview(
  value: SessionView,
  props: Partial<React.ComponentProps<typeof SessionDetail>> = {},
  apiOverrides: Record<string, unknown> = {},
  runnerStatus: RunnerView["status"] = "online",
) {
  const socket = new FakeSocket();
  const client = {
    ...api,
    session: () => new Promise<never>(() => {}),
    getSessionEventPage: () => new Promise<never>(() => {}),
    getSessionEventTailPage: () => new Promise<never>(() => {}),
    git: () => new Promise<never>(() => {}),
    gitSummary: () => new Promise<never>(() => {}),
    runnerSkills: async () => ({ desired: [], reported: null }),
    ...apiOverrides,
  } as unknown as ApiClient;
  const connection: UiConnectionRuntime = {
    instanceId: "preview-bar-test", runtimeKey: "preview-bar-test:1", createSocket: () => socket, close() {},
  };
  const navigation: ViewNavigation = {
    current: () => ({ name: "inbox" }), push: () => {}, listen: () => () => {},
  };
  const rightPanel = {
    open: false, mode: "launcher" as const, width: 360, dragging: false, subagentTarget: null,
    toggle() {}, openMode() {}, show() {}, setMode() {}, setWidth() {}, setDragging() {},
    close() {}, selectSubagent() {}, showSubagent() {}, consumeSubagentFocusRequest() {},
  };
  const feedback = { confirm: async () => false, showToast: () => 0, dismissToast: () => {} };
  const { container, root } = mount();
  await act(async () => root.render(
    <ApiProvider client={client}>
      <FeedbackContext.Provider value={feedback as never}>
        <StoreProvider connection={connection} navigation={navigation}>
          <SessionDetail sessionId={value.id} mode="preview" rightPanel={rightPanel}
            onOpenTerminal={() => {}} composerDraftLoader={async () => null} {...props} />
        </StoreProvider>
      </FeedbackContext.Provider>
    </ApiProvider>,
  ));
  await act(async () => socket.push({
    type: "snapshot",
    capabilities: { sessionSubscriptions: false, boundedDelivery: false, paginatedSessionHistory: false, projects: true },
    runners: [{ ...runner, status: runnerStatus }], boxes: [], projects: [project], sessions: [value], runs: [], pods: [],
  } as ControlPlaneToUi));
  await settle();
  await settle();
  return {
    container,
    async unmount() {
      await act(async () => root.unmount());
      container.remove();
    },
  };
}

test("the preview keeps only the bar's one status and the facts: no chips, Detached Work, activity strip, context, cost or Updated", async () => {
  const preview = await renderPreview(session({
    status: "running", activeTurnId: "turn-1", backgroundWorkTracking: "untracked",
    contextTokensUsed: 120_000, contextWindow: 200_000,
  } as Partial<SessionView>));
  try {
    const { container } = preview;
    const detail = container.querySelector(".session-detail.preview")!;
    assert.ok(detail, "the preview renders");
    assert.equal(detail.querySelectorAll(".tag").length, 0, "no .tag chips");
    assert.equal(detail.querySelector(".session-preview-meta"), null);
    assert.equal(detail.querySelector(".activity-strip"), null, "no activity strip");
    assert.equal(detail.querySelector(".context-control, .context-ring"), null, "no context meter");
    assert.equal(detail.querySelector(".session-usage-info"), null, "no cost");
    const text = detail.textContent ?? "";
    assert.doesNotMatch(text, /Detached Work/);
    assert.doesNotMatch(text, /\$4\.27|Cost/);
    assert.doesNotMatch(text, /Updated /);
    assert.equal(detail.querySelectorAll("header.session-preview-bar .status").length, 1);
    assert.equal([...detail.querySelectorAll(".status")].filter((badge) => !badge.closest(".session-preview-bar")).length, 0,
      "the bar's badge is the preview's only status outside the transcript");
  } finally {
    await preview.unmount();
  }
});

test("a pending request heads the preview, under the meta line and before the reading column", async () => {
  const preview = await renderPreview(session({
    status: "input_required", pendingApproval: withRequests(permission("first", "Run the Migration"), permission("second", "Vacuum")),
  }));
  try {
    const detail = preview.container.querySelector(".session-detail.preview")!;
    const slot = detail.querySelector(".detail-chat > .session-notice-slot");
    assert.ok(slot, "the dock's slot is a direct child of the chat column");
    const chatReading = detail.querySelector(".detail-chat > .chat-reading")!;
    assert.ok(slot!.compareDocumentPosition(chatReading) & domWindow.Node.DOCUMENT_POSITION_FOLLOWING,
      "the request comes before the transcript");
    assert.equal(chatReading.querySelector(".session-notice-slot"), null, "nothing docks at the bottom");
    const facts = detail.querySelector(".session-preview-facts")!;
    assert.ok(facts.compareDocumentPosition(slot!) & domWindow.Node.DOCUMENT_POSITION_FOLLOWING, "under the meta line");
    assert.equal(slot!.querySelector(".request-card-title")?.textContent, "Run the Migration", "the top request is expanded");
    assert.match(slot!.querySelector(".request-dock-more")?.textContent ?? "", /\+1 More Request/);
    assert.equal(detail.querySelector(".approval-bar"), null);
    assert.equal(slot!.querySelector(".dock-strip"), null, "a preview's card never shrinks to its strip");
  } finally {
    await preview.unmount();
  }
});

test("a question in the preview offers Answer in Session, which opens the session with that request", async () => {
  const opened: string[] = [];
  const preview = await renderPreview(session({ status: "input_required", pendingApproval: question("ask") }), {
    onOpenRequest: (requestId) => opened.push(requestId),
  });
  try {
    const card = preview.container.querySelector('.session-detail.preview .request-card[data-presentation="preview"]')!;
    assert.ok(card, "the preview's question card");
    assert.equal(card.querySelector(".request-card-title")?.textContent, "Which ledger should be reconciled first?");
    assert.equal(card.querySelector(".request-card-policy")?.textContent, "1 more question in this request.");
    assert.equal(card.querySelector("input, textarea, [role='radio'], [role='checkbox']"), null, "no answer form");
    const answer = [...card.querySelectorAll<HTMLButtonElement>("button")].find((button) => button.textContent?.startsWith("Answer in Session"))!;
    assert.ok(answer, "Answer in Session");
    await act(async () => answer.click());
    assert.deepEqual(opened, ["ask"]);
  } finally {
    await preview.unmount();
  }
});

test("A and D from the list act on the question the preview shows, not the one ranked above it", async () => {
  const opened: string[] = [];
  const dismissed: Array<{ requestId: string; action: string }> = [];
  const asked = (requestId: string, text: string): PendingApproval => ({
    requestId, kind: "question", title: "Agent Question", options: [],
    questions: [{ id: `${requestId}-q`, question: text, options: [{ label: "Yes" }, { label: "No" }] }],
  } as PendingApproval);
  const preview = await renderPreview(session({
    status: "input_required", pendingApproval: withRequests(asked("q1", "First question?"), asked("q2", "Second question?")),
  }), {
    onOpenRequest: (requestId) => opened.push(requestId),
  }, {
    answerQuestion: async (_sessionId: string, body: { requestId: string; action: string }) => {
      dismissed.push({ requestId: body.requestId, action: body.action });
      return session({ status: "input_required", pendingApproval: asked("q1", "First question?") });
    },
  });
  try {
    const slot = preview.container.querySelector(".session-detail.preview .detail-chat > .session-notice-slot")!;
    await act(async () => slot.querySelector<HTMLButtonElement>(".request-dock-more .disclosure-trigger")!.click());
    await act(async () => slot.querySelector<HTMLButtonElement>(".request-dock-row")!.click());
    assert.equal(slot.querySelector(".request-card-title")?.textContent, "Second question?", "the waiting question is in view");

    await act(async () => { assert.equal(decideDockedRequest("previewed", "approve"), true); });
    assert.deepEqual(opened, ["q2"], "A opens the question in view in its session");
    await act(async () => { assert.equal(decideDockedRequest("previewed", "deny"), true); });
    await settle();
    assert.deepEqual(dismissed, [{ requestId: "q2", action: "dismiss" }], "D dismisses the question in view");
  } finally {
    await preview.unmount();
  }
});

test("D sends nothing while the preview's question cannot be answered, and the card says why", async () => {
  const calls: string[] = [];
  const preview = await renderPreview(session({ status: "input_required", pendingApproval: question("offline-ask") }), {
    onOpenRequest: () => {},
  }, {
    answerQuestion: async () => { calls.push("answerQuestion"); return session(); },
  }, "offline");
  try {
    const card = preview.container.querySelector('.session-detail.preview .request-card[data-presentation="preview"]')!;
    assert.equal(card.querySelector(".request-card-reasons")?.textContent, "Responses are unavailable until the runner reconnects.");
    await act(async () => { assert.equal(decideDockedRequest("previewed", "deny"), true, "the card still takes D"); });
    await settle();
    assert.deepEqual(calls, [], "no dismissal is sent without a runner");
  } finally {
    await preview.unmount();
  }
});
