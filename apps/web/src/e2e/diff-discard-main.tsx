import React from "react";
import { createRoot } from "react-dom/client";
import type { GitDiffInfo } from "@wollipog/protocol";
import { GitDiffViewer } from "../components/GitDiffViewer.js";
import "../styles.css";

const query = new URLSearchParams(window.location.search);
document.documentElement.dataset.theme = query.get("theme") === "light" ? "light" : "dark";
const scheme = query.get("scheme");
if (scheme && scheme !== "wollipog") document.documentElement.dataset.scheme = scheme;

const diff: GitDiffInfo = {
  scope: "uncommitted",
  diffHash: "d".repeat(64),
  stats: { filesChanged: 1, insertions: 1, deletions: 1 },
  files: [{
    path: "src/session.ts",
    status: "modified",
    binary: false,
    hunks: [{
      header: "@@ -18,3 +18,3 @@ export async function sendPrompt()",
      oldStart: 18,
      oldCount: 3,
      newStart: 18,
      newCount: 3,
      lines: [
        { status: " ", text: "  const prompt = composeText();" },
        { status: "-", text: "  return client.send(prompt);" },
        { status: "+", text: "  return client.send(prompt, resolveReferences());" },
      ],
    }],
  }],
};

const noop = () => {};

// `?pane=unstaged` adds the per-line selectors (#2044), `?layout=split` the split view,
// `?refused=1` a person who may not run Git actions, and `?references=1` the prompt-line boxes.
const pane = query.get("pane") === "unstaged" ? "unstaged" : "combined";
const layout = query.get("layout") === "split" ? "split" : "unified";
const refusal = query.get("refused") === "1"
  ? { reason: "Viewers can read this session's changes but cannot stage them.", id: "harness-git-refusal" }
  : null;

createRoot(document.getElementById("root")!).render(
  <main style={{ maxWidth: 720, margin: "0 auto", padding: 24 }}>
    {refusal && <p id={refusal.id} className="muted">{refusal.reason}</p>}
    <GitDiffViewer
      diff={diff}
      layout={layout}
      onAttachWorkspaceReference={query.get("references") === "1" ? async () => {} : undefined}
      staging={{ onHunk: noop, onLines: noop, onDiscard: noop, pane, fineGrained: true, busyKey: null, refusal }}
    />
  </main>,
);
