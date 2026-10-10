import React from "react";
import { createRoot } from "react-dom/client";
import type { GitDiffInfo } from "@wollipog/protocol";
import { GitDiffViewer, type DiffReviewControls, type StagingControls } from "../components/GitDiffViewer.js";
import { LineSelectionBar, useDiffLineSelection } from "../components/DiffLineSelection.js";
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

// `?pane=unstaged` offers line staging, `?layout=split` the split view, `?refused=1` a person who may
// not run Git actions, `?references=1` Attach to Prompt, `?review=1` findings (the gutter "+"), and
// `?select=1` Select Lines with its selection bar (#2849).
const pane = query.get("pane") === "unstaged" ? "unstaged" : "combined";
const layout = query.get("layout") === "split" ? "split" : "unified";
const refusal = query.get("refused") === "1"
  ? { reason: "Viewers can read this session's changes but cannot stage them.", id: "harness-git-refusal" }
  : null;
const attach = query.get("references") === "1" ? async () => {} : undefined;
const staging: StagingControls = { onHunk: noop, onLines: noop, onDiscard: noop, pane, fineGrained: true, busyKey: null, refusal };
const review: DiffReviewControls | undefined = query.get("review") === "1" ? {
  findings: [],
  anchoredFindingIds: new Set(),
  lineage: "uncommitted:combined",
  creating: false,
  busyFindingId: null,
  onCreate: async () => true,
  onStatus: async () => {},
} : undefined;

function Fixture() {
  const lines = useDiffLineSelection({ diff, sessionId: "diff-harness", view: layout });
  const select = query.get("select") === "1";
  return (
    <main style={{ maxWidth: 720, margin: "0 auto", padding: 24 }}>
      {refusal && <p id={refusal.id} className="muted">{refusal.reason}</p>}
      {select && (
        <button
          type="button"
          className="icon-btn sm"
          aria-pressed={lines.selecting}
          ref={lines.toggleRef}
          onClick={() => lines.setSelecting(!lines.selecting)}
        >
          Select Lines
        </button>
      )}
      <GitDiffViewer
        diff={diff}
        layout={layout}
        review={review}
        selection={select ? lines.controls : undefined}
        onAttachWorkspaceReference={attach}
        staging={staging}
      />
      {select && lines.placed.length > 0 && (
        <LineSelectionBar
          placed={lines.placed}
          diff={diff}
          onAttach={attach}
          stage={pane === "unstaged" ? { direction: "stage", unavailable: null, refusal, onLines: noop } : null}
          onClear={lines.clear}
          onRemove={lines.remove}
        />
      )}
    </main>
  );
}

createRoot(document.getElementById("root")!).render(<Fixture />);
