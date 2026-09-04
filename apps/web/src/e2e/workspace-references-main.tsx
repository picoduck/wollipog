import React, { useState } from "react";
import { createRoot } from "react-dom/client";
import type { CreateWorkspaceReferenceRequest, GitDiffInfo, PromptImageInput, WorkspaceReference } from "@wollipog/protocol";
import { GitDiffViewer } from "../components/GitDiffViewer.js";
import { WorkspaceReferencePicker } from "../components/WorkspaceReferencePicker.js";
import { ImageStrip } from "../components/images.js";
import "../styles.css";

const query = new URLSearchParams(window.location.search);
const after = query.get("state") !== "before";
document.documentElement.dataset.theme = query.get("theme") === "light" ? "light" : "dark";

const diffHash = "d".repeat(64);
const diff: GitDiffInfo = {
  scope: "uncommitted",
  diffHash,
  stats: { filesChanged: 1, insertions: 2, deletions: 1 },
  files: [{
    path: "src/session.ts",
    status: "modified",
    binary: false,
    hunks: [{
      header: "@@ -18,4 +18,5 @@ export async function sendPrompt()",
      oldStart: 18,
      oldCount: 4,
      newStart: 18,
      newCount: 5,
      lines: [
        { status: " ", text: "  const prompt = composeText();" },
        { status: "-", text: "  return client.send(prompt);" },
        { status: "+", text: "  const context = resolveReferences();" },
        { status: "+", text: "  return client.send(prompt, context);" },
        { status: " ", text: "}" },
      ],
    }],
  }],
};

function reference(target: CreateWorkspaceReferenceRequest, id: string): WorkspaceReference {
  const revision = id.padEnd(64, "a").slice(0, 64).replace(/[^a-f0-9]/g, "a");
  return {
    artifactId: `workspace:${id}`,
    mimeType: "application/vnd.wollipog.workspace-reference+json",
    sizeBytes: 0,
    sha256: revision,
    referenceVersion: 1,
    kind: target.kind,
    path: target.path,
    rootFingerprint: "b".repeat(64),
    targetFingerprint: revision,
    ...(target.startLine === undefined ? {} : { startLine: target.startLine, endLine: target.endLine }),
    ...(target.side === undefined ? {} : { side: target.side }),
    ...(target.diffHash === undefined ? {} : { diffHash: target.diffHash, diffScope: target.diffScope }),
  };
}

function Fixture() {
  const [attachments, setAttachments] = useState<PromptImageInput[]>(after ? [reference({
    path: "src/session.ts", kind: "lines", startLine: 18, endLine: 21,
  }, "lines")] : []);
  const attach = async (target: CreateWorkspaceReferenceRequest) => {
    setAttachments((current) => [...current, reference(target, `ref${current.length}`)]);
  };
  return (
    <main style={{ maxWidth: 1050, margin: "0 auto", padding: "24px 18px 60px", display: "grid", gap: 22 }}>
      <header>
        <h1 style={{ margin: 0, fontSize: 24 }}>Workspace References</h1>
        <p className="muted">Attach exact workspace context without copying file contents into the composer.</p>
      </header>
      <section className="card" style={{ padding: 16, display: "grid", gap: 12 }}>
        <strong>Prompt Composer</strong>
        <ImageStrip images={attachments} onRemove={(index) => setAttachments((current) => current.filter((_, i) => i !== index))} />
        <div style={{ position: "relative", marginTop: after ? 104 : 0 }}>
          {after && (
            <WorkspaceReferencePicker
              listboxId="workspace-evidence-picker"
              results={[
                { path: "src/session.ts", isDirectory: false },
                { path: "src/components", isDirectory: true },
              ]}
              activeIndex={0}
              busy={false}
              error={null}
              truncated={false}
              query="src"
              onSelect={(candidate) => void attach({ path: candidate.path, kind: candidate.isDirectory ? "directory" : "file" })}
            />
          )}
          <textarea className="composer-textarea" aria-label="Prompt" defaultValue={after ? "Review @src" : "Review the current changes"} style={{ width: "100%", minHeight: 86 }} />
        </div>
      </section>
      <section className="card" style={{ padding: 16, minWidth: 0 }}>
        <strong>Review</strong>
        <GitDiffViewer diff={diff} onAttachWorkspaceReference={after ? attach : undefined} />
      </section>
    </main>
  );
}

const root = document.getElementById("root");
if (!root) throw new Error("missing #root element");
createRoot(root).render(<Fixture />);
