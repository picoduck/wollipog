import assert from "node:assert/strict";
import { test } from "node:test";
import {
  PROTOCOL_VERSION, SESSION_REVIEW_ARTIFACT_LIMIT_BYTES, SESSION_REVIEW_BRIEF_LIMIT_BYTES, SESSION_REVIEW_JOB_ID_PATTERN,
  type RunnerMetadata, type SessionReviewCapability, type SessionReviewJobCommand, type SessionReviewJobRequest,
} from "@wollipog/protocol";
import { ControlPlaneDb } from "./db.js";
import { Hub } from "./hub.js";
import { SessionsService } from "./sessions.js";

const HEAD = "a".repeat(40);
const CAPABILITY: SessionReviewCapability = { controllerDigest: "d".repeat(64), reviewers: ["claude-code", "codex"] };
const request = (extra: Partial<SessionReviewJobRequest> = {}): SessionReviewJobRequest => ({
  pullRequest: { repository: "picoduck/wollipog", number: 3306 }, headSha: HEAD, brief: "Intent and acceptance criteria.", ...extra,
});

function harness(options: { protocol?: number; sessionReview?: SessionReviewCapability | null; driver?: "claude-code" | "codex" | "pi" } = {}) {
  const db = ControlPlaneDb.open(":memory:");
  const identity = db.localIdentityContext();
  const metadata: RunnerMetadata = { runnerId: "r", hostname: "test", os: "linux", version: "test",
    workspaces: [{ id: "w", name: "Repo", path: "/repo" }],
    agents: [{ id: "agent", name: "Agent", command: "agent", args: [], env: {}, driver: options.driver ?? "claude-code", available: true }],
    runtime: { dataDir: "/runner", worktreeRoot: "/runner/worktrees", maxConcurrentSessions: 4,
      ...(options.sessionReview === null ? {} : { sessionReview: options.sessionReview ?? CAPABILITY }) } };
  db.registerRunner(metadata, 1, options.protocol ?? PROTOCOL_VERSION);
  const make = (id: string) => {
    db.createSession({ id, runnerId: "r", workspaceId: "w", agentId: "agent", title: id, useWorktree: true, creationActor: "human",
      scope: { organizationId: identity.organizationId, owner: { kind: "user", userId: identity.userId } },
      driver: options.driver ?? "claude-code", config: {}, now: 2 });
    db.updateSessionStatus(id, "running", 3);
  };
  make("s1");
  make("s2");
  const hub = new Hub(db);
  let online = true;
  hub.isRunnerOnline = () => online;
  hub.sessionChangedById = () => {};
  const sent: Array<{ type: string; jobId?: string; nonce?: string }> = [];
  let deliver = true;
  hub.sendToRunner = (_, message) => { if (deliver) sent.push(message as { type: string }); return deliver; };
  const svc = new SessionsService(db, hub, { info() {}, warn() {}, error() {} });
  return { db, svc, sent, setOnline: (value: boolean) => { online = value; }, setDeliver: (value: boolean) => { deliver = value; } };
}

test("a session requests its own review; the runner receives the durable command (#3306)", () => {
  const h = harness();
  try {
    const result = h.svc.requestSessionReviewJob("s1", request({ scope: "full", fullReason: "rebased onto main" }));
    assert.ok(result.ok && result.data, result.error ?? "request refused");
    assert.equal(result.status, 201);
    assert.match(result.data.jobId, SESSION_REVIEW_JOB_ID_PATTERN);
    assert.deepEqual({ sessionId: result.data.sessionId, state: result.data.state, terminal: result.data.terminal, scope: result.data.scope },
      { sessionId: "s1", state: "requested", terminal: false, scope: "full" });
    const command = h.sent.at(-1) as unknown as SessionReviewJobCommand;
    assert.equal(command.type, "session_review_job");
    assert.equal(command.jobId, result.data.jobId);
    assert.equal(command.sessionId, "s1", "the job is always bound to the requesting session");
    assert.deepEqual(command.request, request({ scope: "full", fullReason: "rebased onto main" }));
    assert.ok(command.nonce);

    const again = h.svc.requestSessionReviewJob("s1", request());
    assert.equal(again.ok, false);
    assert.equal(again.status, 409);
    assert.match(again.error!, /already running/u);
    assert.ok(h.svc.requestSessionReviewJob("s2", request()).ok, "another session's job is independent");
  } finally { h.db.close(); }
});

