import assert from "node:assert/strict";
import { test } from "node:test";
import Fastify from "fastify";
import {
  CAMPAIGN_EVIDENCE_RETENTION_DISCLOSURE, CONTROLLED_REVIEW_PROFILE, DEFAULT_ORCHESTRATOR_DEFAULTS, HUMAN_ONLY_PARENT_CONTROL_POLICY, PROTOCOL_VERSION, WORKFLOW_DECISION_CATEGORIES,
  campaignWorkflowOwner,
  type CampaignLaunchInspectionResult, type CampaignLaunchPreflight, type CampaignLaunchProposal, type ControlledReviewCapability,
  type CampaignWorkItemDetail, type ControlPlaneToRunner, type CreateSessionRequest, type FullControlLaunchRequest, type GithubIssueClosureSnapshot, type RunnerMetadata, type RunnerRuntimeInfo,
} from "@wollipog/protocol";
import { ControlPlaneDb } from "./db.js";
import { Hub } from "./hub.js";
import { SessionsService } from "./sessions.js";
import { OrchestratorSettings, resolveOrchestratorCampaignPolicy } from "./orchestrator-settings.js";
import { authorizeFullControl, evaluateCampaignAuthority } from "./campaign-authority.js";
import { closureEvidence, publicationEvidence } from "./campaign-issue-authority.js";
import { hostingEvidenceAuthorityDisclosures } from "./hosting-evidence-disclosures.js";
import { composeHostingVideoEvidence } from "./hosting-video-evidence.js";
import { syntheticInspectedVideoRuns, syntheticMediaReviewerAttestation, syntheticVideoReviewerTarget } from "./video-live-validation-test-fixture.js";
import type { AuthPrincipal, HumanPrincipal } from "./identity.js";
import { inspectCampaignWorkspace, registerFullControlLaunchRoutes } from "./full-control-launch-route.js";
import { resolveSessionCreationOwnership } from "./session-creation-route.js";

const proposal: CampaignLaunchProposal = { repository: "owner/repo", issueNumbers: [12], objective: "Deliver #12",
  operations: ["implementation_question", "pr_merge"], delegatablePolicyIds: [],
  issueAuthority: { epics: [12], relatedFollowUps: false, maxIssues: 10, closureReasons: ["completed"] },
  budgetAuthority: { version: 1, costUsd: 20, toolCalls: 200, concurrency: 2, acceptedFollowUps: 0,
    accounting: "managed_workers_only", unpriced: "stop" } };
const request: CreateSessionRequest = { runnerId: "r", workspaceId: "w", projectId: null, projectLocationId: null,
  agentId: "claude", role: "orchestrator", config: { model: "claude-opus-5-5", permissionMode: "orchestrator", costBudgetUsd: 50, maxToolCalls: 500 } };
const review: ControlledReviewCapability = { profile: CONTROLLED_REVIEW_PROFILE, controllerSha256: "c".repeat(64), executableSha256: "e".repeat(64),
  cliVersion: "2.1.296", accounting: "provider_list_estimate", account: "runner_default_claude", agentId: "claude" };
const runtime: RunnerRuntimeInfo = { dataDir: "/fixture/data", worktreeRoot: "/fixture/data/worktrees", maxConcurrentSessions: 4,
  campaignLaunchInspection: { version: 2 }, campaignReview: review, executionIsolation: { mode: "provider", network: "inherit" } };
const pacedVideoContract = { id: "wollipog-paced-video-review-v1", revision: 1 } as const;
const reviewerAttestation = syntheticMediaReviewerAttestation("claude");

function fixture(options: { runtime?: RunnerRuntimeInfo; protocolVersion?: number; priced?: boolean; images?: boolean; pacedVideo?: boolean;
  hostingVideo?: boolean; videoPort?: boolean } = {}) {
  const db = ControlPlaneDb.open(":memory:");
  const identity = db.localIdentityContext();
  const human: HumanPrincipal = { ...identity, kind: "human", actorId: identity.userId };
  const meta: RunnerMetadata = { runnerId: "r", hostname: "fixture", os: "linux", version: "test",
    workspaces: [{ id: "w", name: "Fixture Repo", path: "/fixture/repository" }],
    agents: [{ id: "claude", name: "Claude", command: "claude", args: [], env: {}, driver: "claude-code", context: { kind: "native" }, available: true,
      capabilities: { models: [{ id: "claude-opus-5-5", default: true }, { id: "claude-sonnet-5-5" }], effortLevels: ["high"], slashCommands: [],
        permissionModes: ["default", "orchestrator"], supportsImages: true, supportsApprovals: true,
        ...(options.images === false ? {} : { imageToolResults: true }),
        ...(options.pacedVideo ? { pacedVideoReviewContract: pacedVideoContract, mediaReviewerAttestation: reviewerAttestation } : {}) } }],
    runtime: "runtime" in options ? options.runtime : runtime };
  const reconnect = (at: number) => db.registerRunner(meta, at, options.protocolVersion ?? PROTOCOL_VERSION);
  reconnect(Date.now());
  if (options.priced !== false) {
    const rate = { inputCostPerToken: 0.000001, outputCostPerToken: 0.000001, cacheReadCostPerToken: 0.000001, cacheCreationCostPerToken: 0.000001 };
    db.setUsageRateTable(new Map([["claude-opus-5-5", rate], ["claude-sonnet-5-5", rate]])); // Fixture pricing only.
  }
  const hub = new Hub(db);
  hub.isRunnerOnline = () => true;
  const sent: ControlPlaneToRunner[] = [];
  const starts: ControlPlaneToRunner[] = [];
  // The fixture runner answers every inspection with its exact origin; tests replace `inspect`.
  const state: { inspect: (message: Extract<ControlPlaneToRunner, { type: "campaign_launch_inspect" }>) => CampaignLaunchInspectionResult | null } = {
    inspect: (message) => ({ type: "campaign_launch_inspection_result", requestId: message.requestId, workspaceId: message.workspaceId,
      ok: true, repository: "owner/repo", issueNumbers: message.issueNumbers, digest: "d".repeat(64) }),
  };
  hub.sendToRunner = (_, message) => {
    sent.push(message);
    if (message.type === "start_session") starts.push(message);
    if (message.type === "campaign_launch_inspect") {
      const answer = state.inspect(message);
      if (answer) queueMicrotask(() => hub.resolveRunnerRequest(answer, "r"));
    }
    return true;
  };
  const disclosures = hostingEvidenceAuthorityDisclosures({
    organizationExists: (organizationId) => db.listOrganizationIds().includes(organizationId), listRunners: () => db.listRunners() });
  // `hostingVideo` wires the service exactly as hosting does, with its inert video evidence pieces.
  const video = options.hostingVideo ? composeHostingVideoEvidence(db) : undefined;
  const sessions = new SessionsService(db, hub, { info() {}, warn() {}, error() {} }, undefined, undefined, undefined, undefined,
    undefined, undefined, false, undefined, undefined, video?.workflowVideoApprovals, disclosures, undefined, video?.preparedMediaActiveStops);
  const scope = { organizationId: human.organizationId, owner: { kind: "user" as const, userId: human.userId } };
  const settings = new OrchestratorSettings(db);
  // `videoPort` also gives the launch route hosting's certification port, as index.ts does.
  const videoCertification = video && options.videoPort ? (runnerId: string) => video.launchCertification(runnerId) : undefined;
  return { db, hub, sent, starts, state, sessions, human, scope, settings, disclosures, reconnect, video, videoCertification };
}

async function app(f: ReturnType<typeof fixture>, inspectionTimeoutMs?: number) {
  const logs: string[] = [];
  const server = Fastify({ logger: { level: "info", stream: { write(line: string) { logs.push(line); } } } });
  const agent: AuthPrincipal = { kind: "agent", actorId: "fixture-agent", organizationId: f.human.organizationId, delegatedScope: f.scope };
  registerFullControlLaunchRoutes(server, { ...f, evidenceDisclosures: f.disclosures, inspectionTimeoutMs,
    requestPrincipal: (req) => req.headers.authorization === "Bearer human" ? f.human
      : req.headers.authorization === "Bearer agent" ? agent : null });
  return { server, logs };
}

