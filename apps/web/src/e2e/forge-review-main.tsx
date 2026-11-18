import React from "react";
import { createRoot } from "react-dom/client";
import {
  PROTOCOL_VERSION,
  pullRequestMergeReadiness,
  type GitPrSummary,
  type GitStatusInfo,
  type PullRequestMergeFacts,
  type ReviewFinding,
  type SessionView,
} from "@wollipog/protocol";
import { api, ApiError, type ApiClient } from "../api.js";
import { ApiProvider } from "../api-context.js";
import { FeedbackProvider } from "../components/FeedbackProvider.js";
import { ReviewPanel } from "../components/ReviewPanel.js";
import type { GitStatus } from "../components/useGitStatus.js";
import "../styles.css";

const params = new URLSearchParams(window.location.search);
document.documentElement.setAttribute("data-theme", params.get("theme") === "light" ? "light" : "dark");
const legacy = params.get("legacy") === "1";
const request = params.get("request") === "1";
/** #604: `queue=queued|removed` shows a GitHub pull request in, or removed from, its merge queue;
 * `merge=...` alone shows one not yet queued. */
const queue = params.get("queue") ?? (params.has("merge") ? "none" : null);
const queueFacts: GitPrSummary | null = queue === "queued" || queue === "removed" || queue === "none" ? {
  number: 4601, title: "Speed Up Checkout", state: "OPEN", provider: "github", kind: "pull_request",
  url: "https://github.com/picoduck/wollipog/pull/4601", baseRef: "main", headRef: "fix/issue-4601", mergeability: "MERGEABLE",
  mergeQueue: queue === "queued"
    ? { enabled: true, removal: null, entry: { state: "awaiting_checks", position: 2, enqueuedAt: 1_794_800_000_000, groupChecks: "pending" } }
    : queue === "removed"
      ? { enabled: true, entry: null, removal: { reason: "failed_checks", removedAt: 1_794_800_000_000 } }
      : { enabled: params.get("merge") !== "direct", entry: null, removal: null },
} : null;

const session: SessionView = {
  id: "gitlab-review-e2e", runnerId: "runner-1", workspaceId: "workspace-1", workspaceName: "Wollipog",
  projectId: null, agentId: "codex", agentName: "Codex", title: "Add GitLab Integration", status: "idle",
  column: "review", useWorktree: true, worktreePath: "/workspace/wollipog-gitlab",
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
  author: { kind: "human", id: "reviewer" }, createdAt: Date.now() - 61 * 60_000, updatedAt: Date.now() - 60 * 60_000,
  remote: {
    provider: "gitlab", repository: "team/sub/wollipog", pullRequestNumber: 19,
    threadId: "discussion-19", commentId: 119,
    url: "https://gitlab.example.test/team/sub/wollipog/-/merge_requests/19#note_119",
    commitId: "a".repeat(40), outdated: false, subjectType: "line", synchronizedAt: 1_200,
  },
};

const remoteFinding: ReviewFinding = {
  ...finding,
  findingId: "rf_gitlab_remote_fixture",
  filePath: "__remote__/gitlab-discussion-120",
  line: 1,
  body: "Confirm the release-note wording in this remote discussion.",
  required: false,
  remote: {
    ...finding.remote!,
    threadId: "discussion-20",
    commentId: 120,
    url: "https://gitlab.example.test/team/sub/wollipog/-/merge_requests/19#note_120",
    subjectType: "remote",
  },
};

const git: GitStatus = {
  status: { ...status }, observation: 1, observedAt: Date.now(), settled: true, busy: false,
  error: null, errorCode: null, refresh: async () => {}, refreshStatusOnly: async () => {},
  install: () => {}, mutationRevision: 0,
};

/** #604: `merge=ready|direct|blocked` answers the merge-readiness gate for the queued GitHub fixture;
 * anything else answers as a GitLab merge request, which Wollipog cannot merge yet. */
const mergeScenario = params.get("merge") ?? (queue === "queued" ? "in_queue" : queue === "removed" ? "ready" : null);
const mergeFacts: PullRequestMergeFacts = {
  url: "https://github.com/picoduck/wollipog/pull/4601", repository: "picoduck/wollipog", number: 4601, state: "open",
  headSha: "4601c0de".padEnd(40, "0"), isDraft: false, baseRef: "main", mergeQueueEnabled: mergeScenario !== "direct",
  inMergeQueue: mergeScenario === "in_queue", mergeStateStatus: "CLEAN", requiredChecks: mergeScenario === "blocked"
    ? { state: "pending", failing: [], pending: ["Typecheck, Test & Sidecar Bundle"] } : { state: "passed", failing: [], pending: [] },
  viewerPermission: "admin", mergeMethod: "squash", deleteBranchOnMerge: false, observedAt: Date.now(),
};
let mergedOnce = false;

