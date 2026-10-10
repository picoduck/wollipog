import assert from "node:assert/strict";
import { after, before, beforeEach, test } from "node:test";
import React, { act } from "react";
import { fireDomEvent } from "./test-dom-events.js";
import { createRoot } from "react-dom/client";
import { Window } from "happy-dom";
import type {
  GitChecksSummary,
  GitDiffFile,
  GitDiffInfo,
  GitDiffScope,
  GitPrSummary,
  GitStatusInfo,
  SessionView,
} from "@wollipog/protocol";
import { api, type ApiClient } from "../api.js";
import { ApiProvider } from "../api-context.js";
import { assertNoDomNode } from "../dom-test-assertions.js";
import { installDomTestCleanup } from "../dom-test-cleanup.js";
import { fixChecksPrompt } from "../pinned-summary.js";
import { clearPanelScratch } from "../right-panel-scratch.js";
import { PanelActionSlotContext } from "./RightPanel.js";
import type { DiffFileFocus } from "./GitDiffViewer.js";
import { ReviewPanel } from "./ReviewPanel.js";
import { reviewSummaryFacts } from "./ReviewSummary.js";
import type { GitStatus } from "./useGitStatus.js";

/**
 * Review's layout (#2846): one Refresh in the panel header, one toolbar row, a summary that states
 * the branch and the change once, the scope it opens on, the pull request row, and one plain state
 * for each condition the old panel showed as a muted line.
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

const BRANCH = "agent/layout-fixture";

const file: GitDiffFile = {
  path: "src/checkout.ts",
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

function diffOf(scope: GitDiffScope, files: GitDiffFile[]): GitDiffInfo {
  return {
    scope,
    files,
    diffHash: "a".repeat(64),
    fineDiffHash: "b".repeat(64),
    stats: { filesChanged: files.length, insertions: files.length * 3, deletions: files.length },
    stagedFiles: [],
    unstagedFiles: files,
    stagedDiffHash: "c".repeat(64),
    unstagedDiffHash: "d".repeat(64),
    stagedStats: { filesChanged: 0, insertions: 0, deletions: 0 },
    unstagedStats: { filesChanged: files.length, insertions: files.length * 3, deletions: files.length },
  };
}

function statusOf(over: Partial<GitStatusInfo> = {}): GitStatusInfo {
  return {
    branch: BRANCH,
    files: [{ status: "M", path: "src/checkout.ts" }],
    hasChanges: true,
    ahead: 0,
    remoteUrl: "https://github.com/acme/shop.git",
    baseRef: "origin/main",
    stagedCount: 0,
    ...over,
  };
}

const baseSession: SessionView = {
  id: "session-layout",
  runnerId: "runner-1",
  workspaceId: null,
  workspaceName: null,
  projectId: null,
  agentId: "claude",
  driver: "claude-code",
  title: "Layout Fixture",
  status: "idle",
  createdAt: 1,
  updatedAt: 1,
  useWorktree: true,
  worktreePath: "/tmp/layout-fixture",
} as SessionView;

const openPr: GitPrSummary = {
  number: 42,
  title: "Speed up checkout",
  url: "https://github.com/acme/shop/pull/42",
  state: "OPEN",
  provider: "github",
  kind: "pull_request",
};

const failingChecks: GitChecksSummary = {
  failing: 2,
  pending: 0,
  passing: 5,
  failingNames: ["unit", "lint"],
  url: "https://github.com/acme/shop/pull/42/checks",
};

interface Harness {
  container: HTMLElement;
  /** The panel header's action slot. */
  head: HTMLElement;
  calls: { status: number; diff: GitDiffScope[]; findings: number; prompts: string[]; focusHandled: number };
  render: (over?: Partial<Options>) => Promise<void>;
  /** Hold every subsequent diff read open; the returned function releases them. */
  holdDiff: () => () => Promise<void>;
  unmount: () => Promise<void>;
}

interface Options {
  session: SessionView;
  status: GitStatusInfo | null;
  runnerOnline: boolean;
  protocolVersion: number;
  diffs: Partial<Record<GitDiffScope, GitDiffInfo>>;
  forgeFacts: { pr: GitPrSummary | null; checks: GitChecksSummary | null } | null;
  focus: DiffFileFocus | null;
  /** Whether the shared status reader has finished its first read. */
  settled: boolean;
}

