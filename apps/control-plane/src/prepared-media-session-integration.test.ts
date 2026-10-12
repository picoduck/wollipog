import { readFileSync } from "node:fs";
import { WorkflowVideoEvidenceApprovals } from "./workflow-video-evidence-approvals.js";
import { createControlPlaneVideoReviewStore } from "./video-evidence-artifacts.js";
import { VideoEvidenceRuntime, type VideoReviewBinding, type VideoReviewRuntimeAccess } from "./video-evidence-runtime.js";
import { videoPreparationDecoderAvailable } from "./video-evidence-preparation.js";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { test } from "node:test";
import { DEFAULT_ORCHESTRATOR_DEFAULTS, HUMAN_ONLY_PARENT_CONTROL_POLICY, type RunnerMetadata } from "@wollipog/protocol";
import { ControlPlaneDb } from "./db.js";
import { Hub } from "./hub.js";
import { SessionsService, normalizeWorkflowDecisionSnapshot } from "./sessions.js";
import { resolveOrchestratorCampaignPolicy } from "./orchestrator-settings.js";
import { mintCampaignEvidenceAuthority } from "./evidence-authority.js";
import type { HumanPrincipal } from "./identity.js";
import type { PreparedMediaSessionRuntime } from "./prepared-media-session-runtime.js";
import { PreparedMediaSessions, type PreparedMediaSessionPorts } from "./prepared-media-sessions.js";
import type { ReviewerAdmissionContext, EvidenceReviewerTarget, VideoProfileLiveProof } from "./evidence-review-worker.js";
import { isAgentControlApiRouteAllowed } from "./auth.js";
import { mediaSessionMutationAllowed } from "./media-session-route-policy.js";
const sha = (value: string | Buffer) => createHash("sha256").update(value).digest("hex");

/** In-memory concrete DB/service integration with explicitly synthetic proof/rates/source.
 * No actual managed provider, credential, live proof registration, media upload or usage occurs. */
