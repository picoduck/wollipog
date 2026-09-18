import React from "react";
import { createRoot } from "react-dom/client";
import {
  PROTOCOL_VERSION,
  type GitDiffInfo,
  type GitStatusInfo,
  type ReviewFinding,
  type SessionView,
} from "@wollipog/protocol";
import { api, type ApiClient } from "../api.js";
import { ApiProvider } from "../api-context.js";
import { FeedbackProvider } from "../components/FeedbackProvider.js";
import { ReviewPanel } from "../components/ReviewPanel.js";
import type { GitStatus } from "../components/useGitStatus.js";
import "../styles.css";

/**
 * A Review pane as it looks immediately after a page reload (#1286).
 *
 * Mounting this page IS the reload: the panel starts with no carried anchor state, exactly as it
 * does when the tab is refreshed, opened a second time, or synced to another device. The finding
 * was written against an earlier change-set hash — the reviewer has since staged a hunk in a
 * different file — while its own line is byte-identical.
 *
 * `?stored=0` serves that finding without its anchored line text, which is every finding written
 * before #1286 and the behaviour this fixture exists to contrast: hash equality is the only test
 * left, so an untouched line reads "Stale Diff Anchor". The default serves the same finding with
 * the line recorded, which is what keeps it inline.
 */
const params = new URLSearchParams(window.location.search);
document.documentElement.setAttribute("data-theme", params.get("theme") === "light" ? "light" : "dark");
const stored = params.get("stored") !== "0";

/** The line the finding was written against — unchanged by everything that happened since. */
const ANCHORED_LINE = "      return retry(attempt + 1);";

const session: SessionView = {
  id: "review-anchor-reload-e2e", runnerId: "runner-1", workspaceId: "workspace-1", workspaceName: "Wollipog",
  projectId: null, agentId: "claude", agentName: "Claude", title: "Harden the Retry Path", status: "idle",
  column: "review", runId: null, useWorktree: true, worktreePath: "/workspace/wollipog",
  archived: false, createdAt: 1, updatedAt: 1, lastEventAt: 1, messageCount: 1, eventEpoch: 0,
  preview: null, pendingApproval: null, driver: "claude-code", model: null, effort: null,
  permissionMode: null, tokensIn: 0, tokensOut: 0, costUsd: 0, adopted: false,
};

const status: GitStatusInfo = {
  branch: "agent/retry-hardening",
  files: [{ status: "M", path: "src/retry.ts" }, { status: "M", path: "src/telemetry.ts" }],
  hasChanges: true, ahead: 0, remoteUrl: null, headSha: "abc1234",
  stagedCount: 1, addedLines: 3, deletedLines: 2,
};

/**
 * The change set as it reads now. `src/telemetry.ts` is the hunk the reviewer staged after writing
 * the finding: that alone rehashes the whole change set, which is what used to detach the comment
 * over on `src/retry.ts`.
 */
const diff: GitDiffInfo = {
  scope: "uncommitted",
  diffHash: "b".repeat(64),
  stats: { filesChanged: 2, insertions: 3, deletions: 2 },
  files: [
    {
      path: "src/retry.ts", status: "modified", binary: false,
      hunks: [{
        header: "@@ -10,4 +10,4 @@ export async function retry(attempt: number) {",
        oldStart: 10, oldCount: 4, newStart: 10, newCount: 4,
        lines: [
          { status: " ", text: "    if (attempt < MAX_ATTEMPTS) {" },
          { status: "-", text: "      return retry(attempt);" },
          { status: "+", text: ANCHORED_LINE },
          { status: " ", text: "    }" },
        ],
      }],
    },
    {
      path: "src/telemetry.ts", status: "modified", binary: false,
      hunks: [{
        header: "@@ -4,2 +4,2 @@",
        oldStart: 4, oldCount: 2, newStart: 4, newCount: 2,
        staged: true,
        lines: [
          { status: "-", text: "  record(\"retry\");" },
          { status: "+", text: "  record(\"retry\", { attempt });" },
        ],
      }],
    },
  ],
};

const finding: ReviewFinding = {
  findingId: "rf_anchor_reload", sessionId: session.id, scope: "uncommitted",
  // Authored against the change set as it was BEFORE the unrelated staging above.
  diffHash: "a".repeat(64),
  // The added line above, numbered from the new-side gutter: context 10, then the replacement 11.
  filePath: "src/retry.ts", side: "right", line: 11,
  ...(stored ? { anchorText: ANCHORED_LINE } : {}),
  body: "This recurses without a delay — back off before retrying.",
  severity: "major", required: true, status: "open", source: "local",
  author: { kind: "human", id: "reviewer" }, createdAt: 1_000, updatedAt: 1_000,
};

const git: GitStatus = {
  status, observation: 1, observedAt: Date.now(), settled: true, busy: false,
  error: null, errorCode: null, refresh: async () => {}, refreshStatusOnly: async () => {},
  install: () => {}, mutationRevision: 0,
};

const client: ApiClient = {
  ...api,
  reviewFindings: async () => ({
    findings: [finding],
    summary: { total: 1, unresolved: 1, requiredUnresolved: 1, sent: 0, resolved: 0, dismissed: 0, completion: "blocked" },
  }),
  gitDiff: async () => ({ diff }),
};

function Fixture() {
  return (
    <ApiProvider client={client}>
      <FeedbackProvider>
        <main className="app" style={{ minHeight: "100vh", background: "var(--bg)", padding: 24 }}>
          <section className="right-panel" style={{ maxWidth: 820, margin: "0 auto" }}>
            <ReviewPanel
              session={session}
              runnerOnline
              runnerProtocolVersion={PROTOCOL_VERSION}
              git={git}
              onOpenSourceLocation={() => {}}
            />
          </section>
        </main>
      </FeedbackProvider>
    </ApiProvider>
  );
}

createRoot(document.getElementById("root")!).render(<Fixture />);
