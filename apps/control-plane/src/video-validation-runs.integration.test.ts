import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import Fastify from "fastify";
import { DEFAULT_ORCHESTRATOR_DEFAULTS, HUMAN_ONLY_PARENT_CONTROL_POLICY, PACED_VIDEO_REVIEW_CONTRACT_ID, PROTOCOL_VERSION,
  pacedVideoReviewWindowPlan, type ControlPlaneToRunner, type MediaReviewDispatch, type MediaReviewFinished,
  type RunnerMetadata } from "@wollipog/protocol";
import { ControlPlaneDb } from "./db.js";
import { mintCampaignEvidenceAuthority } from "./evidence-authority.js";
import { composeHostingVideoEvidence, registerHostingVideoEvidenceRoutes } from "./hosting-video-evidence.js";
import { Hub } from "./hub.js";
import type { AgentPrincipal, AuthPrincipal, HumanPrincipal } from "./identity.js";
import { resolveOrchestratorCampaignPolicy } from "./orchestrator-settings.js";
import { SessionsService, normalizeWorkflowDecisionSnapshot } from "./sessions.js";
import type { VideoPreparationResult } from "./video-evidence-preparation.js";
import type { VideoReviewDecoder } from "./video-evidence-runtime.js";
import { syntheticInspectedVideoRuns, syntheticMediaReviewerAttestation } from "./video-live-validation-test-fixture.js";

/** Human video validation runs (#1321) end to end over a real database, the real SessionsService,
 * the hosting composition and its HTTP routes. The runner is simulated at its message boundary and a
 * disclosed synthetic decoder stands in for ffmpeg, so nothing here is live delivery, model
 * recognition, usage or a blind oracle. It proves the permit, admission and inspection contracts. */
const sha = (value: string | Buffer) => createHash("sha256").update(value).digest("hex");
const json = (value: unknown) => JSON.stringify(value);
const source = readFileSync(new URL("../test-fixtures/video-preparation-paced.webm", import.meta.url));
const attestation = syntheticMediaReviewerAttestation("claude");
const commitment = sha("disclosed synthetic oracle commitment, never a blind oracle");

/** 360 tiny frames over exactly 12 s at 1280x720: the paced validation envelope. */
const syntheticDecoder: VideoReviewDecoder = {
  paced: async (bytes, mediaType): Promise<VideoPreparationResult> => {
    const images = Array.from({ length: 360 }, (_, i) => Buffer.from(`synthetic validation frame ${i}`));
    let pts = 0;
    const frames = images.map((image, index) => {
      const durationUs = index < 240 ? 33_333 : 33_334;
      const frame = { index, ptsUs: pts, durationUs, sha256: sha(image), sizeBytes: image.length };
      pts += durationUs;
      return frame;
    });
    const manifest = { schemaVersion: 1 as const, purpose: "offline_preparation_only" as const,
      profile: "paced-silent-video-preparation-v1" as const, sourceSha256: sha(bytes), sourceSizeBytes: bytes.length,
      sourceMediaType: mediaType, width: 1280, height: 720, durationUs: pts, frames,
      segments: [{ index: 0, firstFrame: 0, frameCount: 360, startUs: 0, endUs: pts }] };
    return { ok: true, manifest, manifestSha256: sha(json(manifest)), images };
  },
  candidate: async () => ({ ok: false, code: "decoder_unavailable", reason: "No candidate decoder in this test.", retryable: false }),
};

