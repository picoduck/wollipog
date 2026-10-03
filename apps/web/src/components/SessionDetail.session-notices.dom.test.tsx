/**
 * #1966: a session in several problem states at once shows one notice above the composer — the most
 * severe — and lists the rest behind "+N More", rather than stacking a banner for each.
 */

import assert from "node:assert/strict";
import test from "node:test";
import React, { act } from "react";
import { createRoot } from "react-dom/client";
import { Window } from "happy-dom";
import type {
  ControlPlaneToUi, OrchestratorCampaignProjection, RunnerView, SessionEvent, SessionView,
} from "@wollipog/protocol";
import { api, type ApiClient } from "../api.js";
import { ApiProvider } from "../api-context.js";
import type { ViewNavigation } from "../navigation.js";
import { StoreProvider, useStoreActions, useStoreSelector } from "../store.js";
import { readTranscriptAction } from "../dom-test-transcript-actions.js";
import { UI_SOCKET_OPEN, type UiConnectionRuntime, type UiSocket } from "../ui-transport.js";
import { FeedbackContext } from "./FeedbackProvider.js";
import { SessionDetail } from "./SessionDetail.js";
import { assertNoDomNode } from "../dom-test-assertions.js";
import { installDomTestCleanup } from "../dom-test-cleanup.js";

const domWindow = new Window({ url: "http://localhost/" });
installDomTestCleanup(domWindow);
Object.defineProperty(domWindow.Element.prototype, "getBoundingClientRect", {
  configurable: true,
  value() {
    return { x: 0, y: 0, top: 0, left: 0, right: 800, bottom: 72, width: 800, height: 72, toJSON: () => ({}) };
  },
});
// The transcript renders only the rows that fit its viewport, so it needs a height to show any.
for (const [name, value] of [["clientHeight", 1_200], ["offsetHeight", 72]] as const) {
  Object.defineProperty(domWindow.HTMLElement.prototype, name, { configurable: true, get: () => value });
}
for (const [name, value] of Object.entries({
  window: domWindow,
  document: domWindow.document,
  navigator: domWindow.navigator,
  localStorage: domWindow.localStorage,
  Element: domWindow.Element,
  HTMLElement: domWindow.HTMLElement,
  HTMLTextAreaElement: domWindow.HTMLTextAreaElement,
  HTMLButtonElement: domWindow.HTMLButtonElement,
  Node: domWindow.Node,
  Event: domWindow.Event,
  MouseEvent: domWindow.MouseEvent,
  KeyboardEvent: domWindow.KeyboardEvent,
  MutationObserver: domWindow.MutationObserver,
  React,
  IS_REACT_ACT_ENVIRONMENT: true,
  ResizeObserver: class { observe() {} unobserve() {} disconnect() {} },
  requestAnimationFrame: (callback: FrameRequestCallback) =>
    setTimeout(() => callback(0), 0) as unknown as number,
  cancelAnimationFrame: (id: number) => clearTimeout(id as unknown as NodeJS.Timeout),
})) Object.defineProperty(globalThis, name, { configurable: true, writable: true, value });

function runnerView(online: boolean): RunnerView {
  return {
    runnerId: "runner-1",
    hostname: "runner-host",
    displayName: "Build Box",
    os: "linux",
    version: "1",
    status: online ? "online" : "offline",
    agents: [{
      id: "codex", name: "Codex", command: "codex", args: [], env: {},
      driver: "codex-app-server", available: true,
    }],
    workspaces: [],
    connectedAt: 1,
    lastSeen: 1,
    protocolVersion: 192,
  } as RunnerView;
}

const worktreePath = "/repos/demo/wt";
const quarantine: NonNullable<SessionView["historyQuarantine"]> = {
  reason: "oversized_tool_call", detectedAt: 5, recoveryTurn: 2, recovery: "fork",
};
const setupFailure: NonNullable<SessionView["worktrees"]>[number] = {
  id: "worktree-one", path: worktreePath, branch: "agent/setup", source: "created", baseCommit: "a".repeat(40),
  setup: {
    status: "failed", configHash: "b".repeat(64), attemptId: "attempt-one",
    environmentKeys: [], copies: [],
    steps: [{ name: "Install Dependencies", status: "failed", optional: false, startedAt: 1, durationMs: 902, error: "exited with 1" }],
    error: "Install Dependencies exited with 1",
  },
};
function accountFailure(label: string): NonNullable<SessionView["providerAccountSwitchFailure"]> {
  return {
    providerAccountId: "acct-2",
    providerAccountLabel: label,
    reason: "the provider conversation cannot be resumed under another account",
    detectedAt: 7,
  };
}

