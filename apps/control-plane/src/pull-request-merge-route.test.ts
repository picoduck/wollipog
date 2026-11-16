/**
 * #604: the merge-readiness gate and the Owner/Admin-only enqueue-or-merge route. The runner is a
 * stub that records what it was asked; the routes add role, Required findings and runner support,
 * and record the action in the governance audit.
 */
import assert from "node:assert/strict";
import { test } from "node:test";
import Fastify from "fastify";
import { PROTOCOL_VERSION, type GitMergeResultInfo, type PullRequestMergeFacts, type ReviewFinding } from "@wollipog/protocol";
import { ControlPlaneDb } from "./db.js";
import { Hub } from "./hub.js";
import type { HumanPrincipal } from "./identity.js";
import { createSessionGitManagement } from "./session-git-management.js";
import { SessionsService } from "./sessions.js";
import { ASSISTANT_RESIDUAL_MANAGEMENT } from "./assistant-campaign-management.js";

const HEAD = "a".repeat(40);
const URL = "https://github.com/o/r/pull/7";

const FACTS: PullRequestMergeFacts = {
  url: URL, repository: "o/r", number: 7, state: "open", headSha: HEAD, isDraft: false, baseRef: "main",
  mergeQueueEnabled: true, inMergeQueue: false, mergeStateStatus: "CLEAN",
  requiredChecks: { state: "passed", failing: [], pending: [] }, viewerPermission: "write",
  mergeMethod: "squash", deleteBranchOnMerge: false, observedAt: 1,
};

async function fixture(options: { supported?: boolean; merge?: GitMergeResultInfo } = {}) {
  const db = ControlPlaneDb.open(":memory:"), local = db.localIdentityContext();
  db.registerRunner({ runnerId: "runner", hostname: "fixture", os: "linux", version: "fixture", agents: [],
    workspaces: [{ id: "repo", name: "Fixture", path: "/fixture" }] }, 1, PROTOCOL_VERSION);
  db.createSession({ id: "s1", runnerId: "runner", workspaceId: "repo", agentId: "fixture", driver: "acp", useWorktree: true, title: "s1", config: {}, now: 1 });
  db.updateSessionStatus("s1", "running", 2);
  db.raw().prepare("UPDATE sessions SET worktree_path=? WHERE id=?").run("/fixture/managed-s1", "s1");
  const principals: Record<string, HumanPrincipal> = { owner: db.operatingHumanPrincipal(local.userId, local.organizationId)! };
  for (const role of ["admin", "operator"] as const) {
    db.createIdentityMember({ userId: `usr_${role}`, displayName: role, organizationId: local.organizationId, role, now: 2 });
    principals[role] = db.operatingHumanPrincipal(`usr_${role}`, local.organizationId)!;
  }
  // A Viewer is not an operating principal; the same member, read-only.
  principals.viewer = { ...principals.operator!, actorId: "usr_viewer", userId: "usr_viewer", role: "viewer" };
  const hub = new Hub(db), dispatched: any[] = [];
  hub.isRunnerOnline = () => true;
  hub.requestFromRunner = async (_id, requestId, message: any) => {
    dispatched.push(message);
    const data = message.action.kind === "merge_readiness"
      ? { mergeReadiness: { facts: FACTS } }
      : { mergeResult: options.merge ?? { outcome: "enqueued", message: "Added to the merge queue at position 1.", mode: "enqueue", headSha: HEAD, state: "open", queuePosition: 1 } };
    return { type: "git_result", requestId, ok: true, data } as any;
  };
  const svc = new SessionsService(db, hub, { info() {}, warn() {}, error() {} } as any), app = Fastify();
  const git = createSessionGitManagement({
    db, svc, hub, outboundEvents: { recordChecksFromSummary() { return true; } },
    runnerCapabilityError: (_runner, capability) => options.supported === false && capability === "pullRequestMerge"
      ? { ok: false, status: 409, error: "the runner must be updated for pull request merging", code: "RUNNER_UPDATE_REQUIRED" } as any : null,
  });
  git.registerHttp(app, (request) => principals[String(request.headers.authorization)] ?? null);
  const readiness = async (who: string) => (await app.inject({ method: "GET", url: "/api/sessions/s1/pull-request/merge-readiness", headers: { authorization: who } })).json();
  const merge = (who: string, payload: unknown = { pullRequestUrl: URL, headSha: HEAD, mode: "enqueue" }) =>
    app.inject({ method: "POST", url: "/api/sessions/s1/pull-request/merge", headers: { authorization: who }, payload: payload as object });
  const addRequiredFinding = () => db.createReviewFinding({
    findingId: "f1", sessionId: "s1", scope: "uncommitted", diffHash: "h", filePath: "a.ts", side: "right", line: 1,
    body: "Fix this", severity: "major", required: true, status: "open", source: "local",
    author: { kind: "human", id: local.userId }, createdAt: 3, updatedAt: 3,
  } as ReviewFinding);
  return { db, app, dispatched, readiness, merge, addRequiredFinding, close: async () => { await app.close(); db.close(); } };
}

