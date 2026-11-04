import assert from "node:assert/strict";
import { test } from "node:test";
import { DEFAULT_ORCHESTRATOR_DEFAULTS, HUMAN_ONLY_PARENT_CONTROL_POLICY, PROTOCOL_VERSION, RUNNER_CAPABILITY_MIN_PROTOCOL,
  type CampaignForgePullRequestObservation, type CampaignPullRequestRef, type ControlPlaneToRunner,
  type RunnerMetadata, type RunnerToControlPlane } from "@wollipog/protocol";
import { ControlPlaneDb } from "./db.js";
import { Hub } from "./hub.js";
import { SessionsService } from "./sessions.js";
import { resolveOrchestratorCampaignPolicy } from "./orchestrator-settings.js";
import { projectCampaignHandoffsForUi } from "./campaign-status-compatibility.js";
import type { ForgeReadResult } from "./campaign-forge-observations.js";

/** A Full Control campaign over picoduck/wollipog#4070 with two children and two original items.
 * The real control plane, ledger and services; synthetic forge facts and runner answers only. */
function fixture(completion: "retain" | "stop_and_archive" = "retain") {
  const db = ControlPlaneDb.open(":memory:");
  const identity = db.localIdentityContext();
  const metadata: RunnerMetadata = { runnerId: "r", hostname: "test", os: "linux", version: "test",
    workspaces: [{ id: "w", name: "Repo", path: "/repos/test" }], agents: [{ id: "agent", name: "Agent",
      command: "codex", args: [], env: {}, driver: "codex-app-server", available: true }] };
  db.registerRunner(metadata, 1, PROTOCOL_VERSION);
  const policy = resolveOrchestratorCampaignPolicy(DEFAULT_ORCHESTRATOR_DEFAULTS, "system_default");
  policy.behavior.completion = completion;
  policy.issueScope = { repository: "picoduck/wollipog", issueNumbers: [4070], revision: 1,
    authorizedByUserId: identity.userId, authorizedAt: 1 };
  policy.issueNumbers = [4070];
  for (const id of ["root", "child", "other"]) {
    db.createSession({ id, runnerId: "r", workspaceId: "w", agentId: "agent", title: id,
      useWorktree: false, driver: "codex-app-server", config: { model: "gpt-6.1-sol" }, now: 1,
      scope: { organizationId: identity.organizationId, owner: { kind: "user", userId: identity.userId } },
      ...(id !== "root" ? { parentSessionId: "root" } : { role: "orchestrator", orchestratorPolicy: policy,
        parentControlPolicy: { decisions: { ...HUMAN_ONLY_PARENT_CONTROL_POLICY } } }) });
    db.updateSessionStatus(id, "running", 2);
  }
  const hub = new Hub(db);
  hub.isRunnerOnline = () => true;
  hub.sessionChangedById = () => {};
  hub.sendToRunner = () => true;
  const svc = new SessionsService(db, hub, { info() {}, warn() {}, error() {} });
  const enabled = svc.setCampaignControl("root", { mode: "full_control", objective: "Implement #4070",
    operations: ["implementation_question", "question", "tool_approval"], delegatablePolicyIds: [] }, 1,
  { ...identity, kind: "human", actorId: identity.userId });
  assert.ok(enabled.ok, enabled.error ?? "admission failed");
  // History is already local in these fixtures; nothing needs fetching from a runner.
  svc.hydrateHistory = async () => {};
  const plan = svc.recordCampaignPlan("root", { planComplete: true, items: [
    { key: "original:4070:delivery", title: "Record Delivery", issue: { repository: "picoduck/wollipog", number: 4070 } },
    { key: "original:4070:advisory", title: "File the Advisory", issue: { repository: "picoduck/wollipog", number: 4070 } },
  ] });
  assert.ok(plan.ok, plan.error ?? "plan refused");
  const [delivery, advisory] = plan.data!.items.map((item) => item.workItemId) as [string, string];
  const report = (id: string, text = "Done.") => db.appendEvent(id, { kind: "agent_message", text, final: true }, Date.now()).seq;
  return { db, hub, svc, delivery, advisory, report };
}

type Fixture = ReturnType<typeof fixture>;

