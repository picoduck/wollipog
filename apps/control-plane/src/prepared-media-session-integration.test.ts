import { readFileSync } from "node:fs";
import ts from "typescript";
import Fastify from "fastify";
import { runInNewContext } from "node:vm";
import { registerAuthGate } from "./http-auth.js";
import { mutationAuthorizationError, PERSONAL_ORGANIZATION_ID, agentCredentialSessionTargetError,
  agentDelegationAuthorizationError } from "./identity.js";
import { WorkflowVideoEvidenceApprovals } from "./workflow-video-evidence-approvals.js";
import { createControlPlaneVideoReviewStore } from "./video-evidence-artifacts.js";
import { VideoEvidenceRuntime, type VideoReviewBinding, type VideoReviewRuntimeAccess } from "./video-evidence-runtime.js";
import { videoPreparationDecoderAvailable } from "./video-evidence-preparation.js";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { test } from "node:test";
import { DEFAULT_ORCHESTRATOR_DEFAULTS, HUMAN_ONLY_PARENT_CONTROL_POLICY, PACED_VIDEO_REVIEW_MIN_PROTOCOL, pacedVideoReviewWindowPlan,
  PACED_VIDEO_REVIEW_CONTRACT_ID, type RunnerMetadata } from "@wollipog/protocol";
import { ControlPlaneDb } from "./db.js";
import { Hub } from "./hub.js";
import { SessionsService, normalizeWorkflowDecisionSnapshot } from "./sessions.js";
import { resolveOrchestratorCampaignPolicy } from "./orchestrator-settings.js";
import { mintCampaignEvidenceAuthority } from "./evidence-authority.js";
import type { HumanPrincipal } from "./identity.js";
import { MEDIA_SESSION_PURPOSE_ERROR, type PreparedMediaSessionRuntime } from "./prepared-media-session-runtime.js";
import { PreparedMediaSessions, pacedGrantPlanDigest, type PreparedMediaSessionPorts } from "./prepared-media-sessions.js";
import type { ReviewerAdmissionContext, EvidenceReviewerTarget, VideoProfileLiveProof } from "./evidence-review-worker.js";
import { isAgentControlApiRouteAllowed } from "./auth.js";
import { mediaSessionMutationAllowed } from "./media-session-route-policy.js";
import { OperatorVideoValidationPermits, type OperatorVideoValidationScope } from "./operator-video-validation.js";
import { PreparedMediaReservationRelease } from "./prepared-media-reservation-release.js";
import { RunnerMediaDispatchFences } from "../../runner/src/media-dispatch-fences.js";
import { DatabaseSync } from "node:sqlite";
import { applyClaudeReconciliation, previewClaudeReconciliation, correctionFrame } from "./claude-cost-reconciliation.js";
import { mediaActiveStopIdentityBody, type MediaActiveStopIdentity, type MediaActiveStopRequest, type MediaActiveStopAcknowledgement } from "@wollipog/protocol";
import { PreparedMediaActiveStops } from "./prepared-media-active-stops.js";
import { RunnerMediaActiveStops, type OwnedMediaStopHandle } from "../../runner/src/media-active-stops.js";
const sha = (value: string | Buffer) => createHash("sha256").update(value).digest("hex");

/** In-memory concrete DB/service integration with explicitly synthetic proof/rates/source.
 * No actual managed provider, credential, live proof registration, media upload or usage occurs. */
function harness(sourceBytes?: Buffer, validation = false) {
  const db = ControlPlaneDb.open(":memory:");
  const human: HumanPrincipal = { ...db.localIdentityContext(), kind: "human", actorId: "synthetic-human" };
  const audience = { organizationId: human.organizationId, owner: { kind: "user" as const, userId: human.userId } };
  const metadata: RunnerMetadata = { runnerId: "r", hostname: "synthetic", os: "linux", version: "test",
    workspaces: [{ id: "w", name: "Repo", path: "/synthetic-repo" }],
    agents: [{ id: "claude", name: "Synthetic Claude", command: "claude", args: [], env: {}, driver: "claude-code", available: true,
      capabilities: { models: [{ id: "claude-opus-5-5", displayName: "Synthetic Image Model", default: true, inputModalities: ["text", "image"] }],
        effortLevels: ["high"], slashCommands: [], supportsImages: true, supportsApprovals: true, imageToolResults: true,
        // Synthetic compatibility metadata only; proof/rates/namespace remain Source fixtures.
        pacedVideoReviewContract: { id: PACED_VIDEO_REVIEW_CONTRACT_ID, revision: 1 },
        permissionModes: ["default"] } }] };
  db.registerRunner(metadata, 1, PACED_VIDEO_REVIEW_MIN_PROTOCOL);
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
  const log = { info(_message: string) {}, warn() {}, error() {} };
  const bootstrap = new SessionsService(db, hub, log);
  assert.ok(bootstrap.setCampaignControl("root", { mode: "full_control", objective: "Review #1321", operations: ["ui_evidence_approval"],
    delegatablePolicyIds: [], budgetAuthority: { version: 1, accounting: "managed_workers_only", unpriced: "stop",
      toolCalls: 120, costUsd: 120, concurrency: 3 } }, 1, human).ok);
  const rootPolicy = db.getSession("root")!.orchestratorPolicy!;
  assert.equal(rootPolicy.control?.mode, "full_control");
  const boundary = rootPolicy.control!.mode === "full_control" ? rootPolicy.control!.boundary : assert.fail("No fixture boundary");
  let currentPrivacy: "private" | "public" = "private";
  let retentionDisclosure = "Synthetic test disclosure.";
  const disclosures = {
    destination: () => ({ organizationId: human.organizationId, privacy: currentPrivacy, disclosureRevision: 1 }),
    provider: () => ({ disclosureRevision: 1, retentionDisclosure,
      reviewers: [{ driver: "claude-code" as const, modelId: "claude-opus-5-5" }] }),
  };
  const evidence = mintCampaignEvidenceAuthority(human, boundary, "root", {
    destinationConfigurationId: "synthetic-private", destinationDisclosureRevision: 1,
    providers: [{ providerId: "synthetic-provider", disclosureRevision: 1, reviewers: [{ driver: "claude-code", modelId: "claude-opus-5-5" }] }],
  }, disclosures);
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
    resourceDigest: sha(JSON.stringify(snapshot)), policyRevision: boundary.revision, authority: validation ? "human" : "orchestrator", createdAt: 7 }));
  const target: EvidenceReviewerTarget = { agentId: "claude", driver: "claude-code", modelId: "claude-opus-5-5", effort: "high",
    providerId: "synthetic-provider", runnerId: "r", runnerProtocolVersion: PACED_VIDEO_REVIEW_MIN_PROTOCOL, capabilitiesSha256: sha("synthetic capability"),
    pacedVideoReviewContract: { id: PACED_VIDEO_REVIEW_CONTRACT_ID, revision: 1 },
    auditedAllFrameDelivery: true, reviewerNamespaceSha256: sha("synthetic namespace"), mediaOnlyNamespaceVerified: true };
  const context: ReviewerAdmissionContext = { mode: "full_control", rootSessionId: "root", childSessionId: "child",
    repository: "picoduck/wollipog", issue: 1321, issueScopeRevision: 1, policyRevision: boundary.revision,
    boundary, evidenceAuthority: evidence, uiEvidenceOwner: validation ? "human" : "orchestrator", taskEvidenceVerified: true,
    destinationConfigurationId: "synthetic-private", organizationId: human.organizationId, audienceSha256: sha("synthetic audience"),
    controllerProtocolVersion: PACED_VIDEO_REVIEW_MIN_PROTOCOL, childProtocolVersion: PACED_VIDEO_REVIEW_MIN_PROTOCOL,
    controllerPacedVideoReviewContract: { id: PACED_VIDEO_REVIEW_CONTRACT_ID, revision: 1 },
    childPacedVideoReviewContract: { id: PACED_VIDEO_REVIEW_CONTRACT_ID, revision: 1 },
    boundaryCurrent: true, scopeCurrent: true, destinationPrivateVerified: true };
  let proof: VideoProfileLiveProof | null = { proofId: "synthetic-not-live", driver: target.driver, modelId: target.modelId, effort: target.effort,
    providerId: target.providerId, capabilitiesSha256: target.capabilitiesSha256, reviewerNamespaceSha256: target.reviewerNamespaceSha256,
    oracleIsolationEvidenceSha256: sha("synthetic probe"), profile: "paced-silent-complete-frames-v1",
    validatedAt: Date.now() - 1000, expiresAt: Date.now() + 60_000, candidateValidationRunId: "synthetic-candidate",
    pacedValidationRunId: "synthetic-paced", maximumProfileValidationRunId: "synthetic-maximum", sourceSha256: sha(source),
    manifestSha256: sha("synthetic-manifest"), orderedReceiptSetSha256: sha("synthetic-receipts"),
    privateOracleCommitmentSha256: sha("synthetic-oracle"), blindTemporalVerdictSha256: sha("synthetic-verdict"),
    modelDeliveryEvidenceSha256: sha("synthetic-delivery"), usageEvidenceSha256: sha("synthetic-usage"),
    pricingEvidenceSha256: sha("synthetic-pricing"), inputTokens: 1, outputTokens: 1, actualCostUsd: 0.1,
    latencyMs: 1, verifiedByUserId: human.userId };
  let validationPermitId: string | undefined;
  if (validation) proof = null;
  const runtime: PreparedMediaSessionRuntime = { resolve: () => ({ context, target, liveProof: proof,
    ...(validation ? { operatorValidation: { permitId: validationPermitId! } } : {}),
    request: { runnerId: "r", workspaceId: "w", agentId: "claude", title: "Synthetic Media Reviewer",
      prompt: "Review authorized #1321 through the exact scoped media tools.", config: { model: target.modelId, effort: target.effort, costBudgetUsd: 2, maxToolCalls: 10 } } }) };
  const identity = { rootSessionId: "root", childSessionId: "child", admissionId: "synthetic-media", requestSha256: sha("exact source and criteria") };
  const subject = { occurrenceId: "original-gate", evidenceId: "original-video" };
  // Disclosed synthetic permit scope only: no real Human mint, provider profile or live proof.
  let validationScope: OperatorVideoValidationScope | null = validation ? {
    identity, subject: { ...subject, profile: "paced", privateOracleCommitmentSha256: sha("disclosed synthetic test commitment, never a blind oracle") }, authorizedByUserId: human.userId, organizationId: human.organizationId,
    gate: { authority: "human", status: "pending", resourceDigest: sha(JSON.stringify(snapshot)), policyRevision: boundary.revision },
    source: { artifactId: "source", sha256: sha(source), sizeBytes: source.length, manifestSha256: sha("synthetic native manifest"),
      orderedFramesSha256: sha(JSON.stringify(syntheticValidationFrames())), criteriaSha256: sha("synthetic criteria"),
      privateOracleCommitmentSha256: sha("disclosed synthetic test commitment, never a blind oracle"),
      frames: 360, width: 1280, height: 720, durationUs: 12_000_000 },
    context, target, request: runtime.resolve(identity, subject)!.request, providerExecutableSha256: sha("synthetic installed exe"),
    nativeToolProfileSha256: sha("synthetic installed media tools"), namespaceLaunchSha256: sha("synthetic launch"), authoritySha256: sha("synthetic current authority"),
  } : null;
  const permits = validation ? new OperatorVideoValidationPermits(db.raw(), { current: () => validationScope }) : undefined;
  const validationProposal = { identity, subject: { ...subject, profile: "paced" as const,
    privateOracleCommitmentSha256: sha("disclosed synthetic test commitment, never a blind oracle") },
    expectedScopeSha256: sha(JSON.stringify(validationScope)), expiresAt: Date.now() + 30_000 };
  const permit = permits?.mint(human, validationProposal);
  if (validation) { assert.ok(permit); validationPermitId = permit.permitId; }
  const service = new SessionsService(db, hub, log, undefined, undefined, undefined, undefined, undefined, undefined,
    false, undefined, runtime, undefined, disclosures, permits);
  const ports: PreparedMediaSessionPorts = {
    database: db.raw(),
    preflightMaterialization: (id) => { const value = service.preflightPreparedMediaSession(id, subject);
      if (!value.ok) throw new Error(value.error); },
    materialize: (id) => { const value = service.materializePreparedMediaSession(id, subject);
      if (!value.ok || !value.data) throw new Error(value.error); return value.data; },
    preparedCommitted: (record) => service.publishPreparedMediaSession(record),
    currentAdmission: (sessionId) => service.campaignBudgetWorkerPreflight("root", { kind: "managed", sessionId }).data ?? null,
    currentIdentity: (sessionId) => { const session = db.getSession(sessionId), dispatch = db.campaignBudgets.dispatch(sessionId);
      return session && dispatch ? { rootSessionId: dispatch.rootSessionId, runnerId: session.runnerId, generation: dispatch.generation } : null; },
    authorize: async () => false, send: async () => { assert.fail("No actual provider send in preparation tests"); },
    reconcile: async () => null, cancelNeverDispatched: () => { throw new Error("Confirmed-unlaunched budget release adapter is not yet integrated."); },
  };
  const prepared = new PreparedMediaSessions(db.raw(), ports);
  return { db, hub, log, human, source, service, bootstrap, prepared, identity, subject, context, runtime, target, messages, ports, metadata,
    disclosures, revokeDisclosure: () => { retentionDisclosure = "Changed provider retention"; },
    makeDestinationPublic: () => { currentPrivacy = "public"; },
    dropProof: () => { proof = null; }, permits, permit, validationProposal,
    validationScope: () => validationScope, setValidationScope: (scope: OperatorVideoValidationScope | null) => { validationScope = scope; } };
}

