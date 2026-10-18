import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";
import { test } from "node:test";
import { DEFAULT_ORCHESTRATOR_DEFAULTS, HUMAN_ONLY_PARENT_CONTROL_POLICY, isTerminal, PACED_VIDEO_REVIEW_CONTRACT_ID, PROTOCOL_VERSION,
  pacedVideoReviewWindowPlan, pacedVideoReviewWindowPlanBody, type ControlPlaneToRunner, type MediaReviewDispatch,
  type MediaReviewFinished, type RunnerMetadata, type SessionSnapshot } from "@wollipog/protocol";
import { RunnerMediaDispatchFences } from "../../runner/src/media-dispatch-fences.js";
import { ControlPlaneDb } from "./db.js";
import { mintCampaignEvidenceAuthority } from "./evidence-authority.js";
import { composeHostingVideoEvidence } from "./hosting-video-evidence.js";
import { Hub } from "./hub.js";
import type { AgentPrincipal, HumanPrincipal } from "./identity.js";
import { resolveOrchestratorCampaignPolicy } from "./orchestrator-settings.js";
import { SessionsService, normalizeWorkflowDecisionSnapshot } from "./sessions.js";
import { videoPreparationDecoderAvailable, type VideoPreparationResult } from "./video-evidence-preparation.js";
import type { VideoReviewDecoder } from "./video-evidence-runtime.js";
import { syntheticInspectedVideoRuns, syntheticMediaReviewerAttestation, syntheticVideoReviewerTarget } from "./video-live-validation-test-fixture.js";

/** Delegated video review end to end (#1321) over a real database, the real SessionsService and the
 * hosting composition. The runner is simulated at its message boundary, the live proof is disclosed
 * synthetic metadata, and without user namespaces a synthetic decoder stands in for ffmpeg. Nothing
 * here is live provider delivery, model recognition or usage evidence. */
const sha = (value: string | Buffer) => createHash("sha256").update(value).digest("hex");
const json = (value: unknown) => JSON.stringify(value);
const source = readFileSync(new URL("../test-fixtures/video-preparation-paced.webm", import.meta.url));
const attestation = syntheticMediaReviewerAttestation("claude");

/** 130 tiny frames, three fresh-context windows. Used only where the isolated decoder cannot run. */
const syntheticDecoder: VideoReviewDecoder = {
  paced: async (bytes, mediaType): Promise<VideoPreparationResult> => {
    const images = Array.from({ length: 130 }, (_, i) => Buffer.from(`synthetic decoded frame ${i}`));
    const manifest = { schemaVersion: 1 as const, purpose: "offline_preparation_only" as const,
      profile: "paced-silent-video-preparation-v1" as const, sourceSha256: sha(bytes), sourceSizeBytes: bytes.length,
      sourceMediaType: mediaType, width: 1280, height: 720, durationUs: 130 * 33_334,
      frames: images.map((image, index) => ({ index, ptsUs: index * 33_334, durationUs: 33_334, sha256: sha(image), sizeBytes: image.length })),
      segments: [{ index: 0, firstFrame: 0, frameCount: 130, startUs: 0, endUs: 130 * 33_334 }] };
    return { ok: true, manifest, manifestSha256: sha(json(manifest)), images };
  },
  candidate: async () => ({ ok: false, code: "decoder_unavailable", reason: "No candidate profile in this test.", retryable: false }),
};