test("malformed review requests are refused before anything is recorded or sent", () => {
  const h = harness();
  try {
    const bad: unknown[] = [
      null,
      { ...request(), extra: true },
      request({ pullRequest: { repository: "not-a-repo", number: 1 } }),
      request({ pullRequest: { repository: "../etc", number: 1 } }),
      request({ pullRequest: { repository: "picoduck/wollipog", number: 0 } }),
      request({ pullRequest: { repository: "picoduck/wollipog", number: 1.5 } }),
      request({ headSha: "abc" }),
      request({ headSha: "A".repeat(40) }),
      request({ brief: "" }),
      request({ brief: "x".repeat(SESSION_REVIEW_BRIEF_LIMIT_BYTES + 1) }),
      request({ scope: "everything" as "full" }),
      request({ fullReason: "why" }),
      request({ scope: "delta", fullReason: "why" }),
      request({ scope: "full", fullReason: "x".repeat(501) }),
    ];
    for (const item of bad) {
      const result = h.svc.requestSessionReviewJob("s1", item as SessionReviewJobRequest);
      assert.equal(result.ok, false, JSON.stringify(item)?.slice(0, 120));
      assert.equal(result.status, 400, JSON.stringify(item)?.slice(0, 120));
    }
    assert.equal(h.sent.length, 0);
    assert.equal(h.svc.sessionReviewJobs("s1", {}).data?.jobs.length, 0);
    const { brief: _brief, ...withoutBrief } = request();
    assert.ok(h.svc.requestSessionReviewJob("s1", withoutBrief).ok, "a later round may omit the brief; the runner keeps it");
  } finally { h.db.close(); }
});

test("an unsupported runner, a missing installation or an unavailable reviewer is refused", () => {
  const old = harness({ protocol: PROTOCOL_VERSION - 1 });
  try {
    const refused = old.svc.requestSessionReviewJob("s1", request());
    assert.equal(refused.status, 409);
    assert.equal(refused.capabilityRequirement?.requiredRunnerProtocolVersion, PROTOCOL_VERSION);
    assert.equal(old.sent.length, 0);
  } finally { old.db.close(); }
  const missing = harness({ sessionReview: null });
  try {
    const refused = missing.svc.requestSessionReviewJob("s1", request());
    assert.equal(refused.status, 409);
    assert.match(refused.error!, /no trusted cross-model review installation/u);
  } finally { missing.db.close(); }
  const noCodex = harness({ sessionReview: { reviewers: ["claude-code"], unavailable: { codex: "codex is not installed" } } });
  try {
    const refused = noCodex.svc.requestSessionReviewJob("s1", request());
    assert.equal(refused.status, 409);
    assert.match(refused.error!, /Codex reviewer is unavailable.*codex is not installed/u);
  } finally { noCodex.db.close(); }
  const codexSession = harness({ driver: "codex", sessionReview: { reviewers: ["codex"] } });
  try {
    assert.match(codexSession.svc.requestSessionReviewJob("s1", request()).error!, /Claude Code reviewer is unavailable/u,
      "a Codex implementer needs the Claude Code reviewer");
  } finally { codexSession.db.close(); }
  const pi = harness({ driver: "pi" });
  try {
    assert.match(pi.svc.requestSessionReviewJob("s1", request()).error!, /no cross-model reviewer/u);
  } finally { pi.db.close(); }
  const offline = harness();
  try {
    offline.setOnline(false);
    assert.match(offline.svc.requestSessionReviewJob("s1", request()).error!, /offline/u);
  } finally { offline.db.close(); }
});

