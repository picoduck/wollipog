import assert from "node:assert/strict";
import test from "node:test";
import React, { act } from "react";
import { createRoot } from "react-dom/client";
import { Window } from "happy-dom";
import type { ControlPlaneToUi, GitStatusInfo, GitSummaryInfo, ProjectView, RunnerView, SessionView } from "@wollipog/protocol";
import { api, type ApiClient } from "../api.js";
import { ApiProvider } from "../api-context.js";
import type { ViewNavigation } from "../navigation.js";
import { StoreProvider } from "../store.js";
import { UI_SOCKET_OPEN, type UiConnectionRuntime, type UiSocket } from "../ui-transport.js";
import { FeedbackContext } from "./FeedbackProvider.js";
import { SessionDetail } from "./SessionDetail.js";
import { installDomTestCleanup } from "../dom-test-cleanup.js";
import { assertNoDomNode } from "../dom-test-assertions.js";
import { staticPinnedSummary } from "./pinned-summary-state.js";

/**
 * #2160: the session bar carries the session's status and nothing else; the account, the branch,
 * the pull request and the changes are facts, and the Pinned Summary states each of them once.
 */

const domWindow = new Window({ url: "http://localhost/" });
domWindow.localStorage.setItem("wollipog.hide-account-emails", "true");
installDomTestCleanup(domWindow);
Object.defineProperty(domWindow.Element.prototype, "getBoundingClientRect", {
  configurable: true,
  value: () => ({ x: 0, y: 0, top: 0, left: 0, right: 1200, bottom: 72, width: 1200, height: 72, toJSON: () => ({}) }),
});
let phone = false;
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
// A phone is the 760px media query; everything else in this file renders the desktop bar.
Object.defineProperty(domWindow, "matchMedia", {
  configurable: true,
  value: (query: string) => ({
    get matches() { return phone && query === "(max-width: 760px)"; },
    media: query,
    addEventListener() {},
    removeEventListener() {},
    addListener() {},
    removeListener() {},
  }),
});

const EMAIL = "pat.example@example.com";
const BRANCH = "fix/a-long-branch-for-the-pinned-summary";
const PR_URL = "https://github.com/picoduck/wollipog/pull/2160";
const TITLE = "Pinned Summary Facts";

const runner = {
  runnerId: "runner-facts", hostname: "build-host", displayName: "Build Box", os: "linux", version: "1", status: "online",
  agents: [{ id: "codex", name: "Codex", command: "codex", args: [], env: {}, driver: "codex", available: true }],
  workspaces: [], connectedAt: 1, lastSeen: 1, protocolVersion: 146,
} as RunnerView;

const project = {
  id: "payments", name: "Payments Service", hidden: false, locations: [], activeSessionCount: 0,
  unarchivedSessionCount: 1, totalSessionCount: 1, createdAt: 1, updatedAt: 1,
} as ProjectView;

const session = {
  id: "facts", runnerId: runner.runnerId, workspaceId: null, workspaceName: null, projectId: project.id,
  projectName: project.name, agentId: "codex", agentName: "Codex", title: TITLE, status: "idle", column: "review",
  runId: null, useWorktree: true, worktreePath: "/worktrees/facts",
  worktrees: [{
    id: "wt-facts", path: "/worktrees/facts", branch: BRANCH, baseRef: "origin/main", source: "created",
    pullRequest: { url: PR_URL, state: "open", kind: "pull_request" },
  }],
  providerAccountId: "acct", providerAccountLabel: EMAIL, providerAccountAutomaticallySelected: true,
  backgroundWorkTracking: "untracked",
  archived: false, createdAt: 1, updatedAt: 1,
  lastEventAt: null, messageCount: 0, eventEpoch: 0, preview: null, pendingApproval: null,
  driver: "codex", model: "gpt-5.6-sol", effort: "high", permissionMode: null,
  tokensIn: 0, tokensOut: 0, costUsd: 0, adopted: false,
} as SessionView;

