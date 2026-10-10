import assert from "node:assert/strict";
import { after, before, beforeEach, test } from "node:test";
import React, { act } from "react";
import { createRoot } from "react-dom/client";
import { Window } from "happy-dom";
import type { GitDiffFile, GitDiffInfo, GitStatusInfo, ReviewFindingsResponse, SessionView } from "@wollipog/protocol";
import { api, ApiError, type ApiClient } from "../api.js";
import { ApiProvider } from "../api-context.js";
import { installDomTestCleanup } from "../dom-test-cleanup.js";
import { assertNoDomNode } from "../dom-test-assertions.js";
import { clearPanelScratch } from "../right-panel-scratch.js";
import { FeedbackProvider } from "./FeedbackProvider.js";
import { ReviewPanel } from "./ReviewPanel.js";
import { PanelActionSlotContext } from "./RightPanel.js";
import { fireDomEvent } from "./test-dom-events.js";
import type { GitStatus } from "./useGitStatus.js";

/**
 * Review's file sections (#2848) inside the real panel: the discard confirmations' copy, a stage race
 * on its own file, View Options' Wrap Long Lines and Collapse All Files, and Side by Side offered only
 * while the panel is at least 720px wide.
 */

const domWindow = new Window({ url: "http://localhost/" });
/** The DOM lib's view of happy-dom's document, so queries return the types the tests use. */
const doc = domWindow.document as unknown as Document;
installDomTestCleanup(domWindow);

/** A ResizeObserver the test drives, standing in for the browser's. */
class FakeResizeObserver {
  static all: FakeResizeObserver[] = [];
  observed: Element[] = [];
  constructor(private readonly callback: (entries: Array<{ contentRect: { width: number } }>) => void) {
    FakeResizeObserver.all.push(this);
  }
  observe(target: Element) { this.observed.push(target); }
  unobserve() {}
  disconnect() { this.observed = []; }
  static resize(width: number) {
    for (const observer of FakeResizeObserver.all) {
      if (observer.observed.length > 0) observer.callback([{ contentRect: { width } }]);
    }
  }
}

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
const prior = Object.fromEntries(Object.keys({ ...globals, ResizeObserver: 0 })
  .map((name) => [name, (globalThis as Record<string, unknown>)[name]]));

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

beforeEach(() => {
  clearPanelScratch();
  FakeResizeObserver.all = [];
  Object.defineProperty(globalThis, "ResizeObserver", { configurable: true, writable: true, value: undefined });
});

const hash = (seed: string) => seed.repeat(64).slice(0, 64);
const hunk = { header: "@@ -1,2 +1,2 @@", oldStart: 1, oldCount: 2, newStart: 1, newCount: 2,
  lines: [{ status: " " as const, text: "alpha" }, { status: "-" as const, text: "old" }, { status: "+" as const, text: "new" }] };
const tracked: GitDiffFile = { path: "src/cart/cart-store.ts", status: "modified", binary: false, hunks: [hunk] };
const added: GitDiffFile = { path: "src/cart/cart-totals.test.ts", status: "added", binary: false, hunks: [hunk] };
const files = [tracked, added];
const diff: GitDiffInfo = {
  scope: "uncommitted",
  diffHash: hash("1"),
  fineDiffHash: hash("9"),
  stagedDiffHash: hash("2"),
  unstagedDiffHash: hash("3"),
  stats: { filesChanged: 2, insertions: 2, deletions: 2 },
  stagedStats: { filesChanged: 0, insertions: 0, deletions: 0 },
  unstagedStats: { filesChanged: 2, insertions: 2, deletions: 2 },
  files,
  stagedFiles: [],
  unstagedFiles: files,
};
const status: GitStatusInfo = {
  branch: "agent/session-1",
  files: [{ status: "M", path: tracked.path }, { status: "A", path: added.path }],
  hasChanges: true,
  ahead: 0,
  remoteUrl: null,
  headSha: "abc1234",
  stagedCount: 0,
  addedLines: 2,
  deletedLines: 2,
};
const session = {
  id: "session-1", runnerId: "runner-1", workspaceId: null, workspaceName: null, projectId: null,
  agentId: "claude", agentName: "Claude", title: "File Sections Fixture", status: "idle", column: "review",
  runId: null, useWorktree: true, worktreePath: "/repo/.agent-worktrees/session-1", archived: false,
  createdAt: 1, updatedAt: 1, lastEventAt: null, messageCount: 0, eventEpoch: 0, preview: null,
  pendingApproval: null, driver: "claude-code", model: null, effort: null, permissionMode: null,
  tokensIn: 0, tokensOut: 0, costUsd: 0, adopted: false,
} as SessionView;
const noFindings: ReviewFindingsResponse = {
  findings: [],
  summary: { total: 0, unresolved: 0, requiredUnresolved: 0, sent: 0, resolved: 0, dismissed: 0, completion: "complete" },
};

