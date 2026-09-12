import assert from "node:assert/strict";
import { test } from "node:test";
import * as React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import {
  WORKSPACE_REFERENCE_MIME_TYPE,
  type GitDiffInfo,
  type WorkspaceReference,
} from "@wollipog/protocol";
import { ImageStrip } from "./images.js";
import { GitDiffViewer } from "./GitDiffViewer.js";
import { WorkspaceReferencePicker } from "./WorkspaceReferencePicker.js";

(globalThis as typeof globalThis & { React: typeof React }).React = React;

const reference: WorkspaceReference = {
  artifactId: "workspace:test",
  mimeType: WORKSPACE_REFERENCE_MIME_TYPE,
  sizeBytes: 0,
  sha256: "a".repeat(64),
  referenceVersion: 1,
  kind: "diff",
  path: "src/app.ts",
  rootFingerprint: "b".repeat(64),
  targetFingerprint: "a".repeat(64),
  startLine: 10,
  endLine: 12,
  side: "left",
  diffHash: "c".repeat(64),
  diffScope: "uncommitted",
};

test("workspace reference chips are inspectable and removable without rendering as images", () => {
  const html = renderToStaticMarkup(<ImageStrip images={[reference]} onRemove={() => {}} onInspectReference={() => {}} />);
  assert.match(html, /@.*src\/app\.ts:10-12.*Base/);
  assert.match(html, /aria-label="Inspect Workspace Reference/);
  assert.match(html, /aria-label="Remove Workspace Reference/);
  assert.doesNotMatch(html, /<img/);
});

test("the workspace picker exposes a keyboard-addressable listbox", () => {
  const html = renderToStaticMarkup(<WorkspaceReferencePicker
    listboxId="workspace-list"
    results={[{ path: "src/app.ts", isDirectory: false }, { path: "src", isDirectory: true }]}
    activeIndex={1}
    busy={false}
    error={null}
    truncated
    query="src"
    onSelect={() => {}}
  />);
  assert.match(html, /role="listbox"/);
  assert.match(html, /id="workspace-list-1" aria-selected="true"/);
  assert.match(html, /Refine your search/);
});

test("Review exposes selectable added, removed, and both context sides with immutable diff identity", () => {
  const diff: GitDiffInfo = {
    scope: "uncommitted",
    diffHash: "c".repeat(64),
    stats: { filesChanged: 1, insertions: 1, deletions: 1 },
    files: [{
      path: "src/app.ts",
      status: "modified",
      binary: false,
      hunks: [{
        header: "@@ -10,2 +10,2 @@",
        oldStart: 10,
        oldCount: 2,
        newStart: 10,
        newCount: 2,
        lines: [
          { status: " ", text: "context" },
          { status: "-", text: "old" },
          { status: "+", text: "new" },
        ],
      }],
    }],
  };
  const html = renderToStaticMarkup(<GitDiffViewer diff={diff} layout="split" onAttachWorkspaceReference={async () => {}} />);
  assert.match(html, /Select base line 10 for prompt/);
  assert.match(html, /Select worktree line 10 for prompt/);
  assert.match(html, /Select base line 11 for prompt/);
  assert.match(html, /Select worktree line 11 for prompt/);
  assert.match(html, /Attach Selected \(0\)/);
});
