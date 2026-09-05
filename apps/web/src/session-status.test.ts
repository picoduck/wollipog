import assert from "node:assert/strict";
import test from "node:test";
import {
  sessionAttentionStatus,
  type GitStatusInfo,
  type GitSummaryInfo,
  type SessionStatus,
  type SessionView,
} from "@wollipog/protocol";
import { statusMeta } from "./format.js";
import { isOpenReviewRequestState, sessionChangeStatus, sessionMayShowChangeStatus } from "./session-status.js";

const lifecycleCases: Array<[SessionStatus, string]> = [
  ["queued", "Queued"],
  ["starting", "Starting"],
  ["running", "Running"],
  ["input_required", "Awaiting Input"],
  ["idle", "Awaiting Prompt"],
  ["completed", "Completed"],
  ["failed", "Failed"],
  ["stopped", "Stopped"],
];

test("canonical lifecycle labels cover every state and use a neutral unknown fallback", () => {
  assert.deepEqual(lifecycleCases.map(([status]) => statusMeta(status).label), lifecycleCases.map(([, label]) => label));
  assert.equal(statusMeta("future_state" as SessionStatus).label, "Status Unavailable");
  assert.equal(statusMeta("constructor" as SessionStatus).label, "Status Unavailable");
  assert.equal(statusMeta("queued").busy, false);
  assert.equal(statusMeta("starting").busy, true);
  assert.equal(statusMeta("running").busy, true);
});

function session(
  status: SessionView["status"],
  pendingApproval: SessionView["pendingApproval"] = null,
): Pick<SessionView, "status" | "pendingApproval"> {
  return { status, pendingApproval };
}

test("attention labels distinguish questions, authentication, approvals, and legacy input", () => {
  assert.equal(sessionAttentionStatus(session("running")), null);
  assert.deepEqual(
    sessionAttentionStatus(session("input_required", {
      requestId: "question",
      title: "Which database?",
      options: [],
      kind: "question",
    }))?.kind,
    "answer_required",
  );
  assert.equal(
    sessionAttentionStatus(session("input_required", {
      requestId: "recovered-question",
      title: "Which database?",
      options: [],
      kind: "question",
      recoveryReason: "provider_restart",
    }))?.label,
    "Recovery Required",
  );
  assert.equal(
    sessionAttentionStatus(session("input_required", {
      requestId: "auth",
      title: "Sign in",
      options: [],
      kind: "authentication",
    }))?.label,
    "Authentication Required",
  );
  assert.equal(
    sessionAttentionStatus(session("input_required", {
      requestId: "permission",
      title: "Run deploy?",
      options: [],
      kind: "permission",
    }))?.label,
    "Approval Required",
  );
  assert.equal(sessionAttentionStatus(session("input_required"))?.label, "Input Required");
});

function gitStatus(overrides: Partial<GitStatusInfo> = {}): GitStatusInfo {
  return {
    branch: "feature",
    files: [],
    hasChanges: false,
    ahead: 0,
    remoteUrl: null,
    baseRef: "origin/main",
    ...overrides,
  };
}

function gitSummary(overrides: Partial<GitSummaryInfo> = {}): GitSummaryInfo {
  return {
    branch: "feature",
    ahead: 0,
    behind: 0,
    hasChanges: false,
    addedLines: 0,
    deletedLines: 0,
    remoteUrl: null,
    baseRef: "origin/main",
    pr: null,
    checks: null,
    ...overrides,
  };
}

test("active turns suppress retained change evidence", () => {
  for (const status of ["queued", "starting", "running", "input_required"] as SessionStatus[]) {
    assert.equal(sessionMayShowChangeStatus(status), false);
  }
  for (const status of ["idle", "completed", "failed", "stopped"] as SessionStatus[]) {
    assert.equal(sessionMayShowChangeStatus(status), true);
  }
});

test("open review-request states are normalized without provider-specific assumptions", () => {
  assert.equal(isOpenReviewRequestState("OPEN"), true);
  assert.equal(isOpenReviewRequestState("opened"), true);
  assert.equal(isOpenReviewRequestState("CLOSED"), false);
  assert.equal(isOpenReviewRequestState(undefined), false);
});