async function harness(t: { after(fn: () => unknown): void }) {
  const db = ControlPlaneDb.open(":memory:");
  const identity = db.localIdentityContext();
  const owner: HumanPrincipal = { ...identity, kind: "human", actorId: identity.userId, role: "owner" };
  const audience = { organizationId: owner.organizationId, owner: { kind: "user" as const, userId: owner.userId } };
  const contract = { id: PACED_VIDEO_REVIEW_CONTRACT_ID, revision: 1 as const };
  const agent = (id: string, attested: boolean) => ({ id, name: "Synthetic Claude", command: "claude", args: [], env: {}, driver: "claude-code" as const,
    available: true, capabilities: { models: [{ id: "claude-opus-5-5", displayName: "Synthetic", default: true, inputModalities: ["text", "image"] as Array<"text" | "image"> }],
      effortLevels: ["high"], slashCommands: [], supportsImages: true, supportsApprovals: true, imageToolResults: true,
      permissionModes: ["default"], pacedVideoReviewContract: contract,
      ...(attested ? { mediaReviewerAttestation: { ...attestation, agentId: id } } : {}) } });
  const metadata: RunnerMetadata = { runnerId: "r", hostname: "synthetic", os: "linux", version: "test",
    workspaces: [{ id: "w", name: "Repo", path: "/synthetic-repo" }], agents: [agent("claude", true), agent("child-agent", false)] };
  db.registerRunner(metadata, 1, PROTOCOL_VERSION);
  db.setUsageRateTable(new Map([["claude-opus-5-5", { inputCostPerToken: 0.000001, outputCostPerToken: 0.000001,
    cacheReadCostPerToken: 0.000001, cacheCreationCostPerToken: 0.000001 }]]));
  const policy = resolveOrchestratorCampaignPolicy(DEFAULT_ORCHESTRATOR_DEFAULTS, "system_default");
  policy.issueScope = { repository: "picoduck/wollipog", issueNumbers: [1321], revision: 1, authorizedByUserId: owner.userId, authorizedAt: 1 };
  policy.issueNumbers = [1321];
  db.createSession({ id: "root", runnerId: "r", workspaceId: "w", agentId: "claude", title: "Synthetic Root", useWorktree: false,
    driver: "claude-code", config: { model: "claude-opus-5-5" }, scope: audience, creationActor: "human", role: "orchestrator",
    orchestratorPolicy: policy, parentControlPolicy: { decisions: { ...HUMAN_ONLY_PARENT_CONTROL_POLICY } }, now: 2 });
  db.updateSessionStatus("root", "running", 3);
  const hub = new Hub(db), sent: ControlPlaneToRunner[] = [];
  hub.isRunnerOnline = () => true; hub.sendToRunner = (_, message) => { sent.push(message); return true; };
  hub.sessionChanged = () => {}; hub.sessionChangedById = () => {};
  const log = { info() {}, warn() {}, error() {} };
  assert.ok(new SessionsService(db, hub, log).setCampaignControl("root", { mode: "full_control", objective: "Certify the video reviewer",
    operations: ["ui_evidence_approval"], delegatablePolicyIds: [], budgetAuthority: { version: 1, accounting: "managed_workers_only",
      unpriced: "stop", toolCalls: 1000, costUsd: 200, concurrency: 3 } }, 1, owner).ok);
  const rootPolicy = db.getSession("root")!.orchestratorPolicy!;
  const boundary = rootPolicy.control!.mode === "full_control" ? rootPolicy.control!.boundary : assert.fail("No fixture boundary");
  const disclosures = {
    destination: () => ({ organizationId: owner.organizationId, privacy: "private" as const, disclosureRevision: 1 }),
    provider: () => ({ disclosureRevision: 1, retentionDisclosure: "Synthetic test disclosure.",
      reviewers: [{ driver: "claude-code" as const, modelId: "claude-opus-5-5" }] }),
  };
  boundary.evidenceAuthority = mintCampaignEvidenceAuthority(owner, boundary, "root", { destinationConfigurationId: "synthetic-private",
    destinationDisclosureRevision: 1, providers: [{ providerId: "claude-code", disclosureRevision: 1,
      reviewers: [{ driver: "claude-code", modelId: "claude-opus-5-5" }] }] }, disclosures)!;
  assert.ok(boundary.evidenceAuthority);
  // Fixture-only Human boundary composition, as the delegated integration harness does.
  db.raw().prepare("UPDATE sessions SET orchestrator_policy=? WHERE id='root'").run(JSON.stringify(rootPolicy));
  db.createSession({ id: "child", parentSessionId: "root", runnerId: "r", workspaceId: "w", agentId: "child-agent", title: "Synthetic Child",
    useWorktree: false, driver: "claude-code", scope: audience, config: { model: "claude-opus-5-5", costBudgetUsd: 2, maxToolCalls: 10 }, now: 4 });
  db.updateSessionStatus("child", "running", 5);
  db.createWorkflowArtifactBytes({ artifactId: "source", sessionId: "child", kind: "video", name: "Paced.webm", mimeType: "video/webm",
    encoding: "base64", sha256: sha(source), sizeBytes: source.length, createdBy: { kind: "agent", id: "child" },
    metadata: { purpose: "session_attachment" }, createdAt: 6 }, source);
  const normalized = normalizeWorkflowDecisionSnapshot({ category: "ui_evidence_approval",
    evidence: [{ evidenceId: "paced-capture", artifactId: "source", sha256: sha(source), mediaType: "video/webm" }] });
  assert.ok(normalized.ok && normalized.data);
  // No proof exists, so the video gate stays with the Human: the original occurrence is Human-owned.
  assert.ok(db.createWorkflowDecision({ requestId: "synthetic-ui", occurrenceId: "paced-gate", sessionId: "child",
    controllingSessionId: "root", category: "ui_evidence_approval", resourceKey: "synthetic", resourceSnapshot: normalized.data,
    resourceDigest: sha(json(normalized.data)), policyRevision: boundary.revision, authority: "human", createdAt: 7 }));

  let now = Date.now();
  const video = composeHostingVideoEvidence(db, { decoder: syntheticDecoder, clock: () => now,
    schedule: (run, ms) => setTimeout(run, ms + 3_600_000) });
  const sessions = new SessionsService(db, hub, log, undefined, undefined, undefined, undefined, undefined, undefined, false, undefined,
    video.preparedMediaRuntime, video.workflowVideoApprovals, disclosures, video.operatorValidationPermits, video.preparedMediaActiveStops);
  video.attach(sessions, hub);
  const agentPrincipal = (id: string, orchestrator: boolean): AgentPrincipal => ({ kind: "agent", actorId: id, credentialSessionId: id,
    orchestrator, organizationId: owner.organizationId, delegatedScope: audience });
  const principals: Record<string, AuthPrincipal> = { owner, admin: { ...owner, role: "admin" as const, userId: "other-admin", actorId: "other-admin" },
    member: { ...owner, role: "operator" as const }, orchestrator: agentPrincipal("root", true), child: agentPrincipal("child", false) };
  const server = Fastify();
  registerHostingVideoEvidenceRoutes(server, { video, requestPrincipal: (req) => {
    const as = String(req.headers["x-fixture-principal"]);
    return principals[as] ?? (as.startsWith("reviewer:") ? agentPrincipal(as.slice("reviewer:".length), false) : null);
  } });
  t.after(async () => { await server.close(); video.delegated.close(); db.close(); });
  const call = async (as: string | null, method: "GET" | "POST", url: string, payload?: unknown) => {
    const response = await server.inject({ method, url, headers: as ? { "x-fixture-principal": as } : {},
      ...(payload === undefined ? {} : { payload: payload as object }) });
    return { status: response.statusCode, body: response.json() as Record<string, any> };
  };
  const preview = (as: string | null = "owner", profile = "paced") => call(as, "POST", "/api/video-evidence/validation-permits/preview",
    { occurrenceId: "paced-gate", evidenceId: "paced-capture", profile, privateOracleCommitmentSha256: commitment });
  const mint = (as: string, previewed: Record<string, any>, expiresAt = now + 30 * 60_000, scopeSha256 = previewed.scopeSha256) =>
    call(as, "POST", "/api/video-evidence/validation-permits", { identity: previewed.identity, subject: previewed.subject,
      expectedScopeSha256: scopeSha256, expiresAt });
  const dispatches = () => sent.filter((m): m is Extract<ControlPlaneToRunner, { type: "media_review_dispatch" }> => m.type === "media_review_dispatch")
    .map((m) => m.dispatch);
  const runner = {
    fence: (dispatch: MediaReviewDispatch) => { const { childSessionId: _child, ...fence } = dispatch.identity; return fence; },
    accepted: (dispatch: MediaReviewDispatch) => {
      const body = { ...runner.fence(dispatch), outcome: "accepted" as const, deliveryPlanSha256: dispatch.deliveryPlanSha256,
        namespaceLaunchSha256: sha("synthetic actual launch") };
      return { ...body, receiptSha256: sha(json(body)) };
    },
    finished: (dispatch: MediaReviewDispatch): MediaReviewFinished => {
      const body = { ...runner.fence(dispatch), deliveryPlanSha256: dispatch.deliveryPlanSha256, outcome: "completed" as const,
        windowsCompleted: pacedVideoReviewWindowPlan(dispatch.grant.frames).windows.length, verdictConfirmed: true, toolCalls: 20,
        costUsd: 1.25, priced: true };
      return { ...body, receiptSha256: sha(json(body)) };
    },
  };
  /** The reviewer's media calls, window by window over HTTP, then its verdict. */
  const review = async (dispatch: MediaReviewDispatch) => {
    const as = `reviewer:${dispatch.grant.reviewerSessionId}`, base = `/api/sessions/${dispatch.grant.reviewerSessionId}/video-evidence-review`;
    for (const window of pacedVideoReviewWindowPlan(dispatch.grant.frames).windows) {
      for (let cursor = window.firstIndex; cursor < window.endIndex;) {
        const batch = await call(as, "POST", `${base}/frames`, { reviewId: dispatch.grant.reviewId, index: cursor, end: window.endIndex });
        assert.equal(batch.status, 200, json(batch.body));
        const acknowledged = await call(as, "POST", `${base}/acknowledge-frames`, { reviewId: dispatch.grant.reviewId,
          receipts: batch.body.deliveries.map((d: any) => ({ receiptId: d.receipt.receiptId, sha256: d.receipt.sha256 })) });
        assert.equal(acknowledged.status, 200, json(acknowledged.body));
        cursor = batch.body.nextIndex;
      }
    }
    return call(as, "POST", `${base}/verdict`, { reviewId: dispatch.grant.reviewId, report: { outcome: "accept",
      rationale: "Disclosed synthetic contract answer only.",
      criteria: [{ criterionId: "every_frame_in_order", outcome: "pass", observedFrameIndices: [0, 359], observation: "Synthetic." },
        { criterionId: "transient_overlays", outcome: "pass", observedFrameIndices: [42], observation: "Synthetic: a red rectangle at frame 42." }] } });
  };
  return { db, video, sessions, sent, call, preview, mint, dispatches, runner, review, owner,
    advance: (ms: number) => { now += ms; }, now: () => now };
}

