import assert from "node:assert/strict";
import { test } from "node:test";
import {
  DEFAULT_ORCHESTRATOR_DEFAULTS, HUMAN_ONLY_PARENT_CONTROL_POLICY, PROTOCOL_VERSION, REVIEW_SESSION_BRIEF_LIMIT_BYTES, REVIEW_SESSION_OUTPUT_LIMIT_BYTES,
  planReviewRound, REVIEW_ROUND_REFUSALS,
  type CampaignBudgetAuthority,
  type ReviewAttemptRound, type ReviewAttemptVerdictView, type ReviewReportFinding, type ReviewRunHistory,
  type ReviewSessionCapability, type ReviewSessionRequest, type RunnerMetadata, type StartSessionMessage,
} from "@wollipog/protocol";
import { ControlPlaneDb } from "./db.js";
import { Hub } from "./hub.js";
import { SessionsService } from "./sessions.js";
import { resolveOrchestratorCampaignPolicy } from "./orchestrator-settings.js";

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
  campaign?: boolean;
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
  if (options.campaign) {
    for (const agent of metadata.agents.filter((agent) => agent.id !== "pi")) {
      agent.capabilities = { models: [{ id: agent.id === "claude" ? "claude-opus-5-5" : "gpt-6.1-sol", default: true }],
        effortLevels: ["high"], slashCommands: [], supportsImages: false, supportsApprovals: true,
        permissionModes: [agent.id === "claude" ? "dontAsk" : "read-only"] };
    }
    db.registerRunner(metadata, 1, options.protocol ?? PROTOCOL_VERSION);
    db.setUsageRateTable(new Map(["claude-opus-5-5", "gpt-6.1-sol"].map((model) => [model,
      { inputCostPerToken: 0.000001, outputCostPerToken: 0.000001, cacheReadCostPerToken: 0.000001, cacheCreationCostPerToken: 0.000001 }])));
    const policy = resolveOrchestratorCampaignPolicy(DEFAULT_ORCHESTRATOR_DEFAULTS, "system_default");
    policy.issueScope = { repository: "picoduck/wollipog", issueNumbers: [3371], revision: 1,
      authorizedByUserId: identity.userId, authorizedAt: 1 };
    policy.issueNumbers = [3371];
    db.createSession({ id: "root", runnerId: "r", workspaceId: "w", agentId: "claude", title: "Campaign", useWorktree: false,
      driver: "claude-code", config: { model: "claude-opus-5-5" }, now: 2, role: "orchestrator", orchestratorPolicy: policy,
      parentControlPolicy: { decisions: { ...HUMAN_ONLY_PARENT_CONTROL_POLICY } },
      scope: { organizationId: identity.organizationId, owner: { kind: "user", userId: identity.userId } } });
    db.updateSessionStatus("root", "running", 3);
  }
  const driver = options.driver ?? "claude-code";
  const make = (id: string) => {
    db.createSession({ id, runnerId: "r", workspaceId: "w", agentId: driver === "claude-code" ? "claude" : driver === "pi" ? "pi" : "codex",
      title: id, useWorktree: true, creationActor: "human",
      scope: { organizationId: identity.organizationId, owner: { kind: "user", userId: identity.userId } },
      driver, config: options.campaign ? { model: driver === "claude-code" ? "claude-opus-5-5" : "gpt-6.1-sol" } : {}, now: 2,
      ...(options.campaign ? { parentSessionId: "root" } : {}) });
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
  const enableCampaign = (extra: Partial<CampaignBudgetAuthority> = {}) => {
    const result = svc.setCampaignControl("root", { mode: "full_control", objective: "Implement #3371",
      operations: ["implementation_question"], delegatablePolicyIds: [],
      budgetAuthority: { version: 1, accounting: "managed_workers_only", unpriced: "stop", costUsd: 140, toolCalls: 140, concurrency: 4, ...extra } },
    1, { ...identity, kind: "human", actorId: identity.userId });
    assert.ok(result.ok, result.error ?? "campaign authorization refused");
    sent.length = 0;
  };
  return { db, svc, hub, sent, starts, metadata, enableCampaign, setOnline: (value: boolean) => { online = value; },
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
    // Display child only: no delegation slot, charge or campaign membership.
    assert.equal(reviewSession.parentSessionId, "s1");
    assert.equal(reviewSession.campaignMembership, undefined);
    assert.deepEqual(h.db.campaignDescendantIds("s1"), []);
    assert.equal(h.db.getSession("s1")!.liveChildCapacity?.occupied, 0);
    assert.equal(h.db.getSession("s1")!.kind, undefined, "an ordinary session reports no kind");
    assert.equal(reviewSession.title, "Codex Review of picoduck/wollipog#3368");
    // The requester's own view summarizes its reviews, so a client reads them only when there are any.
    assert.deepEqual(h.db.getSession("s1")!.reviewRuns, { count: 1, active: 1, updatedAt: h.db.reviewSessions.view(view.reviewSessionId)!.updatedAt });
    assert.equal(h.db.getSession("s2")!.reviewRuns, undefined, "a session that requested none has no summary");
    assert.equal(reviewSession.reviewRuns, undefined, "a review session reports its link, not a summary");
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

test("review children preserve project attribution and never reserve implementation capacity or charges", () => {
  const h = harness();
  try {
    const project = h.db.createProject({ name: "Repo", scope: h.db.sessionScope("s1")! });
    h.db.setSessionProject("s1", project.id, null, 4);
    h.db.updateSessionMaxChildSessions("s1", 0, 4);
    h.db.updateSessionCostBudget("s1", 10, 4);
    const before = h.db.childSessionAllocations("s1");
    const { reviewSessionId: id } = requested(h);
    assert.equal(h.db.getSession(id)!.projectId, project.id);
    assert.equal(h.db.getSession(id)!.workspaceId, "w");
    assert.equal(h.db.getSession(id)!.parentControl, "off");
    assert.equal(h.db.getSession("s1")!.role, "normal");
    h.db.updateSessionStatus(id, "running", 5);
    h.db.raw().prepare("UPDATE sessions SET cost_usd=2 WHERE id=?").run(id);
    h.db.updateSessionStatus(id, "completed", 6);
    assert.deepEqual(h.db.childSessionAllocations("s1"), before, "review spending and settlement do not charge delegation");
    assert.equal(h.db.getSession("s1")!.liveChildCapacity!.occupied, 0);
    assert.equal(h.db.listSessions().find(s => s.id === "s1")!.liveChildCapacity!.occupied, 0);
    assert.equal(h.db.campaignAncestryRoot(id), "none");
    assert.deepEqual(h.db.listSessionDescendantRequestCandidates("s1"), []);
    assert.equal(h.svc.prompt(id, "implement this").status, 409);
  } finally { h.db.close(); }
});

test("startup repairs legacy top-level review rows and disposes delivered terminal reviews idempotently", () => {
  const h = harness();
  try {
    const { reviewSessionId: id } = requested(h);
    h.db.raw().prepare("UPDATE sessions SET parent_session_id=NULL WHERE id=?").run(id);
    h.db.reviewSessions.accept("r", { type: "review_session_update", sessionId: id, state: "completed", output: report() }, 10);
    h.db.claimHeldReviewContinuations("s1", [id], 11);
    h.db.updateSessionStatus(id, "completed", 12);
    const events = h.db.appendEvent(id, { kind: "agent_message", text: "Review transcript", final: true }, 12);
    for (let attempt = 0; attempt < 2; attempt++) {
      new SessionsService(h.db, h.hub, { info() {}, warn() {}, error() {} });
      assert.equal(h.db.getSession(id)!.parentSessionId, "s1");
      assert.equal(h.db.getSession(id)!.archived, true);
      assert.equal(h.db.listEvents(id).find(event => event.seq === events.seq)?.payload.kind, "agent_message");
      assert.equal(h.svc.reviewSessionView("s1", id).data?.output, report());
      assert.equal(h.db.childSessionAllocations("s1").count, 0);
    }
  } finally { h.db.close(); }
});

test("archiving a requester cancels and archives its reviewers while retaining their transcript links", () => {
  const h = harness();
  try {
    const { reviewSessionId: id } = requested(h);
    assert.ok(h.svc.setArchived("s1", true).ok);
    assert.equal(h.db.reviewSessions.view(id)!.cancelRequested, true);
    h.svc.onReviewSessionUpdate("r", { type: "review_session_update", sessionId: id, state: "cancelled" });
    h.svc.onSessionStatus(id, "stopped", undefined, undefined, "r");
    assert.equal(h.db.getSession(id)!.archived, true);
    assert.equal(h.db.getSession(id)!.parentSessionId, "s1");
  } finally { h.db.close(); }
});

test("reviews under a campaign remain outside its membership, counts, requests and limits", () => {
  const h = harness();
  try {
    h.db.createSession({ id: "campaign", runnerId: "r", workspaceId: "w", agentId: "claude", title: "Campaign",
      driver: "claude-code", useWorktree: false, role: "orchestrator", config: {}, now: 4,
      orchestratorPolicy: resolveOrchestratorCampaignPolicy(DEFAULT_ORCHESTRATOR_DEFAULTS, "system_default") });
    h.db.raw().prepare("UPDATE sessions SET parent_session_id='campaign' WHERE id='s1'").run();
    const before = h.db.campaignProjection("campaign")!;
    const { reviewSessionId: id } = requested(h);
    assert.deepEqual(h.db.campaignDescendantIds("campaign"), ["s1"]);
    assert.deepEqual(h.db.campaignProjection("campaign")!.children, before.children);
    assert.equal(h.db.getSession(id)!.campaignMembership, undefined);
    assert.equal(h.db.campaignAncestryRoot(id), "none");
    assert.equal(h.db.isSessionDescendant("s1", id), false);
    assert.equal(h.db.isSessionDescendant("campaign", id), false);
    assert.equal(h.db.sessionResultOrchestrator(id), null);
    assert.equal(h.db.campaignBudgets.root(id), null);
    assert.deepEqual(h.db.listSessionDescendantRequestCandidates("campaign").map(s => s.id), ["s1"]);
    const plan = h.svc.recordCampaignPlan("campaign", { items: [{ key: "implementation" }], planComplete: true });
    assert.ok(plan.ok, plan.error ?? "campaign plan refused");
    const workItemId = plan.data!.items[0]!.workItemId;
    assert.equal(h.svc.assignCampaignWorkItem("campaign", { workItemId, childSessionId: id }).status, 404);
    assert.equal(h.svc.verifyCampaignChild("campaign", { childSessionId: id, reportEventSeq: 1, followUpsAccounted: true }).status, 404);
    const batch = h.svc.beginRunnerAttentionBatch("r");
    assert.equal(batch.capture(h.db.getSession(id)), null);
    h.db.createSession({ id: "ordinary", parentSessionId: "s1", runnerId: "r", workspaceId: "w", agentId: "claude",
      title: "Ordinary Child", useWorktree: false, driver: "claude-code", config: {}, now: 5 });
    assert.equal(batch.capture(h.db.getSession("ordinary"))?.id, "campaign", "a reviewer cannot poison its siblings' campaign cache");
    h.db.campaignBudgets.authorize("campaign", { version: 1, accounting: "managed_workers_only", unpriced: "stop", concurrency: 2 });
    assert.equal(h.db.campaignBudgets.root(id), "campaign", "retroactive allowance accounting includes reviewer spending");
    assert.equal(h.db.campaignBudgets.view("campaign")!.occupied, 2, "only the two implementation workers take slots");
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

test("a discovery result replaces the reviewer capability a registration made before discovery", () => {
  // Registered before discovery: no agent was available yet, so no Codex reviewer was advertised.
  const h = harness({ reviewSession: { reviewers: [], unavailable: { codex: "no available native agent uses this harness" } } });
  try {
    assert.match(h.svc.requestReviewSession("s1", request()).error!, /Codex reviewer is unavailable/u);
    h.db.updateRunnerReviewSessionCapability("r", CAPABILITY);
    assert.deepEqual(h.db.getRunner("r")!.runtime?.reviewSession, CAPABILITY);
    assert.equal(h.db.getRunner("r")!.runtime?.maxConcurrentSessions, 4, "the rest of the runtime is kept");
    assert.ok(h.svc.requestReviewSession("s1", request()).ok, "the discovered reviewer is used");
    // A malformed capability is dropped, so the next request is refused rather than launched on it.
    h.db.updateRunnerReviewSessionCapability("r", { reviewers: [{ harness: "bash", agentId: "x" }] } as never);
    assert.equal(h.db.getRunner("r")!.runtime?.reviewSession, undefined);
    h.db.updateRunnerReviewSessionCapability("r", null);
    assert.equal(h.db.getRunner("r")!.runtime?.reviewSession, undefined);
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
    assert.equal(codex.db.getSession(start!.spec.sessionId)!.title, "Claude Review of picoduck/wollipog#3368");
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

/** The prompts the requester's runner was sent as durable commands, by command id. */
function continuationCommands(h: ReturnType<typeof harness>): Map<string, string> {
  const commands = new Map<string, string>();
  for (const message of h.sent) {
    if (message.type !== "durable_session_command") continue;
    const command = (message as unknown as { commandId: string; command: { type: string; text?: string } });
    if (command.command.type === "prompt_session") commands.set(command.commandId, command.command.text ?? "");
  }
  return commands;
}

/** The prompts the requester's runner was sent on the immediate lane. */
function immediatePrompts(h: ReturnType<typeof harness>): string[] {
  return h.sent.filter((message) => message.type === "prompt_session" && (message as { sessionId?: string }).sessionId === "s1")
    .map((message) => String((message as { text?: unknown }).text ?? ""));
}

test("without a worktree the continuation goes out once on the immediate lane, claimed before the send", () => {
  const h = harness();
  try {
    h.db.updateSessionStatus("s1", "idle", 10);
    const view = requested(h);
    h.svc.onReviewSessionUpdate("r", { type: "review_session_update", sessionId: view.reviewSessionId, state: "completed",
      output: report(), round: ROUND, verdict: VALID } as never);
    assert.equal(immediatePrompts(h).length, 1);
    assert.match(immediatePrompts(h)[0]!, /valid DOWNVOTE/u);
    assert.equal(h.db.reviewSessions.view(view.reviewSessionId)!.continuation, "delivered");
    h.svc.retryDuePrompts();
    assert.equal(immediatePrompts(h).length, 1, "a later sweep sends nothing again");
  } finally { h.db.close(); }
});

test("a finished review owes its idle requester exactly one continuation, delivered durably", () => {
  const h = harness();
  try {
    // A worktree-backed idle session takes control-plane prompts on the durable lane.
    h.db.setWorktreePath("s1", "/repo/worktrees/s1");
    const view = requested(h);
    h.svc.onReviewSessionUpdate("r", { type: "review_session_update", sessionId: view.reviewSessionId, state: "running", round: ROUND } as never);
    // The requester is mid-turn (polling the review, say): the continuation waits for it to settle.
    h.svc.onReviewSessionUpdate("r", { type: "review_session_update", sessionId: view.reviewSessionId, state: "completed",
      output: report(), round: ROUND, verdict: VALID } as never);
    assert.equal(h.db.reviewSessions.view(view.reviewSessionId)!.continuation, "pending");
    assert.equal(h.db.getSession(view.reviewSessionId)!.archived, false, "the report still owes a continuation");
    assert.equal(continuationCommands(h).size, 0);
    const heldSummary = h.db.reviewSessions.summaryFor("s1")!;
    h.db.updateSessionStatus("s1", "idle", 10);
    h.svc.retryDuePrompts();
    assert.ok(h.db.reviewSessions.summaryFor("s1")!.updatedAt > heldSummary.updatedAt, "staging refreshes the summary");
    const commands = continuationCommands(h);
    assert.equal(commands.size, 1, "one durable command carries it");
    const [commandId, text] = [...commands][0]!;
    assert.match(text, new RegExp(`^\\[Wollipog Cross-Model Review — ${view.reviewSessionId}\\]`, "u"));
    assert.match(text, /Codex Review of picoduck\/wollipog#3368 at a{12} \(round 1, epoch 1\) ended with a valid DOWNVOTE with 1 finding\(s\), 1 blocking\./u);
    assert.match(text, /- \[high blocking\] src\/a\.ts:3: Wrong/u);
    assert.match(text, /Adjudicate every finding/u);
    assert.match(text, /\[End Wollipog Cross-Model Review\]$/u);
    // Later sweeps follow that command; none stages another.
    h.svc.retryDuePrompts();
    h.svc.retryDuePrompts();
    assert.deepEqual([...continuationCommands(h).keys()], [commandId]);
    const pendingSummary = h.db.reviewSessions.summaryFor("s1")!;
    h.svc.onDurablePromptReceipt("r", {
      type: "durable_session_command_update", commandId, sessionId: "s1", state: "started", revision: 5,
    } as never);
    assert.equal(h.db.reviewSessions.view(view.reviewSessionId)!.continuation, "delivered");
    assert.equal(h.db.getSession(view.reviewSessionId)!.archiveStatus, "stop_pending", "delivery requests Stop and Archive");
    h.svc.onSessionStatus(view.reviewSessionId, "stopped", undefined, undefined, "r");
    assert.equal(h.db.getSession(view.reviewSessionId)!.archived, true, "runner settlement completes disposal");
    assert.equal(h.db.getSession(view.reviewSessionId)!.parentSessionId, "s1", "archival retains ancestry");
    assert.equal(h.svc.reviewSessionView("s1", view.reviewSessionId).data?.output, report(), "the report remains readable");
    assert.ok(h.db.getSession("s1")!.reviewRuns!.updatedAt > pendingSummary.updatedAt, "the published session invalidates the pending panel");
    h.svc.retryDuePrompts();
    assert.equal(continuationCommands(h).size, 1);
  } finally { h.db.close(); }
});

test("a failed review is reported to its requester; one it cancelled is not", () => {
  const h = harness();
  try {
    h.db.updateSessionStatus("s1", "idle", 10);
    const failed = requested(h);
    h.svc.onReviewSessionUpdate("r", { type: "review_session_update", sessionId: failed.reviewSessionId, state: "failed",
      reason: "the reviewer timed out", round: ROUND,
      verdict: { valid: false, consumed: false, effectiveVote: null, failureClass: "timeout", validationErrors: ["the reviewer timed out"] } } as never);
    const text = immediatePrompts(h)[0]!;
    assert.match(text, /ended with an invalid attempt that does not count as a review: "the reviewer timed out" \(it did not use one of the round's attempts\)\./u);
    // Cancelled by the requester itself: nothing is owed.
    h.db.updateSessionStatus("s1", "idle", 11);
    const cancelled = requested(h);
    h.svc.onReviewSessionUpdate("r", { type: "review_session_update", sessionId: cancelled.reviewSessionId, state: "cancelled",
      reason: "the review was cancelled" });
    h.svc.retryDuePrompts();
    assert.equal(h.db.reviewSessions.view(cancelled.reviewSessionId)!.continuation, null);
    assert.equal(immediatePrompts(h).length, 1);
  } finally { h.db.close(); }
});

test("a requester that ends for good is owed no continuation", () => {
  const h = harness();
  try {
    const view = requested(h);
    h.svc.onReviewSessionUpdate("r", { type: "review_session_update", sessionId: view.reviewSessionId, state: "completed",
      output: report(), round: ROUND, verdict: VALID } as never);
    assert.equal(h.db.hasOpenReviewContinuations("s1"), true);
    assert.equal(h.db.abandonReviewContinuations("s1", 20), 1);
    assert.equal(h.db.reviewSessions.view(view.reviewSessionId)!.continuation, "abandoned");
    h.db.updateSessionStatus("s1", "idle", 21);
    h.svc.retryDuePrompts();
    assert.equal(immediatePrompts(h).length, 0);
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

/** Four valid DOWNVOTE rounds of epoch 1 for s1: its review run's round budget is used. */
function exhaustRounds(h: ReturnType<typeof harness>): void {
  for (let round = 1; round <= 4; round += 1) {
    const view = requested(h);
    h.svc.onReviewSessionUpdate("r", { type: "review_session_update", sessionId: view.reviewSessionId, state: "completed",
      output: report(), round: { ...ROUND, round }, verdict: VALID } as never);
  }
}

test("a standalone session asks a person for more review rounds, bound to its run, and the run grants them", async () => {
  const h = harness();
  try {
    exhaustRounds(h);
    const pr = request().pullRequest;
    assert.deepEqual([h.db.reviewSessions.history("s1", pr).validRounds, h.db.reviewSessions.history("s1", pr).roundBudget], [4, 4]);
    const key = `review_round_extension:${pr.repository}#${pr.number}:epoch-1:rounds-4`;
    const snapshot = {
      category: "review_round_extension" as const, repository: pr.repository, pullRequest: pr.number, epoch: 1,
      headSha: "c".repeat(40), roundsUsed: 4, blockingFindings: 1, extraRounds: 2, reason: "One blocker left; it is a one-line fix.",
    };
    const ask = (overrides: Partial<typeof snapshot> = {}, resourceKey = key, requestId = `ext-${Math.random()}`) =>
      h.svc.createWorkflowDecision("s1", { requestId, resourceKey, resourceSnapshot: { ...snapshot, ...overrides } });
    // It must describe the run exactly as the control plane records it.
    assert.match(ask({ epoch: 2 }).error!, /in epoch 1, not 2/u);
    assert.match(ask({ roundsUsed: 3 }).error!, /used 4 rounds, not 3/u);
    assert.match(ask({ blockingFindings: 0 }).error!, /1 open blocking finding\(s\), not 0/u);
    assert.match(ask({}, "review_round_extension:any").error!, /resourceKey must be/u);
    assert.equal(ask({ extraRounds: 5 }).status, 400);
    assert.match(h.svc.createWorkflowDecision("s2", { requestId: "x", resourceKey: key, resourceSnapshot: snapshot }).error!,
      /no valid review of that pull request/u);
    // With no Orchestrator above it, the session controls its own gate, and a person decides it.
    const created = ask();
    assert.ok(created.ok && created.data, created.error ?? "refused");
    assert.deepEqual([created.data.authority, created.data.controllingSessionId, created.data.status], ["human", "s1", "pending"]);
    const card = h.db.getSession("s1")!.pendingApproval;
    assert.ok(card && JSON.stringify(card).includes(created.data.occurrenceId), "the card waits on the session itself");
    const approved = h.svc.approve("s1", created.data.occurrenceId, "approve");
    assert.ok(approved.ok, approved.error ?? "approval refused");
    // The approved rounds extend this epoch's budget, and the next request consumes the grant so a
    // restart cannot revoke it.
    assert.equal(h.db.reviewSessions.history("s1", pr).roundBudget, 6);
    const consumed = await h.svc.consumeWorkflowDecision("s1", created.data.occurrenceId, { resourceSnapshot: snapshot });
    assert.ok(consumed.ok, consumed.error ?? "standalone consumption refused");
    assert.equal(consumed.data?.status, "consumed");
    const next = h.svc.requestReviewSession("s1", request({ headSha: "c".repeat(40) }));
    assert.ok(next.ok, next.error ?? "refused");
    assert.equal(h.starts().at(-1)!.spec.review?.history?.roundBudget, 6);
    assert.equal(h.db.workflowDecisionByOccurrence(created.data.occurrenceId)?.status, "consumed");
    assert.equal(h.db.reviewSessions.history("s1", pr).roundBudget, 6, "a consumed grant still counts");
  } finally { h.db.close(); }
});

test("a run with rounds left, or an upvote, is not extended", () => {
  const h = harness();
  try {
    const pr = request().pullRequest;
    const first = requested(h);
    h.svc.onReviewSessionUpdate("r", { type: "review_session_update", sessionId: first.reviewSessionId, state: "completed",
      output: report(), round: ROUND, verdict: VALID } as never);
    const snapshot = {
      category: "review_round_extension" as const, repository: pr.repository, pullRequest: pr.number, epoch: 1,
      headSha: "c".repeat(40), roundsUsed: 1, blockingFindings: 1, extraRounds: 1, reason: "More rounds.",
    };
    assert.match(h.svc.createWorkflowDecision("s1", { requestId: "a", resourceKey: "k", resourceSnapshot: snapshot }).error!,
      /used 1 of its 4 rounds; request a review instead/u);
  } finally { h.db.close(); }
});

test("a campaign member's review reserves allowance and settles actual usage without child authority", () => {
  for (const driver of ["claude-code", "codex-app-server"] as const) {
    const h = harness({ campaign: true, driver });
    try {
      h.enableCampaign();
      const before = h.db.campaignBudgets.view("root")!;
      const view = requested(h);
      const id = view.reviewSessionId;
      const start = h.starts()[0]!;
      const allocation = h.db.campaignBudgets.allocation(id)!;
      assert.equal(h.db.campaignBudgets.root(id), "root");
      assert.deepEqual(start.spec.campaignBudgetDispatch, h.db.campaignBudgets.dispatch(id));
      assert.equal(start.spec.config?.costBudgetUsd, allocation.costUsd);
      assert.equal(start.spec.config?.maxToolCalls, allocation.toolCalls);
      assert.equal(allocation.costUsd, 40, "uses free campaign capacity, not the requester's reserved allocation");
      assert.equal(h.db.campaignBudgets.view("root")!.outstanding.costUsd, before.outstanding.costUsd + 40);
      assert.equal(h.db.campaignBudgets.view("root")!.occupied, before.occupied);
      assert.equal(h.db.getSession(id)!.parentSessionId, "s1", "display parentage grants no descendant authority");
      assert.equal(h.db.getSession("s1")!.liveChildCapacity?.occupied, 0);
      h.db.addSessionUsage(id, { costUsd: 3 }, 7);
      h.db.appendEvent(id, { kind: "tool_call", toolCallId: "read", title: "Read", status: "completed" }, 8);
      assert.equal(h.db.campaignBudgets.view("root")!.actual.costUsd, 3);
      assert.equal(h.db.campaignBudgets.view("root")!.actual.toolCalls, 1);
      h.svc.onReviewSessionUpdate("r", { type: "review_session_update", sessionId: id, state: "failed", reason: "invalid report" });
      h.svc.onSessionStatus(id, "stopped");
      assert.equal(h.db.campaignBudgets.active(id), true, "an outcome or terminal status alone cannot refund reservations");
      const checkpoint = { generation: start.spec.campaignBudgetDispatch!.generation, historyEpoch: 0, throughSeq: 1, costUsd: 3 };
      h.db.campaignBudgets.recordCheckpoint(id, checkpoint);
      assert.equal(h.db.campaignBudgets.settleCheckpoint(id, { historyEpoch: 0, hydratedSeq: 0 }), false);
      assert.ok(h.db.campaignBudgets.settleCheckpoint(id, { historyEpoch: 0, hydratedSeq: 1 }));
      const settled = h.db.campaignBudgets.view("root")!;
      assert.equal(settled.actual.costUsd, 3, "invalid attempts still cost allowance");
      assert.equal(settled.outstanding.costUsd, before.outstanding.costUsd);
      assert.equal(settled.occupied, before.occupied);
      assert.ok(h.svc.requestReviewSession("s1", request()).ok, "another attempt gets a new reservation");
      assert.equal(h.db.campaignBudgets.view("root")!.actual.costUsd, 3, "retries never erase previous spend");
    } finally { h.db.close(); }
  }
});

test("an authenticated prelaunch review checkpoint returns the reservation without refunding earlier spend", async () => {
  const h = harness({ campaign: true });
  try {
    h.enableCampaign();
    h.db.addSessionUsage("s1", { costUsd: 2 }, 5);
    const before = h.db.campaignBudgets.view("root")!;
    const review = requested(h);
    const id = review.reviewSessionId;
    const checkpoint = { generation: h.starts()[0]!.spec.campaignBudgetDispatch!.generation, historyEpoch: 0, throughSeq: 0, costUsd: 0 };
    h.svc.onReviewSessionUpdate("r", { type: "review_session_update", sessionId: id, state: "failed", reason: "the review snapshot could not be prepared" });
    h.db.reconcileRunnerHistory(id, 0, 0);
    h.svc.onSessionStatus(id, "failed", undefined, undefined, "other-runner", undefined, undefined, checkpoint);
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(h.db.campaignBudgets.active(id), true, "only the owning runner can attest zero spend");
    h.svc.onSessionStatus(id, "failed", undefined, undefined, "r", undefined, undefined, checkpoint);
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(h.db.campaignBudgets.active(id), false);
    const after = h.db.campaignBudgets.view("root")!;
    assert.deepEqual(after.actual, before.actual);
    assert.deepEqual(after.outstanding, before.outstanding);
    assert.equal(after.occupied, before.occupied);
    h.svc.recoverCampaignBudgetAllocations("r");
    assert.equal(h.db.campaignBudgets.active(id), false, "recovery cannot mint a new reservation for a finished review");
    assert.ok(h.svc.requestReviewSession("s1", request()).ok);
  } finally { h.db.close(); }
});

test("campaign review ceilings preserve the requester's original human budget across attempts", () => {
  const h = harness({ campaign: true });
  try {
    h.db.updateSessionCostBudget("s1", 8, 4);
    h.enableCampaign();
    h.db.addSessionUsage("s1", { costUsd: 3 }, 5);
    const first = requested(h);
    assert.equal(h.starts()[0]!.spec.config?.costBudgetUsd, 5);
    h.db.addSessionUsage(first.reviewSessionId, { costUsd: 4 }, 6);
    h.svc.onReviewSessionUpdate("r", { type: "review_session_update", sessionId: first.reviewSessionId, state: "failed" });
    assert.ok(h.svc.requestReviewSession("s1", request()).ok);
    assert.equal(h.starts()[1]!.spec.config?.costBudgetUsd, 1, "prior attempts still spend the original ceiling");
    const second = h.starts()[1]!.spec.sessionId;
    h.db.addSessionUsage(second, { costUsd: 1 }, 7);
    h.svc.onReviewSessionUpdate("r", { type: "review_session_update", sessionId: second, state: "failed" });
    assert.match(h.svc.requestReviewSession("s1", request()).error!, /no cost budget left/);
  } finally { h.db.close(); }
});

test("campaign reviews without cost or tool ceilings still record actual spend", () => {
  const h = harness({ campaign: true });
  try {
    h.enableCampaign({ costUsd: undefined, toolCalls: undefined });
    const review = requested(h);
    assert.equal(h.starts()[0]!.spec.config?.costBudgetUsd, undefined);
    assert.equal(h.starts()[0]!.spec.config?.maxToolCalls, undefined);
    h.db.addSessionUsage(review.reviewSessionId, { costUsd: 7 }, 7);
    assert.equal(h.db.campaignBudgets.view("root")!.actual.costUsd, 7);
  } finally { h.db.close(); }
});

test("campaign reviews refuse exhausted, stopped and fully reserved allowances before launch", () => {
  for (const scenario of ["exhausted", "stopped", "reserved"] as const) {
    const h = harness({ campaign: true });
    try {
      h.enableCampaign();
      if (scenario === "exhausted") h.db.addSessionUsage("root", { costUsd: 140 }, 7);
      if (scenario === "stopped") h.db.campaignBudgets.stop("root", "revoked", "Human stopped the campaign allowance.");
      if (scenario === "reserved") h.db.campaignBudgets.admit("root", { sessionId: "reserved", costUsd: 80, toolCalls: 80 }, {});
      const members = h.db.campaignBudgets.members("root");
      const result = h.svc.requestReviewSession("s1", request());
      assert.equal(result.status, 409, scenario);
      assert.match(result.error!, /allowance/, scenario);
      assert.equal(h.starts().length, 0, scenario);
      assert.deepEqual(h.db.campaignBudgets.members("root"), members, "refusal creates no reservation");
      assert.equal(h.db.reviewSessions.activeFor("s1"), null);
    } finally { h.db.close(); }
  }
});

test("review admission and spending remain available with every campaign worker slot occupied", () => {
  const h = harness({ campaign: true });
  try {
    h.enableCampaign({ concurrency: 2, costUsd: undefined, toolCalls: undefined });
    h.db.updateSessionMaxChildSessions("s1", 0, 4);
    const before = h.db.campaignBudgets.view("root")!;
    assert.equal(before.occupied, 2);
    const { reviewSessionId: id } = requested(h);
    assert.equal(h.db.campaignBudgets.view("root")!.occupied, before.occupied);
    assert.equal(h.db.getSession("s1")!.liveChildCapacity!.occupied, 0);
    h.db.addSessionUsage(id, { costUsd: 1 }, 5);
    assert.equal(h.db.campaignBudgets.view("root")!.actual.costUsd, 1);
    const second = requested(h, "s2");
    assert.equal(h.db.campaignBudgets.view("root")!.occupied, 2);
    assert.equal(h.db.getSession(second.reviewSessionId)!.campaignMembership, undefined);
  } finally { h.db.close(); }
});

test("a refused requester archive leaves its reviewer active", () => {
  const h = harness();
  try {
    const { reviewSessionId: id } = requested(h);
    h.svc.dedicatedMediaReviewerOpen = sessionId => sessionId === "s1";
    assert.equal(h.svc.setArchived("s1", true).status, 409);
    assert.equal(h.db.reviewSessions.view(id)!.cancelRequested, false);
    assert.equal(h.db.getSession(id)!.archived, false);
    assert.equal(h.db.hasSessionStopIntent(id), false);
  } finally { h.db.close(); }
});

test("campaign reviews require accounting-aware runners and priced models, while non-campaign reviews keep older support", () => {
  const old = harness({ campaign: true, protocol: 231 });
  try {
    old.enableCampaign();
    assert.match(old.svc.requestReviewSession("s1", request()).error!, /review sessions charged to the campaign allowance/);
    assert.equal(old.starts().length, 0);
  } finally { old.db.close(); }
  const unpriced = harness({ campaign: true });
  try {
    unpriced.enableCampaign();
    unpriced.db.setUsageRateTable(new Map([["claude-opus-5-5", { inputCostPerToken: 0.000001, outputCostPerToken: 0.000001,
      cacheReadCostPerToken: 0.000001, cacheCreationCostPerToken: 0.000001 }]]));
    assert.match(unpriced.svc.requestReviewSession("s1", request()).error!, /unavailable or unpriced/);
    assert.equal(unpriced.db.campaignBudgets.members("root").length, 3);
    assert.equal(unpriced.starts().length, 0);
  } finally { unpriced.db.close(); }
  const ordinary = harness({ protocol: 231 });
  try {
    const view = requested(ordinary);
    assert.equal(ordinary.starts()[0]!.spec.campaignBudgetDispatch, undefined);
    assert.equal(ordinary.db.campaignBudgets.root(view.reviewSessionId), null);
  } finally { ordinary.db.close(); }
});

test("the legacy bridge still refuses campaign allowance members", () => {
  const h = harness({ campaign: true });
  try {
    h.enableCampaign();
    const result = h.svc.requestSessionReviewJob("s1", request());
    assert.match(result.error!, /part of a campaign with an allowance/);
    assert.equal(h.starts().length, 0);
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


for (const preconsume of [false, true]) test(`an extension cannot activate for an unapproved head (preconsumed=${preconsume})`, async () => {
  const h = harness();
  try {
    exhaustRounds(h);
    const pr = request().pullRequest;
    const approvedHead = "c".repeat(40);
    const changedHead = "d".repeat(40);
    const key = `review_round_extension:${pr.repository}#${pr.number}:epoch-1:rounds-4`;
    const snapshot = { category: "review_round_extension" as const, repository: pr.repository, pullRequest: pr.number,
      epoch: 1, headSha: approvedHead, roundsUsed: 4, blockingFindings: 1, extraRounds: 2, reason: "Fix the remaining blocker." };
    const created = h.svc.createWorkflowDecision("s1", { requestId: "head-bound", resourceKey: key, resourceSnapshot: snapshot });
    assert.ok(created.ok && created.data, created.error ?? "request refused");
    assert.ok(h.svc.approve("s1", created.data.occurrenceId, "approve").ok);
    if (preconsume) {
      const consumed = await h.svc.consumeWorkflowDecision("s1", created.data.occurrenceId, { resourceSnapshot: snapshot });
      assert.ok(consumed.ok, consumed.error ?? "request refused");
    }
    const changed = h.svc.requestReviewSession("s1", request({ headSha: changedHead }));
    assert.ok(changed.ok && changed.data, changed.error ?? "request refused");
    assert.equal(h.starts().at(-1)!.spec.review?.history?.roundBudget, 4, "B receives no budget approved for A");
    assert.equal(h.db.workflowDecisionByOccurrence(created.data.occurrenceId)?.status, preconsume ? "consumed" : "approved",
      "a mismatched request does not consume or activate the grant");
    h.svc.onReviewSessionUpdate("r", { type: "review_session_update", sessionId: changed.data.reviewSessionId,
      state: "failed", reason: "the epoch reached its round limit" });
    // A new exact decision can replace the unused grant even when it was explicitly consumed.
    const replacement = h.svc.createWorkflowDecision("s1", { requestId: "new-head", resourceKey: key,
      resourceSnapshot: { ...snapshot, headSha: changedHead } });
    assert.ok(replacement.ok && replacement.data, replacement.error ?? "request refused");
    assert.ok(h.svc.approve("s1", replacement.data.occurrenceId, "approve").ok);
    const next = h.svc.requestReviewSession("s1", request({ headSha: changedHead }));
    assert.ok(next.ok && next.data, next.error ?? "request refused");
    assert.equal(h.starts().at(-1)!.spec.review?.history?.roundBudget, 6);
    assert.equal(h.db.workflowDecisionByOccurrence(replacement.data.occurrenceId)?.status, "consumed");
    // Once the exact approved head starts its planned round, the remaining rounds belong to the epoch.
    h.svc.onReviewSessionUpdate("r", { type: "review_session_update", sessionId: next.data.reviewSessionId,
      state: "completed", output: report(changedHead), round: { ...ROUND, round: 5 }, verdict: VALID } as never);
    const later = h.svc.requestReviewSession("s1", request({ headSha: "e".repeat(40) }));
    assert.ok(later.ok, later.error ?? "request refused");
    assert.equal(h.starts().at(-1)!.spec.review?.history?.roundBudget, 6, "an activated grant retains the remaining epoch budget");
    assert.equal(h.db.reviewSessions.history("s1", pr, approvedHead).roundBudget, 6,
      "returning to the old head never reactivates a consumed grant replaced by the newer occurrence");
  } finally { h.db.close(); }
});

test("every continuation transition invalidates the review summary, including same-millisecond changes", () => {
  const h = harness();
  try {
    const view = requested(h);
    h.svc.onReviewSessionUpdate("r", { type: "review_session_update", sessionId: view.reviewSessionId,
      state: "completed", output: report(), round: ROUND, verdict: VALID } as never);
    const completed = h.db.reviewSessions.summaryFor("s1")!;
    // Another review can have the newest timestamp when an older receipt finally arrives.
    h.db.reviewSessions.record({ reviewSessionId: "newer", requesterSessionId: "s1", runnerId: "r", pullRequest: request().pullRequest,
      headSha: HEAD, reviewer: "codex" }, completed.updatedAt + 10);
    let before = h.db.reviewSessions.summaryFor("s1")!;
    const transition = (change: (now: number) => void) => {
      change(before.updatedAt); // A receipt can arrive in the same millisecond as the outcome.
      const after = h.db.reviewSessions.summaryFor("s1")!;
      assert.ok(after.updatedAt > before.updatedAt, "each continuation mutation changes the panel's refresh key");
      before = after;
    };
    transition(now => { assert.ok(h.db.claimHeldReviewContinuations("s1", [view.reviewSessionId], now)); });
    transition(now => h.db.releaseReviewContinuationClaim("s1", [view.reviewSessionId], now));
    transition(now => {
      h.db.raw().prepare("UPDATE review_sessions SET continuation_state='delivering', continuation_command_id='receipt' WHERE review_session_id=?")
        .run(view.reviewSessionId);
      assert.equal(h.db.setReviewContinuationCommandState("receipt", "delivered", now), 1);
    });
    transition(now => {
      h.db.raw().prepare("UPDATE review_sessions SET continuation_state='held' WHERE review_session_id=?").run(view.reviewSessionId);
      assert.equal(h.db.abandonReviewContinuations("s1", now), 1);
    });
  } finally { h.db.close(); }
});

/** The final round upvotes HEAD after three blocking rounds. */
function exhaustWithUpvote(h: ReturnType<typeof harness>): void {
  for (let round = 1; round <= 4; round += 1) {
    const view = requested(h);
    h.svc.onReviewSessionUpdate("r", { type: "review_session_update", sessionId: view.reviewSessionId, state: "completed",
      output: report(HEAD, round === 4 ? { vote: "UPVOTE", findings: [] } : {}), round: { ...ROUND, round }, verdict: VALID } as never);
  }
}
const postUpvoteSnapshot = () => ({ category: "review_round_extension" as const, repository: request().pullRequest.repository,
  pullRequest: request().pullRequest.number, epoch: 1, headSha: "c".repeat(40), upvotedHeadSha: HEAD,
  roundsUsed: 4, blockingFindings: 0, extraRounds: 1, reason: "Review a verified fix after the upvote." });
const postUpvoteKey = () => `review_round_extension:${request().pullRequest.repository}#${request().pullRequest.number}:epoch-1:rounds-4`;
function askPostUpvote(h: ReturnType<typeof harness>, snapshot = postUpvoteSnapshot(), requestId = "after-upvote") {
  return h.svc.createWorkflowDecision("s1", { requestId, resourceKey: postUpvoteKey(), resourceSnapshot: snapshot });
}

test("an exhausted upvote admits only a changed head bound to that exact upvote", () => {
  const h = harness();
  try {
    exhaustWithUpvote(h);
    const snapshot = postUpvoteSnapshot();
    assert.match(askPostUpvote(h, { ...snapshot, headSha: HEAD }).error!, /last valid review is an upvote; it needs no more rounds/u);
    assert.match(askPostUpvote(h, { ...snapshot, upvotedHeadSha: "d".repeat(40) }).error!, /bind the last valid upvoted head/u);
    assert.match(h.svc.createWorkflowDecision("s1", { requestId: "missing", resourceKey: postUpvoteKey(),
      resourceSnapshot: { ...snapshot, upvotedHeadSha: undefined } }).error!, /bind the last valid upvoted head/u);
    assert.equal(askPostUpvote(h, { ...snapshot, upvotedHeadSha: "bad" }).status, 400);
    assert.match(askPostUpvote(h, { ...snapshot, epoch: 2 }).error!, /in epoch 1/u);
    assert.match(askPostUpvote(h, { ...snapshot, roundsUsed: 3 }).error!, /used 4 rounds/u);
    assert.match(askPostUpvote(h, { ...snapshot, blockingFindings: 1 }).error!, /0 open blocking/u);
    const decision = askPostUpvote(h);
    assert.ok(decision.ok, decision.error ?? "refused");
    assert.equal(decision.data?.authority, "human");
    assert.deepEqual(decision.data?.resourceSnapshot, snapshot);
  } finally { h.db.close(); }
});

for (const preconsume of [false, true]) test(`a post-upvote extension admits a delta and accounts for its round and cost (preconsume=${preconsume})`, async () => {
  const h = harness();
  try {
    exhaustWithUpvote(h);
    const snapshot = postUpvoteSnapshot();
    const decision = askPostUpvote(h);
    assert.ok(decision.ok && decision.data, decision.error ?? "refused");
    assert.ok(h.svc.approve("s1", decision.data.occurrenceId, "approve").ok);
    if (preconsume) assert.ok((await h.svc.consumeWorkflowDecision("s1", decision.data.occurrenceId, { resourceSnapshot: snapshot })).ok);
    const wrong = h.svc.requestReviewSession("s1", request({ headSha: "d".repeat(40) }));
    assert.ok(wrong.data);
    assert.equal(h.starts().at(-1)!.spec.review!.history!.roundBudget, 4);
    h.svc.onReviewSessionUpdate("r", { type: "review_session_update", sessionId: wrong.data.reviewSessionId, state: "failed" });
    const next = h.svc.requestReviewSession("s1", request({ headSha: snapshot.headSha, fullReason: "Review everything" }));
    assert.ok(next.ok && next.data, next.error ?? "refused");
    const history = h.starts().at(-1)!.spec.review!.history!;
    assert.equal(history.roundBudget, 5);
    const plan = planReviewRound(history, { headSha: snapshot.headSha, fullReason: "Review everything" }, true);
    assert.deepEqual(plan, { epoch: 1, round: 5, attempt: 1, mode: "delta", since: HEAD, openFindings: [] });
    assert.equal(h.db.workflowDecisionByOccurrence(decision.data.occurrenceId)?.status, "consumed");
    assert.equal((await h.svc.consumeWorkflowDecision("s1", decision.data.occurrenceId, { resourceSnapshot: snapshot })).status, 409);
    h.db.addSessionUsage(next.data.reviewSessionId, { costUsd: 2.75 }, 7);
    h.svc.onReviewSessionUpdate("r", { type: "review_session_update", sessionId: next.data.reviewSessionId, state: "completed",
      output: report(snapshot.headSha, { vote: "UPVOTE", findings: [] }),
      round: { ...ROUND, round: 5, mode: "delta", since: HEAD }, verdict: VALID } as never);
    const after = h.db.reviewSessions.history("s1", request().pullRequest, snapshot.headSha);
    assert.equal(after.validRounds, 5);
    assert.equal(after.lastValid?.headSha, snapshot.headSha);
    assert.equal(after.lastValid?.vote, "UPVOTE");
    assert.equal(h.db.reviewSessions.spentFor("s1"), 2.75);
  } finally { h.db.close(); }
});

test("post-upvote grants fail closed after supersession, epoch change, or runner downgrade", async () => {
  const h = harness();
  try {
    exhaustWithUpvote(h);
    const old = askPostUpvote(h);
    assert.ok(old.data);
    assert.ok(h.svc.approve("s1", old.data.occurrenceId, "approve").ok);
    const replacement = askPostUpvote(h, { ...postUpvoteSnapshot(), headSha: "d".repeat(40) }, "replacement");
    assert.ok(replacement.data, replacement.error ?? "refused");
    assert.equal((await h.svc.consumeWorkflowDecision("s1", old.data.occurrenceId, { resourceSnapshot: postUpvoteSnapshot() })).status, 409);
    assert.ok(h.svc.approve("s1", replacement.data.occurrenceId, "approve").ok);
    h.db.registerRunner(h.metadata, 2, 236);
    assert.equal(h.svc.requestReviewSession("s1", request({ headSha: "d".repeat(40) })).status, 409);
    assert.equal((await h.svc.consumeWorkflowDecision("s1", replacement.data.occurrenceId, { resourceSnapshot: replacement.data.resourceSnapshot })).status, 409);
    assert.match(askPostUpvote(h, postUpvoteSnapshot(), "old-peer").error!, /compatible runner/u);
    h.db.registerRunner(h.metadata, 3, PROTOCOL_VERSION);
    const current = askPostUpvote(h, postUpvoteSnapshot(), "new-epoch");
    assert.ok(current.data, current.error ?? "refused");
    assert.ok(h.svc.approve("s1", current.data.occurrenceId, "approve").ok);
    const rewrite = h.svc.requestReviewSession("s1", request({ headSha: "e".repeat(40) }));
    assert.ok(rewrite.data);
    h.svc.onReviewSessionUpdate("r", { type: "review_session_update", sessionId: rewrite.data.reviewSessionId, state: "completed",
      output: report("e".repeat(40)), round: { ...ROUND, epoch: 2 }, verdict: VALID } as never);
    assert.equal((await h.svc.consumeWorkflowDecision("s1", current.data.occurrenceId, { resourceSnapshot: postUpvoteSnapshot() })).status, 409);
    assert.equal(h.db.reviewSessions.history("s1", request().pullRequest).roundBudget, 4);
  } finally { h.db.close(); }
});

test("a pending post-upvote extension cannot be approved after a newer epoch", () => {
  const h = harness();
  try {
    exhaustWithUpvote(h);
    const pending = askPostUpvote(h);
    assert.ok(pending.data);
    const rewrite = requested(h);
    h.svc.onReviewSessionUpdate("r", { type: "review_session_update", sessionId: rewrite.reviewSessionId, state: "completed",
      output: report(), round: { ...ROUND, epoch: 2 }, verdict: VALID } as never);
    assert.equal(h.svc.approve("s1", pending.data.occurrenceId, "approve").status, 409);
    assert.equal(h.db.workflowDecisionByOccurrence(pending.data.occurrenceId)?.status, "revoked");
  } finally { h.db.close(); }
});

test("a merge decision cannot reuse the upvote for the preceding head", () => {
  const h = harness({ campaign: true });
  try {
    exhaustWithUpvote(h);
    const headSha = "c".repeat(40);
    const merge = () => h.svc.createWorkflowDecision("s1", { requestId: "merge", resourceKey: "merge",
      resourceSnapshot: { category: "pr_merge", repository: request().pullRequest.repository, pullRequest: request().pullRequest.number,
        headSha, reviewResult: "merge", requiredChecks: { headSha, status: "passed", checkedAt: 10,
          checks: [{ name: "required", state: "passed" }] } } });
    assert.match(merge().error!, /current pull request head needs a valid review/u);
    const next = h.svc.requestReviewSession("s1", request({ headSha }));
    assert.ok(next.data);
    h.svc.onReviewSessionUpdate("r", { type: "review_session_update", sessionId: next.data.reviewSessionId, state: "completed",
      output: report(headSha, { vote: "UPVOTE", findings: [] }), round: { ...ROUND, round: 5 }, verdict: VALID } as never);
    assert.ok(merge().ok);
  } finally { h.db.close(); }
});


test("a post-upvote round uses ordinary campaign admission, reservation and actual usage", () => {
  const h = harness({ campaign: true });
  try {
    exhaustWithUpvote(h);
    h.enableCampaign();
    const decision = askPostUpvote(h);
    assert.ok(decision.data, decision.error ?? "refused");
    assert.equal(decision.data.authority, "human");
    assert.ok(h.svc.approve("s1", decision.data.occurrenceId, "approve").ok);
    const before = h.db.campaignBudgets.view("root")!;
    const next = h.svc.requestReviewSession("s1", request({ headSha: postUpvoteSnapshot().headSha }));
    assert.ok(next.data, next.error ?? "refused");
    const allocation = h.db.campaignBudgets.allocation(next.data.reviewSessionId)!;
    assert.ok(typeof allocation.costUsd === "number" && allocation.costUsd > 0);
    assert.equal(h.db.campaignBudgets.view("root")!.outstanding.costUsd, before.outstanding.costUsd + allocation.costUsd);
    h.db.addSessionUsage(next.data.reviewSessionId, { costUsd: 3.25 }, 8);
    assert.equal(h.db.campaignBudgets.view("root")!.actual.costUsd, 3.25);
    assert.equal(h.db.reviewSessions.spentFor("s1"), 3.25);
    assert.equal(h.starts().at(-1)!.spec.review!.history!.roundBudget, 5);
  } finally { h.db.close(); }
});

test("a merge decision matches review repository names without case", () => {
  const h = harness({ campaign: true });
  try {
    exhaustWithUpvote(h);
    const headSha = "c".repeat(40);
    const merge = h.svc.createWorkflowDecision("s1", { requestId: "mixed-case-merge", resourceKey: "merge",
      resourceSnapshot: { category: "pr_merge", repository: request().pullRequest.repository.toUpperCase(),
        pullRequest: request().pullRequest.number, headSha, reviewResult: "merge",
        requiredChecks: { headSha, status: "passed", checkedAt: 10, checks: [{ name: "required", state: "passed" }] } } });
    assert.equal(merge.status, 409);
    assert.match(merge.error!, /current pull request head needs a valid review/u);
  } finally { h.db.close(); }
});

test("consuming a merge decision rechecks the review run's head and revokes a stale grant", async () => {
  const h = harness({ campaign: true });
  try {
    exhaustWithUpvote(h);
    const snapshot = { category: "pr_merge" as const, repository: request().pullRequest.repository,
      pullRequest: request().pullRequest.number, headSha: HEAD, reviewResult: "merge" as const,
      requiredChecks: { headSha: HEAD, status: "passed" as const, checkedAt: 10,
        checks: [{ name: "required", state: "passed" as const }] } };
    const merge = h.svc.createWorkflowDecision("s1", { requestId: "stale-merge", resourceKey: "merge", resourceSnapshot: snapshot });
    assert.ok(merge.data, merge.error ?? "refused");
    assert.ok(h.svc.approve("s1", merge.data.occurrenceId, "approve").ok);
    const next = h.svc.requestReviewSession("s1", request({ headSha: "c".repeat(40) }));
    assert.ok(next.data, next.error ?? "refused");
    h.svc.onReviewSessionUpdate("r", { type: "review_session_update", sessionId: next.data.reviewSessionId, state: "completed",
      output: report("c".repeat(40), { vote: "UPVOTE", findings: [] }), round: { ...ROUND, round: 5 }, verdict: VALID } as never);
    const consumed = await h.svc.consumeWorkflowDecision("s1", merge.data.occurrenceId, { resourceSnapshot: snapshot });
    assert.equal(consumed.status, 409);
    assert.match(consumed.error!, /current pull request head needs a valid review/u);
    assert.equal(h.db.workflowDecisionByOccurrence(merge.data.occurrenceId)?.status, "revoked");
  } finally { h.db.close(); }
});
