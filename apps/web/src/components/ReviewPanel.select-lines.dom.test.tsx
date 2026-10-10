import { fireDomEvent } from "./test-dom-events.js";
import assert from "node:assert/strict";
import { after, before, beforeEach, test } from "node:test";
import React, { act } from "react";
import { createRoot } from "react-dom/client";
import { Window } from "happy-dom";
import type {
  CreateReviewFindingRequest,
  CreateWorkspaceReferenceRequest,
  GitDiffFile,
  GitDiffInfo,
  GitStatusInfo,
  ReviewFindingsResponse,
  SessionView,
  SourceLocation,
} from "@wollipog/protocol";
import { api, ApiError, type ApiClient } from "../api.js";
import { ApiProvider } from "../api-context.js";
import { installDomTestCleanup } from "../dom-test-cleanup.js";
import { assertNoDomNode } from "../dom-test-assertions.js";
import { clearPanelScratch } from "../right-panel-scratch.js";
import { StoreProvider } from "../store.js";
import { UI_SOCKET_OPEN, type UiConnectionRuntime } from "../ui-transport.js";
import { FeedbackContext } from "./FeedbackProvider.js";
import { GitDiffViewer } from "./GitDiffViewer.js";
import { RightPanel, useRightPanelState, type RightPanelState } from "./RightPanel.js";
import type { GitStatus } from "./useGitStatus.js";

/**
 * Select Lines (#2849): Review's one way to pick diff lines. No line renders a checkbox; a line
 * number opens the line's menu; the selection bar replaces the commit bar and attaches, stages and
 * copies; and Escape clears the selection before it can close the panel.
 */