async function mountPanel({ race = false, panelWidth }: { race?: boolean; panelWidth?: number } = {}) {
  const host = domWindow.document.createElement("div");
  domWindow.document.body.appendChild(host);
  // The panel's frame as RightPanel draws it: the `rp` container, its header slot and the body.
  const panel = domWindow.document.createElement("aside");
  panel.className = "rpanel";
  if (panelWidth !== undefined) Object.defineProperty(panel, "clientWidth", { configurable: true, get: () => panelWidth });
  const slot = domWindow.document.createElement("div");
  const body = domWindow.document.createElement("div");
  panel.append(slot, body);
  host.append(panel);
  const root = createRoot(body as unknown as Element);
  const calls: string[] = [];
  const client = {
    ...api,
    gitDiff: async () => { calls.push("diff"); return { diff }; },
    reviewFindings: async () => noFindings,
    gitStageHunk: async (_id: string, body: { filePath: string }) => {
      calls.push(`stage:${body.filePath}`);
      if (race) throw new ApiError("the diff is out of date", 409, "GIT_STALE");
      return { status, diff };
    },
    gitDiscardFile: async (_id: string, body: { filePath: string }) => {
      calls.push(`discard:${body.filePath}`);
      if (race) throw new ApiError("could not discard", 409, "GIT_APPLY_FAILED");
      return { status, diff };
    },
  } as unknown as ApiClient;
  const git: GitStatus = {
    status, observation: 1, observedAt: 1, settled: true, busy: false, error: null, errorCode: null,
    refresh: async () => {}, refreshStatusOnly: async () => {}, install: () => {}, mutationRevision: 0,
  };
  await act(async () => {
    root.render(
      <FeedbackProvider>
        <ApiProvider client={client}>
          <PanelActionSlotContext.Provider value={slot as unknown as HTMLElement}>
            <ReviewPanel session={session} runnerOnline runnerProtocolVersion={157} git={git} onOpenSourceLocation={() => {}} />
          </PanelActionSlotContext.Provider>
        </ApiProvider>
      </FeedbackProvider>,
    );
  });
  const container = host as unknown as HTMLElement;
  assert.ok(container.querySelector(".dfile"), "the diff has loaded");
  return {
    container,
    calls,
    unmount: async () => {
      await act(async () => { root.unmount(); });
      host.remove();
    },
  };
}

const section = (container: HTMLElement, path: string) => container.querySelector<HTMLElement>(`.dfile[data-path="${path}"]`)!;

async function chooseFileAction(container: HTMLElement, path: string, label: string) {
  const trigger = container.querySelector<HTMLButtonElement>(`button[aria-label="${path} Actions"]`)!;
  await act(async () => { fireDomEvent.click(trigger); });
  const item = [...doc.querySelectorAll<HTMLElement>('[role="menuitem"]')]
    .find((node) => node.getAttribute("data-menu-label") === label);
  assert.ok(item, `${path} offers ${label}`);
  await act(async () => { fireDomEvent.click(item); });
}