/** Both children report and are verified; `child` delivers `delivery` through its open attempt. */
function finishChildren(h: Fixture, completion: "retain" | "stop_and_archive" = "retain") {
  assert.ok(h.svc.assignCampaignWorkItem("root", { workItemId: h.delivery, childSessionId: "child" }).ok);
  for (const id of ["child", "other"]) {
    h.db.updateSessionStatus(id, completion === "retain" ? "idle" : "completed", Date.now());
    const verified = h.svc.verifyCampaignChild("root", { childSessionId: id, reportEventSeq: h.report(id), followUpsAccounted: true,
      ...(id === "child" ? { workItem: { id: h.delivery, outcome: "delivered" as const } } : {}) });
    assert.ok(verified.ok, verified.error ?? "verification refused");
  }
  h.db.updateSessionStatus("root", "idle", Date.now());
}

const handOff = (h: Fixture, workItemId: string, responsibleActor: "human" | "external" | "orchestrator" | "child") =>
  h.svc.updateCampaignWorkItem("root", { workItemId, handoff: { responsibleActor,
    reason: "Private vulnerability reporting refused the agent's account.",
    nextAction: "File the advisory from a maintainer account." } });

test("a campaign whose only unfinished work is handed to a person completes with handoffs (#4070)", () => {
  const h = fixture();
  try {
    finishChildren(h);
    assert.equal(h.db.campaignProjection("root")!.status, "blocked", "an unhanded original item still holds the campaign");
    assert.equal(h.db.campaignProjection("root")!.handoffs, undefined);

    for (const actor of ["orchestrator", "child"] as const) {
      assert.ok(handOff(h, h.advisory, actor).ok);
      assert.equal(h.db.campaignProjection("root")!.status, "blocked", `a handoff to ${actor} is still agent work`);
    }

    assert.ok(handOff(h, h.advisory, "human").ok);
    const projection = h.db.campaignProjection("root")!;
    assert.equal(projection.status, "complete_with_handoffs");
    assert.equal(h.db.campaignStatusOnly("root"), "complete_with_handoffs", "the summary status agrees with the projection");
    assert.equal(projection.handoffs?.total, 1);
    assert.deepEqual(projection.handoffs?.items.map((item) => [item.workItemId, item.title, item.issue?.number,
      item.handoff.responsibleActor, item.handoff.reason, item.handoff.nextAction]), [[h.advisory, "File the Advisory", 4070,
      "human", "Private vulnerability reporting refused the agent's account.", "File the advisory from a maintainer account."]]);
    // The counts a terminal campaign reports: everything else delivered, nothing outstanding.
    assert.deepEqual(projection.work?.counts.byState, { planned: 1, queued: 0, running: 0, waiting: 0, blocked: 0,
      delivered: 1, cancelled: 0, removed: 0 });
    assert.deepEqual(projection.work?.obligations, { verification: 0, adjudication: 0, publication: 0, cleanup: 0 });
    assert.deepEqual([projection.children.active, projection.children.blocked, projection.children.verified], [0, 0, 2]);
    // Terminal: no continuation, Campaign Elapsed ends, and recovery reads as resolved without a warning.
    assert.equal(h.db.campaignContinuationAdmission("root").state, "lifecycle_held");
    assert.notEqual(projection.work?.elapsed.endedAt, null);
    assert.equal(projection.recovery?.automation?.reason, undefined);
    assert.equal(projection.recovery?.blocked, 0);
    assert.ok(projection.recovery?.records.every((record) => record.state === "resolved"));
    // The handoff is on the item itself, and the item stays unfinished: nothing was dropped.
    const item = h.db.campaignWorkLedger.detail("root", h.advisory, Date.now())!;
    assert.equal(item.primaryState, "planned");
    assert.equal(item.handoff?.responsibleActor, "human");
    // An outside party is a handoff too.
    assert.ok(handOff(h, h.advisory, "external").ok);
    assert.equal(h.db.campaignProjection("root")!.status, "complete_with_handoffs");
  } finally { h.db.close(); }
});

