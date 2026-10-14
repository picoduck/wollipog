import { fireDomEvent } from "./test-dom-events.js";
import assert from "node:assert/strict";
import { test } from "node:test";
import React, { act } from "react";
import { createRoot } from "react-dom/client";
import { Window } from "happy-dom";
import type { GitDiffInfo, GitStatusInfo, SessionView } from "@wollipog/protocol";
import { api, type ApiClient } from "../api.js";
import { ApiProvider } from "../api-context.js";
import { installDomTestCleanup } from "../dom-test-cleanup.js";
import { clearPanelScratch } from "../right-panel-scratch.js";
import { FeedbackProvider } from "./FeedbackProvider.js";
import { GitDiffViewer, type DiffFileFocus, type DiffReviewControls } from "./GitDiffViewer.js";
import { ReviewPanel } from "./ReviewPanel.js";
import { PanelActionSlotContext } from "./RightPanel.js";

const domWindow = new Window({ url: "http://localhost/" });
for (const [name, value] of Object.entries({
  window: domWindow, document: domWindow.document, navigator: domWindow.navigator,
  localStorage: domWindow.localStorage, HTMLElement: domWindow.HTMLElement,
  HTMLButtonElement: domWindow.HTMLButtonElement, Node: domWindow.Node,
  Event: domWindow.Event, InputEvent: domWindow.InputEvent,
  MouseEvent: domWindow.MouseEvent, KeyboardEvent: domWindow.KeyboardEvent,
  React, IS_REACT_ACT_ENVIRONMENT: true,
})) Object.defineProperty(globalThis, name, { configurable: true, writable: true, value });
const { cleanup } = installDomTestCleanup(domWindow);
const doc = domWindow.document as unknown as Document;

const path = (index: number) => `src/file-${String(index).padStart(3, "0")}.ts`;
function fixture(count: number, inserted = false): GitDiffInfo {
  const files = Array.from({ length: count }, (_, index) => ({
    path: path(index), status: "modified" as const, binary: false,
    hunks: [{
      header: "@@ -1,2 +1,2 @@", oldStart: 1, oldCount: 2, newStart: 1, newCount: 2,
      lines: [{ status: " " as const, text: "unchanged" }, { status: "-" as const, text: "before" }, { status: "+" as const, text: "after" }],
    }],
  }));
  if (inserted) files.unshift({ ...files[0]!, path: "src/earlier.ts" });
  const stats = { filesChanged: files.length, insertions: files.length, deletions: files.length };
  return { scope: "uncommitted", diffHash: String(count % 10).repeat(64), files, stats,
    fineDiffHash: "f".repeat(64), unstagedFiles: files, unstagedStats: stats, stagedFiles: [],
    stagedStats: { filesChanged: 0, insertions: 0, deletions: 0 } };
}
const status: GitStatusInfo = { branch: "fixture", files: [], hasChanges: true, ahead: 0,
  remoteUrl: null, headSha: "abc1234", stagedCount: 0, addedLines: 5, deletedLines: 5 };
const session = { id: "growth-fixture", runnerId: "runner-fixture", workspaceId: null,
  agentId: "codex-app", title: "Diff Growth Fixture", status: "idle", column: "review",
  archived: false, useWorktree: true, worktreePath: "/fixture", createdAt: 1, updatedAt: 1,
  pendingApproval: null, driver: "codex-app-server" } as SessionView;
const review: DiffReviewControls = { findings: [], anchoredFindingIds: new Set(), lineage: "growth",
  creating: false, busyFindingId: null, onCreate: async () => true, onStatus: async () => {} };

async function mount(consumer: "viewer" | "panel", initial: GitDiffInfo) {
  clearPanelScratch();
  const container = doc.createElement("div");
  doc.body.append(container);
  const slot = doc.createElement("div");
  const body = doc.createElement("div");
  container.append(slot, body);
  const root = createRoot(body);
  cleanup(async () => { await act(async () => root.unmount()); container.remove(); });
  let shown = initial;
  let focus: DiffFileFocus | null = null;
  const client = { ...api, gitDiff: async () => ({ diff: shown }),
    reviewFindings: async () => ({ findings: [], summary: { total: 0, unresolved: 0,
      requiredUnresolved: 0, sent: 0, resolved: 0, dismissed: 0, completion: "complete" } }),
  } as unknown as ApiClient;
  const git = { status, observation: 1, observedAt: 1, settled: true, busy: false,
    error: null, errorCode: null, refresh: async () => {}, refreshStatusOnly: async () => {},
    install: () => {}, mutationRevision: 0 };
  const render = async () => {
    await act(async () => root.render(
      <FeedbackProvider><ApiProvider client={client}><PanelActionSlotContext.Provider value={slot}>
        {consumer === "viewer"
          ? <GitDiffViewer diff={shown} focus={focus} review={review} />
          : <ReviewPanel session={session} runnerOnline runnerProtocolVersion={157}
              git={git} focus={focus} onOpenSourceLocation={() => {}} />}
      </PanelActionSlotContext.Provider></ApiProvider></FeedbackProvider>,
    ));
  };
  await render();
  const count = () => container.querySelectorAll(".dfile-body").length;
  const head = (index: number) => container.querySelector<HTMLButtonElement>(
    `.dfile[data-path="${path(index)}"] .dfile-toggle`,
  )!;
  return {
    container, count, head,
    toggle: async (index: number) => { await act(async () => fireDomEvent.click(head(index))); },
    grow: async (next: GitDiffInfo) => {
      shown = next;
      if (consumer === "viewer") await render();
      else await act(async () => fireDomEvent.click(
        container.querySelector<HTMLButtonElement>('button[aria-label="Refresh Review"]')!,
      ));
    },
    focus: async (index: number) => { focus = { path: path(index), request: 1 }; await render(); },
  };
}