async function harness(t: { after(fn: () => void): void }, options: { proof?: boolean; childContract?: boolean } = {}) {
  const native = await videoPreparationDecoderAvailable();
  const db = ControlPlaneDb.open(":memory:");
  const human: HumanPrincipal = { ...db.localIdentityContext(), kind: "human", actorId: "synthetic-human" };
  const audience = { organizationId: human.organizationId, owner: { kind: "user" as const, userId: human.userId } };
  const contract = { id: PACED_VIDEO_REVIEW_CONTRACT_ID, revision: 1 as const };
  // Only the reviewer installation is attested; the child's declares the contract alone.
  const agent = (id: string, paced: boolean, attested = paced) => ({ id, name: "Synthetic Claude", command: "claude", args: [], env: {}, driver: "claude-code" as const,
    available: true, capabilities: { models: [{ id: "claude-opus-5-5", displayName: "Synthetic", default: true, inputModalities: ["text", "image"] as Array<"text" | "image"> }],
      effortLevels: ["high"], slashCommands: [], supportsImages: true, supportsApprovals: true, imageToolResults: true,
      permissionModes: ["default"], ...(paced ? { pacedVideoReviewContract: contract } : {}),
      ...(attested ? { mediaReviewerAttestation: { ...attestation, agentId: id } } : {}) } });
  const metadata: RunnerMetadata = { runnerId: "r", hostname: "synthetic", os: "linux", version: "test",
    workspaces: [{ id: "w", name: "Repo", path: "/synthetic-repo" }],
    agents: [agent("claude", true), agent("child-agent", options.childContract !== false, false)] };
  db.registerRunner(metadata, 1, PROTOCOL_VERSION);
  db.setUsageRateTable(new Map([["claude-opus-5-5", { inputCostPerToken: 0.000001, outputCostPerToken: 0.000001,
    cacheReadCostPerToken: 0.000001, cacheCreationCostPerToken: 0.000001 }]]));
  const policy = resolveOrchestratorCampaignPolicy(DEFAULT_ORCHESTRATOR_DEFAULTS, "system_default");
  policy.issueScope = { repository: "picoduck/wollipog", issueNumbers: [1321], revision: 1, authorizedByUserId: human.userId, authorizedAt: 1 };
  policy.issueNumbers = [1321];
  db.createSession({ id: "root", runnerId: "r", workspaceId: "w", agentId: "claude", title: "Synthetic Root", useWorktree: false,
    driver: "claude-code", config: { model: "claude-opus-5-5" }, scope: audience, creationActor: "human", role: "orchestrator",
    orchestratorPolicy: policy, parentControlPolicy: { decisions: { ...HUMAN_ONLY_PARENT_CONTROL_POLICY } }, now: 2 });
  db.updateSessionStatus("root", "running", 3);
  const hub = new Hub(db), sent: ControlPlaneToRunner[] = [];
  hub.isRunnerOnline = () => true; hub.sendToRunner = (_, message) => { sent.push(message); return true; };
  hub.sessionChanged = () => {}; hub.sessionChangedById = () => {};
  const log = { info() {}, warn() {}, error() {} };
  assert.ok(new SessionsService(db, hub, log).setCampaignControl("root", { mode: "full_control", objective: "Review #1321",
    operations: ["ui_evidence_approval"], delegatablePolicyIds: [], budgetAuthority: { version: 1, accounting: "managed_workers_only",
      unpriced: "stop", toolCalls: 1000, costUsd: 200, concurrency: 3 } }, 1, human).ok);
  const rootPolicy = db.getSession("root")!.orchestratorPolicy!;
  const boundary = rootPolicy.control!.mode === "full_control" ? rootPolicy.control!.boundary : assert.fail("No fixture boundary");
  const disclosures = {
    destination: () => ({ organizationId: human.organizationId, privacy: "private" as const, disclosureRevision: 1 }),
    provider: () => ({ disclosureRevision: 1, retentionDisclosure: "Synthetic test disclosure.",
      reviewers: [{ driver: "claude-code" as const, modelId: "claude-opus-5-5" }] }),
  };
  boundary.evidenceAuthority = mintCampaignEvidenceAuthority(human, boundary, "root", { destinationConfigurationId: "synthetic-private",
    destinationDisclosureRevision: 1, providers: [{ providerId: "synthetic-provider", disclosureRevision: 1,
      reviewers: [{ driver: "claude-code", modelId: "claude-opus-5-5" }] }] }, disclosures)!;
  assert.ok(boundary.evidenceAuthority);
  // Fixture-only Human boundary composition, as the prepared-media integration harness does.
  db.raw().prepare("UPDATE sessions SET orchestrator_policy=? WHERE id='root'").run(JSON.stringify(rootPolicy));
  db.createSession({ id: "child", parentSessionId: "root", runnerId: "r", workspaceId: "w", agentId: "child-agent", title: "Synthetic Child",
    useWorktree: false, driver: "claude-code", scope: audience, config: { model: "claude-opus-5-5", costBudgetUsd: 2, maxToolCalls: 10 }, now: 4 });
  db.updateSessionStatus("child", "running", 5);
  db.createWorkflowArtifactBytes({ artifactId: "source", sessionId: "child", kind: "video", name: "Synthetic.webm", mimeType: "video/webm",
    encoding: "base64", sha256: sha(source), sizeBytes: source.length, createdBy: { kind: "agent", id: "child" },
    metadata: { purpose: "session_attachment" }, createdAt: 6 }, source);
  const normalized = normalizeWorkflowDecisionSnapshot({ category: "ui_evidence_approval",
    evidence: [{ evidenceId: "original-video", artifactId: "source", sha256: sha(source), mediaType: "video/webm" }] });
  assert.ok(normalized.ok && normalized.data);
  const snapshot = normalized.data;
  assert.ok(db.createWorkflowDecision({ requestId: "synthetic-ui", occurrenceId: "original-gate", sessionId: "child",
    controllingSessionId: "root", category: "ui_evidence_approval", resourceKey: "synthetic", resourceSnapshot: snapshot,
    resourceDigest: sha(json(snapshot)), policyRevision: boundary.revision, authority: "orchestrator", createdAt: 7 }));

  let now = Date.now();
  const timers: Array<{ run: () => void; at: number }> = [];
  const video = composeHostingVideoEvidence(db, { decoder: native ? undefined : syntheticDecoder, clock: () => now,
    schedule: (run, ms) => { timers.push({ run, at: now + ms }); return setTimeout(() => {}, 0); } });
  const sessions = new SessionsService(db, hub, log, undefined, undefined, undefined, undefined, undefined, undefined, false, undefined,
    video.preparedMediaRuntime, video.workflowVideoApprovals, disclosures, video.operatorValidationPermits, video.preparedMediaActiveStops);
  video.attach(sessions, hub);
  t.after(() => { video.delegated.close(); db.close(); });
  let proofId: string | null = null;
  if (options.proof !== false) {
    const target = syntheticVideoReviewerTarget({ runnerId: "r", agentId: "claude", driver: "claude-code", modelId: "claude-opus-5-5",
      protocolVersion: PROTOCOL_VERSION, contract, attestation, providerId: "synthetic-provider" });
    const proof = video.liveValidation.recordInspectedRuns(human, target, syntheticInspectedVideoRuns(target, human.userId), now - 1_000);
    assert.ok(proof);
    proofId = proof.proofId;
  }
  const principal = (id: string, orchestrator: boolean): AgentPrincipal => ({ kind: "agent", actorId: id, credentialSessionId: id,
    orchestrator, organizationId: human.organizationId, delegatedScope: audience });
  const owner = principal("root", true);
  const request = { childSessionId: "child", occurrenceId: "original-gate", evidenceId: "original-video" };
  const dispatches = () => sent.filter((m): m is Extract<ControlPlaneToRunner, { type: "media_review_dispatch" }> => m.type === "media_review_dispatch")
    .map((m) => m.dispatch);
  /** The owning runner's messages, digested exactly as the runner dispatcher digests them. */
  const runner = {
    fence: (dispatch: MediaReviewDispatch) => { const { childSessionId: _child, ...fence } = dispatch.identity; return fence; },
    accepted: (dispatch: MediaReviewDispatch) => {
      const body = { ...runner.fence(dispatch), outcome: "accepted" as const, deliveryPlanSha256: dispatch.deliveryPlanSha256,
        namespaceLaunchSha256: sha("synthetic actual launch") };
      return { ...body, receiptSha256: sha(json(body)) };
    },
    finished: (dispatch: MediaReviewDispatch, usage: { priced: boolean; costUsd?: number }): MediaReviewFinished => {
      const body = { ...runner.fence(dispatch), deliveryPlanSha256: dispatch.deliveryPlanSha256, outcome: "completed" as const,
        windowsCompleted: pacedVideoReviewWindowPlan(dispatch.grant.frames).windows.length, verdictConfirmed: true, toolCalls: 12,
        ...(usage.priced ? { costUsd: usage.costUsd } : {}), priced: usage.priced };
      return { ...body, receiptSha256: sha(json(body)) };
    },
    neverDispatched: (dispatch: MediaReviewDispatch) =>
      new RunnerMediaDispatchFences(new DatabaseSync(":memory:")).cancelBeforeLaunch(runner.fence(dispatch))!,
  };
  /** The reviewer's media calls, window by window, then its verdict. */
  const review = (dispatch: MediaReviewDispatch, outcome: "accept" | "reject" = "accept") => {
    const reviewer = principal(dispatch.grant.reviewerSessionId, false);
    for (const window of pacedVideoReviewWindowPlan(dispatch.grant.frames).windows) {
      for (let cursor = window.firstIndex; cursor < window.endIndex;) {
        const batch = video.reviewService.deliverBatch(reviewer, dispatch.grant.reviewId, cursor, window.endIndex);
        video.reviewService.acknowledgeBatch(reviewer, dispatch.grant.reviewId,
          batch.deliveries.map((d) => ({ receiptId: d.receipt.receiptId, sha256: d.receipt.sha256 })));
        cursor = batch.nextIndex;
      }
    }
    return video.reviewService.verdict(reviewer, dispatch.grant.reviewId, { outcome, rationale: "Synthetic contract test only.",
      criteria: [{ criterionId: "visual_defects", outcome: outcome === "accept" ? "pass" : "fail", observedFrameIndices: [0],
        observation: "Disclosed synthetic observation." },
        { criterionId: "coherent_flow", outcome: "pass", observedFrameIndices: [1], observation: "Disclosed synthetic observation." }] });
  };
  return { db, video, sessions, sent, owner, request, dispatches, runner, review, snapshot, timers, human, principal,
    revokeProof: () => assert.ok(video.liveValidation.revoke(human, proofId!)),
    readbacks: () => sent.filter((m): m is Extract<ControlPlaneToRunner, { type: "media_review_readback" }> => m.type === "media_review_readback"),
    advance: (ms: number) => { now += ms; }, now: () => now,
    /** Fires the next scheduled backoff timer through the coordinator's own callback (so its
     * bookkeeping runs exactly as in production), then waits, bounded, for that retry to settle the
     * subject: dispatched, refused or queued again. Fails if no timer was scheduled. */
    runScheduledRetry: async () => {
      const timer = timers.shift();
      assert.ok(timer, "the coordinator scheduled a backoff timer");
      const before = sent.length;
      timer.run();
      const state = () => (db.raw().prepare("SELECT json_extract(record,'$.state') AS state FROM delegated_video_reviews")
        .get() as { state: string } | undefined)?.state;
      for (const deadline = Date.now() + 60_000; Date.now() < deadline;) {
        if (state() !== "preparing" && (sent.length > before || state() === "refused")) return;
        await new Promise((done) => setTimeout(done, 10));
      }
      assert.fail(`the scheduled retry did not settle (state ${state()})`);
    } };
}