test("change labels require settled Git evidence and never use workflow or lifecycle guesses", () => {
  assert.equal(sessionChangeStatus({ available: true, settled: false, status: gitStatus({ hasChanges: true }) }), null);
  assert.equal(sessionChangeStatus({ available: true, settled: true, status: null }), null);
  const legacyClean = gitStatus();
  delete legacyClean.baseRef;
  assert.equal(sessionChangeStatus({ available: true, settled: true, status: legacyClean }), null);
  assert.equal(sessionChangeStatus({ available: true, settled: true, status: gitStatus() })?.label, "No Changes");
  assert.equal(
    sessionChangeStatus({ available: true, settled: true, status: gitStatus({ hasChanges: true }) })?.label,
    "Changes Present",
  );
  assert.equal(
    sessionChangeStatus({ available: true, settled: true, status: gitStatus({ ahead: 2 }) })?.label,
    "Changes Present",
  );
  const cleanReviewReady = sessionChangeStatus({ available: true,
    settled: true,
    summary: gitSummary({
      ahead: 2,
      pr: { number: 142, title: "Status taxonomy", url: "https://example.test/142", state: "OPEN" },
    }),
  });
  assert.equal(cleanReviewReady?.label, "Ready for Review");
  assert.equal(cleanReviewReady?.supplement, undefined,
    "a clean review-ready branch keeps the concise single-badge presentation");
  const reviewReadyWithLocalWork = sessionChangeStatus({ available: true,
    settled: true,
    summary: gitSummary({
      hasChanges: true,
      ahead: 2,
      pr: { number: 142, title: "Status taxonomy", url: "https://example.test/142", state: "OPEN" },
    }),
  });
  assert.equal(reviewReadyWithLocalWork?.label, "Ready for Review");
  assert.equal(reviewReadyWithLocalWork?.supplement?.label, "Uncommitted Changes");
  assert.match(reviewReadyWithLocalWork?.supplement?.description ?? "", /not included in the pull request/u);
  const mergeRequestReady = sessionChangeStatus({ available: true,
    settled: true,
    summary: gitSummary({
      ahead: 2,
      pr: {
        number: 142,
        title: "GitLab taxonomy",
        url: "https://gitlab.example.test/group/project/-/merge_requests/142",
        state: "OPENED",
        provider: "gitlab",
        kind: "merge_request",
      },
    }),
  });
  assert.match(mergeRequestReady?.description ?? "", /open merge request/u);
  assert.equal(mergeRequestReady?.label, "Ready for Review",
    "GitLab's real OPENED state is normalized as an open merge request");
  const reviewReadyFromProductionEvidence = sessionChangeStatus({
    available: true,
    settled: true,
    status: gitStatus({ hasChanges: true, ahead: 2 }),
    summary: gitSummary({
      ahead: 2,
      pr: { number: 142, title: "Status taxonomy", url: "https://example.test/142", state: "OPEN" },
    }),
  });
  assert.equal(reviewReadyFromProductionEvidence?.supplement?.label, "Uncommitted Changes",
    "fresh status owns working-tree facts while the matching summary contributes PR evidence");
  const cleanStatusWithDirtySummary = sessionChangeStatus({
    available: true,
    settled: true,
    status: gitStatus({ ahead: 2 }),
    summary: gitSummary({
      hasChanges: true,
      ahead: 2,
      pr: { number: 142, title: "Status taxonomy", url: "https://example.test/142", state: "OPEN" },
    }),
  });
  assert.equal(cleanStatusWithDirtySummary?.supplement, undefined,
    "stale summary dirtiness cannot override the fresh clean status");
  assert.equal(
    sessionChangeStatus({ available: true,
      settled: true,
      summary: gitSummary({
        pr: { number: 142, title: "Empty", url: "https://example.test/142", state: "OPEN" },
      }),
    })?.label,
    "No Changes",
    "an open PR alone cannot prove that a reviewable diff exists",
  );
  assert.equal(
    sessionChangeStatus({ available: true,
      settled: true,
      summary: gitSummary({
        hasChanges: true,
        pr: { number: 142, title: "Uncommitted", url: "https://example.test/142", state: "OPEN" },
      }),
    })?.label,
    "Changes Present",
    "uncommitted files are not necessarily part of the open PR",
  );
  assert.equal(
    sessionChangeStatus({ available: true,
      settled: true,
      summary: gitSummary({
        baseRef: null,
        ahead: 2,
        pr: { number: 142, title: "Upstream only", url: "https://example.test/142", state: "OPEN" },
      }),
    })?.label,
    "Changes Present",
    "upstream-only divergence cannot prove that commits are present in the pull request",
  );
});

test("change labels reject unavailable facts and prefer fresh status over a stale summary", () => {
  assert.equal(sessionChangeStatus({
    available: true,
    settled: true,
    summary: gitSummary({
      ahead: 2,
      pr: { number: 142, title: "Legacy", url: "https://example.test/142" } as NonNullable<GitSummaryInfo["pr"]>,
    }),
  })?.label, "Changes Present", "malformed PR evidence fails neutrally without hiding confirmed changes");
  assert.equal(sessionChangeStatus({
    available: true,
    settled: true,
    summary: gitSummary({
      ahead: 2,
      pr: { number: 142, title: "Malformed", url: "https://example.test/142", state: 3 as unknown as string },
    }),
  })?.label, "Changes Present", "non-string PR evidence fails neutrally without hiding confirmed changes");
  assert.equal(sessionChangeStatus({
    available: false,
    settled: true,
    status: gitStatus({ hasChanges: true }),
    summary: gitSummary({ hasChanges: true }),
  }), null);
  assert.equal(sessionChangeStatus({
    available: false,
    settled: true,
    summary: gitSummary({
      hasChanges: true,
      ahead: 2,
      pr: { number: 142, title: "Stale", url: "https://example.test/142", state: "OPEN" },
    }),
  }), null, "stale review and working-tree evidence cannot produce either affirmative indicator");
  assert.equal(sessionChangeStatus({
    available: true,
    settled: true,
    status: gitStatus({ hasChanges: false, ahead: 0 }),
    summary: gitSummary({
      hasChanges: true,
      ahead: 1,
      pr: { number: 142, title: "Stale", url: "https://example.test/142", state: "OPEN" },
    }),
  })?.label, "No Changes");
  assert.equal(sessionChangeStatus({
    available: true,
    settled: true,
    status: gitStatus({ branch: "new-branch", ahead: 2 }),
    summary: gitSummary({
      branch: "old-branch",
      ahead: 2,
      pr: { number: 142, title: "Stale", url: "https://example.test/142", state: "OPEN" },
    }),
  })?.label, "Changes Present", "a stale PR cannot establish review readiness");
});

test("running and attention remain independent dimensions", () => {
  const runningQuestion = session("running", {
    requestId: "question",
    title: "Which database?",
    options: [],
    kind: "question",
  });
  assert.equal(statusMeta(runningQuestion.status).label, "Running");
  assert.equal(sessionAttentionStatus(runningQuestion)?.label, "Answer Required");
});
