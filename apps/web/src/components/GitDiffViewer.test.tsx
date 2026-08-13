import assert from "node:assert/strict";
import { test } from "node:test";
import * as React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import type { GitDiffInfo } from "@wollipog/protocol";
import { GitDiffViewer } from "./GitDiffViewer.js";

(globalThis as typeof globalThis & { React: typeof React }).React = React;

test("diff source links expose current-file headers and right-side line coordinates only", () => {
  const diff: GitDiffInfo = {
    scope: "uncommitted",
    diffHash: "a".repeat(64),
    stats: { filesChanged: 2, insertions: 1, deletions: 2 },
    files: [
      {
        path: "src/app.ts",
        status: "modified",
        binary: false,
        hunks: [{
          header: "@@ -10 +20 @@",
          oldStart: 10,
          oldCount: 1,
          newStart: 20,
          newCount: 1,
          lines: [{ status: "-", text: "old" }, { status: "+", text: "new" }],
        }],
      },
      {
        path: "src/deleted.ts",
        status: "deleted",
        binary: false,
        hunks: [{
          header: "@@ -1 +0,0 @@",
          oldStart: 1,
          oldCount: 1,
          newStart: 0,
          newCount: 0,
          lines: [{ status: "-", text: "gone" }],
        }],
      },
    ],
  };
  const html = renderToStaticMarkup(React.createElement(GitDiffViewer, {
    diff,
    onOpenSourceLocation: () => undefined,
  }));
  assert.match(html, /aria-label="Open src\/app\.ts"/);
  assert.match(html, /aria-label="Open src\/app\.ts line 20"/);
  assert.doesNotMatch(html, /aria-label="Open src\/app\.ts line 10"/);
  assert.doesNotMatch(html, /aria-label="Open src\/deleted\.ts"/);
});

test("diff source links fail closed for noncanonical paths", () => {
  const diff: GitDiffInfo = {
    scope: "uncommitted",
    diffHash: "b".repeat(64),
    stats: { filesChanged: 1, insertions: 1, deletions: 0 },
    files: [{
      path: "../outside.ts",
      status: "added",
      binary: false,
      hunks: [{
        header: "@@ -0,0 +1 @@",
        oldStart: 0,
        oldCount: 0,
        newStart: 1,
        newCount: 1,
        lines: [{ status: "+", text: "new" }],
      }],
    }],
  };
  const html = renderToStaticMarkup(React.createElement(GitDiffViewer, {
    diff,
    onOpenSourceLocation: () => undefined,
  }));
  assert.doesNotMatch(html, /aria-label="Open \.\.\/outside\.ts/);
});