test("only an owner or admin reaches the validation routes; Session credentials and members are refused", async (t) => {
  const h = await harness(t);
  for (const as of [null, "member", "orchestrator", "child", "reviewer:anything"]) {
    assert.equal((await h.preview(as)).status, 403, `preview as ${as}`);
    assert.equal((await h.call(as, "POST", "/api/video-evidence/validation-permits", {})).status, 403, `mint as ${as}`);
    assert.equal((await h.call(as, "POST", "/api/video-evidence/validation-permits/any/run")).status, 403, `run as ${as}`);
    assert.equal((await h.call(as, "GET", "/api/video-evidence/validation-permits/any")).status, 403, `inspect as ${as}`);
    assert.equal((await h.call(as, "POST", "/api/video-evidence/validation-permits/any/revoke")).status, 403, `revoke as ${as}`);
    assert.equal((await h.call(as, "POST", "/api/video-evidence/live-validations", {})).status, 403, `record as ${as}`);
  }
  assert.equal(h.db.raw().prepare("SELECT COUNT(*) AS n FROM operator_video_validation_permits").get()!.n, 0);
});

test("a Human mints a permit for the exact previewed scope, runs it once, inspects it and records the proof", async (t) => {
  const h = await harness(t);
  assert.equal(h.video.readiness().available ? "available" : (h.video.readiness() as { code: string }).code, "live_validation");

  // Preview derives the source once with the server decoder and refuses a profile it does not fit.
  assert.equal((await h.preview("owner", "maximum")).body.code, "preparation", "a 360-frame source is not the 900-frame profile");
  assert.equal((await h.preview("owner", "candidate")).body.code, "preparation");
  const previewed = await h.preview();
  assert.equal(previewed.status, 200, json(previewed.body));
  const scope = previewed.body.scope;
  assert.equal(scope.gate.authority, "human");
  assert.equal(scope.source.privateOracleCommitmentSha256, commitment, "the Human's commitment is pinned before any dispatch");
  assert.equal(scope.source.frames, 360);
  assert.deepEqual([scope.target.driver, scope.target.modelId, scope.target.effort, scope.target.providerId],
    ["claude-code", "claude-opus-5-5", "high", "claude-code"]);
  assert.equal(scope.request.config.costBudgetUsd, 10);
  assert.equal(scope.request.config.maxToolCalls, 120);

  // Mint refuses a changed scope, an expiry over an hour, and a Human who did not establish the boundary.
  assert.equal((await h.mint("owner", previewed.body, h.now() + 30 * 60_000, sha("another scope"))).status, 409);
  assert.equal((await h.mint("owner", previewed.body, h.now() + 61 * 60_000)).status, 409);
  assert.equal((await h.mint("admin", previewed.body)).status, 409, "only the Human who established the boundary mints");
  const minted = await h.mint("owner", previewed.body);
  assert.equal(minted.status, 201, json(minted.body));
  const permitId = minted.body.permit.permitId as string;
  assert.equal((await h.mint("owner", previewed.body)).status, 409, "a replayed mint for the same evidence and profile is refused");
  assert.equal((await h.call("owner", "GET", `/api/video-evidence/validation-permits/${permitId}`)).body.status, "minted");

  // Another admin cannot start, inspect or revoke the owner's permit.
  assert.equal((await h.call("admin", "POST", `/api/video-evidence/validation-permits/${permitId}/run`)).status, 403);
  assert.equal((await h.call("admin", "GET", `/api/video-evidence/validation-permits/${permitId}`)).status, 403);
  assert.equal((await h.call("admin", "POST", `/api/video-evidence/validation-permits/${permitId}/revoke`)).status, 409);

  const started = await h.call("owner", "POST", `/api/video-evidence/validation-permits/${permitId}/run`);
  assert.equal(started.status, 200, json(started.body));
  assert.equal(started.body.status, "dispatched");
  const [dispatch] = h.dispatches();
  assert.ok(dispatch);
  assert.deepEqual(dispatch.grant.operatorValidation, { permitId, scopeSha256: minted.body.permit.scopeSha256 });
  assert.deepEqual(dispatch.command.spec.mediaReviewPurpose?.operatorValidation, dispatch.grant.operatorValidation);
  assert.equal(dispatch.command.spec.config?.model, "claude-opus-5-5");
  assert.equal(dispatch.command.spec.config?.effort, "high");
  assert.equal(dispatch.grant.frames.length, 360);
  assert.ok(dispatch.grant.expiresAt <= h.now() + 30 * 60_000, "the grant never outlives its permit");
  const again = await h.call("owner", "POST", `/api/video-evidence/validation-permits/${permitId}/run`);
  assert.equal(again.body.status, "dispatched", "starting again reports the same run");
  assert.equal(h.dispatches().length, 1, "and never dispatches a second reviewer");

  assert.equal(await h.video.delegated.onDispatchReceipt("r", h.runner.accepted(dispatch)), true);
  // Before any proof exists, the run's own reviewer reaches the media routes; the owner routes still refuse.
  const prepare = await h.call("orchestrator", "POST", "/api/sessions/root/video-evidence-review/prepare",
    { childSessionId: "child", occurrenceId: "paced-gate", evidenceId: "paced-capture" });
  assert.equal(prepare.body.code, "live_validation");
  const verdict = await h.review(dispatch);
  assert.equal(verdict.status, 200, json(verdict.body));
  assert.equal(verdict.body.operatorValidation.permitId, permitId);
  assert.equal((await h.call("owner", "GET", `/api/video-evidence/validation-permits/${permitId}`)).body.status, "dispatched",
    "a verdict is not inspectable until the reviewer's priced usage settles");
  assert.equal(await h.video.delegated.onFinished("r", h.runner.finished(dispatch)), true);

  const inspected = await h.call("owner", "GET", `/api/video-evidence/validation-permits/${permitId}`);
  assert.equal(inspected.status, 200, json(inspected.body));
  assert.equal(inspected.body.status, "complete", json(inspected.body));
  assert.equal(inspected.body.verdict.criteria[1].observation, "Synthetic: a red rectangle at frame 42.");
  const run = inspected.body.run;
  assert.equal(run.kind, "paced");
  assert.equal(run.privateOracleCommitmentSha256, commitment);
  assert.equal(run.actualCostUsd, 1.25);
  assert.equal(run.inspectedByUserId, h.owner.userId);
  assert.equal(run.blindOracleMatched, null, "the Human adjudicates the oracle; the server never claims it");
  assert.equal(h.video.workflowVideoApprovals !== undefined, true);

  // The Human completes the run from evidence outside Wollipog and records it with two other runs.
  const completed = { ...run, usageEvidenceSha256: sha("usage export"), pricingEvidenceSha256: sha("pricing page"),
    oracleIsolationEvidenceSha256: sha("namespace probe output"), actualInputTokens: 120_000, actualOutputTokens: 900,
    allSourceFramesDelivered: true, blindOracleMatched: true, privateOracleExcludedFromReviewerContext: true,
    oracleNamespaceInaccessibleVerified: true, providerUsageVerified: true, currentOfficialPricingVerified: true,
    sourceAndArtifactsStillMatch: true };
  // Disclosed synthetic stand-ins for the candidate and maximum runs, which this fixture does not run.
  const others = syntheticInspectedVideoRuns(run.target, h.owner.userId).filter((other) => other.kind !== "paced");
  const recorded = await h.call("owner", "POST", "/api/video-evidence/live-validations", { target: run.target, runs: [others[0], completed, others[1]] });
  assert.equal(recorded.status, 201, json(recorded.body));
  assert.equal(h.video.readiness().available, true);
  assert.equal(h.video.launchCertification("r")?.reviewer.model, "claude-opus-5-5");
});

