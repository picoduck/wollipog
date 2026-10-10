import assert from "node:assert/strict";
import { after, before, beforeEach, test } from "node:test";
import React, { act } from "react";
import { fireDomEvent } from "./test-dom-events.js";
import { createRoot } from "react-dom/client";
import { Window } from "happy-dom";
import {
  PROTOCOL_VERSION,
  type BundleReviewFindingsRequest,
  type GitDiffFile,
  type GitDiffInfo,
  type GitDiffScope,
  type GitStatusInfo,
  type ReviewFinding,
  type SessionView,
  type SourceLocation,
} from "@wollipog/protocol";
import { api, type ApiClient } from "../api.js";
import { ApiProvider } from "../api-context.js";
import { assertNoDomNode } from "../dom-test-assertions.js";
import { installDomTestCleanup } from "../dom-test-cleanup.js";
import { ViewerIdentityContext, type ViewerIdentity } from "../resolver-identity.js";
import { clearPanelScratch } from "../right-panel-scratch.js";
import { PanelActionSlotContext } from "./RightPanel.js";
import { ReviewPanel } from "./ReviewPanel.js";
import type { GitStatus } from "./useGitStatus.js";

/**
 * Review's findings (#2850): one collapsible section above the diff, single-column rows that say who
 * wrote them in words rather than ids, Sync only for a forge the repository has, and a selection bar
 * that takes the commit bar's place to send findings to the agent.
 */