const status: GitStatusInfo = {
  branch: BRANCH, files: [], hasChanges: true, ahead: 2, remoteUrl: "git@github.com:picoduck/wollipog.git",
  headSha: "abcdef1234567890", detached: false, upstreamBranch: `origin/${BRANCH}`, aheadUpstream: 2, behindUpstream: 0,
  baseRef: "origin/main", worktreeKind: "linked", stagedCount: 0, modifiedCount: 2, untrackedCount: 0, conflictedCount: 0,
  operation: null, remoteRefsAt: 1_700_000_000_000, addedLines: 9, deletedLines: 3,
};
const summary: GitSummaryInfo = {
  ...status, behind: 0, addedLines: 9, deletedLines: 3,
  pr: { number: 2160, title: "Rebuild the Pinned Summary", url: PR_URL, state: "OPEN", provider: "github", kind: "pull_request" },
  checks: null,
};

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

async function withSession(
  options: { phone: boolean; runner?: Partial<RunnerView>; gitNeverSettles?: boolean; session?: Partial<SessionView> },
  run: (container: HTMLDivElement) => Promise<void>,
) {
  phone = options.phone;
  const socket = new FakeSocket();
  const client = {
    ...api,
    session: () => new Promise<never>(() => {}),
    getSessionEventPage: () => new Promise<never>(() => {}),
    getSessionEventTailPage: () => new Promise<never>(() => {}),
    git: options.gitNeverSettles ? () => new Promise<never>(() => {}) : async () => ({ status }),
    gitSummary: options.gitNeverSettles ? () => new Promise<never>(() => {}) : async () => ({ summary }),
    runnerSkills: async () => ({ desired: [], reported: null }),
  } as unknown as ApiClient;
  const connection: UiConnectionRuntime = {
    instanceId: "facts-test", runtimeKey: "facts-test:1", createSocket: () => socket, close() {},
  };
  const navigation: ViewNavigation = {
    current: () => ({ name: "session", id: session.id }), push: () => {}, listen: () => () => {},
  };
  const rightPanel = {
    open: false, mode: "launcher" as const, width: 360, dragging: false, subagentTarget: null,
    toggle() {}, openMode() {}, show() {}, setMode() {}, setWidth() {}, setDragging() {},
    close() {}, selectSubagent() {}, showSubagent() {}, consumeSubagentFocusRequest() {},
  };
  const container = domWindow.document.createElement("div") as unknown as HTMLDivElement;
  domWindow.document.body.append(container as never);
  const root = createRoot(container);
  try {
    await act(async () => root.render(
      <ApiProvider client={client}>
        <FeedbackContext.Provider value={{ confirm: async () => true, showToast: () => 0, dismissToast: () => {} } as never}>
          <StoreProvider connection={connection} navigation={navigation}>
            <SessionDetail sessionId={session.id} mode="expanded" rightPanel={rightPanel}
              onOpenTerminal={() => {}} pinnedSummary={staticPinnedSummary(true)} composerDraftLoader={async () => null} />
          </StoreProvider>
        </FeedbackContext.Provider>
      </ApiProvider>,
    ));
    await act(async () => socket.push({
      type: "snapshot",
      capabilities: { sessionSubscriptions: false, boundedDelivery: false, paginatedSessionHistory: false, projects: true },
      runners: [{ ...runner, ...options.runner }], boxes: [], projects: [project], sessions: [{ ...session, ...options.session }], runs: [], pods: [],
    } as ControlPlaneToUi));
    await settle();
    await settle();
    await run(container);
  } finally {
    await act(async () => root.unmount());
    container.remove();
    phone = false;
  }
}

/** The session bar: the element holding the session's own actions. */
function sessionBar(container: HTMLElement): HTMLElement {
  const moreActions = [...container.querySelectorAll<HTMLButtonElement>("button")]
    .find((button) => button.getAttribute("aria-label") === "More Actions");
  assert.ok(moreActions, "the session bar renders");
  const bar = moreActions.closest<HTMLElement>(".session-bar");
  assert.ok(bar, "More Actions sits in the session bar");
  return bar;
}