function harness(sourceBytes?: Buffer) {
  const db = ControlPlaneDb.open(":memory:");
  const human: HumanPrincipal = { ...db.localIdentityContext(), kind: "human", actorId: "synthetic-human" };
  const audience = { organizationId: human.organizationId, owner: { kind: "user" as const, userId: human.userId } };
  const metadata: RunnerMetadata = { runnerId: "r", hostname: "synthetic", os: "linux", version: "test",
    workspaces: [{ id: "w", name: "Repo", path: "/synthetic-repo" }],
    agents: [{ id: "claude", name: "Synthetic Claude", command: "claude", args: [], env: {}, driver: "claude-code", available: true,
      capabilities: { models: [{ id: "claude-opus-5-5", displayName: "Synthetic Image Model", default: true, inputModalities: ["text", "image"] }],
        effortLevels: [], slashCommands: [], supportsImages: true, supportsApprovals: true, imageToolResults: true,
        permissionModes: ["default"] } }] };
  db.registerRunner(metadata, 1, 218);
  db.setUsageRateTable(new Map([["claude-opus-5-5", { inputCostPerToken: 0.000001, outputCostPerToken: 0.000001,
    cacheReadCostPerToken: 0.000001, cacheCreationCostPerToken: 0.000001 }]]));
  const policy = resolveOrchestratorCampaignPolicy(DEFAULT_ORCHESTRATOR_DEFAULTS, "system_default");
  policy.issueScope = { repository: "picoduck/wollipog", issueNumbers: [1321], revision: 1,
    authorizedByUserId: human.userId, authorizedAt: 1 };
  policy.issueNumbers = [1321];
  db.createSession({ id: "root", runnerId: "r", workspaceId: "w", agentId: "claude", title: "Synthetic Root",
    useWorktree: false, driver: "claude-code", config: { model: "claude-opus-5-5" }, scope: audience,
    creationActor: "human", role: "orchestrator", orchestratorPolicy: policy, parentControlPolicy: { decisions: { ...HUMAN_ONLY_PARENT_CONTROL_POLICY } }, now: 2 });
  db.updateSessionStatus("root", "running", 3);
  const hub = new Hub(db), messages: unknown[] = [];
  hub.isRunnerOnline = () => true; hub.sendToRunner = (_, message) => { messages.push(message); return true; };
  hub.sessionChanged = () => {}; hub.sessionChangedById = () => {};
  const log = { info() {}, warn() {}, error() {} };
  const bootstrap = new SessionsService(db, hub, log);
  assert.ok(bootstrap.setCampaignControl("root", { mode: "full_control", objective: "Review #1321", operations: ["ui_evidence_approval"],
    delegatablePolicyIds: [], budgetAuthority: { version: 1, accounting: "managed_workers_only", unpriced: "stop",
      toolCalls: 120, costUsd: 120, concurrency: 3 } }, 1, human).ok);
  const rootPolicy = db.getSession("root")!.orchestratorPolicy!;
  assert.equal(rootPolicy.control?.mode, "full_control");
  const boundary = rootPolicy.control!.mode === "full_control" ? rootPolicy.control!.boundary : assert.fail("No fixture boundary");
  const evidence = mintCampaignEvidenceAuthority(human, boundary, "root", {
    destinationConfigurationId: "synthetic-private", destinationDisclosureRevision: 1,
    providers: [{ providerId: "synthetic-provider", disclosureRevision: 1, reviewers: [{ driver: "claude-code", modelId: "claude-opus-5-5" }] }],
  }, { destination: () => ({ organizationId: human.organizationId, privacy: "private", disclosureRevision: 1 }),
    provider: () => ({ disclosureRevision: 1, retentionDisclosure: "Synthetic test disclosure.",
      reviewers: [{ driver: "claude-code", modelId: "claude-opus-5-5" }] }) });
  assert.ok(evidence);
  boundary.evidenceAuthority = evidence;
  // Fixture-only human boundary composition until the final human CAS adapter is integrated.
  db.raw().prepare("UPDATE sessions SET orchestrator_policy=? WHERE id='root'").run(JSON.stringify(rootPolicy));
  db.createSession({ id: "child", parentSessionId: "root", runnerId: "r", workspaceId: "w", agentId: "claude",
    title: "Synthetic Child", useWorktree: false, driver: "claude-code", scope: audience,
    config: { model: "claude-opus-5-5", costBudgetUsd: 2, maxToolCalls: 10 }, now: 4 });
  db.updateSessionStatus("child", "running", 5);
  const source = sourceBytes ?? Buffer.from("synthetic storage bytes, not real video evidence");
  db.createWorkflowArtifactBytes({ artifactId: "source", sessionId: "child", kind: "video", name: "Synthetic.webm",
    mimeType: "video/webm", encoding: "base64", sha256: sha(source), sizeBytes: source.length,
    createdBy: { kind: "agent", id: "child" }, metadata: { purpose: "session_attachment" }, createdAt: 6 }, source);
  const suppliedSnapshot = { category: "ui_evidence_approval" as const, evidence: [{ evidenceId: "original-video",
    artifactId: "source", sha256: sha(source), mediaType: "video/webm", description: "Synthetic storage test" }] };
  const normalized = normalizeWorkflowDecisionSnapshot(suppliedSnapshot); assert.ok(normalized.ok && normalized.data);
  const snapshot = normalized.data;
  assert.ok(db.createWorkflowDecision({ requestId: "synthetic-ui", occurrenceId: "original-gate", sessionId: "child",
    controllingSessionId: "root", category: "ui_evidence_approval", resourceKey: "synthetic", resourceSnapshot: snapshot,
    resourceDigest: sha(JSON.stringify(snapshot)), policyRevision: boundary.revision, authority: "orchestrator", createdAt: 7 }));
  const target: EvidenceReviewerTarget = { agentId: "claude", driver: "claude-code", modelId: "claude-opus-5-5",
    providerId: "synthetic-provider", runnerId: "r", runnerProtocolVersion: 218, capabilitiesSha256: sha("synthetic capability"),
    auditedAllFrameDelivery: true, reviewerNamespaceSha256: sha("synthetic namespace"), mediaOnlyNamespaceVerified: true };
  const context: ReviewerAdmissionContext = { mode: "full_control", rootSessionId: "root", childSessionId: "child",
    repository: "picoduck/wollipog", issue: 1321, issueScopeRevision: 1, policyRevision: boundary.revision,
    boundary, evidenceAuthority: evidence, uiEvidenceOwner: "orchestrator", taskEvidenceVerified: true,
    destinationConfigurationId: "synthetic-private", organizationId: human.organizationId, audienceSha256: sha("synthetic audience"),
    controllerProtocolVersion: 218, childProtocolVersion: 218, boundaryCurrent: true, scopeCurrent: true, destinationPrivateVerified: true };
  let proof: VideoProfileLiveProof | null = { proofId: "synthetic-not-live", driver: target.driver, modelId: target.modelId,
    providerId: target.providerId, capabilitiesSha256: target.capabilitiesSha256, reviewerNamespaceSha256: target.reviewerNamespaceSha256,
    oracleIsolationEvidenceSha256: sha("synthetic probe"), profile: "paced-silent-complete-frames-v1",
    validatedAt: Date.now() - 1000, expiresAt: Date.now() + 60_000, candidateValidationRunId: "synthetic-candidate",
    pacedValidationRunId: "synthetic-paced", maximumProfileValidationRunId: "synthetic-maximum", sourceSha256: sha(source),
    manifestSha256: sha("synthetic-manifest"), orderedReceiptSetSha256: sha("synthetic-receipts"),
    privateOracleCommitmentSha256: sha("synthetic-oracle"), blindTemporalVerdictSha256: sha("synthetic-verdict"),
    modelDeliveryEvidenceSha256: sha("synthetic-delivery"), usageEvidenceSha256: sha("synthetic-usage"),
    pricingEvidenceSha256: sha("synthetic-pricing"), inputTokens: 1, outputTokens: 1, actualCostUsd: 0.1,
    latencyMs: 1, verifiedByUserId: human.userId };
  const runtime: PreparedMediaSessionRuntime = { resolve: () => ({ context, target, liveProof: proof,
    request: { runnerId: "r", workspaceId: "w", agentId: "claude", title: "Synthetic Media Reviewer",
      prompt: "Review authorized #1321 through the exact scoped media tools.", config: { model: target.modelId, costBudgetUsd: 2, maxToolCalls: 10 } } }) };
  const service = new SessionsService(db, hub, log, undefined, undefined, undefined, undefined, undefined, undefined,
    false, undefined, runtime);
  const identity = { rootSessionId: "root", childSessionId: "child", admissionId: "synthetic-media", requestSha256: sha("exact source and criteria") };
  const subject = { occurrenceId: "original-gate", evidenceId: "original-video" };
  const ports: PreparedMediaSessionPorts = {
    database: db.raw(),
    preflightMaterialization: (id) => { const value = service.preflightPreparedMediaSession(id, subject);
      if (!value.ok) throw new Error(value.error); },
    materialize: (id) => { const value = service.materializePreparedMediaSession(id, subject);
      if (!value.ok || !value.data) throw new Error(value.error); return value.data; },
    currentAdmission: (sessionId) => service.campaignBudgetWorkerPreflight("root", { kind: "managed", sessionId }).data ?? null,
    currentIdentity: (sessionId) => { const session = db.getSession(sessionId), dispatch = db.campaignBudgets.dispatch(sessionId);
      return session && dispatch ? { rootSessionId: dispatch.rootSessionId, runnerId: session.runnerId, generation: dispatch.generation } : null; },
    authorize: async () => false, send: async () => { assert.fail("No actual provider send in preparation tests"); },
    reconcile: async () => null, cancelNeverDispatched: () => { throw new Error("Confirmed-unlaunched budget release adapter is not yet integrated."); },
  };
  const prepared = new PreparedMediaSessions(db.raw(), ports);
  return { db, hub, log, human, source, service, bootstrap, prepared, identity, subject, context, runtime, target, messages, ports,
    dropProof: () => { proof = null; } };
}
test("concrete createSession pipeline atomically materializes actual row/member/unsent command without provider dispatch", (t) => {
  const h = harness(); t.after(() => h.db.close());
  h.messages.length = 0;
  const result = h.prepared.prepare(h.identity);
  assert.equal(h.db.getSession(result.sessionId)?.parentSessionId, "root");
  assert.equal(h.db.campaignBudgets.root(result.sessionId), "root");
  assert.deepEqual(result.command.spec.campaignBudgetDispatch, result.admission.dispatch);
  assert.deepEqual(h.service.mediaSessionPurposes.get(result.sessionId)?.command, result.command);
  assert.ok(h.service.mediaSessionPurposes.owns(result.sessionId));
  assert.equal(h.service.mediaSessionPurposes.credentialCurrent(result.sessionId), true);
  assert.deepEqual(h.messages, [], "materialization cannot send any provider frame");
  assert.deepEqual(h.prepared.prepare(h.identity), result);
  assert.equal(h.service.prompt(result.sessionId, "Read arbitrary files").ok, false);
  assert.equal(h.service.restart(result.sessionId).ok, false);
  assert.equal(h.service.setConfig(result.sessionId, { model: "another" }).ok, false);
});
test("missing proof, stale policy, changed disclosure/namespace and child capacity refuse before creating any reserved reviewer", (t) => {
  for (const mutate of [
    (h: ReturnType<typeof harness>) => h.dropProof(),
    (h: ReturnType<typeof harness>) => { h.context.destinationPrivateVerified = false; },
    (h: ReturnType<typeof harness>) => { h.target.mediaOnlyNamespaceVerified = false; },
    (h: ReturnType<typeof harness>) => { h.db.updateSessionMaxChildSessions("root", 0, 8); },
    (h: ReturnType<typeof harness>) => { h.db.raw().prepare("UPDATE workflow_decisions SET policy_revision=999").run(); },
  ]) {
    const h = harness(); t.after(() => h.db.close()); h.messages.length = 0; mutate(h);
    assert.throws(() => h.prepared.prepare(h.identity));
    assert.equal(h.db.raw().prepare("SELECT COUNT(*) AS n FROM media_session_purposes").get()!.n, 0);
    assert.equal(h.db.raw().prepare("SELECT COUNT(*) AS n FROM sessions").get()!.n, 2);
    assert.equal(h.db.raw().prepare("SELECT COUNT(*) AS n FROM campaign_budget_members").get()!.n, 2);
    assert.deepEqual(h.messages, []);
  }
});
test("public creation JSON cannot request private preparation or borrow its capability, and ordinary Session behavior remains separate", (t) => {
  const h = harness(); t.after(() => h.db.close());
  assert.equal(h.service.materializePreparedMediaSession(h.identity, h.subject).ok, false, "private preparation requires atomic ledger transaction");
  assert.equal(new SessionsService(h.db, new Hub(h.db), { info() {}, warn() {}, error() {} })
    .materializePreparedMediaSession(h.identity, h.subject).ok, false, "no registered trusted runtime means unsupported");
  assert.equal(h.service.mediaSessionPurposes.owns("child"), false);
  const legacy = h.bootstrap.createSession({ runnerId: "r", workspaceId: "w", agentId: "claude",
    prompt: "Implement authorized #1321", config: { model: "claude-opus-5-5", costBudgetUsd: 2, maxToolCalls: 10 },
    preparedMediaRuntime: true, preparedMedia: { start: false } } as never,
    undefined, undefined, false, false, false, { parentSessionId: "root" });
  assert.ok(legacy.ok, legacy.error ?? "ordinary launch failed");
  assert.equal(h.service.mediaSessionPurposes.owns(legacy.data!.id), false);
  assert.ok(h.messages.some((m) => (m as { type?: string }).type === "start_session"), "JSON flags cannot select private unsent admission");
});
test("purpose-bound HTTP routes allow only exact media operations while parent stop/archive remains available", () => {
  const prefix = "/api/sessions/:id/video-evidence-review/";
  for (const action of ["frame", "frames", "acknowledge", "acknowledge-frames", "verdict"]) {
    assert.equal(isAgentControlApiRouteAllowed("POST", prefix + action, "normal", true), true);
  }
  for (const route of ["/api/sessions", "/api/sessions/:id/config", "/api/sessions/:id/restart",
    "/api/sessions/:id/prompt", "/api/sessions/:id/artifacts/videos", prefix + "prepare", prefix + "provenance"]) {
    assert.equal(isAgentControlApiRouteAllowed("POST", route, "normal", true), false);
  }
  for (const route of ["/api/sessions/:id/prompt", "/api/sessions/:id/config", "/api/sessions/:id/restart",
    "/api/sessions/:id/fork", "/api/sessions/:id/shells"]) assert.equal(mediaSessionMutationAllowed("POST", route), false);
  for (const route of ["/api/sessions/:id/stop", "/api/sessions/:id/archive"]) assert.equal(mediaSessionMutationAllowed("POST", route), true);
  assert.equal(isAgentControlApiRouteAllowed("POST", "/api/sessions", "normal"), true);
});

