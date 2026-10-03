import assert from "node:assert/strict";
import { test } from "node:test";
import React, { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { Window } from "happy-dom";
import type { GitDiffFile, GitDiffInfo } from "@wollipog/protocol";
import { installDomTestCleanup } from "../dom-test-cleanup.js";
import { GitDiffViewer, type DiffFileFocus } from "./GitDiffViewer.js";

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

const file = (path: string): GitDiffFile => ({
  path,
  status: "modified",
  binary: false,
  hunks: [{ header: "@@ -1 +1 @@", oldStart: 1, oldCount: 1, newStart: 1, newCount: 1, lines: [{ status: "-", text: "a" }, { status: "+", text: "b" }] }],
});
const diff: GitDiffInfo = {
  scope: "uncommitted",
  diffHash: "c".repeat(64),
  stats: { filesChanged: 2, insertions: 2, deletions: 2 },
  files: [file("src/a.ts"), file("src/b.ts")],
};

test("Open in Review expands its file, scrolls it into view and focuses its head, once per request", async () => {
  const { container, root } = await mount();
  const scrolled: string[] = [];
  const proto = domWindow.HTMLElement.prototype as unknown as { scrollIntoView: (this: HTMLElement) => void };
  proto.scrollIntoView = function scrollIntoView() { scrolled.push(this.getAttribute("data-path") ?? ""); };
  let handled = 0;
  const render = (focus: DiffFileFocus | null) => root.render(
    <GitDiffViewer diff={diff} focus={focus} onFocusHandled={() => { handled += 1; }} />,
  );
  await act(async () => render(null));
  const head = (path: string) => container.querySelector<HTMLButtonElement>(`.diff-file[data-path="${path}"] .diff-file-head`)!;
  await act(async () => head("src/b.ts").click());
  assert.equal(head("src/b.ts").getAttribute("aria-expanded"), "false", "the reader collapsed it");

  await act(async () => render({ path: "src/b.ts", request: 1 }));
  assert.equal(head("src/b.ts").getAttribute("aria-expanded"), "true");
  assert.deepEqual(scrolled, ["src/b.ts"]);
  assert.equal(domWindow.document.activeElement, head("src/b.ts") as unknown);
  assert.equal(handled, 1);

  await act(async () => render({ path: "src/b.ts", request: 1 }));
  assert.deepEqual(scrolled, ["src/b.ts"], "the same request is not met twice");
  await act(async () => render({ path: "src/b.ts", request: 2 }));
  assert.deepEqual(scrolled, ["src/b.ts", "src/b.ts"], "asking again scrolls again");
});

test("a file this diff does not hold ends the request without scrolling", async () => {
  const { root } = await mount();
  let handled = 0;
  await act(async () => root.render(
    <GitDiffViewer diff={diff} focus={{ path: "src/gone.ts", request: 1 }} onFocusHandled={() => { handled += 1; }} />,
  ));
  assert.equal(handled, 1);
});