// Compatibility regressions only: all runtime/proof/bytes in this harness are synthetic.
for (const [label, version, contract] of [
  ["public221 without private metadata", 221, undefined],
  ["public222 without private metadata", 222, undefined],
  ["private floor without metadata", 223, undefined],
  ["future number without metadata", 999, undefined],
  ["another installation contract", 223, { id: "other-contract", revision: 1 }],
  ["unknown contract revision", 223, { id: "wollipog-paced-video-review-v1", revision: 2 }],
] as const) {
  test(`private media compatibility refuses ${label} before preparation effects`, (t) => {
    const h = harness(); t.after(() => h.db.close());
    const capabilities = h.metadata.agents[0]!.capabilities as unknown as Record<string, unknown>;
    if (contract === undefined) delete capabilities.pacedVideoReviewContract;
    else capabilities.pacedVideoReviewContract = contract;
    h.db.registerRunner(h.metadata, 2, version);
    h.target.runnerProtocolVersion = version;
    h.context.controllerProtocolVersion = version;
    h.context.childProtocolVersion = version;
    h.hub.runnerProtocolVersion = () => version;
    h.messages.length = 0;
    const before = h.db.campaignBudgets.view("root");
    const result = h.service.preflightPreparedMediaSession(h.identity, h.subject);
    assert.equal(result.ok, false, "public version numbers and unrelated metadata cannot authorize private preparation");
    assert.deepEqual(h.db.campaignBudgets.view("root"), before);
    assert.deepEqual(h.messages, []);
    assert.equal(h.db.raw().prepare("SELECT COUNT(*) AS n FROM sessions").get()!.n, 2);
    assert.equal(h.db.raw().prepare("SELECT COUNT(*) AS n FROM prepared_media_sessions").get()!.n, 0);
    assert.equal(h.db.raw().prepare("SELECT COUNT(*) AS n FROM media_session_purposes").get()!.n, 0);
  });
}

test("Human validation permit materializes a real purpose-bound unsent Session without synthetic production proof or changing its Human gate", (t) => {
  const h = harness(undefined, true); t.after(() => h.db.close()); h.messages.length = 0;
  const original = h.db.workflowDecisionByOccurrence(h.subject.occurrenceId)!;
  assert.equal(original.authority, "human");
  assert.equal(h.runtime.resolve(h.identity, h.subject)!.liveProof, null);
  const actual = h.prepared.prepare(h.identity);
  const p = h.permits!.get(h.permit!.permitId)!;
  assert.equal(p.state, "bound");
  assert.equal(p.actual?.sessionId, actual.sessionId);
  assert.equal(p.actual?.generation, actual.admission.dispatch.generation);
  assert.equal(h.db.campaignBudgets.root(actual.sessionId), "root");
  assert.deepEqual(h.service.mediaSessionPurposes.get(actual.sessionId)?.operatorValidation,
    { permitId: p.permitId, scopeSha256: p.scopeSha256 });
  assert.equal(actual.command.spec.mediaReviewPurpose?.admissionId, h.identity.admissionId);
  assert.deepEqual(actual.command.spec.mediaReviewPurpose?.operatorValidation,
    { permitId: p.permitId, scopeSha256: p.scopeSha256 });
  assert.deepEqual(h.db.workflowDecisionByOccurrence(h.subject.occurrenceId), original);
  assert.deepEqual(h.messages, []);
  assert.equal(h.service.restart(actual.sessionId).ok, false);
  assert.equal(h.service.prompt(actual.sessionId, "Use a general tool").ok, false);
  assert.equal(h.permits!.mint(h.human, h.validationProposal), null, "same exact original permit cannot be reminted");
  assert.throws(() => h.permits!.bindPrepared(p.permitId, actual), /atomic validation/);
});

test("private compatibility cannot borrow another installation or a model-level assertion", (t) => {
  const h = harness(); t.after(() => h.db.close());
  const selected = h.metadata.agents[0]!;
  const contract = selected.capabilities!.pacedVideoReviewContract!;
  h.metadata.agents.push({ ...selected, id: "other-installation", capabilities: { ...selected.capabilities!, pacedVideoReviewContract: contract } });
  delete selected.capabilities!.pacedVideoReviewContract;
  (selected.capabilities!.models[0] as unknown as Record<string, unknown>).pacedVideoReviewContract = contract;
  h.db.registerRunner(h.metadata, 2, PACED_VIDEO_REVIEW_MIN_PROTOCOL);
  const before = h.db.campaignBudgets.view("root");
  const messagesBefore = h.messages.slice();
  assert.equal(h.service.preflightPreparedMediaSession(h.identity, h.subject).ok, false);
  assert.deepEqual(h.db.campaignBudgets.view("root"), before);
  assert.equal(h.db.raw().prepare("SELECT COUNT(*) AS n FROM sessions").get()!.n, 2);
  assert.equal(h.db.raw().prepare("SELECT COUNT(*) AS n FROM prepared_media_sessions").get()!.n, 0);
  assert.deepEqual(h.messages, messagesBefore, "preflight preserves the existing setup log without emitting another command");
});

test("current installation removal revokes source preparation while preserving its exact pending gate", (t) => {
  const h = harness(); t.after(() => h.db.close());
  assert.equal(h.service.preflightPreparedMediaSession(h.identity, h.subject).ok, true, "synthetic compatibility control only");
  const gate = h.db.workflowDecisionByOccurrence(h.subject.occurrenceId);
  h.metadata.agents = [];
  h.db.registerRunner(h.metadata, 3, PACED_VIDEO_REVIEW_MIN_PROTOCOL);
  h.messages.length = 0;
  const before = h.db.campaignBudgets.view("root");
  assert.equal(h.service.preflightPreparedMediaSession(h.identity, h.subject).ok, false);
  assert.deepEqual(h.db.workflowDecisionByOccurrence(h.subject.occurrenceId), gate);
  assert.deepEqual(h.db.campaignBudgets.view("root"), before);
  assert.deepEqual(h.messages, []);
});

for (const sessionId of ["root", "child"] as const) {
  for (const selection of [null, "", " "] as const) {
    test(`missing selected installation ${sessionId}/${JSON.stringify(selection)} cannot borrow another catalog or model contract`, (t) => {
      const h = harness(); t.after(() => h.db.close());
      const selected = h.metadata.agents[0]!;
      h.metadata.agents.push({ ...selected, id: "other-valid-installation", capabilities: { ...selected.capabilities! } });
      (selected.capabilities!.models[0] as unknown as Record<string, unknown>).pacedVideoReviewContract =
        { id: PACED_VIDEO_REVIEW_CONTRACT_ID, revision: 1 };
      h.db.registerRunner(h.metadata, 3, PACED_VIDEO_REVIEW_MIN_PROTOCOL);
      h.db.raw().prepare("UPDATE sessions SET agent_id=? WHERE id=?").run(selection, sessionId);
      const before = h.db.campaignBudgets.view("root"), messagesBefore = h.messages.slice();
      const gate = h.db.workflowDecisionByOccurrence(h.subject.occurrenceId);
      const result = h.service.preflightPreparedMediaSession(h.identity, h.subject);
      assert.equal(result.ok, false); assert.equal(result.status, 409);
      assert.deepEqual(h.db.campaignBudgets.view("root"), before);
      assert.deepEqual(h.messages, messagesBefore);
      assert.deepEqual(h.db.workflowDecisionByOccurrence(h.subject.occurrenceId), gate);
      assert.equal(h.db.raw().prepare("SELECT COUNT(*) AS n FROM sessions").get()!.n, 2);
      assert.equal(h.db.raw().prepare("SELECT COUNT(*) AS n FROM prepared_media_sessions").get()!.n, 0);
      assert.equal(h.db.raw().prepare("SELECT COUNT(*) AS n FROM media_session_purposes").get()!.n, 0);
    });
  }
}
test("validation worker messages, changed authority/profile/source, expiry/revocation and unknown permit cannot prepare", (t) => {
  const mutations = [
    (h: ReturnType<typeof harness>) => { h.permits!.revoke(h.human, h.permit!.permitId); },
    (h: ReturnType<typeof harness>) => { h.setValidationScope(null); },
    (h: ReturnType<typeof harness>) => { h.validationScope()!.nativeToolProfileSha256 = sha("replacement tool profile"); },
    (h: ReturnType<typeof harness>) => { h.validationScope()!.source.criteriaSha256 = sha("replacement criteria"); },
    (h: ReturnType<typeof harness>) => { h.validationScope()!.source.privateOracleCommitmentSha256 = sha("changed truth after mint"); },
    (h: ReturnType<typeof harness>) => { h.db.raw().prepare("UPDATE workflow_decisions SET authority='orchestrator'").run(); },
    (h: ReturnType<typeof harness>) => { h.db.raw().prepare("UPDATE workflow_decisions SET resource_digest=?").run(sha("replacement occurrence")); },
    (h: ReturnType<typeof harness>) => { const resolve = h.runtime.resolve;
      h.runtime.resolve = (id, subject) => ({ ...resolve(id, subject)!, liveProof: { proofId: "fixture-bootstrap" } as VideoProfileLiveProof }); },
    (h: ReturnType<typeof harness>) => { h.runtime.resolve = () => ({ ...h.validationScope()!, liveProof: null,
      operatorValidation: { permitId: "unminted-worker-claim" } }); },
  ];
  for (const mutate of mutations) {
    const h = harness(undefined, true); t.after(() => h.db.close()); h.messages.length = 0; mutate(h);
    assert.throws(() => h.prepared.prepare(h.identity));
    assert.equal(h.db.raw().prepare("SELECT COUNT(*) AS n FROM media_session_purposes").get()!.n, 0);
    assert.equal(h.db.raw().prepare("SELECT COUNT(*) AS n FROM campaign_budget_members").get()!.n, 2);
    assert.deepEqual(h.messages, []);
  }
  const h = harness(undefined, true); t.after(() => h.db.close());
  const agent = { kind: "agent" as const, credentialSessionId: "child", actorId: "agent:child", organizationId: h.human.organizationId,
    delegatedScope: h.db.sessionScope("child")! };
  assert.equal(h.permits!.mint(agent, { ...h.validationProposal, identity: { ...h.identity, admissionId: "worker" } }), null);
  assert.equal(h.permits!.revoke(agent, h.permit!.permitId), false);
  assert.equal(h.permits!.revoke({ ...h.human, role: "viewer" as const }, h.permit!.permitId), false);
  assert.equal(h.permits!.mint({ ...h.human, userId: "another-human" }, h.validationProposal), null);
  assert.equal(h.permits!.mint(h.human, { ...h.validationProposal, expectedScopeSha256: sha("stale Human-inspected profile") }), null);
  const expired = new OperatorVideoValidationPermits(h.db.raw(), { current: () => h.validationScope() }, () => h.permit!.expiresAt);
  assert.equal(expired.current(h.permit!.permitId), null);
});
test("validation materialization rollback restores one-shot permit with real Session/member/purpose", (t) => {
  const h = harness(undefined, true); t.after(() => h.db.close()); h.messages.length = 0;
  const original = h.ports.materialize;
  h.ports.materialize = (identity) => { original(identity); throw new Error("Synthetic post-claim storage failure"); };
  assert.throws(() => h.prepared.prepare(h.identity), /storage failure/);
  assert.equal(h.permits!.get(h.permit!.permitId)!.state, "authorized");
  assert.equal(h.db.raw().prepare("SELECT COUNT(*) AS n FROM sessions").get()!.n, 2);
  assert.equal(h.db.raw().prepare("SELECT COUNT(*) AS n FROM campaign_budget_members").get()!.n, 2);
  assert.equal(h.db.raw().prepare("SELECT COUNT(*) AS n FROM media_session_purposes").get()!.n, 0);
  assert.deepEqual(h.messages, []);
  h.ports.materialize = original;
  assert.ok(h.prepared.prepare(h.identity).sessionId);
});
test("rolled-back media preparation emits no phantom Session or creation audit", (t) => {
  const h = harness(undefined, true); t.after(() => h.db.close());
  let broadcasts = 0, createdLogs = 0;
  h.hub.sessionChanged = () => { broadcasts++; };
  h.log.info = () => { createdLogs++; };
  const materialize = h.ports.materialize;
  h.ports.materialize = (identity) => { materialize(identity); throw new Error("Synthetic storage failure after materialization"); };
  assert.throws(() => h.prepared.prepare(h.identity), /storage failure/);
  assert.equal(h.db.raw().prepare("SELECT COUNT(*) AS n FROM sessions").get()!.n, 2);
  assert.equal(broadcasts, 0, "a rolled-back actual Session must never be announced");
  assert.equal(createdLogs, 0, "creation audit must wait for the owning commit");
});
test("nested work-item assignment cannot publish a rolled-back prepared media Session", (t) => {
  const h = harness(); t.after(() => h.db.close());
  const plan = h.service.recordCampaignPlan("root", { items: [{ key: "synthetic-owned-work" }], planComplete: true });
  assert.ok(plan.ok && plan.data, plan.error ?? "Synthetic work-item plan must be recorded");
  const resolve = h.runtime.resolve;
  h.runtime.resolve = (...args) => {
    const resolved = resolve(...args)!;
    return { ...resolved, request: { ...resolved.request, campaignWorkItemId: plan.data!.items[0]!.workItemId } };
  };
  const published: Array<{ id: string; beforeCommit: boolean }> = [];
  h.hub.sessionChangedById = (id) => { published.push({ id, beforeCommit: h.db.raw().isTransaction }); };
  const materialize = h.ports.materialize;
  h.ports.materialize = (identity) => { materialize(identity); throw new Error("Synthetic failure after nested work-item assignment"); };
  assert.throws(() => h.prepared.prepare(h.identity));
  assert.equal(h.db.raw().prepare("SELECT COUNT(*) AS n FROM sessions").get()!.n, 2);
  assert.deepEqual(published, [], "no campaign or child membership may publish from the outer preparation transaction");
  assert.equal(h.db.raw().prepare("SELECT COUNT(*) AS n FROM campaign_work_attempts").get()!.n, 0);
});
for (const phase of ["preflight", "materialize"] as const) {
  test("private media " + phase + " refuses work-item assignment before all effects", (t) => {
    const h = harness(); t.after(() => h.db.close());
    const plan = h.service.recordCampaignPlan("root", { items: [{ key: "synthetic-implementation" }], planComplete: true });
    assert.ok(plan.ok && plan.data, plan.error ?? "Synthetic work-item plan must be recorded");
    const resolve = h.runtime.resolve;
    h.runtime.resolve = (...args) => {
      const resolved = resolve(...args)!;
      return { ...resolved, request: { ...resolved.request, campaignWorkItemId: plan.data!.items[0]!.workItemId } };
    };
    const budget = h.db.campaignBudgets.view("root");
    const events = h.db.listEvents("root"), root = h.db.getSession("root");
    h.messages.length = 0;
    let publications = 0;
    h.hub.sessionChanged = () => { publications++; };
    h.hub.sessionChangedById = () => { publications++; };
    if (phase === "materialize") h.db.raw().exec("BEGIN");
    try {
      const result = phase === "preflight"
        ? h.service.preflightPreparedMediaSession(h.identity, h.subject)
        : h.service.materializePreparedMediaSession(h.identity, h.subject);
      assert.equal(result.ok, false); assert.equal(result.status, 409);
      assert.match(result.error ?? "", /media reviewers cannot name a campaign work item/u);
      assert.deepEqual(h.db.campaignBudgets.view("root"), budget);
      assert.deepEqual(h.db.getSession("root"), root);
      assert.deepEqual(h.db.listEvents("root"), events);
      assert.equal(h.db.raw().prepare("SELECT COUNT(*) AS n FROM sessions").get()!.n, 2);
      assert.equal(h.db.raw().prepare("SELECT COUNT(*) AS n FROM campaign_work_attempts").get()!.n, 0);
      assert.equal(h.db.raw().prepare("SELECT COUNT(*) AS n FROM prepared_media_sessions").get()!.n, 0);
      assert.equal(publications, 0); assert.deepEqual(h.messages, []);
    } finally { if (phase === "materialize") h.db.raw().exec("ROLLBACK"); }
  });
}
test("media preparation announces its actual committed record once and refuses an external commit boundary", (t) => {
  const h = harness(); t.after(() => h.db.close());
  let broadcasts = 0;
  const logs: string[] = [];
  h.hub.sessionChanged = (session) => {
    assert.equal(h.db.raw().isTransaction, false);
    assert.equal(h.prepared.get(h.identity)?.sessionId, session.id);
    broadcasts++;
  };
  h.log.info = (message) => { assert.equal(h.db.raw().isTransaction, false); logs.push(message); };
  const actual = h.prepared.prepare(h.identity);
  assert.equal(h.prepared.prepare(h.identity).sessionId, actual.sessionId);
  assert.equal(broadcasts, 1);
  assert.equal(logs.filter(message => message.startsWith("session created ")).length, 1);
  const snapshots = logs.filter(message => message.startsWith("{")).map(message => JSON.parse(message));
  assert.deepEqual(snapshots, [{ event: "campaign_child_review_policy_snapshot", entryPoint: "prepared_media",
    sessionId: actual.sessionId, parentSessionId: "root", ...h.db.getSession(actual.sessionId)!.reviewPolicy }]);
  assert.equal(logs.length, 2, "creation and snapshot audits publish once, after the owning commit");
  h.db.raw().exec("BEGIN");
  try { assert.throws(() => h.prepared.prepare(h.identity), /own its commit boundary/); }
  finally { h.db.raw().exec("ROLLBACK"); }
});