const domWindow = new Window({ url: "http://localhost/" });
installDomTestCleanup(domWindow);
let coarsePointer = false;
Object.defineProperty(domWindow, "matchMedia", {
  configurable: true,
  writable: true,
  value: (query: string) => ({
    get matches() {
      return query === "(pointer: coarse)" ? coarsePointer : false;
    },
    media: query,
    onchange: null,
    addEventListener() {},
    removeEventListener() {},
    addListener() {},
    removeListener() {},
    dispatchEvent: () => false,
  }),
});
let clipboardText: string | null = null;
Object.defineProperty(domWindow.navigator, "clipboard", {
  configurable: true,
  value: { writeText: async (text: string) => { clipboardText = text; } },
});
const globals: Record<string, unknown> = {
  window: domWindow,
  document: domWindow.document,
  localStorage: domWindow.localStorage,
  navigator: domWindow.navigator,
  HTMLElement: domWindow.HTMLElement,
  HTMLButtonElement: domWindow.HTMLButtonElement,
  Element: domWindow.Element,
  Node: domWindow.Node,
  Event: domWindow.Event,
  InputEvent: domWindow.InputEvent,
  MouseEvent: domWindow.MouseEvent,
  KeyboardEvent: domWindow.KeyboardEvent,
  ResizeObserver: domWindow.ResizeObserver,
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

beforeEach(() => {
  domWindow.localStorage.clear();
  clearPanelScratch();
  coarsePointer = false;
  clipboardText = null;
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

/** src/a.ts: an edit that adds new lines 2 to 4, then a one-line change at 21/22. */
const fileA: GitDiffFile = {
  path: "src/a.ts",
  status: "modified",
  binary: false,
  hunks: [
    {
      header: "@@ -1,3 +1,5 @@",
      oldStart: 1, oldCount: 3, newStart: 1, newCount: 5,
      lines: [
        { status: " ", text: "const one = 1;" },
        { status: "-", text: "const two = 2;" },
        { status: "+", text: "const two = 20;" },
        { status: "+", text: "const three = 30;" },
        { status: "+", text: "const four = 40;" },
        { status: " ", text: "const five = 5;" },
      ],
    },
    {
      header: "@@ -20,2 +22,2 @@",
      oldStart: 20, oldCount: 2, newStart: 22, newCount: 2,
      lines: [{ status: " ", text: "// twenty" }, { status: "-", text: "old();" }, { status: "+", text: "renamed();" }],
    },
  ],
};

const diff: GitDiffInfo = {
  scope: "uncommitted",
  diffHash: hash("1"),
  fineDiffHash: hash("9"),
  stagedDiffHash: hash("2"),
  unstagedDiffHash: hash("3"),
  stats: { filesChanged: 1, insertions: 4, deletions: 2 },
  stagedStats: { filesChanged: 0, insertions: 0, deletions: 0 },
  unstagedStats: { filesChanged: 1, insertions: 4, deletions: 2 },
  files: [fileA],
  stagedFiles: [],
  unstagedFiles: [fileA],
};

const status: GitStatusInfo = {
  branch: "agent/session-1",
  files: [{ status: "M", path: "src/a.ts" }],
  hasChanges: true,
  ahead: 0,
  remoteUrl: null,
  headSha: "abc1234",
  stagedCount: 0,
  addedLines: 4,
  deletedLines: 2,
};

const session: SessionView = {
  id: "session-1",
  runnerId: "runner-1",
  workspaceId: null,
  workspaceName: null,
  projectId: null,
  agentId: "claude",
  agentName: "Claude",
  title: "Select Lines Fixture",
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
  eventEpoch: 1,
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

const noFindings: ReviewFindingsResponse = {
  findings: [],
  summary: { total: 0, unresolved: 0, requiredUnresolved: 0, sent: 0, resolved: 0, dismissed: 0, completion: "complete" },
};

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

const connection: UiConnectionRuntime = {
  instanceId: "review-select-lines-test", runtimeKey: "review-select-lines-test",
  createSocket: () => ({ readyState: UI_SOCKET_OPEN, onopen: null, onmessage: null,
    onclose: null, onerror: null, send() {}, close() {} }),
  close() {},
};

/* -------------------------------------------------------------------------- */
/* Harness                                                                    */
/* -------------------------------------------------------------------------- */

interface Calls {
  attached: CreateWorkspaceReferenceRequest[];
  staged: Array<{ direction: string; filePath: string; hunkIndex: number; lineIndices: number[]; diffHash: string }>;
  created: CreateReviewFindingRequest[];
  opened: SourceLocation[];
  toasts: string[];
}

/** Review in the real side panel, so Escape takes the panel's own order. */
async function mountReview(findings: ReviewFindingsResponse = noFindings, { holdAttach = false } = {}) {
  const calls: Calls = { attached: [], staged: [], created: [], opened: [], toasts: [] };
  let served = diff;
  // With `holdAttach`, an attach waits for `releaseAttach`, as a slow request would.
  let releaseAttach = () => {};
  const attachHeld = holdAttach ? new Promise<void>((resolve) => { releaseAttach = resolve; }) : Promise.resolve();
  const client = {
    ...api,
    childSessions: () => Promise.reject(new ApiError("This fixture has no durable child-session registry.", 404)),
    gitDiff: async () => ({ diff: served }),
    reviewFindings: async () => findings,
    createReviewFinding: async (_id: string, body: CreateReviewFindingRequest) => { calls.created.push(body); return noFindings; },
    gitStageLines: async (_id: string, body: Calls["staged"][number]) => { calls.staged.push(body); return { status, diff }; },
  } as unknown as ApiClient;
  const feedback = {
    confirm: async () => false,
    showToast: (message: string) => { calls.toasts.push(message); return 1; },
    showUndo: () => -1,
    dismissToast: () => {},
  };
  let state!: RightPanelState;
  function Harness() {
    state = useRightPanelState();
    return (
      <FeedbackContext.Provider value={feedback}>
        <ApiProvider client={client}><StoreProvider connection={connection}><RightPanel
          state={state}
          session={session}
          runnerOnline
          runnerProtocolVersion={157}
          git={git}
          items={[]}
          onOpenSourceLocation={(location) => { calls.opened.push(location); }}
          onClearSourceLocation={() => {}}
          onOpenTerminal={() => {}}
          onInsertSideChatDraft={() => {}}
          onAttachWorkspaceReference={async (target) => { calls.attached.push(target); await attachHeld; }}
        /></StoreProvider></ApiProvider>
      </FeedbackContext.Provider>
    );
  }
  const host = domWindow.document.createElement("div");
  domWindow.document.body.append(host);
  const container = host as unknown as HTMLElement;
  const root = createRoot(container);
  await act(async () => { root.render(<Harness />); });
  await act(async () => { state.show("review"); });
  assert.ok(container.querySelector(".dfile"), "the diff has loaded");
  return {
    container,
    calls,
    get state() { return state; },
    async releaseAttach() {
      await act(async () => { releaseAttach(); await attachHeld; await Promise.resolve(); });
    },
    /** Serve `next` and reload through the header's Refresh, as a background reload would land. */
    async refreshWith(next: GitDiffInfo) {
      served = next;
      await act(async () => {
        fireDomEvent.click(container.querySelector<HTMLButtonElement>('button[aria-label="Refresh Review"]')!);
        await Promise.resolve();
      });
      await act(async () => { await new Promise((resolve) => setTimeout(resolve, 0)); });
    },
    async unmount() {
      await act(async () => { root.unmount(); });
      host.remove();
    },
  };
}

type Harness = Awaited<ReturnType<typeof mountReview>>;

const doc = () => domWindow.document as unknown as Document;

function button(scope: ParentNode, label: string): HTMLButtonElement {
  const found = scope.querySelector<HTMLButtonElement>(`button[aria-label="${label}"]`)
    ?? [...scope.querySelectorAll<HTMLButtonElement>("button")].find((node) => (node.textContent ?? "").trim() === label);
  assert.ok(found, `${label} is rendered`);
  return found;
}

async function click(target: HTMLElement, init?: { shiftKey?: boolean }) {
  await act(async () => { fireDomEvent.click(target, init); await Promise.resolve(); });
}

async function selectLines(harness: Harness) {
  const toggle = button(harness.container, "Select Lines");
  assert.equal(toggle.getAttribute("aria-pressed"), "false");
  await click(toggle);
  assert.equal(toggle.getAttribute("aria-pressed"), "true");
}

function bar(harness: Harness): HTMLElement | null {
  return harness.container.querySelector<HTMLElement>('section[aria-label="Selected Lines"]');
}

function requiredBar(harness: Harness): HTMLElement {
  const found = bar(harness);
  assert.ok(found, "the selection bar is in the foot");
  return found;
}

/** The visible reason a bar action points at with `aria-describedby`. */
function reasonOf(control: HTMLElement): string {
  const id = control.getAttribute("aria-describedby");
  assert.ok(id, "the action is described by its reason");
  return doc().getElementById(id)?.textContent ?? "";
}

async function chooseViewOption(harness: Harness, label: string) {
  await click(button(harness.container, "View Options"));
  const item = [...doc().querySelectorAll<HTMLElement>('[role="menuitemradio"]')]
    .find((node) => (node.textContent ?? "").trim() === label);
  assert.ok(item, `View Options offers ${label}`);
  await click(item);
}

async function pressEscape(target: Element) {
  const event = new domWindow.KeyboardEvent("keydown", { key: "Escape", bubbles: true, cancelable: true });
  await act(async () => { target.dispatchEvent(event as unknown as Event); });
}

function menuItems(): HTMLElement[] {
  return [...doc().querySelectorAll<HTMLElement>('[role="menu"] [role="menuitem"]')];
}

/* -------------------------------------------------------------------------- */
/* Cases                                                                      */
/* -------------------------------------------------------------------------- */

test("no diff line renders a checkbox in any view, with Select Lines off or on (#2849)", async () => {
  const harness = await mountReview();
  try {
    for (const pane of ["All Changes", "Unstaged Only", "Staged Only", "All Changes"]) {
      await chooseViewOption(harness, pane);
      for (const on of [false, true]) {
        const toggle = harness.container.querySelector<HTMLButtonElement>('button[aria-label="Select Lines"]');
        if (toggle && (toggle.getAttribute("aria-pressed") === "true") !== on) await click(toggle);
        assert.equal(harness.container.querySelectorAll('.diff-view input[type="checkbox"]').length, 0, `${pane}, Select Lines ${on ? "on" : "off"}`);
      }
    }
    // Side by Side needs a wider panel than this DOM has, so its columns are checked on the viewer.
    for (const selecting of [false, true]) {
      const host = domWindow.document.createElement("div");
      domWindow.document.body.append(host);
      const root = createRoot(host as unknown as Element);
      const selection = { selecting, selected: new Set<string>(), onLine: () => {}, onSelectLine: () => {} };
      await act(async () => { root.render(<GitDiffViewer diff={diff} layout="split" selection={selection} onAttachWorkspaceReference={async () => {}} />); });
      assert.ok(host.querySelector(".dsplit"));
      assert.equal(host.querySelectorAll('input[type="checkbox"]').length, 0, `Side by Side, Select Lines ${selecting ? "on" : "off"}`);
      await act(async () => { root.unmount(); });
      host.remove();
    }
  } finally {
    await harness.unmount();
  }
});

test("three contiguous added lines attach the same reference the line boxes did (#2849)", async () => {
  const harness = await mountReview();
  try {
    assert.ok(harness.container.querySelector('section[aria-label="Commit"]'), "the commit bar is in the foot at rest");
    await selectLines(harness);
    assert.ok(harness.container.querySelector(".diff-view.is-selecting"));
    // A click anywhere on the row picks it and leaves focus on its number; Shift-click ranges.
    const row = button(harness.container, "Select Line 2").closest<HTMLElement>(".diff-line")!;
    await click(row.querySelector<HTMLElement>(".diff-text")!);
    assert.equal(button(harness.container, "Select Line 2").getAttribute("aria-pressed"), "true");
    assert.ok(row.classList.contains("is-selected"));
    assert.ok((doc().activeElement as unknown as Element) === button(harness.container, "Select Line 2"), "focus is on the line's number");
    await click(button(harness.container, "Select Line 4"), { shiftKey: true });

    const selected = requiredBar(harness);
    assertNoDomNode(harness.container.querySelector('section[aria-label="Commit"]'), "the selection bar replaces the commit bar");
    assert.match(selected.textContent ?? "", /3 lines selected/u);
    const attach = button(selected, "Attach to Prompt");
    assert.equal(attach.getAttribute("aria-disabled"), null);
    attach.focus();
    await click(attach);
    assert.deepEqual(harness.calls.attached, [{
      path: "src/a.ts", kind: "diff", startLine: 2, endLine: 4, side: "right", diffHash: diff.diffHash, diffScope: "uncommitted",
    }]);
    assertNoDomNode(bar(harness), "attaching clears the selection");
    assert.ok(harness.container.querySelector('section[aria-label="Commit"]'), "and the commit bar comes back");
    assert.ok((doc().activeElement as unknown as Element) === button(harness.container, "Select Lines"),
      "focus goes back to Select Lines as the bar leaves");
  } finally {
    await harness.unmount();
  }
});

test("a gap or two sides keep Attach to Prompt unavailable, with the reason in the bar (#2849)", async () => {
  const harness = await mountReview();
  try {
    await selectLines(harness);
    await click(button(harness.container, "Select Line 2"));
    await click(button(harness.container, "Select Line 4"));
    const attach = button(requiredBar(harness), "Attach to Prompt");
    assert.equal(attach.getAttribute("aria-disabled"), "true");
    assert.equal(reasonOf(attach), "Select one continuous range to attach it.");
    await click(attach);
    assert.deepEqual(harness.calls.attached, []);
  } finally {
    await harness.unmount();
  }
});

test("Stage Lines stages exactly two changed lines of one hunk, and All Changes says why it can't (#2849)", async () => {
  const harness = await mountReview();
  try {
    await selectLines(harness);
    await click(button(harness.container, "Select Line 2"));
    const unavailable = button(requiredBar(harness), "Stage Lines");
    assert.equal(unavailable.getAttribute("aria-disabled"), "true");
    assert.equal(reasonOf(unavailable), "Show Unstaged Only to stage single lines.");
    assert.match(requiredBar(harness).textContent ?? "", /Show Unstaged Only to stage single lines\./u, "the reason is visible");
    await click(unavailable);
    assert.deepEqual(harness.calls.staged, []);

    // A pane switch is another change set: the selection starts again, Select Lines stays on.
    await chooseViewOption(harness, "Unstaged Only");
    assertNoDomNode(bar(harness));
    await click(button(harness.container, "Select Line 1"));
    await click(button(harness.container, "Select Removed Line 2"));
    await click(button(harness.container, "Select Line 2"));
    const stage = button(requiredBar(harness), "Stage Lines");
    assert.equal(stage.getAttribute("aria-disabled"), null);
    await click(stage);
    // The unchanged line 1 is ignored for staging.
    assert.deepEqual(harness.calls.staged, [{
      direction: "stage", filePath: "src/a.ts", hunkIndex: 0, lineIndices: [1, 2], diffHash: diff.fineDiffHash,
    }]);
    assertNoDomNode(bar(harness), "staging clears the selection");
  } finally {
    await harness.unmount();
  }
});

test("lines in two hunks, or only unchanged lines, keep Stage Lines unavailable with the reason (#2849)", async () => {
  const harness = await mountReview();
  try {
    await chooseViewOption(harness, "Unstaged Only");
    await selectLines(harness);
    await click(button(harness.container, "Select Line 1"));
    assert.equal(reasonOf(button(requiredBar(harness), "Stage Lines")), "Select a changed line to stage it.");
    await click(button(harness.container, "Select Line 2"));
    await click(button(harness.container, "Select Line 23"));
    const stage = button(requiredBar(harness), "Stage Lines");
    assert.equal(stage.getAttribute("aria-disabled"), "true");
    assert.equal(reasonOf(stage), "Select lines in one hunk to stage them.");
    await click(stage);
    assert.deepEqual(harness.calls.staged, []);
  } finally {
    await harness.unmount();
  }
});

test("Escape with a selection clears it and keeps the panel open; a second Escape closes the panel (#2849)", async () => {
  const harness = await mountReview();
  try {
    await selectLines(harness);
    await click(button(harness.container, "Select Line 2"));
    assert.ok(bar(harness));
    const number = button(harness.container, "Select Line 2");
    await pressEscape(number);
    assert.equal(harness.state.open, true, "the panel stays open");
    assertNoDomNode(bar(harness), "the selection is cleared");
    assert.equal(button(harness.container, "Select Lines").getAttribute("aria-pressed"), "false", "Select Lines is off");
    assertNoDomNode(harness.container.querySelector(".diff-view.is-selecting"));

    await pressEscape(button(harness.container, "Line 2 Actions"));
    assert.equal(harness.state.open, false, "the second Escape closes the panel");
  } finally {
    await harness.unmount();
  }
});

test("Clear and Copy Lines: Clear keeps Select Lines on, Copy Lines copies the text (#2849)", async () => {
  const harness = await mountReview();
  try {
    await selectLines(harness);
    await click(button(harness.container, "Select Line 3"));
    await click(button(harness.container, "Select Line 1"));
    await click(button(requiredBar(harness), "Copy Lines"));
    assert.equal(clipboardText, "const one = 1;\nconst three = 30;");
    assert.deepEqual(harness.calls.toasts, ["Copied 2 lines."]);
    await click(button(requiredBar(harness), "Clear"));
    assertNoDomNode(bar(harness));
    assert.equal(button(harness.container, "Select Lines").getAttribute("aria-pressed"), "true", "Select Lines stays on");
  } finally {
    await harness.unmount();
  }
});

test("on a coarse pointer no + renders, and the line number's menu adds a finding, selects or opens the line (#2849)", async () => {
  coarsePointer = true;
  const harness = await mountReview();
  try {
    assert.equal(harness.container.querySelectorAll(".diff-add, .diff-add-slot").length, 0, "no + on a coarse pointer");
    const number = button(harness.container, "Line 2 Actions");
    assert.equal(number.getAttribute("aria-haspopup"), "menu");
    await click(number);
    assert.equal(number.getAttribute("aria-expanded"), "true");
    assert.deepEqual(menuItems().map((item) => item.getAttribute("data-menu-label")),
      ["Add Finding…", "Select Line", "Open in Files at Line"]);
    await click(menuItems()[0]!);
    assertNoDomNode(doc().querySelector('[role="menu"]'), "the menu closes");
    const editor = harness.container.querySelector<HTMLElement>(".diff-comment-editor");
    assert.ok(editor, "Add Finding… opens the editor");
    assert.ok(editor.previousElementSibling?.contains(number), "under line 2");
    await act(async () => {
      const body = editor.querySelector<HTMLTextAreaElement>("textarea")!;
      fireDomEvent.change(body, { target: { value: "check the new value" } });
    });
    await click(button(editor, "Add Finding"));
    assert.equal(harness.calls.created.length, 1);
    assert.deepEqual([harness.calls.created[0]!.side, harness.calls.created[0]!.line], ["right", 2], "filed at that line");

    await click(button(harness.container, "Line 2 Actions"));
    await click(menuItems().find((item) => item.getAttribute("data-menu-label") === "Open in Files at Line")!);
    assert.deepEqual(harness.calls.opened, [{ path: "src/a.ts", line: 2 }]);

    // A removed line is not in the file: Open in Files at Line stays listed and says why.
    await click(button(harness.container, "Removed Line 2 Actions"));
    const files = menuItems().find((item) => item.getAttribute("data-menu-label") === "Open in Files at Line")!;
    assert.equal(files.getAttribute("aria-disabled"), "true");
    assert.equal(files.querySelector(".menu-desc")?.textContent, "This line was removed, so Files can't show it.");
    await click(files);
    assert.equal(harness.calls.opened.length, 1);
    await click(menuItems().find((item) => item.getAttribute("data-menu-label") === "Select Line")!);
    assert.equal(button(harness.container, "Select Lines").getAttribute("aria-pressed"), "true", "Select Line turns Select Lines on");
    assert.match(requiredBar(harness).textContent ?? "", /1 line selected/u);
    assert.equal(button(harness.container, "Select Removed Line 2").getAttribute("aria-pressed"), "true", "with that line");
  } finally {
    await harness.unmount();
  }
});

test("with a mouse, each line's gutter offers Add Finding, hidden while selecting (#2849)", async () => {
  const harness = await mountReview();
  try {
    const add = button(harness.container, "Add Finding on Line 2");
    assert.ok(add.closest(".diff-add-slot"), "in the gutter slot");
    const row = add.closest(".diff-line")!;
    const order = [...row.children].map((child) => child.className);
    assert.deepEqual(order.slice(0, 3), ["diff-num", "diff-add-slot", "diff-sign"], "between the numbers and the change marker");
    assert.ok(button(harness.container, "Add Finding on Removed Line 2"));
    await click(add);
    assert.ok(harness.container.querySelector(".diff-comment-editor"), "the + opens the editor");
    await selectLines(harness);
    assert.equal(harness.container.querySelectorAll(".diff-add").length, 0, "no + while Select Lines is on");
    assert.ok(harness.container.querySelectorAll(".diff-add-slot").length > 0, "its slot stays, so the code does not move");
  } finally {
    await harness.unmount();
  }
});

/** `diff` with src/a.ts's hunks replaced, in every pane. */
function withHunks(hunks: GitDiffFile["hunks"]): GitDiffInfo {
  const file = { ...fileA, hunks };
  return { ...diff, files: [file], unstagedFiles: [file] };
}

test("a selection a pane switch or a refresh dropped never comes back (#2849)", async () => {
  const harness = await mountReview();
  try {
    await chooseViewOption(harness, "Unstaged Only");
    await selectLines(harness);
    await click(button(harness.container, "Select Line 2"));
    assert.ok(bar(harness));
    await chooseViewOption(harness, "Staged Only");
    await chooseViewOption(harness, "Unstaged Only");
    assertNoDomNode(bar(harness), "returning to the pane starts from no selection");
    assert.equal(harness.container.querySelectorAll('button.diff-num[aria-pressed="true"]').length, 0);

    // A hunk the refresh took away drops its lines, and they stay dropped when it comes back.
    await click(button(harness.container, "Select Line 23"));
    assert.ok(bar(harness));
    await harness.refreshWith(withHunks([fileA.hunks[0]!]));
    assertNoDomNode(bar(harness), "the hunk is gone, so its line is");
    await harness.refreshWith(diff);
    assert.ok(harness.container.querySelector('button[aria-label="Select Line 23"]'), "the hunk is back");
    assertNoDomNode(bar(harness), "and its line is not selected again");
  } finally {
    await harness.unmount();
  }
});

test("a line menu whose line a refresh rebuilt closes and leaves focus on that line's new number (#2849)", async () => {
  const harness = await mountReview();
  try {
    await click(button(harness.container, "Line 2 Actions"));
    const first = menuItems()[0]!;
    assert.ok((doc().activeElement as unknown as Element) === first, "the menu opens on its first item");
    // The hunk's last line changed, so its rows are rebuilt; line 2 is still there.
    const [hunk, rest] = [fileA.hunks[0]!, fileA.hunks.slice(1)];
    await harness.refreshWith(withHunks([{ ...hunk, lines: [...hunk.lines.slice(0, -1), { status: " ", text: "const five = 50;" }] }, ...rest]));
    assertNoDomNode(doc().querySelector('[role="menu"]'), "the menu closed");
    const active = doc().activeElement as unknown as Element | null;
    assert.ok(active === button(harness.container, "Line 2 Actions"), "focus is on line 2's rebuilt number, not the page");
  } finally {
    await harness.unmount();
  }
});

const fileB: GitDiffFile = {
  path: "src/b.ts",
  status: "modified",
  binary: false,
  hunks: [{
    header: "@@ -1,1 +1,1 @@",
    oldStart: 1, oldCount: 1, newStart: 1, newCount: 1,
    lines: [{ status: "-", text: "export const b = 1;" }, { status: "+", text: "export const b = 2;" }],
  }],
};
const withFiles = (...files: GitDiffFile[]): GitDiffInfo => ({ ...diff, files, unstagedFiles: files });

test("a line menu whose whole file, or every file, a refresh took away leaves focus in the panel (#2849)", async () => {
  const harness = await mountReview();
  try {
    await harness.refreshWith(withFiles(fileA, fileB));
    const inB = harness.container.querySelector<HTMLButtonElement>('.dfile[data-path="src/b.ts"] button[aria-label="Line 1 Actions"]')!;
    await click(inB);
    assert.ok(menuItems().length > 0, "src/b.ts line 1's menu is open");
    await harness.refreshWith(withFiles(fileA));
    assertNoDomNode(doc().querySelector('[role="menu"]'), "the menu closed with its file");
    const head = harness.container.querySelector('.dfile[data-path="src/a.ts"] .dfile-toggle');
    assert.ok((doc().activeElement as unknown as Element | null) === head, "focus is on the remaining file's head");

    await click(button(harness.container, "Line 2 Actions"));
    assert.ok(menuItems().length > 0);
    await harness.refreshWith(withFiles());
    assertNoDomNode(doc().querySelector('[role="menu"]'), "the menu closed with the last file");
    assert.ok((doc().activeElement as unknown as Element | null) === button(harness.container, "View Options"),
      "with no file left, focus is on View Options");
  } finally {
    await harness.unmount();
  }
});

test("Add Finding… on a line whose editor is open focuses that editor (#2849)", async () => {
  const harness = await mountReview();
  try {
    const choose = async () => {
      await click(button(harness.container, "Line 2 Actions"));
      await click(menuItems().find((item) => item.getAttribute("data-menu-label") === "Add Finding…")!);
    };
    await choose();
    const body = harness.container.querySelector<HTMLTextAreaElement>(".diff-comment-editor textarea")!;
    assert.ok(body);
    button(harness.container, "Line 2 Actions").focus();
    await choose();
    assert.equal(harness.container.querySelectorAll(".diff-comment-editor").length, 1, "the same editor stays");
    assert.ok((doc().activeElement as unknown as Element | null) === body, "and takes focus");
  } finally {
    await harness.unmount();
  }
});

test("one selection bar at a time: picking lines clears selected findings, and selecting a finding clears the lines (#2849, #2850)", async () => {
  const now = Date.now();
  const open: ReviewFindingsResponse = {
    findings: [{
      findingId: "rf_one", sessionId: session.id, scope: "uncommitted", diffHash: diff.diffHash, filePath: "src/a.ts",
      side: "right", line: 2, anchorText: "const two = 20;", body: "Check the new value.", severity: "major", required: false,
      status: "open", source: "local", author: { kind: "human", id: "usr_me000000000" }, createdAt: now - 60_000, updatedAt: now - 60_000,
    }],
    summary: { total: 1, unresolved: 1, requiredUnresolved: 0, sent: 0, resolved: 0, dismissed: 0, completion: "in_review" },
  };
  const harness = await mountReview(open);
  try {
    const box = () => harness.container.querySelector<HTMLInputElement>('input[type="checkbox"][aria-label="Select Finding on src/a.ts Line 2"]')!;
    const findingsBar = () => harness.container.querySelector('section[aria-label="Selected Findings"]');
    assert.ok(box(), "the finding can be selected");
    await act(async () => { fireDomEvent.click(box()); });
    assert.ok(findingsBar(), "selecting a finding shows its bar");
    assertNoDomNode(harness.container.querySelector('section[aria-label="Commit"]'));

    await selectLines(harness);
    await click(button(harness.container, "Select Line 3"));
    assert.ok(bar(harness), "picking a line shows the line bar");
    assertNoDomNode(findingsBar(), "in place of the findings bar");
    assert.equal(box().checked, false, "and the finding is no longer selected");

    await act(async () => { fireDomEvent.click(box()); });
    assert.ok(findingsBar(), "selecting the finding again takes the foot back");
    assertNoDomNode(bar(harness));
    assert.equal(harness.container.querySelectorAll('button.diff-num[aria-pressed="true"]').length, 0, "and the lines are cleared");
  } finally {
    await harness.unmount();
  }
});

test("lines picked while Attach to Prompt runs stay selected when it lands (#2849)", async () => {
  const harness = await mountReview(noFindings, { holdAttach: true });
  try {
    await selectLines(harness);
    await click(button(harness.container, "Select Line 2"));
    await click(button(requiredBar(harness), "Attach to Prompt"));
    assert.equal(harness.calls.attached.length, 1, "the attach is in flight");
    await click(button(harness.container, "Select Line 23"));
    await harness.releaseAttach();
    assert.deepEqual(harness.calls.attached.map(({ startLine, endLine }) => [startLine, endLine]), [[2, 2]]);
    assert.equal(button(harness.container, "Select Line 2").getAttribute("aria-pressed"), "false", "the attached line is let go");
    assert.equal(button(harness.container, "Select Line 23").getAttribute("aria-pressed"), "true", "the line picked meanwhile stays");
    assert.match(requiredBar(harness).textContent ?? "", /1 line selected/u);
  } finally {
    await harness.unmount();
  }
});