let fixtureSequence = 0;
function sessionView(overrides: Partial<SessionView>): SessionView {
  fixtureSequence += 1;
  return {
    id: `notices-${fixtureSequence}`, runnerId: "runner-1", workspaceId: null, workspaceName: null, projectId: null,
    agentId: "codex", agentName: "Codex", title: "Notice Fixture", status: "idle",
    column: "review", runId: null, useWorktree: true, worktreePath,
    archived: false, createdAt: 1, updatedAt: 1, lastEventAt: null, messageCount: 0,
    eventEpoch: 0, preview: null, pendingApproval: null, driver: "codex-app-server",
    model: "gpt-5.6-sol", effort: "high", permissionMode: null, tokensIn: 0, tokensOut: 0,
    costUsd: 0, adopted: false, providerAccountId: "acct-1", providerAccountLabel: "Personal",
    ...overrides,
  };
}

function EventSeeder({ sessionId, payloads }: { sessionId: string; payloads: SessionEvent["payload"][] }) {
  const ready = useStoreSelector((state) => state.sessions.has(sessionId));
  const { dispatch } = useStoreActions();
  React.useEffect(() => {
    if (!ready) return;
    payloads.forEach((payload, index) => {
      dispatch({
        type: "msg",
        msg: {
          type: "session_event",
          event: { id: index + 1, sessionId, seq: index + 1, ts: index + 1, payload },
        },
      });
    });
  }, [dispatch, payloads, ready, sessionId]);
  return null;
}

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

async function flush(delay = 0) {
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, delay));
    await Promise.resolve();
  });
}

async function mount(current: SessionView, { online = true, client: overrides = {}, events, unarchiveAndRestart = false }: {
  online?: boolean;
  client?: Partial<ApiClient>;
  /** Transcript events, delivered live once the session is in the store. */
  events?: SessionEvent["payload"][];
  /** The control plane owns one preflighted Unarchive and Restart. */
  unarchiveAndRestart?: boolean;
} = {}) {
  const toasts: string[] = [];
  const undos: string[] = [];
  const socket = new FakeSocket();
  const connection: UiConnectionRuntime = {
    instanceId: current.id, runtimeKey: `${current.id}:1`, createSocket: () => socket, close() {},
  };
  const navigation: ViewNavigation = {
    current: () => ({ name: "session", id: current.id }), push() {}, listen: () => () => {},
  };
  const client = {
    ...api,
    session: () => new Promise<never>(() => {}),
    getSessionEventPage: () => new Promise<never>(() => {}),
    getSessionEventTailPage: () => new Promise<never>(() => {}),
    ...overrides,
  } as unknown as ApiClient;
  const rightPanel = {
    open: false, mode: "launcher" as const, width: 360, dragging: false, subagentTarget: null,
    toggle() {}, openMode() {}, show() {}, setMode() {}, setWidth() {}, setDragging() {},
    close() {}, selectSubagent() {}, showSubagent() {}, consumeSubagentFocusRequest() {},
  };
  const container = domWindow.document.createElement("div") as unknown as HTMLDivElement;
  domWindow.document.body.append(container as never);
  const root = createRoot(container);
  await act(async () => root.render(
    <ApiProvider client={client}>
      <FeedbackContext.Provider value={{
        confirm: async () => true,
        showToast: (message: string) => { toasts.push(message); return 0; },
        showUndo: (message: string) => { undos.push(message); return 0; },
        dismissToast: () => {},
      } as never}>
        <StoreProvider connection={connection} navigation={navigation}>
          {events && <EventSeeder sessionId={current.id} payloads={events} />}
          <SessionDetail sessionId={current.id} mode="expanded" rightPanel={rightPanel}
            onOpenTerminal={() => {}} composerDraftLoader={async () => null} />
        </StoreProvider>
      </FeedbackContext.Provider>
    </ApiProvider>,
  ));
  await act(async () => socket.push({
    type: "snapshot",
    capabilities: {
      sessionSubscriptions: false, boundedDelivery: false, paginatedSessionHistory: false, projects: true, unarchiveAndRestart,
    },
    runners: [runnerView(online)], boxes: [], projects: [], sessions: [current], runs: [], pods: [],
  }));
  await flush();
  const slot = () => container.querySelector(".session-notice-slot") as HTMLElement | null;
  return {
    container,
    toasts,
    undos,
    slot,
    notices: () => [...container.querySelectorAll(".session-notice-slot .notice")] as HTMLElement[],
    button: (name: string) => [...(slot()?.querySelectorAll("button") ?? [])]
      .find((button) => button.textContent === name) as HTMLButtonElement | undefined,
    update: async (next: SessionView) => {
      await act(async () => socket.push({ type: "session_upsert", session: next }));
      await flush();
    },
    unmount: async () => {
      await flush(1);
      await act(async () => root.unmount());
      container.remove();
    },
  };
}

function describedText(root: ParentNode, button: HTMLElement): string[] {
  return (button.getAttribute("aria-describedby") ?? "").split(/\s+/u).filter(Boolean)
    .map((id) => root.querySelector(`#${id}`)?.textContent ?? "");
}