test("new unhanded work, or an agent taking the item back, reopens a campaign completed with handoffs", () => {
  const h = fixture();
  try {
    finishChildren(h);
    assert.ok(handOff(h, h.advisory, "human").ok);
    assert.equal(h.db.campaignProjection("root")!.status, "complete_with_handoffs");
    assert.equal(h.db.campaignWorkLedger.summary("root", { campaignCreatedAt: 1, complete: true, childSessionIds: [],
      cleanupPending: 0 }).elapsed.endedAt !== null, true);

    const added = h.svc.recordCampaignPlan("root", { planComplete: true, items: [{ key: "follow-up:docs", title: "Docs",
      origin: "follow_up" }] });
    assert.ok(added.ok, added.error ?? "refused");
    const docs = added.data!.items[0]!.workItemId;
    const reopened = h.db.campaignProjection("root")!;
    assert.equal(reopened.status, "blocked", "unhanded follow-up work is agent work");
    assert.equal(reopened.handoffs?.total, 1, "the handed-off item stays listed while the campaign is open");
    assert.equal(reopened.work?.elapsed.endedAt, null, "Campaign Elapsed resumes");
    assert.ok(h.svc.updateCampaignWorkItem("root", { workItemId: docs,
      commitment: { state: "scope_removed", reason: "Folded into the advisory." } }).ok);
    assert.equal(h.db.campaignProjection("root")!.status, "complete_with_handoffs");

    // Assigning the item again clears its handoff: the agent took it back.
    assert.ok(h.svc.assignCampaignWorkItem("root", { workItemId: h.advisory, childSessionId: "other" }).ok);
    assert.equal(h.db.campaignWorkLedger.detail("root", h.advisory, Date.now())!.handoff, null);
    const taken = h.db.campaignProjection("root")!;
    assert.notEqual(taken.status, "complete_with_handoffs");
    assert.equal(taken.handoffs, undefined);
  } finally { h.db.close(); }
});

test("queued, running, or unverified work beside a handoff keeps the campaign out of the terminal state", () => {
  const h = fixture();
  try {
    finishChildren(h);
    assert.ok(handOff(h, h.advisory, "human").ok);
    assert.equal(h.db.campaignProjection("root")!.status, "complete_with_handoffs");

    // Queued, never dispatched.
    const queued = h.svc.recordCampaignPlan("root", { planComplete: true, items: [{ key: "follow-up:queued",
      title: "Queued Follow-Up", origin: "follow_up", dispatchState: "queued" }] });
    assert.ok(queued.ok, queued.error ?? "refused");
    const queuedId = queued.data!.items[0]!.workItemId;
    let projection = h.db.campaignProjection("root")!;
    assert.equal(projection.work?.counts.byState.queued, 1);
    assert.equal(projection.status, "blocked");

    // Assigned to a child that has finished its turn: the Orchestrator owes a verification.
    assert.ok(h.svc.assignCampaignWorkItem("root", { workItemId: queuedId, childSessionId: "other" }).ok);
    projection = h.db.campaignProjection("root")!;
    assert.equal(projection.work?.obligations.verification, 1);
    assert.notEqual(projection.status, "complete_with_handoffs");

    // The child is working on it again.
    h.db.updateSessionStatus("other", "running", Date.now());
    projection = h.db.campaignProjection("root")!;
    assert.equal(projection.work?.counts.byState.running, 1);
    assert.equal(projection.status, "active");
    assert.equal(projection.handoffs?.total, 1, "the owner's item stays listed throughout");
  } finally { h.db.close(); }
});

test("dashboards older than v275 read complete_with_handoffs as waiting for a person, never as active work", () => {
  const h = fixture();
  try {
    finishChildren(h);
    assert.ok(handOff(h, h.advisory, "human").ok);
    const session = h.db.getSession("root")!;
    assert.equal(session.fullControlCampaignStatus, "complete_with_handoffs");
    assert.equal(session.orchestratorCampaign?.status, "complete_with_handoffs");
    const legacy = projectCampaignHandoffsForUi({ type: "session_upsert", session },
      RUNNER_CAPABILITY_MIN_PROTOCOL.campaignHandoffs - 1);
    assert.equal(legacy.session.fullControlCampaignStatus, "waiting_human");
    assert.equal(legacy.session.orchestratorCampaign?.status, "waiting_human");
    assert.equal(session.fullControlCampaignStatus, "complete_with_handoffs", "the projection copies, never mutates");
    const listed = projectCampaignHandoffsForUi({ sessions: [session] }, null);
    assert.equal(listed.sessions[0]!.orchestratorCampaign?.status, "waiting_human");
    const current = { session };
    assert.equal(projectCampaignHandoffsForUi(current, PROTOCOL_VERSION), current);
    const projection = h.db.campaignProjection("root")!;
    assert.equal(projectCampaignHandoffsForUi(projection, 200).status, "waiting_human");
    const identity = h.db.localIdentityContext();
    assert.equal(JSON.parse(h.db.sessionListJsonForPrincipal({ ...identity, kind: "human", actorId: identity.userId }, false, true, false))
      .sessions.find((row: { id: string }) => row.id === "root").fullControlCampaignStatus, "waiting_human");
  } finally { h.db.close(); }
});

