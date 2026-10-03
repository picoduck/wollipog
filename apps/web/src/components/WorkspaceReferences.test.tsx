import assert from "node:assert/strict";
import { test } from "node:test";
import * as React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import {
  WORKSPACE_REFERENCE_MIME_TYPE,
  type GitDiffInfo,
  type WorkspaceReference,
} from "@wollipog/protocol";
import { ComposerAttachments } from "./images.js";
import { REFERENCE_HASH_LABEL, WorkspaceReferenceDialog, workspaceReferenceCheckSentence } from "./WorkspaceReferenceDialog.js";
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
  const html = renderToStaticMarkup(<ComposerAttachments images={[reference]} onRemove={() => {}} onInspectReference={() => {}} />);
  assert.match(html, /class="ref-chip-path"><bdi>src\/app\.ts<\/bdi><\/span><span class="ref-chip-suffix">:10-12 · Base<\/span>/);
  assert.match(html, /aria-label="Inspect Reference src\/app\.ts:10-12 · Base"/);
  assert.match(html, /aria-label="Remove Reference src\/app\.ts:10-12 · Base"/);
  // No "@" glyph and no text "✕": an icon says what the chip is, and the remove is the close icon.
  assert.doesNotMatch(html, />@|✕/);
  assert.doesNotMatch(html, /<img/);
});

test("images and references share one tray and one remove recipe", () => {
  const lines: WorkspaceReference = { ...reference, kind: "lines", side: undefined };
  const html = renderToStaticMarkup(<ComposerAttachments
    images={[{ mimeType: "image/png", data: "AAAA" }, lines, { mimeType: "image/png", data: "BBBB" }]}
    onRemove={() => {}}
  />);
  assert.match(html, /^<div class="composer-attachments">/);
  // Images are numbered among images, so the reference between them does not take a number.
  assert.deepEqual([...html.matchAll(/aria-label="(Remove [^"]+)"/g)].map((match) => match[1]),
    ["Remove Attached Image 1", "Remove Reference src/app.ts:10-12", "Remove Attached Image 2"]);
  assert.equal(html.match(/class="attach-remove"/g)?.length, 3);
  assert.match(html, /alt="Attached image 2"/);
});

function dialog(overrides: Partial<WorkspaceReference> = {}, machineName: string | null = "Studio Mac") {
  return renderToStaticMarkup(<WorkspaceReferenceDialog
    reference={{ ...reference, ...overrides }}
    machineName={machineName}
    onClose={() => {}}
    onRemove={() => {}}
    onOpenInFiles={overrides.kind === "lines" || overrides.kind === "file" ? () => {} : undefined}
  />);
}

test("the reference dialog names its kind and lists its facts without a Done", () => {
  const lines = dialog({ kind: "lines", side: undefined, diffHash: undefined, diffScope: undefined, startLine: 18, endLine: 21 });
  assert.match(lines, /File Reference/);
  assert.deepEqual([...lines.matchAll(/<dt>([^<]+)<\/dt>/g)].map((match) => match[1]), ["Path", "Lines", REFERENCE_HASH_LABEL]);
  assert.match(lines, /<dd>18–21<\/dd>/);
  // Twelve characters of the hash, and its Copy button copies exactly those.
  assert.match(lines, /<span class="mono">aaaaaaaaaaaa<\/span>/);
  assert.match(lines, new RegExp(`aria-label="Copy ${REFERENCE_HASH_LABEL}"`));
  assert.match(lines, /aria-label="Copy Path"/);
  assert.match(lines, /Before sending, Wollipog checks that these lines haven(&#x27;|')t changed on Studio Mac\./);
  assert.match(lines, />Remove from Message</);
  assert.match(lines, /Open in Files/);
  assert.doesNotMatch(lines, />Done</);
  assert.doesNotMatch(lines, /btn primary/);

  const diffHtml = dialog();
  assert.match(diffHtml, /Diff Reference/);
  assert.deepEqual([...diffHtml.matchAll(/<dt>([^<]+)<\/dt>/g)].map((match) => match[1]),
    ["Path", "Lines", "Side", "Scope", REFERENCE_HASH_LABEL]);
  assert.doesNotMatch(diffHtml, /Open in Files/);

  const folder = dialog({ kind: "directory", startLine: undefined, endLine: undefined, side: undefined, diffScope: undefined }, null);
  assert.match(folder, /Folder Reference/);
  assert.match(folder, /Before sending, Wollipog checks that this folder hasn(&#x27;|')t changed\./);
});

test("the check sentence follows what the reference points at", () => {
  const file = { ...reference, kind: "file" as const, startLine: undefined, endLine: undefined };
  assert.equal(workspaceReferenceCheckSentence(file, "Studio Mac"), "Before sending, Wollipog checks that this file hasn't changed on Studio Mac.");
  assert.equal(workspaceReferenceCheckSentence(file, null), "Before sending, Wollipog checks that this file hasn't changed.");
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
