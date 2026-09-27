import assert from "node:assert/strict";
import { after, before, beforeEach, test } from "node:test";
import React, { act } from "react";
import { fireDomEvent } from "./test-dom-events.js";
import { createRoot } from "react-dom/client";
import { Window } from "happy-dom";
import type {
  GitActionRequest,
  GitDiffFile,
  GitDiffInfo,
  GitStatusInfo,
  ReviewFindingsResponse,
  SessionCommandPermission,
  SessionView,
} from "@wollipog/protocol";
import { api, type ApiClient } from "../api.js";
import { ApiProvider } from "../api-context.js";
import { installDomTestCleanup } from "../dom-test-cleanup.js";
import { FeedbackContext } from "./FeedbackProvider.js";
import { ReviewPanel } from "./ReviewPanel.js";
import { clearPanelScratch } from "../right-panel-scratch.js";
import type { GitStatus } from "./useGitStatus.js";

/**
 * A person the server refuses Git actions to (#1870) sees every Git action in the Review pane —
 * Commit, Commit All, Push & Open Pull Request, Sync GitHub, hunk and line Stage or Unstage, and
 * Discard — disabled and described by one visible refusal, and none of them reaches the API. An
 * allowed or absent verdict leaves them as before.
 */

const domWindow = new Window({ url: "http://localhost/" });
installDomTestCleanup(domWindow);
const globals: Record<string, unknown> = {
  window: domWindow,
  document: domWindow.document,
  localStorage: domWindow.localStorage,
  navigator: domWindow.navigator,
  HTMLElement: domWindow.HTMLElement,
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

// Panel scratch survives unmount on purpose (#1202), and these cases share one session id.
beforeEach(() => clearPanelScratch());

/* -------------------------------------------------------------------------- */
/* Fixtures                                                                   */
/* -------------------------------------------------------------------------- */

const VIEWER = "Your Viewer role is read-only.";
const hash = (seed: string) => seed.repeat(64).slice(0, 64);

function file(path: string): GitDiffFile {
  return {
    path,
    status: "modified",
    binary: false,
    hunks: [{
      header: "@@ -1,2 +1,2 @@",
      oldStart: 1,
      oldCount: 2,
      newStart: 1,
      newCount: 2,
      lines: [
        { status: " ", text: "alpha" },
        { status: "-", text: "old" },
        { status: "+", text: "new" },
      ],
    }],
  };
}

const diff: GitDiffInfo = {
  scope: "uncommitted",
  diffHash: hash("1"),
  fineDiffHash: hash("9"),
  stagedDiffHash: hash("2"),
  unstagedDiffHash: hash("3"),
  stats: { filesChanged: 1, insertions: 1, deletions: 1 },
  stagedStats: { filesChanged: 0, insertions: 0, deletions: 0 },
  unstagedStats: { filesChanged: 1, insertions: 1, deletions: 1 },
  files: [file("src/a.ts")],
  stagedFiles: [],
  unstagedFiles: [file("src/a.ts")],
};

/** One staged file, so Commit All is offered next to Commit. */
const status: GitStatusInfo = {
  branch: "agent/session-1",
  files: [{ status: "M", path: "src/a.ts" }],
  hasChanges: true,
  ahead: 0,
  remoteUrl: null,
  headSha: "abc1234",
  stagedCount: 1,
  addedLines: 1,
  deletedLines: 1,
};

const baseSession: SessionView = {
  id: "session-1",
  runnerId: "runner-1",
  workspaceId: null,
  workspaceName: null,
  projectId: null,
  agentId: "claude",
  agentName: "Claude",
  title: "Git Permissions Fixture",
  status: "idle",
  column: "review",
  runId: null,
  useWorktree: true,
  worktreePath: "/repo/.agent-worktrees/session-1",
  archived: false,
  createdAt: 1,
  updatedAt: 1,
  lastEventAt: null,
  messageCount: 0,
  eventEpoch: 0,
  preview: null,
  pendingApproval: null,
  driver: "claude-code",
  model: null,
  effort: null,
  permissionMode: null,
  tokensIn: 0,
  tokensOut: 0,
  costUsd: 0,
  adopted: false,
};

function sessionWith(gitActions: SessionCommandPermission | undefined): SessionView {
  if (!gitActions) return baseSession;
  return {
    ...baseSession,
    commandPermissions: {
      stop: { allowed: true },
      restart: { allowed: true },
      stopBackgroundJob: { allowed: true },
      gitActions,
    },
  };
}

const noFindings: ReviewFindingsResponse = {
  findings: [],
  summary: { total: 0, unresolved: 0, requiredUnresolved: 0, sent: 0, resolved: 0, dismissed: 0, completion: "complete" },
};

/* -------------------------------------------------------------------------- */
/* Harness                                                                    */
/* -------------------------------------------------------------------------- */

async function mountPanel(initial: SessionView) {
  const host = domWindow.document.createElement("div");
  domWindow.document.body.appendChild(host);
  const root = createRoot(host as unknown as Element);
  const calls: string[] = [];
  // Confirmations are answered by the test, so a verdict can change while one is open.
  const confirmations: Array<(answer: boolean) => void> = [];
  const feedback = {
    confirm: () => new Promise<boolean>((resolve) => { confirmations.push(resolve); }),
    showToast: () => -1,
    showUndo: () => -1,
    dismissToast: () => {},
  };
  const client = {
    ...api,
    gitDiff: async () => ({ diff }),
    reviewFindings: async () => noFindings,
    git: async (_id: string, body: GitActionRequest) => {
      calls.push(body.action);
      if (body.action === "github_review_sync" || body.action === "forge_review_sync") throw new Error("sync stub");
      return {};
    },
    gitStageHunk: async (_id: string, body: { direction: string }) => { calls.push(`hunk:${body.direction}`); return { status, diff }; },
    gitStageLines: async (_id: string, body: { direction: string }) => { calls.push(`lines:${body.direction}`); return { status, diff }; },
    gitDiscardFile: async (_id: string, body: { filePath: string }) => { calls.push(`discard:${body.filePath}`); return { status, diff }; },
  } as unknown as ApiClient;
  const git: GitStatus = {
    status,
    observation: 1,
    observedAt: 1,
    settled: true,
    busy: false,
    error: null,
    errorCode: null,
    refresh: async () => {},
    refreshStatusOnly: async () => {},
    install: () => {},
    mutationRevision: 0,
  };
  const tree = (session: SessionView) => (
    <FeedbackContext.Provider value={feedback}>
      <ApiProvider client={client}>
        <ReviewPanel
          session={session}
          runnerOnline
          runnerProtocolVersion={157}
          git={git}
          onOpenSourceLocation={() => {}}
        />
      </ApiProvider>
    </FeedbackContext.Provider>
  );
  await act(async () => { root.render(tree(initial)); });
  const container = host as unknown as HTMLElement;
  assert.ok(container.querySelector(".diff-file"), "the diff has loaded");
  return {
    container,
    calls,
    confirmations,
    render: async (session: SessionView) => { await act(async () => { root.render(tree(session)); }); },
    unmount: async () => {
      await act(async () => { root.unmount(); });
      host.remove();
    },
  };
}

/* -------------------------------------------------------------------------- */
/* Queries                                                                    */
/* -------------------------------------------------------------------------- */

function onlyButton(scope: Element, label: string): HTMLButtonElement {
  const found = [...scope.querySelectorAll<HTMLButtonElement>("button")]
    .filter((button) => (button.textContent ?? "").trim() === label);
  assert.equal(found.length, 1, `exactly one ${label} control`);
  return found[0]!;
}

async function choosePane(container: HTMLElement, label: "All Changes" | "Unstaged") {
  const pane = container.querySelector('[role="radiogroup"][aria-label="Index Pane"]');
  assert.ok(pane, "the index pane choice is rendered");
  await act(async () => { fireDomEvent.click(onlyButton(pane, label)); });
}

/** The Git actions on the All Changes pane: the panel's own, then the diff's hunk Stage and Discard. */
function combinedControls(container: HTMLElement): Array<[string, HTMLButtonElement]> {
  return ["Commit staged", "Commit All", "Push & Open Pull Request", "Sync GitHub", "Stage", "Discard"]
    .map((label) => [label, onlyButton(container, label)]);
}

/** The Git actions on the Unstaged pane: line staging and the selection boxes that feed it. */
function lineControls(container: HTMLElement): Array<[string, HTMLButtonElement | HTMLInputElement]> {
  const boxes = [...container.querySelectorAll<HTMLInputElement>('input[type="checkbox"][aria-label^="Select "]')]
    .filter((box) => /^Select (added|removed) line /u.test(box.getAttribute("aria-label")!));
  assert.equal(boxes.length, 2, "each changed line can be selected");
  return [
    ["Stage hunk", onlyButton(container, "Stage hunk")],
    ["Stage Selected (0)", onlyButton(container, "Stage Selected (0)")],
    ...boxes.map((box) => [box.getAttribute("aria-label")!, box] as [string, HTMLInputElement]),
  ];
}

function refusalId(container: HTMLElement): string {
  const reason = [...container.querySelectorAll<HTMLElement>("[id]")]
    .find((node) => node.id.endsWith("-git-refusal"));
  assert.ok(reason, "the refusal is rendered in the panel");
  assert.equal(reason.textContent, VIEWER);
  return reason.id;
}

function assertRefused(container: HTMLElement, name: string, control: HTMLButtonElement | HTMLInputElement) {
  assert.equal(control.disabled, true, `${name} is disabled`);
  if (control.tagName === "BUTTON") {
    assert.equal(control.getAttribute("title"), VIEWER, `${name} carries the reason as its title`);
  }
  const ids = (control.getAttribute("aria-describedby") ?? "").split(/\s+/u).filter(Boolean);
  assert.ok(ids.includes(refusalId(container)), `${name} is described by the refusal`);
}

/* -------------------------------------------------------------------------- */
/* Cases                                                                      */
/* -------------------------------------------------------------------------- */

test("a refused person sees every Git action disabled with the reason, and nothing is sent (#1870)", async () => {
  const harness = await mountPanel(sessionWith({ allowed: false, reason: VIEWER }));
  try {
    const combined = combinedControls(harness.container);
    for (const [name, button] of combined) assertRefused(harness.container, name, button);
    for (const [, button] of combined) {
      await act(async () => { fireDomEvent.click(button); await Promise.resolve(); });
    }
    assert.equal(harness.confirmations.length, 0, "Discard opens no confirmation");

    await choosePane(harness.container, "Unstaged");
    const lines = lineControls(harness.container);
    for (const [name, control] of lines) assertRefused(harness.container, name, control);
    for (const [, control] of lines) {
      await act(async () => { fireDomEvent.click(control); await Promise.resolve(); });
    }
    assert.equal(onlyButton(harness.container, "Stage Selected (0)").disabled, true, "no line could be selected");

    assert.deepEqual(harness.calls, []);
    assert.equal(onlyButton(harness.container, "Refresh Git Status").disabled, false,
      "reads are not Git actions this verdict disables in the panel");
  } finally {
    await harness.unmount();
  }
});

test("a refusal that arrives while Discard's confirmation is open sends nothing (#1870)", async () => {
  const harness = await mountPanel(sessionWith({ allowed: true }));
  try {
    await act(async () => { fireDomEvent.click(onlyButton(harness.container, "Discard")); });
    assert.equal(harness.confirmations.length, 1, "the confirmation is open");

    await harness.render(sessionWith({ allowed: false, reason: VIEWER }));
    assertRefused(harness.container, "Discard", onlyButton(harness.container, "Discard"));
    await act(async () => { harness.confirmations[0]!(true); await Promise.resolve(); });
    assert.deepEqual(harness.calls, [], "confirming after the refusal arrived sends nothing");
  } finally {
    await harness.unmount();
  }
});

test("an allowed or absent verdict leaves every Git action as it was (#1870)", async () => {
  for (const verdict of [{ allowed: true } as const, undefined]) {
    clearPanelScratch(); // the pane chosen below would otherwise carry into the next verdict
    const harness = await mountPanel(sessionWith(verdict));
    try {
      assert.equal([...harness.container.querySelectorAll("[id]")].some((node) => node.id.endsWith("-git-refusal")), false,
        "no refusal is shown");
      for (const [name, button] of combinedControls(harness.container)) {
        assert.equal(button.disabled, false, `${name} is enabled`);
        assert.equal(button.getAttribute("aria-describedby"), null, `${name} has no refusal description`);
      }
      assert.equal(onlyButton(harness.container, "Commit All").getAttribute("title"),
        "Ignore the staged selection and commit every change in the worktree", "Commit All keeps its own title");
      assert.equal(onlyButton(harness.container, "Discard").getAttribute("title"),
        "Discard all staged and unstaged changes to this tracked file", "Discard keeps its own title");

      await act(async () => { fireDomEvent.click(onlyButton(harness.container, "Sync GitHub")); });
      await act(async () => { fireDomEvent.click(onlyButton(harness.container, "Stage")); });
      await act(async () => { fireDomEvent.click(onlyButton(harness.container, "Discard")); });
      await act(async () => { harness.confirmations[0]!(true); await Promise.resolve(); });
      await act(async () => { fireDomEvent.click(onlyButton(harness.container, "Commit staged")); });
      await act(async () => { fireDomEvent.click(onlyButton(harness.container, "Commit All")); });
      await act(async () => { fireDomEvent.click(onlyButton(harness.container, "Push & Open Pull Request")); });
      await choosePane(harness.container, "Unstaged");
      for (const [name, control] of lineControls(harness.container)) {
        assert.equal(control.disabled, name === "Stage Selected (0)", `${name} is enabled unless nothing is selected`);
        assert.equal(control.getAttribute("aria-describedby"), null, `${name} has no refusal description`);
      }
      await act(async () => { fireDomEvent.click(onlyButton(harness.container, "Stage hunk")); });
      assert.deepEqual(harness.calls, [
        "forge_review_sync",
        "hunk:stage",
        "discard:src/a.ts",
        "commit",
        "commit",
        "open_pr",
        "lines:stage",
      ]);
    } finally {
      await harness.unmount();
    }
  }
});