test("three conditions show one notice, the most severe, with the rest behind +2 More", async () => {
  const session = sessionView({
    historyQuarantine: quarantine,
    worktrees: [setupFailure],
    providerAccountSwitchFailure: accountFailure("Work"),
  });
  const fixture = await mount(session);
  try {
    assert.equal(fixture.notices().length, 1, "only one session notice is in the DOM");
    assert.equal(fixture.notices()[0]!.getAttribute("aria-label"), "Conversation Quarantined");
    assertNoDomNode(fixture.container.querySelector('[aria-label="Worktree Setup Failed"]'));
    assertNoDomNode(fixture.container.querySelector('[aria-label="Account Switch Failed"]'));

    const more = fixture.button("+2 More")!;
    assert.ok(more, "the others are counted in the title row");
    assert.ok(more.closest(".notice-head"), "+N More sits in the title row, not beside the body");
    assert.equal(more.getAttribute("aria-haspopup"), "menu");
    await act(async () => { more.click(); });
    const menu = domWindow.document.querySelector('[role="menu"][aria-label="Session Notices"]') as HTMLElement | null;
    assert.ok(menu, "+2 More opens a menu");
    const items = [...menu.querySelectorAll('[role="menuitem"]')] as HTMLButtonElement[];
    assert.deepEqual(items.map((item) => item.textContent), ["Worktree Setup Failed", "Account Switch Failed"],
      "the menu lists the others most severe first, each with its title");
    assert.ok(items.every((item) => item.querySelector(".menu-icon svg")), "each item carries its tone icon");

    await act(async () => { items[1]!.click(); });
    await flush();
    assert.equal(fixture.notices().length, 1);
    assert.equal(fixture.notices()[0]!.getAttribute("aria-label"), "Account Switch Failed", "the chosen condition shows");
    assert.ok(fixture.button("+2 More"), "the quarantine and the setup failure are now the others");
    assertNoDomNode(domWindow.document.querySelector('[aria-label="Session Notices"]'), "choosing closes the menu");

    // Resolving the setup failure changes the set of conditions: the slot returns to the most severe.
    await fixture.update({ ...session, updatedAt: 2, worktrees: [] });
    assert.equal(fixture.notices().length, 1);
    assert.equal(fixture.notices()[0]!.getAttribute("aria-label"), "Conversation Quarantined");
    assert.ok(fixture.button("+1 More"));
  } finally {
    await fixture.unmount();
  }
});

test("an invalid setup configuration shows only in the slot, ordered by severity, then rank (#2036)", async () => {
  const invalidConfig: NonNullable<SessionView["worktrees"]>[number] = {
    id: "worktree-two", path: worktreePath, branch: "agent/config", source: "created", baseCommit: "c".repeat(40),
    setupConfig: { status: "invalid", error: ".wollipog.json.version must be 1" },
  };
  // A failed setup is on another of the session's worktrees; the invalid configuration is on the
  // active one.
  const otherSetupFailure = { ...setupFailure, id: "worktree-three", path: "/repos/demo/other" };
  const session = sessionView({
    worktrees: [invalidConfig, otherSetupFailure],
    providerAccountSwitchFailure: accountFailure("Work"),
  });
  const fixture = await mount(session);
  const notice = () => fixture.container.querySelector('[aria-label="Invalid Worktree Setup Configuration"]');
  try {
    assert.equal(fixture.container.querySelectorAll(".notice").length, 1, "no banner renders outside the slot");
    assert.equal(fixture.notices()[0]!.getAttribute("aria-label"), "Worktree Setup Failed",
      "danger, rank 3, shows over danger, rank 4");
    await act(async () => { fixture.button("+2 More")!.click(); });
    const items = [...domWindow.document.querySelectorAll('[role="menu"] [role="menuitem"]')] as unknown as
      HTMLButtonElement[];
    assert.deepEqual(items.map((item) => item.textContent),
      ["Invalid Worktree Setup Configuration", "Account Switch Failed"], "danger before warning");
    await act(async () => { items[0]!.click(); });
    await flush();
    assert.equal(fixture.notices().length, 1);
    assert.equal(fixture.notices()[0], notice());

    // Without the setup failure it ranks first, over the warning.
    await fixture.update({ ...session, updatedAt: 2, worktrees: [invalidConfig] });
    assert.equal(fixture.container.querySelectorAll(".notice").length, 1);
    assert.equal(fixture.notices()[0], notice());
    assert.ok(fixture.button("+1 More"));
    assert.equal(notice()!.querySelector(".notice-body p")?.textContent,
      "Wollipog can’t read the setup configuration this worktree was created from, so its setup didn’t run.");
    assertNoDomNode(notice()!.querySelector("code"), "the configuration error waits behind Show Details");
    await act(async () => { fixture.button("Show Details")!.click(); });
    assert.equal(notice()!.querySelector(".notice-details-body .code-well code")?.textContent,
      ".wollipog.json.version must be 1");
  } finally {
    await fixture.unmount();
  }
});