/** `child` works on `delivery`, reports, and is reused for `advisory` before anyone verified it. */
function reusedChild() {
  const h = fixture();
  assert.ok(h.svc.assignCampaignWorkItem("root", { workItemId: h.delivery, childSessionId: "child" }).ok);
  h.db.updateSessionStatus("child", "idle", Date.now());
  const draftReport = h.report("child", "Draft ready for review.");
  const firstReport = h.report("child", "Delivered through PR 4088.");
  const reassigned = h.svc.assignCampaignWorkItem("root", { workItemId: h.advisory, childSessionId: "child" });
  assert.ok(reassigned.ok, reassigned.error ?? "refused");
  assert.deepEqual(reassigned.data!.closedAttempts.map((attempt) => [attempt.workItemId, attempt.endReason]),
    [[h.delivery, "reassigned"]]);
  const laterReport = h.report("child", "Advisory drafted.");
  h.db.updateSessionStatus("other", "idle", Date.now());
  for (const id of ["child", "other"]) {
    const verified = h.svc.verifyCampaignChild("root", { childSessionId: id, followUpsAccounted: true,
      reportEventSeq: id === "child" ? laterReport : h.report(id),
      ...(id === "child" ? { workItem: { id: h.advisory, outcome: "delivered" as const } } : {}) });
    assert.ok(verified.ok, verified.error ?? "refused");
  }
  h.db.updateSessionStatus("root", "idle", Date.now());
  return { ...h, draftReport, firstReport, laterReport };
}