function syntheticValidationFrames() {
  return Array.from({ length: 360 }, (_, i) => ({ index: i, ptsUs: Math.round(i * 1_000_000 / 30),
    durationUs: Math.round((i + 1) * 1_000_000 / 30) - Math.round(i * 1_000_000 / 30),
    sha256: sha("synthetic frame " + i), sizeBytes: 10 }));
}

function releaseHarness(t: { after(fn: () => void): void }) {
  const h = harness(); t.after(() => h.db.close()); h.messages.length = 0;
  const release = new PreparedMediaReservationRelease(h.db.raw(), h.db.campaignBudgets);
  h.ports.cancelNeverDispatched = (record) => release.release(record);
  h.ports.authorize = async () => true; // Disclosed synthetic current-source adapter; no live grant.
  const actual = h.prepared.prepare(h.identity);
  const binding = { namespaceLaunchSha256: sha("synthetic launch"), namespacePolicySha256: sha("synthetic namespace"),
    authoritySha256: sha("synthetic authority"), grant: { reviewId: "synthetic-review", reviewerSessionId: actual.sessionId,
      childSessionId: "child", occurrenceId: h.subject.occurrenceId, policyRevision: actual.admission.authorityRevision,
      sourceEvidenceId: h.subject.evidenceId, sourceArtifactId: "source", sourceSha256: sha(h.source),
      manifestSha256: sha("synthetic manifest"), bindingSha256: sha("synthetic binding"), criteriaSha256: sha("synthetic criteria"),
      expiresAt: Date.now() + 30_000, frames: [{ index: 0, ptsUs: 0, durationUs: 33_333, sha256: sha("synthetic native frame"), sizeBytes: 10 }],
      deliveryPlanSha256: pacedGrantPlanDigest([{ index: 0, ptsUs: 0, durationUs: 33_333, sha256: sha("synthetic native frame"), sizeBytes: 10 }])! } };
  const fenceIdentity = (record: import("./prepared-media-sessions.js").PreparedMediaRecord) => ({ rootSessionId: record.rootSessionId,
    sessionId: record.sessionId, runnerId: record.runnerId, generation: record.admission.dispatch.generation,
    commandSha256: record.commandSha256, dispatchSha256: record.dispatchSha256! });
  return { ...h, actual, binding, release, fenceIdentity };
}
test("never-enqueued actual preparation cancels and deactivates only its reservation without manufacturing settlement or erasing purpose", (t) => {
  const h = releaseHarness(t);
  const before = h.db.campaignBudgets.view("root")!;
  const cancelled = h.prepared.cancelPrepared(h.identity);
  assert.equal(cancelled.state, "cancelled");
  assert.equal(h.db.campaignBudgets.active(h.actual.sessionId), false);
  assert.equal(h.db.getSession(h.actual.sessionId)!.status, "stopped");
  assert.equal(h.db.campaignBudgets.view("root")!.outstanding.costUsd, before.outstanding.costUsd - h.actual.admission.allocation.costUsd!);
  assert.deepEqual(h.db.campaignBudgets.view("root")!.actual, before.actual);
  assert.equal(h.db.campaignBudgets.completedAttestation(h.actual.sessionId), null);
  assert.equal(h.db.raw().prepare("SELECT COUNT(*) AS n FROM campaign_budget_checkpoints").get()!.n, 0);
  assert.equal(h.db.raw().prepare("SELECT COUNT(*) AS n FROM campaign_budget_settlements").get()!.n, 0);
  assert.equal(h.service.mediaSessionPurposes.owns(h.actual.sessionId), true);
  assert.equal(h.service.restart(h.actual.sessionId).ok, false);
  assert.throws(() => h.prepared.cancelPrepared(h.identity), /possibly dispatched/);
  assert.deepEqual(h.messages, []);
});
test("guarded release rejects usage, checkpoints, settlements, replacement generation, generic identity and storage failure", (t) => {
  for (const mutate of [
    (h: ReturnType<typeof releaseHarness>) => h.db.campaignBudgets.replaceDispatch(h.actual.sessionId),
    (h: ReturnType<typeof releaseHarness>) => h.db.raw().prepare("UPDATE campaign_budget_members SET cost=1 WHERE session_id=?").run(h.actual.sessionId),
    (h: ReturnType<typeof releaseHarness>) => h.db.raw().prepare("UPDATE campaign_budget_members SET tools=1 WHERE session_id=?").run(h.actual.sessionId),
    (h: ReturnType<typeof releaseHarness>) => h.db.campaignBudgets.recordCheckpoint(h.actual.sessionId,
      { generation: h.actual.admission.dispatch.generation, historyEpoch: 0, throughSeq: 0, costUsd: 0 }),
    (h: ReturnType<typeof releaseHarness>) => h.db.raw().prepare("INSERT INTO campaign_budget_settlements VALUES (?,?,0,0)").run(h.actual.sessionId, "synthetic previous settlement"),
    (h: ReturnType<typeof releaseHarness>) => h.db.raw().prepare("CREATE TRIGGER synthetic_cancel_failure BEFORE UPDATE ON prepared_media_sessions WHEN NEW.state='cancelled' BEGIN SELECT RAISE(ABORT,'Synthetic cancellation storage failure'); END").run(),
  ]) {
    const h = releaseHarness(t); mutate(h);
    assert.throws(() => h.prepared.cancelPrepared(h.identity));
    assert.equal(h.prepared.get(h.identity)!.state, "prepared");
    assert.equal(h.db.campaignBudgets.active(h.actual.sessionId), true);
    assert.equal(h.service.mediaSessionPurposes.owns(h.actual.sessionId), true);
  }
  const h = releaseHarness(t);
  assert.throws(() => h.release.release({ ...h.actual, ...h.identity, commandSha256: sha(JSON.stringify(h.actual.command)),
    dispatchSha256: null, state: "cancelling", binding: null }), /cannot be released/);
  h.db.raw().exec("SAVEPOINT synthetic_generic");
  try { assert.equal(h.db.campaignBudgets.deactivateNeverDispatchedMediaReservation("child", {
    rootSessionId: "root", runnerId: "r", generation: h.db.campaignBudgets.dispatch("child")!.generation,
    commandSha256: sha("code-job"), dispatchSha256: null }), false); }
  finally { h.db.raw().exec("RELEASE synthetic_generic"); }
});
test("unknown launch retains capacity; only owning authenticated runner terminal fence permits atomic cancellation and blocks late launch", async (t) => {
  const h = releaseHarness(t); h.ports.authorize = async () => true; h.ports.send = async () => "unknown";
  await h.prepared.bind(h.identity, h.binding);
  const uncertain = await h.prepared.dispatch(h.identity);
  const runnerDb = new DatabaseSync(":memory:"); t.after(() => runnerDb.close());
  const fences = new RunnerMediaDispatchFences(runnerDb), identity = h.fenceIdentity(uncertain);
  const receipt = fences.cancelBeforeLaunch(identity)!;
  assert.equal(h.release.recordAuthenticatedFence("agent:child", receipt), false);
  assert.equal(h.service.onMediaReviewNeverDispatched("agent:child", receipt), false);
  assert.equal(h.release.recordAuthenticatedFence("r", { ...receipt, fenceSha256: sha("forged receipt") }), false);
  h.ports.reconcile = async () => ({ ...identity, outcome: "never_dispatched" });
  await assert.rejects(h.prepared.reconcile(h.identity), /cannot be released/);
  assert.equal(h.prepared.get(h.identity)!.state, "uncertain");
  assert.equal(h.db.campaignBudgets.active(h.actual.sessionId), true);
  assert.equal(h.service.onMediaReviewNeverDispatched("r", receipt), true);
  assert.equal(h.release.recordAuthenticatedFence("r", receipt), true, "exact authenticated receipt replay changes nothing");
  assert.equal((await h.prepared.reconcile(h.identity)).state, "cancelled");
  assert.equal(h.db.campaignBudgets.active(h.actual.sessionId), false);
  assert.equal(fences.claim(identity), false, "permanent runner fence blocks delayed original command");
  assert.equal(h.db.campaignBudgets.completedAttestation(h.actual.sessionId), null);
  assert.equal(h.service.mediaSessionPurposes.owns(h.actual.sessionId), true);
});
test("cancellation wins before dispatch CAS; claimed dispatch cannot release on an ambiguous send", async (t) => {
  const h = releaseHarness(t); await h.prepared.bind(h.identity, h.binding);
  let resume!: () => void; const wait = new Promise<void>((resolve) => { resume = resolve; }); let sends = 0;
  h.ports.authorize = async () => { await wait; return true; };
  h.ports.send = async () => { sends++; return "unknown"; };
  const dispatch = h.prepared.dispatch(h.identity);
  assert.equal(h.prepared.cancelPrepared(h.identity).state, "cancelled");
  resume(); await assert.rejects(dispatch, /dispatch authority denied/);
  assert.equal(sends, 0); assert.equal(h.db.campaignBudgets.active(h.actual.sessionId), false);
  const other = releaseHarness(t); await other.prepared.bind(other.identity, other.binding);
  other.ports.authorize = async () => true;
  let finish!: () => void; const sendWait = new Promise<void>((resolve) => { finish = resolve; });
  let entered!: () => void; const started = new Promise<void>((resolve) => { entered = resolve; });
  other.ports.send = async () => { entered(); await sendWait; return "unknown"; };
  const running = other.prepared.dispatch(other.identity); await started;
  assert.throws(() => other.prepared.cancelPrepared(other.identity), /possibly dispatched/);
  assert.equal(other.db.campaignBudgets.active(other.actual.sessionId), true);
  finish(); assert.equal((await running).state, "uncertain");
});
test("exact validation grant binds one dispatch; unknown reply retains actual capacity and replacement generation loses access", async (t) => {
  const h = harness(undefined, true); t.after(() => h.db.close()); h.messages.length = 0;
  const actual = h.prepared.prepare(h.identity), s = h.validationScope()!;
  const binding = {
    namespaceLaunchSha256: s.namespaceLaunchSha256, namespacePolicySha256: s.target.reviewerNamespaceSha256,
    authoritySha256: s.authoritySha256,
    grant: { operatorValidation: h.permits!.purpose(h.permit!.permitId)!, reviewId: "synthetic-validation-review",
      reviewerSessionId: actual.sessionId, childSessionId: h.identity.childSessionId, occurrenceId: h.subject.occurrenceId,
      policyRevision: s.gate.policyRevision, sourceEvidenceId: h.subject.evidenceId, sourceArtifactId: s.source.artifactId,
      sourceSha256: s.source.sha256, manifestSha256: s.source.manifestSha256, bindingSha256: sha(JSON.stringify(h.permits!.binding(h.permit!.permitId))),
      criteriaSha256: s.source.criteriaSha256, expiresAt: h.permit!.expiresAt - 1,
      frames: syntheticValidationFrames(), deliveryPlanSha256: pacedGrantPlanDigest(syntheticValidationFrames())! },
  };
  h.ports.authorize = async (record) => h.permits!.authorize(record);
  let sends = 0;
  h.ports.send = async () => { sends++; return "unknown"; };
  const bound = await h.prepared.bind(h.identity, binding);
  assert.equal(h.permits!.authorize(bound), true);
  for (const mutate of [
    (record: typeof bound) => { delete record.binding!.grant.operatorValidation; },
    (record: typeof bound) => { record.binding!.grant.operatorValidation!.scopeSha256 = sha("borrowed permit"); },
    (record: typeof bound) => { record.binding!.namespaceLaunchSha256 = sha("replaced namespace"); },
    (record: typeof bound) => { record.binding!.grant.criteriaSha256 = sha("borrowed criteria"); },
    (record: typeof bound) => { record.binding!.grant.frames.pop(); },
    (record: typeof bound) => { record.binding!.grant.frames[157]!.sha256 = sha("changed transient"); },
  ]) { const changed = structuredClone(bound); mutate(changed); assert.equal(h.permits!.authorize(changed), false); }
  const uncertain = await h.prepared.dispatch(h.identity);
  assert.equal(uncertain.state, "uncertain");
  assert.equal((await h.prepared.dispatch(h.identity)).state, "uncertain");
  assert.equal(sends, 1);
  assert.equal(h.db.campaignBudgets.root(actual.sessionId), "root");
  assert.equal(h.permits!.get(h.permit!.permitId)!.state, "bound");
  h.db.campaignBudgets.replaceDispatch(actual.sessionId);
  assert.equal(h.permits!.authorize(uncertain), false);
  assert.equal(h.service.mediaSessionPurposes.owns(actual.sessionId), true);
  assert.throws(() => h.prepared.cancelPrepared(h.identity), /possibly dispatched/);
  assert.deepEqual(h.messages, [], "synthetic send did not start any real provider");
});
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
  let allowed = true, settled = false;
  const store = createControlPlaneVideoReviewStore(h.db);
  const runtimeAccess: VideoReviewRuntimeAccess = { currentBinding: () => allowed ? binding : null,
    // Synthetic trusted-port settlement; this unsent Session is never real media usage proof.
    normalCompletion: () => settled, workerAdmission: (_binding, phase) => phase === "historical"
      ? settled ? reviewer.admission : null : h.service.campaignBudgetWorkerPreflight("root",
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
    false, undefined, h.runtime, approvals, h.disclosures);
  const reference = { evidenceId: "original-video", reviewId: record.reviewId, verdictId: "not-yet-attested",
    reviewerSessionId: reviewer.sessionId };
  const resolve = (resolution = { outcome: "approve" as const, evidenceReviewed: [] as string[], delegatedVideoEvidence: [reference] }) =>
    service.resolveWorkflowDecision("root", "child", original.occurrenceId, resolution, "orchestrator",
      { kind: "agent", id: "root" }, () => true);
  const complete = () => {
    // Window by window, as the runner's paced reviewer delivers them; overlap frames repeat.
    for (const window of pacedVideoReviewWindowPlan(record.manifest.frames).windows) {
      for (let index = window.firstIndex; index < window.endIndex;) {
        const batch = runtime.deliverBatch(record.reviewId, reviewer.sessionId, index, window.endIndex);
        runtime.acknowledgeBatch(record.reviewId, reviewer.sessionId, batch.deliveries.map((delivery) => delivery.receipt));
        index = batch.nextIndex;
      }
    }
    const verdict = runtime.recordVerdict(record.reviewId, reviewer.sessionId, { outcome: "accept", criteria: [{
      criterionId: "transients", outcome: "pass", observedFrameIndices: [157],
      observation: "Disclosed deterministic fixture observation; not a blind model claim." }], rationale: "Synthetic contract test only." });
    reference.verdictId = verdict.verdictId; settled = true; return verdict;
  };
  return { ...h, preparedRuntime: h.runtime, service, approvals, approvalAccess, runtimeAccess, runtime, store, original, record, reference, resolve, complete,
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
  assert.equal(h.store.latestReceipts(h.record.reviewId).length,
    pacedVideoReviewWindowPlan(h.record.manifest.frames).windows.reduce((n, w) => n + w.endIndex - w.firstIndex, 0),
    "every window receipts each of its frames");
  const consumed = await h.service.consumeWorkflowDecision("child", h.original.occurrenceId,
    { resourceSnapshot: h.original.resourceSnapshot });
  assert.ok(consumed.ok, consumed.error ?? "Consumption refused"); assert.equal(consumed.data?.status, "consumed");
  assert.equal((await h.service.consumeWorkflowDecision("child", h.original.occurrenceId,
    { resourceSnapshot: h.original.resourceSnapshot })).ok, false, "consumption cannot replay");
});
test("Session deletion cascades exact delegated approval provenance", async (t) => {
  for (const target of ["child", "root"]) {
    const h = await gateHarness(t); if (!h) return; h.complete();
    assert.ok(h.resolve().ok);
    assert.equal(h.db.raw().prepare("PRAGMA foreign_keys").get()!.foreign_keys, 1);
    assert.doesNotThrow(() => h.db.deleteSession(target));
    assert.equal(h.db.raw().prepare("SELECT COUNT(*) AS n FROM workflow_video_approvals").get()!.n, 0);
  }
});
test("prior prepared approval schema migrates transactionally without changing its exact provenance", async (t) => {
  const h = await gateHarness(t); if (!h) return; h.complete(); assert.ok(h.resolve().ok);
  const before = h.db.raw().prepare("SELECT * FROM workflow_video_approvals").get();
  h.db.raw().exec("ALTER TABLE workflow_video_approvals RENAME TO previous_approval;" +
    "CREATE TABLE workflow_video_approvals (occurrence_id TEXT PRIMARY KEY REFERENCES workflow_decisions(occurrence_id),record TEXT NOT NULL,sha256 TEXT NOT NULL);" +
    "INSERT INTO workflow_video_approvals SELECT * FROM previous_approval; DROP TABLE previous_approval;");
  new WorkflowVideoEvidenceApprovals(h.db, h.runtime, h.approvalAccess);
  assert.deepEqual(h.db.raw().prepare("SELECT * FROM workflow_video_approvals").get(), before);
  assert.doesNotThrow(() => h.db.deleteSession("child"));
  assert.equal(h.db.raw().prepare("SELECT COUNT(*) AS n FROM workflow_video_approvals").get()!.n, 0);
});
test("Stop atomically cancels only an exact locally never-enqueued media reservation", (t) => {
  const h = releaseHarness(t); h.messages.length = 0;
  const stopped = h.service.stop(h.actual.sessionId); assert.ok(stopped.ok);
  assert.equal(h.db.getSession(h.actual.sessionId)?.status, "stopped");
  assert.equal(h.prepared.get(h.identity)?.state, "cancelled");
  assert.equal(h.db.campaignBudgets.active(h.actual.sessionId), false);
  assert.equal(h.db.campaignBudgets.completedAttestation(h.actual.sessionId), null, "cancellation is never fabricated final usage");
  assert.ok(h.service.stop(h.actual.sessionId).ok, "duplicate Stop of the cancelled command is a local no-op");
  assert.deepEqual(h.messages, [], "a locally unqueued command needs no provider Stop");
});
test("Stop and archive retain queued unknown, replaced or missing-table media capacity without generic dispatch", async (t) => {
  for (const mode of ["unknown", "replacement", "missing-table"]) {
    const h = releaseHarness(t); h.messages.length = 0;
    if (mode === "unknown") {
      h.ports.authorize = async () => true; h.ports.send = async () => "unknown";
      await h.prepared.bind(h.identity, h.binding); await h.prepared.dispatch(h.identity);
    } else if (mode === "replacement") h.db.campaignBudgets.replaceDispatch(h.actual.sessionId);
    else h.db.raw().exec("DROP TABLE media_never_dispatched_fences");
    assert.equal(h.service.stop(h.actual.sessionId).ok, false);
    assert.equal(h.service.setArchived(h.actual.sessionId, true).ok, false);
    assert.equal(h.db.getSession(h.actual.sessionId)?.status, "queued");
    assert.equal(h.db.campaignBudgets.active(h.actual.sessionId), true);
    assert.equal(h.db.campaignBudgets.completedAttestation(h.actual.sessionId), null);
    assert.deepEqual(h.messages, []);
  }
});
test("all steering entry points refuse permanent media purpose before persistence or RPC", async (t) => {
  const h = releaseHarness(t); h.messages.length = 0;
  h.db.updateSessionStatus(h.actual.sessionId, "running", 9);
  h.db.raw().prepare("UPDATE sessions SET agent_capabilities=? WHERE id=?")
    .run(JSON.stringify({ supportsSteering: true }), h.actual.sessionId);
  h.hub.activeTurnIdForSession = () => "synthetic-active-turn";
  let requests = 0;
  h.hub.requestFromRunner = async () => { requests++; throw new Error("Synthetic RPC only, no actual provider"); };
  for (const invoke of [
    () => h.service.steer(h.actual.sessionId, { submissionId: "synthetic-steer", turnId: "synthetic-active-turn", text: "Untrusted fixture text" }),
    () => h.service.promptOrSteer(h.actual.sessionId, "Untrusted fixture text"),
  ]) {
    const result = await invoke(); assert.equal(result.ok, false);
    assert.equal(result.error, MEDIA_SESSION_PURPOSE_ERROR);
  }
  assert.equal(requests, 0);
  assert.equal(h.db.findSteeringAttemptBySubmission(h.actual.sessionId, "synthetic-steer"), null);
  assert.deepEqual(h.messages, []);
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
    false, undefined, h.preparedRuntime, restartedApprovals, h.disclosures);
  const consumed = await restarted.consumeWorkflowDecision("child", h.original.occurrenceId, { resourceSnapshot: h.original.resourceSnapshot });
  assert.ok(consumed.ok, consumed.error ?? "Durable proof failed after restart");
  assert.equal(consumed.data?.status, "consumed");
});