/** The View Options rows: label, role, checked and the unavailable reason. */
async function viewOptions(container: HTMLElement) {
  const trigger = container.querySelector<HTMLButtonElement>('button[aria-label="View Options"]')!;
  await act(async () => { fireDomEvent.click(trigger); });
  const menu = doc.querySelector<HTMLElement>('[role="menu"]')!;
  const items = [...menu.querySelectorAll<HTMLElement>('[role^="menuitem"]')];
  return {
    rows: items.map((item) => [
      item.querySelector(".menu-text")?.textContent ?? "",
      item.getAttribute("role"),
      item.getAttribute("aria-checked"),
      item.getAttribute("aria-disabled") === "true" ? item.querySelector(".menu-desc")?.textContent ?? "" : null,
    ]),
    choose: async (label: string) => {
      const item = items.find((node) => node.getAttribute("data-menu-label") === label)!;
      await act(async () => { fireDomEvent.click(item); });
    },
    close: async () => { await act(async () => { fireDomEvent.keyDown(menu, { key: "Escape" }); }); },
  };
}

function dialog() {
  const found = doc.querySelector<HTMLElement>('[role="alertdialog"], [role="dialog"]');
  assert.ok(found, "a confirmation is open");
  const buttons = [...found.querySelectorAll<HTMLButtonElement>(".modal-foot button")];
  return {
    title: found.querySelector("h2, .modal-title")?.textContent?.trim(),
    text: found.textContent ?? "",
    row: found.querySelector<HTMLElement>(".confirmation-rows .row-title"),
    buttons: buttons.map((button) => button.textContent),
    cancel: buttons.find((button) => button.textContent === "Cancel")!,
    confirm: buttons.at(-1)!,
  };
}

test("Discard Changes confirms with the file as a mono row and Cancel focused, then discards", async () => {
  const harness = await mountPanel();
  try {
    await chooseFileAction(harness.container, tracked.path, "Discard Changes…");
    const shown = dialog();
    assert.equal(shown.title, "Discard Changes");
    assert.ok(shown.text.includes("All staged and unstaged changes to this file go back to its last commit. This can't be undone."));
    assert.equal(shown.row?.textContent, tracked.path, "the path is the dialog's one row");
    assert.ok(shown.row?.classList.contains("mono"), "in mono");
    assert.deepEqual(shown.buttons, ["Cancel", "Discard Changes"]);
    assert.equal(domWindow.document.activeElement, shown.cancel as unknown, "Cancel has focus");
    await act(async () => { shown.confirm.click(); await Promise.resolve(); });
    assert.deepEqual(harness.calls.filter((call) => call.startsWith("discard:")), [`discard:${tracked.path}`]);
  } finally {
    await harness.unmount();
  }
});

test("Discard New File says the file will be deleted, and Cancel sends nothing", async () => {
  const harness = await mountPanel();
  try {
    await chooseFileAction(harness.container, added.path, "Discard New File…");
    const shown = dialog();
    assert.equal(shown.title, "Discard New File");
    assert.ok(shown.text.includes("This file isn't in any commit yet, so discarding it deletes it. This can't be undone."));
    assert.equal(shown.row?.textContent, added.path);
    assert.deepEqual(shown.buttons, ["Cancel", "Discard New File"]);
    assert.equal(domWindow.document.activeElement, shown.cancel as unknown);
    await act(async () => { shown.cancel.click(); await Promise.resolve(); });
    assert.deepEqual(harness.calls.filter((call) => call.startsWith("discard:")), []);
  } finally {
    await harness.unmount();
  }
});

test("a GIT_STALE Stage Hunk shows a warning at the top of that file, with Refresh, and the newest race wins", async () => {
  const harness = await mountPanel({ race: true });
  try {
    const stage = section(harness.container, tracked.path).querySelector<HTMLButtonElement>("button.hunk-stage")!;
    assert.equal(stage.textContent, "Stage Hunk");
    await act(async () => { stage.click(); await Promise.resolve(); });
    const alert = section(harness.container, tracked.path).querySelector<HTMLElement>('[role="alert"]');
    assert.ok(alert, "the notice is on the file it is about");
    assert.ok(alert.classList.contains("notice-warning") || alert.className.includes("warning"), "a warning");
    assert.ok(alert.textContent?.includes("cart-store.ts changed after this diff loaded, so the hunk wasn't staged."));
    assertNoDomNode(section(harness.container, added.path).querySelector('[role="alert"]'));
    assert.equal(harness.container.querySelectorAll('[role="alert"]').length, 1);

    // Discarding the other file races too: its notice replaces the first.
    await chooseFileAction(harness.container, added.path, "Discard New File…");
    await act(async () => { dialog().confirm.click(); await Promise.resolve(); });
    assertNoDomNode(section(harness.container, tracked.path).querySelector('[role="alert"]'), "one at a time");
    const newest = section(harness.container, added.path).querySelector<HTMLElement>('[role="alert"]');
    assert.ok(newest?.textContent?.includes("cart-totals.test.ts changed after this diff loaded, so it wasn't deleted."));

    const reads = harness.calls.filter((call) => call === "diff").length;
    const refresh = [...newest!.querySelectorAll("button")].find((button) => button.textContent === "Refresh")!;
    await act(async () => { refresh.click(); await Promise.resolve(); });
    assert.ok(harness.calls.filter((call) => call === "diff").length > reads, "Refresh reads the diff again");
    assertNoDomNode(harness.container.querySelector('[role="alert"]'), "and the notice goes");
  } finally {
    await harness.unmount();
  }
});

