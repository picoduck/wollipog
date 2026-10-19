import assert from "node:assert/strict";
import { test } from "node:test";
import {
  PROTOCOL_VERSION, REVIEW_SESSION_BRIEF_LIMIT_BYTES, REVIEW_SESSION_OUTPUT_LIMIT_BYTES,
  type ReviewAttemptRound, type ReviewAttemptVerdictView, type ReviewReportFinding, type ReviewRunHistory,
  type ReviewSessionCapability, type ReviewSessionRequest, type RunnerMetadata, type StartSessionMessage,
} from "@wollipog/protocol";
import { ControlPlaneDb } from "./db.js";
import { Hub } from "./hub.js";
import { SessionsService } from "./sessions.js";

const HEAD = "a".repeat(40);
const CAPABILITY: ReviewSessionCapability = {
  reviewers: [{ harness: "codex", agentId: "codex" }, { harness: "claude-code", agentId: "claude" }],
};
const request = (extra: Partial<ReviewSessionRequest> = {}): ReviewSessionRequest => ({
  pullRequest: { repository: "picoduck/wollipog", number: 3368 }, headSha: HEAD, brief: "Intent and acceptance criteria.", ...extra,
});

function harness(options: {
  protocol?: number;
  reviewSession?: ReviewSessionCapability | null;
  driver?: "claude-code" | "codex-app-server" | "pi";
} = {}) {
  const db = ControlPlaneDb.open(":memory:");
  const identity = db.localIdentityContext();
  const metadata: RunnerMetadata = { runnerId: "r", hostname: "test", os: "linux", version: "test",
    workspaces: [{ id: "w", name: "Repo", path: "/repo" }],
    agents: [
      { id: "claude", name: "Claude", command: "claude", args: [], env: {}, driver: "claude-code", available: true },
      { id: "codex", name: "Codex", command: "codex", args: [], env: {}, driver: "codex-app-server", available: true },
      { id: "pi", name: "Pi", command: "pi", args: [], env: {}, driver: "pi", available: true },
    ],
    runtime: { dataDir: "/runner", worktreeRoot: "/runner/worktrees", maxConcurrentSessions: 4,
      ...(options.reviewSession === null ? {} : { reviewSession: options.reviewSession ?? CAPABILITY }) } };
  db.registerRunner(metadata, 1, options.protocol ?? PROTOCOL_VERSION);
  const driver = options.driver ?? "claude-code";
  const make = (id: string) => {
    db.createSession({ id, runnerId: "r", workspaceId: "w", agentId: driver === "claude-code" ? "claude" : driver === "pi" ? "pi" : "codex",
      title: id, useWorktree: true, creationActor: "human",
      scope: { organizationId: identity.organizationId, owner: { kind: "user", userId: identity.userId } },
      driver, config: {}, now: 2 });
    db.updateSessionStatus(id, "running", 3);
  };
  make("s1");
  make("s2");
  const hub = new Hub(db);
  let online = true;
  hub.isRunnerOnline = () => online;
  hub.sessionChangedById = () => {};
  const sent: Array<{ type: string } & Record<string, unknown>> = [];
  let deliver = true;
  hub.sendToRunner = (_, message) => { if (deliver) sent.push(message as { type: string }); return deliver; };
  const svc = new SessionsService(db, hub, { info() {}, warn() {}, error() {} });
  const starts = () => sent.filter((message): message is StartSessionMessage & Record<string, unknown> => message.type === "start_session");
  return { db, svc, sent, starts, metadata, setOnline: (value: boolean) => { online = value; },
    setDeliver: (value: boolean) => { deliver = value; } };
}