test("campaign notices stay under the session bar, in order, outside the slot (#2036)", async () => {
  const orchestratorCampaign = {
    status: "blocked",
    policyRevision: 1,
    decisionOwners: {
      implementation_question: "orchestrator", pr_merge: "orchestrator", merged_branch_deletion: "orchestrator",
      follow_up_issue_publication: "orchestrator", ui_evidence_approval: "human",
    },
    limits: { maximumConcurrentChildren: 4, occupied: 1, remaining: 3, costBudgetUsd: null, maxToolCalls: null },
    uiEvidenceReview: { status: "available", effectiveOwner: "human" },
    children: { total: 1, active: 0, waitingHuman: 0, blocked: 1, verified: 0, cleanupPending: 0 },
    heldChildren: [{ sessionId: "held-child", holds: [{
      kind: "worktree_recovery", holdId: "hold-one", since: 1,
      reason: "The worktree is on the wrong branch.", recoveryAction: "Select the worktree again.",
    }] }],
    continuation: {
      state: "failed", pendingEvents: 2, continuationId: "campaign_cont_failed", commandId: "campaign_prompt_failed",
      eventFromSeq: 1, eventThroughSeq: 2, attemptCount: 3, updatedAt: 1, canRetry: true,
    },
    pendingDecisions: { human: 0, orchestrator: 0 },
    followUps: { unique: 0, duplicates: 0 },
  } as OrchestratorCampaignProjection;
  const fixture = await mount(sessionView({ orchestratorCampaign, worktrees: [setupFailure] }), {
    client: { descendantRequests: async () => ({ requests: [], blockedChildren: [] }) },
  });
  try {
    const continuation = fixture.container.querySelector('[aria-label="Campaign Continuation: Failed"]');
    const held = fixture.container.querySelector(".campaign-held-children");
    assert.ok(continuation && held, "both campaign notices render");
    assertNoDomNode(continuation.closest(".session-notice-slot"), "Campaign Continuation is not a slot entry");
    assertNoDomNode(held.closest(".session-notice-slot"), "Held Children is not a slot entry");
    assert.ok(continuation.compareDocumentPosition(held) & domWindow.Node.DOCUMENT_POSITION_FOLLOWING,
      "Campaign Continuation comes first");
    assert.ok(held.compareDocumentPosition(fixture.slot()!) & domWindow.Node.DOCUMENT_POSITION_FOLLOWING,
      "both sit above the transcript and the slot");
    assert.equal(fixture.notices().length, 1);
    assert.equal(fixture.notices()[0]!.getAttribute("aria-label"), "Worktree Setup Failed");
    assertNoDomNode(fixture.container.querySelector(".session-notice-more"), "campaign notices are not counted");
  } finally {
    await fixture.unmount();
  }
});

test("a single condition shows no +N More", async () => {
  const fixture = await mount(sessionView({ worktrees: [setupFailure] }));
  try {
    assert.equal(fixture.notices().length, 1);
    assertNoDomNode(fixture.container.querySelector(".session-notice-more"));
  } finally {
    await fixture.unmount();
  }
});

test("Account Switch Failed offers Switch Account… and names a plain label", async () => {
  const fixture = await mount(sessionView({ providerAccountSwitchFailure: accountFailure("Work") }), {
    client: { sessionProviderAccounts: async () => ({ accounts: [] }) } as Partial<ApiClient>,
  });
  try {
    const notice = fixture.notices()[0]!;
    assert.ok(notice.classList.contains("t-warning"), "the tone matches the Account Required badge");
    assert.equal(notice.querySelector(".notice-body")?.textContent,
      "Wollipog couldn’t continue with Work. The provider conversation cannot be resumed under another account.");
    assert.doesNotMatch(notice.textContent ?? "", /queued/i, "the notice does not promise queued messages move (#1668)");
    assert.ok(notice.querySelector('.notice-head button[aria-label="Dismiss Notice"]'), "Dismiss stays, in the title row");
    const switchAccount = fixture.button("Switch Account…")!;
    assert.ok(switchAccount);
    assert.equal(switchAccount.disabled, false);
    await act(async () => { switchAccount.click(); });
    await flush();
    const dialog = domWindow.document.querySelector('[role="dialog"]');
    assert.ok(dialog, "Switch Account… opens the Switch Account dialog");
    assert.match(dialog.textContent ?? "", /Switch Account/);
    assert.match(dialog.textContent ?? "", /Continue this conversation with another Codex account on Build Box\./,
      "the dialog names the provider and the session's machine");
  } finally {
    await fixture.unmount();
  }
});

test("an email-shaped account label is never inlined, masked or not", async () => {
  const fixture = await mount(sessionView({
    providerAccountSwitchFailure: {
      ...accountFailure("ada@example.com"),
      reason: "ada@example.com has no usage headroom",
    },
  }));
  try {
    const notice = fixture.notices()[0]!;
    assert.equal(notice.querySelector(".notice-body")?.textContent,
      "Wollipog couldn’t continue with the selected account. The selected account has no usage headroom.");
    assertNoDomNode(notice.querySelector(".pid"), "no masked identifier");
    assertNoDomNode(notice.querySelector(".pid-toggle"), "no reveal button");
    assert.doesNotMatch(notice.textContent ?? "", /••••|@/u);
  } finally {
    await fixture.unmount();
  }
});