test("an owned video decision is reviewed, priced, approved with delegated provenance and consumed", async (t) => {
  const h = await harness(t);
  const prepared = await h.video.delegated.prepare(h.owner, h.request);
  assert.equal(prepared.ok && prepared.status, "dispatched", JSON.stringify(prepared));
  const [dispatch] = h.dispatches();
  assert.ok(dispatch);
  assert.equal(dispatch.grant.deliveryPlanSha256, sha(pacedVideoReviewWindowPlanBody(pacedVideoReviewWindowPlan(dispatch.grant.frames))));
  assert.equal(dispatch.deliveryPlanSha256, dispatch.grant.deliveryPlanSha256);
  assert.equal(dispatch.command.spec.config?.model, "claude-opus-5-5");
  assert.equal(dispatch.command.spec.config?.effort, "high");
  assert.ok(dispatch.command.spec.mediaReviewPurpose, "only the dedicated dispatcher can launch this command");
  assert.equal(h.sent.filter((m) => m.type === "start_session").length, 0, "no generic provider start");
  const reviewerId = dispatch.grant.reviewerSessionId;

  const pending = h.video.delegated.provenance(h.owner, dispatch.grant.reviewId);
  assert.equal(pending.ok && "status" in pending && pending.status, "pending");
  assert.equal(await h.video.delegated.onDispatchReceipt("other-runner", h.runner.accepted(dispatch)), false, "only the owning runner");
  assert.equal(await h.video.delegated.onDispatchReceipt("r", { ...h.runner.accepted(dispatch), deliveryPlanSha256: sha("other plan") }), false);
  assert.equal(await h.video.delegated.onDispatchReceipt("r", h.runner.accepted(dispatch)), true);
  assert.equal(h.db.getSession(reviewerId)?.status, "running");

  const verdict = h.review(dispatch);
  assert.equal(verdict.receiptIds.length, plannedDeliveryCount(dispatch), "every window receipts each of its frames");
  assert.equal(verdict.deliveryPlanSha256, dispatch.deliveryPlanSha256);
  assert.equal(h.video.delegated.provenance(h.owner, dispatch.grant.reviewId).ok && "status" in h.video.delegated.provenance(h.owner,
    dispatch.grant.reviewId) ? (h.video.delegated.provenance(h.owner, dispatch.grant.reviewId) as { status: string }).status : null, "pending",
    "a verdict without settled final usage stays pending");

  const finished = h.runner.finished(dispatch, { priced: true, costUsd: 1.25 });
  assert.equal(await h.video.delegated.onFinished("r", { ...finished, costUsd: 0.01 }), false, "a changed digest is refused");
  assert.equal(await h.video.delegated.onFinished("r", finished), true);
  assert.equal(h.db.getSession(reviewerId)?.status, "completed");
  assert.equal(h.db.campaignBudgets.active(reviewerId), false, "priced final usage released the unused reservation");
  assert.deepEqual(h.db.campaignBudgets.completedAttestation(reviewerId)?.actual, { costUsd: 1.25, toolCalls: 12 });

  const complete = h.video.delegated.provenance(h.owner, dispatch.grant.reviewId) as Record<string, unknown> & {
    status: string; resolveWith: { evidenceId: string; reviewId: string; verdictId: string; reviewerSessionId: string } };
  assert.equal(complete.status, "complete", JSON.stringify(complete));
  assert.equal(complete.typedDecisionResolved, false);
  assert.equal(complete.deliveryPlanSha256, dispatch.deliveryPlanSha256);
  assert.deepEqual(complete.reviewer, { sessionId: reviewerId, driver: "claude-code", model: "claude-opus-5-5", effort: "high" });
  assert.deepEqual(complete.resolveWith, { evidenceId: "original-video", reviewId: dispatch.grant.reviewId,
    verdictId: verdict.verdictId, reviewerSessionId: reviewerId });
  assert.equal(h.video.delegated.provenance({ ...h.owner, orchestrator: false }, dispatch.grant.reviewId).ok, false);
  assert.equal(h.video.delegated.provenance({ ...h.owner, credentialSessionId: "child" }, dispatch.grant.reviewId).ok, false);

  const approved = h.sessions.resolveWorkflowDecision("root", "child", "original-gate", { outcome: "approve", evidenceReviewed: [],
    delegatedVideoEvidence: [complete.resolveWith] }, "orchestrator", { kind: "agent", id: "root" }, () => true);
  assert.ok(approved.ok, JSON.stringify(approved));
  assert.deepEqual(approved.data?.delegatedVideoEvidence, [complete.resolveWith]);
  const consumed = await h.sessions.consumeWorkflowDecision("child", "original-gate", { resourceSnapshot: h.snapshot });
  assert.ok(consumed.ok, JSON.stringify(consumed));
  assert.equal(consumed.data?.status, "consumed");
});

function plannedDeliveryCount(dispatch: MediaReviewDispatch): number {
  return pacedVideoReviewWindowPlan(dispatch.grant.frames).windows.reduce((sum, w) => sum + w.endIndex - w.firstIndex, 0);
}

test("unpriced final usage retains the reservation and withholds provenance", async (t) => {
  const h = await harness(t);
  await h.video.delegated.prepare(h.owner, h.request);
  const [dispatch] = h.dispatches();
  assert.ok(dispatch);
  assert.equal(await h.video.delegated.onDispatchReceipt("r", h.runner.accepted(dispatch)), true);
  h.review(dispatch);
  assert.equal(await h.video.delegated.onFinished("r", h.runner.finished(dispatch, { priced: false })), true);
  const withheld = h.video.delegated.provenance(h.owner, dispatch.grant.reviewId) as { status: string; reason: string };
  assert.deepEqual([withheld.status, withheld.reason], ["withheld", "unpriced_usage"]);
  assert.equal(h.db.campaignBudgets.active(dispatch.grant.reviewerSessionId), true, "the reservation is retained, not refunded");
  assert.equal(h.db.campaignBudgets.completedAttestation(dispatch.grant.reviewerSessionId), null);
  assert.equal(h.db.campaignBudgets.view("root")?.state, "accounting_unavailable");
});

test("a busy host requeues fresh identities with bounded backoff, reserving nothing while queued, then refuses", async (t) => {
  const h = await harness(t);
  await h.video.delegated.prepare(h.owner, h.request);
  const reviewers: string[] = [];
  for (let attempt = 0; attempt < 4; attempt++) {
    const dispatch = h.dispatches().at(-1)!;
    assert.equal(h.dispatches().length, attempt + 1);
    reviewers.push(dispatch.grant.reviewerSessionId);
    assert.equal(await h.video.delegated.onNeverDispatched("r", h.runner.neverDispatched(dispatch), "host_busy"), true);
    assert.equal(h.db.campaignBudgets.active(dispatch.grant.reviewerSessionId), false, "the unsent reservation is released");
    assert.equal(h.db.getSession(dispatch.grant.reviewerSessionId)?.status, "stopped");
    const state = await h.video.delegated.prepare(h.owner, h.request) as Record<string, unknown>;
    if (attempt === 3) {
      assert.deepEqual([state.ok, state.code], [false, "reviewer_busy_exhausted"], "no silent retry past the cap");
      break;
    }
    assert.deepEqual([state.ok, state.status, state.reason], [true, "pending", "host_busy"], JSON.stringify(state));
    assert.equal(state.nextAttemptAt, h.now() + [30_000, 120_000, 480_000][attempt]!);
    assert.equal(h.dispatches().length, attempt + 1, "re-preparing while queued neither dispatches nor reserves");
    assert.equal(h.db.raw().prepare("SELECT COUNT(*) AS n FROM campaign_budget_members WHERE active=1 AND session_id NOT IN ('root','child')")
      .get()!.n, 0, "nothing is reserved while queued");
    h.advance([30_000, 120_000, 480_000][attempt]!);
    await h.runScheduledRetry();
  }
  assert.equal(new Set(reviewers).size, 4, "each attempt is a new reviewer Session and identity");
});

test("a non-busy never-dispatched refusal is not retried", async (t) => {
  const h = await harness(t);
  await h.video.delegated.prepare(h.owner, h.request);
  const [dispatch] = h.dispatches();
  assert.ok(dispatch);
  assert.equal(await h.video.delegated.onNeverDispatched("r", h.runner.neverDispatched(dispatch)), true);
  assert.equal(h.timers.length, 0);
  const state = await h.video.delegated.prepare(h.owner, h.request) as Record<string, unknown>;
  assert.equal(state.ok && state.status, "dispatched", "the owner may prepare a fresh attempt after a refusal");
  assert.equal(h.dispatches().length, 2);
});