const client: ApiClient = {
  ...api,
  pullRequestMergeReadiness: async () => {
    if (!mergeScenario) {
      const unavailable = "Merging from Wollipog supports GitHub pull requests only; merge this merge request on GitLab.";
      return { facts: null, unavailable, readiness: pullRequestMergeReadiness(null, { roleRefusal: null, runnerSupported: true, requiredFindingsOpen: 0 }, unavailable) };
    }
    const facts = mergedOnce && mergeScenario === "ready" ? { ...mergeFacts, inMergeQueue: true } : mergeFacts;
    const session = mergeScenario === "blocked"
      ? { roleRefusal: "Merging requires an Admin or Owner role.", runnerSupported: true, requiredFindingsOpen: 1 }
      : { roleRefusal: null, runnerSupported: true, requiredFindingsOpen: 0 };
    return { facts, readiness: pullRequestMergeReadiness(facts, session) };
  },
  mergePullRequest: async (_id, body) => {
    mergedOnce = true;
    return { result: body.mode === "enqueue"
      ? { outcome: "enqueued", message: "Added to the merge queue at position 3.", mode: "enqueue", headSha: body.headSha, state: "open", queuePosition: 3 }
      : { outcome: "merged", message: "Merged with the repository's squash method.", mode: "merge", headSha: body.headSha, state: "merged" } };
  },
  git: async (_id, body) => {
    if (body.action !== "request_diff") throw new Error("Unexpected action");
    if (params.has("stale")) throw new Error("revisions changed");
    if (params.has("authError")) throw new ApiError("Authenticated GitLab integration is unavailable on this machine.", 409);
    return { requestDiff: {
      requestUrl: params.has("wrong") ? "https://evil.test/other/pull/19" : body.requestUrl!,
      headOid: "a".repeat(40), baseOid: "b".repeat(40), targetOid: "c".repeat(40),
      baseRef: "release", headRef: "feature/gitlab", readAt: Date.now(), incomplete: params.has("partial"),
      diff: { scope: "all_branch", diffHash: "d".repeat(64), stats: { filesChanged: 1, insertions: 1, deletions: 1 },
        files: [{ path: "src/request.ts", status: "modified", binary: false,
          hunks: [{ header: "@@ -1 +1 @@", oldStart: 1, oldCount: 1, newStart: 1, newCount: 1,
            lines: [{ status: "-", text: "old target" }, { status: "+", text: "authoritative request head" }] }] }] },
    } };
  },
  bundleReviewFindings: async (_id, body) => {
    if (body.findings.length !== 1 || body.findings[0]?.findingId !== finding.findingId) throw new Error("Unexpected bundle");
    return {
      findings: [{ ...finding, status: "sent" }, remoteFinding],
      summary: { total: 2, unresolved: 2, requiredUnresolved: 1, sent: 1, resolved: 0, dismissed: 0, completion: "blocked" },
    };
  },
  reviewFindings: async () => ({
    findings: [finding, remoteFinding],
    summary: { total: 2, unresolved: 2, requiredUnresolved: 1, sent: 0, resolved: 0, dismissed: 0, completion: "blocked" },
  }),
  gitDiff: async (_id, scope) => ({
    diff: {
      scope, baseRef: "origin/main", headRef: "HEAD", raw: "", files: [],
      diffHash: "e".repeat(64), fineDiffHash: "f".repeat(64), stats: { filesChanged: 0, insertions: 0, deletions: 0 },
    },
  }),
};

function Fixture() {
  return (
    <ApiProvider client={client}>
      <FeedbackProvider>
        <main className="app" style={{ minHeight: "100vh", background: "var(--bg)", padding: 24 }}>
          <section className="rpanel" style={{ width: "100%", maxWidth: 820, margin: "0 auto" }}>
            <ReviewPanel
              session={session}
              runnerOnline
              runnerProtocolVersion={legacy ? 105 : params.has("oldDiff") ? 343 : PROTOCOL_VERSION}
              git={git}
              forgeFacts={queueFacts ? {
                pr: queueFacts,
                checks: mergeScenario === "blocked"
                  ? { passing: 5, failing: 0, pending: 1, failingNames: [], url: `${queueFacts.url}/checks` }
                  : { passing: 6, failing: 0, pending: 0, failingNames: [], url: `${queueFacts.url}/checks` },
              } : request ? {
                pr: {
                  number: 19, title: "Add GitLab Integration", state: "OPENED", provider: "gitlab", kind: "merge_request",
                  url: "https://gitlab.example.test/team/sub/wollipog/-/merge_requests/19",
                  baseRef: "release", headRef: "feature/gitlab", mergeability: "ci_must_pass",
                },
                checks: {
                  passing: 0, failing: 1, pending: 0, failingNames: ["Pipeline #7"],
                  url: "https://gitlab.example.test/team/sub/wollipog/-/pipelines/7",
                  jobs: [
                    { name: "unit", state: "failing", url: "https://gitlab.example.test/team/sub/wollipog/-/jobs/11" },
                    { name: "typecheck", state: "passing", url: "https://gitlab.example.test/team/sub/wollipog/-/jobs/12" },
                    { name: "browser", state: "pending", url: "https://gitlab.example.test/team/sub/wollipog/-/jobs/13" },
                  ],
                },
              } : null}
              forge={legacy ? undefined : queueFacts ? {
                provider: "github", host: "github.com", project: "picoduck/wollipog", authenticated: true,
              } : {
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
