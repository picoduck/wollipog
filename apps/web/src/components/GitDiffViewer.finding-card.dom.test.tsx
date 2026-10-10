import assert from "node:assert/strict";
import { test } from "node:test";
import React, { act } from "react";
import { fireDomEvent } from "./test-dom-events.js";
import { createRoot } from "react-dom/client";
import { Window } from "happy-dom";
import type { CreateReviewFindingRequest, GitDiffInfo, GitHunk, ReviewFinding, ReviewFindingStatus } from "@wollipog/protocol";
import { installDomTestCleanup } from "../dom-test-cleanup.js";
import { assertNoDomNode } from "../dom-test-assertions.js";
import { ViewerIdentityContext, type ViewerIdentity } from "../resolver-identity.js";
import { findingSummary } from "./DiffInlineFinding.js";
import { FeedbackContext } from "./FeedbackProvider.js";
import { GitDiffViewer, type DiffReviewControls } from "./GitDiffViewer.js";

/**
 * A finding in the diff (#2851): the editor is one neutral card with a Severity radio group, a
 * Required checkbox and its helper, Cancel then Add Finding, and an inline error for an empty body;
 * an open finding keeps its card, and a resolved or dismissed one is one quiet line with Reopen.
 */

const domWindow = new Window({ url: "http://localhost/" });
for (const [name, value] of Object.entries({
  window: domWindow,
  document: domWindow.document,
  navigator: domWindow.navigator,
  HTMLElement: domWindow.HTMLElement,
  HTMLButtonElement: domWindow.HTMLButtonElement,
  HTMLTextAreaElement: domWindow.HTMLTextAreaElement,
  Node: domWindow.Node,
  Event: domWindow.Event,
  MouseEvent: domWindow.MouseEvent,
  KeyboardEvent: domWindow.KeyboardEvent,
  React,
  IS_REACT_ACT_ENVIRONMENT: true,
})) Object.defineProperty(globalThis, name, { configurable: true, writable: true, value });

const { cleanup } = installDomTestCleanup(domWindow);

const feedback = {
  confirm: async () => false,
  showToast: () => 1,
  showUndo: () => -1,
  dismissToast: () => {},
};

async function mount(viewer: ViewerIdentity | null = null) {
  const container = domWindow.document.createElement("div") as unknown as HTMLDivElement;
  domWindow.document.body.append(container as never);
  const root = createRoot(container);
  cleanup(async () => {
    await act(async () => { root.unmount(); });
    container.remove();
  });
  const render = async (node: React.ReactNode) => {
    await act(async () => {
      root.render(
        <FeedbackContext.Provider value={feedback}>
          <ViewerIdentityContext.Provider value={viewer}>{node}</ViewerIdentityContext.Provider>
        </FeedbackContext.Provider>,
      );
    });
  };
  return { container, render };
}

const hunkWith = (added: string): GitHunk => ({
  header: "@@ -1,3 +1,3 @@",
  oldStart: 1, oldCount: 3, newStart: 1, newCount: 3,
  lines: [{ status: " ", text: "a" }, { status: "-", text: "b" }, { status: "+", text: added }, { status: " ", text: "d" }],
});
const diffOf = (added = "c"): GitDiffInfo => ({
  scope: "uncommitted",
  diffHash: "c".repeat(64),
  stats: { filesChanged: 1, insertions: 1, deletions: 1 },
  files: [{ path: "src/a.ts", status: "modified", binary: false, hunks: [hunkWith(added)] }],
});

function finding(overrides: Partial<ReviewFinding> = {}): ReviewFinding {
  return {
    findingId: "rf_1", sessionId: "s1", scope: "uncommitted", diffHash: "c".repeat(64),
    filePath: "src/a.ts", side: "right", line: 2, anchorText: "c",
    body: "This guard misses the empty cart.\nAdd a test for it.",
    severity: "blocker", required: true, status: "open", source: "local",
    author: { kind: "human", id: "usr_9f3a2c71" }, createdAt: Date.now() - 60_000, updatedAt: Date.now(),
    ...overrides,
  };
}