test("the busy-host cap survives a non-busy refusal and a fresh owner preparation", async (t) => {
  const h = await harness(t);
  await h.video.delegated.prepare(h.owner, h.request);
  assert.equal(await h.video.delegated.onNeverDispatched("r", h.runner.neverDispatched(h.dispatches().at(-1)!), "host_busy"), true);
  h.advance(30_000); await h.runScheduledRetry();
  assert.equal(h.dispatches().length, 2);
  assert.equal(await h.video.delegated.onNeverDispatched("r", h.runner.neverDispatched(h.dispatches().at(-1)!)), true);
  assert.equal((await h.video.delegated.prepare(h.owner, h.request) as { status: string }).status, "dispatched");
  assert.equal(await h.video.delegated.onNeverDispatched("r", h.runner.neverDispatched(h.dispatches().at(-1)!), "host_busy"), true);
  const queued = await h.video.delegated.prepare(h.owner, h.request) as { status: string; nextAttemptAt: number };
  assert.equal(queued.status, "pending");
  assert.equal(queued.nextAttemptAt, h.now() + 120_000, "the second busy requeue backs off further, whatever happened between");
});

test("an interrupted preparation is recovered without a second reservation or dispatch", async (t) => {
  const h = await harness(t);
  await h.video.delegated.prepare(h.owner, h.request);
  assert.equal(h.dispatches().length, 1);
  // A restart between dispatch and the ledger's final write leaves the subject `preparing`.
  h.db.raw().prepare("UPDATE delegated_video_reviews SET record=json_set(record,'$.state','preparing')").run();
  const recovered = await h.video.delegated.prepare(h.owner, h.request) as { status: string; reviewId: string };
  assert.equal(recovered.status, "dispatched", "a possibly dispatched reviewer is kept, never replaced");
  assert.equal(recovered.reviewId, h.dispatches()[0]!.grant.reviewId);
  assert.equal(h.dispatches().length, 1);
});

test("revoking the review's own proof ends its media access even while readiness is otherwise available", async (t) => {
  const h = await harness(t);
  await h.video.delegated.prepare(h.owner, h.request);
  const [dispatch] = h.dispatches();
  assert.ok(dispatch);
  const reviewer = h.principal(dispatch.grant.reviewerSessionId, false);
  const first = pacedVideoReviewWindowPlan(dispatch.grant.frames).windows[0]!;
  const batch = h.video.reviewService.deliverBatch(reviewer, dispatch.grant.reviewId, 0, first.endIndex);
  h.video.reviewService.acknowledgeBatch(reviewer, dispatch.grant.reviewId,
    batch.deliveries.map((d) => ({ receiptId: d.receipt.receiptId, sha256: d.receipt.sha256 })));
  h.revokeProof();
  assert.throws(() => h.video.reviewService.deliverBatch(reviewer, dispatch.grant.reviewId, batch.nextIndex, first.endIndex),
    "the service path, below the route readiness gate, refuses once the proof is revoked");
  assert.equal(h.video.reviewStore.getReview(dispatch.grant.reviewId)?.status, "revoked", "the revocation is irreversible");
});

test("an active reviewer survives runner disconnect, absent inventory and a provisional startup stop", async (t) => {
  const h = await harness(t);
  await h.video.delegated.prepare(h.owner, h.request);
  const [dispatch] = h.dispatches();
  assert.ok(dispatch);
  const reviewerId = dispatch.grant.reviewerSessionId;
  assert.equal(await h.video.delegated.onDispatchReceipt("r", h.runner.accepted(dispatch)), true);
  h.sessions.failRunnerSessions("r");
  assert.equal(h.db.getSession(reviewerId)?.status, "running", "a disconnect leaves the dedicated lifecycle to its readback");
  h.sessions.reconcileRunnerSessions("r", ["root", "child"]);
  assert.equal(h.db.getSession(reviewerId)?.status, "running", "the ordinary inventory never lists a media reviewer");
  h.db.settleStartupState();
  assert.equal(h.db.getSession(reviewerId)?.status, "running", "a restart leaves an active reviewer to its own lifecycle");
  for (const id of ["root", "child"]) h.db.updateSessionStatus(id, "running", Date.now());
  h.review(dispatch);
  // A provisional stop, as an older control plane's startup wrote it, still yields to the runner's report.
  h.db.updateSessionStatus(reviewerId, "stopped", Date.now(), { cause: "startup_settlement" });
  assert.equal(await h.video.delegated.onFinished("r", h.runner.finished(dispatch, { priced: true, costUsd: 0.5 })), true);
  assert.equal(h.db.getSession(reviewerId)?.status, "completed", "the owning runner's report replaces a provisional stop");
  assert.equal((h.video.delegated.provenance(h.owner, dispatch.grant.reviewId) as { status: string }).status, "complete");
});

test("an explicitly stopped reviewer is not revived by a later runner report", async (t) => {
  const h = await harness(t);
  await h.video.delegated.prepare(h.owner, h.request);
  const [dispatch] = h.dispatches();
  assert.ok(dispatch);
  h.db.updateSessionStatus(dispatch.grant.reviewerSessionId, "stopped", Date.now(), { cause: "user_requested" } as never);
  assert.equal(await h.video.delegated.onDispatchReceipt("r", h.runner.accepted(dispatch)), true);
  assert.equal(h.db.getSession(dispatch.grant.reviewerSessionId)?.status, "stopped");
});

test("unresolved dispatches are read back from the owning runner on registration and while the owner polls", async (t) => {
  const h = await harness(t);
  await h.video.delegated.prepare(h.owner, h.request);
  const [dispatch] = h.dispatches();
  assert.ok(dispatch);
  assert.equal(h.video.delegated.readback("other-runner"), 0);
  assert.equal(h.video.delegated.readback("r"), 1);
  assert.deepEqual(h.readbacks().map((m) => m.identity), [dispatch.identity], "the exact identity, never a replayed dispatch");
  assert.equal(h.dispatches().length, 1);
  h.video.delegated.provenance(h.owner, dispatch.grant.reviewId);
  assert.equal(h.readbacks().length, 1, "polling reads back at most once a minute");
  h.advance(60_000);
  h.video.delegated.provenance(h.owner, dispatch.grant.reviewId);
  assert.equal(h.readbacks().length, 2);
  // The runner never received the command, so its readback fences it and reports never-dispatched.
  assert.equal(await h.video.delegated.onNeverDispatched("r", h.runner.neverDispatched(dispatch)), true);
  assert.equal(h.db.campaignBudgets.active(dispatch.grant.reviewerSessionId), false, "the held reservation is released");
  assert.equal(h.video.delegated.readback("r"), 0, "a settled review is not read back again");
});

test("a running reviewer's readback marks it active without a plan digest, which its dispatch digest binds", async (t) => {
  const h = await harness(t);
  await h.video.delegated.prepare(h.owner, h.request);
  const [dispatch] = h.dispatches();
  assert.ok(dispatch);
  const body = { ...h.runner.fence(dispatch), outcome: "accepted" as const, deliveryPlanSha256: "" };
  assert.equal(await h.video.delegated.onDispatchReceipt("r", { ...body, receiptSha256: sha(json(body)) }), true);
  assert.equal(h.db.getSession(dispatch.grant.reviewerSessionId)?.status, "running");
});

test("a verified rejection reaches its owner with observations but never approves", async (t) => {
  const h = await harness(t);
  await h.video.delegated.prepare(h.owner, h.request);
  const [dispatch] = h.dispatches();
  assert.ok(dispatch);
  assert.equal(await h.video.delegated.onDispatchReceipt("r", h.runner.accepted(dispatch)), true);
  const verdict = h.review(dispatch, "reject");
  assert.equal(await h.video.delegated.onFinished("r", h.runner.finished(dispatch, { priced: true, costUsd: 0.5 })), true);
  const observed = h.video.delegated.provenance(h.owner, dispatch.grant.reviewId) as Record<string, unknown> & {
    status: string; verdict: { outcome: string; criteria: Array<{ outcome: string }> } };
  assert.equal(observed.status, "complete", JSON.stringify(observed));
  assert.equal(observed.verdict.outcome, "reject");
  assert.equal(observed.verdict.criteria[0]!.outcome, "fail");
  assert.equal(Object.hasOwn(observed, "resolveWith"), false, "a rejection offers no approval reference");
  const approved = h.sessions.resolveWorkflowDecision("root", "child", "original-gate", { outcome: "approve", evidenceReviewed: [],
    delegatedVideoEvidence: [{ evidenceId: "original-video", reviewId: dispatch.grant.reviewId, verdictId: verdict.verdictId,
      reviewerSessionId: dispatch.grant.reviewerSessionId }] }, "orchestrator", { kind: "agent", id: "root" }, () => true);
  assert.equal(approved.ok, false);
});

