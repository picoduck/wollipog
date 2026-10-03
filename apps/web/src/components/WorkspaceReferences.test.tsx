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

function picker(overrides: Partial<React.ComponentProps<typeof WorkspaceReferencePicker>> = {}) {
  return renderToStaticMarkup(<WorkspaceReferencePicker
    listboxId="workspace-list"
    results={[{ path: "src/app.ts", isDirectory: false }, { path: "src", isDirectory: true }]}
    activeIndex={1}
    busy={false}
    error={null}
    truncated={false}
    query="src"
    workspaceName="wollipog"
    machineName="Studio Mac"
    machineOnline
    onSelect={() => {}}
    {...overrides}
  />);
}

test("the workspace picker exposes a keyboard-addressable listbox", () => {
  const html = picker({ truncated: true });
  assert.match(html, /role="listbox"/);
  assert.match(html, /id="workspace-list-1"[^>]*aria-selected="true"/);
  assert.match(html, /class="picker-note">More matches exist\. Keep typing to narrow them\./);
});

test("workspace rows show an icon, the name before its folder, and the match underlined", () => {
  const html = picker({ results: [{ path: "apps/web/src/index.ts", isDirectory: false }], query: "web", activeIndex: 0 });
  assert.doesNotMatch(html, /📁|📄/u);
  assert.match(html, /aria-label="apps\/web\/src\/index\.ts"/);
  assert.match(html, /<span class="picker-name">index\.ts<\/span><span class="picker-path"><bdi>apps\/<mark>web<\/mark>\/src<\/bdi><\/span>/);
  assert.match(picker({ query: "app" }), /<span class="picker-name"><mark>app<\/mark>\.ts<\/span>/);
});

test("the workspace picker shows one state at a time in plain words", () => {
  const noQuery = picker({ query: "", results: [] });
  assert.match(noQuery, /Type a file or folder name\./);
  assert.match(noQuery, /Searches wollipog on Studio Mac\./);
  assert.match(picker({ busy: true, results: [] }), /role="status"[^>]*>.*Searching the workspace…/);
  // A search in flight keeps the previous results instead of flickering to the busy row.
  assert.doesNotMatch(picker({ busy: true }), /Searching the workspace/);
  assert.match(picker({ results: [], query: "zz" }), /No files or folders match “zz”\./);
  const offline = picker({ error: "runner is offline", machineOnline: false });
  assert.match(offline, /role="alert"/);
  assert.match(offline, /Studio Mac is offline\. Try again when it reconnects\./);
  assert.doesNotMatch(offline, /role="option"/);
  assert.match(picker({ error: "socket exploded: ECONNRESET" }), /Couldn&#x27;t search the workspace\. Try again\./);
  assert.doesNotMatch(picker({ error: "socket exploded: ECONNRESET" }), /ECONNRESET/);
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
  assert.match(html, /Select Base Line 10 for Prompt/);
  assert.match(html, /Select Worktree Line 10 for Prompt/);
  assert.match(html, /Select Base Line 11 for Prompt/);
  assert.match(html, /Select Worktree Line 11 for Prompt/);
  assert.match(html, /Attach Selected \(0\)/);
});
