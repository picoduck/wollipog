import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import React, { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { Window } from "happy-dom";
import type { SessionEvent, SessionEventPayload } from "@wollipog/protocol";
import { deriveTimeline, type TimelineItem } from "../timeline.js";
import { installDomTestCleanup } from "../dom-test-cleanup.js";
import { assertNoDomNode } from "../dom-test-assertions.js";
import { EventTimeline } from "./EventTimeline.js";

const domWindow = new Window({ url: "http://localhost/" });
for (const [name, value] of Object.entries({
  window: domWindow,
  document: domWindow.document,
  navigator: domWindow.navigator,
  HTMLElement: domWindow.HTMLElement,
  Node: domWindow.Node,
  React,
  IS_REACT_ACT_ENVIRONMENT: true,
})) Object.defineProperty(globalThis, name, { configurable: true, writable: true, value });

const { cleanup } = installDomTestCleanup(domWindow);

async function mount(): Promise<{ container: HTMLDivElement; root: Root }> {
  const container = domWindow.document.createElement("div") as unknown as HTMLDivElement;
  domWindow.document.body.append(container as never);
  const root = createRoot(container);
  cleanup(async () => {
    await act(async () => { root.unmount(); });
    container.remove();
  });
  return { container, root };
}

async function openWork(container: HTMLElement) {
  for (const disclosure of container.querySelectorAll<HTMLButtonElement>(".tl-work > .disclosure-trigger")) {
    if (disclosure.getAttribute("aria-expanded") !== "true") await act(async () => disclosure.click());
  }
}

let seq = 0;
const ev = (payload: SessionEventPayload): SessionEvent => {
  seq += 1;
  return { id: seq, seq, sessionId: "plan-diffs", ts: seq * 1_000, payload };
};
type Status = "pending" | "in_progress" | "completed";
const plan = (...statuses: Status[]) => ev({
  kind: "plan",
  entries: statuses.map((status, index) => ({ content: `Step ${index + 1}`, status })),
});

const button = (scope: Element, text: string) =>
  [...scope.querySelectorAll<HTMLButtonElement>("button")].find((candidate) => candidate.textContent?.includes(text));

test("a plan card counts what is done and lines every label up in one icon column, with no glyphs", async () => {
  const { container, root } = await mount();
  const items = deriveTimeline([ev({ kind: "user_message", text: "Go" }), plan("completed", "in_progress", "pending")]);
  await act(async () => root.render(<EventTimeline items={items} />));
  await openWork(container);
  const card = container.querySelector<HTMLElement>(".tl-plan")!;
  assert.ok(card);
  const head = card.querySelector(".tl-plan-head")!;
  assert.equal(head.textContent, "Plan1 of 3 Done");
  assert.equal(head.querySelector(".count")?.textContent, "1 of 3 Done");
  assert.ok(head.querySelector("svg.lucide-list-todo"), "the head's ListTodo icon");
  const rows = [...card.querySelectorAll(".tl-plan-item")];
  assert.equal(rows.length, 3);
  assert.deepEqual(rows.map((row) => row.querySelector(".tl-plan-icon > svg")?.getAttribute("class")?.match(/lucide-(circle[a-z-]*)/)?.[1]),
    ["circle-check", "circle-dot", "circle"]);
  for (const row of rows) {
    assert.equal(row.firstElementChild?.className, "tl-plan-icon", "every label follows the same 16px icon column");
    assert.equal(row.querySelector(".tl-plan-icon > svg")?.getAttribute("width"), "16");
  }
  assert.doesNotMatch(card.textContent ?? "", /[✓◐○◖]|PLAN/);
  assert.deepEqual(rows.map((row) => row.querySelector(".sr-only")?.textContent), [", Done", ", In Progress", ", Not Started"]);

  const source = readFileSync(new URL("./EventTimeline.tsx", import.meta.url), "utf8");
  assert.doesNotMatch(source, /[✓◐○]/, "no plan glyphs remain in EventTimeline.tsx");
});

test("three plan updates in one turn show one card with two earlier versions; a later turn gets its own card", async () => {
  const { container, root } = await mount();
  const items = deriveTimeline([
    ev({ kind: "user_message", text: "First" }),
    plan("pending", "pending", "pending"),
    plan("completed", "in_progress", "pending"),
    plan("completed", "completed", "in_progress"),
    ev({ kind: "agent_message", text: "Done for now.", final: true }),
    ev({ kind: "user_message", text: "Second" }),
    plan("completed", "completed", "completed"),
  ]);
  await act(async () => root.render(<EventTimeline items={items} />));
  await openWork(container);
  const cards = [...container.querySelectorAll<HTMLElement>(".tl-plan")];
  assert.equal(cards.length, 2, "one card per turn that changed the plan");
  const [first, second] = cards;
  assert.equal(first!.querySelector(".tl-plan-head .count")?.textContent, "2 of 3 Done", "the first card shows its turn's latest entries");
  assert.equal(second!.querySelector(".tl-plan-head .count")?.textContent, "3 of 3 Done");
  assertNoDomNode(second!.querySelector(".tl-plan-history"), "a card with one version has no history");

  const trigger = button(first!, "Show Earlier Versions")!;
  assert.equal(trigger.getAttribute("aria-expanded"), "false");
  assert.equal(trigger.querySelector(".count")?.textContent, "2");
  await act(async () => trigger.click());
  assert.equal(button(first!, "Show Earlier Versions")!.getAttribute("aria-expanded"), "true");
  const versions = [...first!.querySelectorAll(".tl-plan-version")];
  assert.deepEqual(versions.map((version) => version.querySelector(".tl-plan-version-head")?.textContent), [
    "Version 10 of 3 Done",
    "Version 21 of 3 Done",
  ]);
});

const EDIT = [
  "diff --git a/src/components/Header.tsx b/src/components/Header.tsx",
  "index 9f2c1aa..4e0b7d2 100644",
  "--- a/src/components/Header.tsx",
  "+++ b/src/components/Header.tsx",
  "@@ -12,3 +12,4 @@ export function Header({ title }: { title: string }) {",
  "   const version = useVersion();",
  "-  const label = title.toUpperCase();",
  "+  const label = title;",
  "+  const note = latest();",
  "   return (",
].join("\n");

const NEW_FILE = [
  "diff --git a/src/notes.ts b/src/notes.ts",
  "new file mode 100644",
  "index 0000000..3b18e51",
  "--- /dev/null",
  "+++ b/src/notes.ts",
  "@@ -0,0 +1,12 @@",
  ...Array.from({ length: 12 }, (_, index) => `+export const line${index + 1} = ${index + 1};`),
].join("\n");

const edits: TimelineItem[] = [
  { kind: "user_message", id: 1, text: "Edit" },
  { kind: "file_edit", id: 2, path: "/repo/src/components/Header.tsx", diff: EDIT },
  { kind: "file_edit", id: 3, path: "/repo/src/notes.ts", diff: NEW_FILE },
  { kind: "agent_message", id: 4, text: "Edited." },
];

async function openEdits(onOpenInReview?: (path: string) => void) {
  const { container, root } = await mount();
  await act(async () => root.render(<EventTimeline items={edits} workspaceRoot="/repo" onOpenInReview={onOpenInReview} />));
  await openWork(container);
  const steps = [...container.querySelectorAll<HTMLElement>("details.tl-step")];
  for (const step of steps) await act(async () => step.querySelector<HTMLElement>("summary")!.click());
  return { container, edit: steps[0]!, created: steps[1]! };
}

test("an edit names its relative path once with its counts, and its diff drops Git's metadata", async () => {
  const { edit } = await openEdits();
  const object = edit.querySelector(".tl-step-object")!;
  assert.equal(object.textContent, "src/components/Header.tsx");
  assert.equal(object.querySelector(".tl-path-dir")?.textContent, "src/components/", "the directory is faint");
  assert.equal(edit.textContent?.split("src/components/Header.tsx").length, 2, "the path is shown once");
  assert.doesNotMatch(edit.textContent ?? "", /\/repo\//);
  assert.match(edit.querySelector(".tl-step-trail")?.textContent ?? "", /^\+2 −1/);
  assert.ok(edit.querySelector(".tl-step-icon svg.lucide-file-pen"));
  const body = edit.querySelector(".tl-diff")!;
  assert.doesNotMatch(body.textContent ?? "", /diff --git|index 9f2c1aa|new file mode|^---|\+\+\+|@@/m);
  assert.equal(body.querySelector(".tl-diff-hunk-label")?.textContent, "Lines 12–15 in Header()");
  const lines = [...body.querySelectorAll(".tl-diff-line")].map((line) => [
    line.className,
    line.querySelector(".tl-diff-number")?.textContent,
    line.querySelector(".tl-diff-sign")?.textContent,
  ]);
  assert.deepEqual(lines, [
    ["tl-diff-line", "12", ""],
    ["tl-diff-line is-removed", "13", "−"],
    ["tl-diff-line is-added", "13", "+"],
    ["tl-diff-line is-added", "14", "+"],
    ["tl-diff-line", "15", ""],
  ]);
  assert.ok(!body.querySelector(".tl-diff-file")!.classList.contains("is-plain"), "an edited file keeps its washes");
});

test("a new file is plain code with line numbers and + signs, collapsed after 8 lines", async () => {
  const { created } = await openEdits();
  assert.ok(created.querySelector(".tl-step-icon svg.lucide-file-plus"), "FilePlus marks a new file");
  const file = created.querySelector(".tl-diff-file")!;
  assert.ok(file.classList.contains("is-plain"), "a new file has no wash");
  const numbers = () => [...created.querySelectorAll(".tl-diff-number")].map((cell) => cell.textContent);
  assert.deepEqual(numbers(), ["1", "2", "3", "4", "5", "6", "7", "8"]);
  assert.ok([...created.querySelectorAll(".tl-diff-sign")].every((sign) => sign.textContent === "+"));
  const more = button(created, "More Lines")!;
  assert.equal(more.textContent, "Show 4 More Lines");
  await act(async () => more.click());
  assert.equal(numbers().length, 12);
  assert.equal(button(created, "Fewer Lines")?.textContent, "Show Fewer Lines");

  const stylesheet = readFileSync(new URL("../styles.css", import.meta.url), "utf8");
  assert.match(stylesheet, /\.tl-diff-file:not\(\.is-plain\) \.tl-diff-line\.is-added \{ background: color-mix\(in srgb, var\(--green\) 9%, transparent\); \}/);
  assert.match(stylesheet, /\.tl-diff-file:not\(\.is-plain\) \.tl-diff-line\.is-removed \{ background: color-mix\(in srgb, var\(--red\) 9%, transparent\); \}/);
});

test("Open in Review opens the Review tab on the relative path, and Copy Path copies it", async () => {
  const opened: string[] = [];
  const copied: string[] = [];
  Object.defineProperty(domWindow.navigator, "clipboard", {
    configurable: true,
    value: { writeText: async (text: string) => { copied.push(text); } },
  });
  const { edit } = await openEdits((path) => opened.push(path));
  await act(async () => button(edit, "Open in Review")!.click());
  assert.deepEqual(opened, ["src/components/Header.tsx"]);
  await act(async () => button(edit, "Copy Path")!.click());
  assert.deepEqual(copied, ["src/components/Header.tsx"]);
});

test("without a Review tab there is no Open in Review, and the per-turn capture offers no path actions", async () => {
  const { edit } = await openEdits();
  assert.equal(button(edit, "Open in Review"), undefined);
  const { container, root } = await mount();
  await act(async () => root.render(<EventTimeline
    items={[{ kind: "user_message", id: 1, text: "Go" }, { kind: "file_edit", id: 2, path: "worktree", diff: `${EDIT}\n${NEW_FILE}` }]}
    workspaceRoot="/repo"
    onOpenInReview={() => {}}
  />));
  await openWork(container);
  const capture = container.querySelector<HTMLElement>("details.tl-step")!;
  await act(async () => capture.querySelector<HTMLElement>("summary")!.click());
  assertNoDomNode(capture.querySelector(".tl-diff-actions"), "the per-turn capture has no path actions");
  assert.deepEqual([...capture.querySelectorAll(".tl-diff-file-path")].map((path) => path.textContent),
    ["src/components/Header.tsx", "src/notes.ts"], "a capture of several files names each file it shows");
});

async function openCapture(diff: string) {
  const { container, root } = await mount();
  await act(async () => root.render(<EventTimeline
    items={[{ kind: "user_message", id: 1, text: "Go" }, { kind: "file_edit", id: 2, path: "worktree", diff }]}
    workspaceRoot="/repo"
  />));
  await openWork(container);
  const capture = container.querySelector<HTMLElement>("details.tl-step")!;
  await act(async () => capture.querySelector<HTMLElement>("summary")!.click());
  return capture;
}

test("a capture of one file still names it, and changes with no lines say what changed", async () => {
  const single = await openCapture(EDIT);
  assert.deepEqual([...single.querySelectorAll(".tl-diff-file-path")].map((path) => path.textContent), ["src/components/Header.tsx"]);
  const binary = await openCapture("diff --git a/logo.png b/logo.png\nindex 1..2 100644\nBinary files a/logo.png and b/logo.png differ");
  assert.equal(binary.querySelector(".tl-diff-file-path")?.textContent, "logo.png");
  assert.equal(binary.querySelector(".tl-diff-note")?.textContent, "Binary file changed.");
  const moved = await openCapture("diff --git a/src/old.ts b/src/new.ts\nsimilarity index 100%\nrename from src/old.ts\nrename to src/new.ts");
  assert.equal(moved.querySelector(".tl-diff-file-path")?.textContent, "src/new.ts");
  assert.equal(moved.querySelector(".tl-diff-note")?.textContent, "Renamed from src/old.ts.");
});

test("a diff too large for a spread call still renders its first 8 lines", async () => {
  const lines = 150_000;
  const huge = `@@ -0,0 +1,${lines} @@\n${Array.from({ length: lines }, (_, index) => `+line ${index + 1}`).join("\n")}`;
  const { container, root } = await mount();
  await act(async () => root.render(<EventTimeline
    items={[{ kind: "user_message", id: 1, text: "Go" }, { kind: "file_edit", id: 2, path: "/repo/big.txt", diff: huge }]}
    workspaceRoot="/repo"
  />));
  await openWork(container);
  const step = container.querySelector<HTMLElement>("details.tl-step")!;
  await act(async () => step.querySelector<HTMLElement>("summary")!.click());
  assert.equal(step.querySelectorAll(".tl-diff-line").length, 8);
  assert.equal(button(step, "More Lines")?.textContent, `Show ${lines - 8} More Lines`);
});

test("an edit's path keeps its file name whole when the directory gives way", async () => {
  const { edit } = await openEdits();
  const path = edit.querySelector(".tl-step-object .tl-path")!;
  assert.equal(path.getAttribute("title"), "src/components/Header.tsx", "the whole path is the label's title");
  assert.deepEqual([...path.children].map((part) => [part.className, part.textContent]), [
    ["tl-path-dir", "src/components/"],
    ["tl-path-name", "Header.tsx"],
  ]);
  const stylesheet = readFileSync(new URL("../styles.css", import.meta.url), "utf8");
  assert.match(stylesheet, /\.tl-path-name \{\n  flex: 0 0 auto;\n  max-width: 100%;/, "the name never shrinks while the directory can");
});