test("the readiness gate combines the runner's forge facts with role and Required findings", async () => {
  const f = await fixture();
  try {
    const owner = await f.readiness("owner");
    assert.deepEqual(owner.readiness, { mode: "enqueue", label: "Enqueue for Merge", ready: true, blockers: [], headSha: HEAD, mergeMethod: null });
    assert.deepEqual(owner.facts, FACTS);
    assert.deepEqual(f.dispatched.map((message) => [message.type, message.action.kind, message.worktreePath]),
      [["git_action", "merge_readiness", "/fixture/managed-s1"]], "a busy session can still be read; the runner holds the forge login");
    assert.equal((await f.readiness("admin")).readiness.ready, true);
    assert.deepEqual((await f.readiness("operator")).readiness.blockers,
      [{ code: "role", message: "Merging requires an Admin or Owner role." }]);
    assert.deepEqual((await f.readiness("viewer")).readiness.blockers, [{ code: "role", message: "Your Viewer role is read-only." }]);
    f.addRequiredFinding();
    assert.deepEqual((await f.readiness("owner")).readiness.blockers,
      [{ code: "required_findings", message: "Resolve the open Required finding first." }]);
  } finally {
    await f.close();
  }
});

test("an older runner is explained without being asked, and the merge route refuses it", async () => {
  const f = await fixture({ supported: false });
  try {
    const body = await f.readiness("owner");
    assert.equal(body.readiness.ready, false);
    assert.ok(body.readiness.blockers.some((blocker: { code: string }) => blocker.code === "runner_unsupported"));
    assert.equal((await f.merge("owner")).statusCode, 409);
    assert.deepEqual(f.dispatched, []);
  } finally {
    await f.close();
  }
});

test("only an Owner or Admin may merge, exactly as confirmed, and both the request and the outcome are audited", async () => {
  const f = await fixture();
  try {
    for (const who of ["operator", "viewer"]) {
      const refused = await f.merge(who);
      assert.equal(refused.statusCode, 403, who);
    }
    assert.equal((await f.merge("owner", { pullRequestUrl: URL, headSha: "abc", mode: "enqueue" })).statusCode, 400);
    assert.deepEqual(f.dispatched, [], "nothing reaches the runner before the gate");

    const accepted = await f.merge("admin");
    assert.equal(accepted.statusCode, 200);
    assert.equal(accepted.json().result.outcome, "enqueued");
    assert.deepEqual(f.dispatched.map((message) => message.action),
      [{ kind: "merge_pull_request", pullRequestUrl: URL, headSha: HEAD, mode: "enqueue" }]);
    const audit = f.db.listGovernanceAudit("s1").filter((entry) => entry.approvalKind === "pull_request_merge");
    assert.deepEqual(audit.map((entry) => [entry.stage, entry.outcome, entry.actor.kind, entry.actor.id, entry.optionId ?? null]),
      [["request", "pending", "human", "usr_admin", null], ["resolution", "allowed", "human", "usr_admin", "enqueued"]]);
    assert.equal(audit[0]!.requestId, audit[1]!.requestId);
    assert.match(audit[0]!.contentDigest ?? "", /^[0-9a-f]{64}$/u, "the pull request and head are kept only as a digest");
  } finally {
    await f.close();
  }
});

test("open Required findings refuse the merge before the runner is asked", async () => {
  const f = await fixture();
  try {
    f.addRequiredFinding();
    const refused = await f.merge("owner");
    assert.equal(refused.statusCode, 409);
    assert.match(refused.json().error, /Resolve the open Required finding first\./u);
    assert.deepEqual(f.dispatched, []);
  } finally {
    await f.close();
  }
});

test("a refusal the runner read back is audited as denied", async () => {
  const f = await fixture({ merge: { outcome: "refused", message: "The pull request's head changed since you confirmed; review the new head first.", mode: "enqueue", headSha: HEAD, state: "open" } });
  try {
    const response = await f.merge("owner");
    assert.equal(response.statusCode, 200);
    assert.equal(response.json().result.outcome, "refused");
    const resolution = f.db.listGovernanceAudit("s1").find((entry) => entry.approvalKind === "pull_request_merge" && entry.stage === "resolution");
    assert.deepEqual([resolution?.outcome, resolution?.optionId], ["denied", "refused"]);
  } finally {
    await f.close();
  }
});

test("neither the shared Git route nor an assistant connection can reach the merge", async () => {
  const f = await fixture();
  try {
    for (const action of ["merge_pull_request", "merge_readiness"]) {
      const response = await f.app.inject({ method: "POST", url: "/api/sessions/s1/git", headers: { authorization: "owner" },
        payload: { action, pullRequestUrl: URL, headSha: HEAD, mode: "enqueue" } });
      assert.equal(response.statusCode, 400, action);
    }
    assert.deepEqual(f.dispatched, []);
    assert.ok(ASSISTANT_RESIDUAL_MANAGEMENT.every(([, route]) => !route.includes("pull-request")));
  } finally {
    await f.close();
  }
});
