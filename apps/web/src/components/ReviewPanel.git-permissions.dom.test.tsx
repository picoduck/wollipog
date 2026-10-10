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
import { assertNoDomNode } from "../dom-test-assertions.js";
import { FeedbackContext } from "./FeedbackProvider.js";
import { ReviewPanel } from "./ReviewPanel.js";
import { PanelActionSlotContext } from "./RightPanel.js";
import { clearPanelScratch } from "../right-panel-scratch.js";
import type { GitStatus } from "./useGitStatus.js";

/**
 * A person the server refuses Git actions to (#1870) sees every Git action in the Review pane —
 * the commit bar's Commit Staged, its More Commit Options menu and Open Pull Request…, Sync GitHub,
 * hunk and line Stage or Unstage, and Discard — disabled and described by one visible refusal, and
 * none of them reaches the API. An allowed or absent verdict leaves them as before.
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

/** One staged file, so Commit Staged is a split button whose menu offers Commit All Changes. */
const status: GitStatusInfo = {
  branch: "agent/session-1",
  files: [{ status: "M", path: "src/a.ts" }],
  hasChanges: true,
  ahead: 0,
  remoteUrl: "https://github.com/acme/app.git",
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
  // The panel header's action slot sits beside the body, as in RightPanel.
  const slot = domWindow.document.createElement("div");
  const body = domWindow.document.createElement("div");
  host.append(slot, body);
  const root = createRoot(body as unknown as Element);
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
        <PanelActionSlotContext.Provider value={slot as unknown as HTMLElement}>
          <ReviewPanel
            session={session}
            runnerOnline
            runnerProtocolVersion={157}
            git={git}
            onOpenSourceLocation={() => {}}
          />
        </PanelActionSlotContext.Provider>
      </ApiProvider>
    </FeedbackContext.Provider>
  );
  await act(async () => { root.render(tree(initial)); });
  const container = host as unknown as HTMLElement;
  assert.ok(container.querySelector(".dfile"), "the diff has loaded");
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
    .filter((button) => ((button.textContent ?? "").trim() || button.getAttribute("aria-label")) === label);
  assert.equal(found.length, 1, `exactly one ${label} control`);
  return found[0]!;
}

/** Choose one View Options item (a Show pane or a Layout); the menu is portalled to the body. */
async function chooseViewOption(container: HTMLElement, label: "All Changes" | "Unstaged Only" | "Side by Side") {
  const trigger = container.querySelector<HTMLButtonElement>('button[aria-label="View Options"]');
  assert.ok(trigger, "the View Options button is rendered");
  await act(async () => { fireDomEvent.click(trigger); });
  const item = [...domWindow.document.querySelectorAll('[role="menuitemradio"]')]
    .find((node) => (node.textContent ?? "").trim() === label) as unknown as HTMLElement | undefined;
  assert.ok(item, `View Options offers ${label}`);
  await act(async () => { fireDomEvent.click(item); });
}

/** The Git actions on the All Changes pane: the panel's own, then the diff's Stage Hunk. */
function combinedControls(container: HTMLElement): Array<[string, HTMLButtonElement]> {
  return ["Commit Staged", "More Commit Options", "Open Pull Request…", "Sync GitHub", "Stage Hunk"]
    .map((label) => [label, onlyButton(container, label)]);
}

/** Discard Changes… in the file's actions menu (#2848), opened for the test; the menu is portalled. */
async function discardItem(container: HTMLElement): Promise<HTMLElement> {
  const trigger = container.querySelector<HTMLButtonElement>('button[aria-label="src/a.ts Actions"]');
  assert.ok(trigger, "the file has an actions menu");
  if (trigger.getAttribute("aria-expanded") !== "true") await act(async () => { fireDomEvent.click(trigger); });
  const item = [...(domWindow.document as unknown as Document).querySelectorAll<HTMLElement>('[role="menuitem"]')]
    .find((node) => node.getAttribute("data-menu-label") === "Discard Changes…");
  assert.ok(item, "the menu offers Discard Changes…");
  return item;
}

/**
 * The Git actions on the Unstaged pane: Stage Hunk, and the selection bar's Stage Lines once Select
 * Lines has picked both changed lines (#2849). Picking lines is not a Git action, so it stays open.
 */
async function lineControls(container: HTMLElement): Promise<Array<[string, HTMLButtonElement]>> {
  const toggle = container.querySelector<HTMLButtonElement>('button[aria-label="Select Lines"]');
  assert.ok(toggle, "Review offers Select Lines");
  if (toggle.getAttribute("aria-pressed") !== "true") await act(async () => { fireDomEvent.click(toggle); });
  for (const label of ["Select Removed Line 2", "Select Line 2"]) {
    const line = container.querySelector<HTMLButtonElement>(`button.diff-num[aria-label="${label}"]`);
    assert.ok(line, `${label} can be picked`);
    if (line.getAttribute("aria-pressed") !== "true") await act(async () => { fireDomEvent.click(line); });
  }
  const bar = container.querySelector<HTMLElement>('section[aria-label="Selected Lines"]');
  assert.ok(bar, "the selection bar replaces the commit bar");
  return [["Stage Hunk", onlyButton(container, "Stage Hunk")], ["Stage Lines", onlyButton(bar, "Stage Lines")]];
}