const launch: FullControlLaunchRequest = { runnerId: "r", workspaceId: "w", issueNumbers: [12, 7], task: "Deliver the launch issues",
  overrides: { session: { agentId: "claude", config: { model: "claude-opus-5-5", permissionMode: "orchestrator" },
    orchestrator: { behavior: { completion: "stop_and_archive", childModel: "claude-opus-5-5", followUps: "execute_approved" } } },
  budget: { costUsd: 40, toolCalls: 400 } } };

async function preflight(server: Awaited<ReturnType<typeof app>>["server"], body: FullControlLaunchRequest, auth = "Bearer human") {
  const response = await server.inject({ method: "POST", url: "/api/full-control-campaigns/preflight", headers: { authorization: auth }, payload: body });
  return { response, preflight: response.statusCode === 200 ? response.json().preflight as CampaignLaunchPreflight : undefined };
}
const sessionCount = (f: ReturnType<typeof fixture>) => f.db.raw().prepare("SELECT count(*) AS n FROM sessions").get()!.n;

test("a ready Human launch admits one Full Control root that owns every authorized decision and controlled review", async () => {
  const f = fixture();
  const { server, logs } = await app(f);
  try {
    const before = f.db.raw().prepare("SELECT total_changes() AS n").get()!.n;
    const { response, preflight: checked } = await preflight(server, launch);
    assert.equal(response.statusCode, 200, response.body);
    assert.equal(response.headers["cache-control"], "private, no-store");
    assert.equal(f.db.raw().prepare("SELECT total_changes() AS n").get()!.n, before, "preflight performs no SQL writes");
    assert.equal(checked!.ready, true, JSON.stringify(checked!.summary.blockers));
    assert.equal(checked!.inspectionCancellation, "supported");
    for (const id of ["repository_scope", "authority_contract", "accounting_budget", "native_review", "execution_isolation", "image_evidence"]) {
      assert.equal(checked!.capabilities.find((item) => item.id === id)!.state, "verified", id);
    }
    assert.deepEqual(checked!.capabilities.filter((item) => item.state === "human_required").map((item) => item.id), ["video_evidence", "external_evidence"]);
    const summary = checked!.summary;
    assert.equal(summary.repository, "owner/repo");
    assert.deepEqual(summary.issueNumbers, [7, 12]);
    assert.equal(summary.objective, "Deliver the launch issues");
    assert.deepEqual(summary.budget, { costUsd: 40, toolCalls: 400, concurrency: 4, acceptedFollowUps: 2, source: "override", reviewIncluded: true });
    assert.deepEqual(summary.followUps, { policy: "execute_approved", relatedFollowUps: true, maxIssues: 4, closureReasons: ["completed"] });
    assert.equal(summary.root.completion, "stop_and_archive");
    assert.deepEqual(summary.root.isolation, { mode: "provider", network: "inherit" });
    assert.equal(summary.evidence.statement, "The Orchestrator reviews screenshots. Video and external evidence need your review.");
    assert.equal(summary.evidence.provider!.retentionDisclosure, CAMPAIGN_EVIDENCE_RETENTION_DISCLOSURE);
    assert.equal(summary.evidence.destination.configurationId, `session_artifacts:${f.human.organizationId}`);
    assert.equal(summary.evidence.envelope, false, "no peer declares the private media contract");
    assert.ok(summary.humanRequired.some((item) => item.exception === "Secrets and Sign-In"));
    assert.deepEqual(summary.blockers, []);
    assert.deepEqual(checked!.advanced.controlledReview, review);
    assert.deepEqual(f.starts, []);

    const admitted = await server.inject({ method: "POST", url: "/api/full-control-campaigns", headers: { authorization: "Bearer human" },
      payload: { ...launch, requestId: "launch-1", preflightDigest: checked!.digest } });
    assert.equal(admitted.statusCode, 201, admitted.body);
    const root = f.db.getSession(admitted.json().id)!;
    const control = root.orchestratorPolicy!.control!;
    assert.equal(control.mode, "full_control");
    if (control.mode !== "full_control") throw new Error("Full Control expected");
    assert.equal(control.boundary.authorizedByUserId, f.human.userId);
    assert.equal(control.boundary.repository, "owner/repo");
    assert.equal(control.boundary.evidenceAuthority, undefined);
    assert.deepEqual(control.boundary.budgetAuthority!.controlledReview, review);
    assert.deepEqual(root.orchestratorPolicy!.issueScope!.issueNumbers, [7, 12]);
    assert.equal(root.orchestratorPolicy!.behavior.completion, "stop_and_archive");
    assert.equal(root.orchestratorPolicy!.behavior.childModel, "claude-opus-5-5");
    assert.equal(root.model, "claude-opus-5-5");
    assert.equal(root.agentId, "claude");
    assert.equal(root.parentControlPolicy!.revision, control.boundary.revision);
    for (const category of [...WORKFLOW_DECISION_CATEGORIES, "issue_closure", "campaign_issue_scope"] as const) {
      assert.equal(campaignWorkflowOwner(control, root.parentControlPolicy!.decisions, category, true), "orchestrator", category);
    }
    const projection = f.db.campaignProjection(root.id)!;
    for (const category of WORKFLOW_DECISION_CATEGORIES) assert.equal(projection.decisionOwners[category], "orchestrator", category);
    assert.equal(f.db.campaignBudgets.view(root.id)!.state, "active");
    assert.deepEqual(f.db.campaignBudgets.view(root.id)!.authority.controlledReview, review);
    assert.equal(projection.budget!.requiredNativeReview!.supported, true, "the launched campaign can actually admit controlled review");
    assert.equal(f.starts.length, 1);
    const start = f.starts[0]! as Extract<ControlPlaneToRunner, { type: "start_session" }>;
    assert.deepEqual(start.spec.orchestrator!.control, control);
    assert.equal(start.initialPrompt, "Deliver the launch issues");

    const replay = await server.inject({ method: "POST", url: "/api/full-control-campaigns", headers: { authorization: "Bearer human" },
      payload: { ...launch, requestId: "launch-1", preflightDigest: checked!.digest } });
    assert.equal(replay.json().id, root.id, "the same request identity returns the committed root");
    assert.equal(f.starts.length, 1, "no provider start is replayed");
    // Revocation is the existing explicit Human campaign operation; it restores the saved owners.
    const revoked = f.sessions.setCampaignControl(root.id, { mode: "custom" }, control.boundary.revision, f.human);
    assert.equal(revoked.ok, true, revoked.error ?? "revocation succeeded");
    assert.equal(revoked.data!.parentControlPolicy!.revision, control.boundary.revision + 1);
    const custom = f.db.campaignProjection(root.id)!;
    for (const category of WORKFLOW_DECISION_CATEGORIES) {
      assert.equal(custom.decisionOwners[category], root.parentControlPolicy!.decisions[category], category);
    }
    assert.equal(campaignWorkflowOwner(revoked.data!.orchestratorPolicy!.control, root.parentControlPolicy!.decisions, "issue_closure", true), "human");
    const event = logs.map((line) => JSON.parse(line)).find((entry) => entry.event === "full_control_launch_preflight");
    assert.equal(event.ready, true);
    assert.doesNotMatch(logs.join("\n"), /Deliver the launch issues|Bearer human/);
  } finally { await server.close(); f.db.close(); }
});