const domWindow = new Window({ url: "http://localhost/" });
installDomTestCleanup(domWindow);
const globals: Record<string, unknown> = {
  window: domWindow,
  document: domWindow.document,
  localStorage: domWindow.localStorage,
  navigator: domWindow.navigator,
  HTMLElement: domWindow.HTMLElement,
  HTMLButtonElement: domWindow.HTMLButtonElement,
  Node: domWindow.Node,
  Event: domWindow.Event,
  InputEvent: domWindow.InputEvent,
  MouseEvent: domWindow.MouseEvent,
  KeyboardEvent: domWindow.KeyboardEvent,
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

beforeEach(() => clearPanelScratch());

/* -------------------------------------------------------------------------- */
/* Fixtures                                                                   */
/* -------------------------------------------------------------------------- */

const MINUTE = 60_000;

const file: GitDiffFile = {
  path: "src/checkout/CheckoutPage.tsx",
  status: "modified",
  binary: false,
  hunks: [{
    header: "@@ -1,2 +1,2 @@",
    oldStart: 1,
    oldCount: 2,
    newStart: 1,
    newCount: 2,
    lines: [
      { status: " ", text: "keep" },
      { status: "-", text: "old" },
      { status: "+", text: "new" },
    ],
  }],
};

const DIFF_HASH = "a".repeat(64);

function diffOf(scope: GitDiffScope): GitDiffInfo {
  return {
    scope,
    files: [file],
    diffHash: DIFF_HASH,
    fineDiffHash: "b".repeat(64),
    stats: { filesChanged: 1, insertions: 1, deletions: 1 },
    stagedFiles: [],
    unstagedFiles: [file],
    stagedDiffHash: "c".repeat(64),
    unstagedDiffHash: "d".repeat(64),
    stagedStats: { filesChanged: 0, insertions: 0, deletions: 0 },
    unstagedStats: { filesChanged: 1, insertions: 1, deletions: 1 },
  };
}

function statusOf(over: Partial<GitStatusInfo> = {}): GitStatusInfo {
  return {
    branch: "agent/findings-fixture",
    files: [{ status: "M", path: file.path }],
    hasChanges: true,
    ahead: 0,
    remoteUrl: null,
    baseRef: "origin/main",
    stagedCount: 0,
    ...over,
  };
}

const session: SessionView = {
  id: "session-findings",
  runnerId: "runner-1",
  workspaceId: null,
  workspaceName: null,
  projectId: null,
  agentId: "claude",
  agentName: "Claude",
  driver: "claude-code",
  title: "Findings Fixture",
  status: "idle",
  createdAt: 1,
  updatedAt: 1,
  useWorktree: true,
  worktreePath: "/tmp/findings-fixture",
} as SessionView;

/** A shared organization, so "You" is earned by the id rather than by being the only member. */
const viewer: ViewerIdentity = {
  userId: "usr_me000000000",
  shared: true,
  names: new Map([["usr_me000000000", "Mitch"], ["usr_ada000000000", "Ada Lovelace"]]),
};

function finding(over: Partial<ReviewFinding> & Pick<ReviewFinding, "findingId">): ReviewFinding {
  const now = Date.now();
  return {
    sessionId: session.id,
    scope: "uncommitted",
    diffHash: DIFF_HASH,
    filePath: file.path,
    side: "right",
    line: 2,
    anchorText: "new",
    body: "Guard the empty cart before charging.",
    severity: "major",
    required: false,
    status: "open",
    source: "local",
    author: { kind: "human", id: viewer.userId },
    createdAt: now - 12 * MINUTE,
    updatedAt: now - 12 * MINUTE,
    ...over,
  };
}

const mine = finding({ findingId: "rf_mine" });
const adas = finding({
  findingId: "rf_ada",
  author: { kind: "human", id: "usr_ada000000000" },
  scope: "all_branch",
  side: "left",
  line: 2,
  anchorText: "old",
  severity: "nit",
  createdAt: Date.now() - 65 * MINUTE,
});
const remote = finding({
  findingId: "rf_remote",
  source: "github",
  author: { kind: "human", id: "octocat" },
  severity: "minor",
  createdAt: Date.now() - 125 * MINUTE,
  remote: {
    provider: "github",
    repository: "acme/shop",
    pullRequestNumber: 42,
    threadId: "thread-1",
    commentId: 101,
    url: "https://github.com/acme/shop/pull/42#discussion_r101",
    commitId: "e".repeat(40),
    outdated: false,
    subjectType: "line",
    synchronizedAt: Date.now(),
  },
});

interface Options {
  findings: ReviewFinding[];
  status: GitStatusInfo;
  protocolVersion: number;
  runnerOnline: boolean;
}

interface Harness {
  container: HTMLElement;
  bundles: BundleReviewFindingsRequest[];
  opened: SourceLocation[];
  render: (over?: Partial<Options>) => Promise<void>;
  reloadFindings: (findings: ReviewFinding[]) => Promise<void>;
  /** Hold the next Sync or Send open; the returned function settles it, after installing `findings`. */
  hold: (kind: "sync" | "bundle") => (findings?: ReviewFinding[]) => Promise<void>;
  unmount: () => Promise<void>;
}

async function mountReview(initial: Partial<Options> = {}): Promise<Harness> {
  let options: Options = {
    findings: [mine],
    status: statusOf(),
    protocolVersion: PROTOCOL_VERSION,
    runnerOnline: true,
    ...initial,
  };
  const host = domWindow.document.createElement("div");
  const head = domWindow.document.createElement("div");
  const body = domWindow.document.createElement("div");
  host.append(head, body);
  domWindow.document.body.appendChild(host);
  const root = createRoot(body as unknown as Element);
  const bundles: BundleReviewFindingsRequest[] = [];
  const opened: SourceLocation[] = [];
  const gates: Partial<Record<"sync" | "bundle", Promise<void>>> = {};
  const response = () => ({
    findings: options.findings,
    summary: { total: 0, unresolved: 0, requiredUnresolved: 0, sent: 0, resolved: 0, dismissed: 0, completion: "complete" as const },
  });
  const client = {
    ...api,
    gitDiff: async (_id: string, scope: GitDiffScope) => ({ diff: diffOf(scope) }),
    reviewFindings: async () => response(),
    git: async (_id: string, request: { action: string }) => {
      if (request.action !== "forge_review_sync" && request.action !== "github_review_sync") return {};
      await gates.sync;
      return {
        reviewFindings: response(),
        reviewReconciliation: { imported: 0, updated: 1, dismissedMissing: 0 },
        forgeReview: { provider: "github", changeRequestNumber: 42, threads: [] },
      };
    },
    bundleReviewFindings: async (_id: string, request: BundleReviewFindingsRequest) => {
      await gates.bundle;
      bundles.push(request);
      const sent = new Set(request.findings.map((entry) => entry.findingId));
      options = {
        ...options,
        findings: options.findings.map((entry) => (sent.has(entry.findingId) ? { ...entry, status: "sent" as const } : entry)),
      };
      return response();
    },
  } as unknown as ApiClient;
  const tree = () => {
    const git: GitStatus = {
      status: options.status,
      observation: 1,
      observedAt: Date.now(),
      settled: true,
      busy: false,
      error: null,
      errorCode: null,
      refresh: async () => {},
      refreshStatusOnly: async () => {},
      install: () => {},
      mutationRevision: 0,
    };
    return (
      <ApiProvider client={client}>
        <ViewerIdentityContext.Provider value={viewer}>
          <PanelActionSlotContext.Provider value={head as unknown as HTMLElement}>
            <ReviewPanel
              session={session}
              runnerOnline={options.runnerOnline}
              runnerProtocolVersion={options.protocolVersion}
              git={git}
              onOpenSourceLocation={(location) => { opened.push(location); }}
            />
          </PanelActionSlotContext.Provider>
        </ViewerIdentityContext.Provider>
      </ApiProvider>
    );
  };
  await act(async () => { root.render(tree()); });
  return {
    container: host as unknown as HTMLElement,
    bundles,
    opened,
    render: async (over = {}) => {
      options = { ...options, ...over };
      await act(async () => { root.render(tree()); });
    },
    reloadFindings: async (findings) => {
      options = { ...options, findings };
      const refresh = (head as unknown as HTMLElement).querySelector<HTMLButtonElement>('button[aria-label="Refresh Review"]');
      assert.ok(refresh, "the header Refresh is rendered");
      await act(async () => { fireDomEvent.click(refresh); });
    },
    hold: (kind) => {
      let release!: () => void;
      gates[kind] = new Promise<void>((resolve) => { release = resolve; });
      return async (findings) => {
        if (findings) options = { ...options, findings };
        delete gates[kind];
        await act(async () => { release(); });
      };
    },
    unmount: async () => {
      await act(async () => { root.unmount(); });
      host.remove();
    },
  };
}

/* -------------------------------------------------------------------------- */
/* Queries                                                                    */
/* -------------------------------------------------------------------------- */

function section(container: HTMLElement): HTMLElement {
  const found = container.querySelector<HTMLElement>("section.review-findings");
  assert.ok(found, "the findings section is rendered");
  return found;
}

function rows(container: HTMLElement): HTMLElement[] {
  return [...container.querySelectorAll<HTMLElement>(".review-finding-row")];
}

function rowWith(container: HTMLElement, text: string): HTMLElement {
  const found = rows(container).find((row) => (row.textContent ?? "").includes(text));
  assert.ok(found, `a row reads "${text}"`);
  return found;
}

function buttonNamed(scope: Element, name: string): HTMLButtonElement[] {
  return [...scope.querySelectorAll<HTMLButtonElement>("button")]
    .filter((button) => button.getAttribute("aria-label") === name || (button.textContent ?? "").trim() === name);
}

function onlyButton(scope: Element, name: string): HTMLButtonElement {
  const found = buttonNamed(scope, name);
  assert.equal(found.length, 1, `exactly one ${name}`);
  return found[0]!;
}

const metaOf = (row: HTMLElement) => row.querySelector(".review-finding-meta")?.textContent ?? "";

async function select(row: HTMLElement) {
  const box = row.querySelector<HTMLInputElement>('input[type="checkbox"]');
  assert.ok(box, "the row has a selection box");
  await act(async () => { fireDomEvent.click(box); });
}

/* -------------------------------------------------------------------------- */
/* Cases                                                                      */
/* -------------------------------------------------------------------------- */

test("findings sit above the first file section, one column each, and say who wrote them in words (#2850)", async () => {
  const harness = await mountReview({ findings: [mine, adas, remote] });
  try {
    const findings = section(harness.container);
    const firstFile = harness.container.querySelector(".git-diff-section");
    assert.ok(firstFile, "the diff is rendered");
    assert.ok(findings.compareDocumentPosition(firstFile as never) & domWindow.Node.DOCUMENT_POSITION_FOLLOWING,
      "the findings come before the diff");
    assert.equal(rows(harness.container).length, 3);

    for (const row of rows(harness.container)) {
      const text = row.textContent ?? "";
      assert.doesNotMatch(text, /usr_/u, "no user id");
      assert.doesNotMatch(text, /uncommitted|all_branch|last_turn|All Branch/u, "no scope enum");
      assert.doesNotMatch(text, /\bLeft\b|\bRight\b/u, "no diff side");
    }
    assert.equal(metaOf(rowWith(harness.container, "Major")), "You · 12m ago", "the viewer's own finding");
    assert.equal(metaOf(rowWith(harness.container, "Nit")), "Ada Lovelace · 1h ago · Branch",
      "another member by name, with the scope it was written against since that differs");
    assert.equal(metaOf(rowWith(harness.container, "Minor")), "octocat on GitHub · 2h ago", "a forge thread's author");

    const location = rowWith(harness.container, "You · 12m ago").querySelector<HTMLButtonElement>("button.review-finding-location");
    assert.ok(location, "the location is a link into Files");
    assert.equal(location.textContent, "CheckoutPage.tsx:2", "the base name and line");
    assert.equal(location.title, "src/checkout/CheckoutPage.tsx:2", "the full path in the tooltip");
    await act(async () => { fireDomEvent.click(location); });
    assert.deepEqual(harness.opened, [{ path: "src/checkout/CheckoutPage.tsx", line: 2 }]);

    const forgeRow = rowWith(harness.container, "octocat on GitHub");
    assert.equal(buttonNamed(forgeRow, "Resolve").length, 0, "a forge thread is resolved on the forge");
    const resolveOnForge = forgeRow.querySelector<HTMLAnchorElement>("a.btn");
    assert.equal(resolveOnForge?.textContent, "Resolve on GitHub");
    assert.equal(resolveOnForge?.getAttribute("href"), remote.remote!.url);
    assert.doesNotMatch(forgeRow.textContent ?? "", /Remote-Owned/u);
  } finally {
    await harness.unmount();
  }
});

test("a stale local finding shows its one badge and the Outdated line, and an anchored one shows neither (#2850)", async () => {
  // Written against an earlier change set, at a line whose text has since changed.
  const stale = finding({
    findingId: "rf_stale", diffHash: "f".repeat(64), anchorText: "a line that is no longer there", severity: "blocker", required: true,
  });
  const harness = await mountReview({ findings: [mine, stale] });
  try {
    const staleRow = rowWith(harness.container, "Blocker");
    const statusBadges = staleRow.querySelectorAll(".status:not(.no-dot)");
    assert.equal(statusBadges.length, 1, "one status badge (§11.1)");
    assert.ok(statusBadges[0]!.classList.contains("t-danger"), "Blocker is the danger tone");
    const flags = [...staleRow.querySelectorAll(".status.no-dot")].map((badge) => badge.textContent);
    assert.deepEqual(flags, ["Required"], "Required is the neutral flag badge");
    assert.equal(staleRow.querySelector(".review-finding-outdated")?.textContent,
      "Outdated: the line changed after this was written.");
    assert.ok(staleRow.querySelector(".review-finding-outdated svg"), "after its icon");

    const anchoredRow = rowWith(harness.container, "Major");
    assertNoDomNode(anchoredRow.querySelector(".review-finding-outdated"), "an anchored finding is not outdated");
    assert.ok(anchoredRow.querySelector(".status.t-warning"), "Major is the warning tone");
  } finally {
    await harness.unmount();
  }
});

test("Sync renders only for a forge remote, named for that forge, and says why an older runner can't (#2850)", async () => {
  const harness = await mountReview();
  try {
    assert.equal(buttonNamed(section(harness.container), "Sync GitHub").length, 0, "no forge remote, no Sync");
    assert.equal(buttonNamed(section(harness.container), "Sync GitLab").length, 0);

    await harness.render({ status: statusOf({ remoteUrl: "git@gitlab.com:acme/shop.git" }) });
    const gitlab = onlyButton(section(harness.container), "Sync GitLab");
    assert.equal(gitlab.disabled, false);
    assert.equal(buttonNamed(section(harness.container), "Sync GitHub").length, 0);

    await harness.render({ status: statusOf({ remoteUrl: "https://github.com/acme/shop.git" }) });
    assert.equal(onlyButton(section(harness.container), "Sync GitHub").disabled, false);

    // GitLab threads need the forge contract, which a v105 runner does not have.
    await harness.render({ status: statusOf({ remoteUrl: "git@gitlab.com:acme/shop.git" }), protocolVersion: 105 });
    const old = onlyButton(section(harness.container), "Sync GitLab");
    assert.equal(old.disabled, true);
    const reasonId = old.getAttribute("aria-describedby");
    assert.ok(reasonId, "the disabled Sync is described by its reason");
    const reason = domWindow.document.getElementById(reasonId);
    assert.ok(reason && section(harness.container).contains(reason as never), "the reason is visible in the section");
    assert.match(reason.textContent ?? "", /GitLab review sync/u);
  } finally {
    await harness.unmount();
  }
});

test("selecting findings swaps the commit bar for the selection bar, and Send to Agent sends the same bundle (#2850)", async () => {
  const other = finding({ findingId: "rf_other", severity: "minor", line: 1, anchorText: "keep" });
  const harness = await mountReview({ findings: [mine, other] });
  try {
    assert.ok(harness.container.querySelector(".commit-bar"), "the commit bar holds the foot");
    assertNoDomNode(harness.container.querySelector(".finding-selection-bar"), "nothing is selected by default");

    await select(rowWith(harness.container, "Major"));
    await select(rowWith(harness.container, "Minor"));
    assertNoDomNode(harness.container.querySelector(".commit-bar"), "the commit bar is replaced, not stacked");
    const bar = harness.container.querySelector<HTMLElement>(".rpanel-foot .finding-selection-bar");
    assert.ok(bar, "the selection bar is in the panel's foot");
    assert.equal(bar.querySelector(".finding-selection-count")?.textContent, "2 findings selected");
    onlyButton(bar, "Clear");

    await act(async () => { fireDomEvent.click(onlyButton(bar, "Send to Agent")); });
    assert.deepEqual(harness.bundles, [{
      findings: [
        { findingId: mine.findingId, expectedUpdatedAt: mine.updatedAt },
        { findingId: other.findingId, expectedUpdatedAt: other.updatedAt },
      ],
    }], "the bundle is the selected findings with their versions, as before");

    const after = harness.container.querySelector<HTMLElement>(".finding-selection-bar");
    assert.ok(after, "the bar keeps the result");
    const notice = after.querySelector(".notice");
    assert.equal(notice?.getAttribute("role"), "status");
    assert.match(notice?.textContent ?? "", /Sent 2 findings to Claude\./u);
    assertNoDomNode(after.querySelector(".finding-selection-count"), "nothing is selected any more");
    for (const row of rows(harness.container)) assert.match(metaOf(row), /Sent to Claude$/u);
    assertNoDomNode(domWindow.document.querySelector(".toast"), "no toast");

    const dismiss = after.querySelector<HTMLButtonElement>(".notice button[aria-label]");
    assert.ok(dismiss, "the notice can be dismissed");
    await act(async () => { fireDomEvent.click(dismiss); });
    assert.ok(harness.container.querySelector(".commit-bar"), "the commit bar comes back");
    assert.equal(domWindow.document.activeElement?.textContent?.startsWith("Findings"), true,
      "focus returns to the findings rather than the page");
  } finally {
    await harness.unmount();
  }
});

test("Clear empties the selection and gives the foot back to the commit bar (#2850)", async () => {
  const harness = await mountReview();
  try {
    await select(rows(harness.container)[0]!);
    const bar = harness.container.querySelector<HTMLElement>(".finding-selection-bar")!;
    assert.equal(bar.querySelector(".finding-selection-count")?.textContent, "1 finding selected");
    await act(async () => { fireDomEvent.click(onlyButton(bar, "Clear")); });
    assertNoDomNode(harness.container.querySelector(".finding-selection-bar"));
    assert.ok(harness.container.querySelector(".commit-bar"));
    assert.equal((rows(harness.container)[0]!.querySelector('input[type="checkbox"]') as HTMLInputElement).checked, false);
    assert.deepEqual(harness.bundles, []);
  } finally {
    await harness.unmount();
  }
});

test("offline, Send to Agent is disabled with its reason in the bar (#2850)", async () => {
  const harness = await mountReview({ runnerOnline: false });
  try {
    await select(rows(harness.container)[0]!);
    const bar = harness.container.querySelector<HTMLElement>(".finding-selection-bar")!;
    const send = onlyButton(bar, "Send to Agent");
    assert.equal(send.disabled, true);
    const reason = domWindow.document.getElementById(send.getAttribute("aria-describedby")!);
    assert.ok(reason && bar.contains(reason as never));
    assert.equal(reason.textContent, "Reconnect to send findings to the agent.");
  } finally {
    await harness.unmount();
  }
});

test("the head counts open findings and shows one summary status: Required, All Resolved, or none (#2850)", async () => {
  const required = finding({ findingId: "rf_required", required: true });
  const harness = await mountReview({ findings: [mine, required] });
  try {
    const trigger = () => section(harness.container).querySelector<HTMLButtonElement>(".disclosure-trigger")!;
    const badges = () => [...section(harness.container).querySelectorAll(".review-findings-head .status")];
    assert.equal(trigger().getAttribute("aria-expanded"), "true", "open while findings are open");
    assert.equal(trigger().querySelector(".review-findings-count")?.textContent, "2", "the open count, plain");
    assert.deepEqual(badges().map((badge) => [badge.textContent, badge.classList.contains("t-warning")]), [["1 Required", true]]);

    await harness.reloadFindings([mine, { ...required, status: "resolved" }]);
    assert.deepEqual(badges(), [], "no required finding is open, and one still is: no summary status");

    await harness.reloadFindings([{ ...mine, status: "dismissed" }, { ...required, status: "resolved" }]);
    assert.deepEqual(badges().map((badge) => [badge.textContent, badge.classList.contains("t-success")]), [["All Resolved", true]]);
    assertNoDomNode(trigger().querySelector(".review-findings-count"), "no count of zero");

    assert.equal(trigger().getAttribute("aria-expanded"), "false", "with nothing open the rows fold");
    const body = () => domWindow.document.getElementById(trigger().getAttribute("aria-controls")!);
    assert.equal(body()?.hasAttribute("hidden"), true);
    await act(async () => { fireDomEvent.click(trigger()); });
    assert.equal(trigger().getAttribute("aria-expanded"), "true", "and the disclosure opens them again");
    assert.equal(body()?.hasAttribute("hidden"), false);
  } finally {
    await harness.unmount();
  }
});

test("with no findings the section says how to add one, and settled findings start folded (#2850)", async () => {
  const empty = await mountReview({ findings: [] });
  try {
    assert.equal(section(empty.container).querySelector(".review-findings-empty")?.textContent,
      "Hover a line and choose + to add a finding.");
    assert.equal(section(empty.container).querySelectorAll(".status").length, 0, "no summary status without findings");
  } finally {
    await empty.unmount();
  }
  const settled = await mountReview({ findings: [{ ...mine, status: "resolved" }] });
  try {
    const trigger = section(settled.container).querySelector<HTMLButtonElement>(".disclosure-trigger")!;
    assert.equal(trigger.getAttribute("aria-expanded"), "false");
  } finally {
    await settled.unmount();
  }
});

test("a Sync that settles the selected findings while Send runs keeps the busy bar and the focus (#2850)", async () => {
  const harness = await mountReview({ status: statusOf({ remoteUrl: "https://github.com/acme/shop.git" }) });
  try {
    const finishSync = harness.hold("sync");
    await act(async () => { fireDomEvent.click(onlyButton(section(harness.container), "Sync GitHub")); });
    await select(rows(harness.container)[0]!);
    const finishSend = harness.hold("bundle");
    const send = onlyButton(harness.container.querySelector(".finding-selection-bar")!, "Send to Agent");
    send.focus();
    await act(async () => { fireDomEvent.click(send); });
    assert.equal(send.getAttribute("aria-busy"), "true", "the send is running");

    // The forge reports the selected finding resolved while the send is still out.
    await finishSync([{ ...mine, status: "resolved" }]);
    const bar = harness.container.querySelector<HTMLElement>(".finding-selection-bar");
    assert.ok(bar, "the bar stays while its send runs");
    assert.equal(send.isConnected, true, "the busy Send to Agent is not taken away");
    assert.equal(send.getAttribute("aria-busy"), "true");
    assert.equal(bar.querySelector(".finding-selection-count")?.textContent, "1 finding selected", "it still says what is being sent");
    assert.equal(domWindow.document.activeElement, send, "focus stays on the running action");
    assertNoDomNode(harness.container.querySelector(".commit-bar"), "the commit bar waits for the send");

    await finishSend();
    assert.match(harness.container.querySelector(".finding-selection-bar .notice")?.textContent ?? "", /Sent 1 finding to Claude\./u);
    assert.notEqual(domWindow.document.activeElement, domWindow.document.body, "focus moves to the result, not the page");
  } finally {
    await harness.unmount();
  }
});

test("a reload that settles every selected finding gives the foot back and focus to the findings (#2850)", async () => {
  const harness = await mountReview();
  try {
    await select(rows(harness.container)[0]!);
    onlyButton(harness.container.querySelector(".finding-selection-bar")!, "Clear").focus();
    await harness.reloadFindings([{ ...mine, status: "resolved" }]);
    assertNoDomNode(harness.container.querySelector(".finding-selection-bar"));
    assert.ok(harness.container.querySelector(".commit-bar"));
    assert.equal(domWindow.document.activeElement?.textContent?.startsWith("Findings"), true,
      "focus returns to the findings rather than the page");
  } finally {
    await harness.unmount();
  }
});