function assertBarHasNoFacts(bar: HTMLElement) {
  const text = bar.textContent ?? "";
  assert.doesNotMatch(text, new RegExp(BRANCH.replace(/[/-]/g, "\\$&")), "no branch");
  assert.doesNotMatch(text, /Open PR|Pull Request|#2160/, "no pull request");
  assert.doesNotMatch(text, /Changes Present|Ready for Review|Uncommitted Changes/, "no change status");
  assert.doesNotMatch(text, /Detached Work/, "no untracked-provider flag");
  assert.doesNotMatch(text, /Email Hidden|Auto:/, "no account");
  assert.doesNotMatch(bar.innerHTML, /example\.com/, "the account never reaches the bar's DOM");
  assertNoDomNode(bar.querySelector(`a[href="${PR_URL}"]`), "no pull request link");
  assertNoDomNode(bar.querySelector(".pid, .pid-toggle, .tag-wt, .change-status-indicators"), "no fact chips");
}

for (const width of [{ phone: false, name: "desktop" }, { phone: true, name: "phone" }]) {
  test(`the ${width.name} session bar holds no account, branch, pull request, changes or detached-work fact`, async () => {
    await withSession({ phone: width.phone }, async (container) => {
      // The phone bar is the app bar's second line, without the desktop detail bar's geometry.
      assert.equal(sessionBar(container).classList.contains("detail-bar"), !width.phone, `renders the ${width.name} bar`);
      assertBarHasNoFacts(sessionBar(container));
    });
  });
}

test("the Pinned Summary states the account, branch, pull request and changes once, and never the title or project", async () => {
  await withSession({ phone: false }, async (container) => {
    const summaryAside = container.querySelector<HTMLElement>('aside.ps[aria-label="Pinned Summary"]');
    assert.ok(summaryAside, "the summary is docked open");
    const heads = [...summaryAside.querySelectorAll(".ps-head > h3")].map((heading) => heading.textContent);
    assert.deepEqual(heads, ["Session", "Environment", "Git"]);
    const rows = [...summaryAside.querySelectorAll<HTMLElement>(".ps-row")];
    const row = (label: string) => rows.find((candidate) => candidate.querySelector(":scope > .k")?.textContent === label);
    const value = (label: string) => row(label)?.querySelector(":scope > .v")?.textContent;

    // Account: masked until revealed, never in the DOM while masked, chosen automatically as meta.
    const account = row("Account");
    assert.ok(account, "an Account row");
    assert.match(account.textContent ?? "", /Email Hidden/);
    assert.doesNotMatch(summaryAside.innerHTML, /example\.com/, "a masked account is not in the DOM");
    assert.equal(account.querySelector(".ps-note")?.textContent, "Chosen Automatically");
    const reveal = account.querySelector<HTMLButtonElement>("button.pid-toggle");
    assert.equal(reveal?.getAttribute("aria-label"), "Show Account Email");
    assert.ok(reveal?.classList.contains("icon-btn") && reveal.classList.contains("sm"));
    await act(async () => reveal!.click());
    assert.match(account.textContent ?? "", new RegExp(EMAIL.replace(/\./g, "\\.")));

    assert.equal(value("Background Work"), "Not Tracked", "untracked detached work is a Session fact");
    assert.equal(row("Background Work")?.tagName, "BUTTON", "it opens Background Work");

    // Git: the branch with its folder kind, the changes, and the pull request with its state.
    assert.equal(value(BRANCH), "Worktree");
    assert.equal(value("Changes"), "+9 −3");
    assert.equal(row("Changes")?.tagName, "BUTTON", "Changes opens Review");
    const pr = row("Rebuild the Pinned Summary");
    assert.equal(pr?.tagName, "A");
    assert.equal(pr?.getAttribute("href"), PR_URL);
    assert.equal(value("Rebuild the Pinned Summary"), "Open");
    for (const fact of [BRANCH, "Changes", "Rebuild the Pinned Summary", "Account"]) {
      assert.equal(rows.filter((candidate) => candidate.querySelector(":scope > .k")?.textContent === fact).length, 1,
        `${fact} is stated once`);
    }

    // No row repeats the session's title or its project, and the Workspace row and "+" are gone.
    for (const candidate of rows) {
      for (const part of candidate.querySelectorAll(":scope > .k, :scope > .v")) {
        assert.notEqual(part.textContent, TITLE);
        assert.notEqual(part.textContent, project.name);
      }
    }
    assert.equal(row("Workspace"), undefined);
    assert.equal(summaryAside.querySelector("button[disabled]")?.textContent === "+", false);
  });
});

test("a legacy runner with no Git read names the session record's branch, not a made-up one", async () => {
  await withSession({ phone: false, runner: { protocolVersion: 75 }, gitNeverSettles: true }, async (container) => {
    const summaryAside = container.querySelector<HTMLElement>('aside.ps[aria-label="Pinned Summary"]');
    assert.ok(summaryAside);
    const labels = [...summaryAside.querySelectorAll(".ps-row > .k")].map((label) => label.textContent);
    assert.ok(labels.includes(BRANCH), `the recorded branch is shown (${labels.join(", ")})`);
    assert.ok(!labels.includes(`agent/${session.id}`), "no synthetic branch name");
  });
});

const ORCHESTRATOR: Partial<SessionView> = {
  role: "orchestrator",
  parentControl: "questions",
  parentControlPolicy: {
    revision: 2,
    decisions: {
      implementation_question: "orchestrator",
      pr_merge: "human",
      merged_branch_deletion: "human",
      follow_up_issue_publication: "orchestrator",
      ui_evidence_approval: "human",
    },
  },
};

function orchestratorDialog(): HTMLElement | null {
  return [...domWindow.document.querySelectorAll('[role="dialog"]')]
    .find((dialog) => dialog.textContent?.startsWith("Orchestrator Controls")) as unknown as HTMLElement | null ?? null;
}

test("an Orchestrator's Pinned Summary states how its requests and decisions are routed, and each row opens Orchestrator Controls (#2192)", async () => {
  await withSession({ phone: false, session: ORCHESTRATOR }, async (container) => {
    const summaryAside = container.querySelector<HTMLElement>('aside.ps[aria-label="Pinned Summary"]');
    assert.ok(summaryAside);
    const sessionSection = summaryAside.querySelector<HTMLElement>(".ps-sec");
    const row = (label: string) => [...(sessionSection?.querySelectorAll<HTMLElement>(".ps-row") ?? [])]
      .find((candidate) => candidate.querySelector(":scope > .k")?.textContent === label);
    for (const [label, value] of [
      ["Child Session Requests", "Questions"],
      ["Workflow Decisions", "3 of 5 decisions stay with a person."],
    ] as const) {
      const fact = row(label);
      assert.ok(fact, `${label} is a Session row`);
      assert.equal(fact.querySelector(":scope > .ps-note")?.textContent, value, "its value is the row's second line");
      assert.equal(fact.tagName, "BUTTON", `${label} is a navigating row`);
      assert.ok(fact.querySelector(".ps-go"), "with a trailing chevron");
      assertNoDomNode(orchestratorDialog(), "the dialog starts closed");
      await act(async () => fact.click());
      await settle();
      const dialog = orchestratorDialog();
      assert.ok(dialog, `${label} opens Orchestrator Controls`);
      const done = [...dialog.querySelectorAll<HTMLButtonElement>(".modal-foot button")].find((button) => button.textContent === "Done");
      await act(async () => done!.click());
      await settle();
      assertNoDomNode(orchestratorDialog(), "Done closes it");
    }
  });
});

test("a session that is not an Orchestrator has no Orchestrator rows in its Pinned Summary", async () => {
  await withSession({ phone: false }, async (container) => {
    const labels = [...container.querySelectorAll('aside.ps .ps-row > .k')].map((label) => label.textContent);
    assert.ok(!labels.includes("Child Session Requests"));
    assert.ok(!labels.includes("Workflow Decisions"));
  });
});

test("the composer's + menu opens Orchestrator Controls from its one Orchestrator row (#2192)", async () => {
  await withSession({ phone: false, session: ORCHESTRATOR }, async (container) => {
    const plus = container.querySelector<HTMLButtonElement>('[aria-label="Attach and Settings"]');
    assert.ok(plus && !plus.disabled, "+ is available");
    await act(async () => plus.click());
    const item = [...(domWindow.document as unknown as Document).querySelectorAll<HTMLButtonElement>(".menu-item")]
      .find((candidate) => candidate.querySelector(".menu-text")?.textContent === "Orchestrator Controls…");
    assert.ok(item, "the row is in the menu");
    assert.equal(item.querySelector(".menu-desc")?.textContent, "3 of 5 decisions stay with a person.");
    await act(async () => item.click());
    await settle();
    assert.ok(orchestratorDialog(), "it opens the dialog");
  });
});