test("a session under a campaign allowance is refused and pointed at the campaign review job", () => {
  const h = harness();
  try {
    h.db.campaignBudgets.database.prepare(`INSERT INTO campaign_budget_members(session_id,root_id,cost,tools,active)
      VALUES ('s1','root',0,0,1)`).run();
    const refused = h.svc.requestSessionReviewJob("s1", request());
    assert.equal(refused.status, 409);
    assert.match(refused.error!, /run_campaign_review_job/u);
    assert.equal(h.sent.length, 0);
    assert.ok(h.svc.requestSessionReviewJob("s2", request()).ok, "a session outside the campaign is unaffected");
  } finally { h.db.close(); }
});

test("only the owning runner's updates with the job's nonce apply, and a terminal state is final", () => {
  const h = harness();
  try {
    const job = h.svc.requestSessionReviewJob("s1", request()).data!;
    const command = h.sent.at(-1) as unknown as SessionReviewJobCommand;
    const base = { type: "session_review_job_update" as const, jobId: job.jobId, nonce: command.nonce };
    h.svc.onSessionReviewJobUpdate("r", { ...base, nonce: "forged", state: "completed", report: "forged" });
    h.svc.onSessionReviewJobUpdate("other-runner", { ...base, state: "completed", report: "forged" });
    h.svc.onSessionReviewJobUpdate("r", { ...base, state: "bogus" as "running" });
    h.svc.onSessionReviewJobUpdate("r", { ...base, state: "running", round: -1 });
    assert.equal(h.svc.sessionReviewJob("s1", job.jobId).data!.state, "requested");

    h.svc.onSessionReviewJobUpdate("r", { ...base, state: "running", round: 2, attempt: 1, reviewer: "codex", controllerDigest: "d".repeat(64) });
    const running = h.svc.sessionReviewJob("s1", job.jobId).data!;
    assert.deepEqual({ state: running.state, round: running.round, attempt: running.attempt, reviewer: running.reviewer, terminal: running.terminal },
      { state: "running", round: 2, attempt: 1, reviewer: "codex", terminal: false });

    const oversized = "L".repeat(SESSION_REVIEW_ARTIFACT_LIMIT_BYTES + 10);
    h.svc.onSessionReviewJobUpdate("r", { ...base, state: "completed", summary: "{\"status\":\"complete\"}", report: "{\"vote\":\"UPVOTE\"}", ledger: oversized });
    const done = h.svc.sessionReviewJob("s1", job.jobId).data!;
    assert.deepEqual({ state: done.state, terminal: done.terminal, round: done.round, hasReport: done.hasReport, ledgerTruncated: done.ledgerTruncated },
      { state: "completed", terminal: true, round: 2, hasReport: true, ledgerTruncated: true });
    const artifacts = h.svc.sessionReviewJobArtifacts("s1", job.jobId).data!;
    assert.equal(artifacts.summary, "{\"status\":\"complete\"}");
    assert.equal(artifacts.report, "{\"vote\":\"UPVOTE\"}");
    assert.equal(Buffer.byteLength(artifacts.ledger!), SESSION_REVIEW_ARTIFACT_LIMIT_BYTES);

    h.svc.onSessionReviewJobUpdate("r", { ...base, state: "failed", reason: "the review was cancelled" });
    h.svc.onSessionReviewJobUpdate("r", { ...base, state: "running" });
    assert.equal(h.svc.sessionReviewJob("s1", job.jobId).data!.state, "completed", "a finished job never changes");
    assert.ok(h.svc.requestSessionReviewJob("s1", request()).ok, "a finished job no longer blocks the next round");
  } finally { h.db.close(); }
});

test("runner reasons are reduced to the fixed vocabulary", () => {
  const h = harness();
  try {
    const job = h.svc.requestSessionReviewJob("s1", request()).data!;
    const command = h.sent.at(-1) as unknown as SessionReviewJobCommand;
    h.svc.onSessionReviewJobUpdate("r", { type: "session_review_job_update", jobId: job.jobId, nonce: command.nonce,
      state: "not_launched", reason: "failed at /home/user/.secret/path" });
    assert.equal(h.svc.sessionReviewJob("s1", job.jobId).data!.reason, "the review could not be completed; see the runner log");
  } finally { h.db.close(); }
});