test("the Orchestrator records delivery after reuse from the child's exact report inside the reassigned attempt", async () => {
  const h = reusedChild();
  try {
    assert.equal(h.db.campaignWorkLedger.detail("root", h.delivery, Date.now())!.primaryState, "planned");
    assert.equal(h.db.campaignProjection("root")!.status, "blocked", "the reused child's earlier item cannot finish");
    // verify_campaign_child records only the child's open attempt.
    assert.equal(h.svc.verifyCampaignChild("root", { childSessionId: "child", reportEventSeq: h.firstReport,
      followUpsAccounted: true, workItem: { id: h.delivery, outcome: "delivered" } }).status, 409);

    const refuse = async (report: { childSessionId: string; reportEventSeq: number }, pattern: RegExp) => {
      const result = await h.svc.recordCampaignWorkItemDelivery("root", { workItemId: h.delivery, report });
      assert.equal(result.ok, false);
      assert.match(result.error ?? "", pattern);
    };
    await refuse({ childSessionId: "child", reportEventSeq: h.laterReport }, /not inside the child's attempt/u);
    await refuse({ childSessionId: "child", reportEventSeq: h.draftReport }, /last report before its attempt on this work item closed/u);
    await refuse({ childSessionId: "other", reportEventSeq: h.db.durableFinalReportSeq("other")! }, /never had an attempt/u);
    assert.equal(h.db.campaignWorkLedger.detail("root", h.delivery, Date.now())!.deliveries?.length, 0);

    const recorded = await h.svc.recordCampaignWorkItemDelivery("root", { workItemId: h.delivery,
      report: { childSessionId: "child", reportEventSeq: h.firstReport }, note: "Reused before verification." });
    assert.ok(recorded.ok, recorded.error ?? "refused");
    const item = recorded.data!.item;
    assert.equal(item.primaryState, "delivered");
    assert.deepEqual(item.attempts.map((attempt) => attempt.endReason), ["reassigned"], "the attempt history is kept");
    assert.deepEqual(item.verifications.map((verification) => [verification.attemptId, verification.outcome, verification.report.seq]),
      [[item.attempts[0]!.id, "delivered", h.firstReport]]);
    assert.deepEqual(recorded.data!.delivery.report, { childSessionId: "child", attemptId: item.attempts[0]!.id, seq: h.firstReport });
    assert.equal(h.db.campaignProjection("root")!.status, "verified_complete");

    // The same evidence again is a no-op; other evidence for a delivered item is refused.
    const revision = h.db.campaignWorkLedger.revision("root");
    const repeated = await h.svc.recordCampaignWorkItemDelivery("root", { workItemId: h.delivery,
      report: { childSessionId: "child", reportEventSeq: h.firstReport } });
    assert.ok(repeated.ok, repeated.error ?? "refused");
    assert.equal(repeated.data!.delivery.id, recorded.data!.delivery.id);
    assert.equal(h.db.campaignWorkLedger.revision("root"), revision);
    // Last, since a new prompt starts another turn of the child: only a top-level report is evidence.
    const prompt = h.db.appendEvent("child", { kind: "user_message", text: "Status?" }, Date.now()).seq;
    await refuse({ childSessionId: "child", reportEventSeq: prompt }, /not a completed top-level agent response/u);
  } finally { h.db.close(); }
});

const merged = (overrides: Partial<CampaignForgePullRequestObservation> = {}): CampaignForgePullRequestObservation => ({
  state: "merged", draft: false, headSha: "a".repeat(40), baseRef: "main", reviewDecision: "approved",
  checks: { state: "passing", passing: 1, failing: 0, pending: 0 },
  requiredChecks: { state: "passing", passing: 1, failing: 0, pending: 0 },
  mergeQueue: null, mergeCommitSha: "b".repeat(40), defaultBranch: "main", ...overrides,
});

test("delivery from merged pull requests is checked against the forge now, never taken from the claim", async () => {
  const h = reusedChild();
  try {
    const refs = [{ repository: "picoduck/wollipog", number: 4088 }, { repository: "picoduck/wollipog", number: 4099 }];
    assert.ok(h.svc.updateCampaignWorkItem("root", { workItemId: h.delivery, stage: { stage: "merged", pullRequests: refs } }).ok);
    let forge = new Map<number, CampaignForgePullRequestObservation | undefined>();
    const reads: CampaignPullRequestRef[][] = [];
    h.svc.campaignForgeReadNow = async (_campaignId, asked) => {
      reads.push([...asked]);
      return asked.map((ref): ForgeReadResult => forge.get(ref.number)
        ? { ref, observation: forge.get(ref.number)! } : { ref, failure: "forge_not_found" });
    };
    const attempt = async (pullRequests: CampaignPullRequestRef[]) =>
      h.svc.recordCampaignWorkItemDelivery("root", { workItemId: h.delivery, pullRequests });

    // Refused before any forge read: another repository, or a pull request the stage does not name.
    assert.match((await attempt([{ repository: "picoduck/other", number: 4088 }])).error ?? "", /not in the campaign repository/u);
    assert.match((await attempt([{ repository: "picoduck/wollipog", number: 5000 }])).error ?? "", /not named by the work item's reported stage/u);
    assert.equal(reads.length, 0);
    // Refused by what the forge reports now.
    forge = new Map([[4088, merged()], [4099, merged({ state: "open", mergeCommitSha: null })]]);
    assert.match((await attempt(refs)).error ?? "", /4099 is not merged/u);
    forge = new Map([[4088, merged()], [4099, merged({ baseRef: "release" })]]);
    assert.match((await attempt(refs)).error ?? "", /merged into release, not the default branch main/u);
    forge = new Map([[4088, merged()], [4099, merged({ defaultBranch: undefined })]]);
    assert.match((await attempt(refs)).error ?? "", /does not report the repository's default branch/u);
    forge = new Map([[4088, merged()]]);
    assert.match((await attempt(refs)).error ?? "", /could not be read from the forge \(forge_not_found\)/u);
    h.svc.campaignForgeReadNow = async () => null;
    assert.match((await attempt(refs)).error ?? "", /could not read the forge/u);
    assert.equal(h.db.campaignWorkLedger.detail("root", h.delivery, Date.now())!.primaryState, "planned");

    forge = new Map([[4088, merged({ mergeCommitSha: "c".repeat(40) })], [4099, merged()]]);
    h.svc.campaignForgeReadNow = async (_campaignId, asked) => asked.map((ref) => ({ ref, observation: forge.get(ref.number)! }));
    const recorded = await attempt(refs);
    assert.ok(recorded.ok, recorded.error ?? "refused");
    assert.equal(recorded.data!.item.primaryState, "delivered");
    assert.deepEqual(recorded.data!.delivery.pullRequests.map((pr) => [pr.number, pr.mergeCommitSha, pr.baseRef]),
      [[4088, "c".repeat(40), "main"], [4099, "b".repeat(40), "main"]]);
    assert.equal(recorded.data!.delivery.report, null);
    assert.equal(recorded.data!.item.verifications.length, 0, "a pull request alone is not a verified child report");
    assert.equal(h.db.campaignProjection("root")!.status, "verified_complete");
  } finally { h.db.close(); }
});

test("a delivery with an open attempt closes it, and another session still working refuses it", async () => {
  const h = fixture();
  try {
    assert.ok(h.svc.assignCampaignWorkItem("root", { workItemId: h.delivery, childSessionId: "child" }).ok);
    h.db.updateSessionStatus("child", "running", Date.now());
    const report = h.report("child");
    const working = await h.svc.recordCampaignWorkItemDelivery("root", { workItemId: h.delivery,
      report: { childSessionId: "child", reportEventSeq: report } });
    assert.match(working.error ?? "", /still working on this item/u);
    h.db.updateSessionStatus("child", "idle", Date.now());
    const recorded = await h.svc.recordCampaignWorkItemDelivery("root", { workItemId: h.delivery,
      report: { childSessionId: "child", reportEventSeq: report } });
    assert.ok(recorded.ok, recorded.error ?? "refused");
    assert.deepEqual(recorded.data!.item.attempts.map((attempt) => attempt.endReason), ["delivered"]);
    assert.equal(recorded.data!.item.currentAttempt, null);
    // A later assignment reopens the item: the recorded delivery no longer holds.
    assert.ok(h.svc.assignCampaignWorkItem("root", { workItemId: h.delivery, childSessionId: "other" }).ok);
    assert.notEqual(h.db.campaignWorkLedger.detail("root", h.delivery, Date.now())!.primaryState, "delivered");
  } finally { h.db.close(); }
});

test("an earlier report never delivers a later attempt the same child is still working on", async () => {
  const h = reusedChild();
  try {
    // The child comes back to its first item and is working on it again.
    assert.ok(h.svc.assignCampaignWorkItem("root", { workItemId: h.delivery, childSessionId: "child" }).ok);
    h.db.updateSessionStatus("child", "running", Date.now());
    const refused = await h.svc.recordCampaignWorkItemDelivery("root", { workItemId: h.delivery,
      report: { childSessionId: "child", reportEventSeq: h.firstReport } });
    assert.equal(refused.status, 409);
    assert.match(refused.error ?? "", /still working on this item in a later attempt/u);
    const item = h.db.campaignWorkLedger.detail("root", h.delivery, Date.now())!;
    assert.equal(item.currentAttempt?.sessionId, "child", "the later attempt stays open");
    assert.equal(item.deliveries?.length, 0);
    assert.notEqual(item.primaryState, "delivered");
  } finally { h.db.close(); }
});

test("everything a delivery rests on is checked again after the forge answers", async () => {
  const h = reusedChild();
  try {
    const refs = [{ repository: "picoduck/wollipog", number: 4088 }];
    assert.ok(h.svc.updateCampaignWorkItem("root", { workItemId: h.delivery, stage: { stage: "merged", pullRequests: refs } }).ok);
    let answer: (results: ForgeReadResult[]) => void = () => {};
    h.svc.campaignForgeReadNow = (_campaignId, asked) => new Promise((resolve) => {
      answer = (results) => resolve(results.length ? results : asked.map((ref) => ({ ref, observation: merged() })));
    });
    const pending = h.svc.recordCampaignWorkItemDelivery("root", { workItemId: h.delivery, pullRequests: refs });
    await new Promise((resolve) => setImmediate(resolve));
    // While the forge is being read, the item goes back to a child that starts working on it.
    assert.ok(h.svc.assignCampaignWorkItem("root", { workItemId: h.delivery, childSessionId: "other" }).ok);
    h.db.updateSessionStatus("other", "running", Date.now());
    answer([]);
    const result = await pending;
    assert.equal(result.status, 409);
    assert.match(result.error ?? "", /still working on this item in a later attempt/u);
    const item = h.db.campaignWorkLedger.detail("root", h.delivery, Date.now())!;
    assert.equal(item.currentAttempt?.sessionId, "other", "the new attempt is not closed");
    assert.equal(item.deliveries?.length, 0);

    // The same for a stage that stops naming the pull request meanwhile.
    h.db.updateSessionStatus("other", "idle", Date.now());
    const again = h.svc.recordCampaignWorkItemDelivery("root", { workItemId: h.delivery, pullRequests: refs });
    await new Promise((resolve) => setImmediate(resolve));
    assert.ok(h.svc.updateCampaignWorkItem("root", { workItemId: h.delivery, stage: { stage: "merged",
      pullRequests: [{ repository: "picoduck/wollipog", number: 4099 }] } }).ok);
    answer([]);
    assert.match((await again).error ?? "", /not named by the work item's reported stage/u);
    assert.equal(h.db.campaignWorkLedger.detail("root", h.delivery, Date.now())!.deliveries?.length, 0);
  } finally { h.db.close(); }
});

test("withdrawing the last handoff, or handing the item to an agent, reopens rather than verifying the campaign", () => {
  const h = fixture();
  try {
    finishChildren(h);
    // The original advisory item is out of scope here: only an unfinished follow-up is left.
    assert.ok(h.svc.updateCampaignWorkItem("root", { workItemId: h.advisory,
      commitment: { state: "scope_removed", reason: "Covered by the follow-up." } }).ok);
    const added = h.svc.recordCampaignPlan("root", { planComplete: true, items: [{ key: "follow-up:advisory",
      title: "File the Advisory", origin: "follow_up" }] });
    assert.ok(added.ok, added.error ?? "refused");
    const followUp = added.data!.items[0]!.workItemId;
    assert.equal(h.db.campaignProjection("root")!.status, "blocked", "an unhanded follow-up is agent work under Full Control");
    assert.ok(handOff(h, followUp, "human").ok);
    assert.equal(h.db.campaignProjection("root")!.status, "complete_with_handoffs");
    assert.notEqual(h.db.campaignProjection("root")!.work?.elapsed.endedAt, null);

    assert.ok(h.svc.updateCampaignWorkItem("root", { workItemId: followUp, handoff: null }).ok);
    let projection = h.db.campaignProjection("root")!;
    assert.equal(projection.status, "blocked");
    assert.equal(projection.work?.elapsed.endedAt, null, "Campaign Elapsed resumes");
    for (const actor of ["child", "orchestrator"] as const) {
      assert.ok(handOff(h, followUp, actor).ok);
      projection = h.db.campaignProjection("root")!;
      assert.equal(projection.status, "blocked", `a handoff to ${actor} is agent work`);
      assert.equal(projection.work?.elapsed.endedAt, null);
    }
  } finally { h.db.close(); }
});

test("reassigning an item to the child that still holds it clears the item's handoff", () => {
  const h = fixture();
  try {
    finishChildren(h);
    assert.ok(handOff(h, h.advisory, "human").ok);
    const added = h.svc.recordCampaignPlan("root", { planComplete: true, items: [{ key: "follow-up:docs",
      title: "Docs", origin: "follow_up" }] });
    assert.ok(added.ok, added.error ?? "refused");
    const followUp = added.data!.items[0]!.workItemId;
    const assigned = h.svc.assignCampaignWorkItem("root", { workItemId: followUp, childSessionId: "other" });
    assert.ok(assigned.ok && assigned.data!.created, assigned.error ?? "refused");
    const attemptId = assigned.data!.attempt.id;
    // The child reports and is verified, but its attempt on the follow-up stays open.
    const verified = h.svc.verifyCampaignChild("root", { childSessionId: "other", reportEventSeq: h.report("other"),
      followUpsAccounted: true });
    assert.ok(verified.ok, verified.error ?? "verification refused");
    assert.ok(handOff(h, followUp, "human").ok);
    assert.equal(h.db.campaignProjection("root")!.status, "complete_with_handoffs");

    const before = h.db.campaignWorkLedger.revision("root");
    const again = h.svc.assignCampaignWorkItem("root", { workItemId: followUp, childSessionId: "other" });
    assert.ok(again.ok, again.error ?? "refused");
    // The same attempt, and nothing closed: only the handoff goes.
    assert.equal(again.data!.attempt.id, attemptId);
    assert.equal(again.data!.created, false);
    assert.deepEqual(again.data!.closedAttempts, []);
    const item = h.db.campaignWorkLedger.detail("root", followUp, Date.now())!;
    assert.equal(item.handoff, null);
    assert.deepEqual(item.attempts.map((attempt) => [attempt.id, attempt.endReason]), [[attemptId, null]]);
    const after = h.db.campaignWorkLedger.revision("root");
    assert.ok(after > before, "clearing the handoff is a ledger write");
    assert.equal(again.data!.revision, after);
    // The agent owns unfinished work again, so the remaining handoff no longer completes the campaign.
    const projection = h.db.campaignProjection("root")!;
    assert.equal(projection.status, "blocked");
    assert.deepEqual(projection.handoffs?.items.map((handed) => handed.workItemId), [h.advisory]);

    // With no handoff left to clear, reassigning the holder is a no-op.
    const repeated = h.svc.assignCampaignWorkItem("root", { workItemId: followUp, childSessionId: "other" });
    assert.ok(repeated.ok, repeated.error ?? "refused");
    assert.equal(repeated.data!.attempt.id, attemptId);
    assert.equal(repeated.data!.revision, after);
    assert.equal(h.db.campaignWorkLedger.revision("root"), after);
  } finally { h.db.close(); }
});

/** Answers the verification's worktree inspection the way a v275 runner does. */
function inspectWorktrees(h: Fixture, answer: (worktreePath: string) => Extract<RunnerToControlPlane, { type: "git_result" }>) {
  const inspected: string[] = [];
  h.hub.requestFromRunner = (async (_runnerId: string, requestId: string, message: ControlPlaneToRunner) => {
    // Archive-time retirement is not under test: leave it pending so nothing outlives the fixture.
    if (message.type !== "git_action") return new Promise(() => {});
    inspected.push(message.worktreePath ?? "");
    return { ...answer(message.worktreePath ?? ""), requestId };
  }) as Hub["requestFromRunner"];
  return inspected;
}

const clean = { changedPathCount: 0, hasChanges: false, files: [] };

test("verification skips a worktree the runner no longer links, and keeps refusing a dirty one that exists", async () => {
  const h = fixture("stop_and_archive");
  try {
    // The child's record still names an earlier worktree that was already retired, beside its current one.
    h.db.raw().prepare("UPDATE sessions SET worktrees=?, worktree_path=? WHERE id='child'").run(JSON.stringify([
      { id: "wt_old", path: "/fixture/worktrees/child-old", branch: "agent/child", source: "created" },
      { id: "wt_new", path: "/fixture/worktrees/child-new", branch: "agent/child-2", source: "created" },
    ]), "/fixture/worktrees/child-new");
    h.db.updateSessionStatus("child", "completed", Date.now());
    const report = h.report("child");
    const verify = () => h.svc.verifyCampaignChildWithHistory("root", { childSessionId: "child", reportEventSeq: report,
      followUpsAccounted: true });

    let inspected = inspectWorktrees(h, (path) => path.endsWith("child-old")
      ? { type: "git_result", requestId: "", ok: false, error: "the session no longer links this worktree", code: "GIT_WORKTREE_UNLINKED" }
      : { type: "git_result", requestId: "", ok: true, data: { status: { ...clean, changedPathCount: 1, hasChanges: true,
        files: [{ path: "notes.md", status: "modified" }] } as never } });
    const dirty = await verify();
    assert.equal(dirty.status, 409);
    assert.match(dirty.error ?? "", /child-new.*notes\.md/u, "a dirty worktree that exists is still refused");
    assert.deepEqual(inspected, ["/fixture/worktrees/child-old", "/fixture/worktrees/child-new"]);

    inspectWorktrees(h, (path) => path.endsWith("child-old")
      ? { type: "git_result", requestId: "", ok: false, error: "git action path does not match runner-owned session metadata" }
      : { type: "git_result", requestId: "", ok: true, data: { status: clean as never } });
    const unknown = await verify();
    assert.equal(unknown.status, 409, "an older runner's refusal is never read as retirement");
    assert.match(unknown.error ?? "", /child-old.*does not match runner-owned session metadata/u);

    inspected = inspectWorktrees(h, (path) => path.endsWith("child-old")
      ? { type: "git_result", requestId: "", ok: false, error: "the session no longer links this worktree", code: "GIT_WORKTREE_UNLINKED" }
      : { type: "git_result", requestId: "", ok: true, data: { status: clean as never } });
    const verified = await verify();
    assert.ok(verified.ok, verified.error ?? "refused");
    assert.equal(h.db.campaignChildReportVerified("root", "child"), true);
    assert.equal(inspected.length, 2);
  } finally { h.db.close(); }
});