test("post-materialization failure rolls back actual Session/member/purpose/command together", (t) => {
  const h = harness(); t.after(() => h.db.close()); h.messages.length = 0;
  const original = h.ports.materialize;
  h.ports.materialize = (identity) => {
    const actual = original(identity);
    actual.admission.allocationDigest = sha("substituted post-materialization admission");
    return actual;
  };
  assert.throws(() => h.prepared.prepare(h.identity), /Actual managed media Session/iu);
  for (const table of ["media_session_purposes", "prepared_media_sessions"]) {
    assert.equal(h.db.raw().prepare("SELECT COUNT(*) AS n FROM " + table).get()!.n, 0);
  }
  assert.equal(h.db.raw().prepare("SELECT COUNT(*) AS n FROM sessions").get()!.n, 2);
  assert.equal(h.db.raw().prepare("SELECT COUNT(*) AS n FROM campaign_budget_members").get()!.n, 2);
  assert.deepEqual(h.messages, []);
});
test("stored media purpose corruption still blocks generic repurposing and credential routes", (t) => {
  const h = harness(); t.after(() => h.db.close());
  const result = h.prepared.prepare(h.identity);
  h.db.raw().prepare("UPDATE media_session_purposes SET record=json_set(record,'$.generation','replacement')").run();
  assert.throws(() => h.service.mediaSessionPurposes.get(result.sessionId), /purpose is invalid/);
  assert.equal(h.service.mediaSessionPurposes.owns(result.sessionId), true);
  assert.equal(h.service.mediaSessionPurposes.credentialCurrent(result.sessionId), false);
  assert.equal(h.service.restart(result.sessionId).ok, false);
  assert.equal(isAgentControlApiRouteAllowed("POST", "/api/sessions", "normal",
    h.service.mediaSessionPurposes.owns(result.sessionId)), false);
});