function refusalId(container: HTMLElement): string {
  const reason = [...container.querySelectorAll<HTMLElement>("[id]")]
    .find((node) => node.id.endsWith("-git-refusal"));
  assert.ok(reason, "the refusal is rendered in the panel");
  assert.equal(reason.textContent, VIEWER);
  return reason.id;
}

function assertRefused(container: HTMLElement, name: string, control: HTMLButtonElement | HTMLInputElement) {
  // The selection bar's actions stay focusable to say why (`aria-disabled`); the rest are disabled.
  assert.ok(control.disabled || control.getAttribute("aria-disabled") === "true", `${name} is disabled`);
  assert.equal(control.getAttribute("title"), VIEWER, `${name} carries the reason as its title`);
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
    // Discard stays listed in the file's menu, unavailable with the reason as its second line.
    const discard = await discardItem(harness.container);
    assert.equal(discard.getAttribute("aria-disabled"), "true", "Discard is unavailable");
    assert.equal(discard.querySelector(".menu-desc")?.textContent, VIEWER, "Discard says why");
    await act(async () => { fireDomEvent.click(discard); await Promise.resolve(); });
    assert.equal(harness.confirmations.length, 0, "Discard opens no confirmation");

    await chooseViewOption(harness.container, "Unstaged Only");
    const lines = await lineControls(harness.container);
    for (const [name, control] of lines) assertRefused(harness.container, name, control);
    for (const [, control] of lines) {
      await act(async () => { fireDomEvent.click(control); await Promise.resolve(); });
    }
    assert.ok(harness.container.querySelector('section[aria-label="Selected Lines"]'), "the refused Stage Lines kept the selection");

    // The side-by-side layout picks lines in its own columns.
    await chooseViewOption(harness.container, "Side by Side");
    assert.ok(harness.container.querySelector(".dsplit"), "the diff is side by side");
    for (const [name, control] of await lineControls(harness.container)) assertRefused(harness.container, `split ${name}`, control);

    assert.deepEqual(harness.calls, []);
    assert.equal(harness.container.querySelector<HTMLButtonElement>('button[aria-label="Refresh Review"]')?.disabled, false,
      "reads are not Git actions this verdict disables in the panel");
  } finally {
    await harness.unmount();
  }
});

test("a refusal that arrives while Discard's confirmation is open sends nothing (#1870)", async () => {
  const harness = await mountPanel(sessionWith({ allowed: true }));
  try {
    const discard = await discardItem(harness.container);
    await act(async () => { fireDomEvent.click(discard); });
    assert.equal(harness.confirmations.length, 1, "the confirmation is open");

    await harness.render(sessionWith({ allowed: false, reason: VIEWER }));
    assertRefused(harness.container, "Stage Hunk", onlyButton(harness.container, "Stage Hunk"));
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
      const discard = await discardItem(harness.container);
      assert.equal(discard.getAttribute("aria-disabled"), null, "Discard is available");
      assertNoDomNode(discard.querySelector(".menu-desc"), "with no reason under it");
      await act(async () => { fireDomEvent.click(discard); });

      await act(async () => { fireDomEvent.click(onlyButton(harness.container, "Sync GitHub")); });
      await act(async () => { fireDomEvent.click(onlyButton(harness.container, "Stage Hunk")); });
      await act(async () => { harness.confirmations[0]!(true); await Promise.resolve(); });
      await act(async () => { fireDomEvent.click(onlyButton(harness.container, "Commit Staged")); });
      await act(async () => { fireDomEvent.click(onlyButton(harness.container, "More Commit Options")); });
      const commitAll = [...domWindow.document.querySelectorAll('[role="menuitem"]')]
        .find((item) => (item.textContent ?? "").startsWith("Commit All Changes")) as unknown as HTMLElement;
      await act(async () => { fireDomEvent.click(commitAll); });
      await act(async () => { fireDomEvent.click(onlyButton(harness.container, "Open Pull Request…")); });
      const dialog = domWindow.document.querySelector('[role="dialog"]') as unknown as HTMLElement;
      await act(async () => { fireDomEvent.click(onlyButton(dialog, "Open Pull Request")); });
      await chooseViewOption(harness.container, "Unstaged Only");
      for (const [name, control] of await lineControls(harness.container)) {
        assert.equal(control.disabled, false, `${name} is enabled`);
        assert.equal(control.getAttribute("aria-disabled"), null, `${name} is available`);
        assert.equal(control.getAttribute("aria-describedby"), null, `${name} has no refusal description`);
      }
      await act(async () => { fireDomEvent.click(onlyButton(harness.container, "Stage Hunk")); });
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