test("an expired permit starts nothing and still holds its evidence and profile", async (t) => {
  const h = await harness(t);
  const previewed = await h.preview();
  assert.equal(previewed.status, 200, json(previewed.body));

  // Expired: a permit is finite; after its expiry it starts nothing.
  const expiring = await h.mint("owner", previewed.body, h.now() + 60_000);
  assert.equal(expiring.status, 201);
  h.advance(61_000);
  const late = await h.call("owner", "POST", `/api/video-evidence/validation-permits/${expiring.body.permit.permitId}/run`);
  assert.equal(late.status, 403);
  assert.equal(h.dispatches().length, 0);
  assert.equal((await h.mint("owner", previewed.body)).status, 409, "the expired permit still holds this evidence and profile");
  assert.equal(h.db.raw().prepare("SELECT COUNT(*) AS n FROM sessions").get()!.n, 2, "no reviewer Session was created");
});

test("a revoked permit starts nothing and is revoked only once", async (t) => {
  const h = await harness(t);
  const previewed = await h.preview();
  const minted = await h.mint("owner", previewed.body);
  const permitId = minted.body.permit.permitId as string;
  assert.equal((await h.call("owner", "POST", `/api/video-evidence/validation-permits/${permitId}/revoke`)).status, 200);
  assert.equal((await h.call("owner", "POST", `/api/video-evidence/validation-permits/${permitId}/revoke`)).status, 409, "revocation is once");
  assert.equal((await h.call("owner", "POST", `/api/video-evidence/validation-permits/${permitId}/run`)).status, 403);
  assert.equal((await h.call("owner", "GET", `/api/video-evidence/validation-permits/${permitId}`)).body.status, "revoked");
  assert.equal(h.dispatches().length, 0);
});

