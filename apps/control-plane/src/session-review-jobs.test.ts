import assert from "node:assert/strict";
import { test } from "node:test";
import {
  PROTOCOL_VERSION, SESSION_REVIEW_ARTIFACT_LIMIT_BYTES,
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

/** Seed an already-dispatched pre-retirement record; this never calls admission or sends a job. */
function seedHistoricalBridge(h: ReturnType<typeof harness>) {
  const command = h.db.sessionReviewJobs.create("s1", "r", request(), Date.now());
  return { ok: true, data: h.db.sessionReviewJobs.view(command.jobId)! };
}

test("legacy bridge admission always refuses with migration guidance, without writes or dispatch", () => {
  for (const protocol of [223, 243, PROTOCOL_VERSION]) {
    const h = harness({ protocol });
    try {
      assert.equal(h.svc.requestSessionReviewJob("s1", request()).status, 410);
      assert.match(h.svc.requestSessionReviewJob("s1", request()).error!, /retired.*review session/u);
      assert.equal(h.db.sessionReviewJobs.page("s1", undefined, 10)?.jobs.length, 0);
      assert.equal(h.sent.length, 0);
      assert.equal(h.svc.requestSessionReviewJob("s1", request(), () => false).status, 404);
    } finally { h.db.close(); }
  }
});

test("only the owning runner's updates with the job's nonce apply, and a terminal state is final", () => {
  const h = harness();
  try {
    const job = seedHistoricalBridge(h).data!;
    const command = h.db.sessionReviewJobs.command(job.jobId)!;
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
    assert.equal(h.svc.requestSessionReviewJob("s1", request()).status, 410, "new reviews use review sessions");
  } finally { h.db.close(); }
});

test("runner reasons are reduced to the fixed vocabulary", () => {
  const h = harness();
  try {
    const job = seedHistoricalBridge(h).data!;
    const command = h.db.sessionReviewJobs.command(job.jobId)!;
    h.svc.onSessionReviewJobUpdate("r", { type: "session_review_job_update", jobId: job.jobId, nonce: command.nonce,
      state: "not_launched", reason: "failed at /home/user/.secret/path" });
    assert.equal(h.svc.sessionReviewJob("s1", job.jobId).data!.reason, "the review could not be completed; see the runner log");
  } finally { h.db.close(); }
});

test("reads are bound to the job's own session", () => {
  const h = harness();
  try {
    const job = seedHistoricalBridge(h).data!;
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
      const job = seedHistoricalBridge(h).data!;
      ids.push(job.jobId);
      const command = h.db.sessionReviewJobs.command(job.jobId)!;
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


test("cancellation never dispatches a requested legacy bridge job", () => {
  const h = harness();
  try {
    const job = seedHistoricalBridge(h).data;
    assert.equal(h.svc.cancelSessionReviewJob("s1", job.jobId).status, 202);
    assert.deepEqual(h.sent.map(message => message.type), ["cancel_session_review_job"]);
    assert.equal(h.svc.sessionReviewJob("s1", job.jobId).data?.terminal, false, "await the owning runner's terminal receipt");
  } finally { h.db.close(); }
});

test("reconnect cancels retired bridge work once and never redispatches it, including a downgraded runner", () => {
  for (const protocol of [222, PROTOCOL_VERSION]) {
    const h = harness({ protocol });
    try {
      const job = seedHistoricalBridge(h).data;
      h.svc.recoverSessionReviewJobs("r");
      assert.deepEqual(h.sent.map(message => message.type), protocol < 223 ? [] : ["cancel_session_review_job"]);
      assert.equal(h.svc.sessionReviewJob("s1", job.jobId).data?.state, protocol < 223 ? "failed" : "requested");
      assert.match(h.svc.sessionReviewJob("s1", job.jobId).data?.reason ?? "", /retired/u);
      if (protocol >= 223) {
        assert.equal(h.svc.sessionReviewJob("s1", job.jobId).data?.cancelRequested, true);
        h.sent.length = 0;
        h.svc.recoverSessionReviewJobs("r");
        assert.deepEqual(h.sent.map(message => message.type), ["cancel_session_review_job"], "lost cancellation is retried without dispatch");
        const command = h.db.sessionReviewJobs.command(job.jobId)!;
        h.svc.onSessionReviewJobUpdate("r", { type: "session_review_job_update", jobId: job.jobId,
          nonce: command.nonce, state: "failed", reason: "the review was cancelled" });
      }
      h.sent.length = 0;
      h.svc.recoverSessionReviewJobs("r");
      assert.equal(h.sent.length, 0);
    } finally { h.db.close(); }
  }
});