test("a busy retry that runs past the deadline refuses without reserving or dispatching", async (t) => {
  const h = await harness(t);
  await h.video.delegated.prepare(h.owner, h.request);
  assert.equal(await h.video.delegated.onNeverDispatched("r", h.runner.neverDispatched(h.dispatches()[0]!), "host_busy"), true);
  const members = () => h.db.raw().prepare("SELECT COUNT(*) AS n FROM campaign_budget_members").get()!.n;
  const before = members();
  h.advance(21 * 60_000); // The process was suspended or down past the 20-minute limit.
  await h.runScheduledRetry();
  assert.equal(h.dispatches().length, 1);
  assert.equal(members(), before, "no new reviewer Session or reservation");
  assert.deepEqual(await h.video.delegated.prepare(h.owner, h.request), { ok: false, code: "reviewer_busy_exhausted",
    reason: "The reviewer host stayed busy through every bounded retry; video evidence stays with the Human." });
});

// ---- Lifecycle audit matrix (#1321 PR C round 3). Each test names its cell: state x event. ----

/** The runner's ordinary inventory for the controller and child; it never lists a media reviewer. */
function liveSnapshots(): SessionSnapshot[] {
  return (["root", "child"] as const).map((id) => ({ id, workspaceId: "w", agentId: id === "root" ? "claude" : "child-agent",
    status: "running" as const, title: id, driver: "claude-code", config: id === "root" ? { model: "claude-opus-5-5" }
      : { model: "claude-opus-5-5", costBudgetUsd: 2, maxToolCalls: 10 }, costUsd: 0, tokensIn: 0, tokensOut: 0, useWorktree: false,
    worktreePath: null, preview: null, pendingApproval: null, seq: 0, historyEpoch: 0, createdAt: 1, updatedAt: 2 }));
}
async function dispatched(t: { after(fn: () => void): void }, accepted = true) {
  const h = await harness(t);
  await h.video.delegated.prepare(h.owner, h.request);
  const dispatch = h.dispatches()[0]!;
  if (accepted) assert.equal(await h.video.delegated.onDispatchReceipt("r", h.runner.accepted(dispatch)), true);
  return { ...h, dispatch, reviewerId: dispatch.grant.reviewerSessionId };
}
const provisional = (h: Awaited<ReturnType<typeof harness>>, id: string, cause: "startup_settlement" | "runner_disconnect" = "startup_settlement") =>
  h.db.updateSessionStatus(id, "stopped", Date.now(), { cause });

test("preparing x startup: an unsent reviewer stays queued, so a restarted coordinator still releases it", async (t) => {
  const h = await harness(t);
  (h.video.reviewService as unknown as { prepare: () => Promise<never> }).prepare = () => new Promise(() => {});
  void h.video.delegated.prepare(h.owner, h.request); // Hangs after materialization, as a crash would.
  await new Promise((done) => setTimeout(done, 20));
  const reviewerId = h.db.raw().prepare("SELECT json_extract(payload,'$.sessionId') AS id FROM prepared_media_sessions").get()!.id as string;
  assert.equal(h.db.campaignBudgets.active(reviewerId), true);
  h.db.settleStartupState();
  assert.equal(h.db.getSession(reviewerId)?.status, "queued", "startup leaves an unsent media command to its coordinator");
  const restarted = composeHostingVideoEvidence(h.db, { clock: () => h.now(), schedule: () => setTimeout(() => {}, 0) });
  restarted.attach(h.sessions, { sendToRunner: () => true, isRunnerOnline: () => true, sessionChangedById: () => {} });
  t.after(() => restarted.delegated.close());
  await restarted.delegated.prepare(h.owner, h.request);
  assert.equal(h.db.campaignBudgets.active(reviewerId), false, "the interrupted reservation is released, not stranded");
  assert.equal(h.db.getSession(reviewerId)?.status, "stopped");
});

test("preparing x child deletion: the orphaned unsent reservation is released on the next registration", async (t) => {
  const h = await harness(t);
  (h.video.reviewService as unknown as { prepare: () => Promise<never> }).prepare = () => new Promise(() => {});
  void h.video.delegated.prepare(h.owner, h.request);
  await new Promise((done) => setTimeout(done, 20));
  const reviewerId = h.db.raw().prepare("SELECT json_extract(payload,'$.sessionId') AS id FROM prepared_media_sessions").get()!.id as string;
  h.db.deleteSession("child");
  assert.equal(h.db.campaignBudgets.active(reviewerId), true);
  h.video.delegated.readback("r");
  assert.equal(h.db.campaignBudgets.active(reviewerId), false, "no subject is left to release it, so registration does");
  assert.equal(h.db.getSession(reviewerId)?.status, "stopped");
});

test("dispatched x startup, archive and readback: provisional stays open, archive refuses, readback restores", async (t) => {
  const h = await dispatched(t, false);
  h.db.settleStartupState();
  assert.equal(h.db.getSession(h.reviewerId)?.status, "queued", "startup leaves a sent media command to readback");
  provisional(h, h.reviewerId); // As an older control plane's startup wrote it.
  const archived = h.sessions.setArchived(h.reviewerId, true);
  assert.equal(archived.ok, false, "an open reviewer cannot be archived, even provisionally stopped");
  assert.equal(h.db.getSession(h.reviewerId)?.archived, false);
  assert.equal(await h.video.delegated.onDispatchReceipt("r", h.runner.accepted(h.dispatch)), true);
  assert.equal(h.db.getSession(h.reviewerId)?.status, "running");
});

for (const sweep of ["reconcile", "hydrate"] as const) {
  test(`running x provisional stop then ${sweep}: absence never confirms it, and the finished report completes it`, async (t) => {
    const h = await dispatched(t);
    provisional(h, h.reviewerId, "runner_disconnect");
    if (sweep === "reconcile") h.sessions.reconcileRunnerSessions("r", ["root", "child"]);
    else assert.equal(await h.sessions.hydrateRunnerSessionsCooperatively("r", liveSnapshots(), { isCurrent: () => true }), true);
    assert.equal(h.db.sessionStopProvenance(h.reviewerId)?.confirmation, null, "inventory absence leaves the stop provisional");
    for (const id of ["root", "child"]) if (h.db.getSession(id)?.status !== "running") h.db.updateSessionStatus(id, "running", Date.now());
    assert.equal(await h.video.delegated.onDispatchReceipt("r", h.runner.accepted(h.dispatch)), true);
    h.review(h.dispatch);
    assert.equal(await h.video.delegated.onFinished("r", h.runner.finished(h.dispatch, { priced: true, costUsd: 0.5 })), true);
    assert.equal(h.db.getSession(h.reviewerId)?.status, "completed");
    assert.equal((h.video.delegated.provenance(h.owner, h.dispatch.grant.reviewId) as { status: string }).status, "complete");
  });
}

test("running x disconnect: the reviewer is left to its media lifecycle", async (t) => {
  const h = await dispatched(t);
  h.sessions.failRunnerSessions("r");
  assert.equal(h.db.getSession(h.reviewerId)?.status, "running");
});

test("running x Stop: media ends at once, and a later finished report stops it without provenance", async (t) => {
  const h = await dispatched(t);
  assert.equal(h.sessions.stop(h.reviewerId).status, 202, "a dedicated media Stop to the owning runner");
  assert.equal(h.sent.filter((m) => m.type === "media_review_stop").length, 1);
  const reviewer = h.principal(h.reviewerId, false);
  assert.throws(() => h.video.reviewService.deliverBatch(reviewer, h.dispatch.grant.reviewId, 0,
    pacedVideoReviewWindowPlan(h.dispatch.grant.frames).windows[0]!.endIndex));
  assert.equal(h.sessions.setArchived(h.reviewerId, true).ok, false, "archive waits for the authenticated end");
  assert.equal(await h.video.delegated.onFinished("r", h.runner.finished(h.dispatch, { priced: true, costUsd: 0.25 })), true);
  assert.equal(h.db.getSession(h.reviewerId)?.status, "stopped", "a Stopped reviewer is never completed");
  assert.equal(h.db.campaignBudgets.active(h.reviewerId), false, "its priced final usage still settles and releases the rest");
  assert.notEqual((h.video.delegated.provenance(h.owner, h.dispatch.grant.reviewId) as { status: string }).status, "complete");
  assert.equal(await h.video.delegated.onDispatchReceipt("r", h.runner.accepted(h.dispatch)), true);
  assert.equal(h.db.getSession(h.reviewerId)?.status, "stopped", "no later report restores it");
});

