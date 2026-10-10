import assert from "node:assert/strict";
import { test } from "node:test";
import React, { act, useState } from "react";
import { createRoot, type Root } from "react-dom/client";
import { Window } from "happy-dom";
import type { CreateWorkspaceReferenceRequest, GitDiffFile, GitDiffInfo, GitHunk, SourceLocation } from "@wollipog/protocol";
import { installDomTestCleanup } from "../dom-test-cleanup.js";
import { assertNoDomNode } from "../dom-test-assertions.js";
import { FeedbackContext } from "./FeedbackProvider.js";
import { GitDiffViewer, type DiffFileNotice, type DiffReviewControls, type StagingControls } from "./GitDiffViewer.js";
import { fireDomEvent } from "./test-dom-events.js";

/**
 * Changed files as flush sections (#2848): the file actions menu, collapsing into the file index, a
 * stage race on its own file, and Side by Side's two columns.
 */

const domWindow = new Window({ url: "http://localhost/" });
/** The DOM lib's view of happy-dom's document, so queries return the types the tests use. */
const doc = domWindow.document as unknown as Document;
for (const [name, value] of Object.entries({
  window: domWindow,
  document: domWindow.document,
  navigator: domWindow.navigator,
  HTMLElement: domWindow.HTMLElement,
  HTMLButtonElement: domWindow.HTMLButtonElement,
  Node: domWindow.Node,
  Event: domWindow.Event,
  MouseEvent: domWindow.MouseEvent,
  KeyboardEvent: domWindow.KeyboardEvent,
  React,
  IS_REACT_ACT_ENVIRONMENT: true,
})) Object.defineProperty(globalThis, name, { configurable: true, writable: true, value });

const { cleanup } = installDomTestCleanup(domWindow);

const toasts: Array<{ message: string; tone?: string }> = [];
const feedback = {
  confirm: async () => false,
  showToast: (message: string, options?: { tone?: string }) => { toasts.push({ message, tone: options?.tone }); return 1; },
  showUndo: () => -1,
  dismissToast: () => {},
};

async function mount(): Promise<{ container: HTMLDivElement; root: Root; render: (node: React.ReactNode) => Promise<void> }> {
  const container = domWindow.document.createElement("div") as unknown as HTMLDivElement;
  domWindow.document.body.append(container as never);
  const root = createRoot(container);
  cleanup(async () => {
    await act(async () => { root.unmount(); });
    container.remove();
  });
  const render = async (node: React.ReactNode) => {
    await act(async () => { root.render(<FeedbackContext.Provider value={feedback}>{node}</FeedbackContext.Provider>); });
  };
  return { container, root, render };
}

const TEXT_HUNK: GitHunk = {
  header: "@@ -1,3 +1,3 @@",
  oldStart: 1, oldCount: 3, newStart: 1, newCount: 3,
  lines: [{ status: " ", text: "a" }, { status: "-", text: "b" }, { status: "+", text: "c" }, { status: " ", text: "d" }],
};
const file = (path: string, status: GitDiffFile["status"] = "modified", hunks: GitHunk[] = [TEXT_HUNK]): GitDiffFile =>
  ({ path, status, binary: false, hunks });
const diffOf = (files: GitDiffFile[]): GitDiffInfo => ({
  scope: "uncommitted", diffHash: "c".repeat(64), stats: { filesChanged: files.length, insertions: 1, deletions: 1 }, files,
});

function staging(overrides: Partial<StagingControls> = {}): StagingControls & { discarded: Array<[string, boolean]> } {
  const discarded: Array<[string, boolean]> = [];
  return {
    onHunk: () => {},
    onLines: () => {},
    onDiscard: (path, newFile) => { discarded.push([path, newFile]); },
    pane: "combined",
    fineGrained: true,
    busyKey: null,
    discarded,
    ...overrides,
  };
}