function controls(overrides: Partial<DiffReviewControls> = {}) {
  const created: CreateReviewFindingRequest[] = [];
  const statuses: Array<[string, Exclude<ReviewFindingStatus, "sent">]> = [];
  const review: DiffReviewControls = {
    findings: [],
    anchoredFindingIds: new Set(),
    lineage: "uncommitted:combined",
    creating: false,
    busyFindingId: null,
    onCreate: async (input) => { created.push(input); return true; },
    onStatus: async (target, status) => { statuses.push([target.findingId, status]); },
    agentLabel: "Claude",
    ...overrides,
  };
  return { review, created, statuses };
}

/** Open the editor on the added line (new-side line 2), as the line's own control does. */
async function openEditor(container: HTMLElement): Promise<HTMLElement> {
  const add = container.querySelector<HTMLButtonElement>('button[aria-label="Comment on src/a.ts right line 2"]');
  assert.ok(add, "the line offers to add a finding");
  await act(async () => { add.click(); });
  const editor = container.querySelector<HTMLElement>(".dedit");
  assert.ok(editor, "the editor opened");
  return editor;
}

function button(scope: HTMLElement, label: string): HTMLButtonElement {
  const found = [...scope.querySelectorAll<HTMLButtonElement>("button")].find((candidate) => candidate.textContent?.trim() === label);
  assert.ok(found, `a ${label} button`);
  return found;
}

function typeBody(editor: HTMLElement, value: string) {
  const body = editor.querySelector<HTMLTextAreaElement>("textarea")!;
  body.value = value;
  fireDomEvent.change(body);
}

test("the editor is one card: Severity radios and Required on a row, its helper, then Cancel and Add Finding", async () => {
  const { container, render } = await mount();
  const { review } = controls();
  await render(<GitDiffViewer diff={diffOf()} review={review} />);
  const editor = await openEditor(container);

  assert.equal(editor.getAttribute("role"), "group");
  assert.equal(editor.getAttribute("aria-label"), "New Finding");
  const body = editor.querySelector<HTMLTextAreaElement>("textarea")!;
  assert.equal(body.getAttribute("aria-label"), "Finding");
  assert.equal(body.placeholder, "Describe the issue and the fix you expect");
  assert.equal(body.getAttribute("rows"), "3");

  // Severity is a radio group, not a native select, in the badges' words.
  assertNoDomNode(editor.querySelector("select"), "no native select");
  const group = editor.querySelector<HTMLElement>('[role="radiogroup"]')!;
  assert.equal(group.getAttribute("aria-label"), "Severity");
  assert.ok(group.classList.contains("seg") && group.classList.contains("sm"));
  assert.deepEqual([...group.querySelectorAll('[role="radio"]')].map((radio) => radio.textContent), ["Blocker", "Major", "Minor", "Nit"]);
  assert.equal(group.querySelector('[aria-checked="true"]')?.textContent, "Major", "Major by default");

  // One word for one idea: "Required", described by its helper.
  assert.ok(!container.textContent?.includes("Must Resolve Before Publish"));
  const required = editor.querySelector<HTMLInputElement>('.dedit-options input[type="checkbox"]')!;
  assert.equal(required.checked, true);
  const labelId = required.getAttribute("aria-labelledby")!;
  assert.equal(editor.querySelector(`[id="${labelId}"]`)?.textContent, "Required");
  const helper = editor.querySelector(`[id="${required.getAttribute("aria-describedby")}"]`);
  assert.equal(helper?.textContent, "Required findings must be resolved before publishing.");
  assert.ok(helper?.classList.contains("dedit-helper"));
  assert.equal(group.closest(".dedit-options"), required.closest(".dedit-options"), "Severity and Required share a row");

  // Actions on their own row: Cancel (secondary), then Add Finding (primary) last.
  const actions = editor.querySelector<HTMLElement>(".dedit-actions")!;
  const labels = [...actions.querySelectorAll("button")].map((candidate) => candidate.textContent?.trim());
  assert.deepEqual(labels, ["Cancel", "Add Finding"]);
  const [cancel, add] = [...actions.querySelectorAll("button")];
  assert.ok(!cancel!.classList.contains("ghost") && !cancel!.classList.contains("primary"), "Cancel is secondary");
  assert.ok(add!.classList.contains("primary"), "Add Finding is the primary");
  assert.equal(add!.disabled, false, "Add Finding stays enabled with nothing written");
});