test("Retry Setup keeps its label and shows a spinner while pending", async () => {
  let settle: (() => void) | undefined;
  const session = sessionView({ worktrees: [setupFailure] });
  const fixture = await mount(session, {
    client: {
      retryWorktreeSetup: () => new Promise((resolve) => {
        settle = () => resolve({ session: { ...session, worktrees: [] } });
      }),
    } as Partial<ApiClient>,
  });
  try {
    const notice = fixture.notices()[0]!;
    assert.equal(notice.querySelector(".notice-body")?.textContent,
      "Install Dependencies exited with 1. The worktree was kept.");
    const retry = fixture.button("Retry Setup")!;
    await act(async () => { retry.click(); });
    assert.equal(retry.textContent, "Retry Setup", "the label does not change");
    assert.equal(retry.getAttribute("aria-busy"), "true");
    assert.ok(retry.querySelector(".spinner, [data-spinner], svg"), "a spinner is shown in the button");
    assert.equal(retry.getAttribute("data-busy-spinner"), "prepended");
    await act(async () => { settle!(); });
    await flush();
  } finally {
    await fixture.unmount();
  }
});

test("with the runner offline, every disabled action has a visible reason naming the machine", async () => {
  const session = sessionView({
    historyQuarantine: quarantine,
    worktrees: [setupFailure],
    providerAccountSwitchFailure: accountFailure("Work"),
  });
  const fixture = await mount(session, { online: false });
  try {
    const conditions = ["Conversation Quarantined", "Worktree Setup Failed", "Account Switch Failed"];
    const actions = ["Recover Session", "Retry Setup", "Switch Account…"];
    for (const [index, condition] of conditions.entries()) {
      if (index > 0) {
        const more = fixture.container.querySelector(".session-notice-more") as HTMLButtonElement;
        await act(async () => { more.click(); });
        const item = ([...domWindow.document.querySelectorAll('[role="menuitem"]')] as unknown as HTMLButtonElement[])
          .find((candidate) => candidate.textContent === condition)!;
        await act(async () => { item.click(); });
        await flush();
      }
      assert.equal(fixture.notices()[0]!.getAttribute("aria-label"), condition);
      const action = fixture.button(actions[index]!)!;
      assert.equal(action.disabled, true, `${actions[index]} is unavailable offline`);
      const reasons = describedText(fixture.container, action);
      assert.deepEqual(reasons, ["Build Box is offline."], `${actions[index]} is described by the reason`);
      const line = fixture.container.querySelector(`#${action.getAttribute("aria-describedby")}`) as HTMLElement;
      assert.ok(line.closest(".notice-body"), "the reason is a visible line in the notice");
    }
  } finally {
    await fixture.unmount();
  }
});

test("a worktree selection still running keeps recovery refused after showing another notice", async () => {
  let settle: (() => void) | undefined;
  const selections: string[] = [];
  const session = sessionView({
    historyQuarantine: quarantine,
    worktreeRecovery: {
      recoveryId: "recovery-select", detectedAt: 3, selectedPath: worktreePath, expectedBranch: "agent/setup",
      detail: "The selected worktree is missing.",
    },
    worktrees: [{ id: "other", path: "/repos/demo/other", branch: "agent/other", source: "created" }],
  });
  const fixture = await mount(session, {
    client: {
      sessionWorktreeOperations: async () => ({ operations: [] }),
      selectSessionWorktree: (_id: string, path: string) => {
        selections.push(path);
        return new Promise((resolve) => { settle = () => resolve({ session }); });
      },
    } as unknown as Partial<ApiClient>,
  });
  const choose = async (title: string) => {
    await act(async () => { (fixture.container.querySelector(".session-notice-more") as HTMLButtonElement).click(); });
    const item = ([...domWindow.document.querySelectorAll('[role="menuitem"]')] as unknown as HTMLButtonElement[])
      .find((candidate) => candidate.textContent === title)!;
    await act(async () => { item.click(); });
    await flush();
  };
  const actions = () => [...fixture.container.querySelectorAll(".worktree-missing-row button.btn")] as HTMLButtonElement[];
  const unavailable = (button: HTMLButtonElement) => button.disabled || button.getAttribute("aria-disabled") === "true";
  const useExisting = async () => {
    const radio = [...fixture.container.querySelectorAll('[role="radio"]')]
      .find((candidate) => candidate.textContent === "Use Existing") as HTMLButtonElement;
    await act(async () => { radio.click(); });
  };
  try {
    await flush(5);
    await useExisting();
    await act(async () => { actions().find((button) => button.textContent === "Use Worktree")!.click(); });
    assert.deepEqual(selections, ["/repos/demo/other"]);
    await choose("Conversation Quarantined");
    await choose("Worktree Missing");
    assert.equal(actions().find((button) => button.textContent === "Use Worktree")?.getAttribute("aria-busy"), "true",
      "the notice comes back on the chosen path, still showing the running selection");
    assert.ok(actions().every(unavailable), "no second selection while the first runs");
    const radios = [...fixture.container.querySelectorAll('[role="radio"]')] as HTMLButtonElement[];
    await act(async () => { radios.find((radio) => radio.textContent === "Create New")!.click(); });
    assert.ok(actions().every(unavailable), "and no create either");
    await useExisting();
    await act(async () => { settle!(); });
    await flush();
    assert.ok(actions().every((button) => !unavailable(button)), "the actions return once the selection settles");
  } finally {
    await fixture.unmount();
  }
});

