import assert from "node:assert/strict";
import { after, before, beforeEach, mock, test } from "node:test";
import React, { act } from "react";
import { fireDomEvent } from "./test-dom-events.js";
import { createRoot } from "react-dom/client";
import { Window } from "happy-dom";
import type {
  GitDiffFile,
  GitDiffInfo,
  GitHunk,
  GitStatusInfo,
  ReviewFinding,
  ReviewFindingsResponse,
  SessionView,
} from "@wollipog/protocol";
import { api, type ApiClient } from "../api.js";
import { ApiProvider } from "../api-context.js";
import { installDomTestCleanup } from "../dom-test-cleanup.js";
import { ReviewPanel } from "./ReviewPanel.js";
import { clearPanelScratch } from "../right-panel-scratch.js";
import type { GitStatus } from "./useGitStatus.js";

/**
 * The Review pane's refresh path: a diff reload must not destroy what the reviewer is holding
 * (#1203), and the diff must follow the same observation as the header above it (#1204).
 *
 * Driven through the real panel rather than the viewer alone, because both defects live in the seam
 * between them — which state survives a reinstalled diff, and what causes one to be installed.
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

/**
 * Panel scratch survives unmount on purpose (#1202), and these cases share one session id — so
 * without this each test would start holding whatever the previous one typed or chose.
 */
beforeEach(() => clearPanelScratch());

/* -------------------------------------------------------------------------- */
/* Fixtures                                                                   */
/* -------------------------------------------------------------------------- */

const hash = (seed: string) => seed.repeat(64).slice(0, 64);

/** File A: the file the reviewer acts on (stage/unstage), driving the change-set hash. */
function fileA(over: { staged?: boolean; text?: string } = {}): GitDiffFile {
  return {
    path: "src/a.ts",
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
        { status: "-", text: "old-a" },
        { status: "+", text: over.text ?? "new-a" },
      ],
      ...(over.staged === undefined ? {} : { staged: over.staged }),
    }],
  };
}

/** File B: the file the reviewer is reading — a draft and a finding live on its line 10. */
function fileB(over: { context?: string; extraHunks?: number } = {}): GitDiffFile {
  const primary: GitHunk = {
    header: "@@ -10,3 +10,3 @@",
    oldStart: 10,
    oldCount: 3,
    newStart: 10,
    newCount: 3,
    lines: [
      { status: " ", text: over.context ?? "keep" },
      { status: "-", text: "old-b" },
      { status: "+", text: "new-b" },
    ],
  };
  const extras = Array.from({ length: over.extraHunks ?? 0 }, (_unused, offset): GitHunk => ({
    header: `@@ -${100 + offset * 10},1 +${100 + offset * 10},1 @@`,
    oldStart: 100 + offset * 10,
    oldCount: 1,
    newStart: 100 + offset * 10,
    newCount: 1,
    lines: [{ status: "+", text: `extra-${offset}` }],
  }));
  return { path: "src/b.ts", status: "modified", binary: false, hunks: [primary, ...extras] };
}

/**
 * `src/b.ts` with its old-side line 11 as a DELETION (`deleted`) or as unchanged CONTEXT
 * (`context`), the text identical either way.
 *
 * The pair is the point: re-anchoring keys on file, side, and line content, so a finding written on
 * the deleted line stays legitimately anchored once that line becomes context — and must therefore
 * still render somewhere.
 */
function fileBOldSide(shape: "deleted" | "context"): GitDiffFile {
  return {
    path: "src/b.ts",
    status: "modified",
    binary: false,
    hunks: [{
      header: "@@ -10,3 +10,3 @@",
      oldStart: 10,
      oldCount: 3,
      newStart: 10,
      newCount: 3,
      lines: shape === "deleted"
        ? [
            { status: " ", text: "keep" },
            { status: "-", text: "old-side-line" },
            { status: "+", text: "replacement" },
          ]
        : [
            { status: " ", text: "keep" },
            { status: " ", text: "old-side-line" },
            { status: " ", text: "tail" },
          ],
    }],
  };
}

function diffOf(seed: string, files: GitDiffFile[]): GitDiffInfo {
  return {
    scope: "uncommitted",
    diffHash: hash(seed),
    fineDiffHash: hash(seed === "1" ? "9" : "8"),
    stats: { filesChanged: files.length, insertions: files.length, deletions: files.length },
    files,
  };
}

/**
 * A diff carrying the canonical staged/unstaged panes, where `src/b.ts` is byte-identical in both.
 * That identity is the point: it is the only shape in which per-hunk selections could survive a
 * pane switch, so it is what pins the lineage reset.
 */
function panedDiff(seed: string): GitDiffInfo {
  const shared = [fileA(), fileB()];
  return {
    ...diffOf(seed, shared),
    stagedFiles: [fileB()],
    unstagedFiles: [fileB()],
    stagedDiffHash: hash("5"),
    unstagedDiffHash: hash("6"),
    stagedStats: { filesChanged: 1, insertions: 1, deletions: 1 },
    unstagedStats: { filesChanged: 1, insertions: 1, deletions: 1 },
  };
}

function statusOf(over: Partial<GitStatusInfo> = {}): GitStatusInfo {
  return {
    branch: "agent/session-1",
    files: [{ status: "M", path: "src/a.ts" }, { status: "M", path: "src/b.ts" }],
    hasChanges: true,
    ahead: 0,
    remoteUrl: null,
    headSha: "abc1234",
    stagedCount: 0,
    addedLines: 2,
    deletedLines: 2,
    ...over,
  };
}