test("an empty submit shows the field error and marks the textarea invalid; writing clears it", async () => {
  const { container, render } = await mount();
  const { review, created } = controls();
  await render(<GitDiffViewer diff={diffOf()} review={review} />);
  const editor = await openEditor(container);
  const body = editor.querySelector<HTMLTextAreaElement>("textarea")!;
  assert.equal(body.getAttribute("aria-invalid"), null);

  // Whitespace is still nothing written.
  await act(async () => { typeBody(editor, "   "); });
  await act(async () => { button(editor, "Add Finding").click(); });
  assert.deepEqual(created, [], "nothing was sent");
  assert.equal(body.getAttribute("aria-invalid"), "true");
  const error = editor.querySelector<HTMLElement>(".field-error")!;
  assert.equal(error.textContent, "Describe the issue before adding it.");
  assert.equal(body.getAttribute("aria-describedby"), error.id, "the textarea is described by its error");
  assert.equal(domWindow.document.activeElement, body as never, "focus is on the field that needs fixing");

  await act(async () => { typeBody(editor, "The guard misses the empty cart."); });
  assert.equal(body.getAttribute("aria-invalid"), null, "the error clears as the body takes text");
  assertNoDomNode(editor.querySelector(".field-error"));
});

test("a non-empty submit creates the finding as before and closes the editor", async () => {
  const { container, render } = await mount();
  const { review, created } = controls();
  await render(<GitDiffViewer diff={diffOf()} review={review} />);
  const editor = await openEditor(container);
  await act(async () => { typeBody(editor, "The guard misses the empty cart."); });
  const nit = [...editor.querySelectorAll<HTMLElement>('[role="radio"]')].find((radio) => radio.textContent === "Nit")!;
  await act(async () => { nit.click(); });
  await act(async () => { fireDomEvent.click(editor.querySelector<HTMLInputElement>('input[type="checkbox"]')!); });
  await act(async () => { button(editor, "Add Finding").click(); });
  assert.deepEqual(created, [{
    scope: "uncommitted", diffHash: "c".repeat(64), filePath: "src/a.ts", side: "right", line: 2, anchorText: "c",
    body: "The guard misses the empty cart.", severity: "nit", required: false,
  }]);
  assertNoDomNode(container.querySelector(".dedit"), "the draft became a finding");
});

test("only the editor that is submitting shows Add Finding running", async () => {
  const { container, render } = await mount();
  let release: (created: boolean) => void = () => {};
  const { review } = controls({ onCreate: () => new Promise<boolean>((resolve) => { release = resolve; }) });
  await render(<GitDiffViewer diff={diffOf()} review={review} />);
  const editor = await openEditor(container);
  // Another editor's creation holds this one's Add Finding without making it look busy.
  await render(<GitDiffViewer diff={diffOf()} review={{ ...review, creating: true }} />);
  const add = button(editor, "Add Finding");
  assert.equal(add.disabled, true);
  assert.equal(add.getAttribute("aria-busy"), null);

  await render(<GitDiffViewer diff={diffOf()} review={review} />);
  await act(async () => { typeBody(editor, "Busy"); });
  await act(async () => { button(editor, "Add Finding").click(); });
  await render(<GitDiffViewer diff={diffOf()} review={{ ...review, creating: true }} />);
  assert.equal(button(editor, "Add Finding").getAttribute("aria-busy"), "true");
  assert.equal(button(editor, "Cancel").disabled, true);
  // A refused create leaves the draft open and the button ready again.
  await act(async () => { release(false); });
  await render(<GitDiffViewer diff={diffOf()} review={review} />);
  assert.equal(button(editor, "Add Finding").getAttribute("aria-busy"), null);
  assert.equal(editor.querySelector("textarea")!.value, "Busy");
});