test("a worktree selection that fails while another notice shows still says why", async () => {
  let fail: ((error: Error) => void) | undefined;
  const session = sessionView({
    historyQuarantine: quarantine,
    worktreeRecovery: {
      recoveryId: "recovery-select-fail", detectedAt: 3, selectedPath: worktreePath, expectedBranch: "agent/setup",
      detail: "The selected worktree is missing.",
    },
    worktrees: [{ id: "other", path: "/repos/demo/other", branch: "agent/other", source: "created" }],
  });
  const fixture = await mount(session, {
    client: {
      sessionWorktreeOperations: async () => ({ operations: [] }),
      selectSessionWorktree: () => new Promise((_resolve, reject) => { fail = reject; }),
    } as unknown as Partial<ApiClient>,
  });
  const choose = async (title: string) => {
    await act(async () => { (fixture.container.querySelector(".session-notice-more") as HTMLButtonElement).click(); });
    const item = ([...domWindow.document.querySelectorAll('[role="menuitem"]')] as unknown as HTMLButtonElement[])
      .find((candidate) => candidate.textContent === title)!;
    await act(async () => { item.click(); });
    await flush();
  };
  const actions = () => [...fixture.container.querySelectorAll(".worktree-missing-row button.btn")] as HTMLButtonElement[];
  const unavailable = (button: HTMLButtonElement) => button.disabled || button.getAttribute("aria-disabled") === "true";
  const useExisting = async () => {
    const radio = [...fixture.container.querySelectorAll('[role="radio"]')]
      .find((candidate) => candidate.textContent === "Use Existing") as HTMLButtonElement;
    await act(async () => { radio.click(); });
  };
  try {
    await flush(5);
    await useExisting();
    await act(async () => { actions().find((button) => button.textContent === "Use Worktree")!.click(); });
    await choose("Conversation Quarantined");
    await act(async () => { fail!(new Error("That worktree is not linked to this session.")); });
    await flush();
    await choose("Worktree Missing");
    const alert = fixture.container.querySelector('.session-notice-slot [role="alert"]');
    assert.equal(alert?.textContent, "That worktree is not linked to this session.");
    assert.ok(actions().every((button) => !unavailable(button)), "the person can try again");

    // A later incident starts without the earlier failure.
    await fixture.update({
      ...session,
      updatedAt: 2,
      worktreeRecovery: { ...session.worktreeRecovery!, recoveryId: "recovery-select-fail-2", detectedAt: 4 },
    });
    assertNoDomNode(fixture.container.querySelector('.session-notice-slot [role="alert"]'),
      "the new recovery shows no failure from the old one");
  } finally {
    await fixture.unmount();
  }
});

test("a missing worktree ranks first and renders the recovery card in the slot", async () => {
  const fixture = await mount(sessionView({
    historyQuarantine: quarantine,
    worktreeRecovery: {
      recoveryId: "recovery-1", detectedAt: 3, selectedPath: worktreePath, expectedBranch: "agent/setup",
      detail: "The selected worktree is missing.",
    },
  }), { online: false });
  try {
    assert.equal(fixture.notices().length, 1);
    const card = fixture.notices()[0]!;
    assert.equal(card.getAttribute("aria-label"), "Worktree Missing");
    assert.ok(fixture.button("+1 More"));
    const offline = "Build Box is offline, so the worktree can't be recovered until it reconnects.";
    assert.match(card.textContent ?? "", new RegExp(offline.replace(/\./gu, "\\.")), "the reason names the machine");
    const actions = [...card.querySelectorAll(".worktree-missing-row button.btn")];
    assert.equal(actions.length, 1);
    for (const action of actions) {
      assert.ok(describedText(fixture.container, action as HTMLElement).includes(offline));
    }
  } finally {
    await fixture.unmount();
  }
});

// #2037: the composer says why it cannot send by naming the condition the slot shows first, and
// Edit as a New Turn says the same.
async function mountWithMessage(session: SessionView, online = true) {
  const fixture = await mount(session, { online, events: [{ kind: "user_message", text: "original prompt", images: [] }] });
  const composer = () => fixture.container.querySelector(".composer-box textarea") as HTMLTextAreaElement;
  const resendReason = async () => {
    const edit = await readTranscriptAction(fixture.container, "More Message Actions", "Edit as a New Turn");
    assert.ok(edit?.disabled, "Edit as a New Turn stays listed, unavailable");
    return edit.reason;
  };
  return { ...fixture, composer, resendReason };
}