for (const consumer of ["viewer", "panel"] as const) {
  for (const choice of ["untouched", "collapse", "collapse/reopen"] as const) {
    test(`${consumer}: ${choice} keeps automatic growth bounded (#3161)`, async () => {
      const h = await mount(consumer, fixture(5));
      assert.equal(h.count(), 5);
      if (choice !== "untouched") await h.toggle(0);
      if (choice === "collapse/reopen") await h.toggle(0);
      await h.grow(fixture(200));
      assert.equal(h.container.querySelectorAll(".dfile").length, 200, "all paths remain in the index");
      assert.equal(h.count(), choice === "collapse" ? 9 : 10, "only automatic first-ten slots and per-path choices mount");
      assert.equal(h.head(0).getAttribute("aria-expanded"), choice === "collapse" ? "false" : "true");
      assert.equal(h.head(199).getAttribute("aria-expanded"), "false", "growth never silently expands the tail");
      await h.toggle(199);
      await h.grow(fixture(201));
      assert.equal(h.count(), choice === "collapse" ? 10 : 11, "explicit tail is the only extra body");
      assert.equal(h.head(199).getAttribute("aria-expanded"), "true");
      assert.equal(h.head(200).getAttribute("aria-expanded"), "false");
    });
  }

  test(`${consumer}: Open in Review is one path exception during growth (#3161)`, async () => {
    const h = await mount(consumer, fixture(12));
    assert.equal(h.count(), 10);
    await h.focus(11);
    assert.equal(h.count(), 11);
    const head = h.head(11);
    assert.equal(doc.activeElement, head);
    await h.grow(fixture(200));
    assert.equal(h.count(), 11);
    assert.equal(h.head(11), head);
    assert.equal(doc.activeElement, head, "refresh does not move focus");
    assert.equal(h.head(199).getAttribute("aria-expanded"), "false");
  });

  test(`${consumer}: earlier inserted paths preserve the unchanged editor and choices (#3161)`, async () => {
    const h = await mount(consumer, fixture(5));
    await h.toggle(0);
    const section = h.head(4).closest(".dfile")!;
    await act(async () => fireDomEvent.click(
      section.querySelector<HTMLButtonElement>('button[aria-label="Add Finding on Line 1"]')!,
    ));
    const editor = section.querySelector(".dedit");
    const textarea = section.querySelector<HTMLTextAreaElement>("textarea")!;
    assert.ok(editor); assert.ok(textarea);
    textarea.focus();
    await act(async () => fireDomEvent.change(textarea, { target: { value: "synthetic draft" } }));
    textarea.setSelectionRange(2, 5, "backward");
    await act(async () => fireDomEvent.select(textarea));
    await h.grow(fixture(200, true));
    assert.equal(section.querySelector(".dedit"), editor);
    assert.equal(section.querySelector("textarea"), textarea);
    assert.equal(doc.activeElement, textarea);
    assert.equal(textarea.value, "synthetic draft");
    assert.deepEqual([textarea.selectionStart, textarea.selectionEnd, textarea.selectionDirection], [2, 5, "backward"]);
    assert.equal(h.head(0).getAttribute("aria-expanded"), "false");
    assert.equal(h.head(4).getAttribute("aria-expanded"), "true");
    assert.ok(h.count() <= 10, "insertion does not promote all subsequent paths to expanded");
  });
}

async function chooseViewOption(container: HTMLElement, label: string) {
  await act(async () => fireDomEvent.click(
    container.querySelector<HTMLButtonElement>('button[aria-label="View Options"]')!,
  ));
  const item = [...doc.querySelectorAll<HTMLElement>('[role="menuitem"]')]
    .find((node) => node.getAttribute("data-menu-label") === label);
  assert.ok(item, `View Options offers ${label}`);
  await act(async () => fireDomEvent.click(item));
}

test("panel: Collapse All growth keeps existing choices and the automatic bound (#3161)", async () => {
  const h = await mount("panel", fixture(5));
  await chooseViewOption(h.container, "Collapse All Files");
  assert.equal(h.count(), 0);
  await h.grow(fixture(200));
  assert.ok(h.count() <= 10);
  for (let i = 0; i < 5; i++) assert.equal(h.head(i).getAttribute("aria-expanded"), "false");
  assert.equal(h.head(199).getAttribute("aria-expanded"), "false");
});

test("panel: explicit Expand All retains global intent and later per-path choices (#3161)", async () => {
  const h = await mount("panel", fixture(12));
  await chooseViewOption(h.container, "Collapse All Files");
  await chooseViewOption(h.container, "Expand All Files");
  assert.equal(h.count(), 12);
  await h.grow(fixture(200));
  assert.equal(h.count(), 200);
  await h.toggle(0);
  await h.grow(fixture(201));
  assert.equal(h.count(), 200, "Expand All intent applies to new paths while the chosen path stays closed");
  assert.equal(h.head(0).getAttribute("aria-expanded"), "false");
  assert.equal(h.head(200).getAttribute("aria-expanded"), "true");
  await chooseViewOption(h.container, "Collapse All Files");
  await h.grow(fixture(202));
  assert.equal(h.count(), 0, "Collapse All ends global expansion intent");
});