test("a draft whose line changed says so in a compact warning notice at the top of the card", async () => {
  const { container, render } = await mount();
  const { review } = controls();
  await render(<GitDiffViewer diff={diffOf("c")} review={review} />);
  const editor = await openEditor(container);
  assertNoDomNode(editor.querySelector(".notice"));
  await render(<GitDiffViewer diff={diffOf("c, rewritten")} review={review} />);
  const notice = container.querySelector<HTMLElement>(".dedit > .notice")!;
  assert.ok(notice, "the notice is in the card");
  assert.equal(notice.parentElement!.firstElementChild, notice, "at its top");
  assert.ok(notice.classList.contains("t-warning") && notice.classList.contains("compact"), "a warning");
  assert.equal(notice.getAttribute("role"), "status");
  assert.equal(notice.textContent?.trim(), "This line changed after you started writing. Check that the finding still applies.");
});

test("an open inline finding keeps its card with #2850's badges and provenance, and never a user id, scope or side", async () => {
  const { container, render } = await mount({ userId: "usr_9f3a2c71", shared: false, names: new Map() });
  const open = finding();
  const sent = finding({ findingId: "rf_2", status: "sent", severity: "minor", required: false, body: "Rename this.", author: { kind: "agent" } });
  const { review, statuses } = controls({ findings: [open, sent], anchoredFindingIds: new Set(["rf_1", "rf_2"]) });
  await render(<GitDiffViewer diff={diffOf()} review={review} />);
  const cards = [...container.querySelectorAll<HTMLElement>(".dfinding")];
  assert.equal(cards.length, 2);
  for (const card of cards) assert.ok(!card.classList.contains("is-settled"));
  const [first, second] = cards as [HTMLElement, HTMLElement];
  assert.deepEqual([...first.querySelectorAll(".status")].map((badge) => badge.textContent?.trim()), ["Blocker", "Required"]);
  assert.match(first.querySelector(".dfinding-meta")!.textContent!, /^You · 1m ago$/);
  assert.equal(first.querySelector(".dfinding-body")?.textContent, open.body);
  assert.match(second.querySelector(".dfinding-meta")!.textContent!, /^Agent · 1m agoSent to Claude$/);
  for (const card of cards) {
    const text = card.textContent ?? "";
    for (const leak of ["usr_", "Uncommitted", "Right", "Left", "Local", "Human"]) assert.ok(!text.includes(leak), `no ${leak} in ${text}`);
  }
  await act(async () => { button(first, "Resolve").click(); });
  await act(async () => { button(second, "Dismiss").click(); });
  assert.deepEqual(statuses, [["rf_1", "resolved"], ["rf_2", "dismissed"]]);
});

