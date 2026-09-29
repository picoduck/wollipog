/**
 * #1966: a session in several problem states at once shows one notice above the composer — the most
 * severe — and lists the rest behind "+N More", rather than stacking a banner for each.
 */

import assert from "node:assert/strict";
import test from "node:test";
import React, { act } from "react";
import { createRoot } from "react-dom/client";
import { Window } from "happy-dom";
import type { ControlPlaneToUi, RunnerView, SessionView } from "@wollipog/protocol";
import { api, type ApiClient } from "../api.js";
import { ApiProvider } from "../api-context.js";
import type { ViewNavigation } from "../navigation.js";
import { StoreProvider } from "../store.js";
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

async function mount(current: SessionView, { online = true, client: overrides = {} }: {
  online?: boolean;
  client?: Partial<ApiClient>;
} = {}) {
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
      <FeedbackContext.Provider value={{ confirm: async () => true, showToast: () => 0, dismissToast: () => {} } as never}>
        <StoreProvider connection={connection} navigation={navigation}>
          <SessionDetail sessionId={current.id} mode="expanded" rightPanel={rightPanel}
            onOpenTerminal={() => {}} pinnedOpen={false} composerDraftLoader={async () => null} />
        </StoreProvider>
      </FeedbackContext.Provider>
    </ApiProvider>,
  ));
  await act(async () => socket.push({
    type: "snapshot",
    capabilities: { sessionSubscriptions: false, boundedDelivery: false, paginatedSessionHistory: false, projects: true },
    runners: [runnerView(online)], boxes: [], projects: [], sessions: [current], runs: [], pods: [],
  }));
  await flush();
  const slot = () => container.querySelector(".session-notice-slot") as HTMLElement | null;
  return {
    container,
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
    assert.match(dialog.textContent ?? "", /another subscription account on this Machine/);
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
  const actions = () => [...fixture.container.querySelectorAll(".worktree-recovery-controls button.btn")] as HTMLButtonElement[];
  try {
    await flush(5);
    await act(async () => { actions().find((button) => button.textContent === "Select Worktree")!.click(); });
    assert.deepEqual(selections, ["/repos/demo/other"]);
    await choose("Conversation Quarantined");
    await choose("Worktree Recovery Required");
    assert.ok(actions().every((button) => button.disabled), "no second selection or create while the first runs");
    assert.ok(actions().some((button) => button.textContent === "Selecting…"));
    await act(async () => { settle!(); });
    await flush();
    assert.ok(actions().every((button) => !button.disabled), "the actions return once the selection settles");
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
    assert.equal(card.getAttribute("aria-label"), "Worktree Recovery Required");
    assert.ok(fixture.button("+1 More"));
    for (const action of card.querySelectorAll(".worktree-recovery-controls button.btn")) {
      assert.ok(describedText(fixture.container, action as HTMLElement).includes("Build Box is offline."));
    }
  } finally {
    await fixture.unmount();
  }
});
