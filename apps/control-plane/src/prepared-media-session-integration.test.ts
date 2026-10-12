import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { test } from "node:test";
import { DEFAULT_ORCHESTRATOR_DEFAULTS, HUMAN_ONLY_PARENT_CONTROL_POLICY, type RunnerMetadata } from "@wollipog/protocol";
import { ControlPlaneDb } from "./db.js";
import { Hub } from "./hub.js";
import { SessionsService } from "./sessions.js";
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
function harness() {
  const db = ControlPlaneDb.open(":memory:");
  const human: HumanPrincipal = { ...db.localIdentityContext(), kind: "human", actorId: "synthetic-human" };
  const audience = { organizationId: human.organizationId, owner: { kind: "user" as const, userId: human.userId } };
  const metadata: RunnerMetadata = { runnerId: "r", hostname: "synthetic", os: "linux", version: "test",
    workspaces: [{ id: "w", name: "Repo", path: "/synthetic-repo" }],
    agents: [{ id: "claude", name: "Synthetic Claude", command: "claude", args: [], env: {}, driver: "claude-code", available: true }] };
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
  const source = Buffer.from("synthetic storage bytes, not real video evidence");
  db.createWorkflowArtifactBytes({ artifactId: "source", sessionId: "child", kind: "video", name: "Synthetic.webm",
    mimeType: "video/webm", encoding: "base64", sha256: sha(source), sizeBytes: source.length,
    createdBy: { kind: "agent", id: "child" }, metadata: { purpose: "session_attachment" }, createdAt: 6 }, source);
  const snapshot = { category: "ui_evidence_approval" as const, evidence: [{ evidenceId: "original-video",
    artifactId: "source", sha256: sha(source), mediaType: "video/webm", description: "Synthetic storage test" }] };
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
  return { db, service, bootstrap, prepared, identity, subject, context, runtime, target, messages, ports,
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