test("explicit ordinary child-creation governance ask survives refusal without reserving or launching the media worker", (t) => {
  const h = harness(); t.after(() => h.db.close()); h.messages.length = 0;
  h.db.upsertGovernancePolicy({ policyId: "synthetic-ask", name: "Review Child Creation",
    effect: "ask", priority: 100, enabled: true, scope: { toolName: "wollipog.create_session" } }, Date.now());
  assert.throws(() => h.prepared.prepare(h.identity), /Child creation requires approval/);
  const request = h.db.getSession("root")!.pendingApproval;
  assert.equal(request?.kind, "policy_hook");
  assert.ok(request?.requestId);
  assert.equal(h.db.getPolicyHookApproval("root", request.requestId)?.status, "pending");
  assert.equal(h.db.raw().prepare("SELECT COUNT(*) AS n FROM media_session_purposes").get()!.n, 0);
  assert.equal(h.db.raw().prepare("SELECT COUNT(*) AS n FROM prepared_media_sessions").get()!.n, 0);
  assert.equal(h.db.raw().prepare("SELECT COUNT(*) AS n FROM campaign_budget_members").get()!.n, 2);
  assert.deepEqual(h.messages, []);
});

test("replacement generation loses the old media credential surface without becoming a general Session", (t) => {
  const h = harness(); t.after(() => h.db.close());
  const result = h.prepared.prepare(h.identity);
  h.db.campaignBudgets.replaceDispatch(result.sessionId);
  assert.equal(h.service.mediaSessionPurposes.credentialCurrent(result.sessionId), false);
  assert.equal(h.service.mediaSessionPurposes.owns(result.sessionId), true);
  assert.equal(h.service.restart(result.sessionId).ok, false);
});