test("View Options wraps long lines and collapses every file into the index, which a refresh keeps", async () => {
  const harness = await mountPanel();
  try {
    const options = await viewOptions(harness.container);
    assert.deepEqual(options.rows.slice(-2), [
      ["Wrap Long Lines", "menuitemcheckbox", "false", null],
      ["Collapse All Files", "menuitem", null, null],
    ]);
    await options.choose("Wrap Long Lines");
    assert.ok(harness.container.querySelector(".diff-view.is-wrapped"), "code wraps");

    const again = await viewOptions(harness.container);
    assert.deepEqual(again.rows.at(-2), ["Wrap Long Lines", "menuitemcheckbox", "true", null]);
    await again.choose("Collapse All Files");
    const shape = () => [...harness.container.querySelectorAll<HTMLElement>(".dfile")]
      .map((node) => `${node.dataset.path}:${node.querySelector(".dfile-body") ? "open" : "row"}`);
    assert.deepEqual(shape(), [`${tracked.path}:row`, `${added.path}:row`], "one line per file");

    const refresh = harness.container.querySelector<HTMLButtonElement>('button[aria-label="Refresh Review"]')!;
    await act(async () => { refresh.click(); await Promise.resolve(); });
    assert.deepEqual(shape(), [`${tracked.path}:row`, `${added.path}:row`], "the same diff stays collapsed");

    const expand = await viewOptions(harness.container);
    assert.deepEqual(expand.rows.at(-1), ["Expand All Files", "menuitem", null, null]);
    await expand.choose("Expand All Files");
    assert.deepEqual(shape(), [`${tracked.path}:open`, `${added.path}:open`]);
  } finally {
    await harness.unmount();
  }
});

test("Side by Side is offered only while the panel is at least 720px wide (#2848)", async () => {
  Object.defineProperty(globalThis, "ResizeObserver", { configurable: true, writable: true, value: FakeResizeObserver });
  const harness = await mountPanel({ panelWidth: 400 });
  try {
    const narrow = await viewOptions(harness.container);
    const layout = narrow.rows.filter(([label]) => label === "Unified" || label === "Side by Side");
    assert.deepEqual(layout, [
      ["Unified", "menuitemradio", "true", null],
      ["Side by Side", "menuitemradio", "false", "Expand the panel to compare side by side."],
    ]);
    await narrow.choose("Side by Side");
    assertNoDomNode(harness.container.querySelector(".dsplit"), "an unavailable Side by Side does nothing");
    await narrow.close();

    // Expanded: the panel reports its new width and Side by Side can be chosen.
    await act(async () => { FakeResizeObserver.resize(1100); });
    const wide = await viewOptions(harness.container);
    assert.deepEqual(wide.rows.find(([label]) => label === "Side by Side"), ["Side by Side", "menuitemradio", "false", null]);
    await wide.choose("Side by Side");
    assert.ok(harness.container.querySelector(".dsplit"), "the diff is side by side");

    // Narrowed again, Review renders Unified and keeps the choice for when the panel widens.
    await act(async () => { FakeResizeObserver.resize(719); });
    assertNoDomNode(harness.container.querySelector(".dsplit"));
    await act(async () => { FakeResizeObserver.resize(720); });
    assert.ok(harness.container.querySelector(".dsplit"), "720px is wide enough");
  } finally {
    await harness.unmount();
  }
});