test("reads are bound to the job's own session", () => {
  const h = harness();
  try {
    const job = h.svc.requestSessionReviewJob("s1", request()).data!;
    assert.equal(h.svc.sessionReviewJob("s2", job.jobId).status, 404);
    assert.equal(h.svc.sessionReviewJobArtifacts("s2", job.jobId).status, 404);
    assert.equal(h.svc.cancelSessionReviewJob("s2", job.jobId).status, 404);
    assert.equal(h.svc.sessionReviewJob("s1", "srj_../../x").status, 404);
    assert.equal(h.svc.sessionReviewJobs("s2", { afterJobId: job.jobId }).status, 404, "another session's cursor is refused");
  } finally { h.db.close(); }
});

test("listing pages newest first", () => {
  const h = harness();
  try {
    const ids: string[] = [];
    for (let i = 0; i < 3; i++) {
      const job = h.svc.requestSessionReviewJob("s1", request()).data!;
      ids.push(job.jobId);
      const command = h.sent.at(-1) as unknown as SessionReviewJobCommand;
      h.svc.onSessionReviewJobUpdate("r", { type: "session_review_job_update", jobId: job.jobId, nonce: command.nonce, state: "failed" });
    }
    const first = h.svc.sessionReviewJobs("s1", { limit: 2 }).data!;
    assert.deepEqual(first.jobs.map((job) => job.jobId), [ids[2], ids[1]]);
    const second = h.svc.sessionReviewJobs("s1", { limit: 2, afterJobId: first.nextAfterJobId! }).data!;
    assert.deepEqual(second.jobs.map((job) => job.jobId), [ids[0]]);
    assert.equal(second.nextAfterJobId, null);
    assert.equal(h.svc.sessionReviewJobs("s1", { limit: 0 }).status, 400);
  } finally { h.db.close(); }
});

test("cancelling sends the job first when the runner may never have received it", () => {
  const h = harness();
  try {
    const job = h.svc.requestSessionReviewJob("s1", request()).data!;
    h.sent.length = 0;
    const cancelled = h.svc.cancelSessionReviewJob("s1", job.jobId);
    assert.equal(cancelled.status, 202);
    assert.equal(cancelled.data!.cancelRequested, true);
    assert.deepEqual(h.sent.map((message) => message.type), ["session_review_job", "cancel_session_review_job"]);
    assert.ok(h.sent.every((message) => message.jobId === job.jobId));
  } finally { h.db.close(); }
});

test("reconnect re-dispatches unfinished jobs, with their pending cancellation", () => {
  const h = harness();
  try {
    h.setDeliver(false);
    const job = h.svc.requestSessionReviewJob("s1", request());
    assert.ok(job.ok, "an undelivered request stays durable for reconnect");
    h.svc.cancelSessionReviewJob("s1", job.data!.jobId);
    h.setDeliver(true);
    h.svc.recoverSessionReviewJobs("r");
    assert.deepEqual(h.sent.map((message) => message.type), ["session_review_job", "cancel_session_review_job"]);
    const command = h.sent[0] as unknown as SessionReviewJobCommand;
    h.svc.onSessionReviewJobUpdate("r", { type: "session_review_job_update", jobId: command.jobId, nonce: command.nonce,
      state: "not_launched", reason: "the review was cancelled" });
    h.sent.length = 0;
    h.svc.recoverSessionReviewJobs("r");
    assert.equal(h.sent.length, 0, "a finished job is never sent again");
  } finally { h.db.close(); }
});

test("a runner that lost support cannot report, so its unfinished jobs finish on reconnect", () => {
  const h = harness();
  try {
    const job = h.svc.requestSessionReviewJob("s1", request()).data!;
    h.db.registerRunner({ runnerId: "r", hostname: "test", os: "linux", version: "old", workspaces: [], agents: [] }, 1, PROTOCOL_VERSION - 1);
    h.sent.length = 0;
    h.svc.recoverSessionReviewJobs("r");
    assert.equal(h.sent.length, 0);
    const view = h.svc.sessionReviewJob("s1", job.jobId).data!;
    assert.deepEqual({ state: view.state, terminal: view.terminal }, { state: "not_launched", terminal: true });
  } finally { h.db.close(); }
});