test("running x confirmed stop, archive, unarchive: nothing restores a closed reviewer", async (t) => {
  const h = await dispatched(t);
  h.db.updateSessionStatus(h.reviewerId, "stopped", Date.now(), { cause: "runner_reported", confirmation: "runner_terminal" });
  assert.equal(h.sessions.setArchived(h.reviewerId, true).ok, true, "a closed reviewer may be archived");
  assert.equal(h.sessions.setArchived(h.reviewerId, false).ok, true);
  assert.equal(await h.video.delegated.onDispatchReceipt("r", h.runner.accepted(h.dispatch)), true);
  assert.equal(h.db.getSession(h.reviewerId)?.status, "stopped");
  const reviewer = h.principal(h.reviewerId, false);
  assert.throws(() => h.video.reviewService.deliverBatch(reviewer, h.dispatch.grant.reviewId, 0,
    pacedVideoReviewWindowPlan(h.dispatch.grant.frames).windows[0]!.endIndex));
});

test("running x ownership revocation: media is refused and the review is revoked; the reservation waits for the runner", async (t) => {
  const h = await dispatched(t);
  h.db.raw().prepare("UPDATE workflow_decisions SET status='revoked' WHERE occurrence_id='original-gate'").run();
  const reviewer = h.principal(h.reviewerId, false);
  assert.throws(() => h.video.reviewService.deliverBatch(reviewer, h.dispatch.grant.reviewId, 0,
    pacedVideoReviewWindowPlan(h.dispatch.grant.frames).windows[0]!.endIndex));
  assert.equal(h.video.reviewStore.getReview(h.dispatch.grant.reviewId)?.status, "revoked");
  assert.equal(h.db.campaignBudgets.active(h.reviewerId), true, "a possibly running reviewer keeps its reservation");
  assert.equal(h.video.delegated.provenance(h.owner, h.dispatch.grant.reviewId).ok, false);
  assert.equal(await h.video.delegated.onFinished("r", h.runner.finished(h.dispatch, { priced: true, costUsd: 0.1 })), true);
  assert.equal(h.db.campaignBudgets.active(h.reviewerId), false, "its authenticated end settles and releases it");
});

test("verdict recorded x proof revocation: settled usage cannot make the revoked review's provenance observable", async (t) => {
  const h = await dispatched(t);
  h.review(h.dispatch);
  h.revokeProof();
  assert.equal(await h.video.delegated.onFinished("r", h.runner.finished(h.dispatch, { priced: true, costUsd: 0.5 })), true);
  assert.equal(h.db.getSession(h.reviewerId)?.status, "completed");
  assert.equal((h.video.delegated.provenance(h.owner, h.dispatch.grant.reviewId) as { status: string }).status, "withheld");
  assert.equal(h.video.reviewStore.getReview(h.dispatch.grant.reviewId)?.status, "revoked");
});

test("finished x archive and unarchive: provenance survives archival and no report reopens the reviewer", async (t) => {
  const h = await dispatched(t);
  h.review(h.dispatch);
  assert.equal(await h.video.delegated.onFinished("r", h.runner.finished(h.dispatch, { priced: true, costUsd: 0.5 })), true);
  assert.equal(h.sessions.setArchived(h.reviewerId, true).ok, true);
  assert.equal((h.video.delegated.provenance(h.owner, h.dispatch.grant.reviewId) as { status: string }).status, "complete");
  assert.equal(h.sessions.setArchived(h.reviewerId, false).ok, true);
  assert.equal(await h.video.delegated.onDispatchReceipt("r", h.runner.accepted(h.dispatch)), true);
  assert.equal(h.db.getSession(h.reviewerId)?.status, "completed");
  assert.equal(h.video.delegated.readback("r"), 0, "a finished review is never read back");
});

test("running x child deletion: the review disappears with its subject and spend is never refunded", async (t) => {
  const h = await dispatched(t);
  h.db.deleteSession("child");
  const reviewer = h.principal(h.reviewerId, false);
  assert.throws(() => h.video.reviewService.deliverBatch(reviewer, h.dispatch.grant.reviewId, 0,
    pacedVideoReviewWindowPlan(h.dispatch.grant.frames).windows[0]!.endIndex));
  assert.equal(h.video.reviewStore.getReview(h.dispatch.grant.reviewId), null);
  assert.equal(h.db.campaignBudgets.active(h.reviewerId), true, "the reservation is retained for the runner's end");
  assert.equal(await h.video.delegated.onFinished("r", h.runner.finished(h.dispatch, { priced: true, costUsd: 0.1 })), true);
  assert.equal(h.db.campaignBudgets.active(h.reviewerId), false, "the runner's authenticated end still settles it");
  assert.equal(h.video.reviewStore.getReview(h.dispatch.grant.reviewId), null, "no review, so no provenance can exist");
});

test("dispatched x child deletion: the never-dispatched fence still releases the reservation", async (t) => {
  const h = await dispatched(t, false);
  h.db.deleteSession("child");
  assert.equal(await h.video.delegated.onNeverDispatched("r", h.runner.neverDispatched(h.dispatch)), true);
  assert.equal(h.db.campaignBudgets.active(h.reviewerId), false);
});

test("running x root deletion: the review goes with its campaign, and the orphaned reviewer still settles", async (t) => {
  const h = await dispatched(t);
  h.db.deleteSession("root");
  assert.equal(h.video.reviewStore.getReview(h.dispatch.grant.reviewId), null);
  const reviewer = h.principal(h.reviewerId, false);
  assert.throws(() => h.video.reviewService.deliverBatch(reviewer, h.dispatch.grant.reviewId, 0,
    pacedVideoReviewWindowPlan(h.dispatch.grant.frames).windows[0]!.endIndex));
  assert.equal(h.db.campaignBudgets.active(h.reviewerId), true, "deletion never refunds a possibly running reviewer");
  assert.equal(await h.video.delegated.onFinished("r", h.runner.finished(h.dispatch, { priced: true, costUsd: 0.1 })), true);
  assert.equal(h.db.campaignBudgets.active(h.reviewerId), false);
  assert.ok(isTerminal(h.db.getSession(h.reviewerId)!.status));
});

// ---- Orphan axis (round 4): a dispatched or running reviewer whose subject is gone or detached. ----

const settlements = (h: { db: ControlPlaneDb }, id: string) =>
  h.db.raw().prepare("SELECT COUNT(*) AS n FROM campaign_budget_settlements WHERE session_id=?").get(id)!.n;
const stops = (h: { sent: ControlPlaneToRunner[] }, id: string) =>
  h.sent.filter((m) => m.type === "media_review_stop" && m.request.sessionId === id).length;
const unknown = (h: Awaited<ReturnType<typeof dispatched>>) => {
  const body = { ...h.runner.fence(h.dispatch), outcome: "unknown" as const, deliveryPlanSha256: "" };
  return { ...body, receiptSha256: sha(json(body)) };
};

for (const subject of ["child", "root"] as const) {
  test(`orphaned running x ${subject} deletion, lost result, reconnect: read back, stopped, settled exactly once`, async (t) => {
    const h = await dispatched(t);
    h.db.deleteSession(subject); // Its finished message is then lost around a disconnect.
    assert.equal(h.video.delegated.readback("r"), 1, "registration reads back the orphan from its own record");
    assert.deepEqual(h.readbacks().map((m) => m.identity), [h.dispatch.identity]);
    assert.equal(stops(h, h.reviewerId), 1, "a running orphan can produce nothing usable, so it is stopped");
    const finished = h.runner.finished(h.dispatch, { priced: true, costUsd: 0.4 });
    assert.equal(await h.video.delegated.onFinished("r", finished), true);
    assert.equal(await h.video.delegated.onFinished("r", finished), true, "a replayed result is accepted idempotently");
    assert.equal(settlements(h, h.reviewerId), 1, "settled exactly once");
    assert.equal(h.db.campaignBudgets.active(h.reviewerId), false);
    assert.ok(isTerminal(h.db.getSession(h.reviewerId)!.status));
    assert.equal(h.video.delegated.readback("r"), 0, "a settled orphan is never read back again");
  });
}