const EMPTY_HISTORY: ReviewRunHistory = {
  epoch: 0, lastValid: null, lastAttempt: null, validRounds: 0, consumedInLastRound: 0, roundBudget: 4, attemptsPerRound: 2,
};
const BASE = "b".repeat(40);
const ROUND: ReviewAttemptRound = { epoch: 1, round: 1, attempt: 1, mode: "full", baseSha: BASE, scopeFiles: ["src/a.ts"] };
const BLOCKER: ReviewReportFinding = {
  severity: "high", blocking: true, file: "src/a.ts", line: 3, title: "Wrong", scenario: "s", evidence: "e", verify: "v",
};
const VALID: ReviewAttemptVerdictView = { valid: true, consumed: true, effectiveVote: "DOWNVOTE", failureClass: null, validationErrors: [] };

/** A contract-conforming report of `ROUND` at `head`. */
function report(head = HEAD, extra: Record<string, unknown> = {}): string {
  return JSON.stringify({
    schema_version: 2, reviewed_head: head, vote: "DOWNVOTE", summary: "one blocker", findings: [BLOCKER],
    examined_changed_files: ["src/a.ts"], not_examined_changed_files: [], context_files_examined: [], commands_run: [],
    verification_requests: [], ...extra,
  });
}

function requested(h: ReturnType<typeof harness>, sessionId = "s1") {
  const result = h.svc.requestReviewSession(sessionId, request());
  assert.ok(result.ok && result.data, result.error ?? "request refused");
  return result.data;
}

test("a session requests a review session: a typed reviewer of the other family, launched read-only for its exact head", () => {
  const h = harness();
  try {
    const result = h.svc.requestReviewSession("s1", request());
    assert.ok(result.ok && result.data, result.error ?? "request refused");
    assert.equal(result.status, 201);
    const view = result.data;
    assert.deepEqual({ requester: view.requesterSessionId, reviewer: view.reviewer, state: view.state, terminal: view.terminal,
      validated: view.validated, output: view.output }, {
      requester: "s1", reviewer: "codex", state: "requested", terminal: false, validated: false, output: null,
    });
    const [start] = h.starts();
    assert.ok(start, "the review session's launch was sent");
    assert.equal(start.spec.sessionId, view.reviewSessionId);
    assert.equal(start.spec.agentId, "codex");
    assert.equal(start.spec.driver, "codex-app-server");
    assert.equal(start.spec.useWorktree, false);
    assert.equal(start.initialPrompt, "Intent and acceptance criteria.");
    assert.equal(start.spec.config?.permissionMode, "read-only");
    assert.equal(start.spec.config?.effort, "high");
    assert.deepEqual(start.spec.review, {
      requesterSessionId: "s1", pullRequest: { repository: "picoduck/wollipog", number: 3368 }, headSha: HEAD, harness: "codex",
      history: EMPTY_HISTORY,
    });
    const reviewSession = h.db.getSession(view.reviewSessionId)!;
    assert.equal(reviewSession.kind, "review");
    assert.deepEqual(reviewSession.review, {
      requesterSessionId: "s1", pullRequest: { repository: "picoduck/wollipog", number: 3368 }, headSha: HEAD, reviewer: "codex",
    });
    // Not a child: no delegation slot, charge or descendant authority.
    assert.equal(reviewSession.parentSessionId ?? null, null);
    assert.equal(h.db.getSession("s1")!.liveChildCapacity?.occupied, 0);
    assert.equal(h.db.getSession("s1")!.kind, undefined, "an ordinary session reports no kind");
    assert.deepEqual(h.svc.reviewSessionView("s1", view.reviewSessionId).data, view);
    assert.equal(h.svc.reviewSessionView("s2", view.reviewSessionId).status, 404, "another session cannot read it");
  } finally { h.db.close(); }
});