test("with a quarantined conversation and a failed account switch, the composer names the quarantine", async () => {
  const session = sessionView({ historyQuarantine: quarantine, providerAccountSwitchFailure: accountFailure("Work") });
  const fixture = await mountWithMessage(session);
  try {
    assert.equal(fixture.notices()[0]!.getAttribute("aria-label"), "Conversation Quarantined");
    const quarantined = "Conversation quarantined. Recover this session to continue.";
    assert.equal(fixture.composer().placeholder, quarantined, "the placeholder names the notice the slot shows");
    assert.equal(fixture.composer().disabled, true);
    assert.ok((await fixture.resendReason())?.endsWith(quarantined), "Edit as a New Turn states the same reason");

    // Once the quarantine resolves, both surfaces move to the account switch together.
    await fixture.update({ ...session, updatedAt: 2, historyQuarantine: undefined });
    assert.equal(fixture.notices()[0]!.getAttribute("aria-label"), "Account Switch Failed");
    const chooseAccount = "Choose another account before sending another message.";
    assert.equal(fixture.composer().placeholder, chooseAccount);
    assert.ok((await fixture.resendReason())?.endsWith(chooseAccount));
  } finally {
    await fixture.unmount();
  }
});

test("with a missing worktree and a quarantined conversation, the composer names the missing worktree", async () => {
  const fixture = await mountWithMessage(sessionView({
    historyQuarantine: quarantine,
    providerAccountSwitchFailure: accountFailure("Work"),
    worktreeRecovery: {
      recoveryId: "recovery-order", detectedAt: 3, selectedPath: worktreePath, expectedBranch: "agent/setup",
      detail: "The selected worktree is missing.",
    },
  }));
  try {
    assert.equal(fixture.notices()[0]!.getAttribute("aria-label"), "Worktree Missing");
    const recovery = "Worktree recovery is required before sending another message.";
    assert.equal(fixture.composer().placeholder, recovery);
    assert.ok((await fixture.resendReason())?.endsWith(recovery));
  } finally {
    await fixture.unmount();
  }
});

test("reasons that are not slot conditions keep their place around the slot's", async () => {
  const offline = await mountWithMessage(sessionView({
    historyQuarantine: quarantine, providerAccountSwitchFailure: accountFailure("Work"),
  }), false);
  try {
    assert.equal(offline.composer().placeholder, "Build Box is offline. You can send again when it reconnects.",
      "an offline runner still comes first");
  } finally {
    await offline.unmount();
  }
  const paused = await mountWithMessage(sessionView({
    historyQuarantine: quarantine,
    pendingApproval: { requestId: "budget-1", kind: "cost_budget", title: "Cost Budget Reached", options: [] },
  }));
  try {
    assert.equal(paused.composer().placeholder, "Conversation quarantined. Recover this session to continue.",
      "a guardrail pause still comes after the slot's conditions");
  } finally {
    await paused.unmount();
  }
});

// #2202: an archived session that has stopped says so in the slot, with the way back.

test("an archived session shows Session Archived with Unarchive and Restart, and the composer points to it", async () => {
  const unarchived: string[] = [];
  const session = sessionView({ status: "stopped", archived: true });
  const fixture = await mount(session, {
    unarchiveAndRestart: true,
    client: { unarchiveAndRestart: async (id: string) => { unarchived.push(id); return { ...session, archived: false, status: "starting" }; } },
  });
  try {
    const notice = fixture.notices()[0]!;
    assert.equal(fixture.notices().length, 1);
    assert.equal(notice.getAttribute("aria-label"), "Session Archived");
    assert.equal(notice.querySelector(".notice-title")?.textContent, "Session Archived");
    assert.equal(notice.querySelector(".notice-body")?.textContent, "This session is archived and stopped.");
    assert.ok(notice.classList.contains("t-info"));
    assertNoDomNode(notice.querySelector(".notice-dismiss"), "the way back is not dismissible");
    const composer = fixture.container.querySelector(".composer-box textarea") as HTMLTextAreaElement;
    assert.equal(composer.placeholder, "Unarchive the session to send a message.");
    assert.equal(composer.disabled, true);

    const action = fixture.button("Unarchive and Restart")!;
    assert.ok(action, "the control plane's one operation is offered");
    assert.equal(action.disabled, false);
    await act(async () => {
      action.focus();
      action.click();
    });
    await flush();
    assert.deepEqual(unarchived, [session.id]);
    assert.deepEqual(fixture.toasts, ["Session restored and restarting."]);

    // The restored session's notice leaves with the focused button; focus goes to the composer.
    await fixture.update({ ...session, updatedAt: 2, archived: false, status: "starting" });
    assertNoDomNode(fixture.slot());
    assert.ok(domWindow.document.activeElement === (composer as never), "focus moves to the composer, not <body>");
  } finally {
    await fixture.unmount();
  }
});