test("revoking a permit mid-run withholds every further frame and the verdict", async (t) => {
  const h = await harness(t);
  const previewed = await h.preview();
  const minted = await h.mint("owner", previewed.body);
  const permitId = minted.body.permit.permitId as string;
  assert.equal((await h.call("owner", "POST", `/api/video-evidence/validation-permits/${permitId}/run`)).body.status, "dispatched");
  const [dispatch] = h.dispatches();
  assert.equal(await h.video.delegated.onDispatchReceipt("r", h.runner.accepted(dispatch!)), true);
  const as = `reviewer:${dispatch!.grant.reviewerSessionId}`, base = `/api/sessions/${dispatch!.grant.reviewerSessionId}/video-evidence-review`;
  assert.equal((await h.call(as, "POST", `${base}/frames`, { reviewId: dispatch!.grant.reviewId, index: 0, end: 60 })).status, 200);
  assert.equal((await h.call("owner", "POST", `/api/video-evidence/validation-permits/${permitId}/revoke`)).status, 200);
  const refused = await h.call(as, "POST", `${base}/frames`, { reviewId: dispatch!.grant.reviewId, index: 0, end: 60 });
  assert.equal(refused.status, 409);
  assert.equal(refused.body.code, "live_validation", "without a current permit the reviewer is an ordinary unproven reviewer");
});

test("a changed policy revision invalidates a minted permit before it starts", async (t) => {
  const h = await harness(t);
  const previewed = await h.preview();
  const minted = await h.mint("owner", previewed.body);
  // Fixture-only: the campaign's Human-owned policy moves to a new revision after the mint.
  h.db.raw().prepare("UPDATE sessions SET parent_control_policy_revision=parent_control_policy_revision+1 WHERE id='root'").run();
  const started = await h.call("owner", "POST", `/api/video-evidence/validation-permits/${minted.body.permit.permitId}/run`);
  assert.equal(started.status, 403, json(started.body));
  assert.equal(h.dispatches().length, 0);
});