test("a requester has one active review; another starts once it settles", () => {
  const h = harness();
  try {
    const first = requested(h);
    const again = h.svc.requestReviewSession("s1", request());
    assert.equal(again.status, 409);
    assert.match(again.error!, /already has an active review session/u);
    assert.ok(h.svc.requestReviewSession("s2", request()).ok, "another requester is independent");
    h.svc.onReviewSessionUpdate("r", { type: "review_session_update", sessionId: first.reviewSessionId, state: "completed", output: "{}" });
    const next = h.svc.requestReviewSession("s1", request());
    assert.ok(next.ok, next.error ?? "request refused");
    const page = h.svc.reviewSessionsPage("s1", { limit: 1 });
    assert.equal(page.data?.reviews[0]?.reviewSessionId, next.data!.reviewSessionId, "newest first");
    const older = h.svc.reviewSessionsPage("s1", { limit: 1, afterReviewSessionId: page.data!.nextAfterReviewSessionId! });
    assert.equal(older.data?.reviews[0]?.reviewSessionId, first.reviewSessionId);
    assert.equal(older.data?.nextAfterReviewSessionId, null);
  } finally { h.db.close(); }
});

test("malformed review session requests are refused before anything is created or sent", () => {
  const h = harness();
  try {
    for (const item of [
      null,
      { ...request(), extra: true },
      { ...request(), scope: "full" },
      request({ pullRequest: { repository: "not-a-repo", number: 1 } }),
      request({ pullRequest: { repository: "picoduck/wollipog", number: 0 } }),
      request({ headSha: "abc" }),
      request({ headSha: "A".repeat(40) }),
      request({ brief: " " }),
      { pullRequest: request().pullRequest, headSha: HEAD },
      request({ brief: "x".repeat(REVIEW_SESSION_BRIEF_LIMIT_BYTES + 1) }),
      request({ fullReason: " " }),
      request({ fullReason: "x".repeat(501) }),
      { ...request(), fullReason: 5 },
    ]) {
      const result = h.svc.requestReviewSession("s1", item as ReviewSessionRequest);
      assert.equal(result.status, 400, JSON.stringify(item)?.slice(0, 120));
    }
    assert.deepEqual(h.sent, []);
  } finally { h.db.close(); }
});