test("source audience changes refuse preparation before reserving or returning quality to an unauthorized controller", (t) => {
  const h = harness(); t.after(() => h.db.close()); h.messages.length = 0;
  const read = h.db.sessionScope.bind(h.db);
  h.db.sessionScope = (id) => {
    const original = read(id);
    return id === "child" && original ? { ...original, owner: { kind: "user", userId: "another-private-source-owner" } } : original;
  };
  assert.throws(() => h.prepared.prepare(h.identity), /scoped media profile/);
  assert.equal(h.db.raw().prepare("SELECT COUNT(*) AS n FROM media_session_purposes").get()!.n, 0);
  assert.deepEqual(h.messages, []);
});

/** Complete real native fixture derivation and private artifact/SQLite/provenance flow with a
 * synthetic admitted, unsent Session. No model call, oracle, actual grant or live proof. */
async function gateHarness(t: { skip(reason: string): void; after(fn: () => void): void }, withImage = false) {
  if (!await videoPreparationDecoderAvailable()) {
    assert.notEqual(process.env.CI, "true", "CI must provision isolated decoder"); t.skip("isolated decoder unavailable"); return null;
  }
  const source = readFileSync(new URL("../test-fixtures/video-preparation-paced.webm", import.meta.url));
  const h = harness(source); t.after(() => h.db.close());
  if (withImage) {
    const image = readFileSync(new URL("../../web/public/icons/icon-192.png", import.meta.url));
    h.db.createWorkflowArtifactBytes({ artifactId: "direct-image", sessionId: "child", kind: "screenshot", name: "Synthetic Test Image.png",
      mimeType: "image/png", encoding: "base64", sha256: sha(image), sizeBytes: image.length,
      createdBy: { kind: "agent", id: "child" }, metadata: { purpose: "session_attachment" }, createdAt: 8 }, image);
    const original = h.db.workflowDecisionByOccurrence("original-gate")!;
    assert.equal(original.resourceSnapshot.category, "ui_evidence_approval");
    if (original.resourceSnapshot.category !== "ui_evidence_approval") throw new Error("No UI fixture");
    const normalized = normalizeWorkflowDecisionSnapshot({ ...original.resourceSnapshot,
      evidence: [...original.resourceSnapshot.evidence, { evidenceId: "direct-image", artifactId: "direct-image",
        sha256: sha(image), mediaType: "image/png" }] });
    assert.ok(normalized.ok && normalized.data);
    // Fixture construction precedes admission/derivation; the original gate then remains immutable.
    h.db.raw().prepare("UPDATE workflow_decisions SET resource_snapshot=?,resource_digest=? WHERE occurrence_id='original-gate'")
      .run(JSON.stringify(normalized.data), sha(JSON.stringify(normalized.data)));
  }
  const reviewer = h.prepared.prepare(h.identity);
  const original = h.db.workflowDecisionByOccurrence("original-gate")!;
  const criteria = [{ criterionId: "transients", description: "Review all source frames for transient defects." }];
  const binding: VideoReviewBinding = { rootSessionId: "root", childSessionId: "child", occurrenceId: original.occurrenceId,
    resourceDigest: original.resourceDigest, policyRevision: original.policyRevision,
    boundaryRevision: h.context.boundary!.revision, evidenceAuthorityRevision: h.context.evidenceAuthority!.revision,
    reviewerSessionId: reviewer.sessionId, reviewerDriver: reviewer.admission.worker.driver,
    reviewerModelId: reviewer.admission.worker.model!, providerId: h.target.providerId,
    audienceSha256: h.context.audienceSha256, capabilitiesSha256: h.target.capabilitiesSha256,
    sourceEvidenceId: "original-video", sourceArtifactId: "source", sourceSha256: sha(source),
    workerAdmissionSha256: reviewer.admission.allocationDigest, criteriaSha256: sha(JSON.stringify(criteria)) };
  let allowed = true;
  const store = createControlPlaneVideoReviewStore(h.db);
  const runtimeAccess: VideoReviewRuntimeAccess = { currentBinding: () => allowed ? binding : null,
    normalCompletion: () => false, workerAdmission: () => h.service.campaignBudgetWorkerPreflight("root",
      { kind: "managed", sessionId: reviewer.sessionId }).data ?? null,
    readSource: (id) => h.db.readWorkflowArtifactBytes(id) };
  const runtime = new VideoEvidenceRuntime(store, runtimeAccess);
  const derived = await runtime.derive(binding, "video/webm", criteria); assert.ok(derived.ok);
  if (!derived.ok) throw new Error("Fixture derivation refused");
  const record = derived.review;
  const approvalAccess = {
    available: () => allowed, linkedReview: () => store.getReview(record.reviewId),
    decisionCurrent: (decision: import("@wollipog/protocol").WorkflowDecisionView, phase: "resolve" | "consume") => allowed && h.db.workflowDecisionByOccurrence(decision.occurrenceId)?.status ===
      (phase === "resolve" ? "pending" : "approved"),
  };
  const approvals = new WorkflowVideoEvidenceApprovals(h.db, runtime, approvalAccess);
  const service = new SessionsService(h.db, h.hub, h.log, undefined, undefined, undefined, undefined, undefined, undefined,
    false, undefined, h.runtime, approvals);
  const reference = { evidenceId: "original-video", reviewId: record.reviewId, verdictId: "not-yet-attested",
    reviewerSessionId: reviewer.sessionId };
  const resolve = (resolution = { outcome: "approve" as const, evidenceReviewed: [] as string[], delegatedVideoEvidence: [reference] }) =>
    service.resolveWorkflowDecision("root", "child", original.occurrenceId, resolution, "orchestrator",
      { kind: "agent", id: "root" }, () => true);
  const complete = () => {
    for (let index = 0; index < record.manifest.frames.length;) {
      const batch = runtime.deliverBatch(record.reviewId, reviewer.sessionId, index);
      runtime.acknowledgeBatch(record.reviewId, reviewer.sessionId, batch.deliveries.map((delivery) => delivery.receipt));
      index = batch.nextIndex;
    }
    const verdict = runtime.recordVerdict(record.reviewId, reviewer.sessionId, { outcome: "accept", criteria: [{
      criterionId: "transients", outcome: "pass", observedFrameIndices: [157],
      observation: "Disclosed deterministic fixture observation; not a blind model claim." }], rationale: "Synthetic contract test only." });
    reference.verdictId = verdict.verdictId; return verdict;
  };
  return { ...h, preparedRuntime: h.runtime, service, approvals, approvalAccess, runtime, store, original, record, reference, resolve, complete,
    revoke: () => { allowed = false; } };
}