test("a resolved finding is one quiet line with Reopen that opens on click, and Reopen restores the open card", async () => {
  const { container, render } = await mount();
  const resolved = finding({ status: "resolved" });
  const dismissed = finding({ findingId: "rf_2", status: "dismissed", body: "Not worth it." });
  const { review, statuses } = controls({ findings: [resolved, dismissed], anchoredFindingIds: new Set(["rf_1", "rf_2"]) });
  await render(<GitDiffViewer diff={diffOf()} review={review} />);
  const [line, other] = [...container.querySelectorAll<HTMLElement>(".dfinding")] as [HTMLElement, HTMLElement];
  assert.ok(line.classList.contains("is-settled"));
  const toggle = line.querySelector<HTMLButtonElement>(".dfinding-toggle")!;
  assert.equal(toggle.getAttribute("aria-expanded"), "false");
  assert.equal(line.querySelector(".dfinding-summary")?.textContent, "Resolved: This guard misses the empty cart.");
  assert.equal(other.querySelector(".dfinding-summary")?.textContent, "Dismissed: Not worth it.");
  assertNoDomNode(line.querySelector(".dfinding-body"), "folded, the body is the line's words only");
  assertNoDomNode(line.querySelector(".status"));
  assert.deepEqual([...line.querySelectorAll("button")].map((candidate) => candidate.textContent?.trim()),
    ["Resolved: This guard misses the empty cart.", "Reopen"]);

  await act(async () => { toggle.click(); });
  assert.equal(toggle.getAttribute("aria-expanded"), "true");
  assert.ok(line.classList.contains("is-expanded"));
  const detail = line.querySelector<HTMLElement>(`[id="${toggle.getAttribute("aria-controls")}"]`)!;
  assert.equal(detail.hidden, false);
  assert.equal(detail.querySelector(".dfinding-body")?.textContent, resolved.body);
  assert.deepEqual([...detail.querySelectorAll(".status")].map((badge) => badge.textContent?.trim()), ["Blocker", "Required"]);

  await act(async () => { button(line, "Reopen").click(); });
  assert.deepEqual(statuses, [["rf_1", "open"]]);
  await render(<GitDiffViewer diff={diffOf()} review={{ ...review, findings: [{ ...resolved, status: "open" }, dismissed] }} />);
  const reopened = container.querySelector<HTMLElement>(".dfinding")!;
  assert.ok(!reopened.classList.contains("is-settled"), "Reopen restores the open card");
  assert.equal(reopened.querySelector(".dfinding-body")?.textContent, resolved.body);
  assert.ok(button(reopened, "Resolve"));
});

test("a refused person's inline controls are disabled with the reason", async () => {
  const { container, render } = await mount();
  const { review } = controls({
    findings: [finding(), finding({ findingId: "rf_2", status: "resolved" })],
    anchoredFindingIds: new Set(["rf_1", "rf_2"]),
    refusal: { reason: "Viewers can't change findings.", id: "refusal" },
  });
  await render(<GitDiffViewer diff={diffOf()} review={review} />);
  const [open, settled] = [...container.querySelectorAll<HTMLElement>(".dfinding")] as [HTMLElement, HTMLElement];
  for (const control of [button(open, "Resolve"), button(open, "Dismiss"), button(settled, "Reopen")]) {
    assert.equal(control.disabled, true);
    assert.equal(control.getAttribute("aria-describedby"), "refusal");
  }
  // The settled line still opens: reading is not a change.
  assert.equal(settled.querySelector<HTMLButtonElement>(".dfinding-toggle")!.disabled, false);
});

test("a forge thread inline resolves and reopens on its forge, as in the Findings section", async () => {
  const { container, render } = await mount();
  const remote = { provider: "github" as const, url: "https://github.com/acme/shop/pull/4#discussion_r1", subjectType: "line" as const, outdated: false };
  const { review } = controls({
    findings: [
      finding({ source: "github", remote, author: { kind: "human", id: "octocat" } } as Partial<ReviewFinding>),
      finding({ findingId: "rf_2", status: "resolved", source: "github", remote } as Partial<ReviewFinding>),
    ],
    anchoredFindingIds: new Set(["rf_1", "rf_2"]),
  });
  await render(<GitDiffViewer diff={diffOf()} review={review} />);
  const [open, settled] = [...container.querySelectorAll<HTMLElement>(".dfinding")] as [HTMLElement, HTMLElement];
  assert.equal(open.querySelector("a")?.textContent, "Resolve on GitHub");
  assert.equal(settled.querySelector("a")?.textContent, "Reopen on GitHub");
  assert.ok(![...open.querySelectorAll("button")].some((candidate) => candidate.textContent === "Resolve"));
  assert.match(open.querySelector(".dfinding-meta")!.textContent!, /^octocat on GitHub · /);
});

test("a settled finding's line keeps the first words of its first line", () => {
  assert.equal(findingSummary("  Short.\nSecond line."), "Short.");
  const long = "Back off before retrying so that a failing upstream service is not hammered by every client at once and recovers";
  const summary = findingSummary(long);
  assert.ok(summary.endsWith("…") && summary.length <= 81);
  assert.ok(long.startsWith(summary.slice(0, -1)), "cut at a word boundary");
  assert.equal(findingSummary("x".repeat(120)), `${"x".repeat(80)}…`);
});