test("a review session is refused without a supporting runner, reviewer or connection, and for unsupported requesters", () => {
  const old = harness({ protocol: 223 });
  try {
    const result = old.svc.requestReviewSession("s1", request());
    assert.equal(result.ok, false);
    assert.match(result.error!, /review sessions/u);
  } finally { old.db.close(); }
  const none = harness({ reviewSession: null });
  try { assert.match(none.svc.requestReviewSession("s1", request()).error!, /Codex reviewer is unavailable/u); } finally { none.db.close(); }
  const partial = harness({ reviewSession: { reviewers: [{ harness: "claude-code", agentId: "claude" }], unavailable: { codex: "codex is not installed" } } });
  try {
    assert.match(partial.svc.requestReviewSession("s1", request()).error!, /Codex reviewer is unavailable on this session's runner: codex is not installed/u);
  } finally { partial.db.close(); }
  const pi = harness({ driver: "pi" });
  try { assert.match(pi.svc.requestReviewSession("s1", request()).error!, /no cross-model reviewer/u); } finally { pi.db.close(); }
  const codex = harness({ driver: "codex-app-server" });
  try {
    assert.ok(codex.svc.requestReviewSession("s1", request()).ok);
    const [start] = codex.starts();
    assert.equal(start?.spec.agentId, "claude", "Claude Code reviews Codex");
    assert.equal(start?.spec.config?.permissionMode, "dontAsk");
  } finally { codex.db.close(); }
  const offline = harness();
  try {
    offline.setOnline(false);
    assert.match(offline.svc.requestReviewSession("s1", request()).error!, /offline/u);
  } finally { offline.db.close(); }
  const finished = harness();
  try {
    finished.db.updateSessionStatus("s1", "failed", 4);
    assert.equal(finished.svc.requestReviewSession("s1", request()).status, 409);
    assert.deepEqual(finished.sent, []);
  } finally { finished.db.close(); }
});

test("only the owning runner reports a review, a terminal state is final, and outputs are bounded", () => {
  const h = harness();
  try {
    const view = requested(h);
    h.svc.onReviewSessionUpdate("other-runner", { type: "review_session_update", sessionId: view.reviewSessionId, state: "completed", output: "{}" });
    assert.equal(h.db.reviewSessions.view(view.reviewSessionId)?.state, "requested");
    const big = "x".repeat(REVIEW_SESSION_OUTPUT_LIMIT_BYTES + 10);
    h.svc.onReviewSessionUpdate("r", { type: "review_session_update", sessionId: view.reviewSessionId, state: "completed", output: big });
    const done = h.db.reviewSessions.view(view.reviewSessionId)!;
    assert.equal(done.state, "completed");
    assert.equal(done.output?.length, REVIEW_SESSION_OUTPUT_LIMIT_BYTES);
    assert.equal(done.outputTruncated, true);
    assert.equal(done.terminal, true);
    h.svc.onReviewSessionUpdate("r", { type: "review_session_update", sessionId: view.reviewSessionId, state: "failed", reason: "x" });
    assert.equal(h.db.reviewSessions.view(view.reviewSessionId)?.state, "completed", "the first outcome stands");

    const second = requested(h, "s2");
    h.svc.onReviewSessionUpdate("r", { type: "review_session_update", sessionId: second.reviewSessionId, state: "completed" });
    const empty = h.db.reviewSessions.view(second.reviewSessionId)!;
    assert.deepEqual({ state: empty.state, reason: empty.reason, output: empty.output },
      { state: "failed", reason: "the review ended without a result", output: null }, "a completion needs its output");
  } finally { h.db.close(); }
});

test("a review run records each attempt's round and verdict and sends its history with the next request", () => {
  const h = harness();
  try {
    const first = requested(h);
    const update = (sessionId: string, fields: Record<string, unknown>) =>
      h.svc.onReviewSessionUpdate("r", { type: "review_session_update", sessionId, ...fields } as never);
    update(first.reviewSessionId, { state: "running", round: ROUND });
    assert.deepEqual(h.db.reviewSessions.view(first.reviewSessionId)!.round, ROUND, "the planned round shows while it runs");
    // A round is planned once: a later report cannot move the attempt.
    update(first.reviewSessionId, { state: "running", round: { ...ROUND, round: 3 } });
    update(first.reviewSessionId, { state: "completed", output: report(), round: { ...ROUND, round: 3 }, verdict: VALID });
    const done = h.db.reviewSessions.view(first.reviewSessionId)!;
    assert.deepEqual({ round: done.round, validated: done.validated, verdict: done.verdict, findings: done.findings, stale: done.stale },
      { round: ROUND, validated: true, verdict: VALID, findings: [BLOCKER], stale: false });

    // The next request carries the epoch, and a full review's reason.
    const next = h.svc.requestReviewSession("s1", request({ headSha: "c".repeat(40), fullReason: " The base moved. " }));
    assert.ok(next.ok && next.data, next.error ?? "request refused");
    const start = h.starts().at(-1)!;
    assert.deepEqual(start.spec.review?.history, {
      ...EMPTY_HISTORY, epoch: 1, validRounds: 1, consumedInLastRound: 1,
      lastValid: { headSha: HEAD, baseSha: BASE, round: 1, vote: "DOWNVOTE", findings: [BLOCKER] },
      lastAttempt: { headSha: HEAD, round: 1, attempt: 1, valid: true },
    });
    assert.equal(start.spec.review?.fullReason, "The base moved.");
    assert.equal(h.db.reviewSessions.view(first.reviewSessionId)!.stale, true, "a newer review covers another head");
    assert.equal(next.data.stale, false);

    // An attempt that ran out of time is not counted; one the runner judged invalid is.
    update(next.data.reviewSessionId, { state: "running", round: { ...ROUND, round: 2, mode: "full" } });
    update(next.data.reviewSessionId, { state: "failed", reason: "the reviewer timed out",
      verdict: { valid: false, consumed: false, effectiveVote: null, failureClass: "timeout", validationErrors: ["the reviewer timed out"] } });
    assert.equal(h.db.reviewSessions.view(next.data.reviewSessionId)!.reason, "the reviewer timed out");
    const history = h.db.reviewSessions.history("s1", request().pullRequest);
    assert.deepEqual([history.lastAttempt, history.consumedInLastRound, history.validRounds],
      [{ headSha: "c".repeat(40), round: 2, attempt: 1, valid: false }, 0, 1]);
    // Reviews of another pull request are another run.
    assert.deepEqual(h.db.reviewSessions.history("s1", { repository: "picoduck/wollipog", number: 1 }), EMPTY_HISTORY);
  } finally { h.db.close(); }
});

test("a new epoch without a valid round keeps the earlier epoch's last valid review in its history", () => {
  const h = harness();
  try {
    const update = (sessionId: string, fields: Record<string, unknown>) =>
      h.svc.onReviewSessionUpdate("r", { type: "review_session_update", sessionId, ...fields } as never);
    const first = requested(h);
    update(first.reviewSessionId, { state: "completed", output: report(), round: ROUND, verdict: VALID });
    const rewritten = "c".repeat(40);
    const second = h.svc.requestReviewSession("s1", request({ headSha: rewritten })).data!;
    update(second.reviewSessionId, { state: "failed", reason: "the review ended without a result",
      round: { ...ROUND, epoch: 2, mode: "rebase", rebasedFrom: { baseSha: BASE, headSha: HEAD } },
      verdict: { valid: false, consumed: true, effectiveVote: "INVALID", failureClass: "evidence_contract", validationErrors: ["no structured report"] } });
    assert.deepEqual(h.db.reviewSessions.history("s1", request().pullRequest), {
      ...EMPTY_HISTORY, epoch: 2, consumedInLastRound: 1,
      lastAttempt: { headSha: rewritten, round: 1, attempt: 1, valid: false },
      carried: { headSha: HEAD, baseSha: BASE, findings: [BLOCKER] },
    }, "the epoch's counters reset while the earlier findings and range-diff origin stay");
  } finally { h.db.close(); }
});

test("a valid verdict counts only when the control plane can check the report against its head and scope", () => {
  const cases: Array<[string, Record<string, unknown>, string]> = [
    ["another head", { output: report("c".repeat(40)) }, "reviewed_head"],
    ["an unclassified file", { output: report(HEAD, { examined_changed_files: [] }) }, "src/a.ts"],
    ["a truncated report", { output: report(), outputTruncated: true }, "could not be validated"],
    ["no planned round", { round: undefined }, "could not be validated"],
    ["a malformed verdict", { verdict: { valid: true } }, "malformed"],
  ];
  for (const [label, fields, error] of cases) {
    const h = harness();
    try {
      const view = requested(h);
      h.svc.onReviewSessionUpdate("r", { type: "review_session_update", sessionId: view.reviewSessionId, state: "completed",
        output: report(), round: ROUND, verdict: VALID, ...fields } as never);
      const done = h.db.reviewSessions.view(view.reviewSessionId)!;
      assert.deepEqual([done.verdict?.valid, done.verdict?.effectiveVote, done.verdict?.failureClass, done.findings],
        [false, "INVALID", "evidence_contract", []], label);
      assert.ok(done.verdict!.validationErrors.some((message) => message.includes(error)), `${label}: ${done.verdict!.validationErrors}`);
      assert.equal(h.db.reviewSessions.history("s1", request().pullRequest).validRounds, 0, label);
    } finally { h.db.close(); }
  }
  // A malformed round is ignored rather than recorded.
  const h = harness();
  try {
    const view = requested(h);
    h.svc.onReviewSessionUpdate("r", { type: "review_session_update", sessionId: view.reviewSessionId, state: "running",
      round: { ...ROUND, mode: "partial", baseSha: "../x" } } as never);
    assert.equal(h.db.reviewSessions.view(view.reviewSessionId)!.round, null);
  } finally { h.db.close(); }
});

test("a runner below review runs gets no history and reviews without a verdict", () => {
  const h = harness({ protocol: 226 });
  try {
    assert.ok(h.svc.requestReviewSession("s1", request({ fullReason: "why" })).ok);
    assert.deepEqual(h.starts()[0]?.spec.review, {
      requesterSessionId: "s1", pullRequest: { repository: "picoduck/wollipog", number: 3368 }, headSha: HEAD, harness: "codex",
    });
  } finally { h.db.close(); }
});

test("an undelivered review launch leaves no active review behind", () => {
  const h = harness();
  try {
    h.setDeliver(false);
    const refused = h.svc.requestReviewSession("s1", request());
    assert.equal(refused.status, 409);
    assert.equal(h.db.reviewSessions.activeFor("s1"), null);
    assert.deepEqual(h.svc.reviewSessionsPage("s1", {}).data?.reviews.map((review) => [review.state, review.reason]),
      [["failed", "the review session could not be launched"]], "the undelivered review stays on record, settled");
    h.setDeliver(true);
    assert.ok(h.svc.requestReviewSession("s1", request()).ok, "the requester can retry at once");
  } finally { h.db.close(); }
});

test("a refusal reported before the terminal status keeps its specific reason", () => {
  const h = harness();
  try {
    const view = requested(h);
    h.svc.onReviewSessionUpdate("r", { type: "review_session_update", sessionId: view.reviewSessionId, state: "failed",
      reason: "the requested head is not the pull request's pushed head" });
    h.svc.onSessionStatus(view.reviewSessionId, "failed", "the requested head is not the pull request's pushed head", undefined, "r");
    assert.equal(h.db.reviewSessions.view(view.reviewSessionId)?.reason, "the requested head is not the pull request's pushed head");
  } finally { h.db.close(); }
});

test("a failure reason is one of the fixed reasons, and an unknown one is replaced", () => {
  const h = harness();
  try {
    const view = requested(h);
    h.svc.onReviewSessionUpdate("r", { type: "review_session_update", sessionId: view.reviewSessionId, state: "failed", reason: "/home/user/secret path" });
    assert.equal(h.db.reviewSessions.view(view.reviewSessionId)?.reason, "the review could not be completed; see the runner log");
  } finally { h.db.close(); }
});

test("the review session's own status marks it running, and ending without a report fails it", () => {
  const h = harness();
  try {
    const view = requested(h);
    h.svc.onSessionStatus(view.reviewSessionId, "running", undefined, undefined, "r");
    assert.equal(h.db.reviewSessions.view(view.reviewSessionId)?.state, "running");
    h.svc.onSessionStatus(view.reviewSessionId, "stopped", undefined, undefined, "r");
    const ended = h.db.reviewSessions.view(view.reviewSessionId)!;
    assert.deepEqual({ state: ended.state, reason: ended.reason }, { state: "failed", reason: "the review ended without a result" });
  } finally { h.db.close(); }
});

test("a review session takes no messages, configuration, commands, restarts, side chats or children", async () => {
  const h = harness();
  try {
    const { reviewSessionId: id } = requested(h);
    const refusals = [
      h.svc.prompt(id, "now fix it"),
      h.svc.promptFromUser("user", id, "now fix it"),
      await h.svc.promptOrSteer(id, "now fix it"),
      await h.svc.steer(id, { submissionId: "x", text: "fix" } as never),
      h.svc.setConfig(id, { permissionMode: "bypassPermissions" }),
      h.svc.invokeSessionCommand(id, { submissionId: "x", providerCommandId: "y", catalogRevision: 1 } as never),
      h.svc.restart(id),
      h.svc.unarchiveAndRestart(id),
      h.svc.createSideChat(id),
      h.svc.createSession({ runnerId: "r", workspaceId: "w", agentId: "claude", title: "child", useWorktree: false },
        undefined, undefined, false, false, false, { parentSessionId: id }),
    ];
    for (const [index, result] of refusals.entries()) {
      assert.equal(result.ok, false, `refusal ${index}`);
      assert.equal(result.status, 409, `refusal ${index}: ${result.error}`);
      assert.match(result.error!, /^A review session /u, `refusal ${index}`);
    }
    assert.equal(h.svc.requestReviewSession(id, request()).status, 409, "a review session never requests a review");
    assert.equal(h.starts().length, 1, "nothing but the original launch reached the runner");
  } finally { h.db.close(); }
});

test("cancelling a review stops its session, and the runner's report settles it", () => {
  const h = harness();
  try {
    const view = requested(h);
    h.svc.onSessionStatus(view.reviewSessionId, "running", undefined, undefined, "r");
    const cancelled = h.svc.cancelReviewSession("s1", view.reviewSessionId);
    assert.equal(cancelled.status, 202);
    assert.equal(cancelled.data?.cancelRequested, true);
    assert.ok(h.sent.some((message) => message.type === "stop_session" && message.sessionId === view.reviewSessionId));
    h.svc.onReviewSessionUpdate("r", { type: "review_session_update", sessionId: view.reviewSessionId, state: "cancelled", reason: "the review was cancelled" });
    assert.equal(h.db.reviewSessions.view(view.reviewSessionId)?.state, "cancelled");
    assert.equal(h.svc.cancelReviewSession("s1", view.reviewSessionId).status, 200, "a settled review is returned unchanged");
    assert.equal(h.svc.cancelReviewSession("s2", view.reviewSessionId).status, 404);
  } finally { h.db.close(); }
});

test("a runner that no longer supports review sessions settles its unfinished reviews on registration", () => {
  const h = harness();
  try {
    const view = requested(h);
    h.db.registerRunner({ ...h.metadata, runtime: { dataDir: "/runner", worktreeRoot: "/runner/worktrees", maxConcurrentSessions: 4 } }, 2, 223);
    h.svc.recoverReviewSessions("r");
    const ended = h.db.reviewSessions.view(view.reviewSessionId)!;
    assert.deepEqual({ state: ended.state, reason: ended.reason },
      { state: "failed", reason: "the review session's runner no longer supports review sessions" });
  } finally { h.db.close(); }
});

test("a requester's cost budget bounds its review, and an exhausted budget refuses one", () => {
  const h = harness();
  try {
    h.db.updateSessionCostBudget("s1", 10, 5);
    h.db.addSessionUsage("s1", { costUsd: 4 }, 6);
    assert.ok(h.svc.requestReviewSession("s1", request()).ok);
    assert.equal(h.starts()[0]?.spec.config?.costBudgetUsd, 6);
    // A later review spends only what the requester and its earlier reviews left.
    const first = h.db.reviewSessions.activeFor("s1")!;
    h.db.addSessionUsage(first, { costUsd: 5 }, 7);
    h.svc.onReviewSessionUpdate("r", { type: "review_session_update", sessionId: first, state: "completed", output: "{}" });
    assert.ok(h.svc.requestReviewSession("s1", request()).ok);
    assert.equal(h.starts()[1]?.spec.config?.costBudgetUsd, 1);
    h.svc.onReviewSessionUpdate("r", { type: "review_session_update", sessionId: h.db.reviewSessions.activeFor("s1")!, state: "failed" });
    h.db.addSessionUsage(h.starts()[1]!.spec.sessionId, { costUsd: 1 }, 8);
    assert.match(h.svc.requestReviewSession("s1", request()).error!, /no cost budget left/u);
    h.db.updateSessionCostBudget("s2", 1, 5);
    h.db.addSessionUsage("s2", { costUsd: 2 }, 6);
    assert.match(h.svc.requestReviewSession("s2", request()).error!, /no cost budget left/u);
  } finally { h.db.close(); }
});