test("original UI gate persists actual media actor separately and consumes complete current proof without parent frame receipts", async (t) => {
  const h = await gateHarness(t); if (!h) return;
  assert.equal(h.resolve().ok, false, "receipts without a criterion verdict cannot approve");
  assert.equal(h.db.workflowDecisionByOccurrence(h.original.occurrenceId)?.status, "pending");
  h.complete();
  assert.equal(h.resolve({ outcome: "approve", evidenceReviewed: ["original-video"], delegatedVideoEvidence: [h.reference] }).ok, false,
    "parent cannot claim the worker's inspected video as directly inspected");
  const approved = h.resolve(); assert.ok(approved.ok, approved.error ?? "Approval refused");
  assert.deepEqual(approved.data?.evidenceReviewed, []);
  assert.deepEqual(approved.data?.delegatedVideoEvidence, [h.reference]);
  assert.deepEqual(approved.data?.resourceSnapshot, h.original.resourceSnapshot);
  assert.equal(approved.data?.resourceDigest, h.original.resourceDigest);
  assert.equal(h.db.validUiEvidenceReviewReceipts(h.original.occurrenceId, "root", Date.now()).length, 0);
  assert.equal(h.store.latestReceipts(h.record.reviewId).length, 360);
  const consumed = await h.service.consumeWorkflowDecision("child", h.original.occurrenceId,
    { resourceSnapshot: h.original.resourceSnapshot });
  assert.ok(consumed.ok, consumed.error ?? "Consumption refused"); assert.equal(consumed.data?.status, "consumed");
  assert.equal((await h.service.consumeWorkflowDecision("child", h.original.occurrenceId,
    { resourceSnapshot: h.original.resourceSnapshot })).ok, false, "consumption cannot replay");
});