test("each missing mandatory capability blocks launch with a specific reason and creates nothing", async () => {
  const cases: Array<{ name: string; options?: Parameters<typeof fixture>[0]; body?: FullControlLaunchRequest; id: string; reason: RegExp }> = [
    { name: "no controlled reviewer", options: { runtime: { ...runtime, campaignReview: undefined } }, id: "native_review", reason: /executionIsolation\.mode "provider".*2\.1\.296/ },
    { name: "no isolation report", options: { runtime: { ...runtime, executionIsolation: undefined } }, id: "execution_isolation", reason: /does not report the execution isolation/ },
    { name: "unpriced model", options: { priced: false }, id: "accounting_budget", reason: /unpriced/ },
    { name: "no budget", body: { ...launch, overrides: { ...launch.overrides, budget: undefined } }, id: "accounting_budget", reason: /No campaign budget yet/ },
    { name: "root session ceiling", body: { ...launch, overrides: { ...launch.overrides, session: { ...launch.overrides!.session,
      config: { model: "claude-opus-5-5", permissionMode: "orchestrator", costBudgetUsd: 50, maxToolCalls: 500 } } } },
      id: "native_review", reason: /root session's own cost or tool-call limit/ },
    { name: "old runner", options: { protocolVersion: 217 }, id: "authority_contract", reason: /protocol-v218/ },
    { name: "no inspection", options: { runtime: { ...runtime, campaignLaunchInspection: undefined } }, id: "repository_scope", reason: /cannot inspect the workspace/ },
    { name: "unknown policy ask", body: { ...launch, overrides: { ...launch.overrides, delegatablePolicyIds: ["missing"] } }, id: "authority_contract", reason: /missing/ },
  ];
  for (const item of cases) {
    const f = fixture(item.options);
    const { server } = await app(f);
    try {
      const { response, preflight: checked } = await preflight(server, item.body ?? launch);
      assert.equal(response.statusCode, 200, `${item.name}: ${response.body}`);
      assert.equal(checked!.ready, false, item.name);
      const capability = checked!.capabilities.find((entry) => entry.id === item.id)!;
      assert.equal(capability.state, "unsupported", item.name);
      assert.match(capability.reason, item.reason, item.name);
      assert.ok(checked!.summary.blockers.some((entry) => entry.reason === capability.reason), item.name);
      const admitted = await server.inject({ method: "POST", url: "/api/full-control-campaigns", headers: { authorization: "Bearer human" },
        payload: { ...(item.body ?? launch), requestId: "launch-1", preflightDigest: checked!.digest } });
      assert.equal(admitted.statusCode, 409, item.name);
      assert.match(admitted.json().error, /Full Control launch is blocked/);
      assert.equal(sessionCount(f), 0, item.name);
      assert.deepEqual(f.starts, [], item.name);
    } finally { await server.close(); f.db.close(); }
  }
  const limited = fixture();
  limited.db.setUsageDailyBudget(limited.human.organizationId, 5, Date.now());
  const { server } = await app(limited);
  try {
    const { preflight: checked } = await preflight(server, launch);
    assert.match(checked!.capabilities.find((entry) => entry.id === "native_review")!.reason, /per-user daily limit/);
    assert.equal(checked!.ready, false);
  } finally { await server.close(); limited.db.close(); }
});

test("a non-Human caller, a changed digest and a stale runner generation are refused before any write", async () => {
  const f = fixture();
  const { server } = await app(f);
  try {
    for (const auth of ["", "Bearer agent"]) {
      for (const url of ["/api/full-control-campaigns/preflight", "/api/full-control-campaigns"]) {
        const response = await server.inject({ method: "POST", url, headers: auth ? { authorization: auth } : {},
          payload: { ...launch, ...(url.endsWith("preflight") ? {} : { requestId: "launch-1", preflightDigest: "a".repeat(64) }) } });
        assert.equal(response.statusCode, 403, `${auth} ${url}`);
      }
    }
    assert.equal(f.sent.length, 0, "a refused caller never reaches the runner");
    const { preflight: checked } = await preflight(server, launch);
    assert.equal(checked!.ready, true);
    const changed = await server.inject({ method: "POST", url: "/api/full-control-campaigns", headers: { authorization: "Bearer human" },
      payload: { ...launch, overrides: { ...launch.overrides, budget: { costUsd: 41, toolCalls: 400 } }, requestId: "launch-1", preflightDigest: checked!.digest } });
    assert.equal(changed.statusCode, 409);
    assert.match(changed.json().error, /preflight changed/);
    // A runner reconnect is a new generation: the reviewed preflight is stale.
    f.reconnect(Date.now() + 1000);
    const stale = await server.inject({ method: "POST", url: "/api/full-control-campaigns", headers: { authorization: "Bearer human" },
      payload: { ...launch, requestId: "launch-1", preflightDigest: checked!.digest } });
    assert.equal(stale.statusCode, 409);
    assert.match(stale.json().error, /preflight changed/);
    for (const payload of [{ ...launch, repository: "other/repo" }, { ...launch, overrides: { authorizedByUserId: "injected" } },
      { runnerId: "r", workspaceId: "w" }, { ...launch, requestId: "x" }]) {
      assert.equal((await preflight(server, payload as FullControlLaunchRequest)).response.statusCode, 400, JSON.stringify(payload));
    }
    assert.equal(sessionCount(f), 0);
    assert.deepEqual(f.starts, []);
  } finally { await server.close(); f.db.close(); }
});

test("screenshots route to the Human when the Orchestrator model cannot review images, and the launch stays allowed", async () => {
  const f = fixture({ images: false });
  const { server } = await app(f);
  try {
    const { preflight: checked } = await preflight(server, launch);
    assert.equal(checked!.ready, true);
    const image = checked!.capabilities.find((item) => item.id === "image_evidence")!;
    assert.equal(image.state, "human_required");
    assert.equal(image.mandatory, false);
    assert.equal(checked!.summary.evidence.provider, null);
    assert.equal(checked!.summary.evidence.statement, "Screenshots, video and external evidence need your review.");
    assert.ok(checked!.summary.humanRequired.some((item) => item.exception === "Screenshot Evidence Review"));
  } finally { await server.close(); f.db.close(); }
});

test("a peer declaring the private media contract gets the evidence envelope from the same launch", async () => {
  const f = fixture({ pacedVideo: true });
  const { server } = await app(f);
  try {
    const { preflight: checked } = await preflight(server, launch);
    assert.equal(checked!.ready, true, JSON.stringify(checked!.summary.blockers));
    assert.equal(checked!.summary.evidence.envelope, true);
    const admitted = await server.inject({ method: "POST", url: "/api/full-control-campaigns", headers: { authorization: "Bearer human" },
      payload: { ...launch, requestId: "launch-video", preflightDigest: checked!.digest } });
    assert.equal(admitted.statusCode, 201, admitted.body);
    const control = f.db.getSession(admitted.json().id)!.orchestratorPolicy!.control!;
    if (control.mode !== "full_control") throw new Error("Full Control expected");
    const evidence = control.boundary.evidenceAuthority!;
    assert.equal(evidence.campaignRootSessionId, admitted.json().id);
    assert.equal(evidence.destination.configurationId, `session_artifacts:${f.human.organizationId}`);
    assert.equal(evidence.destination.privacy, "private");
    assert.deepEqual(evidence.providers.map((provider) => [provider.providerId, provider.retentionDisclosure, provider.reviewers]),
      [["claude-code", CAMPAIGN_EVIDENCE_RETENTION_DISCLOSURE, [{ driver: "claude-code", modelId: "claude-opus-5-5" }]]]);
    assert.equal(f.db.campaignProjection(admitted.json().id)!.decisionOwners.pr_merge, "orchestrator", "the envelope keeps the boundary supported");
  } finally { await server.close(); f.db.close(); }
});

test("the hosting video composition flips no launch capability: video stays with the Human even with a paced peer and a live proof", async () => {
  const plain = fixture({ pacedVideo: true });
  const hosted = fixture({ pacedVideo: true, hostingVideo: true });
  const video = hosted.video!;
  const plainApp = await app(plain), hostedApp = await app(hosted);
  try {
    const before = video.readiness();
    assert.equal(before.available ? "available" : before.code, "live_validation");
    const peer = video.pacedPeers()[0]!;
    const target = syntheticVideoReviewerTarget({ ...peer, modelId: "claude-opus-5-5", attestation: reviewerAttestation });
    assert.ok(video.liveValidation.recordInspectedRuns(hosted.human, target, syntheticInspectedVideoRuns(target, hosted.human.userId)));
    const readiness = video.readiness();
    assert.equal(readiness.available ? "available" : readiness.code, "reviewer_unavailable",
      "a recorded proof alone does not make video review available");
    const [expected, checked] = [(await preflight(plainApp.server, launch)).preflight!, (await preflight(hostedApp.server, launch)).preflight!];
    assert.deepEqual(checked.capabilities.map((item) => [item.id, item.state]), expected.capabilities.map((item) => [item.id, item.state]));
    const videoCapability = checked.capabilities.find((item) => item.id === "video_evidence")!;
    assert.equal(videoCapability.state, "human_required");
    assert.equal(videoCapability.reason, "Video evidence needs your review until production video review is available.");
    assert.ok(checked.summary.humanRequired.some((item) => item.exception === "Video Evidence Review" && item.reason === videoCapability.reason));
    assert.equal(checked.summary.evidence.statement, expected.summary.evidence.statement);
  } finally {
    await plainApp.server.close(); await hostedApp.server.close(); plain.db.close(); hosted.db.close();
  }
});

test("a current live proof makes launch video review delegable only when the envelope names the certified reviewer", async () => {
  const plain = fixture({ pacedVideo: true });
  const hosted = fixture({ pacedVideo: true, hostingVideo: true, videoPort: true });
  const video = hosted.video!;
  const plainApp = await app(plain), hostedApp = await app(hosted);
  const videoRow = (checked: CampaignLaunchPreflight) => checked.capabilities.find((item) => item.id === "video_evidence")!;
  try {
    const expected = (await preflight(plainApp.server, launch)).preflight!;
    const unchanged = async () => {
      const checked = (await preflight(hostedApp.server, launch)).preflight!;
      assert.deepEqual(checked.capabilities, expected.capabilities, "without a current proof the preflight is exactly as before");
      assert.deepEqual(checked.summary.evidence, expected.summary.evidence);
      assert.deepEqual(checked.summary.humanRequired, expected.summary.humanRequired);
    };
    await unchanged();
    const peer = video.pacedPeers()[0]!;
    const target = syntheticVideoReviewerTarget({ ...peer, modelId: "claude-opus-5-5", attestation: reviewerAttestation });
    // An expired proof is no certification.
    assert.ok(video.liveValidation.recordInspectedRuns(hosted.human, target, syntheticInspectedVideoRuns(target, hosted.human.userId),
      Date.now() - 31 * 24 * 60 * 60 * 1000));
    await unchanged();
    const proof = video.liveValidation.recordInspectedRuns(hosted.human, target, syntheticInspectedVideoRuns(target, hosted.human.userId))!;
    assert.ok(proof);

    const detached = (await preflight(hostedApp.server, launch)).preflight!;
    assert.equal(videoRow(detached).state, "human_required");
    assert.equal(videoRow(detached).reason, "Video evidence needs your review because this control plane's video review adapters are not attached yet.");
    assert.ok(detached.summary.humanRequired.some((item) => item.exception === "Video Evidence Review" && item.reason === videoRow(detached).reason));

    video.attach(hosted.sessions, hosted.hub);
    const ready = (await preflight(hostedApp.server, launch)).preflight!;
    assert.equal(videoRow(ready).state, "verified", videoRow(ready).reason);
    assert.match(videoRow(ready).reason, /certified claude-code claude-opus-5-5 \(high effort\) media-only reviewer/u);
    assert.ok(videoRow(ready).reason.includes(new Date(proof.expiresAt).toISOString()));
    assert.ok(!ready.summary.humanRequired.some((item) => item.exception === "Video Evidence Review"));
    assert.equal(ready.summary.evidence.statement,
      "The Orchestrator reviews screenshots, and video through the certified media-only reviewer. External evidence needs your review.");
    assert.equal(ready.summary.evidence.envelope, true);
    assert.equal(ready.ready, true);
    // Delegable video changes no other capability.
    assert.deepEqual(ready.capabilities.filter((item) => item.id !== "video_evidence"),
      expected.capabilities.filter((item) => item.id !== "video_evidence"));

    const sonnet = { ...launch, overrides: { ...launch.overrides, session: { ...launch.overrides!.session,
      config: { model: "claude-sonnet-5-5", permissionMode: "orchestrator" as const } } } };
    assert.equal(videoRow((await preflight(hostedApp.server, sonnet)).preflight!).reason,
      "Video evidence needs your review because the evidence envelope would name claude-code claude-sonnet-5-5, not the certified claude-code claude-opus-5-5 reviewer.");
    const humanEvidence = { ...launch, overrides: { ...launch.overrides, operations: ["implementation_question" as const, "pr_merge" as const] } };
    assert.equal(videoRow((await preflight(hostedApp.server, humanEvidence)).preflight!).reason,
      "Video evidence needs your review because UI evidence approval is not delegated to the Orchestrator.");
    const unbudgeted = { ...launch, overrides: { ...launch.overrides, budget: undefined } };
    assert.equal(videoRow((await preflight(hostedApp.server, unbudgeted)).preflight!).reason,
      "Video evidence needs your review because the launch is blocked, so no evidence envelope is minted.");
  } finally {
    await plainApp.server.close(); await hostedApp.server.close(); plain.db.close(); hosted.db.close();
  }
});

test("a revoked proof or a changed attestation returns launch video review to the Human exactly as before", async () => {
  const plain = fixture({ pacedVideo: true });
  const hosted = fixture({ pacedVideo: true, hostingVideo: true, videoPort: true });
  const video = hosted.video!;
  video.attach(hosted.sessions, hosted.hub);
  const plainApp = await app(plain), hostedApp = await app(hosted);
  const videoState = async () => (await preflight(hostedApp.server, launch)).preflight!.capabilities.find((item) => item.id === "video_evidence")!.state;
  try {
    const peer = video.pacedPeers()[0]!;
    const target = syntheticVideoReviewerTarget({ ...peer, modelId: "claude-opus-5-5", attestation: reviewerAttestation });
    const runs = () => syntheticInspectedVideoRuns(target, hosted.human.userId);
    const proof = video.liveValidation.recordInspectedRuns(hosted.human, target, runs())!;
    assert.equal(await videoState(), "verified");
    assert.ok(video.liveValidation.revoke(hosted.human, proof.proofId));
    const [expected, checked] = [(await preflight(plainApp.server, launch)).preflight!, (await preflight(hostedApp.server, launch)).preflight!];
    assert.deepEqual(checked.capabilities, expected.capabilities);
    assert.deepEqual(checked.summary.evidence, expected.summary.evidence);

    assert.ok(video.liveValidation.recordInspectedRuns(hosted.human, target, runs()));
    assert.equal(await videoState(), "verified");
    // The runner re-registers with a different attestation: the proof no longer certifies it.
    const runner = hosted.db.getRunner("r")!;
    hosted.db.registerRunner({ runnerId: runner.runnerId, hostname: "fixture", os: "linux", version: "test", workspaces: runner.workspaces,
      agents: runner.agents.map((agent) => ({ ...agent, capabilities: { ...agent.capabilities!,
        mediaReviewerAttestation: syntheticMediaReviewerAttestation("claude", "changed") } })), runtime: runner.runtime } as never,
    Date.now(), PROTOCOL_VERSION);
    assert.equal(await videoState(), "human_required");
  } finally {
    await plainApp.server.close(); await hostedApp.server.close(); plain.db.close(); hosted.db.close();
  }
});

test("Project child-session ceilings block controlled review, and a task alone launches with an empty issue scope", async () => {
  const f = fixture();
  const organizationScope = { organizationId: f.human.organizationId, owner: { kind: "organization" as const, organizationId: f.human.organizationId } };
  const project = f.db.createProject({ name: "Fixture", scope: organizationScope });
  const location = f.db.addProjectLocation(project.id, { runnerId: "r", workspaceId: "w" });
  f.db.updateProject(project.id, { childSessionDefaults: { costBudgetUsd: 5, maxToolCalls: 50 } });
  const { server } = await app(f);
  try {
    const body: FullControlLaunchRequest = { runnerId: "r", workspaceId: "w", projectId: project.id, task: "Investigate flaky tests",
      overrides: { session: { config: { model: "claude-opus-5-5", permissionMode: "orchestrator" } }, budget: { costUsd: 10, toolCalls: 100 } } };
    const blocked = await preflight(server, body);
    assert.equal(blocked.response.statusCode, 200, blocked.response.body);
    assert.equal(blocked.preflight!.ready, false);
    assert.match(blocked.preflight!.capabilities.find((item) => item.id === "native_review")!.reason, /child-session defaults/);
    assert.equal(blocked.preflight!.summary.budget.source, "override", "saved per-session limits never become the campaign envelope");

    f.db.updateProject(project.id, { childSessionDefaults: null });
    const { response, preflight: checked } = await preflight(server, body);
    assert.equal(response.statusCode, 200, response.body);
    assert.equal(checked!.ready, true, JSON.stringify(checked!.summary.blockers));
    assert.equal(checked!.summary.root.agentId, "claude", "the default root is the reviewer's own Claude Code installation");
    assert.deepEqual(checked!.summary.issueNumbers, []);
    assert.deepEqual(f.sent.filter((message) => message.type === "campaign_launch_inspect").map((message) =>
      (message as { issueNumbers: number[] }).issueNumbers), [[], []]);
    assert.deepEqual(checked!.summary.budget, { costUsd: 10, toolCalls: 100, concurrency: 4, acceptedFollowUps: 0, source: "override", reviewIncluded: true });
    const admitted = await server.inject({ method: "POST", url: "/api/full-control-campaigns", headers: { authorization: "Bearer human" },
      payload: { ...body, requestId: "task-only", preflightDigest: checked!.digest } });
    assert.equal(admitted.statusCode, 201, admitted.body);
    const root = f.db.getSession(admitted.json().id)!;
    assert.deepEqual(root.orchestratorPolicy!.issueScope!.issueNumbers, []);
    // The organization Project contains a user-owned root; ordinary creation there is unchanged.
    assert.equal(root.projectId, project.id);
    assert.deepEqual(f.db.sessionScope(root.id), f.scope);
    const ordinary = resolveSessionCreationOwnership(f.db, f.human, { runnerId: "r", workspaceId: "w", projectId: project.id,
      projectLocationId: location.id, agentId: "claude" });
    assert.ok(ordinary.ok);
    assert.deepEqual(ordinary.scope, organizationScope);
    assert.equal(f.db.campaignProjection(root.id)!.budget!.requiredNativeReview!.supported, true);
  } finally { await server.close(); f.db.close(); }
});

test("an empty launch scope delegates no issue writes: additions are refused and closure or publication get no bounded admission", async () => {
  const f = fixture();
  const { server } = await app(f);
  const send = f.hub.sendToRunner;
  f.hub.sendToRunner = (runnerId, message) => {
    if (message.type === "campaign_issue_scope" && message.operation === "inspect") {
      const issues = message.issues ?? [];
      queueMicrotask(() => f.hub.resolveRunnerRequest({ type: "campaign_issue_scope_result", requestId: message.requestId,
        sessionId: message.sessionId, ok: true, repository: "owner/repo",
        candidates: issues.map((number) => ({ issue: { repository: "owner/repo", number }, title: `Issue ${number}`, source: "member_checklist" as const })) }, "r"));
      return true;
    }
    return send(runnerId, message);
  };
  try {
    const body: FullControlLaunchRequest = { runnerId: "r", workspaceId: "w", task: "Investigate flaky tests",
      overrides: { session: { config: { model: "claude-opus-5-5", permissionMode: "orchestrator" } }, budget: { costUsd: 10, toolCalls: 100 },
        issues: { relatedFollowUps: true, maxIssues: 3 } } };
    const { preflight: checked } = await preflight(server, body);
    assert.equal(checked!.ready, true, JSON.stringify(checked!.summary.blockers));
    const admitted = await server.inject({ method: "POST", url: "/api/full-control-campaigns", headers: { authorization: "Bearer human" },
      payload: { ...body, requestId: "empty-scope", preflightDigest: checked!.digest } });
    assert.equal(admitted.statusCode, 201, admitted.body);
    const root = f.db.getSession(admitted.json().id)!;
    const control = root.orchestratorPolicy!.control!;
    if (control.mode !== "full_control") throw new Error("Full Control expected");
    assert.deepEqual(root.orchestratorPolicy!.issueScope!.issueNumbers, []);
    assert.deepEqual(control.boundary.issueAuthority!.epics, []);

    // The Orchestrator cannot widen an empty scope: an addition needs epic or in-scope lineage.
    const addition = await f.sessions.proposeCampaignIssueScope(root.id, { requestId: "add-5", expectedRevision: 1,
      additions: [{ repository: "owner/repo", number: 5 }], removals: [], explanation: "Fixture addition without lineage" });
    assert.equal(addition.ok, false);
    assert.equal(addition.status, 403);
    assert.match(addition.error!, /authorized epic or exact related-publication lineage/);
    const epic = await f.sessions.proposeCampaignIssueScope(root.id, { requestId: "add-epic", expectedRevision: 1,
      additions: [{ repository: "owner/repo", number: 5 }], removals: [], explanation: "Fixture epic addition", lineage: { kind: "epic", epic: 5 } });
    assert.equal(epic.ok, false);
    assert.equal(epic.status, 403, "an epic outside the empty authorized epic list grants nothing");
    assert.equal(f.db.getSession(root.id)!.orchestratorPolicy!.issueScope!.revision, 1);

    // Closure and publication have no bounded admission, so the typed gate stays with the Human.
    // Ledger reads are stubbed with otherwise eligible delivered work and an accepted related
    // recommendation, so only scope membership separates the positive control from the refusal.
    const delivered = { id: "wi-5", issue: { repository: "owner/repo", number: 5 }, primaryState: "delivered", currentAttempt: null,
      verifications: [{ outcome: "delivered", report: { digest: "d".repeat(64) } }],
      observed: { pullRequests: [{ ref: { repository: "owner/repo", number: 10 },
        fact: { availability: "fresh", value: { state: "merged", headSha: "b".repeat(40), mergeCommitSha: "c".repeat(40) } } }] } } as unknown as CampaignWorkItemDetail;
    const ledger = f.db.campaignWorkLedger;
    ledger.page = (() => ({ ok: true, data: { items: [delivered] } })) as unknown as typeof ledger.page;
    ledger.detail = (() => delivered) as unknown as typeof ledger.detail;
    ledger.recommendation = (() => ({ id: "rec-1", disposition: "accepted", duplicateOfId: null, publication: "awaiting_publication",
      dispositionReason: "Observed related work", repository: "owner/repo", title: "Fixture Follow-Up", originWorkItemIds: ["wi-5"] })) as unknown as typeof ledger.recommendation;
    const inScope = structuredClone(root);
    inScope.orchestratorPolicy!.issueNumbers = [5];
    const closure = { category: "issue_closure", repository: "owner/repo", issue: 5, title: "Issue 5", forgeDigest: "f".repeat(64),
      reason: "completed", explanation: "Fixture closure", evidence: [], activeChildren: [], openPullRequests: [],
      delivery: [{ number: 10, headSha: "b".repeat(40), mergeCommitSha: "c".repeat(40) }] } as unknown as GithubIssueClosureSnapshot;
    assert.ok(closureEvidence(f.db, inScope, closure), "positive control: the same delivered issue in scope is admissible");
    assert.equal(closureEvidence(f.db, root, closure), null);
    const publication = { category: "follow_up_issue_publication" as const, repository: "owner/repo", sanitizedTitle: "Fixture Follow-Up",
      sanitizedBody: "## Problem\nRelated failure\n## Proposed Behavior\nRepair it\n## Acceptance Criteria\n- Verified repair\n## Security and Compatibility\nNone",
      labels: [], recommendationId: "rec-1" };
    assert.ok(publicationEvidence(f.db, inScope, publication), "positive control: an in-scope origin is admissible");
    assert.equal(publicationEvidence(f.db, root, publication), null);
    for (const snapshot of [closure, publication]) {
      const evaluation = evaluateCampaignAuthority(root, root, PROTOCOL_VERSION, snapshot);
      assert.equal(evaluation.owner, "human", snapshot.category);
      assert.equal(evaluation.basis, "human_required", snapshot.category);
    }
  } finally { await server.close(); f.db.close(); }
});

test("saved defaults changed while the admission inspection is pending invalidate the reviewed digest", async () => {
  const f = fixture();
  const identity = { agentId: "claude", driver: "claude-code" as const, context: { kind: "native" as const } };
  f.db.setAgentHarnessDefault(f.human.userId, identity, { model: "claude-opus-5-5" });
  const { server } = await app(f);
  try {
    const body: FullControlLaunchRequest = { ...launch, overrides: { ...launch.overrides, session: { agentId: "claude", config: { permissionMode: "orchestrator" } } } };
    const { preflight: checked } = await preflight(server, body);
    assert.equal(checked!.ready, true, JSON.stringify(checked!.summary.blockers));
    assert.equal(checked!.summary.root.model, "claude-opus-5-5");
    const answer = f.state.inspect;
    f.state.inspect = (message) => {
      f.db.setAgentHarnessDefault(f.human.userId, identity, { model: "claude-sonnet-5-5" });
      return answer(message);
    };
    const admitted = await server.inject({ method: "POST", url: "/api/full-control-campaigns", headers: { authorization: "Bearer human" },
      payload: { ...body, requestId: "drift", preflightDigest: checked!.digest } });
    assert.equal(admitted.statusCode, 409, admitted.body);
    assert.match(admitted.json().error, /preflight changed/);
    assert.equal(admitted.json().preflight.summary.root.model, "claude-sonnet-5-5");
    assert.equal(sessionCount(f), 0);
    assert.deepEqual(f.starts, []);
  } finally { await server.close(); f.db.close(); }
});

test("a lost admission response recovers the committed root even after HEAD or runner generation change", async () => {
  const f = fixture();
  const { server } = await app(f);
  try {
    const { preflight: checked } = await preflight(server, launch);
    const payload = { ...launch, requestId: "lost-response", preflightDigest: checked!.digest };
    const first = await server.inject({ method: "POST", url: "/api/full-control-campaigns", headers: { authorization: "Bearer human" }, payload });
    assert.equal(first.statusCode, 201, first.body);
    const answer = f.state.inspect;
    f.state.inspect = (message) => ({ ...answer(message)!, digest: "e".repeat(64) });
    f.reconnect(Date.now() + 1000);
    const inspections = f.sent.filter((message) => message.type === "campaign_launch_inspect").length;
    const retry = await server.inject({ method: "POST", url: "/api/full-control-campaigns", headers: { authorization: "Bearer human" }, payload });
    assert.equal(retry.statusCode, 200, retry.body);
    assert.equal(retry.json().id, first.json().id);
    assert.equal(f.sent.filter((message) => message.type === "campaign_launch_inspect").length, inspections, "no new inspection");
    assert.equal(f.starts.length, 1, "no provider start is replayed");
    const reused = await server.inject({ method: "POST", url: "/api/full-control-campaigns", headers: { authorization: "Bearer human" },
      payload: { ...payload, preflightDigest: "f".repeat(64) } });
    assert.equal(reused.statusCode, 409);
    assert.match(reused.json().error, /already admitted a different reviewed launch/);
    assert.equal(sessionCount(f), 1);
  } finally { await server.close(); f.db.close(); }
});

test("an expired inspection is cancelled on the runner and its late result cannot admit a launch (#3360)", async () => {
  const f = fixture();
  let held: CampaignLaunchInspectionResult | undefined;
  f.state.inspect = (message) => { held = { type: "campaign_launch_inspection_result", requestId: message.requestId,
    workspaceId: message.workspaceId, ok: true, repository: "owner/repo", issueNumbers: message.issueNumbers, digest: "d".repeat(64) }; return null; };
  const { server } = await app(f, 20);
  try {
    const { preflight: checked } = await preflight(server, launch);
    assert.equal(checked!.ready, false);
    assert.match(checked!.capabilities.find((item) => item.id === "repository_scope")!.reason, /did not answer the workspace inspection in time/);
    const cancels = f.sent.filter((message) => message.type === "campaign_launch_inspect_cancel");
    assert.deepEqual(cancels, [{ type: "campaign_launch_inspect_cancel", requestId: held!.requestId }]);
    assert.equal(f.hub.resolveRunnerRequest(held!, "r"), false, "the late result is discarded");
    const admitted = await server.inject({ method: "POST", url: "/api/full-control-campaigns", headers: { authorization: "Bearer human" },
      payload: { ...launch, requestId: "late", preflightDigest: checked!.digest } });
    assert.equal(admitted.statusCode, 409);
    assert.equal(sessionCount(f), 0);
    assert.deepEqual(f.starts, []);
  } finally { await server.close(); f.db.close(); }
});

test("a cancelled caller stops only its own inspection, and older runners report unsupported cancellation (#3360)", async () => {
  const f = fixture();
  f.state.inspect = () => null;
  const runner = f.db.getRunner("r")!;
  const caller = new AbortController();
  const pending = inspectCampaignWorkspace(f.hub, runner, "w", [1, 2, 3], caller.signal, 60_000);
  const other = inspectCampaignWorkspace(f.hub, runner, "w", [4], new AbortController().signal, 60_000);
  const [mine, theirs] = f.sent.filter((message) => message.type === "campaign_launch_inspect") as Array<{ requestId: string }>;
  caller.abort();
  assert.equal(await pending, undefined);
  assert.deepEqual(f.sent.filter((message) => message.type === "campaign_launch_inspect_cancel"),
    [{ type: "campaign_launch_inspect_cancel", requestId: mine!.requestId }]);
  assert.equal(f.hub.resolveRunnerRequest({ type: "campaign_launch_inspection_result", requestId: mine!.requestId, workspaceId: "w", ok: true,
    repository: "owner/repo", issueNumbers: [1, 2, 3], digest: "d".repeat(64) }, "r"), false);
  assert.equal(f.hub.resolveRunnerRequest({ type: "campaign_launch_inspection_result", requestId: theirs!.requestId, workspaceId: "w", ok: true,
    repository: "owner/repo", issueNumbers: [4], digest: "d".repeat(64) }, "r"), true);
  assert.equal((await other)?.ok, true, "another caller's inspection is unaffected");
  f.db.close();

  const legacy = fixture({ runtime: { ...runtime, campaignLaunchInspection: { version: 1 } } });
  legacy.state.inspect = () => null;
  const { server } = await app(legacy, 20);
  try {
    const { preflight: checked } = await preflight(server, launch);
    assert.equal(checked!.inspectionCancellation, "unsupported");
    assert.equal(legacy.sent.filter((message) => message.type === "campaign_launch_inspect_cancel").length, 0,
      "a version-1 runner is never sent a message it cannot parse");
    const taskOnly = await preflight(server, { runnerId: "r", workspaceId: "w", task: "No issues" });
    assert.match(taskOnly.preflight!.capabilities.find((item) => item.id === "repository_scope")!.reason, /select issue numbers or update the runner/);
  } finally { await server.close(); legacy.db.close(); }
});

test("fixture Human atomic admission commits scope/control/budget before its one provider start and never replays", () => {
  const f = fixture();
  try {
    const issueScope = { repository: proposal.repository, issueNumbers: [12], revision: 1, authorizedByUserId: f.human.userId, authorizedAt: 1 };
    const control = authorizeFullControl(f.human, issueScope, proposal, 1, 1)!;
    assert.equal(control.mode, "full_control");
    if (control.mode !== "full_control") throw new Error("fixture Full control expected");
    let starts = 0;
    f.hub.sendToRunner = (_, message) => {
      if (message.type !== "start_session") return true;
      starts++;
      assert.equal(f.db.raw().isTransaction, false, "provider start is after COMMIT");
      const root = f.db.getSession(message.spec.sessionId)!;
      assert.deepEqual(root.orchestratorPolicy!.control, control);
      assert.deepEqual(message.spec.orchestrator!.issueNumbers, [12]);
      assert.deepEqual(message.spec.orchestrator!.control, control);
      assert.equal(message.initialPrompt, "Deliver #12");
      const budget = f.db.campaignBudgets.view(root.id)!;
      assert.equal(budget.state, "active");
      assert.equal(budget.sessionLimits!.costBudgetUsd, 50);
      assert.equal(budget.sessionLimits!.maxToolCalls, 500);
      assert.equal(message.spec.config!.costBudgetUsd, budget.rootAllocation!.costUsd);
      assert.ok(message.spec.campaignBudgetDispatch);
      return true;
    };
    const context = { defaultOwnerUserId: f.human.userId, humanCampaignLaunch: { principal: f.human, requestId: "launch-1", digest: "a".repeat(64), control, issueScope } };
    const first = f.sessions.createSession(request, undefined, f.scope, false, false, false, context);
    assert.equal(first.ok, true, first.error ?? "fixture admission succeeded");
    assert.equal(first.data!.parentControlPolicy!.revision, 1);
    assert.equal(starts, 1);
    const repeated = f.sessions.createSession(request, undefined, f.scope, false, false, false, context);
    assert.equal(repeated.ok, true, repeated.error ?? "fixture duplicate read succeeded");
    assert.equal(repeated.data!.id, first.data!.id);
    assert.equal(starts, 1);
    const changed = f.sessions.createSession(request, undefined, f.scope, false, false, false,
      { ...context, humanCampaignLaunch: { ...context.humanCampaignLaunch, digest: "b".repeat(64) } });
    assert.equal(changed.ok, false);
    assert.equal(starts, 1);
  } finally { f.db.close(); }
});

test("an admission failure rolls back the root, scope, allowance and launch identity and sends nothing", () => {
  const f = fixture();
  try {
    const issueScope = { repository: proposal.repository, issueNumbers: [12], revision: 1, authorizedByUserId: f.human.userId, authorizedAt: 1 };
    const control = authorizeFullControl(f.human, issueScope, proposal, 1, 1)!;
    if (control.mode !== "full_control") throw new Error("fixture control expected");
    f.db.raw().exec("CREATE TRIGGER fail_human_launch BEFORE INSERT ON human_campaign_launches BEGIN SELECT RAISE(ABORT,'fixture admission failure'); END");
    const result = f.sessions.createSession(request, undefined, f.scope, false, false, false, {
      defaultOwnerUserId: f.human.userId, humanCampaignLaunch: { principal: f.human, requestId: "launch-1", digest: "a".repeat(64), control, issueScope },
    });
    assert.equal(result.ok, false);
    assert.match(result.error!, /fixture admission failure/);
    for (const table of ["sessions", "campaign_budgets", "campaign_budget_members", "human_campaign_launches"]) {
      assert.equal(f.db.raw().prepare(`SELECT count(*) AS n FROM ${table}`).get()!.n, 0, `${table} rolled back`);
    }
    assert.deepEqual(f.starts, []);
  } finally { f.db.close(); }
});

test("uncertain dispatch retains the root reservation and identity without retrying or refunding", () => {
  const f = fixture();
  try {
    const issueScope = { repository: proposal.repository, issueNumbers: [12], revision: 1, authorizedByUserId: f.human.userId, authorizedAt: 1 };
    const control = authorizeFullControl(f.human, issueScope, proposal, 1, 1)!;
    if (control.mode !== "full_control") throw new Error("fixture control expected");
    let sends = 0;
    f.hub.sendToRunner = () => { sends++; return false; };
    const context = { defaultOwnerUserId: f.human.userId, humanCampaignLaunch: {
      principal: f.human, requestId: "launch-1", digest: "a".repeat(64), control, issueScope,
    } };
    const first = f.sessions.createSession(request, undefined, f.scope, true, false, false, context);
    assert.equal(first.ok, false);
    assert.equal(first.errorDetails!.code, "FULL_CONTROL_LAUNCH_RETAINED");
    const id = String(first.errorDetails!.sessionId);
    assert.ok(f.db.getSession(id));
    assert.equal(f.db.campaignBudgets.view(id)!.outstanding.costUsd > 0, true);
    assert.equal(f.db.raw().prepare("SELECT dispatch_state FROM human_campaign_launches").get()!.dispatch_state, "uncertain");
    const again = f.sessions.createSession(request, undefined, f.scope, false, false, false, context);
    assert.equal(again.data!.id, id);
    assert.equal(sends, 1);
    assert.equal(f.db.claimHumanCampaignDispatch(id), false);
  } finally { f.db.close(); }
});

const savedBudget = { costUsd: 30, toolCalls: 300 };
const saveBudget = (f: ReturnType<typeof fixture>, campaignBudget: { costUsd: number; toolCalls: number } | null) =>
  f.settings.update(f.human, { defaults: { ...structuredClone(DEFAULT_ORCHESTRATOR_DEFAULTS), campaignBudget } });

test("the saved Full Control budget becomes the launch envelope, an override replaces it, and none asks for one inline", async () => {
  const f = fixture();
  const { server } = await app(f);
  try {
    const plain: FullControlLaunchRequest = { ...launch, overrides: { session: launch.overrides!.session } };
    const unset = await preflight(server, plain);
    assert.equal(unset.preflight!.summary.budget.source, "unset");
    assert.equal(unset.preflight!.capabilities.find((item) => item.id === "accounting_budget")!.reason,
      "No campaign budget yet: enter a cost limit and a tool-call limit.");
    saveBudget(f, savedBudget);
    const saved = await preflight(server, plain);
    assert.equal(saved.preflight!.ready, true, JSON.stringify(saved.preflight!.summary.blockers));
    assert.deepEqual([saved.preflight!.summary.budget.costUsd, saved.preflight!.summary.budget.toolCalls, saved.preflight!.summary.budget.source],
      [30, 300, "saved_defaults"]);
    assert.notEqual(saved.preflight!.digest, unset.preflight!.digest);
    const overridden = await preflight(server, { ...plain, overrides: { ...plain.overrides, budget: { costUsd: 12 } } });
    assert.deepEqual([overridden.preflight!.summary.budget.costUsd, overridden.preflight!.summary.budget.toolCalls, overridden.preflight!.summary.budget.source],
      [12, 300, "override"]);
    const admitted = await server.inject({ method: "POST", url: "/api/full-control-campaigns", headers: { authorization: "Bearer human" },
      payload: { ...plain, requestId: "saved-budget", preflightDigest: saved.preflight!.digest } });
    assert.equal(admitted.statusCode, 201, admitted.body);
    const control = f.db.getSession(admitted.json().id)!.orchestratorPolicy!.control!;
    if (control.mode !== "full_control") throw new Error("Full Control expected");
    assert.deepEqual([control.boundary.budgetAuthority!.costUsd, control.boundary.budgetAuthority!.toolCalls], [30, 300]);

    // A saved budget changed while the admission inspection is pending invalidates the reviewed digest.
    const { preflight: reviewed } = await preflight(server, plain);
    assert.equal(reviewed!.summary.budget.source, "saved_defaults");
    const answer = f.state.inspect;
    f.state.inspect = (message) => { saveBudget(f, null); return answer(message); };
    const sessions = sessionCount(f);
    const refused = await server.inject({ method: "POST", url: "/api/full-control-campaigns", headers: { authorization: "Bearer human" },
      payload: { ...plain, requestId: "budget-changed", preflightDigest: reviewed!.digest } });
    assert.equal(refused.statusCode, 409, refused.body);
    assert.match(refused.json().error, /preflight changed/);
    assert.equal(refused.json().preflight.summary.budget.source, "unset");
    assert.equal(sessionCount(f), sessions, "no campaign starts on the budget the Human no longer has saved");
  } finally { await server.close(); f.db.close(); }
});


/** A live Custom campaign whose issue scope this Human established, never Full Control before. */
function customCampaign(f: ReturnType<typeof fixture>, id = "custom-root", authorizedByUserId = f.human.userId) {
  const policy = resolveOrchestratorCampaignPolicy(DEFAULT_ORCHESTRATOR_DEFAULTS, "system_default");
  policy.issueScope = { repository: "owner/repo", issueNumbers: [12], revision: 1, authorizedByUserId, authorizedAt: 1 };
  policy.issueNumbers = [12];
  f.db.createSession({ id, runnerId: "r", workspaceId: "w", agentId: "claude", title: "Deliver #12", useWorktree: false,
    driver: "claude-code", creationActor: "human", scope: f.scope, config: { model: "claude-opus-5-5", permissionMode: "orchestrator" }, now: 2,
    role: "orchestrator", orchestratorPolicy: policy, parentControlPolicy: { decisions: { ...HUMAN_ONLY_PARENT_CONTROL_POLICY } } });
  f.db.updateSessionStatus(id, "running", 3);
  return id;
}

test("an existing campaign enables Full Control through one exact reviewed authorization and keeps Revoke", async () => {
  const f = fixture();
  saveBudget(f, savedBudget);
  const { server } = await app(f);
  try {
    const rootId = customCampaign(f);
    const url = `/api/sessions/${rootId}/orchestrator-campaign/full-control`;
    for (const auth of ["", "Bearer agent"]) {
      assert.equal((await server.inject({ method: "POST", url: `${url}/preflight`, headers: auth ? { authorization: auth } : {}, payload: {} })).statusCode, 403);
    }
    const checked = await server.inject({ method: "POST", url: `${url}/preflight`, headers: { authorization: "Bearer human" }, payload: {} });
    assert.equal(checked.statusCode, 200, checked.body);
    const { preflight: enablePreflight, expectedRevision } = checked.json() as { preflight: CampaignLaunchPreflight; expectedRevision: number };
    assert.equal(enablePreflight.ready, true, JSON.stringify(enablePreflight.summary.blockers));
    assert.equal(enablePreflight.capabilities.find((item) => item.id === "repository_scope")!.reason,
      "This campaign's Human-established scope is owner/repo with issues #12.");
    assert.equal(enablePreflight.summary.budget.source, "saved_defaults");
    assert.equal(f.sent.filter((message) => message.type === "campaign_launch_inspect").length, 0, "enabling needs no workspace inspection");
    for (const stale of [{ expectedRevision: expectedRevision + 1, preflightDigest: enablePreflight.digest },
      { expectedRevision, preflightDigest: "f".repeat(64) }]) {
      const refused = await server.inject({ method: "POST", url, headers: { authorization: "Bearer human" }, payload: stale });
      assert.equal(refused.statusCode, 409, JSON.stringify(stale));
      assert.match(refused.json().error, /changed; refresh/);
    }
    assert.equal(f.db.getSession(rootId)!.orchestratorPolicy!.control, undefined, "a refused enable changes nothing");
    const enabled = await server.inject({ method: "POST", url, headers: { authorization: "Bearer human" },
      payload: { expectedRevision, preflightDigest: enablePreflight.digest } });
    assert.equal(enabled.statusCode, 200, enabled.body);
    const root = f.db.getSession(rootId)!;
    const control = root.orchestratorPolicy!.control!;
    if (control.mode !== "full_control") throw new Error("Full Control expected");
    assert.equal(root.parentControlPolicy!.revision, expectedRevision + 1);
    assert.equal(control.boundary.authorizedByUserId, f.human.userId);
    assert.deepEqual([control.boundary.budgetAuthority!.costUsd, control.boundary.budgetAuthority!.toolCalls], [30, 300]);
    assert.deepEqual(control.boundary.budgetAuthority!.controlledReview, review);
    for (const category of WORKFLOW_DECISION_CATEGORIES) {
      assert.equal(f.db.campaignProjection(rootId)!.decisionOwners[category], "orchestrator", category);
    }
    const replay = await server.inject({ method: "POST", url, headers: { authorization: "Bearer human" },
      payload: { expectedRevision, preflightDigest: enablePreflight.digest } });
    assert.equal(replay.statusCode, 409, "an enabled revision cannot be replayed");
    const revoked = f.sessions.setCampaignControl(rootId, { mode: "custom" }, root.parentControlPolicy!.revision, f.human);
    assert.ok(revoked.ok, revoked.error ?? "Revoke stays the ordinary operation");
  } finally { await server.close(); f.db.close(); }
});

test("enabling an existing campaign is blocked by another person's scope, participant ceilings and a missing budget", async () => {
  const f = fixture();
  const { server } = await app(f);
  const check = async (id: string, payload: object = {}) => (await server.inject({ method: "POST",
    url: `/api/sessions/${id}/orchestrator-campaign/full-control/preflight`, headers: { authorization: "Bearer human" }, payload })).json().preflight as CampaignLaunchPreflight;
  try {
    const foreign = customCampaign(f, "foreign-root", "someone-else");
    assert.equal((await check(foreign, { overrides: { budget: savedBudget } })).capabilities.find((item) => item.id === "repository_scope")!.reason,
      "Only the person who established this campaign's issue scope can enable Full Control for it.");
    const rootId = customCampaign(f);
    const unbudgeted = await check(rootId);
    assert.equal(unbudgeted.ready, false);
    assert.equal(unbudgeted.summary.budget.source, "unset");
    assert.equal(unbudgeted.capabilities.find((item) => item.id === "native_review")!.state, "verified");
    f.db.createSession({ id: "limited-child", parentSessionId: rootId, runnerId: "r", workspaceId: "w", agentId: "claude", title: "child",
      useWorktree: false, creationActor: "agent", driver: "claude-code", config: { model: "claude-opus-5-5" }, now: 3 });
    f.db.updateSessionStatus("limited-child", "running", 4);
    f.db.updateSessionCostBudget("limited-child", 5, 4);
    const limited = await check(rootId, { overrides: { budget: savedBudget } });
    assert.equal(limited.ready, false);
    assert.match(limited.capabilities.find((item) => item.id === "native_review")!.reason, /limits some of this campaign's sessions already hold/);
    f.db.updateSessionStatus("limited-child", "completed", 5);
    assert.equal((await check(rootId, { overrides: { budget: savedBudget } })).ready, true, "a finished participant no longer blocks");
    assert.equal((await server.inject({ method: "POST", url: `/api/sessions/${rootId}/orchestrator-campaign/full-control/preflight`,
      headers: { authorization: "Bearer human" }, payload: { overrides: { session: { agentId: "claude" } } } })).statusCode, 400,
      "an existing root's harness cannot be overridden");
  } finally { await server.close(); f.db.close(); }
});
