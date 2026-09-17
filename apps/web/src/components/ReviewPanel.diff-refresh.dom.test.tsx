import assert from "node:assert/strict";
import { after, before, mock, test } from "node:test";
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

function diffOf(seed: string, files: GitDiffFile[]): GitDiffInfo {
  return {
    scope: "uncommitted",
    diffHash: hash(seed),
    fineDiffHash: hash(seed === "1" ? "9" : "8"),
    stats: { filesChanged: files.length, insertions: files.length, deletions: files.length },
    files,
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

  const client = {
    ...api,
    gitDiff: async (_id: string, scope: string) => {
      diffCalls.push(scope);
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

test("a first status observation after the diff loaded does not spend a redundant read", async () => {
  const harness = await mountPanel({ status: null });
  try {
    assert.deepEqual(harness.diffCalls, ["uncommitted"]);
    await harness.render({ status: statusOf() });
    assert.deepEqual(harness.diffCalls, ["uncommitted"],
      "the diff was read at least as recently as this status, so it is adopted rather than re-proven");
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