test("orphaned dispatched x child deletion, lost fence, reconnect: the runner's readback fence releases it once", async (t) => {
  const h = await dispatched(t, false);
  h.db.deleteSession("child");
  assert.equal(h.video.delegated.readback("r"), 1);
  assert.equal(stops(h, h.reviewerId), 0, "an unacknowledged command is fenced by readback, not stopped");
  const fence = h.runner.neverDispatched(h.dispatch);
  assert.equal(await h.video.delegated.onNeverDispatched("r", fence), true);
  assert.equal(await h.video.delegated.onNeverDispatched("r", fence), false, "a replayed fence changes nothing");
  assert.equal(h.db.campaignBudgets.active(h.reviewerId), false);
  assert.equal(h.db.getSession(h.reviewerId)?.status, "stopped");
  assert.equal(h.video.delegated.readback("r"), 0);
});

test("orphaned provisionally stopped x lost reviewer: unknown ends it once, retains its reservation and stops accounting", async (t) => {
  const h = await dispatched(t);
  h.db.deleteSession("child");
  provisional(h, h.reviewerId, "runner_disconnect");
  assert.equal(h.video.delegated.readback("r"), 1);
  assert.equal(await h.video.delegated.onDispatchReceipt("r", unknown(h)), true);
  assert.equal(h.db.getSession(h.reviewerId)?.status, "stopped");
  assert.notEqual(h.db.sessionStopProvenance(h.reviewerId)?.confirmation, null, "the stop is confirmed, so it is not open");
  assert.equal(h.sessions.dedicatedMediaReviewerOpen(h.reviewerId), false);
  assert.equal(h.db.campaignBudgets.active(h.reviewerId), true, "unknown usage is retained, never refunded");
  assert.equal(h.db.campaignBudgets.view("root")?.state, "accounting_unavailable");
  assert.equal(await h.video.delegated.onDispatchReceipt("r", unknown(h)), true, "a repeated answer changes nothing");
  assert.equal(h.video.delegated.readback("r"), 0, "a lost reviewer is never read back or restored");
  assert.equal(await h.video.delegated.onDispatchReceipt("r", h.runner.accepted(h.dispatch)), true);
  assert.equal(h.db.getSession(h.reviewerId)?.status, "stopped");
  assert.equal(h.sessions.setArchived(h.reviewerId, true).ok, true, "a closed orphan can be archived");
});

test("detached running x ownership revocation, reconnect: the reviewer is stopped and its end settles once", async (t) => {
  const h = await dispatched(t);
  h.db.raw().prepare("UPDATE workflow_decisions SET status='revoked' WHERE occurrence_id='original-gate'").run();
  const reviewer = h.principal(h.reviewerId, false);
  assert.throws(() => h.video.reviewService.deliverBatch(reviewer, h.dispatch.grant.reviewId, 0,
    pacedVideoReviewWindowPlan(h.dispatch.grant.frames).windows[0]!.endIndex));
  assert.equal(h.video.delegated.readback("r"), 1);
  assert.equal(stops(h, h.reviewerId), 1, "a reviewer whose review was revoked is stopped");
  assert.equal(await h.video.delegated.onFinished("r", h.runner.finished(h.dispatch, { priced: true, costUsd: 0.2 })), true);
  assert.equal(settlements(h, h.reviewerId), 1);
  assert.equal(h.db.getSession(h.reviewerId)?.status, "stopped", "a Stopped reviewer never completes");
});

test("lost reviewer with its subject intact: the owner sees reviewer_lost and the review is revoked", async (t) => {
  const h = await dispatched(t);
  assert.equal(await h.video.delegated.onDispatchReceipt("r", unknown(h)), true);
  assert.equal(h.video.reviewStore.getReview(h.dispatch.grant.reviewId)?.status, "revoked");
  const state = h.video.delegated.provenance(h.owner, h.dispatch.grant.reviewId) as { ok: boolean; code: string };
  assert.deepEqual([state.ok, state.code], [false, "reviewer_lost"]);
});

test("attach on restart reads back outstanding reviewers without waiting for a registration", async (t) => {
  const h = await dispatched(t);
  h.db.deleteSession("child");
  const before = h.readbacks().length;
  const restarted = composeHostingVideoEvidence(h.db, { clock: () => h.now(), schedule: () => setTimeout(() => {}, 0) });
  const sent: ControlPlaneToRunner[] = [];
  restarted.attach(h.sessions, { sendToRunner: (_r, m) => { sent.push(m); return true; }, isRunnerOnline: () => true, sessionChangedById: () => {} });
  t.after(() => restarted.delegated.close());
  assert.equal(sent.filter((m) => m.type === "media_review_readback").length, 1);
  assert.equal(h.readbacks().length, before);
});

// ---- Accounting persistence and in-flight launch orphans (round 4 findings). ----

for (const subject of ["kept", "child"] as const) {
  test(`finished x crash before settlement (${subject} subject): nothing commits, and readback recovers it exactly once`, async (t) => {
    const h = await dispatched(t);
    if (subject === "child") h.db.deleteSession("child");
    const budgets = h.db.campaignBudgets as unknown as { settleMediaReview: (...args: unknown[]) => boolean };
    const settle = budgets.settleMediaReview;
    budgets.settleMediaReview = () => { throw new Error("injected crash after the status write"); };
    const finished = h.runner.finished(h.dispatch, { priced: true, costUsd: 0.3 });
    assert.equal(await h.video.delegated.onFinished("r", finished), false);
    budgets.settleMediaReview = settle;
    assert.equal(isTerminal(h.db.getSession(h.reviewerId)!.status), false, "the terminal status rolled back with the failed settlement");
    assert.equal(h.video.delegated.readback("r"), 1, "an unaccounted reviewer is still read back after restart");
    assert.equal(await h.video.delegated.onFinished("r", finished), true);
    assert.equal(await h.video.delegated.onFinished("r", finished), true);
    assert.equal(settlements(h, h.reviewerId), 1, "settled exactly once");
    assert.equal(h.db.campaignBudgets.active(h.reviewerId), false);
    assert.equal(h.video.delegated.readback("r"), 0);
  });
}

test("terminal status from any other path never hides an unaccounted reviewer from readback", async (t) => {
  const h = await dispatched(t);
  h.db.updateSessionStatus(h.reviewerId, "stopped", Date.now(), { cause: "runner_reported", confirmation: "runner_terminal" });
  assert.equal(h.video.delegated.readback("r"), 1, "eligibility follows the accounting disposition, not the Session status");
  assert.equal(await h.video.delegated.onFinished("r", h.runner.finished(h.dispatch, { priced: true, costUsd: 0.3 })), true);
  assert.equal(settlements(h, h.reviewerId), 1);
  assert.equal(h.db.getSession(h.reviewerId)?.status, "stopped", "a closed reviewer is never reopened to completed");
});

test("lost x crash inside the transition: nothing commits, and a repeated unknown accounts it exactly once", async (t) => {
  const h = await dispatched(t);
  const budgets = h.db.campaignBudgets as unknown as { stop: (...args: unknown[]) => void };
  const stop = budgets.stop;
  budgets.stop = () => { throw new Error("injected crash after the status write"); };
  await h.video.delegated.onDispatchReceipt("r", unknown(h)).catch(() => false);
  budgets.stop = stop;
  assert.equal(h.db.getSession(h.reviewerId)?.status, "running", "the lost status rolled back");
  assert.equal(h.video.delegated.readback("r"), 1);
  assert.equal(await h.video.delegated.onDispatchReceipt("r", unknown(h)), true);
  assert.equal(h.db.getSession(h.reviewerId)?.status, "stopped");
  assert.equal(h.db.campaignBudgets.view("root")?.state, "accounting_unavailable");
  assert.equal(h.video.delegated.readback("r"), 0, "its retained unknown disposition is final");
});

