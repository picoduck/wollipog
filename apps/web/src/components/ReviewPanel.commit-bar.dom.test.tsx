import assert from "node:assert/strict";
import { after, before, beforeEach, test } from "node:test";
import React, { act } from "react";
import { fireDomEvent } from "./test-dom-events.js";
import { createRoot } from "react-dom/client";
import { Window } from "happy-dom";
import type {
  GitActionRequest,
  GitChecksSummary,
  GitDiffFile,
  GitDiffInfo,
  GitDiffScope,
  GitPrInfo,
  GitPrSummary,
  GitStatusInfo,
  SessionView,
} from "@wollipog/protocol";
import { api, ApiError, type ApiClient } from "../api.js";
import { ApiProvider } from "../api-context.js";
import { assertNoDomNode } from "../dom-test-assertions.js";
import { installDomTestCleanup } from "../dom-test-cleanup.js";
import { clearPanelScratch } from "../right-panel-scratch.js";
import { PanelActionSlotContext } from "./RightPanel.js";
import { ReviewPanel } from "./ReviewPanel.js";
import type { GitStatus } from "./useGitStatus.js";

/**
 * Review's commit bar and Open Pull Request dialog (#2847): the commit message and its primary fixed
 * in the panel's foot in every state, Commit All Changes only in the split button's menu, each git
 * result in the bar beside the button that caused it, and the request opened from a dialog.
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
    stats: { filesChanged: files.length, insertions: 1, deletions: 1 },
    stagedFiles: [],
    unstagedFiles: files,
    stagedDiffHash: "c".repeat(64),
    unstagedDiffHash: "d".repeat(64),
    stagedStats: { filesChanged: 0, insertions: 0, deletions: 0 },
    unstagedStats: { filesChanged: files.length, insertions: 1, deletions: 1 },
  };
}

/** Three changed files, one of them staged, on a GitHub remote. */
function statusOf(over: Partial<GitStatusInfo> = {}): GitStatusInfo {
  return {
    branch: "agent/commit-bar",
    files: [
      { status: "M", path: "src/checkout.ts" },
      { status: "M", path: "src/cart.ts" },
      { status: "??", path: "src/cart.test.ts" },
    ],
    hasChanges: true,
    ahead: 1,
    remoteUrl: "https://github.com/acme/shop.git",
    baseRef: "origin/main",
    stagedCount: 1,
    ...over,
  };
}

const CLEAN = statusOf({ files: [], hasChanges: false, stagedCount: 0 });

const baseSession: SessionView = {
  id: "session-commit-bar",
  runnerId: "runner-1",
  workspaceId: null,
  workspaceName: null,
  projectId: null,
  agentId: "claude",
  driver: "claude-code",
  title: "Speed Up Checkout",
  status: "idle",
  createdAt: 1,
  updatedAt: 1,
  useWorktree: true,
  worktreePath: "/tmp/commit-bar-fixture",
} as SessionView;

const openPr: GitPrSummary = {
  number: 42,
  title: "Speed up checkout",
  url: "https://github.com/acme/shop/pull/42",
  state: "OPEN",
  provider: "github",
  kind: "pull_request",
};

const REJECTED = `Command failed: git push -u origin agent/commit-bar
 ! [rejected]        agent/commit-bar -> agent/commit-bar (fetch first)
error: failed to push some refs to 'https://github.com/acme/shop.git'`;

/** What the runner answers for one Git action: a result, or a failure with its error text. */
type GitReply = { commit?: object; pr?: GitPrInfo } | { error: string; code?: string };

interface Harness {
  container: HTMLElement;
  /** Every Git action sent, in order. */
  sent: GitActionRequest[];
  /** Queue the replies for the next Git actions; an empty queue answers with a commit. */
  reply: (...replies: GitReply[]) => void;
  /** Hold every later Git action (and hunk stage) open; the returned function releases them. */
  hold: () => () => Promise<void>;
  render: (over?: Partial<Options>) => Promise<void>;
  unmount: () => Promise<void>;
}

interface Options {
  session: SessionView;
  status: GitStatusInfo | null;
  /** The shared status reader is mid-read, which holds the bar. */
  gitBusy: boolean;
  runnerOnline: boolean;
  forgeFacts: { pr: GitPrSummary | null; checks: GitChecksSummary | null } | null;
}