test("current media authority revocation invalidates approval before consume", async (t) => {
  const h = await gateHarness(t); if (!h) return; h.complete(); assert.ok(h.resolve().ok); h.revoke();
  const consumed = await h.service.consumeWorkflowDecision("child", h.original.occurrenceId, { resourceSnapshot: h.original.resourceSnapshot });
  assert.equal(consumed.ok, false); assert.equal(h.db.workflowDecisionByOccurrence(h.original.occurrenceId)?.status, "revoked");
});

test("provider retention and destination privacy are current at preparation, resolution and consumption", async (t) => {
  const before = harness(); t.after(() => before.db.close()); before.makeDestinationPublic();
  assert.throws(() => before.prepared.prepare(before.identity));
  assert.equal(before.db.raw().prepare("SELECT COUNT(*) AS n FROM media_session_purposes").get()!.n, 0);
  const resolve = await gateHarness(t); if (!resolve) return; resolve.complete(); resolve.revokeDisclosure();
  assert.equal(resolve.resolve().ok, false);
  const consume = await gateHarness(t); if (!consume) return; consume.complete(); assert.ok(consume.resolve().ok);
  consume.makeDestinationPublic();
  assert.equal((await consume.service.consumeWorkflowDecision("child", consume.original.occurrenceId,
    { resourceSnapshot: consume.original.resourceSnapshot })).ok, false);
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

// Merge-boundary regressions: issue limits and disclosed media authority must compose atomically.
for (const scenario of ["issue count", "outdated participant", "malformed disclosure", "stale disclosure", "valid composition"] as const) {
  test(`human campaign CAS composes issue limits and media disclosure: ${scenario}`, (t) => {
    const h = harness(); t.after(() => h.db.close());
    if (scenario === "issue count") {
      const policy = h.db.getSession("root")!.orchestratorPolicy!;
      policy.issueScope!.issueNumbers = [1321, 2939];
      policy.issueNumbers = [1321, 2939];
      h.db.raw().prepare("UPDATE sessions SET orchestrator_policy=? WHERE id='root'").run(JSON.stringify(policy));
    }
    if (scenario === "outdated participant") h.db.registerRunner(h.metadata, 3, 216);
    let disclosureReads = 0;
    const disclosures = {
      destination: () => { disclosureReads++; return {
        organizationId: h.human.organizationId, privacy: "private" as const, disclosureRevision: 1,
      }; },
      provider: () => { disclosureReads++; return {
        disclosureRevision: 1, retentionDisclosure: "Synthetic CAS composition fixture; no provider delivery.",
        reviewers: [{ driver: "claude-code" as const, modelId: "claude-opus-5-5" }],
      }; },
    };
    const service = new SessionsService(h.db, h.hub, h.log, undefined, undefined, undefined, undefined, undefined, undefined,
      false, undefined, undefined, undefined, disclosures);
    const root = h.db.getSession("root")!, control = root.orchestratorPolicy!.control!;
    assert.equal(control.mode, "full_control"); if (control.mode !== "full_control") throw new Error("No fixture boundary");
    const issueAuthority = { epics: [1321], relatedFollowUps: true, maxIssues: 1, closureReasons: ["completed" as const] };
    const proposal = { mode: "full_control" as const, objective: control.boundary.objective,
      operations: control.boundary.operations, delegatablePolicyIds: control.boundary.delegatablePolicyIds,
      budgetAuthority: control.boundary.budgetAuthority, issueAuthority, evidenceAuthority: {
        destinationConfigurationId: scenario === "malformed disclosure" ? "" : "synthetic-private",
        destinationDisclosureRevision: scenario === "stale disclosure" ? 2 : 1,
        providers: [{ providerId: "synthetic-provider", disclosureRevision: 1,
          reviewers: [{ driver: "claude-code" as const, modelId: "claude-opus-5-5" }] }],
      } };
    const state = () => ({ root: h.db.getSession("root"), budget: h.db.campaignBudgets.view("root"),
      gate: h.db.workflowDecisionByOccurrence("original-gate"), governance: h.db.listGovernanceAudit("root"),
      mutations: h.db.listMutationAudit(h.human.organizationId), messages: structuredClone(h.messages) });
    const before = state(), revision = root.parentControlPolicy!.revision;
    const result = service.setCampaignControl("root", proposal, revision, h.human);
    if (scenario !== "valid composition") {
      assert.equal(result.ok, false);
      assert.deepEqual(state(), before, "refusal cannot change policy, audit, budget, occurrence or runner messages");
      if (scenario === "issue count") assert.match(result.error!, /scope limit/u);
      if (scenario === "outdated participant") assert.equal(result.status, 409);
      if (scenario === "issue count" || scenario === "outdated participant") {
        assert.equal(disclosureReads, 0, "issue bounds refuse before deriving media evidence authority");
      }
      return;
    }
    assert.ok(result.ok, result.error ?? "Valid composed Human CAS refused");
    const next = result.data!.orchestratorPolicy!.control!;
    assert.equal(next.mode, "full_control"); if (next.mode !== "full_control") throw new Error("No composed boundary");
    assert.deepEqual(next.boundary.issueAuthority, issueAuthority);
    assert.deepEqual(next.boundary.budgetAuthority, control.boundary.budgetAuthority);
    assert.deepEqual(result.data!.orchestratorPolicy!.issueScope, root.orchestratorPolicy!.issueScope);
    assert.equal(next.boundary.evidenceAuthority?.authorizedByUserId, h.human.userId);
    assert.equal(next.boundary.evidenceAuthority?.revision, revision + 1);
    assert.equal(next.boundary.evidenceAuthority?.campaignRootSessionId, "root");
    assert.equal(next.boundary.evidenceAuthority?.providers[0]?.retentionDisclosure, disclosures.provider().retentionDisclosure);
    assert.equal(h.db.workflowDecisionByOccurrence("original-gate")?.status, "revoked");
    assert.deepEqual(h.messages.filter((message) => (message as { type?: string }).type === "start_session"), []);
  });
}

// Disclosed SYNTHETIC fixtures only. No live principal/capture/provider/media/usage proof.
test("Session deletion removes private quality metadata while retaining exact unknown command and budget proof", async (t) => {
  const h = await gateHarness(t); if (!h) return;
  h.complete(); assert.ok(h.resolve().ok);
  const reviewerId = h.record.binding.reviewerSessionId;
  const budgetBefore = JSON.stringify(h.db.raw().prepare("SELECT * FROM campaign_budget_members WHERE session_id=?").get(reviewerId));
  assert.ok(h.db.raw().prepare("SELECT record FROM media_session_purposes WHERE session_id=?").get(reviewerId));
  assert.ok(h.db.raw().prepare("SELECT verdict FROM temporal_video_verdicts WHERE review_id=?").get(h.record.reviewId));
  h.db.deleteSession("child");
  const purposeRow = h.db.raw().prepare("SELECT record FROM media_session_purposes WHERE session_id=?").get(reviewerId);
  const preparedRow = h.db.raw().prepare("SELECT payload FROM prepared_media_sessions").get();
  const p = purposeRow ? JSON.parse(String(purposeRow.record)) : null;
  const preparedPayload = preparedRow ? JSON.parse(String(preparedRow.payload)) : null;
  t.diagnostic(JSON.stringify({ sourceDeleted: h.db.getSession("child") === null,
    actualReviewerRetained: h.db.getSession(reviewerId) !== null,
    reviewRetained: h.store.getReview(h.record.reviewId) !== null,
    receiptCount: h.store.latestReceipts(h.record.reviewId).length,
    privateVerdictRetained: h.store.getVerdict(h.record.reviewId) !== null,
    purposeCommandRetained: !!p?.command, preparedCommandRetained: !!preparedPayload?.command,
    purposePromptPresent: typeof p?.command?.initialPrompt === "string",
    launchEnvironmentFieldCount: Object.keys(p?.command?.spec?.env ?? {}).length,
    budgetMemberUnchanged: budgetBefore === JSON.stringify(h.db.raw().prepare("SELECT * FROM campaign_budget_members WHERE session_id=?").get(reviewerId)) }));
  assert.equal(h.db.workflowArtifactExportPreflight("source"), null);
  assert.equal(h.store.getReview(h.record.reviewId) === null, true, "deleted private source cannot leave rationale/frame/criteria records");
  assert.deepEqual(h.db.raw().prepare("SELECT record FROM media_session_purposes WHERE session_id=?").get(reviewerId), purposeRow);
  assert.equal(budgetBefore, JSON.stringify(h.db.raw().prepare("SELECT * FROM campaign_budget_members WHERE session_id=?").get(reviewerId)));
  assert.equal(h.store.latestReceipts(h.record.reviewId).length, 0);
  assert.equal(h.store.getVerdict(h.record.reviewId), null);
  assert.deepEqual(h.db.raw().prepare("SELECT payload FROM prepared_media_sessions").get(), preparedRow);
});
test("CR2 Reproduction F2 actual resolve SAVEPOINT cannot undo irreversible frame revocation", async (t) => {
  const h = await gateHarness(t); if (!h) return; h.complete();
  const read = h.store.readFrame.bind(h.store);
  h.store.readFrame = () => null;
  assert.equal(h.resolve().ok, false);
  const status = h.store.getReview(h.record.reviewId)?.status;
  h.store.readFrame = read;
  const revived = h.resolve();
  t.diagnostic(JSON.stringify({ savedStatusAfterFailedResolve: status, restoredFrameApproval: revived.ok }));
  assert.equal(status, "revoked", "actual resolve rollback must preserve negative frame proof");
  assert.equal(revived.ok, false, "restored bytes cannot revive observed irreversible revocation");
});
test("CR2 Reproduction F2 consume refusal and restored frames must preserve runtime revocation too", async (t) => {
  const h = await gateHarness(t); if (!h) return; h.complete(); assert.ok(h.resolve().ok);
  const read = h.store.readFrame.bind(h.store); h.store.readFrame = () => null;
  const result = await h.service.consumeWorkflowDecision("child", h.original.occurrenceId, { resourceSnapshot: h.original.resourceSnapshot });
  assert.equal(result.ok, false);
  assert.equal(h.db.workflowDecisionByOccurrence(h.original.occurrenceId)?.status, "revoked");
  const runtimeStatus = h.store.getReview(h.record.reviewId)?.status;
  h.store.readFrame = read;
  assert.equal((await h.service.consumeWorkflowDecision("child", h.original.occurrenceId, { resourceSnapshot: h.original.resourceSnapshot })).ok, false);
  t.diagnostic(JSON.stringify({ originalGateIrreversiblyRevoked: true, runtimeStatusAfterConsumeRefusal: runtimeStatus }));
  assert.equal(runtimeStatus, "revoked", "consume SAVEPOINT must retain observed irreversible runtime revocation");
});
test("CR2 Reproduction F4 real Fastify gate denies unauthorized media and missing IDs identically", async (t) => {
  const h = harness(); t.after(() => h.db.close());
  const actual = h.prepared.prepare(h.identity);
  const outsider = { ...h.human, userId: "synthetic-other-member", actorId: "synthetic-member", role: "operator" as const };
  assert.equal(h.db.canAccessSession(outsider, actual.sessionId), false);
  const index = readFileSync(new URL("./index.ts", import.meta.url), "utf8");
  const ast = ts.createSourceFile("index.ts", index, ts.ScriptTarget.Latest, true);
  const fn = ast.statements.find((s) => ts.isFunctionDeclaration(s) && s.name?.text === "authorizeApiRequest");
  assert.ok(fn, "extract the actual frozen handler without importing hosting bootstrap");
  const js = ts.transpileModule(fn.getText(ast), { compilerOptions: { target: ts.ScriptTarget.ES2022 } }).outputText;
  const authorize = runInNewContext(js + "\nauthorizeApiRequest;", { db: h.db, svc: h.service,
    requestPrincipals: new WeakMap(), mutationAuthorizationError, mediaSessionMutationAllowed,
    MEDIA_SESSION_PURPOSE_ERROR, PERSONAL_ORGANIZATION_ID, agentCredentialSessionTargetError, agentDelegationAuthorizationError });
  const app = Fastify(); t.after(() => app.close());
  registerAuthGate(app, { authenticate: () => ({ id: "synthetic-device", name: "Code Fixture", principal: outsider }),
    isAllowedOrigin: () => true, authorize });
  app.post("/api/sessions/:id/restart", async () => ({ invoked: true }));
  await app.ready();
  const missing = await app.inject({ method: "POST", url: "/api/sessions/not-a-session/restart" });
  const media = await app.inject({ method: "POST", url: "/api/sessions/" + actual.sessionId + "/restart" });
  assert.equal(missing.statusCode, 404);
  assert.equal(media.statusCode, missing.statusCode, "actual purpose guard must run AFTER member access denial");
  assert.deepEqual(media.json(), missing.json());
  const authorized = Fastify(); t.after(() => authorized.close());
  registerAuthGate(authorized, { authenticate: () => ({ id: "synthetic-owner-device", name: "Code Fixture", principal: h.human }),
    isAllowedOrigin: () => true, authorize });
  authorized.post("/api/sessions/:id/restart", async () => ({ invoked: true }));
  await authorized.ready();
  const denied = await authorized.inject({ method: "POST", url: "/api/sessions/" + actual.sessionId + "/restart" });
  assert.equal(denied.statusCode, 403);
  assert.equal(denied.json().error, MEDIA_SESSION_PURPOSE_ERROR);
});

test("observed source, binding and expiry negatives survive real resolve and consume rollback and restoration", async (t) => {
  for (const phase of ["resolve", "consume"] as const) for (const change of ["source", "binding", "expiry"] as const) {
    const h = await gateHarness(t); if (!h) return; h.complete();
    if (phase === "consume") assert.ok(h.resolve().ok);
    const source = h.runtimeAccess.readSource, current = h.runtimeAccess.currentBinding;
    const savedRecord = h.db.raw().prepare("SELECT record FROM temporal_video_reviews WHERE review_id=?").get(h.record.reviewId)!.record;
    if (change === "source") h.runtimeAccess.readSource = () => null;
    if (change === "binding") h.runtimeAccess.currentBinding = () => null;
    if (change === "expiry") h.db.raw().prepare("UPDATE temporal_video_reviews SET record=? WHERE review_id=?")
      .run(JSON.stringify({ ...JSON.parse(String(savedRecord)), expiresAt: 1 }), h.record.reviewId);
    const invoke = () => phase === "resolve" ? h.resolve() : h.service.consumeWorkflowDecision("child", h.original.occurrenceId,
      { resourceSnapshot: h.original.resourceSnapshot });
    assert.equal((await invoke()).ok, false, phase + "/" + change);
    assert.equal(h.store.getReview(h.record.reviewId)?.status, "revoked", phase + "/" + change);
    h.runtimeAccess.readSource = source; h.runtimeAccess.currentBinding = current;
    h.db.raw().prepare("UPDATE temporal_video_reviews SET record=? WHERE review_id=?").run(savedRecord!, h.record.reviewId);
    assert.equal((await invoke()).ok, false, "restoration cannot revive " + phase + "/" + change);
    assert.equal(h.store.getReview(h.record.reviewId)?.status, "revoked");
  }
});

test("media gates refuse enclosing transactions before proof, and late mutation failure preserves pending quality", async (t) => {
  const h = await gateHarness(t); if (!h) return; h.complete();
  h.db.raw().exec("BEGIN");
  assert.equal(h.resolve().ok, false);
  h.db.raw().exec("ROLLBACK");
  assert.equal(h.store.getReview(h.record.reviewId)?.status, "pending");
  assert.ok(h.resolve().ok);
  const approved = h.db.workflowDecisionByOccurrence(h.original.occurrenceId)!;
  h.db.raw().exec("BEGIN");
  assert.throws(() => h.approvals.consume(approved, () => { throw new Error("must not invoke mutation"); }), /own transaction boundary/);
  h.db.raw().exec("ROLLBACK");
  assert.throws(() => h.approvals.consume(approved, () => null), /before consumption/);
  assert.equal(h.store.getReview(h.record.reviewId)?.status, "pending", "failed approval mutation is not observed negative evidence");
  assert.equal(h.db.workflowDecisionByOccurrence(h.original.occurrenceId)?.status, "approved");
});

test("root or reviewer deletion cascades private quality records but retained source artifacts remain a live prerequisite", async (t) => {
  for (const target of ["root", "reviewer"] as const) {
    const h = await gateHarness(t); if (!h) return; h.complete();
    const frameId = h.record.reviewId + ":frame:0";
    assert.ok(h.db.workflowArtifactExportPreflight(frameId));
    h.db.deleteSession(target === "reviewer" ? h.record.binding.reviewerSessionId : target);
    assert.equal(h.store.getReview(h.record.reviewId), null);
    assert.equal(h.store.latestReceipts(h.record.reviewId).length, 0);
    assert.equal(h.store.getVerdict(h.record.reviewId), null);
    assert.ok(h.db.workflowArtifactExportPreflight(frameId), "source-owned frame bytes use existing retention; no full privacy cleanup claim");
  }
});

test("exact prior quality schema migrates atomically, preserves live provenance and removes only orphan quality metadata", async (t) => {
  for (const orphan of [false, true]) {
    const h = await gateHarness(t); if (!h) return; h.complete();
    const sql = h.db.raw();
    const review = sql.prepare("SELECT review_id,binding_sha256,record,status FROM temporal_video_reviews").get()!;
    // Legacy rows predate window binding: one receipt per frame (the overlap frame's last delivery).
    const byFrame = new Map<number, Record<string, unknown>>();
    for (const r of sql.prepare("SELECT review_id,frame_index,receipt_id,receipt,acknowledged FROM temporal_video_receipts " +
      "ORDER BY window_index,frame_index").all()) byFrame.set(Number(r.frame_index), { ...r });
    const receipts = [...byFrame.values()].sort((a, b) => Number(a.frame_index) - Number(b.frame_index)) as Array<Record<string, string | number>>;
    const verdict = sql.prepare("SELECT * FROM temporal_video_verdicts").get()!;
    const intents = sql.prepare("SELECT * FROM prepared_media_sessions").all();
    sql.exec("BEGIN; DROP TABLE temporal_video_verdicts; DROP TABLE temporal_video_receipts; DROP TABLE temporal_video_reviews;" +
      "CREATE TABLE temporal_video_reviews(review_id TEXT PRIMARY KEY,binding_sha256 TEXT NOT NULL,record TEXT NOT NULL,status TEXT NOT NULL);" +
      "CREATE TABLE temporal_video_receipts(review_id TEXT NOT NULL REFERENCES temporal_video_reviews(review_id),frame_index INTEGER NOT NULL,receipt_id TEXT NOT NULL UNIQUE,receipt TEXT NOT NULL,acknowledged INTEGER NOT NULL DEFAULT 0,PRIMARY KEY(review_id,frame_index));" +
      "CREATE TABLE temporal_video_verdicts(review_id TEXT PRIMARY KEY REFERENCES temporal_video_reviews(review_id),verdict TEXT NOT NULL,sha256 TEXT NOT NULL);");
    sql.prepare("INSERT INTO temporal_video_reviews VALUES (?,?,?,?)").run(review.review_id!, review.binding_sha256!, review.record!, review.status!);
    for (const r of receipts) sql.prepare("INSERT INTO temporal_video_receipts VALUES (?,?,?,?,?)")
      .run(r.review_id!, r.frame_index!, r.receipt_id!, r.receipt!, r.acknowledged!);
    sql.prepare("INSERT INTO temporal_video_verdicts VALUES (?,?,?)").run(verdict.review_id!, verdict.verdict!, verdict.sha256!);
    sql.exec("COMMIT");
    if (orphan) h.db.deleteSession("child");
    else {
      sql.prepare("UPDATE temporal_video_reviews SET binding_sha256=?").run("corrupt-fixture-binding");
      assert.throws(() => createControlPlaneVideoReviewStore(h.db), /invalid binding provenance/);
      assert.equal(sql.isTransaction, false);
      assert.equal(sql.prepare("SELECT COUNT(*) AS n FROM temporal_video_receipts").get()!.n, receipts.length);
      assert.equal(sql.prepare("SELECT name FROM sqlite_master WHERE name='temporal_video_reviews_next'").get(), undefined);
      sql.prepare("UPDATE temporal_video_reviews SET binding_sha256=?").run(review.binding_sha256!);
    }
    const migrated = createControlPlaneVideoReviewStore(h.db);
    assert.deepEqual(sql.prepare("SELECT * FROM prepared_media_sessions").all(), intents, "unknown intent history is unchanged");
    if (orphan) {
      assert.equal(migrated.getReview(h.record.reviewId), null);
      assert.equal(migrated.latestReceipts(h.record.reviewId).length, 0);
      assert.equal(migrated.getVerdict(h.record.reviewId), null);
    } else {
      assert.deepEqual({ ...sql.prepare("SELECT review_id,binding_sha256,record,status FROM temporal_video_reviews").get() },
        { ...review, status: "revoked" }, "a pending review cannot prove which window saw each frame");
      assert.deepEqual(sql.prepare("SELECT review_id,frame_index,receipt_id,receipt,acknowledged FROM temporal_video_receipts ORDER BY frame_index")
        .all().map((r) => ({ ...r })), receipts.map((r) => ({ ...r })));
      assert.equal(sql.prepare("SELECT COUNT(*) AS n FROM temporal_video_receipts WHERE window_index<>0").get()!.n, 0, "kept as window 0");
      assert.deepEqual(sql.prepare("SELECT * FROM temporal_video_verdicts").get(), verdict);
      h.db.deleteSession(h.record.binding.reviewerSessionId);
      assert.equal(migrated.getReview(h.record.reviewId), null);
      assert.equal(migrated.latestReceipts(h.record.reviewId).length, 0);
      assert.equal(migrated.getVerdict(h.record.reviewId), null);
    }
  }
});

// Synthetic in-memory CODE fixtures; no actual provider, grant, budget, host or media action.
for (const entry of ["reconnect", "enforcement"] as const) for (const unknown of [false, true]) {
  test("CR3 Reproduction guardrail " + entry + " preserves exact media " + (unknown ? "unknown fence" : "never-enqueued release"), async (t) => {
    const h = releaseHarness(t);
    if (unknown) {
      h.ports.authorize = async () => true; h.ports.send = async () => "unknown";
      await h.prepared.bind(h.identity, h.binding); await h.prepared.dispatch(h.identity);
    }
    h.messages.length = 0;
    h.db.campaignBudgets.stop("root", "accounting_unavailable", "Synthetic allowance refusal");
    if (entry === "reconnect") h.service.recoverCampaignBudgetAllocations("r");
    else (h.service as unknown as { enforceCampaignBudget(id: string, now: number): boolean }).enforceCampaignBudget("root", Date.now());
    const status = h.db.getSession(h.actual.sessionId)!.status;
    const state = h.prepared.get(h.identity)!.state;
    const messages = h.messages.filter((m) => (m as { sessionId?: string }).sessionId === h.actual.sessionId);
    t.diagnostic(JSON.stringify({ entry, unknown, status, state, active: h.db.campaignBudgets.active(h.actual.sessionId), targetMessages: messages }));
    assert.equal(h.db.campaignBudgets.completedAttestation(h.actual.sessionId), null);
    if (unknown) {
      assert.equal(status, "queued");
      const r = h.prepared.get(h.identity)!;
      const runnerDb = new DatabaseSync(":memory:"); t.after(() => runnerDb.close());
      const receipt = new RunnerMediaDispatchFences(runnerDb).cancelBeforeLaunch(h.fenceIdentity(r))!;
      assert.ok(h.service.onMediaReviewNeverDispatched("r", receipt));
      h.ports.reconcile = async () => ({ ...h.fenceIdentity(r), outcome: "never_dispatched" });
      assert.equal((await h.prepared.reconcile(h.identity)).state, "cancelled");
    } else assert.equal(state, "cancelled");
    assert.equal(h.db.campaignBudgets.active(h.actual.sessionId), false);
    assert.deepEqual(messages, [], "no generic media Stop RPC or new dispatch");
  });
}
for (const entry of ["reconcile_absent", "hydrate_absent", "hydrate_terminal", "live_terminal", "reported_terminal", "disconnect", "delete"] as const) {
  test("CR3 Reproduction generic " + entry + " cannot destroy uncertain media cancellation identity", async (t) => {
    const h = releaseHarness(t); h.ports.authorize = async () => true; h.ports.send = async () => "unknown";
    await h.prepared.bind(h.identity, h.binding); await h.prepared.dispatch(h.identity);
    h.messages.length = 0;
    if (entry === "reconcile_absent") h.service.reconcileRunnerSessions("r", []);
    if (entry === "hydrate_absent") await h.service.hydrateRunnerSessionsCooperatively("r", [], { isCurrent: () => true });
    if (entry === "reported_terminal") h.service.onSessionStatus(h.actual.sessionId, "stopped", undefined, undefined, "r");
    if (entry === "disconnect") h.service.failRunnerSessions("r");
    if (entry === "live_terminal" || entry === "hydrate_terminal") {
      const snapshot: import("@wollipog/protocol").SessionSnapshot = { id: h.actual.sessionId, workspaceId: "w", agentId: "claude", status: "stopped" as const,
        title: "Synthetic Generic Snapshot", config: {}, costUsd: 0, tokensIn: 0, tokensOut: 0,
        useWorktree: false, worktreePath: null, preview: null, pendingApproval: null,
        seq: 0, createdAt: 1, updatedAt: 2, driver: "claude-code" as const };
      if (entry === "live_terminal") h.service.applySessionRuntimeUpdate("r", snapshot);
      else await h.service.hydrateRunnerSessionsCooperatively("r", [snapshot], { isCurrent: () => true });
    }
    if (entry === "delete") {
      const result = h.service.delete(h.actual.sessionId);
      t.diagnostic(JSON.stringify({ deleted: result.ok, memberRetained: h.db.campaignBudgets.active(h.actual.sessionId),
        commandRetained: h.prepared.get(h.identity)?.state, purposeRetained: h.service.mediaSessionPurposes.owns(h.actual.sessionId) }));
      assert.equal(result.ok, false, "unknown media cannot acquire generic delete/kill authority");
    }
    assert.equal(h.db.getSession(h.actual.sessionId)?.status, "queued", "generic absence/status is not same-command permanent fence");
    assert.equal(h.prepared.get(h.identity)?.state, "uncertain");
    assert.equal(h.db.campaignBudgets.active(h.actual.sessionId), true);
    assert.deepEqual(h.messages.filter((m) => (m as { sessionId?: string }).sessionId === h.actual.sessionId), []);
  });
}

function lifecycleSnapshot(sessionId: string, costUsd = 0): import("@wollipog/protocol").SessionSnapshot {
  return { id: sessionId, workspaceId: "w", agentId: "claude", status: "stopped",
    title: "Synthetic Lifecycle Snapshot", driver: "claude-code", config: {}, costUsd,
    tokensIn: 10, tokensOut: 2, useWorktree: false, worktreePath: null, preview: null,
    pendingApproval: null, seq: 0, historyEpoch: 0, createdAt: 1, updatedAt: 2 };
}
test("quarantined snapshots retain possible charges and same-generation checkpoints without releasing capacity", async (t) => {
  for (const entry of ["live", "inventory", "status"] as const) {
    const h = releaseHarness(t); h.ports.authorize = async () => true; h.ports.send = async () => "unknown";
    await h.prepared.bind(h.identity, h.binding); await h.prepared.dispatch(h.identity);
    const checkpoint = { generation: h.actual.admission.dispatch.generation, historyEpoch: 0, throughSeq: 0, costUsd: 0.5 };
    const snapshot = { ...lifecycleSnapshot(h.actual.sessionId, 0.5), campaignBudgetCheckpoint: checkpoint };
    if (entry === "live") h.service.applySessionRuntimeUpdate("r", snapshot);
    if (entry === "inventory") await h.service.hydrateRunnerSessionsCooperatively("r", [snapshot], { isCurrent: () => true });
    if (entry === "status") h.service.onSessionStatus(h.actual.sessionId, "stopped", undefined, undefined, "r", undefined, undefined, checkpoint);
    assert.equal(h.db.getSession(h.actual.sessionId)?.status, "queued");
    assert.equal(h.db.campaignBudgets.active(h.actual.sessionId), true);
    const budget = h.db.campaignBudgets.view("root")!;
    if (entry !== "status") assert.ok(budget.actual.costUsd >= 0.5, entry + " preserves observed monotonic cost");
    // A checkpoint without hydrated priced history is not final usage or zero charge. Preserve
    // its exact amount and the full outstanding reservation, rather than manufacturing settlement.
    assert.ok(budget.actual.costUsd + budget.outstanding.costUsd >= checkpoint.costUsd);
    assert.equal(h.db.campaignBudgets.completedAttestation(h.actual.sessionId), null);
    assert.equal(h.db.raw().prepare("SELECT COUNT(*) AS n FROM campaign_budget_checkpoints WHERE session_id=?").get(h.actual.sessionId)!.n, 1);
    assert.deepEqual(JSON.parse(String(h.db.raw().prepare("SELECT checkpoint FROM campaign_budget_checkpoints WHERE session_id=?")
      .get(h.actual.sessionId)!.checkpoint)), checkpoint);
    assert.equal(h.db.raw().prepare("SELECT COUNT(*) AS n FROM campaign_budget_settlements WHERE session_id=?").get(h.actual.sessionId)!.n, 0);
    assert.throws(() => h.prepared.cancelPrepared(h.identity), /possibly dispatched/);
  }
});
test("missing, corrupt or replaced lifecycle proof cannot admit generic status, delete or guardrail stop", async (t) => {
  for (const mode of ["missing", "corrupt-purpose", "corrupt-prepared", "replacement", "history"] as const) {
    const h = releaseHarness(t); h.messages.length = 0;
    if (mode === "missing") h.db.raw().exec("DROP TABLE prepared_media_sessions");
    if (mode === "corrupt-purpose") h.db.raw().prepare("UPDATE media_session_purposes SET sha256='bad'").run();
    if (mode === "corrupt-prepared") h.db.raw().prepare("UPDATE prepared_media_sessions SET payload_sha256='bad'").run();
    if (mode === "replacement") h.db.campaignBudgets.replaceDispatch(h.actual.sessionId);
    if (mode === "history") h.db.campaignBudgets.recordCheckpoint(h.actual.sessionId,
      { generation: h.actual.admission.dispatch.generation, historyEpoch: 0, throughSeq: 0, costUsd: 0 });
    h.service.onSessionStatus(h.actual.sessionId, "stopped", undefined, undefined, "r");
    h.service.reconcileRunnerSessions("r", []);
    assert.equal(h.service.delete(h.actual.sessionId).ok, false);
    h.db.campaignBudgets.stop("root", "accounting_unavailable", "Synthetic unavailable accounting");
    h.service.recoverCampaignBudgetAllocations("r");
    assert.equal(h.db.getSession(h.actual.sessionId)?.status, "queued", mode);
    assert.equal(h.db.campaignBudgets.active(h.actual.sessionId), true, mode);
    assert.deepEqual(h.messages.filter((m) => (m as { sessionId?: string }).sessionId === h.actual.sessionId), []);
  }
});
test("verified current active command permits authenticated status, but generic Stop and Delete do not invent terminal cleanup proof", async (t) => {
  const h = releaseHarness(t); h.ports.authorize = async () => true; h.ports.send = async () => "accepted";
  await h.prepared.bind(h.identity, h.binding); await h.prepared.dispatch(h.identity);
  assert.equal(h.service.mediaSessionPurposes.lifecycleState(h.actual.sessionId), "active");
  h.messages.length = 0;
  h.db.campaignBudgets.stop("root", "accounting_unavailable", "Synthetic stopped allowance");
  h.service.recoverCampaignBudgetAllocations("r");
  assert.equal(h.db.getSession(h.actual.sessionId)?.status, "queued");
  assert.deepEqual(h.messages.filter((m) => (m as { sessionId?: string }).sessionId === h.actual.sessionId), []);
  h.service.onSessionStatus(h.actual.sessionId, "running", undefined, undefined, "r");
  assert.equal(h.db.getSession(h.actual.sessionId)?.status, "running", "only synthetic trusted active same-generation command unquarantines lifecycle");
  assert.equal(h.service.delete(h.actual.sessionId).ok, false, "active is not terminal privacy/kill proof");
  h.db.campaignBudgets.replaceDispatch(h.actual.sessionId);
  assert.equal(h.service.mediaSessionPurposes.lifecycleState(h.actual.sessionId), null);
  h.service.onSessionStatus(h.actual.sessionId, "stopped", undefined, undefined, "r");
  assert.equal(h.db.getSession(h.actual.sessionId)?.status, "running", "replaced generation stays quarantined without resurrecting status");
});

async function activeStopHarness(t: { after(fn: () => void): void }, unknownDispatch = false) {
  const h = releaseHarness(t); h.ports.send = async () => unknownDispatch ? "unknown" : "accepted";
  await h.prepared.bind(h.identity, h.binding); const record = await h.prepared.dispatch(h.identity);
  const identity: MediaActiveStopIdentity = { ...h.fenceIdentity(record), childSessionId: record.childSessionId };
  const canonical = mediaActiveStopIdentityBody(identity);
  const runnerDb = new DatabaseSync(":memory:"); t.after(() => runnerDb.close());
  const fences = new RunnerMediaDispatchFences(runnerDb);
  const { childSessionId: _child, ...dispatch } = canonical;
  assert.ok(fences.claim(dispatch));
  let registered = true, allowed = true, stops = 0, sends = 0, ambiguous = false;
  let handle: OwnedMediaStopHandle = { identity: canonical, requestStop() { stops++; if (ambiguous) throw new Error("Synthetic ambiguous owned signal"); } };
  const matches = (i: MediaActiveStopIdentity) => JSON.stringify(mediaActiveStopIdentityBody(i)) === JSON.stringify(canonical);
  const runnerPorts = { current: (i: MediaActiveStopIdentity) => registered && matches(i) ? handle : null, currentAuthority: () => allowed };
  const worker = new RunnerMediaActiveStops(runnerDb, runnerPorts);
  let ack: MediaActiveStopAcknowledgement | null = null, sent: MediaActiveStopRequest | null = null;
  const stopPorts = { current: (i: MediaActiveStopIdentity) => registered && allowed && matches(i) && fences.claimed(dispatch),
    send: (request: MediaActiveStopRequest) => { sends++; sent = request; h.hub.sendToRunner("r", { type: "media_review_stop", request }); ack = worker.request(request); } };
  const coordinator = new PreparedMediaActiveStops(h.db.raw(), stopPorts);
  h.hub.runnerProtocolVersion = () => PACED_VIDEO_REVIEW_MIN_PROTOCOL;
  const service = new SessionsService(h.db, h.hub, h.log, undefined, undefined, undefined, undefined, undefined, undefined,
    false, undefined, h.runtime, undefined, h.disclosures, h.permits, coordinator);
  h.messages.length = 0;
  return { ...h, service, coordinator, worker, runnerDb, stopPorts, runnerPorts, identity: canonical, stops: () => stops, sends: () => sends,
    ack: () => ack, sent: () => sent, register: (value: boolean) => { registered = value; }, allow: (value: boolean) => { allowed = value; },
    unknown: () => { ambiguous = true; }, replaceHandle: () => { handle = { ...handle, identity: { ...canonical, generation: "replacement" } }; } };
}

test("accepted queued media Stop uses only an exact owned handle and never settles lifecycle or capacity from its ACK", async (t) => {
  const h = await activeStopHarness(t);
  const before = h.prepared.get({ rootSessionId: "root", childSessionId: "child", admissionId: "synthetic-media", requestSha256: sha("exact source and criteria") })!;
  const result = h.service.stop(h.actual.sessionId);
  assert.equal(result.ok, true); assert.equal(result.status, 202);
  assert.equal(h.stops(), 1); assert.equal(h.sends(), 1);
  const ack = h.ack()!; assert.equal(ack.outcome, "stop_requested");
  assert.equal(h.service.onMediaReviewStopAcknowledged("wrong-runner", ack), false);
  assert.equal(h.service.onMediaReviewStopAcknowledged("r", { ...ack, generation: "replacement" }), false);
  assert.equal(h.service.onMediaReviewStopAcknowledged("r", ack), true);
  assert.equal(h.service.onMediaReviewStopAcknowledged("r", ack), true);
  assert.equal(h.service.onMediaReviewStopAcknowledged("r", { ...ack, operationId: "late-other-operation" }), false);
  assert.equal(h.service.stop(h.actual.sessionId).status, 202);
  assert.equal(h.stops(), 1); assert.equal(h.sends(), 1);
  assert.deepEqual(new PreparedMediaActiveStops(h.db.raw(), h.stopPorts).request(h.actual.sessionId), h.sent());
  assert.deepEqual(new RunnerMediaActiveStops(h.runnerDb, h.runnerPorts).request(h.sent()!), ack);
  assert.equal(h.stops(), 1); assert.equal(h.sends(), 1);
  h.service.onSessionEvent(h.actual.sessionId, { kind: "token_usage", model: "claude-opus-5-5", inputTokens: 200_000 }, 1, Date.now(), "r");
  h.service.onSessionStatus(h.actual.sessionId, "stopped", undefined, undefined, "r");
  assert.equal(h.db.getSession(h.actual.sessionId)?.status, "queued", "generic terminal status is not exact fenced final usage");
  assert.equal(h.db.sessionCostUsd(h.actual.sessionId), 0.2);
  assert.equal(h.db.campaignBudgets.active(h.actual.sessionId), true);
  assert.equal(h.db.campaignBudgets.completedAttestation(h.actual.sessionId), null);
  assert.equal(h.db.hasSessionStopIntent(h.actual.sessionId), false, "no generic Stop intent");
  assert.deepEqual(h.prepared.get(before), before);
  assert.deepEqual(h.messages.map((m) => (m as { type: string }).type), ["media_review_stop", "priced_session_cost"]);
});

test("changed selected contract refuses Stop before signaling and retains its reservation and command", async (t) => {
  const h = await activeStopHarness(t);
  const before = h.prepared.get(h.actual)!;
  const budget = h.db.campaignBudgets.view("root");
  delete h.metadata.agents[0]!.capabilities!.pacedVideoReviewContract;
  h.db.registerRunner(h.metadata, 3, PACED_VIDEO_REVIEW_MIN_PROTOCOL);
  h.messages.length = 0;
  const result = h.service.stop(h.actual.sessionId);
  assert.equal(result.ok, false); assert.equal(result.status, 409);
  assert.equal(h.stops(), 0); assert.equal(h.sends(), 0);
  assert.deepEqual(h.messages, []);
  assert.deepEqual(h.prepared.get(before), before);
  assert.deepEqual(h.db.campaignBudgets.view("root"), budget);
  assert.equal(h.db.campaignBudgets.active(h.actual.sessionId), true);
});

test("removed private metadata cannot authenticate an old Stop ACK or a never-dispatched refund", async (t) => {
  const h = await activeStopHarness(t);
  assert.equal(h.service.stop(h.actual.sessionId).status, 202);
  const ack = h.ack()!;
  const before = h.prepared.get(h.actual)!;
  const budget = h.db.campaignBudgets.view("root");
  delete h.metadata.agents[0]!.capabilities!.pacedVideoReviewContract;
  h.db.registerRunner(h.metadata, 3, PACED_VIDEO_REVIEW_MIN_PROTOCOL);
  assert.equal(h.service.onMediaReviewStopAcknowledged("r", ack), false);
  assert.deepEqual(h.prepared.get(before), before);
  const fence = h.fenceIdentity(before);
  assert.equal(h.service.onMediaReviewNeverDispatched("r", { ...fence, outcome: "never_dispatched", fenceSha256: sha("synthetic non-proof") }), false);
  assert.deepEqual(h.db.campaignBudgets.view("root"), budget);
  assert.equal(h.db.campaignBudgets.active(h.actual.sessionId), true);
  assert.equal(h.stops(), 1); assert.equal(h.sends(), 1);
});
test("unknown owned Stop signal is retained across both coordinators' restart without a second effect", async (t) => {
  const h = await activeStopHarness(t); h.unknown();
  assert.equal(h.service.stop(h.actual.sessionId).status, 202);
  assert.equal(h.ack()?.outcome, "unknown"); assert.equal(h.stops(), 1);
  assert.deepEqual(new PreparedMediaActiveStops(h.db.raw(), h.stopPorts).request(h.actual.sessionId), h.sent());
  assert.equal(new RunnerMediaActiveStops(h.runnerDb, h.runnerPorts).request(h.sent()!)?.outcome, "unknown");
  assert.equal(h.stops(), 1); assert.equal(h.sends(), 1);
  assert.equal(h.db.campaignBudgets.active(h.actual.sessionId), true);
  assert.equal(h.db.getSession(h.actual.sessionId)?.status, "queued");
});
test("missing dedicated Stop history retains the original command fence and quarantines terminal frames", async (t) => {
  const h = await activeStopHarness(t);
  assert.equal(h.service.stop(h.actual.sessionId).status, 202);
  assert.equal(h.stops(), 1); assert.equal(h.sends(), 1);
  h.db.raw().exec("DELETE FROM prepared_media_active_stops");
  const restarted = new PreparedMediaActiveStops(h.db.raw(), h.stopPorts);
  assert.equal(restarted.request(h.actual.sessionId), null);
  assert.equal(h.service.stop(h.actual.sessionId).status, 409);
  h.service.onSessionStatus(h.actual.sessionId, "stopped", undefined, undefined, "r");
  assert.equal(h.db.getSession(h.actual.sessionId)?.status, "queued");
  assert.equal(h.db.campaignBudgets.active(h.actual.sessionId), true);
  assert.equal(h.db.campaignBudgets.completedAttestation(h.actual.sessionId), null);
  assert.equal(h.stops(), 1); assert.equal(h.sends(), 1);
});
for (const mode of ["unknown-dispatch", "unregistered", "revoked", "replacement", "corrupt", "mixed-peer"] as const) {
  test("queued media Stop refuses " + mode + " and retains identity without an intent or generic kill", async (t) => {
    const h = await activeStopHarness(t, mode === "unknown-dispatch");
    if (mode === "unregistered") h.register(false);
    if (mode === "revoked") h.allow(false);
    if (mode === "replacement") h.db.campaignBudgets.replaceDispatch(h.actual.sessionId);
    if (mode === "corrupt") h.db.raw().prepare("UPDATE media_session_purposes SET sha256='corrupt'").run();
    if (mode === "mixed-peer") h.hub.runnerProtocolVersion = () => 220;
    assert.equal(h.service.stop(h.actual.sessionId).status, 409);
    assert.equal(h.stops(), 0); assert.equal(h.sends(), 0);
    assert.equal(h.coordinator.owns(h.actual.sessionId), false);
    assert.equal(h.db.getSession(h.actual.sessionId)?.status, "queued");
    assert.equal(h.db.campaignBudgets.active(h.actual.sessionId), true);
    assert.deepEqual(h.messages, []);
  });
}
test("dedicated Stop registration is required even after an authentic running status", async (t) => {
  const h = await activeStopHarness(t); h.register(false);
  h.service.onSessionStatus(h.actual.sessionId, "running", undefined, undefined, "r");
  assert.equal(h.service.stop(h.actual.sessionId).status, 409);
  h.db.campaignBudgets.stop("root", "accounting_unavailable", "Synthetic stopped allowance");
  h.service.recoverCampaignBudgetAllocations("r");
  assert.equal(h.db.getSession(h.actual.sessionId)?.status, "running");
  assert.equal(h.stops(), 0); assert.equal(h.sends(), 0);
  assert.deepEqual(h.messages.filter((m) => (m as { sessionId?: string }).sessionId === h.actual.sessionId), []);
  assert.ok(h.messages.some((m) => (m as { sessionId?: string; type?: string }).sessionId === "root" &&
    (m as { type?: string }).type === "stop_session"), "ordinary campaign budget Stop remains effective");
});

// #3365: archive acceptance (202) must mean a durable archive intent exists, in every media state.
function archiveOutcome(h: Awaited<ReturnType<typeof activeStopHarness>> | ReturnType<typeof releaseHarness>) {
  const session = h.db.getSession(h.actual.sessionId)!;
  return { status: session.status, archived: session.archived === true,
    archiveIntent: h.db.sessionStopIntent(h.actual.sessionId)?.archiveAfterStop === true,
    stopIntent: h.db.hasSessionStopIntent(h.actual.sessionId), active: h.db.campaignBudgets.active(h.actual.sessionId) };
}
for (const state of ["active-running", "active-queued", "ambiguous-running", "ambiguous-queued"] as const) {
  test("archive of " + state + " media refuses without an archive intent, generic kill or dedicated Stop", async (t) => {
    const h = await activeStopHarness(t, state.startsWith("ambiguous"));
    const record = h.prepared.get(h.actual)!;
    assert.equal(record.state, state.startsWith("ambiguous") ? "uncertain" : "active");
    // Only the trusted active command admits a running status; an ambiguous one is set directly.
    if (state === "active-running") h.service.onSessionStatus(h.actual.sessionId, "running", undefined, undefined, "r");
    if (state === "ambiguous-running") h.db.updateSessionStatus(h.actual.sessionId, "running", Date.now());
    const status = state.endsWith("running") ? "running" : "queued";
    assert.equal(h.db.getSession(h.actual.sessionId)?.status, status);
    const result = h.service.setArchived(h.actual.sessionId, true);
    assert.equal(result.ok, false); assert.equal(result.status, 409);
    // A dispatched reviewer is open whether running or still queued, so the lifecycle fence answers first.
    assert.match(result.error!, /cannot be archived yet/u);
    assert.deepEqual(archiveOutcome(h), { status, archived: false, archiveIntent: false, stopIntent: false, active: true });
    assert.equal(h.stops(), 0); assert.equal(h.sends(), 0);
    assert.deepEqual(h.messages, []);
    assert.deepEqual(h.prepared.get(record), record);
  });
}
test("a dedicated Stop acknowledgement is not archival: archive still refuses after an accepted media Stop", async (t) => {
  const h = await activeStopHarness(t);
  h.service.onSessionStatus(h.actual.sessionId, "running", undefined, undefined, "r");
  assert.equal(h.service.stop(h.actual.sessionId).status, 202);
  assert.equal(h.service.onMediaReviewStopAcknowledged("r", h.ack()!), true);
  const result = h.service.setArchived(h.actual.sessionId, true);
  assert.equal(result.ok, false); assert.equal(result.status, 409);
  assert.deepEqual(archiveOutcome(h), { status: "running", archived: false, archiveIntent: false, stopIntent: false, active: true });
  assert.equal(h.stops(), 1, "archive sends no second Stop"); assert.equal(h.sends(), 1);
  assert.equal(h.db.campaignBudgets.completedAttestation(h.actual.sessionId), null, "no final pricing is implied");
});
test("archive of locally cancelled and terminal media is accepted only with its durable archived state", async (t) => {
  // Cancelled: never-enqueued cancellation already released capacity; archive commits directly.
  const cancelled = releaseHarness(t);
  assert.ok(cancelled.service.stop(cancelled.actual.sessionId).ok);
  assert.equal(cancelled.service.mediaSessionPurposes.lifecycleState(cancelled.actual.sessionId), "cancelled");
  const archived = cancelled.service.setArchived(cancelled.actual.sessionId, true);
  assert.equal(archived.ok, true); assert.equal(archived.status, 200);
  assert.deepEqual(archiveOutcome(cancelled), { status: "stopped", archived: true, archiveIntent: false, stopIntent: false, active: false });
  // Queued and locally cancellable: the same request cancels and archives atomically.
  const queued = releaseHarness(t);
  const accepted = queued.service.setArchived(queued.actual.sessionId, true);
  assert.equal(accepted.ok, true); assert.equal(accepted.status, 202);
  assert.deepEqual(archiveOutcome(queued), { status: "stopped", archived: true, archiveIntent: false, stopIntent: false, active: false });
  // Terminal row: no Stop is needed, and the archive is recorded rather than promised.
  const terminal = await activeStopHarness(t);
  terminal.db.updateSessionStatus(terminal.actual.sessionId, "failed", Date.now());
  const done = terminal.service.setArchived(terminal.actual.sessionId, true);
  assert.equal(done.ok, true); assert.equal(done.status, 200);
  assert.equal(archiveOutcome(terminal).archived, true);
  assert.equal(terminal.stops(), 0); assert.deepEqual(terminal.messages, []);
});

test("ordinary rate-priced usage sends exactly one authoritative accounting acknowledgement", (t) => {
  const h = releaseHarness(t); h.messages.length = 0;
  h.hub.runnerProtocolVersion = () => PACED_VIDEO_REVIEW_MIN_PROTOCOL; // Synthetic negotiated connection; no actual runner.
  h.db.createSession({ id: "ordinary-control", runnerId: "r", workspaceId: "w", agentId: "claude",
    title: "Synthetic Ordinary Control", useWorktree: false, driver: "claude-code",
    config: { model: "claude-opus-5-5" }, scope: { organizationId: h.human.organizationId,
      owner: { kind: "user", userId: h.human.userId } }, now: 8 });
  h.service.onSessionEvent("ordinary-control", { kind: "token_usage", model: "claude-opus-5-5", inputTokens: 3_000_000 },
    1, Date.now(), "r");
  assert.equal(h.db.sessionCostUsd("ordinary-control"), 3);
  assert.deepEqual(h.messages.filter((m) => (m as { type?: string }).type === "priced_session_cost"),
    [{ type: "priced_session_cost", sessionId: "ordinary-control", costUsd: 3 }]);
});

for (const outcome of ["unknown", "accepted"] as const) {
  test("queued " + outcome + " media synchronizes rate-priced usage without granting lifecycle authority", async (t) => {
    const h = releaseHarness(t); h.ports.send = async () => outcome;
    h.hub.runnerProtocolVersion = () => PACED_VIDEO_REVIEW_MIN_PROTOCOL; // Synthetic negotiated connection; no actual runner.
    await h.prepared.bind(h.identity, h.binding); await h.prepared.dispatch(h.identity);
    const before = h.prepared.get(h.identity)!;
    h.messages.length = 0;
    h.service.onSessionEvent(h.actual.sessionId, { kind: "token_usage", model: "claude-opus-5-5", inputTokens: 3_000_000 },
      1, Date.now(), "r");
    assert.equal(h.db.sessionCostUsd(h.actual.sessionId), 3, "actual test rate table prices input without supplied USD");
    assert.deepEqual(h.prepared.get(h.identity), before, "command, reservation generation and dispatch state are unchanged");
    assert.equal(h.db.getSession(h.actual.sessionId)?.status, "queued");
    assert.equal(h.db.getSession(h.actual.sessionId)?.pendingApproval, null);
    assert.equal(h.db.campaignBudgets.active(h.actual.sessionId), true);
    assert.equal(h.db.campaignBudgets.completedAttestation(h.actual.sessionId), null);
    assert.ok(h.db.campaignBudgets.view("root")!.actual.costUsd >= 3);
    assert.ok(h.db.listEvents(h.actual.sessionId).some((e) => e.payload.kind === "token_usage"));
    assert.deepEqual(h.messages.filter((m) => (m as { sessionId?: string }).sessionId === h.actual.sessionId),
      [{ type: "priced_session_cost", sessionId: h.actual.sessionId, costUsd: 3 }], "only accounting ACK, no Stop or policy action");
  });
}

test("quarantined media price synchronization retains correction coordinates and refuses a missing prefix", async (t) => {
  const h = releaseHarness(t); h.ports.send = async () => "unknown";
  h.hub.runnerProtocolVersion = () => PACED_VIDEO_REVIEW_MIN_PROTOCOL;
  await h.prepared.bind(h.identity, h.binding); await h.prepared.dispatch(h.identity);
  const sessionId = h.actual.sessionId, now = Date.now();
  // Actual reconciliation code over disclosed synthetic accounting evidence. Both queries are
  // independent, so normalization preserves USD3 rather than manufacturing a refund or zero.
  const first = h.db.appendEvent(sessionId, { kind: "token_usage", model: "claude-opus-5-5", costUsd: 1 }, now,
    { accrueUsage: true, runnerSeq: 1, historyEpoch: 1 });
  const second = h.db.appendEvent(sessionId, { kind: "token_usage", model: "claude-opus-5-5", costUsd: 2 }, now + 1,
    { accrueUsage: true, runnerSeq: 2, historyEpoch: 1 });
  const evidence = { sessionId, eventEpoch: 0, historyEpoch: 1, importAuthorized: true, sourceSha256: sha("synthetic accounting source"),
    records: [
      { eventId: first.id, conversation: sha("first query"), process: sha("first process"), boundary: "origin", startUsd: 0, endUsd: 1, model: "claude-opus-5-5", scope: "query-tree" },
      { eventId: second.id, conversation: sha("second query"), process: sha("second process"), boundary: "reset", startUsd: 0, endUsd: 2, model: "claude-opus-5-5", scope: "query-tree" },
    ] };
  const preview = previewClaudeReconciliation(h.db, h.human, evidence);
  assert.equal(preview.originalUsd, 3); assert.equal(preview.proposedUsd, 3);
  applyClaudeReconciliation(h.db, h.human, evidence, preview.digest);
  h.messages.length = 0;
  h.service.onSessionEvent(sessionId, { kind: "token_usage", model: "claude-opus-5-5", inputTokens: 1_000_000 }, 3, now + 2, "r");
  assert.deepEqual(h.messages.filter((m) => (m as { sessionId?: string }).sessionId === sessionId), [correctionFrame(h.db, sessionId)]);
  assert.equal(h.db.sessionCostUsd(sessionId), 4);
  // Deliberately corrupt synthetic provenance: a bare price must never replace a missing chain.
  h.db.raw().prepare("UPDATE usage_cost_reconciliations SET revision=2 WHERE session_id=?").run(sessionId);
  h.messages.length = 0;
  h.service.onSessionEvent(sessionId, { kind: "token_usage", model: "claude-opus-5-5", inputTokens: 1_000_000 }, 4, now + 3, "r");
  assert.equal(h.db.sessionCostUsd(sessionId), 5);
  assert.deepEqual(h.messages.filter((m) => (m as { sessionId?: string }).sessionId === sessionId), []);
  assert.equal(h.db.getSession(sessionId)?.status, "queued");
  assert.equal(h.prepared.get(h.identity)?.state, "uncertain");
  assert.equal(h.db.campaignBudgets.active(sessionId), true);
  assert.equal(h.db.campaignBudgets.completedAttestation(sessionId), null);
});

test("unresolved media event ingestion retains usage/history while generic questions cannot acquire lifecycle authority", async (t) => {
  const h = releaseHarness(t); h.ports.authorize = async () => true; h.ports.send = async () => "unknown";
  await h.prepared.bind(h.identity, h.binding); await h.prepared.dispatch(h.identity);
  h.messages.length = 0;
  h.service.onSessionEvent(h.actual.sessionId, { kind: "token_usage", model: "claude-opus-5-5", costUsd: 0.2 }, 1, Date.now(), "r");
  h.service.onSessionEvent(h.actual.sessionId, { kind: "question_request", requestId: "synthetic-media-question",
    questions: [{ id: "q", header: "Synthetic", question: "Synthetic generic request", options: [{ label: "Proceed" }] }] },
    2, Date.now(), "r");
  assert.equal(h.db.getSession(h.actual.sessionId)?.status, "queued");
  assert.equal(h.db.getSession(h.actual.sessionId)?.pendingApproval, null);
  assert.ok(h.db.campaignBudgets.view("root")!.actual.costUsd >= 0.2);
  assert.ok(h.db.listEvents(h.actual.sessionId).some((e) => e.payload.kind === "token_usage"));
  assert.equal(h.db.campaignBudgets.active(h.actual.sessionId), true);
  assert.equal(h.db.campaignBudgets.completedAttestation(h.actual.sessionId), null);
  assert.deepEqual(h.messages.filter((m) => (m as { sessionId?: string }).sessionId === h.actual.sessionId),
    [{ type: "priced_session_cost", sessionId: h.actual.sessionId, costUsd: 0.2 }], "accounting synchronization grants no generic question or lifecycle action");
});