for (const subject of ["child", "root"] as const) {
  test(`orphaned launch whose acknowledgement was lost x ${subject} deletion: the late accepted readback stops it`, async (t) => {
    const h = await dispatched(t, false);
    h.db.deleteSession(subject);
    assert.equal(h.video.delegated.readback("r"), 1);
    assert.equal(stops(h, h.reviewerId), 0, "an unacknowledged launch is not stopped before it is known to run");
    const body = { ...h.runner.fence(h.dispatch), outcome: "accepted" as const, deliveryPlanSha256: "" };
    assert.equal(await h.video.delegated.onDispatchReceipt("r", { ...body, receiptSha256: sha(json(body)) }), true);
    assert.equal(stops(h, h.reviewerId), 1, "the exact worker receives the dedicated Stop");
    const reviewer = h.principal(h.reviewerId, false);
    assert.throws(() => h.video.reviewService.deliverBatch(reviewer, h.dispatch.grant.reviewId, 0,
      pacedVideoReviewWindowPlan(h.dispatch.grant.frames).windows[0]!.endIndex), "media access stays denied");
    assert.equal(await h.video.delegated.onFinished("r", h.runner.finished(h.dispatch, { priced: true, costUsd: 0.2 })), true);
    assert.equal(settlements(h, h.reviewerId), 1);
  });
}

test("detached launch whose acknowledgement was lost x ownership revocation: the late accepted readback stops it", async (t) => {
  const h = await dispatched(t, false);
  h.db.raw().prepare("UPDATE workflow_decisions SET status='revoked' WHERE occurrence_id='original-gate'").run();
  assert.equal(await h.video.delegated.onDispatchReceipt("r", h.runner.accepted(h.dispatch)), true);
  assert.equal(stops(h, h.reviewerId), 1);
});

test("never-dispatched x crash between release and requeue: the subject is re-derived from the durable outcome", async (t) => {
  const h = await dispatched(t, false);
  const ledger = (h.video.delegated as unknown as { ledger: { save: (row: { state: string }) => void } }).ledger;
  const save = ledger.save.bind(ledger);
  ledger.save = (row) => { if (row.state === "queued") throw new Error("injected crash after the release"); save(row); };
  await assert.rejects(h.video.delegated.onNeverDispatched("r", h.runner.neverDispatched(h.dispatch), "host_busy"));
  ledger.save = save;
  assert.equal(h.db.campaignBudgets.active(h.reviewerId), false, "the release itself committed");
  const state = await h.video.delegated.prepare(h.owner, h.request) as { status: string; reason: string };
  assert.deepEqual([state.status, state.reason], ["pending", "host_busy"], "the persisted reason requeues it, not a stuck dispatch");
  assert.equal(h.dispatches().length, 1, "nothing was re-dispatched early");
});

test("busy deadline x crash, then recovery past 20 minutes: anchored to the first busy observation, never reset", async (t) => {
  const h = await dispatched(t, false);
  const ledger = (h.video.delegated as unknown as { ledger: { save: (row: { state: string }) => void } }).ledger;
  const save = ledger.save.bind(ledger);
  ledger.save = (row) => { if (row.state === "queued") throw new Error("injected crash after the release"); save(row); };
  await assert.rejects(h.video.delegated.onNeverDispatched("r", h.runner.neverDispatched(h.dispatch), "host_busy"));
  ledger.save = save;
  const members = () => h.db.raw().prepare("SELECT COUNT(*) AS n FROM campaign_budget_members").get()!.n;
  const before = members();
  h.advance(21 * 60_000); // The process stayed down past the limit before recovering.
  h.video.delegated.readback("r");
  assert.deepEqual(await h.video.delegated.prepare(h.owner, h.request), { ok: false, code: "reviewer_busy_exhausted",
    reason: "The reviewer host stayed busy through every bounded retry; video evidence stays with the Human." });
  assert.equal(h.timers.length, 0, "no retry is queued");
  assert.equal(h.dispatches().length, 1, "no new dispatch");
  assert.equal(members(), before, "no new reservation");
});

test("busy deadline x requeues and a restart: later busy refusals keep the first observation as the anchor", async (t) => {
  const h = await harness(t);
  await h.video.delegated.prepare(h.owner, h.request);
  assert.equal(await h.video.delegated.onNeverDispatched("r", h.runner.neverDispatched(h.dispatches().at(-1)!), "host_busy"), true);
  const first = h.now();
  h.advance(30_000); await h.runScheduledRetry();
  // A restart in between: a fresh composition over the same database resumes the subject.
  const restarted = composeHostingVideoEvidence(h.db, { clock: () => h.now(), schedule: () => setTimeout(() => {}, 0) });
  restarted.attach(h.sessions, { sendToRunner: () => true, isRunnerOnline: () => true, sessionChangedById: () => {} });
  t.after(() => restarted.delegated.close());
  h.advance(5 * 60_000);
  assert.equal(await restarted.delegated.onNeverDispatched("r", h.runner.neverDispatched(h.dispatches().at(-1)!), "host_busy"), true);
  const row = h.db.raw().prepare("SELECT record FROM delegated_video_reviews").get() as { record: string };
  assert.equal((JSON.parse(row.record) as { firstBusyAt: number }).firstBusyAt, first, "the anchor never moves");
});

test("preparation refuses specifically before reserving anything", async (t) => {
  const noProof = await harness(t, { proof: false });
  assert.deepEqual(await noProof.video.delegated.prepare(noProof.owner, noProof.request),
    { ok: false, code: "live_validation", reason: "No current Human-inspected live validation proof covers this reviewer." });
  const mixed = await harness(t, { childContract: false });
  assert.equal((await mixed.video.delegated.prepare(mixed.owner, mixed.request) as { code: string }).code, "mixed_peer");
  const h = await harness(t);
  for (const principal of [{ ...h.owner, orchestrator: false }, { ...h.owner, credentialSessionId: "child" }]) {
    assert.equal((await h.video.delegated.prepare(principal, h.request) as { code: string }).code, "not_authorized");
  }
  assert.equal((await h.video.delegated.prepare(h.owner, { ...h.request, evidenceId: "missing" }) as { code: string }).code, "not_authorized");
  for (const fixture of [noProof, mixed, h]) {
    assert.equal(fixture.dispatches().length, 0);
    assert.equal(fixture.db.raw().prepare("SELECT COUNT(*) AS n FROM prepared_media_sessions").get()!.n, 0);
  }
});

test("the campaign projection reports delegated video review from the same server facts as gate ownership", async (t) => {
  const h = await harness(t);
  assert.equal(h.db.campaignProjection("root")!.videoEvidenceReview, undefined, "without the Session service's source there is no fact");
  h.db.setCampaignVideoReviewSource((id, owner) => h.sessions.campaignVideoReview(id, owner));
  const video = () => h.db.campaignProjection("root")!.videoEvidenceReview;
  assert.equal(h.db.campaignProjection("root")!.decisionOwners.ui_evidence_approval, "orchestrator");
  assert.equal(video()?.status, "available", JSON.stringify(video()));
  assert.match(video()!.reason, /certified media-only reviewer/u);
  h.revokeProof();
  assert.deepEqual(video(), { status: "unavailable",
    reason: "Video evidence comes to you because no current live proof certifies the media-only reviewer on the Orchestrator's machine." });
  assert.equal(h.sessions.campaignVideoReview("root", "human")?.reason,
    "Video evidence comes to you because UI evidence approval is not delegated to the Orchestrator.");
  assert.equal(h.sessions.campaignVideoReview("child", "orchestrator"), null, "only a Full Control campaign root has the fact");
});

test("a campaign without a live proof reports video as the Human's with the missing proof named", async (t) => {
  const h = await harness(t, { proof: false });
  assert.deepEqual(h.sessions.campaignVideoReview("root", "orchestrator"), { status: "unavailable",
    reason: "Video evidence comes to you because no current live proof certifies the media-only reviewer on the Orchestrator's machine." });
});