async function mountReview(initial: Partial<Options> = {}): Promise<Harness> {
  let options: Options = { session: baseSession, status: statusOf(), gitBusy: false, runnerOnline: true, forgeFacts: null, ...initial };
  const host = domWindow.document.createElement("div");
  const head = domWindow.document.createElement("div");
  const body = domWindow.document.createElement("div");
  host.append(head, body);
  domWindow.document.body.appendChild(host);
  const root = createRoot(body as unknown as Element);
  const sent: GitActionRequest[] = [];
  const replies: GitReply[] = [];
  let held = false;
  let waiting: Array<() => void> = [];
  const wait = async () => { if (held) await new Promise<void>((resolve) => waiting.push(resolve)); };
  const client = {
    ...api,
    gitDiff: async (_id: string, scope: GitDiffScope) => ({ diff: diffOf(scope, [file]) }),
    reviewFindings: async () => ({
      findings: [],
      summary: { total: 0, unresolved: 0, requiredUnresolved: 0, sent: 0, resolved: 0, dismissed: 0, completion: "complete" },
    }),
    gitStageHunk: async () => {
      await wait();
      return { status: options.status, diff: diffOf("uncommitted", [file]) };
    },
    git: async (_id: string, request: GitActionRequest) => {
      sent.push(request);
      await wait();
      const next = replies.shift() ?? { commit: { sha: "9d2a7da", message: "", filesChanged: 1, stagedOnly: true } };
      if ("error" in next) throw new ApiError(next.error, 500, next.code);
      return next;
    },
  } as unknown as ApiClient;
  const tree = () => {
    const git: GitStatus = {
      status: options.status,
      observation: 1,
      observedAt: Date.UTC(2026, 9, 9, 9, 30),
      settled: true,
      busy: options.gitBusy,
      error: null,
      errorCode: null,
      refresh: async () => {},
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
            runnerProtocolVersion={157}
            git={git}
            forgeFacts={options.forgeFacts}
            onOpenSourceLocation={() => {}}
          />
        </PanelActionSlotContext.Provider>
      </ApiProvider>
    );
  };
  await act(async () => { root.render(tree()); });
  return {
    container: host as unknown as HTMLElement,
    sent,
    reply: (...next) => { replies.push(...next); },
    hold: () => {
      held = true;
      return async () => {
        held = false;
        const release = waiting;
        waiting = [];
        await act(async () => { for (const resolve of release) resolve(); });
      };
    },
    render: async (over = {}) => {
      options = { ...options, ...over };
      await act(async () => { root.render(tree()); });
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

const bar = (container: HTMLElement) => {
  const found = container.querySelector<HTMLElement>(".rpanel-foot .commit-bar");
  assert.ok(found, "the commit bar is in the panel's foot");
  return found;
};

const named = (scope: Element, name: string) =>
  [...scope.querySelectorAll<HTMLButtonElement | HTMLAnchorElement>("button, a")]
    .filter((control) => control.getAttribute("aria-label") === name || (control.textContent ?? "").trim() === name);

function only(scope: Element, name: string): HTMLButtonElement {
  const found = named(scope, name);
  assert.equal(found.length, 1, `exactly one ${name}`);
  return found[0] as HTMLButtonElement;
}

/** The bar's action row, left to right, with the primary's class. */
const actionRow = (container: HTMLElement) =>
  [...bar(container).querySelectorAll<HTMLButtonElement>(".commit-bar-actions button")]
    .map((button) => `${(button.textContent ?? "").trim() || button.getAttribute("aria-label")}${button.classList.contains("primary") ? " (primary)" : ""}`);

const dialog = () => domWindow.document.querySelector('[role="dialog"]') as unknown as HTMLElement | null;

async function click(control: Element | null | undefined) {
  assert.ok(control, "the control is rendered");
  await act(async () => { fireDomEvent.click(control as HTMLElement); await Promise.resolve(); });
}

async function typeInto(control: HTMLInputElement | HTMLTextAreaElement, value: string) {
  await act(async () => { fireDomEvent.change(control, { target: { value } }); });
}

/** A dialog field by its visible label. */
function dialogField(label: string): HTMLInputElement {
  const element = [...dialog()!.querySelectorAll("label")].find((candidate) => candidate.textContent === label);
  assert.ok(element, `the dialog has a ${label} field`);
  return domWindow.document.getElementById(element.getAttribute("for")!) as unknown as HTMLInputElement;
}

/* -------------------------------------------------------------------------- */
/* Cases                                                                      */
/* -------------------------------------------------------------------------- */

test("the commit message and Commit Staged sit in the panel's foot, not the scroller", async () => {
  const harness = await mountReview();
  try {
    const commitBar = bar(harness.container);
    assertNoDomNode(commitBar.closest(".rpanel-scroll"), "nothing of the bar is in the scroller");
    assert.equal(commitBar.querySelector("label")?.textContent, "Commit Message");
    assert.equal(commitBar.querySelector(".commit-bar-count")?.textContent, "1 of 3 files staged");
    assert.equal(commitBar.querySelector("input")?.value, "Speed Up Checkout", "the message defaults to the session title");
    assert.deepEqual(actionRow(harness.container), ["Open Pull Request…", "Commit Staged (primary)", "More Commit Options (primary)"]);
    assert.ok(commitBar.querySelector(".split"), "Commit Staged is a split button");
    for (const retired of [".git-action", ".git-inline", ".git-ok", ".hint"]) {
      assertNoDomNode(harness.container.querySelector(retired), `${retired} is gone`);
    }
  } finally {
    await harness.unmount();
  }
});

test("Commit All Changes is reached only from the split button's menu, with its description", async () => {
  const harness = await mountReview();
  try {
    assert.equal(named(harness.container, "Commit All").length + named(harness.container, "Commit All Changes").length, 0,
      "no Commit All button stands beside Commit Staged");
    await click(only(bar(harness.container), "More Commit Options"));
    const item = domWindow.document.querySelector('[role="menu"] [role="menuitem"]') as unknown as HTMLElement;
    assert.equal(item.querySelector(".menu-desc")?.textContent, "All 3 files, including unstaged and untracked ones.");
    assert.match(item.textContent ?? "", /^Commit All Changes/);
    await click(item);
    assert.deepEqual(harness.sent.map((request) => request.action === "commit" && request.all), [true]);
    assert.match(bar(harness.container).textContent ?? "", /Committed 1 staged file as 9d2a7da\./);
  } finally {
    await harness.unmount();
  }
});

test("with nothing staged the primary is Commit, without a menu", async () => {
  const harness = await mountReview({ status: statusOf({ stagedCount: 0 }) });
  try {
    assert.deepEqual(actionRow(harness.container), ["Open Pull Request…", "Commit (primary)"]);
    assertNoDomNode(bar(harness.container).querySelector(".split"), "no split button");
    assert.equal(bar(harness.container).querySelector(".commit-bar-count")?.textContent, "3 uncommitted files");
    await click(only(bar(harness.container), "Commit"));
    assert.deepEqual(harness.sent, [{ action: "commit", message: "Speed Up Checkout", expectStaged: false }]);
  } finally {
    await harness.unmount();
  }
});

test("with nothing to commit, Open Pull Request… is the primary and Commit says why it can't run", async () => {
  const harness = await mountReview({ status: CLEAN });
  try {
    // The DOM keeps the request button first in every state; the disabled Commit is drawn before it.
    assert.deepEqual(actionRow(harness.container), ["Open Pull Request… (primary)", "Commit"]);
    const commit = only(bar(harness.container), "Commit");
    assert.ok(commit.classList.contains("commit-bar-idle-commit"), "Commit is drawn first, so the primary stays last");
    assert.equal(commit.disabled, true);
    const reason = domWindow.document.getElementById(commit.getAttribute("aria-describedby")!);
    assert.equal(reason?.textContent, "Nothing to commit.", "the reason is visible text the button points to");
    assert.equal(only(bar(harness.container), "Open Pull Request…").disabled, false);
  } finally {
    await harness.unmount();
  }
});

test("with an open pull request the secondary pushes to it, without renaming the branch", async () => {
  const harness = await mountReview({ forgeFacts: { pr: openPr, checks: null } });
  try {
    assert.deepEqual(actionRow(harness.container), ["Push to Pull Request", "Commit Staged (primary)", "More Commit Options (primary)"]);
    harness.reply({ pr: { url: openPr.url, branch: "agent/commit-bar", pushed: true, createdWithGh: true, created: true, provider: "github", kind: "pull_request" } });
    await click(only(bar(harness.container), "Push to Pull Request"));
    assert.deepEqual(harness.sent, [{ action: "open_pr", title: "Speed up checkout", body: "", branch: "", message: "Speed Up Checkout" }]);
    assertNoDomNode(dialog(), "no dialog");
    assert.match(bar(harness.container).textContent ?? "", /Pushed to the pull request\./);
    assert.equal(only(bar(harness.container), "Open on GitHub").getAttribute("href"), openPr.url);
  } finally {
    await harness.unmount();
  }
});

test("a rejected push shows in the commit bar with Try Again and Show Details, and nothing at the top", async () => {
  const harness = await mountReview({ forgeFacts: { pr: openPr, checks: null } });
  try {
    harness.reply({ error: REJECTED });
    await click(only(bar(harness.container), "Push to Pull Request"));

    const notice = bar(harness.container).querySelector<HTMLElement>(".notice.t-danger");
    assert.ok(notice, "the failure is a danger notice in the bar");
    assert.equal(notice.getAttribute("role"), "alert");
    assert.equal(notice.querySelector(".notice-body")?.textContent,
      "The remote rejected the push because it has commits this branch doesn't. Bring the branch up to date, then try again.");
    assert.doesNotMatch(notice.textContent ?? "", /failed to push some refs/, "Git's output stays behind Show Details");
    assertNoDomNode(harness.container.querySelector(".rpanel-scroll .notice.t-danger"), "nothing renders at the top of the panel");

    await click(only(notice, "Show Details"));
    assert.equal(notice.querySelector(".code-well pre")?.textContent, REJECTED);

    harness.reply({ pr: { url: openPr.url, branch: "agent/commit-bar", pushed: true, createdWithGh: true, created: true, provider: "github", kind: "pull_request" } });
    await click(only(notice, "Try Again"));
    assert.equal(harness.sent.length, 2, "Try Again sends the push again");
    assert.deepEqual(harness.sent[1], harness.sent[0]);
    assertNoDomNode(bar(harness.container).querySelector(".notice.t-danger"), "the newest result replaces the failure");
    assert.equal(bar(harness.container).querySelectorAll(".notice").length, 1, "one notice at a time");
  } finally {
    await harness.unmount();
  }
});

test("a failed commit says so in plain words in the bar, and Try Again commits again", async () => {
  const harness = await mountReview();
  try {
    harness.reply({ error: "fatal: unable to write new index file" });
    await click(only(bar(harness.container), "Commit Staged"));
    const notice = bar(harness.container).querySelector<HTMLElement>(".notice.t-danger")!;
    assert.equal(notice.querySelector(".notice-body")?.textContent, "Couldn't commit the changes. Try again.");
    await click(only(notice, "Try Again"));
    assert.deepEqual(harness.sent.map((request) => request.action), ["commit", "commit"]);
    assert.match(bar(harness.container).textContent ?? "", /Committed 1 staged file as 9d2a7da\./);
  } finally {
    await harness.unmount();
  }
});

test("a staged set that moved under Commit Staged warns in the bar, not at the top", async () => {
  const harness = await mountReview();
  try {
    harness.reply({ error: "the staged set changed since this panel was loaded", code: "GIT_STALE" });
    await click(only(bar(harness.container), "Commit Staged"));
    assert.equal(bar(harness.container).querySelector(".notice.t-warning .notice-body")?.textContent,
      "The staged files changed since Review loaded. Check them, then commit again.");
    assertNoDomNode(harness.container.querySelector(".rpanel-scroll .notice.t-warning"));
  } finally {
    await harness.unmount();
  }
});

test("a successful commit reads as a sentence with the hash in mono and Copy Hash", async () => {
  const harness = await mountReview();
  try {
    harness.reply({ commit: { sha: "9d2a7da", message: "Speed Up Checkout", filesChanged: 5, stagedOnly: true } });
    await click(only(bar(harness.container), "Commit Staged"));
    const notice = bar(harness.container).querySelector<HTMLElement>(".notice.t-success")!;
    assert.equal(notice.querySelector(".notice-body")?.textContent, "Committed 5 staged files as 9d2a7da.");
    assert.equal(notice.querySelector(".notice-body code")?.textContent, "9d2a7da");
    assert.ok(only(notice, "Copy Hash"));
    assert.doesNotMatch(harness.container.textContent ?? "", /✓|Staged Only|\(\d+ Files?/u);
  } finally {
    await harness.unmount();
  }
});

test("an empty commit message is a field error, and nothing is sent", async () => {
  const harness = await mountReview();
  try {
    const input = bar(harness.container).querySelector("input")!;
    await typeInto(input, "  ");
    await click(only(bar(harness.container), "Commit Staged"));
    assert.deepEqual(harness.sent, []);
    assert.equal(input.getAttribute("aria-invalid"), "true");
    assert.equal(domWindow.document.getElementById(input.getAttribute("aria-describedby")!)?.textContent, "Enter a commit message.");
  } finally {
    await harness.unmount();
  }
});

test("the dialog opens a pull request: it closes, the summary gains the row and the bar offers Open on GitHub", async () => {
  const harness = await mountReview({ status: statusOf({ stagedCount: 3 }) });
  try {
    await click(only(bar(harness.container), "Open Pull Request…"));
    assert.equal(dialog()?.querySelector(".modal-title, h2")?.textContent, "Open Pull Request");
    assert.equal(dialogField("Title").value, "Speed Up Checkout");
    assert.equal(dialogField("Branch (Optional)").getAttribute("aria-describedby") &&
      domWindow.document.getElementById(dialogField("Branch (Optional)").getAttribute("aria-describedby")!)?.textContent,
    "Defaults to the agent's branch.");
    assertNoDomNode(dialog()!.querySelector(".notice"), "everything is staged, so there is no partial-stage warning");

    await typeInto(dialogField("Description (Optional)") as unknown as HTMLTextAreaElement, "Totals use quantity.");
    harness.reply({ pr: { url: "https://github.com/acme/shop/pull/77", branch: "agent/commit-bar", pushed: true, createdWithGh: true, created: true, provider: "github", kind: "pull_request" } });
    await click(only(dialog()!, "Open Pull Request"));

    assert.deepEqual(harness.sent, [{ action: "open_pr", title: "Speed Up Checkout", body: "Totals use quantity.", branch: "", message: "Speed Up Checkout" }]);
    assertNoDomNode(dialog(), "the dialog closes");
    const row = harness.container.querySelector('.review-summary [role="group"][aria-label="Pull Request"]');
    assert.ok(row, "the summary gains the Pull Request row");
    assert.match(row.textContent ?? "", /Speed Up Checkout/);
    const notice = bar(harness.container).querySelector<HTMLElement>(".notice.t-success")!;
    assert.equal(notice.querySelector(".notice-body")?.textContent, "Pull request opened.");
    const link = only(notice, "Open on GitHub") as unknown as HTMLAnchorElement;
    assert.equal(link.localName, "a");
    assert.ok(link.classList.contains("btn"), "an a.btn, which never underlines");
    assert.equal(link.getAttribute("href"), "https://github.com/acme/shop/pull/77");
    assert.deepEqual(actionRow(harness.container).slice(0, 1), ["Push to Pull Request"], "the bar now pushes to it");
  } finally {
    await harness.unmount();
  }
});

test("a prefilled-link fallback is a warning with Finish on GitHub", async () => {
  const harness = await mountReview({ status: CLEAN });
  try {
    await click(only(bar(harness.container), "Open Pull Request…"));
    harness.reply({ pr: {
      url: "https://github.com/acme/shop/compare/main...agent/commit-bar?expand=1", branch: "agent/commit-bar", pushed: true,
      createdWithGh: false, created: false, provider: "github", kind: "pull_request",
      notice: "Only the branch was pushed. Authenticate the GitHub CLI to create the pull request here.",
    } });
    await click(only(dialog()!, "Open Pull Request"));
    assertNoDomNode(dialog());
    const notice = bar(harness.container).querySelector<HTMLElement>(".notice.t-warning")!;
    assert.equal(notice.querySelector(".notice-body")?.textContent, "Pushed the branch. Finish opening the pull request on GitHub.");
    assert.match(only(notice, "Finish on GitHub").getAttribute("href")!, /compare\/main\.\.\.agent/);
    assertNoDomNode(harness.container.querySelector('.review-summary [aria-label="Pull Request"]'), "no request was opened");
  } finally {
    await harness.unmount();
  }
});

test("the dialog's own failures stay in the dialog: a missing title under the field, a push failure above the footer", async () => {
  const harness = await mountReview();
  try {
    await click(only(bar(harness.container), "Open Pull Request…"));
    assert.equal(dialog()!.querySelector(".notice.t-warning")?.textContent,
      "Commit the staged changes first. Opening a pull request won't commit a partial stage.",
      "a partial stage is warned about before anything is sent");

    await typeInto(dialogField("Title"), "");
    await click(only(dialog()!, "Open Pull Request"));
    assert.deepEqual(harness.sent, [], "nothing is sent without a title");
    assert.equal(dialogField("Title").getAttribute("aria-invalid"), "true");
    assert.equal(dialog()!.querySelector(".field-error")?.textContent, "Enter a title for the pull request.");

    await typeInto(dialogField("Title"), "Speed up checkout");
    harness.reply({ error: "Command failed: git push\nfatal: Authentication failed for 'https://github.com/acme/shop.git/'" });
    await click(only(dialog()!, "Open Pull Request"));
    const notice = dialog()!.querySelector<HTMLElement>(".notice.t-danger")!;
    assert.equal(notice.querySelector(".notice-body")?.textContent,
      "Git couldn't sign in to the remote. Check this machine's Git credentials, then try again.");
    assertNoDomNode(bar(harness.container).querySelector(".notice"), "the bar shows nothing while the dialog reports it");
  } finally {
    await harness.unmount();
  }
});

test("GitLab sessions read Merge Request in the button, the dialog title and the notices", async () => {
  const harness = await mountReview({ status: statusOf({ remoteUrl: "https://gitlab.com/acme/shop.git", stagedCount: 3 }) });
  try {
    await click(only(bar(harness.container), "Open Merge Request…"));
    assert.equal(dialog()?.querySelector(".modal-title, h2")?.textContent, "Open Merge Request");
    harness.reply({ pr: { url: "https://gitlab.com/acme/shop/-/merge_requests/9", branch: "agent/commit-bar", pushed: true, createdWithGh: false, created: true, provider: "gitlab", kind: "merge_request" } });
    await click(only(dialog()!, "Open Merge Request"));
    const notice = bar(harness.container).querySelector<HTMLElement>(".notice.t-success")!;
    assert.equal(notice.querySelector(".notice-body")?.textContent, "Merge request opened.");
    assert.ok(only(notice, "Open on GitLab"));
    assert.deepEqual(actionRow(harness.container).slice(0, 1), ["Push to Merge Request"]);
    assert.doesNotMatch(bar(harness.container).textContent ?? "", /Pull Request|pull request/);
  } finally {
    await harness.unmount();
  }
});

test("with the runner offline both actions are disabled and Reconnect to commit. is visible", async () => {
  const harness = await mountReview({ runnerOnline: false });
  try {
    const reason = bar(harness.container).querySelector(".commit-bar-reason");
    assert.equal(reason?.textContent, "Reconnect to commit.");
    for (const name of ["Commit Staged", "Open Pull Request…"]) {
      const button = only(bar(harness.container), name);
      assert.equal(button.disabled, true, `${name} is disabled`);
      assert.equal(button.getAttribute("aria-describedby"), reason?.id, `${name} points to the reason`);
    }
    await harness.render({ status: CLEAN });
    assert.equal(bar(harness.container).querySelector(".commit-bar-reason")?.textContent, "Reconnect to commit.",
      "offline is the reason even with nothing to commit");
  } finally {
    await harness.unmount();
  }
});

test("a result belongs to its session: switching sessions clears the bar's notice", async () => {
  const harness = await mountReview();
  try {
    await click(only(bar(harness.container), "Commit Staged"));
    assert.ok(bar(harness.container).querySelector(".notice"));
    await harness.render({ session: { ...baseSession, id: "session-other" } });
    assertNoDomNode(bar(harness.container).querySelector(".notice"));
  } finally {
    await harness.unmount();
  }
});

/* Cross-model review round 1 (#2893) */

test("Try Again waits on the same gates as the bar: not while a hunk stage is in flight", async () => {
  const harness = await mountReview();
  try {
    harness.reply({ error: "fatal: unable to write new index file" });
    await click(only(bar(harness.container), "Commit Staged"));
    const retry = () => only(bar(harness.container), "Try Again");
    assert.equal(retry().disabled, false);

    const release = harness.hold();
    await click(named(harness.container, "Stage")[0]);
    assert.equal(retry().disabled, true, "a stage RPC holds Try Again, as it holds Commit Staged");
    await click(retry());
    assert.deepEqual(harness.sent.map((request) => request.action), ["commit"], "nothing more is sent");
    await release();
    assert.equal(retry().disabled, false);
  } finally {
    await harness.unmount();
  }
});

test("the dialog can't open a request once the runner disconnects, and says why in its footer", async () => {
  const harness = await mountReview();
  try {
    await click(only(bar(harness.container), "Open Pull Request…"));
    await harness.render({ runnerOnline: false });
    const primary = only(dialog()!, "Open Pull Request");
    assert.equal(primary.disabled, true);
    const reason = domWindow.document.getElementById(primary.getAttribute("aria-describedby")!);
    assert.equal(reason?.textContent, "Reconnect to open the pull request.");
    assert.ok(reason?.closest(".modal-foot"), "the reason is the footer's left slot");
    await act(async () => {
      fireDomEvent.submit(dialog()!.querySelector("form")!);
      await Promise.resolve();
    });
    assert.deepEqual(harness.sent, [], "neither the button nor Enter sends anything");
  } finally {
    await harness.unmount();
  }
});

test("a request opened after a session switch still releases the drafts it consumed", async () => {
  const harness = await mountReview();
  try {
    await click(only(bar(harness.container), "Open Pull Request…"));
    await typeInto(dialogField("Description (Optional)") as unknown as HTMLTextAreaElement, "Submitted once.");
    const release = harness.hold();
    harness.reply({ pr: { url: "https://github.com/acme/shop/pull/77", branch: "agent/commit-bar", pushed: true, createdWithGh: true, created: true, provider: "github", kind: "pull_request" } });
    await click(only(dialog()!, "Open Pull Request"));

    await harness.render({ session: { ...baseSession, id: "session-other" } });
    await release();
    assertNoDomNode(bar(harness.container).querySelector(".notice"), "the other session shows no result");

    await harness.render({ session: baseSession });
    await click(only(bar(harness.container), "Open Pull Request…"));
    assert.equal(dialogField("Description (Optional)").value, "", "the submitted description was released");
  } finally {
    await harness.unmount();
  }
});

test("a newly opened request is followed even while the forge still reports an older, closed one", async () => {
  const closed: GitPrSummary = { ...openPr, number: 42, state: "CLOSED", title: "An older attempt" };
  const oldChecks: GitChecksSummary = { failing: 1, pending: 0, passing: 3, failingNames: ["old-pr-build"], url: "https://github.com/acme/shop/pull/42/checks" };
  const harness = await mountReview({ forgeFacts: { pr: closed, checks: oldChecks } });
  try {
    assert.deepEqual(actionRow(harness.container).slice(0, 1), ["Open Pull Request…"], "a closed request is not pushed to");
    await click(only(bar(harness.container), "Open Pull Request…"));
    harness.reply({ pr: { url: "https://github.com/acme/shop/pull/99", branch: "agent/commit-bar", pushed: true, createdWithGh: true, created: true, provider: "github", kind: "pull_request" } });
    await click(only(dialog()!, "Open Pull Request"));

    const row = () => harness.container.querySelector('.review-summary [role="group"][aria-label="Pull Request"]');
    assert.equal(row()?.querySelector("a")?.getAttribute("href"), "https://github.com/acme/shop/pull/99");
    assert.deepEqual(actionRow(harness.container).slice(0, 1), ["Push to Pull Request"]);
    assert.doesNotMatch(row()?.textContent ?? "", /fail/i, "the older request's failing checks are not the new one's");
    assert.equal(named(harness.container, "Ask Agent to Fix").length, 0, "nor is their Fix action offered");

    // The forge catches up with the new request; its own row takes over.
    const reported: GitPrSummary = { ...openPr, number: 99, url: "https://github.com/acme/shop/pull/99", title: "Reported by the forge" };
    await harness.render({ forgeFacts: { pr: reported, checks: null } });
    assert.match(row()?.textContent ?? "", /Reported by the forge/);
  } finally {
    await harness.unmount();
  }
});

/* Cross-model review round 2 (#2893) */

test("pushing to an open request releases the commit message it committed with, and only that", async () => {
  const harness = await mountReview({ forgeFacts: { pr: openPr, checks: null } });
  try {
    const input = () => bar(harness.container).querySelector("input")!;
    await typeInto(input(), "fix: totals use quantity");
    harness.reply({ pr: { url: openPr.url, branch: "agent/commit-bar", pushed: true, createdWithGh: true, created: true, provider: "github", kind: "pull_request" } });
    await click(only(bar(harness.container), "Push to Pull Request"));
    assert.equal((harness.sent[0] as { message?: string }).message, "fix: totals use quantity");
    assert.equal(input().value, "fix: totals use quantity", "the message stays on screen for the next commit");

    // A remount reads what scratch kept: the consumed message is gone, as after a commit.
    await harness.render({ session: { ...baseSession, id: "session-other" } });
    await harness.render({ session: baseSession });
    assert.equal(input().value, "Speed Up Checkout", "the consumed message is not restored");
  } finally {
    await harness.unmount();
  }
});

/* Cross-model review round 3 (#2893) */

test("a push to an open request that forge tooling couldn't confirm still reads as pushed, to that request", async () => {
  const harness = await mountReview({ forgeFacts: { pr: openPr, checks: null } });
  try {
    const input = () => bar(harness.container).querySelector("input")!;
    await typeInto(input(), "fix: totals use quantity");
    harness.reply({ pr: {
      url: "https://github.com/acme/shop/compare/main...agent/commit-bar?expand=1", branch: "agent/commit-bar", pushed: true,
      createdWithGh: false, created: false, provider: "github", kind: "pull_request",
      notice: "Only the branch was pushed. Authenticate the GitHub CLI to create the pull request here.",
    } });
    await click(only(bar(harness.container), "Push to Pull Request"));

    const notice = bar(harness.container).querySelector<HTMLElement>(".notice")!;
    assert.ok(notice.classList.contains("t-success"), "not a Finish warning: the request already exists");
    assert.equal(notice.querySelector(".notice-body")?.textContent, "Pushed to the pull request.");
    assert.equal(only(notice, "Open on GitHub").getAttribute("href"), openPr.url, "the link is the open request's");

    await harness.render({ session: { ...baseSession, id: "session-other" } });
    await harness.render({ session: baseSession });
    assert.equal(input().value, "Speed Up Checkout", "the message the push committed with is released");
  } finally {
    await harness.unmount();
  }
});

/* Cross-model review epoch 2 round 1 (#2893) */

/** Let Modal's deferred focus restoration run. */
const settleFocus = () => act(async () => { await new Promise((resolve) => setTimeout(resolve, 0)); });

/** Where focus is, as text: asserting on DOM nodes would make a failure print the whole document. */
const focusedName = () => {
  const active = domWindow.document.activeElement as unknown as HTMLElement | null;
  if (!active || active === (domWindow.document.body as unknown as HTMLElement)) return "<body>";
  return `${active.localName}: ${active.getAttribute("aria-label") ?? (active.textContent ?? "").trim() ?? ""}${active.id ? ` #${active.id}` : ""}`;
};

test("Cancel returns focus to Open Pull Request…", async () => {
  const harness = await mountReview();
  try {
    const opener = only(bar(harness.container), "Open Pull Request…");
    opener.focus();
    await click(opener);
    await click(only(dialog()!, "Cancel"));
    await settleFocus();
    assert.equal(focusedName(), "button: Open Pull Request…");
  } finally {
    await harness.unmount();
  }
});

test("a request opened while the status refresh holds the bar keeps keyboard position in the bar", async () => {
  const harness = await mountReview();
  try {
    const opener = only(bar(harness.container), "Open Pull Request…");
    opener.focus();
    await click(opener);
    harness.reply({ pr: { url: "https://github.com/acme/shop/pull/77", branch: "agent/commit-bar", pushed: true, createdWithGh: true, created: true, provider: "github", kind: "pull_request" } });
    const release = harness.hold();
    await act(async () => {
      fireDomEvent.submit(dialog()!.querySelector("form")!);
      await Promise.resolve();
    });
    // A status read is in flight as the request lands, so the bar is held when the dialog closes.
    await harness.render({ gitBusy: true });
    await release();
    await settleFocus();
    assertNoDomNode(dialog(), "the dialog closed");
    const pushButton = only(bar(harness.container), "Push to Pull Request");
    assert.equal(pushButton.disabled, false, "a hold is not disabled, which would drop the focus");
    assert.equal(pushButton.getAttribute("aria-disabled"), "true", "it is held: aria-disabled");
    assert.equal(focusedName(), "button: Push to Pull Request", "focus returns to the opener, not the page");
    await click(pushButton);
    assert.equal(harness.sent.length, 1, "a held button refuses presses");
  } finally {
    await harness.unmount();
  }
});

/* Cross-model review epoch 2 round 2 (#2893) */

test("a dialog dismissed while its request runs leaves focus on the request button through a clean status", async () => {
  const harness = await mountReview({ status: statusOf({ stagedCount: 3 }) });
  try {
    const opener = only(bar(harness.container), "Open Pull Request…");
    opener.focus();
    await click(opener);
    harness.reply({ pr: { url: "https://github.com/acme/shop/pull/77", branch: "agent/commit-bar", pushed: true, createdWithGh: true, created: true, provider: "github", kind: "pull_request" } });
    const release = harness.hold();
    await act(async () => {
      fireDomEvent.submit(dialog()!.querySelector("form")!);
      await Promise.resolve();
    });
    await act(async () => { fireDomEvent.keyDown(dialog()!, { key: "Escape" }); });
    await settleFocus();
    assertNoDomNode(dialog(), "Escape closed the dialog while the request ran");
    assert.equal(focusedName(), "button: Open Pull Request…", "focus is back on the running opener");

    await release();
    await harness.render({ status: CLEAN });
    await settleFocus();
    assert.equal(focusedName(), "button: Push to Pull Request", "the same button, relabelled, still has focus");
  } finally {
    await harness.unmount();
  }
});

test("a commit that leaves nothing to commit hands focus to the request action", async () => {
  const harness = await mountReview({ status: statusOf({ stagedCount: 3 }) });
  try {
    const commit = only(bar(harness.container), "Commit Staged");
    commit.focus();
    await click(commit);
    await harness.render({ status: CLEAN });
    await settleFocus();
    assert.equal(focusedName(), "button: Open Pull Request…", "not the page");
  } finally {
    await harness.unmount();
  }
});

test("Try Again takes its notice away and leaves focus on the action it started", async () => {
  const harness = await mountReview();
  try {
    harness.reply({ error: "fatal: unable to write new index file" });
    await click(only(bar(harness.container), "Commit Staged"));
    const retry = only(bar(harness.container), "Try Again");
    retry.focus();
    const release = harness.hold();
    await click(retry);
    await settleFocus();
    assertNoDomNode(bar(harness.container).querySelector(".notice"), "the notice went as the action started");
    assert.equal(focusedName(), "button: Commit Staged", "focus is on the running Commit Staged");
    await release();
  } finally {
    await harness.unmount();
  }
});
