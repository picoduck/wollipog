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

createRoot(document.getElementById("root")!).render(
  <main style={{ maxWidth: 720, margin: "0 auto", padding: 24 }}>
    <GitDiffViewer
      diff={diff}
      staging={{ onHunk: noop, onLines: noop, onDiscard: noop, pane: "combined", fineGrained: true, busyKey: null }}
    />
  </main>,
);
