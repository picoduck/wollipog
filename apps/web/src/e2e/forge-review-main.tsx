import React from "react";
import { createRoot } from "react-dom/client";
import { PROTOCOL_VERSION, type GitStatusInfo, type ReviewFinding, type SessionView } from "@wollipog/protocol";
import { api, type ApiClient } from "../api.js";
import { ApiProvider } from "../api-context.js";
import { FeedbackProvider } from "../components/FeedbackProvider.js";
import { ReviewPanel } from "../components/ReviewPanel.js";
import type { GitStatus } from "../components/useGitStatus.js";
import "../styles.css";

const params = new URLSearchParams(window.location.search);
document.documentElement.setAttribute("data-theme", params.get("theme") === "light" ? "light" : "dark");
const legacy = params.get("legacy") === "1";

const session: SessionView = {
  id: "gitlab-review-e2e", runnerId: "runner-1", workspaceId: "workspace-1", workspaceName: "Wollipog",
  projectId: null, agentId: "codex", agentName: "Codex", title: "Add GitLab Integration", status: "idle",
  column: "review", runId: null, useWorktree: true, worktreePath: "/workspace/wollipog-gitlab",
  archived: false, createdAt: 1, updatedAt: 1, lastEventAt: 1, messageCount: 1, eventEpoch: 0,
  preview: null, pendingApproval: null, driver: "codex-app-server", model: null, effort: null,
  permissionMode: null, tokensIn: 0, tokensOut: 0, costUsd: 0, adopted: false,
};

const status: GitStatusInfo = {
  branch: "feature/gitlab", files: [], hasChanges: false, ahead: 2,
  remoteUrl: "git@gitlab.example.test:team/sub/wollipog.git", baseRef: "origin/main",
};

const finding: ReviewFinding = {
  findingId: "rf_gitlab_fixture", sessionId: session.id, scope: "all_branch", diffHash: "d".repeat(64),
  filePath: "src/gitlab.ts", side: "right", line: 42, body: "Preserve exact host matching.",
  severity: "major", required: true, status: "open", source: "gitlab",
  author: { kind: "human", id: "reviewer" }, createdAt: 1_000, updatedAt: 1_100,
  remote: {
    provider: "gitlab", repository: "team/sub/wollipog", pullRequestNumber: 19,
    threadId: "discussion-19", commentId: 119,
    url: "https://gitlab.example.test/team/sub/wollipog/-/merge_requests/19#note_119",
    commitId: "a".repeat(40), outdated: false, subjectType: "line", synchronizedAt: 1_200,
  },
};

const git: GitStatus = {
  status: { ...status }, observation: 1, observedAt: Date.now(), settled: true, busy: false,
  error: null, errorCode: null, refresh: async () => {}, refreshStatusOnly: async () => {},
  install: () => {}, mutationRevision: 0,
};

const client: ApiClient = {
  ...api,
  reviewFindings: async () => ({
    findings: [finding],
    summary: { total: 1, unresolved: 1, requiredUnresolved: 1, sent: 0, resolved: 0, dismissed: 0, completion: "blocked" },
  }),
  gitDiff: async () => ({
    diff: {
      scope: "uncommitted", baseRef: "origin/main", headRef: "HEAD", raw: "", files: [],
      diffHash: "e".repeat(64), fineDiffHash: "f".repeat(64), stats: { filesChanged: 0, insertions: 0, deletions: 0 },
    },
  }),
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
              runnerProtocolVersion={legacy ? 105 : PROTOCOL_VERSION}
              git={git}
              forge={legacy ? undefined : {
                provider: "gitlab", host: "gitlab.example.test", project: "team/sub/wollipog", authenticated: true,
              }}
              onOpenSourceLocation={() => {}}
            />
          </section>
        </main>
      </FeedbackProvider>
    </ApiProvider>
  );
}

createRoot(document.getElementById("root")!).render(<Fixture />);