const session: SessionView = {
  id: "session-1",
  runnerId: "runner-1",
  workspaceId: null,
  workspaceName: null,
  projectId: null,
  agentId: "claude",
  agentName: "Claude",
  title: "Review Refresh Fixture",
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

function findingsResponse(findings: ReviewFinding[]): ReviewFindingsResponse {
  const unresolved = findings.filter((f) => f.status === "open" || f.status === "sent").length;
  return {
    findings,
    summary: {
      total: findings.length,
      unresolved,
      requiredUnresolved: findings.filter((f) => f.required && f.status === "open").length,
      sent: 0,
      resolved: 0,
      dismissed: 0,
      completion: unresolved ? "in_review" : "complete",
    },
  };
}

function findingOnB(over: Partial<ReviewFinding> = {}): ReviewFinding {
  return {
    findingId: "finding-b",
    sessionId: session.id,
    scope: "uncommitted",
    diffHash: hash("1"),
    filePath: "src/b.ts",
    side: "right",
    line: 10,
    body: "this guard is missing",
    severity: "major",
    required: true,
    status: "open",
    source: "local",
    author: { kind: "human", id: "reviewer" },
    createdAt: 1,
    updatedAt: 1,
    ...over,
  };
}

/* -------------------------------------------------------------------------- */
/* Harness                                                                    */
/* -------------------------------------------------------------------------- */

interface Harness {
  container: HTMLElement;
  /** Every scope `api.gitDiff` was asked for, in order — the reload ledger these tests assert on. */
  diffCalls: string[];
  /** Replace what the next `api.gitDiff` resolves with. */
  serveDiff: (diff: GitDiffInfo) => void;
  /** Fail the next `api.gitDiff` calls until `serveDiff` is called again. */
  failDiff: (message: string) => void;
  /** Hold every subsequent `api.gitDiff` open; the returned function releases them all. */
  holdDiff: () => () => Promise<void>;
  /** Hold the next stage reply, returning a resolver for it. */
  holdStage: () => (reply: { diff?: GitDiffInfo; status?: GitStatusInfo }) => Promise<void>;
  render: (over?: { status?: GitStatusInfo | null; sessionStatus?: SessionView["status"] }) => Promise<void>;
  installed: GitStatusInfo[];
  unmount: () => Promise<void>;
}

async function mountPanel(options: {
  diff?: GitDiffInfo;
  status?: GitStatusInfo | null;
  findings?: ReviewFinding[];
  sessionStatus?: SessionView["status"];
} = {}): Promise<Harness> {
  const host = domWindow.document.createElement("div");
  domWindow.document.body.appendChild(host);
  const root = createRoot(host as unknown as Element);

  let served: GitDiffInfo | null = options.diff ?? diffOf("1", [fileA(), fileB()]);
  let failure: string | null = null;
  const diffCalls: string[] = [];
  const installed: GitStatusInfo[] = [];
  let stageGate: ((reply: { diff?: GitDiffInfo; status?: GitStatusInfo }) => void) | null = null;
  let diffHeld = false;
  let heldDiffs: Array<() => void> = [];

  const client = {
    ...api,
    gitDiff: async (_id: string, scope: string) => {
      diffCalls.push(scope);
      if (diffHeld) await new Promise<void>((resolve) => heldDiffs.push(resolve));
      if (failure) throw new Error(failure);
      return { diff: served! };
    },
    reviewFindings: async () => findingsResponse(options.findings ?? []),
    createReviewFinding: async () => findingsResponse(options.findings ?? []),
    gitStageHunk: async () => {
      if (!stageGate) return { status: undefined, diff: served! };
      return await new Promise<{ diff?: GitDiffInfo; status?: GitStatusInfo }>((resolve) => {
        stageGate = (reply) => resolve(reply);
      });
    },
  } as unknown as ApiClient;

  let currentStatus: GitStatusInfo | null = options.status === undefined ? statusOf() : options.status;
  let currentSessionStatus: SessionView["status"] = options.sessionStatus ?? "idle";

  const tree = () => {
    const git: GitStatus = {
      status: currentStatus,
      observation: 1,
      observedAt: 1,
      settled: true,
      busy: false,
      error: null,
      errorCode: null,
      refresh: async () => {},
      refreshStatusOnly: async () => {},
      install: (next) => void installed.push(next),
      mutationRevision: 0,
    };
    return (
      <ApiProvider client={client}>
        <ReviewPanel
          session={{ ...session, status: currentSessionStatus }}
          runnerOnline
          runnerProtocolVersion={157}
          git={git}
          onOpenSourceLocation={() => {}}
        />
      </ApiProvider>
    );
  };

  await act(async () => { root.render(tree()); });

  return {
    container: host as unknown as HTMLElement,
    diffCalls,
    installed,
    serveDiff: (diff) => { served = diff; failure = null; },
    holdDiff: () => {
      diffHeld = true;
      return async () => {
        diffHeld = false;
        const waiting = heldDiffs;
        heldDiffs = [];
        await act(async () => { for (const resolve of waiting) resolve(); });
      };
    },
    failDiff: (message) => { failure = message; },
    holdStage: () => {
      // A sentinel so `gitStageHunk` takes the gated path; it is replaced by the real resolver the
      // moment the panel calls in.
      stageGate = () => {};
      return async (reply) => {
        await act(async () => { stageGate?.(reply); });
      };
    },
    render: async (over = {}) => {
      if ("status" in over) currentStatus = over.status ?? null;
      if (over.sessionStatus) currentSessionStatus = over.sessionStatus;
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

function card(container: HTMLElement, path: string): HTMLElement {
  for (const file of container.querySelectorAll<HTMLElement>(".diff-file")) {
    if (file.querySelector(".diff-file-path")?.textContent?.includes(path)) return file;
  }
  throw new Error(`no diff card for ${path}`);
}

function stageButton(container: HTMLElement, path: string): HTMLElement {
  const found = [...card(container, path).querySelectorAll<HTMLElement>("button.hunk-act")]
    .find((button) => (button.textContent ?? "").trim() === "Stage");
  if (!found) throw new Error(`no Stage control on ${path}`);
  return found;
}

/** One option of the layout segmented control ("Unified" / "Side by Side"). */
function layoutButton(container: HTMLElement, label: string): HTMLElement {
  const group = container.querySelector<HTMLElement>('[aria-label="Diff Layout"]');
  if (!group) throw new Error("the layout control is not rendered");
  const found = [...group.querySelectorAll<HTMLElement>("button")]
    .find((button) => (button.textContent ?? "").trim() === label);
  if (!found) throw new Error(`no layout option labelled ${label}`);
  return found;
}

/** One option of the index-pane segmented control ("All Changes" / "Unstaged" / "Staged"). */
function paneButton(container: HTMLElement, label: string): HTMLElement {
  const group = container.querySelector<HTMLElement>('[aria-label="Index Pane"]');
  if (!group) throw new Error("the index-pane control is not rendered");
  const found = [...group.querySelectorAll<HTMLElement>("button")]
    .find((button) => (button.textContent ?? "").trim() === label);
  if (!found) throw new Error(`no pane option labelled ${label}`);
  return found;
}

/** How many lines the visible hunks report as selected, read off the Stage/Unstage Selected labels. */
function selectedCount(container: HTMLElement): number {
  let total = 0;
  for (const button of container.querySelectorAll<HTMLElement>("button.hunk-act")) {
    const found = /Selected \((\d+)\)/.exec(button.textContent ?? "");
    if (found) total += Number(found[1]);
  }
  return total;
}

/** The diff pane's refresh control, matched on its current label so busy state is asserted, not assumed. */
function refreshDiffButton(container: HTMLElement, label: string): HTMLElement {
  const found = [...container.querySelectorAll<HTMLElement>(".git-diff-controls button")]
    .find((button) => (button.textContent ?? "").trim() === label);
  if (!found) throw new Error(`no diff refresh control labelled ${label}`);
  return found;
}

function commentButton(container: HTMLElement, label: string): HTMLElement {
  const found = container.querySelector<HTMLElement>(`button[aria-label="${label}"]`);
  if (!found) throw new Error(`no comment control labelled ${label}`);
  return found;
}

function editorIn(container: HTMLElement, path: string): HTMLElement | null {
  return card(container, path).querySelector<HTMLElement>(".diff-comment-editor");
}

function requiredEditor(container: HTMLElement, path: string): HTMLElement {
  const editor = editorIn(container, path);
  if (!editor) throw new Error(`no draft editor open in ${path}`);
  return editor;
}

function field<T extends HTMLElement>(scope: HTMLElement, selector: string): T {
  const found = scope.querySelector<T>(selector);
  if (!found) throw new Error(`missing ${selector}`);
  return found;
}

/** A control inside an open draft editor, matched on its label rather than its class list. */
function editorButton(container: HTMLElement, path: string, label: string): HTMLElement {
  const found = [...requiredEditor(container, path).querySelectorAll<HTMLElement>("button")]
    .find((button) => (button.textContent ?? "").trim() === label);
  if (!found) throw new Error(`no ${label} control in the ${path} draft editor`);
  return found;
}

function inlineFindingBodies(container: HTMLElement): string[] {
  return [...container.querySelectorAll(".diff-inline-finding-body")].map((node) => node.textContent ?? "");
}

function staleMarkers(container: HTMLElement): number {
  return container.querySelectorAll(".review-stale").length;
}

/* -------------------------------------------------------------------------- */
/* #1203 — unsent drafts and existing findings survive an unrelated refresh    */
/* -------------------------------------------------------------------------- */

test("staging a hunk in one file leaves an unsent draft in another intact", async () => {
  const harness = await mountPanel();
  try {
    await act(async () => {
      fireDomEvent.click(commentButton(harness.container, "Comment on src/b.ts right line 10"));
    });
    const editor = requiredEditor(harness.container, "src/b.ts");
    await act(async () => {
      const body = field<HTMLTextAreaElement>(editor, "textarea");
      body.value = "half-written finding";
      fireDomEvent.change(body);
    });
    await act(async () => {
      const severity = field<HTMLSelectElement>(requiredEditor(harness.container, "src/b.ts"), "select");
      severity.value = "blocker";
      fireDomEvent.change(severity);
    });
    await act(async () => {
      const required = field<HTMLInputElement>(
        requiredEditor(harness.container, "src/b.ts"),
        ".review-required-toggle input",
      );
      fireDomEvent.change(required, { target: { checked: false } });
    });

    // Staging rehashes the whole change set — that is the reported trigger, and the reply installs
    // a brand-new diff for every file, including the untouched one holding the draft.
    harness.serveDiff(diffOf("2", [fileA({ staged: true }), fileB()]));
    await act(async () => { fireDomEvent.click(stageButton(harness.container, "src/a.ts")); });

    const after = requiredEditor(harness.container, "src/b.ts");
    assert.equal(field<HTMLTextAreaElement>(after, "textarea").value, "half-written finding",
      "the typed text must survive the reinstalled diff");
    assert.equal(field<HTMLSelectElement>(after, "select").value, "blocker", "severity too");
    assert.equal(field<HTMLInputElement>(after, ".review-required-toggle input").checked, false,
      "and the required flag");
  } finally {
    await harness.unmount();
  }
});

test("an unsent draft survives a refresh that rewrites its own file around it", async () => {
  // The stronger half of the criterion: the draft survives "as long as its file and line still
  // exist", so a card the refresh legitimately rebuilds must not take the text with it. Only the
  // lifted store can do this — the card itself is remounted here on purpose.
  const harness = await mountPanel();
  try {
    await act(async () => {
      fireDomEvent.click(commentButton(harness.container, "Comment on src/b.ts right line 10"));
    });
    await act(async () => {
      const body = field<HTMLTextAreaElement>(requiredEditor(harness.container, "src/b.ts"), "textarea");
      body.value = "survives its own file moving";
      fireDomEvent.change(body);
    });

    // A second hunk appears in B; line 10 is untouched, but B's card is rebuilt.
    harness.serveDiff(diffOf("2", [fileA(), fileB({ extraHunks: 1 })]));
    await harness.render({ status: statusOf({ addedLines: 4 }) });
    assert.ok(harness.container.textContent?.includes("extra-0"), "the reload landed");

    assert.equal(
      field<HTMLTextAreaElement>(requiredEditor(harness.container, "src/b.ts"), "textarea").value,
      "survives its own file moving",
    );
  } finally {
    await harness.unmount();
  }
});

const collapseState = (container: HTMLElement, path: string) =>
  field<HTMLElement>(card(container, path), "button.diff-file-head").getAttribute("aria-expanded");

test("a collapsed file stays collapsed when another file's change reloads the diff", async () => {
  const harness = await mountPanel();
  try {
    await act(async () => {
      fireDomEvent.click(field<HTMLElement>(card(harness.container, "src/a.ts"), "button.diff-file-head"));
    });
    assert.equal(collapseState(harness.container, "src/a.ts"), "false");
    assert.equal(collapseState(harness.container, "src/b.ts"), "true");

    // Only B's content moves, and the whole-change-set hash moves with it. A is untouched.
    harness.serveDiff(diffOf("2", [fileA(), fileB({ context: "keep-changed" })]));
    await harness.render({ status: statusOf({ addedLines: 3 }) });

    assert.ok(harness.container.textContent?.includes("keep-changed"), "the reload landed");
    assert.equal(collapseState(harness.container, "src/a.ts"), "false",
      "an untouched file keeps its collapse state across the refresh");
    assert.equal(collapseState(harness.container, "src/b.ts"), "true",
      "and the rewritten file is rebuilt, so its per-hunk selections cannot point at moved text");
  } finally {
    await harness.unmount();
  }
});

test("collapse and show-all survive a refresh that only touches the other file", async () => {
  const harness = await mountPanel({ diff: diffOf("1", [fileA(), fileB({ extraHunks: 4 })]) });
  try {
    await act(async () => {
      fireDomEvent.click(field<HTMLElement>(card(harness.container, "src/b.ts"), "button.diff-more"));
    });
    assert.equal(card(harness.container, "src/b.ts").querySelectorAll(".diff-hunk").length, 5);

    harness.serveDiff(diffOf("2", [fileA({ text: "rewritten-a" }), fileB({ extraHunks: 4 })]));
    await act(async () => { fireDomEvent.click(stageButton(harness.container, "src/a.ts")); });

    assert.equal(card(harness.container, "src/b.ts").querySelectorAll(".diff-hunk").length, 5,
      "B's show-all toggle must outlive a refresh caused by A");
    assert.equal(card(harness.container, "src/b.ts").querySelector("button.diff-more"), null);
  } finally {
    await harness.unmount();
  }
});

test("a finding on an unchanged line stays inline across an unrelated hash change", async () => {
  const harness = await mountPanel({ findings: [findingOnB()] });
  try {
    assert.deepEqual(inlineFindingBodies(harness.container), ["this guard is missing"]);
    assert.equal(staleMarkers(harness.container), 0);

    harness.serveDiff(diffOf("2", [fileA({ staged: true }), fileB()]));
    await act(async () => { fireDomEvent.click(stageButton(harness.container, "src/a.ts")); });

    assert.deepEqual(inlineFindingBodies(harness.container), ["this guard is missing"],
      "src/b.ts line 10 is byte-identical, so the finding is still attached to it");
    assert.equal(staleMarkers(harness.container), 0, "Stale Diff Anchor is reserved for content that moved");
  } finally {
    await harness.unmount();
  }
});

test("a finding goes stale once its own anchored line changes", async () => {
  const harness = await mountPanel({ findings: [findingOnB()] });
  try {
    assert.equal(staleMarkers(harness.container), 0);
    harness.serveDiff(diffOf("2", [fileA(), fileB({ context: "keep-rewritten" })]));
    await harness.render({ status: statusOf({ addedLines: 9 }) });

    assert.deepEqual(inlineFindingBodies(harness.container), [], "the anchored line no longer exists");
    assert.equal(staleMarkers(harness.container), 1, "and the list says so");
  } finally {
    await harness.unmount();
  }
});

test("a draft editor in an untouched hunk is not rebuilt when another hunk of its file changes", async () => {
  // Node identity is the assertion: the text surviving proves the store works, but only the same
  // DOM node proves the editor was never remounted — which is what keeps focus and the caret where
  // the reviewer left them while the agent edits the rest of the file every 10 seconds (#1204).
  const harness = await mountPanel({ diff: diffOf("1", [fileA(), fileB({ extraHunks: 1 })]) });
  try {
    await act(async () => {
      fireDomEvent.click(commentButton(harness.container, "Comment on src/b.ts right line 10"));
    });
    const textarea = field<HTMLTextAreaElement>(requiredEditor(harness.container, "src/b.ts"), "textarea");
    await act(async () => {
      textarea.value = "mid-sentence";
      fireDomEvent.change(textarea);
    });

    // The file's SECOND hunk is rewritten. The drafted hunk is untouched.
    const rewrittenTail = fileB({ extraHunks: 1 });
    rewrittenTail.hunks[1]!.lines = [{ status: "+", text: "rewritten-tail" }];
    harness.serveDiff(diffOf("2", [fileA(), rewrittenTail]));
    await harness.render({ status: statusOf({ addedLines: 6 }) });
    assert.ok(harness.container.textContent?.includes("rewritten-tail"), "the reload landed");

    assert.equal(
      field<HTMLTextAreaElement>(requiredEditor(harness.container, "src/b.ts"), "textarea"),
      textarea,
      "the same textarea node, so focus and caret were never disturbed",
    );
    assert.equal(textarea.value, "mid-sentence");
  } finally {
    await harness.unmount();
  }
});

test("a draft that outlived the line it targets says so instead of submitting silently", async () => {
  const harness = await mountPanel();
  try {
    await act(async () => {
      fireDomEvent.click(commentButton(harness.container, "Comment on src/b.ts right line 10"));
    });
    await act(async () => {
      const body = field<HTMLTextAreaElement>(requiredEditor(harness.container, "src/b.ts"), "textarea");
      body.value = "this context line is wrong";
      fireDomEvent.change(body);
    });
    assert.ok(!harness.container.textContent?.includes("This line changed after you started writing"));

    // The agent rewrites the very line the draft is aimed at. Line 10 still exists, so the draft
    // must survive (#1203) — but its text was written about content that is no longer there.
    harness.serveDiff(diffOf("2", [fileA(), fileB({ context: "keep-rewritten" })]));
    await harness.render({ status: statusOf({ addedLines: 8 }) });

    const editor = requiredEditor(harness.container, "src/b.ts");
    assert.equal(field<HTMLTextAreaElement>(editor, "textarea").value, "this context line is wrong",
      "the typed text still survives, as the criterion requires");
    assert.ok(editor.textContent?.includes("This line changed after you started writing"),
      "and the editor admits the anchor moved");
  } finally {
    await harness.unmount();
  }
});

test("Cancel keeps the whole draft for the next open, while submitting it starts the next one fresh", async () => {
  // Cancel and submit both close the editor, and only what reopens tells them apart: a mis-clicked
  // Cancel must not destroy a half-written finding (#1203), and a sent finding must not come back as
  // a draft. Severity and the required flag are part of the draft, so both are held to the same rule.
  const harness = await mountPanel();
  const editorState = () => {
    const editor = requiredEditor(harness.container, "src/b.ts");
    return {
      body: field<HTMLTextAreaElement>(editor, "textarea").value,
      severity: field<HTMLSelectElement>(editor, "select").value,
      required: field<HTMLInputElement>(editor, ".review-required-toggle input").checked,
    };
  };
  const open = async () => {
    await act(async () => {
      fireDomEvent.click(commentButton(harness.container, "Comment on src/b.ts right line 10"));
    });
  };
  try {
    await open();
    await act(async () => {
      const body = field<HTMLTextAreaElement>(requiredEditor(harness.container, "src/b.ts"), "textarea");
      body.value = "not finished yet";
      fireDomEvent.change(body);
    });
    await act(async () => {
      const severity = field<HTMLSelectElement>(requiredEditor(harness.container, "src/b.ts"), "select");
      severity.value = "nit";
      fireDomEvent.change(severity);
    });
    await act(async () => {
      fireDomEvent.change(
        field<HTMLInputElement>(requiredEditor(harness.container, "src/b.ts"), ".review-required-toggle input"),
        { target: { checked: false } },
      );
    });

    await act(async () => {
      fireDomEvent.click(editorButton(harness.container, "src/b.ts", "Cancel"));
    });
    assert.equal(editorIn(harness.container, "src/b.ts"), null, "cancel closed the editor");
    await open();
    assert.deepEqual(editorState(), { body: "not finished yet", severity: "nit", required: false },
      "cancel only closed the editor; the draft was still there to reopen");

    await act(async () => {
      fireDomEvent.click(editorButton(harness.container, "src/b.ts", "Add Finding"));
    });
    assert.equal(editorIn(harness.container, "src/b.ts"), null, "submitting closed the editor");
    await open();
    assert.deepEqual(editorState(), { body: "", severity: "major", required: true },
      "the submitted draft became a finding, so the next one on this line starts from the defaults");
  } finally {
    await harness.unmount();
  }
});

/* -------------------------------------------------------------------------- */
/* #1287 — the caret survives a rebuild the same way the text does             */
/* -------------------------------------------------------------------------- */

test("a rebuilt draft editor puts the caret back where the reviewer left it", async () => {
  // The drafted hunk changing is the one refresh that still rebuilds this editor after #1203/#1204,
  // and a rebuild restores the body by assigning it — which parks the caret at the end of the text.
  // Mid-sentence is exactly where a half-written finding is being typed, so the offset has to be
  // carried across the rebuild too, not just the characters.
  const harness = await mountPanel();
  try {
    await act(async () => {
      fireDomEvent.click(commentButton(harness.container, "Comment on src/b.ts right line 10"));
    });
    const before = field<HTMLTextAreaElement>(requiredEditor(harness.container, "src/b.ts"), "textarea");
    await act(async () => {
      before.value = "leaks the handle\nsecond thought";
      fireDomEvent.change(before);
    });
    // The reviewer goes back to fix a word in the first line.
    before.setSelectionRange(6, 6);
    assert.equal(before.selectionStart, 6, "the caret really is mid-text before the refresh");

    // The agent rewrites the very line the draft is aimed at, which rebuilds the hunk holding it.
    harness.serveDiff(diffOf("2", [fileA(), fileB({ context: "keep-rewritten" })]));
    await harness.render({ status: statusOf({ addedLines: 8 }) });

    const after = field<HTMLTextAreaElement>(requiredEditor(harness.container, "src/b.ts"), "textarea");
    assert.notEqual(after, before, "a different textarea node, so the editor was genuinely rebuilt");
    assert.equal(after.value, "leaks the handle\nsecond thought", "the text still survives (#1203)");
    assert.deepEqual(
      [after.selectionStart, after.selectionEnd],
      [6, 6],
      "and the caret returns to the offset it was left at, rather than the end of the text",
    );
  } finally {
    await harness.unmount();
  }
});

test("a rebuilt draft editor restores a whole selection, not just a collapsed caret", async () => {
  const harness = await mountPanel();
  try {
    await act(async () => {
      fireDomEvent.click(commentButton(harness.container, "Comment on src/b.ts right line 10"));
    });
    const before = field<HTMLTextAreaElement>(requiredEditor(harness.container, "src/b.ts"), "textarea");
    await act(async () => {
      before.value = "replace this phrase";
      fireDomEvent.change(before);
    });
    // A word selected for replacement is as much "where the reviewer is" as a bare caret.
    before.setSelectionRange(8, 12);

    harness.serveDiff(diffOf("2", [fileA(), fileB({ context: "keep-rewritten" })]));
    await harness.render({ status: statusOf({ addedLines: 8 }) });

    const after = field<HTMLTextAreaElement>(requiredEditor(harness.container, "src/b.ts"), "textarea");
    assert.deepEqual([after.selectionStart, after.selectionEnd], [8, 12]);
  } finally {
    await harness.unmount();
  }
});

test("a submitted draft leaves no caret behind for the next finding written on its line", async () => {
  // Submitting drops the draft, so the offset it was holding must go with it — otherwise the next
  // finding written against this anchor opens with its caret aimed at text that is no longer there.
  const harness = await mountPanel();
  try {
    await act(async () => {
      fireDomEvent.click(commentButton(harness.container, "Comment on src/b.ts right line 10"));
    });
    const first = field<HTMLTextAreaElement>(requiredEditor(harness.container, "src/b.ts"), "textarea");
    await act(async () => {
      first.value = "a finished finding";
      fireDomEvent.change(first);
    });
    first.setSelectionRange(4, 9);
    await act(async () => {
      fireDomEvent.click(editorButton(harness.container, "src/b.ts", "Add Finding"));
    });
    assert.equal(editorIn(harness.container, "src/b.ts"), null, "submitting closed the editor");

    await act(async () => {
      fireDomEvent.click(commentButton(harness.container, "Comment on src/b.ts right line 10"));
    });
    const reopened = field<HTMLTextAreaElement>(requiredEditor(harness.container, "src/b.ts"), "textarea");
    assert.equal(reopened.value, "", "the new draft starts empty");
    assert.deepEqual([reopened.selectionStart, reopened.selectionEnd], [0, 0],
      "and with no caret carried over from the finding that was sent");
  } finally {
    await harness.unmount();
  }
});

test("a draft that was cancelled reopens with its caret intact", async () => {
  // Cancel keeps the text on purpose (#1203), so it must keep the place in it too.
  const harness = await mountPanel();
  try {
    await act(async () => {
      fireDomEvent.click(commentButton(harness.container, "Comment on src/b.ts right line 10"));
    });
    const before = field<HTMLTextAreaElement>(requiredEditor(harness.container, "src/b.ts"), "textarea");
    await act(async () => {
      before.value = "paused mid-thought";
      fireDomEvent.change(before);
    });
    before.setSelectionRange(7, 7);
    await act(async () => {
      fireDomEvent.click(editorButton(harness.container, "src/b.ts", "Cancel"));
    });
    assert.equal(editorIn(harness.container, "src/b.ts"), null, "cancel closed the editor");

    await act(async () => {
      fireDomEvent.click(commentButton(harness.container, "Comment on src/b.ts right line 10"));
    });
    const reopened = field<HTMLTextAreaElement>(requiredEditor(harness.container, "src/b.ts"), "textarea");
    assert.equal(reopened.value, "paused mid-thought");
    assert.deepEqual([reopened.selectionStart, reopened.selectionEnd], [7, 7]);
  } finally {
    await harness.unmount();
  }
});

test("per-hunk line selections do not survive a pane switch, even where the file is identical", async () => {
  // Pane-local anchor identity: a selection made against the unstaged pane must not be reusable in
  // the staged pane, where the same line numbers carry a different anchor identity — and where
  // Attach would emit the other pane's `diffHash` for it.
  const harness = await mountPanel({ diff: panedDiff("1") });
  try {
    await act(async () => { fireDomEvent.click(paneButton(harness.container, "Unstaged")); });
    const selectable = harness.container.querySelectorAll<HTMLInputElement>(
      'input[type="checkbox"][aria-label^="Select removed line"], input[type="checkbox"][aria-label^="Select added line"]',
    );
    assert.ok(selectable.length > 0, "the unstaged pane offers line staging");
    await act(async () => { fireDomEvent.change(selectable[0]!, { target: { checked: true } }); });
    assert.ok(selectedCount(harness.container) > 0, "a line is selected");

    await act(async () => { fireDomEvent.click(paneButton(harness.container, "Staged")); });
    assert.equal(selectedCount(harness.container), 0, "the other pane starts from no selection");
  } finally {
    await harness.unmount();
  }
});

test("a finding carried onto an unchanged old-side line still renders inline", async () => {
  // The gap this closes: re-anchoring keys on file/side/line CONTENT, so a finding written on a
  // deleted line is correctly still anchored once that line becomes unchanged context — it bore no
  // stale marker. But a context row anchors RIGHT in the unified layout, so nothing rendered it: the
  // finding existed, was not stale, and was invisible.
  const harness = await mountPanel({
    diff: diffOf("1", [fileA(), fileBOldSide("deleted")]),
    findings: [findingOnB({ side: "left", line: 11, body: "this deletion is wrong" })],
  });
  try {
    assert.deepEqual(inlineFindingBodies(harness.container), ["this deletion is wrong"]);
    assert.equal(staleMarkers(harness.container), 0);

    harness.serveDiff(diffOf("2", [fileA(), fileBOldSide("context")]));
    await harness.render({ status: statusOf({ addedLines: 3 }) });
    assert.ok(harness.container.textContent?.includes("tail"), "the reload landed");

    assert.equal(staleMarkers(harness.container), 0, "the old-side line 11 content never moved");
    assert.deepEqual(inlineFindingBodies(harness.container), ["this deletion is wrong"],
      "and a finding that is not stale must not be invisible");
  } finally {
    await harness.unmount();
  }
});

test("a draft on an old-side line that became context is still reachable", async () => {
  const harness = await mountPanel({ diff: diffOf("1", [fileA(), fileBOldSide("deleted")]) });
  try {
    await act(async () => {
      fireDomEvent.click(commentButton(harness.container, "Comment on src/b.ts left line 11"));
    });
    await act(async () => {
      const body = field<HTMLTextAreaElement>(requiredEditor(harness.container, "src/b.ts"), "textarea");
      body.value = "why remove this";
      fireDomEvent.change(body);
    });

    harness.serveDiff(diffOf("2", [fileA(), fileBOldSide("context")]));
    await harness.render({ status: statusOf({ addedLines: 3 }) });

    assert.equal(
      field<HTMLTextAreaElement>(requiredEditor(harness.container, "src/b.ts"), "textarea").value,
      "why remove this",
      "a surviving draft the reviewer cannot see is the same as a lost one",
    );
  } finally {
    await harness.unmount();
  }
});

test("the split layout renders extras for an old-side context anchor too", async () => {
  const harness = await mountPanel({
    diff: diffOf("1", [fileA(), fileBOldSide("context")]),
    findings: [findingOnB({ side: "left", line: 11, body: "old-side note" })],
  });
  try {
    assert.deepEqual(inlineFindingBodies(harness.container), ["old-side note"], "unified");
    await act(async () => { fireDomEvent.click(layoutButton(harness.container, "Side by Side")); });
    assert.deepEqual(inlineFindingBodies(harness.container), ["old-side note"], "side by side");
  } finally {
    await harness.unmount();
  }
});

/* -------------------------------------------------------------------------- */
/* #1204 — the diff follows the status reader's observation                    */
/* -------------------------------------------------------------------------- */

test("a status observation that changes the change set reloads the diff, with staging quiescent", async () => {
  const harness = await mountPanel();
  try {
    assert.deepEqual(harness.diffCalls, ["uncommitted"], "one read on mount");

    // A fresh observation of the SAME change set must not spend a request: the 60s poll would
    // otherwise re-read the diff every minute for nothing.
    await harness.render({ status: statusOf() });
    assert.deepEqual(harness.diffCalls, ["uncommitted"], "an unchanged observation costs nothing");

    // Now the reader sees a third file — exactly the header/list-versus-diff disagreement reported.
    harness.serveDiff(diffOf("2", [fileA(), fileB(), {
      path: "src/c.ts", status: "untracked", binary: false, hunks: [],
    }]));
    await harness.render({
      status: statusOf({
        files: [
          { status: "M", path: "src/a.ts" },
          { status: "M", path: "src/b.ts" },
          { status: "??", path: "src/c.ts" },
        ],
      }),
    });

    assert.deepEqual(harness.diffCalls, ["uncommitted", "uncommitted"], "the diff followed the observation");
    assert.ok(harness.container.textContent?.includes("src/c.ts"), "and the new file is rendered");
  } finally {
    await harness.unmount();
  }
});

test("an in-place edit no status entry can show still reloads the diff", async () => {
  // #1285: the reported gap. The reader observes the same two modified files, the same staged
  // count, and the same line totals — the edit replaced a line rather than adding or removing
  // one — so before the runner published a content identity nothing here moved and the rendered
  // diff sat behind the working tree until the next manual refresh.
  const harness = await mountPanel({ status: statusOf({ contentSignature: hash("a") }) });
  try {
    assert.deepEqual(harness.diffCalls, ["uncommitted"], "one read on mount");

    // Same content, observed again: still no request.
    await harness.render({ status: statusOf({ contentSignature: hash("a") }) });
    assert.deepEqual(harness.diffCalls, ["uncommitted"], "an unchanged observation costs nothing");

    harness.serveDiff(diffOf("2", [fileA({ text: "edited-in-place" }), fileB()]));
    await harness.render({ status: statusOf({ contentSignature: hash("b") }) });

    assert.deepEqual(harness.diffCalls, ["uncommitted", "uncommitted"], "the diff followed the edit");
    assert.ok(harness.container.textContent?.includes("edited-in-place"), "and the new content is rendered");
  } finally {
    await harness.unmount();
  }
});

test("a runner that publishes no content identity keeps the observation watcher quiet", async () => {
  // A pre-v165 runner omits the field entirely. That must read as "unknown", never as movement:
  // a signature that changed on every poll would re-read the diff once a minute forever.
  const harness = await mountPanel({ status: statusOf() });
  try {
    await harness.render({ status: statusOf() });
    await harness.render({ status: statusOf() });
    assert.deepEqual(harness.diffCalls, ["uncommitted"], "shape-only comparison, exactly as before");
  } finally {
    await harness.unmount();
  }
});

test("a diff read against no observation is verified by the first real one, not assumed current", async () => {
  // The status read completes AFTER this diff read, so it can legitimately describe a change set the
  // diff does not have. Adopting it unverified would leave the header ahead of the diff in silence;
  // one extra read on panel open is the cheaper mistake.
  const harness = await mountPanel({ status: null });
  try {
    assert.deepEqual(harness.diffCalls, ["uncommitted"]);
    await harness.render({ status: statusOf() });
    assert.deepEqual(harness.diffCalls, ["uncommitted", "uncommitted"]);
    // And it settles there rather than re-reading on every subsequent render.
    await harness.render({ status: statusOf() });
    assert.deepEqual(harness.diffCalls, ["uncommitted", "uncommitted"], "one verifying read, then quiet");
  } finally {
    await harness.unmount();
  }
});

test("a background reload that supersedes a manual refresh still releases the busy control", async () => {
  // The stuck-forever bug: the background request takes the request token, so the superseded
  // foreground read is barred from clearing `diffBusy`, and the background winner never sets it.
  // Refresh then sits disabled on "Loading…" for the life of the panel.
  const harness = await mountPanel();
  try {
    const releaseForeground = harness.holdDiff();
    await act(async () => { fireDomEvent.click(refreshDiffButton(harness.container, "↻ Refresh")); });
    assert.equal(refreshDiffButton(harness.container, "Loading…").hasAttribute("disabled"), true);

    // A status observation lands while that read is still out, triggering a background reload that
    // takes the request token — so the foreground read's result will be discarded.
    await harness.render({ status: statusOf({ addedLines: 5 }) });
    // Mount, the manual refresh, then the background reload that supersedes it.
    assert.equal(harness.diffCalls.length, 3, "the background reload superseded the manual one");
    // Released at supersession, not at the discarded response: the manual read can no longer render
    // anything, so leaving the control on "Loading…" would be reporting work that is already void.
    assert.equal(
      refreshDiffButton(harness.container, "↻ Refresh").hasAttribute("disabled"),
      false,
      "ownership of the busy flag moves with the request token",
    );

    await releaseForeground();
    assert.equal(
      refreshDiffButton(harness.container, "↻ Refresh").hasAttribute("disabled"),
      false,
      "and it certainly must not stay disabled once both reads have landed",
    );
  } finally {
    await harness.unmount();
  }
});

test("the active-turn cadence never runs two reads at once, however slow the runner is", async () => {
  // A read slower than the interval would otherwise have every response superseded by the next
  // request — the pane would never update — and in-flight reads would pile up for the whole turn.
  mock.timers.enable({ apis: ["setInterval"] });
  const harness = await mountPanel({ sessionStatus: "running" });
  try {
    const release = harness.holdDiff();
    await act(async () => { mock.timers.tick(10_000); });
    assert.equal(harness.diffCalls.length, 2, "one cadence read launched");
    await act(async () => { mock.timers.tick(10_000); });
    await act(async () => { mock.timers.tick(10_000); });
    assert.equal(harness.diffCalls.length, 2, "and no second read while the first is still out");
    await release();
    await act(async () => { mock.timers.tick(10_000); });
    assert.equal(harness.diffCalls.length, 3, "the cadence resumes once the read lands");
  } finally {
    await harness.unmount();
    mock.timers.reset();
  }
});

test("a successful stage reply answers an earlier failed-refresh warning", async () => {
  const harness = await mountPanel();
  try {
    harness.failDiff("runner is unreachable");
    await harness.render({ status: statusOf({ addedLines: 7 }) });
    assert.ok(harness.container.textContent?.includes("The last automatic refresh of this diff did not land"));

    // The reply carries BOTH halves of a fresh read, and its status is the observation already on
    // screen — so nothing else will re-read, and only the reply itself can answer the warning. A
    // reply without a status would leave the observation unread and a later background read would
    // clear the warning instead, which would not test this at all.
    const settled = statusOf({ addedLines: 7, stagedCount: 1 });
    const resolveStage = harness.holdStage();
    await harness.render({ status: settled });
    const before = harness.diffCalls.length;
    await act(async () => { fireDomEvent.click(stageButton(harness.container, "src/a.ts")); });
    await resolveStage({ diff: diffOf("2", [fileA({ staged: true }), fileB()]), status: settled });

    assert.equal(harness.diffCalls.length, before, "no further read happened, so the reply is what answered it");
    assert.ok(!harness.container.textContent?.includes("The last automatic refresh of this diff did not land"),
      "a stale warning must not outlive the read that answered it");
  } finally {
    await harness.unmount();
  }
});

test("a reload never lands under an in-flight stage, and the panel says the diff is behind", async () => {
  const harness = await mountPanel();
  try {
    const resolveStage = harness.holdStage();
    await act(async () => { fireDomEvent.click(stageButton(harness.container, "src/a.ts")); });
    assert.deepEqual(harness.diffCalls, ["uncommitted"], "the stage is in flight");

    harness.serveDiff(diffOf("2", [fileA({ staged: true }), fileB()]));
    await harness.render({ status: statusOf({ stagedCount: 1, addedLines: 5 }) });
    assert.deepEqual(harness.diffCalls, ["uncommitted"],
      "the observation is deferred rather than clobbering the stage reply");
    assert.ok(
      harness.container.textContent?.includes("The changes on disk moved since this diff was read"),
      "and the deferral is visible, not silent",
    );
    assert.ok(
      [...harness.container.querySelectorAll("button")].some((b) => (b.textContent ?? "").includes("Refresh Diff")),
      "with a one-click read",
    );

    // The reply carries no status, so the deferred observation is still unread — it runs now.
    await resolveStage({ diff: diffOf("2", [fileA({ staged: true }), fileB()]) });
    assert.deepEqual(harness.diffCalls, ["uncommitted", "uncommitted"], "the deferred reload ran once free");
  } finally {
    await harness.unmount();
  }
});

test("during an active turn the diff re-reads on a bounded cadence", async () => {
  mock.timers.enable({ apis: ["setInterval"] });
  const harness = await mountPanel({ sessionStatus: "running" });
  try {
    assert.deepEqual(harness.diffCalls, ["uncommitted"]);
    harness.serveDiff(diffOf("2", [fileA({ text: "written-by-the-agent" }), fileB()]));
    await act(async () => { mock.timers.tick(10_000); });
    assert.deepEqual(harness.diffCalls, ["uncommitted", "uncommitted"],
      "the pane follows the agent's edits instead of freezing until the turn settles");
    assert.ok(harness.container.textContent?.includes("written-by-the-agent"));

    await act(async () => { mock.timers.tick(10_000); });
    assert.equal(harness.diffCalls.length, 3, "and keeps to the cadence");
  } finally {
    await harness.unmount();
    mock.timers.reset();
  }
});

test("foregrounding the tab mid-turn catches the diff up at once instead of waiting out a tick", async () => {
  // A hidden tab skips its cadence reads, so without the catch-up the reviewer would come back to a
  // diff up to a whole interval behind the agent's edits.
  const ownVisibility = Object.getOwnPropertyDescriptor(domWindow.document, "visibilityState");
  const setVisibility = (value: "hidden" | "visible") => {
    Object.defineProperty(domWindow.document, "visibilityState", { configurable: true, value });
  };
  mock.timers.enable({ apis: ["setInterval"] });
  const harness = await mountPanel({ sessionStatus: "running" });
  try {
    assert.deepEqual(harness.diffCalls, ["uncommitted"]);
    setVisibility("hidden");
    harness.serveDiff(diffOf("2", [fileA({ text: "written-while-hidden" }), fileB()]));
    await act(async () => { mock.timers.tick(10_000); });
    await act(async () => { domWindow.document.dispatchEvent(new domWindow.Event("visibilitychange")); });
    assert.deepEqual(harness.diffCalls, ["uncommitted"], "a hidden tab spends nothing, on a tick or on the event");

    setVisibility("visible");
    await act(async () => { domWindow.document.dispatchEvent(new domWindow.Event("visibilitychange")); });
    assert.deepEqual(harness.diffCalls, ["uncommitted", "uncommitted"],
      "the catch-up read ran on foregrounding, with no tick in between");
    assert.ok(harness.container.textContent?.includes("written-while-hidden"), "and its diff is rendered");
  } finally {
    await harness.unmount();
    mock.timers.reset();
    if (ownVisibility) Object.defineProperty(domWindow.document, "visibilityState", ownVisibility);
    else Reflect.deleteProperty(domWindow.document, "visibilityState");
  }
});

test("a stage reply that lands after a scope switch leaves the new scope's read in charge", async () => {
  // The reply describes the Uncommitted scope the reviewer has since left. Installing it would render
  // nothing (the viewer gates on the response's own scope), and superseding the new scope's pending
  // read would discard the one response that could — wedging the pane on "Loading diff…".
  const harness = await mountPanel();
  try {
    // The reply's status is already the observation on screen, as it is once the real status reader
    // installs it — so the observation watcher has nothing unread and cannot re-read its way out of a
    // wedged pane. Only the reply's own handling decides the outcome.
    const staged = statusOf({ stagedCount: 1 });
    await harness.render({ status: staged });
    const resolveStage = harness.holdStage();
    await act(async () => { fireDomEvent.click(stageButton(harness.container, "src/a.ts")); });

    const releaseBranch = harness.holdDiff();
    const branchButton = [...harness.container.querySelectorAll<HTMLElement>('[aria-label="Diff Scope"] button')]
      .find((button) => (button.textContent ?? "").trim() === "Branch");
    if (!branchButton) throw new Error("no Branch scope option");
    await act(async () => { fireDomEvent.click(branchButton); });
    // Mount, the watcher's read of the staged observation, then the Branch read.
    assert.deepEqual(harness.diffCalls, ["uncommitted", "uncommitted", "all_branch"], "the Branch read is in flight");

    await resolveStage({ diff: diffOf("2", [fileA({ staged: true }), fileB()]), status: staged });
    assert.deepEqual(harness.installed, [staged], "the reply's status is still installed — it is scope-free");

    harness.serveDiff({ ...diffOf("3", [fileA({ text: "branch-only" })]), scope: "all_branch" });
    await releaseBranch();
    assert.equal(harness.diffCalls.length, 3, "no further read, so the pending Branch read is what rendered");
    assert.ok(harness.container.textContent?.includes("branch-only"), "the Branch read rendered");
    assert.ok(!harness.container.textContent?.includes("Loading diff…"), "and the pane is not wedged loading");
  } finally {
    await harness.unmount();
  }
});

test("the cadence stops when the turn settles, leaving the settle read as the last word", async () => {
  mock.timers.enable({ apis: ["setInterval"] });
  const harness = await mountPanel({ sessionStatus: "running" });
  try {
    await harness.render({ sessionStatus: "idle" });
    const settled = harness.diffCalls.length;
    await act(async () => { mock.timers.tick(60_000); });
    assert.equal(harness.diffCalls.length, settled, "no interval survives the turn boundary");
  } finally {
    await harness.unmount();
    mock.timers.reset();
  }
});

test("a failed background reload keeps the diff on screen and offers a manual read", async () => {
  const harness = await mountPanel();
  try {
    harness.failDiff("runner is unreachable");
    await harness.render({ status: statusOf({ addedLines: 7 }) });

    assert.deepEqual(harness.diffCalls, ["uncommitted", "uncommitted"]);
    assert.ok(harness.container.querySelector(".diff-file"), "the diff the reviewer was reading is still there");
    assert.equal(harness.container.querySelector(".composer-error"), null,
      "a background failure does not hijack the error surface");
    assert.ok(
      harness.container.textContent?.includes("The last automatic refresh of this diff did not land"),
      "but it is not silent either",
    );
    assert.ok(harness.container.querySelector(".hint.warn"), "a persistent lag warrants the amber hint");
    assert.ok(!harness.container.textContent?.includes("Amber only"),
      "the rationale beside that class is a comment, not rendered copy");
  } finally {
    await harness.unmount();
  }
});