test("an older control plane offers a plain Unarchive, with Undo", async () => {
  const calls: Array<[string, boolean]> = [];
  const session = sessionView({ status: "completed", archived: true });
  const fixture = await mount(session, {
    client: { setArchived: async (id: string, archived: boolean) => { calls.push([id, archived]); return { ...session, archived }; } },
  });
  try {
    assert.equal(fixture.button("Unarchive and Restart"), undefined);
    await act(async () => fixture.button("Unarchive")!.click());
    await flush();
    assert.deepEqual(calls, [[session.id, false]]);
    assert.deepEqual(fixture.undos, ["Session restored."]);
  } finally {
    await fixture.unmount();
  }
});

test("a Viewer sees Session Archived with the action disabled and a visible reason", async () => {
  const refusal = "Only the session's owner or an admin can unarchive it.";
  const fixture = await mount(sessionView({
    status: "stopped",
    archived: true,
    commandPermissions: {
      stop: { allowed: false, reason: "No." },
      restart: { allowed: false, reason: "No." },
      stopBackgroundJob: { allowed: false, reason: "No." },
      unarchive: { allowed: false, reason: refusal },
    },
  }), { unarchiveAndRestart: true });
  try {
    const action = fixture.button("Unarchive and Restart")!;
    assert.equal(action.disabled, true);
    assert.deepEqual(describedText(fixture.container, action), [refusal]);
    assert.ok(fixture.notices()[0]!.textContent?.includes(refusal), "the reason is visible, not only a tooltip");
  } finally {
    await fixture.unmount();
  }
});

test("an archived session's notice waits behind a more severe one, and the composer names that one", async () => {
  const fixture = await mount(sessionView({ status: "stopped", archived: true, historyQuarantine: quarantine }));
  try {
    assert.equal(fixture.notices()[0]!.getAttribute("aria-label"), "Conversation Quarantined");
    assert.ok(fixture.button("+1 More"));
    const composer = fixture.container.querySelector(".composer-box textarea") as HTMLTextAreaElement;
    assert.equal(composer.placeholder, "Conversation quarantined. Recover this session to continue.");
  } finally {
    await fixture.unmount();
  }
});

test("an archive whose Stop failed keeps its Stop recovery, not Session Archived", async () => {
  const fixture = await mount(sessionView({ status: "running", archived: true, archiveStatus: "stop_failed" }));
  try {
    assert.equal(fixture.notices().some((notice) => notice.getAttribute("aria-label") === "Session Archived"), false);
  } finally {
    await fixture.unmount();
  }
});

test("a hidden Session Archived resolving under the shown notice's +1 More keeps focus in the slot", async () => {
  const session = sessionView({ status: "stopped", archived: true, historyQuarantine: quarantine });
  const fixture = await mount(session);
  try {
    const more = fixture.button("+1 More")!;
    await act(async () => more.focus());
    assert.ok(domWindow.document.activeElement === (more as never));
    // Restored elsewhere: the archived entry resolves and the trigger it gave the quarantine goes.
    await fixture.update({ ...session, updatedAt: 2, archived: false });
    assert.equal(fixture.button("+1 More"), undefined);
    const active = domWindow.document.activeElement as unknown as HTMLElement;
    assert.ok(active !== (domWindow.document.body as never), "focus does not fall to <body>");
    assert.ok(fixture.slot()?.contains(active), "focus stays in the slot");
  } finally {
    await fixture.unmount();
  }
});

test("a plain Unarchive leaves the composer stopped, so focus goes to the page title", async () => {
  const session = sessionView({ status: "stopped", archived: true });
  const fixture = await mount(session, { client: { setArchived: async (_id: string, archived: boolean) => ({ ...session, archived }) } });
  try {
    const action = fixture.button("Unarchive")!;
    await act(async () => {
      action.focus();
      action.click();
    });
    await flush();
    await fixture.update({ ...session, updatedAt: 2, archived: false });
    assertNoDomNode(fixture.slot());
    const title = domWindow.document.getElementById("page-title");
    assert.ok(title, "the session bar owns the page title");
    assert.ok(domWindow.document.activeElement === (title as never), "focus moves to the page title, not <body>");
  } finally {
    await fixture.unmount();
  }
});

test("clicking away from the slot is a choice, so a later resolution does not pull focus back", async () => {
  const session = sessionView({ status: "stopped", archived: true, historyQuarantine: quarantine });
  const fixture = await mount(session);
  try {
    const more = fixture.button("+1 More")!;
    await act(async () => more.focus());
    await act(async () => more.blur());
    await fixture.update({ ...session, updatedAt: 2, archived: false });
    assert.ok(domWindow.document.activeElement === (domWindow.document.body as never), "focus stays where the person left it");
  } finally {
    await fixture.unmount();
  }
});