test("original media approval fails closed after durable provenance corruption, revocation and missing runtime", async (t) => {
  const h = await gateHarness(t); if (!h) return; h.complete();
  assert.ok(h.resolve().ok);
  h.db.raw().prepare("UPDATE workflow_video_approvals SET record='{}'").run();
  const consumed = await h.service.consumeWorkflowDecision("child", h.original.occurrenceId,
    { resourceSnapshot: h.original.resourceSnapshot });
  assert.equal(consumed.ok, false); assert.equal(h.db.workflowDecisionByOccurrence(h.original.occurrenceId)?.status, "revoked");
  assert.equal(h.bootstrap.resolveWorkflowDecision("root", "child", "original-gate",
    { outcome: "approve", evidenceReviewed: [], delegatedVideoEvidence: [h.reference] }, "orchestrator",
    { kind: "agent", id: "root" }, () => true).ok, false);
});


test("mixed original evidence requires actual parent image inspection, atomic approval and durable restart provenance", async (t) => {
  const h = await gateHarness(t, true); if (!h) return; h.complete();
  const resolution = { outcome: "approve" as const, evidenceReviewed: ["direct-image"], delegatedVideoEvidence: [h.reference] };
  assert.equal(h.resolve(resolution).ok, false, "an image ID alone is no proof");
  const image = h.service.reviewDescendantUiEvidence("root", "child", h.original.occurrenceId, "direct-image", () => true);
  assert.ok(image.ok && image.data, image.error ?? "Image delivery refused");
  assert.ok(h.service.acknowledgeDescendantUiEvidence("root", image.data.receipt.receiptId, image.data.receipt.sha256).ok);
  h.db.raw().exec("CREATE TRIGGER reject_media_approval BEFORE INSERT ON workflow_video_approvals BEGIN SELECT RAISE(ABORT,'synthetic disk failure'); END");
  assert.equal(h.resolve(resolution).ok, false);
  assert.equal(h.db.workflowDecisionByOccurrence(h.original.occurrenceId)?.status, "pending", "approval and proof commit atomically");
  assert.equal(h.db.validUiEvidenceReviewReceipts(h.original.occurrenceId, "root", Date.now()).length, 1, "rollback preserves unused inspection receipt");
  h.db.raw().exec("DROP TRIGGER reject_media_approval");
  assert.ok(h.resolve(resolution).ok);
  assert.deepEqual(h.db.workflowDecisionByOccurrence(h.original.occurrenceId)?.evidenceReviewed, ["direct-image"]);
  const restartedApprovals = new WorkflowVideoEvidenceApprovals(h.db, h.runtime, h.approvalAccess);
  const restarted = new SessionsService(h.db, h.hub, h.log, undefined, undefined, undefined, undefined, undefined, undefined,
    false, undefined, h.preparedRuntime, restartedApprovals);
  const consumed = await restarted.consumeWorkflowDecision("child", h.original.occurrenceId, { resourceSnapshot: h.original.resourceSnapshot });
  assert.ok(consumed.ok, consumed.error ?? "Durable proof failed after restart");
  assert.equal(consumed.data?.status, "consumed");
});