/** Open a file's actions menu and read its rows: label, unavailable reason, danger. */
async function openActions(container: HTMLElement, path: string) {
  const trigger = container.querySelector<HTMLButtonElement>(`button[aria-label="${path} Actions"]`);
  assert.ok(trigger, `${path} has an actions menu`);
  await act(async () => { fireDomEvent.click(trigger); });
  const menu = doc.querySelector<HTMLElement>('[role="menu"]');
  assert.ok(menu, "the menu opened");
  const rows = [...menu.querySelectorAll('[role="menuitem"], [role="separator"]')].map((child) => child.getAttribute("role") === "separator"
    ? "—"
    : `${child.querySelector(".menu-text")?.textContent ?? ""}${child.getAttribute("aria-disabled") === "true"
      ? ` (${child.querySelector(".menu-desc")?.textContent ?? ""})` : ""}${child.classList.contains("danger") ? " [danger]" : ""}`);
  const item = (label: string) => [...menu.querySelectorAll<HTMLElement>('[role="menuitem"]')]
    .find((node) => node.getAttribute("data-menu-label") === label)!;
  return { rows, item, close: async () => { await act(async () => { fireDomEvent.keyDown(menu, { key: "Escape" }); }); } };
}

test("the file actions menu lists Open in Files, Attach File to Prompt, Copy Path, then the discard last", async () => {
  const { container, render } = await mount();
  const opened: SourceLocation[] = [];
  const attached: CreateWorkspaceReferenceRequest[] = [];
  const controls = staging();
  await render(
    <GitDiffViewer
      diff={diffOf([file("src/app.ts"), file("src/new.ts", "added")])}
      staging={controls}
      onOpenSourceLocation={(location) => { opened.push(location); }}
      onAttachWorkspaceReference={async (target) => { attached.push(target); }}
    />,
  );
  const tracked = await openActions(container, "src/app.ts");
  assert.deepEqual(tracked.rows, ["Open in Files", "Attach File to Prompt", "Copy Path", "—", "Discard Changes… [danger]"]);
  await act(async () => { fireDomEvent.click(tracked.item("Open in Files")); });
  assert.deepEqual(opened, [{ path: "src/app.ts" }]);

  const again = await openActions(container, "src/app.ts");
  await act(async () => { fireDomEvent.click(again.item("Attach File to Prompt")); });
  assert.deepEqual(attached, [{ path: "src/app.ts", kind: "file" }]);

  const discard = await openActions(container, "src/app.ts");
  await act(async () => { fireDomEvent.click(discard.item("Discard Changes…")); });
  assert.deepEqual(controls.discarded, [["src/app.ts", false]]);

  // A file this change adds is deleted by discarding it, and the item says so.
  const added = await openActions(container, "src/new.ts");
  assert.deepEqual(added.rows, ["Open in Files", "Attach File to Prompt", "Copy Path", "—", "Discard New File… [danger]"]);
  await act(async () => { fireDomEvent.click(added.item("Discard New File…")); });
  assert.deepEqual(controls.discarded.at(-1), ["src/new.ts", true]);
  assertNoDomNode(container.querySelector(".diff-open-source, .diff-discard"), "the head's old ↗ and Discard are gone");
});

test("discard is offered only where it can run, and a deleted file cannot be opened or attached", async () => {
  const { container, render } = await mount();
  const all = [file("notes.md", "untracked", []), file("src/gone.ts", "deleted"), file("src/moved.ts", "renamed"), file("logo.png")];
  all[3] = { ...all[3]!, binary: true, hunks: [] };
  await render(
    <GitDiffViewer diff={diffOf(all)} staging={staging()} onOpenSourceLocation={() => {}} onAttachWorkspaceReference={async () => {}} />,
  );
  const rows = async (path: string) => {
    const menu = await openActions(container, path);
    await menu.close();
    return menu.rows;
  };
  // An untracked file has no last commit to return to, and its content is not shown.
  assert.deepEqual(await rows("notes.md"), ["Open in Files", "Attach File to Prompt", "Copy Path"]);
  assert.deepEqual(await rows("src/gone.ts"), [
    "Open in Files (The file was deleted.)",
    "Attach File to Prompt (The file was deleted.)",
    "Copy Path",
    "—",
    "Discard Changes… [danger]",
  ]);
  assert.equal((await rows("src/moved.ts")).at(-1), "Discard Changes… [danger]");
  assert.equal((await rows("logo.png")).at(-1), "Discard Changes… [danger]", "a binary file is still tracked");

  // The staged and unstaged panes and a read-only scope never discard.
  for (const controls of [staging({ pane: "unstaged" }), staging({ pane: "staged" }), staging({ fineGrained: false }), undefined]) {
    await render(<GitDiffViewer diff={diffOf([file("src/app.ts")])} staging={controls} />);
    assert.deepEqual(await rows("src/app.ts"), ["Copy Path"]);
  }
});