async function mountReview(initial: Partial<Options> = {}): Promise<Harness> {
  let options: Options = {
    session: baseSession,
    status: statusOf(),
    runnerOnline: true,
    protocolVersion: 157,
    diffs: { uncommitted: diffOf("uncommitted", [file]), all_branch: diffOf("all_branch", [file]), last_turn: diffOf("last_turn", [file]) },
    forgeFacts: null,
    focus: null,
    settled: true,
    ...initial,
  };
  const host = domWindow.document.createElement("div");
  const head = domWindow.document.createElement("div");
  const body = domWindow.document.createElement("div");
  host.append(head, body);
  domWindow.document.body.appendChild(host);
  const root = createRoot(body as unknown as Element);
  const calls: Harness["calls"] = { status: 0, diff: [], findings: 0, prompts: [], focusHandled: 0 };
  let held = false;
  let waiting: Array<() => void> = [];
  const client = {
    ...api,
    gitDiff: async (_id: string, scope: GitDiffScope) => {
      calls.diff.push(scope);
      if (held) await new Promise<void>((resolve) => waiting.push(resolve));
      return { diff: options.diffs[scope] ?? diffOf(scope, []) };
    },
    reviewFindings: async () => {
      calls.findings += 1;
      return {
        findings: [],
        summary: { total: 0, unresolved: 0, requiredUnresolved: 0, sent: 0, resolved: 0, dismissed: 0, completion: "complete" },
      };
    },
    prompt: async (_id: string, text: string) => {
      calls.prompts.push(text);
      return {};
    },
  } as unknown as ApiClient;
  const tree = () => {
    const git: GitStatus = {
      status: options.status,
      observation: 1,
      observedAt: Date.UTC(2026, 9, 9, 9, 30),
      settled: options.settled,
      busy: false,
      error: null,
      errorCode: null,
      refresh: async () => { calls.status += 1; },
      refreshStatusOnly: async () => {},
      install: () => {},
      mutationRevision: 0,
    };
    return (
      <ApiProvider client={client}>
        <PanelActionSlotContext.Provider value={head as unknown as HTMLElement}>
          <ReviewPanel
            session={options.session}
            runnerOnline={options.runnerOnline}
            runnerProtocolVersion={options.protocolVersion}
            git={git}
            forgeFacts={options.forgeFacts}
            onOpenSourceLocation={() => {}}
            focus={options.focus}
            onFocusHandled={() => { calls.focusHandled += 1; options = { ...options, focus: null }; }}
          />
        </PanelActionSlotContext.Provider>
      </ApiProvider>
    );
  };
  await act(async () => { root.render(tree()); });
  return {
    container: host as unknown as HTMLElement,
    head: head as unknown as HTMLElement,
    calls,
    render: async (over = {}) => {
      options = { ...options, ...over };
      await act(async () => { root.render(tree()); });
    },
    holdDiff: () => {
      held = true;
      return async () => {
        held = false;
        const release = waiting;
        waiting = [];
        await act(async () => { for (const resolve of release) resolve(); });
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

const buttonNamed = (scope: Element, name: string) =>
  [...scope.querySelectorAll<HTMLButtonElement>("button")]
    .filter((button) => button.getAttribute("aria-label") === name || (button.textContent ?? "").trim() === name);

const scopeOption = (container: HTMLElement, name: string) =>
  [...container.querySelectorAll<HTMLElement>('[role="radiogroup"][aria-label="Scope"] [role="radio"]')]
    .find((radio) => (radio.textContent ?? "").trim() === name);

const stateTitles = (container: HTMLElement) =>
  [...container.querySelectorAll(".state-title")].map((title) => title.textContent);

const noticeTexts = (container: HTMLElement) =>
  [...container.querySelectorAll(".notice")].map((notice) => notice.textContent ?? "");

/* -------------------------------------------------------------------------- */
/* Cases                                                                      */
/* -------------------------------------------------------------------------- */

test("Review has one refresh control, in the panel header, and it reloads status, diff and findings together", async () => {
  const harness = await mountReview();
  try {
    const refresh = buttonNamed(harness.container, "Refresh Review");
    assert.equal(refresh.length, 1, "exactly one refresh control in Review");
    assert.ok(harness.head.contains(refresh[0]!), "and it is in the panel header's action slot");
    assert.equal(refresh[0]!.getAttribute("title"), "Refresh Review");
    assert.ok(refresh[0]!.querySelector("svg"), "an icon button");
    for (const old of ["Refresh Git Status", "↻ Refresh", "↻ Refresh Diff"]) {
      assert.equal(buttonNamed(harness.container, old).length, 0, `no ${old}`);
    }
    assert.ok(!(harness.container.textContent ?? "").includes("↻"), "no refresh glyph anywhere");

    const before = { status: harness.calls.status, diff: harness.calls.diff.length, findings: harness.calls.findings };
    await act(async () => { fireDomEvent.click(refresh[0]!); });
    assert.equal(harness.calls.status - before.status, 1, "one status read");
    assert.equal(harness.calls.diff.length - before.diff, 1, "one diff read");
    assert.equal(harness.calls.findings - before.findings, 1, "one findings read");
  } finally {
    await harness.unmount();
  }
});

test("the header Refresh shows a spinner in its icon slot while its reload is out", async () => {
  const harness = await mountReview();
  try {
    const release = harness.holdDiff();
    const refresh = buttonNamed(harness.container, "Refresh Review")[0]!;
    await act(async () => { fireDomEvent.click(refresh); });
    assert.ok(refresh.querySelector(".spinner"), "busy: the spinner replaces the icon");
    assert.equal(refresh.getAttribute("aria-busy"), "true");
    assert.equal(refresh.disabled, true);
    await release();
    assertNoDomNode(refresh.querySelector(".spinner"), "settled: the icon is back");
    assert.equal(refresh.disabled, false);
  } finally {
    await harness.unmount();
  }
});

test("the toolbar is one row with Scope and View Options; Show and Layout live only in View Options", async () => {
  const harness = await mountReview();
  try {
    const slot = harness.container.querySelector(".rpanel-toolbar");
    assert.ok(slot, "the toolbar slot is rendered above the scroller");
    const rows = slot!.querySelectorAll(":scope > .toolbar");
    assert.equal(rows.length, 1, "one toolbar row");
    const row = rows[0]!;
    assert.ok(row.querySelector('[role="radiogroup"][aria-label="Scope"]'), "Scope is in the row");
    assert.deepEqual(
      [...row.querySelectorAll('[role="radio"]')].map((radio) => radio.textContent),
      ["Uncommitted", "Branch", "Last Turn"],
    );
    const viewOptions = row.querySelector<HTMLButtonElement>('button[aria-label="View Options"]');
    assert.ok(viewOptions?.classList.contains("icon-btn") && viewOptions.classList.contains("sm"), "View Options is a small icon button");
    assert.equal(harness.container.querySelectorAll('[role="radiogroup"]').length, 1, "no second or third segmented control");
    for (const gone of ["All Changes", "Unstaged Only", "Staged Only", "Unified", "Side by Side"]) {
      assert.ok(!(harness.container.textContent ?? "").includes(gone), `${gone} is not on the panel`);
    }

    await act(async () => { fireDomEvent.click(viewOptions!); });
    const menu = domWindow.document.querySelector('[role="menu"][aria-label="View Options"]');
    assert.ok(menu, "View Options opens a menu");
    const groups = [...menu!.querySelectorAll('[role="group"]')].map((group) => [
      group.getAttribute("aria-label"),
      [...group.querySelectorAll('[role="menuitemradio"]')].map((item) => [item.textContent, item.getAttribute("aria-checked")]),
    ]);
    assert.deepEqual(groups, [
      ["Show", [["All Changes", "true"], ["Unstaged Only", "false"], ["Staged Only", "false"]]],
      ["Layout", [["Unified", "true"], ["Side by Side", "false"]]],
    ]);
    assert.ok(menu!.querySelector('[aria-checked="true"] .menu-check'), "the chosen item has a trailing check");
  } finally {
    await harness.unmount();
  }
});

test("Show is offered only where the diff has staged and unstaged panes", async () => {
  const branchOnly = await mountReview({ protocolVersion: 49 });
  try {
    await act(async () => { fireDomEvent.click(branchOnly.container.querySelector<HTMLButtonElement>('button[aria-label="View Options"]')!); });
    const labels = [...domWindow.document.querySelectorAll('[role="menu"] [role="group"]')].map((group) => group.getAttribute("aria-label"));
    assert.deepEqual(labels, ["Layout"], "a runner without fine-grained staging has no Show choice");
    await act(async () => { fireDomEvent.click(domWindow.document.querySelector(".menu-backdrop") as unknown as HTMLElement); });
  } finally {
    await branchOnly.unmount();
  }
});

test("there is no file list, and the branch and the change appear once, in the summary", async () => {
  const harness = await mountReview();
  try {
    assertNoDomNode(harness.container.querySelector("ul.git-files"), "no 12-row file list");
    const text = harness.container.textContent ?? "";
    assert.equal(text.split(BRANCH).length - 1, 1, "the branch name appears once");
    assert.ok(!(harness.head.textContent ?? "").includes(BRANCH), "and not in the panel header");
    const summary = harness.container.querySelector(".review-summary")!;
    assert.equal(summary.querySelector(".review-branch")?.getAttribute("title"), BRANCH, "the full name is its tooltip");
    assert.equal(summary.querySelector(".review-diffstat")?.textContent, "+3−1");
    assert.equal(text.split("+3").length - 1, 1, "the diffstat appears once");
    assert.ok(!/Files? Changed/.test(text), "no second change count above the diff");
    const firstBlock = harness.container.querySelector(".rpanel-scroll .review-panel > :not(.notice)");
    assert.ok(firstBlock?.querySelector(".review-summary"), "the summary is the scroller's first block");
  } finally {
    await harness.unmount();
  }
});

test("the summary's meta facts are sentences, with no middle dots", () => {
  assert.deepEqual(reviewSummaryFacts(statusOf({
    files: Array.from({ length: 9 }, (_unused, index) => ({ status: "M", path: `f${index}` })),
    stagedCount: 5,
    ahead: 1,
  })), ["5 of 9 files staged", "1 commit ahead of main"]);
  assert.deepEqual(reviewSummaryFacts(statusOf({ ahead: 3, baseRef: null, upstreamBranch: null })),
    ["1 uncommitted file", "3 commits ahead"]);
  assert.deepEqual(reviewSummaryFacts(statusOf({ files: [], ahead: 0 })), []);
});

test("a session with no uncommitted files and one commit ahead opens Review on Branch", async () => {
  const harness = await mountReview({ status: statusOf({ files: [], hasChanges: false, ahead: 1 }) });
  try {
    assert.deepEqual(harness.calls.diff, ["all_branch"], "the first and only read is the Branch diff");
    assert.equal(scopeOption(harness.container, "Branch")?.getAttribute("aria-checked"), "true");
    assert.ok(harness.container.querySelector(".diff-file"), "the branch's changes are on screen");
  } finally {
    await harness.unmount();
  }
});

test("uncommitted work, or a scope the reviewer chose, keeps Review on that scope", async () => {
  const dirty = await mountReview({ status: statusOf({ ahead: 1 }) });
  try {
    assert.deepEqual(dirty.calls.diff, ["uncommitted"]);
    await act(async () => { fireDomEvent.click(scopeOption(dirty.container, "Last Turn")!); });
  } finally {
    await dirty.unmount();
  }
  // The choice is remembered for this session, and outranks the opening rule on the next visit.
  const again = await mountReview({ status: statusOf({ files: [], hasChanges: false, ahead: 1 }) });
  try {
    assert.deepEqual(again.calls.diff, ["last_turn"]);
  } finally {
    await again.unmount();
  }
});

test("an open pull request with failing checks shows its title, Open as meta, a danger checks badge and Ask Agent to Fix", async () => {
  const harness = await mountReview({ forgeFacts: { pr: openPr, checks: failingChecks } });
  try {
    const row = harness.container.querySelector<HTMLElement>('.review-summary [role="group"][aria-label="Pull Request"]');
    assert.ok(row, "the summary has a Pull Request row");
    assert.equal(row!.querySelector(".review-pr-title")?.textContent, "Speed up checkout");
    const meta = row!.querySelector(".review-pr-meta")!;
    assert.equal(meta.firstElementChild?.textContent, "Open", "the state is a fact, as meta text");
    assert.ok(!meta.firstElementChild?.classList.contains("status"), "and not a status badge");
    const badge = meta.querySelector(".status");
    assert.ok(badge?.classList.contains("t-danger"), "failing checks are a danger badge");
    assert.equal(badge?.textContent, "Checks Failing");
    const link = row!.querySelector<HTMLAnchorElement>("a.link");
    assert.equal(link?.textContent, "Open on GitHub");
    assert.equal(link?.getAttribute("href"), openPr.url);

    const fix = buttonNamed(row!, "Ask Agent to Fix")[0];
    assert.ok(fix, "Ask Agent to Fix is offered");
    await act(async () => { fireDomEvent.click(fix!); });
    assert.deepEqual(harness.calls.prompts, [fixChecksPrompt(failingChecks, "pull_request")],
      "the same prompt the Pinned Summary's Fix sends");
  } finally {
    await harness.unmount();
  }
});

test("pending checks get an info badge and no Fix; passing checks get no badge", async () => {
  const pending = await mountReview({ forgeFacts: { pr: openPr, checks: { ...failingChecks, failing: 0, pending: 3, failingNames: [] } } });
  try {
    const badge = pending.container.querySelector(".review-pr .status");
    assert.ok(badge?.classList.contains("t-info"));
    assert.equal(badge?.textContent, "Checks Running");
    assert.equal(buttonNamed(pending.container, "Ask Agent to Fix").length, 0);
    await pending.render({ forgeFacts: { pr: { ...openPr, state: "MERGED" }, checks: { ...failingChecks, failing: 0, failingNames: [] } } });
    assertNoDomNode(pending.container.querySelector(".review-pr .status"));
    assert.equal(pending.container.querySelector(".review-pr-meta")?.firstElementChild?.textContent, "Merged");
  } finally {
    await pending.unmount();
  }
});

test("no working folder is a state with a title and a sentence", async () => {
  const harness = await mountReview({ session: { ...baseSession, worktreePath: null, useWorktree: false } as SessionView });
  try {
    assert.deepEqual(stateTitles(harness.container), ["No Working Folder"]);
    assert.ok((harness.container.textContent ?? "").includes("This session has no folder to compare, so there is nothing to review."));
    assertNoDomNode(harness.container.querySelector(".hint"), "not a muted hint");
    assert.deepEqual(harness.calls.diff, []);
  } finally {
    await harness.unmount();
  }
});

test("an empty Uncommitted scope says everything is committed and offers the branch's changes", async () => {
  const harness = await mountReview({
    status: statusOf({ files: [], hasChanges: false, ahead: 2 }),
    diffs: { uncommitted: diffOf("uncommitted", []), all_branch: diffOf("all_branch", [file]) },
  });
  try {
    // Opened on Branch by the rule; go back to Uncommitted to see its empty state.
    await act(async () => { fireDomEvent.click(scopeOption(harness.container, "Uncommitted")!); });
    assert.deepEqual(stateTitles(harness.container), ["No Uncommitted Changes"]);
    assert.ok((harness.container.textContent ?? "").includes("Everything is committed."));
    const show = buttonNamed(harness.container, "Show Branch Changes")[0];
    assert.ok(show, "the branch is ahead, so its changes are one click away");
    await act(async () => { fireDomEvent.click(show!); });
    assert.equal(scopeOption(harness.container, "Branch")?.getAttribute("aria-checked"), "true");
  } finally {
    await harness.unmount();
  }
});

test("empty Branch and Last Turn scopes have their own titles and sentences", async () => {
  const harness = await mountReview({
    diffs: { uncommitted: diffOf("uncommitted", [file]), all_branch: diffOf("all_branch", []), last_turn: diffOf("last_turn", []) },
  });
  try {
    await act(async () => { fireDomEvent.click(scopeOption(harness.container, "Branch")!); });
    assert.deepEqual(stateTitles(harness.container), ["No Changes on This Branch"]);
    assert.ok(harness.container.querySelector(".state-body")?.textContent);
    await act(async () => { fireDomEvent.click(scopeOption(harness.container, "Last Turn")!); });
    assert.deepEqual(stateTitles(harness.container), ["No Changes in the Last Turn"]);
    assert.ok(harness.container.querySelector(".state-body")?.textContent);
  } finally {
    await harness.unmount();
  }
});

test("loading a scope shows skeleton file sections, not a sentence", async () => {
  const harness = await mountReview();
  try {
    const release = harness.holdDiff();
    await act(async () => { fireDomEvent.click(scopeOption(harness.container, "Branch")!); });
    assert.ok(harness.container.querySelector(".review-skeleton .review-skeleton-file"), "skeleton sections");
    assert.ok(!(harness.container.textContent ?? "").includes("Loading diff…"));
    await release();
    assertNoDomNode(harness.container.querySelector(".review-skeleton"));
  } finally {
    await harness.unmount();
  }
});

test("offline keeps the last-known review visible and dimmed under a compact warning notice", async () => {
  const harness = await mountReview();
  try {
    await harness.render({ runnerOnline: false });
    const offline = [...harness.container.querySelectorAll<HTMLElement>(".notice")]
      .find((notice) => (notice.textContent ?? "").includes("is offline."));
    assert.ok(offline, "an offline notice");
    assert.ok(offline!.classList.contains("t-warning") && offline!.classList.contains("compact"));
    assert.match(offline!.textContent ?? "", /is offline\. This review is from .+\./);
    const stale = harness.container.querySelector(".is-stale");
    assert.ok(stale?.querySelector(".diff-file"), "the last-known diff stays on screen, dimmed");
    assert.ok(stale?.querySelector(".review-summary"), "and so does the summary");
    assert.ok(!stale?.contains(offline!), "the notice itself is not dimmed");

    const reads = harness.calls.diff.length;
    await harness.render({ runnerOnline: true });
    assert.equal(harness.calls.diff.length, reads + 1, "the diff reloads on reconnect");
    assertNoDomNode(harness.container.querySelector(".is-stale"));
  } finally {
    await harness.unmount();
  }
});

test("an older runner shows one compact neutral notice, the most limiting", async () => {
  for (const [version, expected] of [[11, "rich diff loading"], [12, "hunk staging"], [13, "staged panes"]] as const) {
    const harness = await mountReview({ protocolVersion: version });
    try {
      const limits = [...harness.container.querySelectorAll<HTMLElement>(".notice")]
        .filter((notice) => (notice.textContent ?? "").includes("needs a newer runner"));
      assert.equal(limits.length, 1, `v${version}: at most one runner notice`);
      assert.ok(limits[0]!.classList.contains("t-neutral") && limits[0]!.classList.contains("compact"));
      assert.ok(limits[0]!.textContent?.includes(expected), `v${version}: ${expected}`);
      assertNoDomNode(harness.container.querySelector(".hint.warn"), "not a muted hint");
    } finally {
      await harness.unmount();
    }
  }
});

test("no Review state is a bare muted line", async () => {
  const harness = await mountReview({ runnerOnline: false, status: null });
  try {
    assert.ok(noticeTexts(harness.container).some((text) => text.includes("is offline.")), "offline with nothing loaded is a notice");
    for (const muted of harness.container.querySelectorAll(".rpanel-scroll .muted, .rpanel-scroll .hint")) {
      assert.ok(muted.closest(".review-findings, .git-action"), `no state line outside the findings and forms: ${muted.textContent}`);
    }
  } finally {
    await harness.unmount();
  }
});

test("the viewer gate is the toolbar's disabled reason (#1870)", async () => {
  const refused = {
    ...baseSession,
    commandPermissions: {
      stop: { allowed: true }, restart: { allowed: true }, stopBackgroundJob: { allowed: true },
      gitActions: { allowed: false, reason: "Viewers can't run Git actions in this session." },
    },
  } as unknown as SessionView;
  const harness = await mountReview({ session: refused });
  try {
    const reason = harness.container.querySelector(".rpanel-toolbar .review-toolbar-reason");
    assert.equal(reason?.textContent, "Viewers can't run Git actions in this session.");
    const commit = buttonNamed(harness.container, "Commit")[0]!;
    assert.equal(commit.getAttribute("aria-describedby"), reason?.id);
  } finally {
    await harness.unmount();
  }
});

/** Choose one View Options item; the menu is portalled to the document body. */
async function chooseViewOption(container: HTMLElement, label: string): Promise<void> {
  await act(async () => { fireDomEvent.click(container.querySelector<HTMLButtonElement>('button[aria-label="View Options"]')!); });
  const item = [...domWindow.document.querySelectorAll('[role="menuitemradio"]')]
    .find((node) => (node.textContent ?? "").trim() === label) as unknown as HTMLElement | undefined;
  assert.ok(item, `View Options offers ${label}`);
  await act(async () => { fireDomEvent.click(item!); });
}

test("an unsent comment draft survives a visit to an empty pane", async () => {
  // The empty pane's state is drawn by the viewer itself, so the viewer — and the draft it holds —
  // stays mounted through All Changes, Staged Only (empty here) and back.
  const harness = await mountReview();
  try {
    await act(async () => {
      fireDomEvent.click(harness.container.querySelector<HTMLElement>('button[aria-label="Comment on src/checkout.ts right line 2"]')!);
    });
    await act(async () => {
      const body = harness.container.querySelector<HTMLTextAreaElement>(".diff-comment-editor textarea")!;
      fireDomEvent.change(body, { target: { value: "half-written finding" } });
    });
    await chooseViewOption(harness.container, "Staged Only");
    assert.deepEqual(stateTitles(harness.container), ["No Staged Changes"]);
    await chooseViewOption(harness.container, "All Changes");
    assert.equal(
      harness.container.querySelector<HTMLTextAreaElement>(".diff-comment-editor textarea")?.value,
      "half-written finding",
      "the draft is still there",
    );
  } finally {
    await harness.unmount();
  }
});

test("a fresh empty diff settles an Open in Review request for a file it does not hold", async () => {
  const harness = await mountReview({ diffs: { uncommitted: diffOf("uncommitted", []) } });
  try {
    await harness.render({ focus: { path: "src/committed-away.ts", request: 1 } });
    assert.equal(harness.calls.focusHandled, 1, "the request is answered, not left pending");
    assert.deepEqual(stateTitles(harness.container), ["No Uncommitted Changes"]);
  } finally {
    await harness.unmount();
  }
});

test("choosing Uncommitted after Review opened on Branch is remembered", async () => {
  const clean = { status: statusOf({ files: [], hasChanges: false, ahead: 1 }) };
  const first = await mountReview(clean);
  try {
    assert.equal(scopeOption(first.container, "Branch")?.getAttribute("aria-checked"), "true");
    await act(async () => { fireDomEvent.click(scopeOption(first.container, "Uncommitted")!); });
    assert.equal(scopeOption(first.container, "Uncommitted")?.getAttribute("aria-checked"), "true");
  } finally {
    await first.unmount();
  }
  const again = await mountReview(clean);
  try {
    assert.equal(scopeOption(again.container, "Uncommitted")?.getAttribute("aria-checked"), "true",
      "the reviewer's choice outranks the opening rule");
    assert.deepEqual(again.calls.diff, ["uncommitted"]);
  } finally {
    await again.unmount();
  }
});

test("a scope picked before the first status read loads at once, and the opening rule does not override it", async () => {
  const harness = await mountReview({ status: null, settled: false });
  try {
    assert.deepEqual(harness.calls.diff, [], "nothing loads before the opening scope is known");
    await act(async () => { fireDomEvent.click(scopeOption(harness.container, "Last Turn")!); });
    assert.deepEqual(harness.calls.diff, ["last_turn"], "the reviewer's pick loads immediately");
    // The first status then says the branch has only committed work, which would open on Branch.
    await harness.render({ status: statusOf({ files: [], hasChanges: false, ahead: 1 }), settled: true });
    assert.equal(scopeOption(harness.container, "Last Turn")?.getAttribute("aria-checked"), "true");
    // The first status read is an observation the diff predates, so it is re-read once (#1204), but
    // only ever for the scope the reviewer picked.
    assert.ok(harness.calls.diff.every((scope) => scope === "last_turn"), `no other scope is read: ${harness.calls.diff.join(", ")}`);
  } finally {
    await harness.unmount();
  }
});