test("current media authority revocation invalidates approval before consume", async (t) => {
  const h = await gateHarness(t); if (!h) return; h.complete(); assert.ok(h.resolve().ok); h.revoke();
  const consumed = await h.service.consumeWorkflowDecision("child", h.original.occurrenceId, { resourceSnapshot: h.original.resourceSnapshot });
  assert.equal(consumed.ok, false); assert.equal(h.db.workflowDecisionByOccurrence(h.original.occurrenceId)?.status, "revoked");
});

test("human campaign CAS derives evidence disclosure without replacing budget/scope or accepting agent provenance", (t) => {
  const h = harness(); t.after(() => h.db.close());
  let privacy: "private" | "public" = "private";
  const disclosures = {
    destination: () => ({ organizationId: h.human.organizationId, privacy, disclosureRevision: 1 }),
    provider: () => ({ disclosureRevision: 1, retentionDisclosure: "Synthetic provider retention for this in-memory test.",
      reviewers: [{ driver: "claude-code" as const, modelId: "claude-opus-5-5" }] }),
  };
  const service = new SessionsService(h.db, h.hub, h.log, undefined, undefined, undefined, undefined, undefined, undefined,
    false, undefined, undefined, undefined, disclosures);
  const before = h.db.getSession("root")!, policy = before.orchestratorPolicy!, control = policy.control!;
  assert.equal(control.mode, "full_control"); if (control.mode !== "full_control") throw new Error("No test boundary");
  const proposal = { mode: "full_control" as const, objective: control.boundary.objective,
    operations: control.boundary.operations, delegatablePolicyIds: control.boundary.delegatablePolicyIds,
    budgetAuthority: control.boundary.budgetAuthority, evidenceAuthority: {
      destinationConfigurationId: "synthetic-private", destinationDisclosureRevision: 1,
      providers: [{ providerId: "synthetic-provider", disclosureRevision: 1,
        reviewers: [{ driver: "claude-code" as const, modelId: "claude-opus-5-5" }] }],
    } };
  const revision = before.parentControlPolicy!.revision;
  assert.equal(service.setCampaignControl("root", proposal, revision, { ...h.human, kind: "agent" } as never).ok, false);
  assert.equal(h.bootstrap.setCampaignControl("root", proposal, revision, h.human).ok, false, "unknown disclosure stays unsupported");
  privacy = "public"; assert.equal(service.setCampaignControl("root", proposal, revision, h.human).ok, false);
  privacy = "private";
  assert.equal(service.setCampaignControl("root", { ...proposal, evidenceAuthority: { ...proposal.evidenceAuthority,
    authorizedByUserId: "forged" } } as never, revision, h.human).ok, false);
  assert.equal(h.db.getSession("root")!.parentControlPolicy!.revision, revision);
  const allowed = service.setCampaignControl("root", proposal, revision, h.human); assert.ok(allowed.ok, allowed.error ?? "Human CAS refused");
  const next = allowed.data!.orchestratorPolicy!.control!;
  assert.equal(next.mode, "full_control"); if (next.mode !== "full_control") throw new Error("No resulting boundary");
  assert.equal(next.boundary.evidenceAuthority?.authorizedByUserId, h.human.userId);
  assert.equal(next.boundary.evidenceAuthority?.revision, revision + 1);
  assert.equal(next.boundary.evidenceAuthority?.campaignRootSessionId, "root");
  assert.equal(next.boundary.evidenceAuthority?.providers[0]?.retentionDisclosure, disclosures.provider().retentionDisclosure);
  assert.deepEqual(next.boundary.budgetAuthority, control.boundary.budgetAuthority);
  assert.deepEqual(allowed.data!.orchestratorPolicy!.issueScope, policy.issueScope);
  assert.equal(h.db.workflowDecisionByOccurrence("original-gate")?.status, "revoked", "old occurrence loses the superseded envelope");
  assert.equal(service.setCampaignControl("root", proposal, revision, h.human).ok, false, "stale CAS cannot replace new human authorization");
  assert.deepEqual(h.messages.filter((message) => (message as { type?: string }).type === "start_session"), []);
});