test("a refused or busy discard stays listed with its reason and does nothing", async () => {
  const { container, render } = await mount();
  const refused = staging({ refusal: { reason: "Viewers can't change files.", id: "refusal" } });
  await render(<GitDiffViewer diff={diffOf([file("src/app.ts")])} staging={refused} />);
  const menu = await openActions(container, "src/app.ts");
  assert.equal(menu.rows.at(-1), "Discard Changes… (Viewers can't change files.) [danger]");
  await act(async () => { fireDomEvent.click(menu.item("Discard Changes…")); });
  assert.deepEqual(refused.discarded, []);
  await menu.close();

  const busy = staging({ busyKey: "src/other.ts#0" });
  await render(<GitDiffViewer diff={diffOf([file("src/app.ts")])} staging={busy} />);
  const waiting = await openActions(container, "src/app.ts");
  assert.equal(waiting.rows.at(-1), "Discard Changes… (Wait for the current change to finish.) [danger]");
});

test("Copy Path copies the whole path and says so", async () => {
  const { container, render } = await mount();
  const written: string[] = [];
  Object.defineProperty(domWindow.navigator, "clipboard", {
    configurable: true,
    value: { writeText: async (text: string) => { written.push(text); } },
  });
  toasts.length = 0;
  await render(<GitDiffViewer diff={diffOf([file("apps/shop/src/cart/cart-store.ts")])} />);
  const menu = await openActions(container, "apps/shop/src/cart/cart-store.ts");
  await act(async () => { fireDomEvent.click(menu.item("Copy Path")); await Promise.resolve(); });
  assert.deepEqual(written, ["apps/shop/src/cart/cart-store.ts"]);
  assert.deepEqual(toasts, [{ message: "Copied the path.", tone: "success" }]);
});

/** The collapsed state lifted to a host, as Review holds it. */
function Host({ diff, onPaths }: { diff: GitDiffInfo; onPaths?: (paths: ReadonlySet<string>) => void }) {
  const [paths, setPaths] = useState<ReadonlySet<string>>(new Set(["src/b.ts", "src/c.ts"]));
  return (
    <GitDiffViewer
      diff={diff}
      collapsedPaths={paths}
      onCollapsedPathsChange={(next) => { setPaths(next); onPaths?.(next); }}
    />
  );
}

test("collapsed sections are the file index: choosing one opens it and scrolls it to the top", async () => {
  const { container, render } = await mount();
  const scrolled: string[] = [];
  const proto = domWindow.HTMLElement.prototype as unknown as { scrollIntoView: (this: HTMLElement, options?: unknown) => void };
  proto.scrollIntoView = function scrollIntoView(options?: unknown) {
    scrolled.push(`${this.getAttribute("data-path")}:${JSON.stringify(options)}`);
  };
  const reported: string[][] = [];
  const diff = diffOf([file("src/a.ts"), file("src/b.ts"), file("src/c.ts")]);
  await render(<Host diff={diff} onPaths={(paths) => reported.push([...paths].sort())} />);
  const toggle = (path: string) => container.querySelector<HTMLButtonElement>(`.dfile[data-path="${path}"] .dfile-toggle`)!;
  const bodies = () => [...container.querySelectorAll<HTMLElement>(".dfile")]
    .map((section) => `${section.dataset.path}:${section.querySelector(".dfile-body") ? "open" : "row"}`);
  assert.deepEqual(bodies(), ["src/a.ts:open", "src/b.ts:row", "src/c.ts:row"], "the host's choice is what renders");
  assert.equal(toggle("src/b.ts").getAttribute("aria-expanded"), "false");

  await act(async () => { toggle("src/c.ts").click(); });
  assert.deepEqual(bodies(), ["src/a.ts:open", "src/b.ts:row", "src/c.ts:open"]);
  assert.deepEqual(reported, [["src/b.ts"]], "the host hears the new set");
  assert.deepEqual(scrolled, ['src/c.ts:{"block":"start"}'], "the opened file scrolls to the top");

  await act(async () => { toggle("src/a.ts").click(); });
  assert.deepEqual(scrolled, ['src/c.ts:{"block":"start"}'], "collapsing never scrolls");

  // A refresh with the same files keeps every section as it was.
  await render(<Host diff={{ ...diff, diffHash: "d".repeat(64) }} />);
  assert.deepEqual(bodies(), ["src/a.ts:row", "src/b.ts:row", "src/c.ts:open"]);
});

test("a stage race shows at the top of its own file's section, with Refresh, as an alert", async () => {
  const { container, render } = await mount();
  let refreshed = 0;
  const notice: DiffFileNotice = {
    path: "src/b.ts",
    message: "b.ts changed after this diff loaded, so the hunk wasn't staged.",
    onRefresh: () => { refreshed += 1; },
  };
  await render(<GitDiffViewer diff={diffOf([file("src/a.ts"), file("src/b.ts")])} fileNotice={notice} />);
  const alerts = [...container.querySelectorAll<HTMLElement>('[role="alert"]')];
  assert.equal(alerts.length, 1, "one notice at a time");
  const section = alerts[0]!.closest<HTMLElement>(".dfile");
  assert.equal(section?.dataset.path, "src/b.ts", "on the file it is about");
  assert.equal(alerts[0]!.previousElementSibling?.classList.contains("dfile-head"), true, "at the top, under the head");
  assert.ok(alerts[0]!.textContent?.includes(notice.message));
  const refresh = [...alerts[0]!.querySelectorAll("button")].find((button) => button.textContent === "Refresh")!;
  await act(async () => { refresh.click(); });
  assert.equal(refreshed, 1);

  // A file no longer in the diff still gets its notice read, above the sections.
  await render(<GitDiffViewer diff={diffOf([file("src/a.ts")])} fileNotice={notice} />);
  const orphan = container.querySelector<HTMLElement>('[role="alert"]');
  assert.equal(orphan?.parentElement?.classList.contains("diff-view"), true);
  assertNoDomNode(orphan?.closest(".dfile"));

  // And when the re-read left no files at all, the notice sits above the empty state.
  await render(<GitDiffViewer diff={diffOf([])} fileNotice={notice} empty={<p className="empty-probe">Everything is committed.</p>} />);
  const alone = container.querySelector<HTMLElement>('[role="alert"]');
  assert.ok(alone?.textContent?.includes(notice.message), "the warning is still shown");
  assert.equal(alone?.nextElementSibling?.classList.contains("empty-probe"), true, "above the empty state");
  await render(<GitDiffViewer diff={diffOf([])} fileNotice={notice} />);
  assert.ok(container.querySelector('[role="alert"]'), "and above the default empty line");
  assert.ok(container.querySelector(".diff-empty"));
});

const review = (open: boolean): DiffReviewControls => ({
  findings: [],
  anchoredFindingIds: new Set(),
  lineage: "uncommitted:combined",
  creating: false,
  busyFindingId: null,
  onCreate: async () => open,
  onStatus: async () => {},
});

test("Side by Side is two columns that break around an open editor, and each pair is a row when wrapped", async () => {
  const { container, render } = await mount();
  const long: GitHunk = {
    header: "@@ -1,4 +1,4 @@",
    oldStart: 1, oldCount: 4, newStart: 1, newCount: 4,
    lines: [
      { status: " ", text: "one" }, { status: "-", text: "two" }, { status: "+", text: "TWO" },
      { status: " ", text: "three" }, { status: " ", text: "four" },
    ],
  };
  const diff = diffOf([file("src/a.ts", "modified", [long])]);
  await render(<GitDiffViewer diff={diff} layout="split" review={review(true)} />);
  const runs = () => [...container.querySelectorAll<HTMLElement>(".dsplit")]
    .map((run) => [...run.querySelectorAll(":scope > .side")].map((side) => side.children.length));
  assert.deepEqual(runs(), [[4, 4]], "one run, a left and a right column, one row per pair");
  assertNoDomNode(container.querySelector(".diff-split-row"));

  // Open an editor on the new side of line 3 ("three"): the columns break under that row.
  const comment = container.querySelector<HTMLButtonElement>('button[aria-label="Add Finding on Line 3"]')!;
  await act(async () => { comment.click(); });
  assert.deepEqual(runs(), [[3, 3], [1, 1]]);
  const editor = container.querySelector(".diff-comment-editor");
  assert.ok(editor);
  assert.equal(editor.previousElementSibling?.classList.contains("dsplit"), true, "the editor spans both columns, between the runs");

  await render(<GitDiffViewer diff={diff} layout="split" wrap review={review(true)} />);
  assert.ok(container.querySelector(".diff-view.is-wrapped"));
  assert.equal(container.querySelectorAll(".dsplit.is-wrapped > .dsplit-pair").length, 4, "a row per pair when lines wrap");
});
