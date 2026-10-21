import assert from "node:assert/strict";
import { test } from "node:test";
import Fastify from "fastify";
import {
  CAMPAIGN_EVIDENCE_RETENTION_DISCLOSURE, CONTROLLED_REVIEW_PROFILE, FULL_CONTROL_FIRST_MESSAGE_OBJECTIVE, DEFAULT_ORCHESTRATOR_DEFAULTS, HUMAN_ONLY_PARENT_CONTROL_POLICY, PROTOCOL_VERSION, WORKFLOW_DECISION_CATEGORIES,
  campaignWorkflowOwner,
  type CampaignLaunchInspectionResult, type CampaignLaunchPreflight, type CampaignLaunchProposal, type ControlledReviewCapability,
  type CampaignWorkItemDetail, type ControlPlaneToRunner, type CreateSessionRequest, type FullControlLaunchRequest, type GithubIssueClosureSnapshot, type RunnerMetadata, type RunnerRuntimeInfo,
} from "@wollipog/protocol";
import { ControlPlaneDb } from "./db.js";
import { Hub } from "./hub.js";
import { SessionsService } from "./sessions.js";
import { OrchestratorSettings, resolveOrchestratorCampaignPolicy } from "./orchestrator-settings.js";
import { authorizeFullControl, campaignBoundaryCurrent, evaluateCampaignAuthority } from "./campaign-authority.js";
import { firstMessageDigest, firstMessageObjective } from "./campaign-launch-admission.js";
import { closureEvidence, publicationEvidence } from "./campaign-issue-authority.js";
import { hostingEvidenceAuthorityDisclosures } from "./hosting-evidence-disclosures.js";
import { composeHostingVideoEvidence } from "./hosting-video-evidence.js";
import { syntheticInspectedVideoRuns, syntheticMediaReviewerAttestation, syntheticVideoReviewerTarget } from "./video-live-validation-test-fixture.js";
import type { AuthPrincipal, HumanPrincipal } from "./identity.js";
import { inspectCampaignWorkspace, registerFullControlLaunchRoutes } from "./full-control-launch-route.js";
import type { SessionPromptOutbox } from "./session-prompt-outbox.js";
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
  // Issue reads answer as the runner does: one number that is not an issue of the origin refuses
  // the whole read. Synchronization echoes the revision it persisted.
  const issues = { repository: "owner/repo" as string | null, notIssues: new Set<number>(), holdSync: null as Promise<void> | null };
  hub.sendToRunner = (_, message) => {
    sent.push(message);
    if (message.type === "start_session") starts.push(message);
    if (message.type === "campaign_launch_inspect") {
      const answer = state.inspect(message);
      if (answer) queueMicrotask(() => hub.resolveRunnerRequest(answer, "r"));
    }
    if (message.type === "campaign_issue_scope" && (message.operation === "inspect" || message.operation === "synchronize")) {
      const requested = message.operation === "inspect" ? message.issues ?? [] : [];
      const answer = message.operation === "synchronize" ? { ok: true, repository: "owner/repo", revision: message.scope.revision }
        : issues.repository && !requested.some((n) => issues.notIssues.has(n))
          ? { ok: true, repository: issues.repository, candidates: requested.map((n) => ({ issue: { repository: issues.repository!, number: n },
            title: `Issue ${n}`, source: "member_checklist" as const })) }
          : { ok: false };
      const respond = () => hub.resolveRunnerRequest({ type: "campaign_issue_scope_result", requestId: message.requestId,
        sessionId: message.sessionId, ...answer }, "r");
      if (message.operation === "synchronize" && issues.holdSync) void issues.holdSync.then(respond);
      else queueMicrotask(respond);
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
  return { db, hub, sent, starts, state, issues, sessions, human, scope, settings, disclosures, reconnect, video, videoCertification };
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
    assert.deepEqual(checked!.capabilities.filter((item) => item.state === "orchestrator_decides").map((item) => item.id), ["video_evidence", "external_evidence"]);
    assert.deepEqual(checked!.capabilities.filter((item) => item.state === "human_required"), [], "Full Control routes no evidence to the Human (#2940)");
    const summary = checked!.summary;
    assert.equal(summary.repository, "owner/repo");
    assert.deepEqual(summary.issueNumbers, [7, 12]);
    assert.equal(summary.objective, "Deliver the launch issues");
    assert.deepEqual(summary.budget, { costUsd: 40, toolCalls: 400, concurrency: 4, acceptedFollowUps: 2, source: "override", reviewIncluded: true });
    assert.deepEqual(summary.review, { controlled: true, statement: "Controlled cross-model review, charged to this campaign." });
    assert.deepEqual(summary.followUps, { policy: "execute_approved", relatedFollowUps: true, maxIssues: 4, closureReasons: ["completed"] });
    assert.equal(summary.root.completion, "stop_and_archive");
    assert.deepEqual(summary.root.isolation, { mode: "provider", network: "inherit" });
    assert.equal(summary.evidence.statement, "The Orchestrator reviews screenshots. For video and external evidence it asks for screenshots or denies the claim as unproven.");
    assert.equal(summary.evidence.provider!.retentionDisclosure, CAMPAIGN_EVIDENCE_RETENTION_DISCLOSURE);
    assert.equal(summary.evidence.destination.configurationId, `session_artifacts:${f.human.organizationId}`);
    assert.equal(summary.evidence.envelope, false, "no peer declares the private media contract");
    assert.deepEqual(summary.humanRequired, [], "no rule is marked Human Required, so nothing comes to the Human");
    assert.match(summary.declinedNote!, /declined automatically and shown as blocked work/u);
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
      // Extra review rounds are never part of Full Control's own authority (#3369).
      assert.equal(campaignWorkflowOwner(control, root.parentControlPolicy!.decisions, category, true),
        category === "review_round_extension" ? "human" : "orchestrator", category);
    }
    const projection = f.db.campaignProjection(root.id)!;
    for (const category of WORKFLOW_DECISION_CATEGORIES) {
      assert.equal(projection.decisionOwners[category], category === "review_round_extension" ? "human" : "orchestrator", category);
    }
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

test("each genuine impossibility blocks launch with a specific reason and creates nothing", async () => {
  const cases: Array<{ name: string; options?: Parameters<typeof fixture>[0]; body?: FullControlLaunchRequest; id: string; reason: RegExp }> = [
    // The launch sets an explicit cost ceiling, which cannot be enforced on unpriced usage.
    { name: "unpriced model under a cost ceiling", options: { priced: false }, id: "accounting_budget", reason: /unpriced/ },
    // Checkpoints are amounts within a cost ceiling; without one they are refused, never dropped.
    { name: "cost checkpoints without a cost limit", body: { ...launch, overrides: { session: launch.overrides!.session, budget: { toolCalls: 400, checkpointsUsd: [5] } } },
      id: "accounting_budget", reason: /^Cost checkpoints need a cost limit; enter one or remove the checkpoints\.$/ },
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
});

test("infrastructure gaps never block launch: each is informational and the campaign uses the regular review workflow", async () => {
  const unbudgeted: FullControlLaunchRequest = { ...launch, overrides: { session: launch.overrides!.session } };
  const cases: Array<{ name: string; options?: Parameters<typeof fixture>[0]; body?: FullControlLaunchRequest; daily?: boolean; id: string; reason: RegExp }> = [
    { name: "no controlled reviewer", options: { runtime: { ...runtime, campaignReview: undefined } }, id: "native_review",
      reason: /does not offer the controlled reviewer, which needs provider isolation \(current: provider\).*2\.1\.296.*regular cross-model review workflow\.$/ },
    { name: "no isolation report", options: { runtime: { ...runtime, executionIsolation: undefined } }, id: "execution_isolation", reason: /does not report the execution isolation/ },
    { name: "root session ceiling", body: { ...launch, overrides: { ...launch.overrides, session: { ...launch.overrides!.session,
      config: { model: "claude-opus-5-5", permissionMode: "orchestrator", costBudgetUsd: 50, maxToolCalls: 500 } } } },
      id: "native_review", reason: /root session's own cost or tool-call limit; the campaign uses the regular cross-model review workflow\./ },
    { name: "organization daily limit", daily: true, id: "native_review", reason: /per-user daily limit; the campaign uses the regular/ },
    { name: "unpriced model with no ceiling", options: { priced: false }, body: unbudgeted, id: "accounting_budget", reason: /^No limit\. Managed workers' tool calls are counted, but this model's cost is not priced/ },
  ];
  for (const item of cases) {
    const f = fixture(item.options);
    if (item.daily) f.db.setUsageDailyBudget(f.human.organizationId, 5, Date.now());
    const { server } = await app(f);
    try {
      const body = item.body ?? launch;
      const { response, preflight: checked } = await preflight(server, body);
      assert.equal(response.statusCode, 200, `${item.name}: ${response.body}`);
      assert.equal(checked!.ready, true, `${item.name}: ${JSON.stringify(checked!.summary.blockers)}`);
      assert.deepEqual(checked!.summary.blockers, [], item.name);
      const capability = checked!.capabilities.find((entry) => entry.id === item.id)!;
      assert.equal(capability.state, "informational", item.name);
      assert.equal(capability.mandatory, false, item.name);
      assert.match(capability.reason, item.reason, item.name);
      const admitted = await server.inject({ method: "POST", url: "/api/full-control-campaigns", headers: { authorization: "Bearer human" },
        payload: { ...body, requestId: "launch-1", preflightDigest: checked!.digest } });
      assert.equal(admitted.statusCode, 201, `${item.name}: ${admitted.body}`);
      const control = f.db.getSession(admitted.json().id)!.orchestratorPolicy!.control!;
      if (control.mode !== "full_control") throw new Error("Full Control expected");
      if (item.id === "native_review") {
        assert.equal(checked!.summary.review.controlled, false, item.name);
        assert.equal(checked!.summary.review.statement, "The regular cross-model review workflow, because controlled review is unavailable.");
        assert.equal(checked!.summary.budget.reviewIncluded, false, item.name);
        assert.equal(checked!.advanced.controlledReview, undefined, item.name);
        assert.equal(control.boundary.budgetAuthority!.controlledReview, undefined, `${item.name}: no unusable reviewer enters the boundary`);
      }
      if (item.id === "accounting_budget") {
        // What the summary promised holds at runtime: unpriced usage counts tool calls and never stops the campaign.
        const rootId = admitted.json().id as string;
        f.sessions.onSessionEvent(rootId, { kind: "token_usage", inputTokens: 100, outputTokens: 2, model: "claude-opus-5-5" });
        f.sessions.onSessionEvent(rootId, { kind: "tool_call", toolCallId: "read", title: "Read", status: "completed" });
        const view = f.db.campaignBudgets.view(rootId)!;
        assert.deepEqual([view.state, view.costAccounting, view.actual.toolCalls], ["active", "unavailable", 1]);
        assert.notEqual(f.db.getSession(rootId)!.status, "stopped");
      }
      assert.equal(f.starts.length, 1, item.name);
    } finally { await server.close(); f.db.close(); }
  }
});

test("with no budget the campaign launches unbounded, metered, and still charges controlled review per job", async () => {
  const f = fixture();
  const { server } = await app(f);
  try {
    const body: FullControlLaunchRequest = { ...launch, overrides: { session: launch.overrides!.session } };
    const { preflight: checked } = await preflight(server, body);
    assert.equal(checked!.ready, true, JSON.stringify(checked!.summary.blockers));
    assert.deepEqual(checked!.summary.budget, { costUsd: null, toolCalls: null, concurrency: 4, acceptedFollowUps: 2, source: "unset", reviewIncluded: true });
    const accounting = checked!.capabilities.find((item) => item.id === "accounting_budget")!;
    assert.deepEqual([accounting.state, accounting.mandatory], ["verified", false]);
    assert.equal(accounting.reason, "No limit. Managed workers are metered and priced, and Campaign Status shows the campaign's usage.");
    assert.deepEqual(checked!.summary.blockers, []);
    const admitted = await server.inject({ method: "POST", url: "/api/full-control-campaigns", headers: { authorization: "Bearer human" },
      payload: { ...body, requestId: "unbounded", preflightDigest: checked!.digest } });
    assert.equal(admitted.statusCode, 201, admitted.body);
    const root = f.db.getSession(admitted.json().id)!;
    const control = root.orchestratorPolicy!.control!;
    if (control.mode !== "full_control") throw new Error("Full Control expected");
    // No ceiling is absent, never a fake large amount.
    assert.equal("costUsd" in control.boundary.budgetAuthority!, false);
    assert.equal("toolCalls" in control.boundary.budgetAuthority!, false);
    assert.deepEqual(control.boundary.budgetAuthority!.controlledReview, review);
    const view = f.db.campaignBudgets.view(root.id)!;
    assert.equal(view.state, "active");
    assert.deepEqual(view.remaining, { costUsd: null, toolCalls: null });
    assert.deepEqual(f.db.campaignBudgets.allocation(root.id), { sessionId: root.id }, "the root holds no allocation ceiling");
    assert.equal(root.costBudgetUsd ?? null, null);
    assert.equal(root.maxToolCalls ?? null, null);
    assert.equal(f.db.campaignProjection(root.id)!.budget!.requiredNativeReview!.supported, true);
    assert.equal(f.starts.length, 1);
  } finally { await server.close(); f.db.close(); }
});

test("an explicit ceiling, even on one amount, is the enforced campaign envelope", async () => {
  const f = fixture();
  const { server } = await app(f);
  try {
    const body: FullControlLaunchRequest = { ...launch, overrides: { session: launch.overrides!.session, budget: { costUsd: 15 } } };
    const { preflight: checked } = await preflight(server, body);
    assert.equal(checked!.ready, true, JSON.stringify(checked!.summary.blockers));
    assert.deepEqual([checked!.summary.budget.costUsd, checked!.summary.budget.toolCalls, checked!.summary.budget.source], [15, null, "override"]);
    const accounting = checked!.capabilities.find((item) => item.id === "accounting_budget")!;
    assert.deepEqual([accounting.state, accounting.mandatory], ["verified", true]);
    assert.equal(accounting.reason, "Managed workers are metered and priced; the campaign is limited to $15.");
    const admitted = await server.inject({ method: "POST", url: "/api/full-control-campaigns", headers: { authorization: "Bearer human" },
      payload: { ...body, requestId: "cost-only", preflightDigest: checked!.digest } });
    assert.equal(admitted.statusCode, 201, admitted.body);
    const root = f.db.getSession(admitted.json().id)!;
    const control = root.orchestratorPolicy!.control!;
    if (control.mode !== "full_control") throw new Error("Full Control expected");
    assert.equal(control.boundary.budgetAuthority!.costUsd, 15);
    assert.equal("toolCalls" in control.boundary.budgetAuthority!, false);
    const view = f.db.campaignBudgets.view(root.id)!;
    assert.equal(view.remaining.toolCalls, null);
    assert.ok(view.remaining.costUsd !== null && view.remaining.costUsd <= 15);
    const allocation = f.db.campaignBudgets.allocation(root.id)!;
    assert.ok(allocation.costUsd !== undefined && allocation.costUsd <= 15, "the root's allocation is bounded by the ceiling");
    assert.equal(root.costBudgetUsd, allocation.costUsd);
  } finally { await server.close(); f.db.close(); }
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
      { runnerId: "r" }, { ...launch, requestId: "x" }]) {
      assert.equal((await preflight(server, payload as FullControlLaunchRequest)).response.statusCode, 400, JSON.stringify(payload));
    }
    assert.equal(sessionCount(f), 0);
    assert.deepEqual(f.starts, []);
  } finally { await server.close(); f.db.close(); }
});

test("screenshots stay with the Orchestrator when its model cannot review images, which then asks or denies, and the launch stays allowed", async () => {
  const f = fixture({ images: false });
  const { server } = await app(f);
  try {
    const { preflight: checked } = await preflight(server, launch);
    assert.equal(checked!.ready, true);
    const image = checked!.capabilities.find((item) => item.id === "image_evidence")!;
    assert.equal(image.state, "orchestrator_decides");
    assert.match(image.reason, /It asks for inspectable evidence or denies the claim as unproven\.$/u);
    assert.equal(image.mandatory, false);
    assert.equal(checked!.summary.evidence.provider, null, "no image bytes are disclosed to a provider that cannot view them");
    assert.equal(checked!.summary.evidence.statement,
      "The Orchestrator decides UI evidence but can't view images, so it asks for inspectable evidence or denies the claim as unproven.");
    assert.deepEqual(checked!.summary.humanRequired, []);
  } finally { await server.close(); f.db.close(); }
});

test("an authorization that leaves UI Evidence Approval out keeps all evidence with the Human", async () => {
  const f = fixture();
  const { server } = await app(f);
  try {
    const { preflight: checked } = await preflight(server, { ...launch, overrides: { ...launch.overrides, operations: ["implementation_question", "pr_merge"] } });
    assert.deepEqual(checked!.capabilities.filter((item) => item.state === "human_required").map((item) => item.id),
      ["image_evidence", "video_evidence", "external_evidence"]);
    assert.equal(checked!.summary.evidence.statement, "Screenshots, video and external evidence need your review.");
    assert.deepEqual(checked!.summary.humanRequired.map((item) => item.exception),
      ["Screenshot Evidence Review", "Video Evidence Review", "External Evidence Review"]);
  } finally { await server.close(); f.db.close(); }
});

test("only a rule a person marked Human Required is listed, and only while one is enabled", async () => {
  const f = fixture();
  const { server } = await app(f);
  try {
    assert.deepEqual((await preflight(server, launch)).preflight!.summary.humanRequired, []);
    const rule = { policyId: "mine", name: "Mine", effect: "ask" as const, priority: 1, enabled: true, scope: { toolName: "Bash" },
      conditions: { humanRequired: true } };
    f.db.upsertGovernancePolicy(rule, Date.now());
    assert.deepEqual((await preflight(server, launch)).preflight!.summary.humanRequired.map((item) => item.exception), ["Human Required Governance Rules"]);
    f.db.upsertGovernancePolicy({ ...rule, enabled: false }, Date.now());
    assert.deepEqual((await preflight(server, launch)).preflight!.summary.humanRequired, []);
    f.db.upsertGovernancePolicy({ ...rule, conditions: undefined }, Date.now());
    assert.deepEqual((await preflight(server, launch)).preflight!.summary.humanRequired, [], "an ordinary ask is the Orchestrator's");
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

test("the hosting video composition flips no launch capability: uncertified video stays an Orchestrator ask-or-deny even with a paced peer and a live proof", async () => {
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
    assert.equal(videoCapability.state, "orchestrator_decides");
    assert.equal(videoCapability.reason, "The Orchestrator can't watch video yet, so it asks for screenshots or denies the claim as unproven.");
    assert.ok(!checked.summary.humanRequired.some((item) => item.exception === "Video Evidence Review"));
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
    assert.equal(videoRow(detached).state, "orchestrator_decides");
    assert.equal(videoRow(detached).reason, "The Orchestrator can't watch video because Wollipog's video review service is not attached yet. It asks for screenshots or denies the claim as unproven.");
    assert.ok(!detached.summary.humanRequired.some((item) => item.exception === "Video Evidence Review"));

    video.attach(hosted.sessions, hosted.hub);
    const ready = (await preflight(hostedApp.server, launch)).preflight!;
    assert.equal(videoRow(ready).state, "verified", videoRow(ready).reason);
    assert.match(videoRow(ready).reason, /certified claude-code claude-opus-5-5 \(high effort\) media-only reviewer/u);
    assert.ok(videoRow(ready).reason.includes(new Date(proof.expiresAt).toISOString()));
    assert.ok(!ready.summary.humanRequired.some((item) => item.exception === "Video Evidence Review"));
    assert.equal(ready.summary.evidence.statement,
      "The Orchestrator reviews screenshots, and video through the certified media-only reviewer. For external evidence it asks for screenshots or denies the claim as unproven.");
    assert.equal(ready.summary.evidence.envelope, true);
    assert.equal(ready.ready, true);
    // Delegable video changes no other capability.
    assert.deepEqual(ready.capabilities.filter((item) => item.id !== "video_evidence"),
      expected.capabilities.filter((item) => item.id !== "video_evidence"));

    const sonnet = { ...launch, overrides: { ...launch.overrides, session: { ...launch.overrides!.session,
      config: { model: "claude-sonnet-5-5", permissionMode: "orchestrator" as const } } } };
    assert.equal(videoRow((await preflight(hostedApp.server, sonnet)).preflight!).reason,
      "The Orchestrator can't watch video because the evidence envelope would name claude-code claude-sonnet-5-5, not the certified claude-code claude-opus-5-5 reviewer. It asks for screenshots or denies the claim as unproven.");
    const humanEvidence = { ...launch, overrides: { ...launch.overrides, operations: ["implementation_question" as const, "pr_merge" as const] } };
    assert.equal(videoRow((await preflight(hostedApp.server, humanEvidence)).preflight!).reason,
      "Video evidence needs your review because UI evidence approval is not part of this campaign's authorization.");
    const unbudgeted = { ...launch, overrides: { ...launch.overrides, budget: undefined } };
    assert.equal(videoRow((await preflight(hostedApp.server, unbudgeted)).preflight!).state, "verified", "no limit never blocks the envelope");
    const blocked = { ...launch, overrides: { ...launch.overrides, delegatablePolicyIds: ["missing"] } };
    assert.equal(videoRow((await preflight(hostedApp.server, blocked)).preflight!).reason,
      "The Orchestrator can't watch video because the launch is blocked, so no evidence envelope is minted. It asks for screenshots or denies the claim as unproven.");
  } finally {
    await plainApp.server.close(); await hostedApp.server.close(); plain.db.close(); hosted.db.close();
  }
});

test("a revoked proof or a changed attestation returns launch video review to the uncertified Orchestrator path, never the Human", async () => {
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
    assert.equal(await videoState(), "orchestrator_decides");
  } finally {
    await plainApp.server.close(); await hostedApp.server.close(); plain.db.close(); hosted.db.close();
  }
});

test("Project child-session ceilings route review to the regular workflow, and a task alone launches with an empty issue scope", async () => {
  const f = fixture();
  const organizationScope = { organizationId: f.human.organizationId, owner: { kind: "organization" as const, organizationId: f.human.organizationId } };
  const project = f.db.createProject({ name: "Fixture", scope: organizationScope });
  const location = f.db.addProjectLocation(project.id, { runnerId: "r", workspaceId: "w" });
  f.db.updateProject(project.id, { childSessionDefaults: { costBudgetUsd: 5, maxToolCalls: 50 } });
  const { server } = await app(f);
  try {
    const body: FullControlLaunchRequest = { runnerId: "r", workspaceId: "w", projectId: project.id, task: "Investigate flaky tests",
      overrides: { session: { config: { model: "claude-opus-5-5", permissionMode: "orchestrator" } }, budget: { costUsd: 10, toolCalls: 100 } } };
    const regular = await preflight(server, body);
    assert.equal(regular.response.statusCode, 200, regular.response.body);
    assert.equal(regular.preflight!.ready, true, "Project defaults only change which review the campaign uses");
    const native = regular.preflight!.capabilities.find((item) => item.id === "native_review")!;
    assert.equal(native.state, "informational");
    assert.match(native.reason, /child-session defaults/);
    assert.equal(regular.preflight!.summary.budget.reviewIncluded, false);
    assert.equal(regular.preflight!.summary.budget.source, "override", "saved per-session limits never become the campaign envelope");

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
    assert.equal(unset.preflight!.ready, true, "no budget means no limit, never a launch blocker");
    assert.match(unset.preflight!.capabilities.find((item) => item.id === "accounting_budget")!.reason, /^No limit\./);
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
      assert.equal(f.db.campaignProjection(rootId)!.decisionOwners[category],
        category === "review_round_extension" ? "human" : "orchestrator", category);
    }
    const replay = await server.inject({ method: "POST", url, headers: { authorization: "Bearer human" },
      payload: { expectedRevision, preflightDigest: enablePreflight.digest } });
    assert.equal(replay.statusCode, 409, "an enabled revision cannot be replayed");
    const revoked = f.sessions.setCampaignControl(rootId, { mode: "custom" }, root.parentControlPolicy!.revision, f.human);
    assert.ok(revoked.ok, revoked.error ?? "Revoke stays the ordinary operation");
  } finally { await server.close(); f.db.close(); }
});

test("enabling an existing campaign is blocked only by another person's scope; participant ceilings and no budget are informational", async () => {
  const f = fixture();
  const { server } = await app(f);
  const check = async (id: string, payload: object = {}) => (await server.inject({ method: "POST",
    url: `/api/sessions/${id}/orchestrator-campaign/full-control/preflight`, headers: { authorization: "Bearer human" }, payload })).json().preflight as CampaignLaunchPreflight;
  try {
    const foreign = customCampaign(f, "foreign-root", "someone-else");
    const refused = await check(foreign, { overrides: { budget: savedBudget } });
    assert.equal(refused.ready, false);
    assert.equal(refused.capabilities.find((item) => item.id === "repository_scope")!.reason,
      "Only the person who established this campaign's issue scope can enable Full Control for it.");
    const rootId = customCampaign(f);
    const unbudgeted = await check(rootId);
    assert.equal(unbudgeted.ready, true, JSON.stringify(unbudgeted.summary.blockers));
    assert.equal(unbudgeted.summary.budget.source, "unset");
    assert.equal(unbudgeted.capabilities.find((item) => item.id === "native_review")!.state, "verified");
    f.db.createSession({ id: "limited-child", parentSessionId: rootId, runnerId: "r", workspaceId: "w", agentId: "claude", title: "child",
      useWorktree: false, creationActor: "agent", driver: "claude-code", config: { model: "claude-opus-5-5" }, now: 3 });
    f.db.updateSessionStatus("limited-child", "running", 4);
    f.db.updateSessionCostBudget("limited-child", 5, 4);
    const limited = await check(rootId, { overrides: { budget: savedBudget } });
    assert.equal(limited.ready, true, "a participant's own limit only routes review to the regular workflow");
    assert.equal(limited.capabilities.find((item) => item.id === "native_review")!.state, "informational");
    assert.match(limited.capabilities.find((item) => item.id === "native_review")!.reason, /limits some of this campaign's sessions already hold/);
    assert.equal(limited.summary.review.controlled, false);
    f.db.updateSessionStatus("limited-child", "completed", 5);
    assert.equal((await check(rootId, { overrides: { budget: savedBudget } })).summary.review.controlled, true,
      "a finished participant no longer holds the campaign to the regular workflow");
    // Enabling with no budget and a participant ceiling admits Full Control with no controlled reviewer.
    f.db.updateSessionStatus("limited-child", "running", 6);
    const { preflight: plain, expectedRevision } = (await server.inject({ method: "POST",
      url: `/api/sessions/${rootId}/orchestrator-campaign/full-control/preflight`, headers: { authorization: "Bearer human" }, payload: {} })).json() as
      { preflight: CampaignLaunchPreflight; expectedRevision: number };
    const enabled = await server.inject({ method: "POST", url: `/api/sessions/${rootId}/orchestrator-campaign/full-control`,
      headers: { authorization: "Bearer human" }, payload: { expectedRevision, preflightDigest: plain.digest } });
    assert.equal(enabled.statusCode, 200, enabled.body);
    const control = f.db.getSession(rootId)!.orchestratorPolicy!.control!;
    if (control.mode !== "full_control") throw new Error("Full Control expected");
    assert.equal(control.boundary.budgetAuthority!.controlledReview, undefined);
    assert.equal("costUsd" in control.boundary.budgetAuthority!, false);
    assert.equal((await server.inject({ method: "POST", url: `/api/sessions/${rootId}/orchestrator-campaign/full-control/preflight`,
      headers: { authorization: "Bearer human" }, payload: { overrides: { session: { agentId: "claude" } } } })).statusCode, 400,
      "an existing root's harness cannot be overridden");
  } finally { await server.close(); f.db.close(); }
});

/** A launch's first-message wait when every limit was derived (no Human override). */
const PENDING = { state: "pending", derivedLimits: { acceptedFollowUps: true, maxIssues: true } };

/** A launch with no task, as New Session sends it: the root starts idle like any Orchestrator. */
async function firstMessageLaunch(f: ReturnType<typeof fixture>, server: Awaited<ReturnType<typeof app>>["server"],
  limits: Pick<NonNullable<FullControlLaunchRequest["overrides"]>, "budget" | "issues"> = {}) {
  const body: FullControlLaunchRequest = { runnerId: "r", workspaceId: "w", overrides: { session: { agentId: "claude",
    config: { model: "claude-opus-5-5", permissionMode: "orchestrator" }, orchestrator: { behavior: { followUps: "execute_approved" } } }, ...limits } };
  const { preflight: checked } = await preflight(server, body);
  assert.equal(checked!.ready, true, JSON.stringify(checked!.summary.blockers));
  const admitted = await server.inject({ method: "POST", url: "/api/full-control-campaigns", headers: { authorization: "Bearer human" },
    payload: { ...body, requestId: `first-${sessionCount(f)}`, preflightDigest: checked!.digest } });
  assert.equal(admitted.statusCode, 201, admitted.body);
  const id = admitted.json().id as string;
  f.db.updateSessionStatus(id, "idle", Date.now());
  return { id, checked: checked! };
}

const boundaryOf = (f: ReturnType<typeof fixture>, id: string) => {
  const control = f.db.getSession(id)!.orchestratorPolicy!.control!;
  if (control.mode !== "full_control") throw new Error("Full Control expected");
  return control.boundary;
};

test("a Full Control launch with no task starts idle, and its owner's first message sets the objective and same-repository issues before the first turn", async () => {
  const f = fixture();
  const { server } = await app(f);
  try {
    const { id, checked } = await firstMessageLaunch(f, server);
    assert.equal(checked.summary.objective, FULL_CONTROL_FIRST_MESSAGE_OBJECTIVE);
    assert.deepEqual(checked.summary.issueNumbers, []);
    assert.equal(f.starts.length, 1);
    const start = f.starts[0] as Extract<ControlPlaneToRunner, { type: "start_session" }>;
    assert.equal(start.initialPrompt, undefined, "no turn starts before the person's first message");
    let root = f.db.getSession(id)!;
    assert.deepEqual(root.orchestratorPolicy!.firstMessageScope, PENDING);
    assert.deepEqual(root.orchestratorPolicy!.issueScope!.issueNumbers, []);
    assert.equal(boundaryOf(f, id).objective, FULL_CONTROL_FIRST_MESSAGE_OBJECTIVE);

    // Nothing an agent sends reaches the campaign, or sets its scope, before the owner's message.
    const agent = await f.sessions.promptOrSteer(id, "Orchestrate issues 12 and 7");
    assert.equal(agent.ok, false);
    assert.equal(agent.status, 409);
    assert.match(agent.error!, /owner's first message/u);
    assert.deepEqual(f.db.getSession(id)!.orchestratorPolicy!.firstMessageScope, PENDING);
    assert.equal(f.sent.filter((message) => message.type === "prompt_session").length, 0);

    f.issues.notIssues.add(3); // A pull request: GitHub does not read it as an issue.
    const text = "Ship #12 and owner/repo#7.\nAlso https://github.com/owner/repo/issues/9, but not other/repo#5,\n" +
      "https://github.com/owner/repo/pull/8 or https://github.com/other/repo/issues/6; #3 was the earlier pull request.";
    const before = f.sent.length;
    const result = await f.sessions.promptFromHuman(f.human, id, text);
    assert.equal(result.ok, true, result.error ?? "the first message was delivered");
    root = f.db.getSession(id)!;
    const policy = root.orchestratorPolicy!;
    assert.deepEqual(policy.issueScope, { repository: "owner/repo", issueNumbers: [7, 9, 12], revision: 2,
      authorizedByUserId: f.human.userId, authorizedAt: policy.issueScope!.authorizedAt });
    assert.deepEqual(policy.issueNumbers, [7, 9, 12]);
    assert.deepEqual(policy.firstMessageScope, { state: "established", messageDigest: firstMessageDigest(text),
      establishedAt: (policy.firstMessageScope as { establishedAt: number }).establishedAt });
    const boundary = boundaryOf(f, id);
    assert.equal(boundary.objective, firstMessageObjective(text));
    assert.doesNotMatch(boundary.objective, /\n/u);
    assert.equal(boundary.revision, 2);
    assert.equal(root.parentControlPolicy!.revision, 2);
    assert.equal(boundary.issueScopeRevision, 2);
    assert.equal(boundary.authorizedByUserId, f.human.userId);
    assert.deepEqual(boundary.issueAuthority!.epics, [7, 9, 12]);
    assert.equal(boundary.budgetAuthority!.acceptedFollowUps, 3);
    assert.ok(boundary.issueAuthority!.maxIssues >= 3 + boundary.budgetAuthority!.acceptedFollowUps);
    assert.equal(campaignBoundaryCurrent(root), true);
    assert.equal(f.db.campaignBudgets.view(id)!.state, "active");
    // The runner holds the new scope and boundary before the message reaches the Orchestrator.
    const after = f.sent.slice(before);
    const sync = after.findIndex((message) => message.type === "campaign_issue_scope" && message.operation === "synchronize");
    const prompt = after.findIndex((message) => message.type === "prompt_session");
    assert.ok(sync >= 0 && prompt > sync, after.map((message) => message.type).join(","));
    const synced = after[sync] as Extract<ControlPlaneToRunner, { type: "campaign_issue_scope"; operation: "synchronize" }>;
    assert.equal(synced.scope.revision, 2);
    assert.deepEqual(synced.control, policy.control);
    assert.equal((after[prompt] as Extract<ControlPlaneToRunner, { type: "prompt_session" }>).text, text);

    // Later messages, the owner's or an agent's, never change the scope the first one set.
    f.db.updateSessionStatus(id, "idle", Date.now());
    assert.equal((await f.sessions.promptFromHuman(f.human, id, "Also take #40.")).ok, true);
    f.db.updateSessionStatus(id, "idle", Date.now());
    assert.equal((await f.sessions.promptOrSteer(id, "Orchestrate issues 41 and 42")).ok, true);
    assert.deepEqual(f.db.getSession(id)!.orchestratorPolicy!.issueScope!.issueNumbers, [7, 9, 12]);
    assert.equal(boundaryOf(f, id).revision, 2);
  } finally { await server.close(); f.db.close(); }
});

test("only the launching person's text message establishes the boundary; no references keep it task-only; an undelivered one reopens the wait", async () => {
  const f = fixture();
  const { server } = await app(f);
  try {
    const { id } = await firstMessageLaunch(f, server);
    const other: HumanPrincipal = { ...f.human, userId: "someone-else", actorId: "someone-else" };
    assert.equal((await f.sessions.promptFromHuman(other, id, "Ship #12")).status, 403);
    assert.equal((await f.sessions.promptFromHuman(f.human, id, "", [], "compact")).status, 409, "a slash command is not the task");
    assert.deepEqual(f.db.getSession(id)!.orchestratorPolicy!.firstMessageScope, PENDING);

    // The runner drops the message: the boundary it set waits for the next first message.
    const send = f.hub.sendToRunner;
    f.hub.sendToRunner = (runnerId, message) => message.type === "prompt_session" ? false : send(runnerId, message);
    const dropped = await f.sessions.promptFromHuman(f.human, id, "Tidy the docs");
    assert.equal(dropped.ok, false);
    assert.deepEqual(f.db.getSession(id)!.orchestratorPolicy!.firstMessageScope, PENDING);
    f.hub.sendToRunner = send;
    f.db.updateSessionStatus(id, "idle", Date.now());

    // An unreadable origin verifies no reference, so the scope stays task-only.
    f.issues.repository = null;
    const text = "Tidy the README, as #12 asked.";
    assert.equal((await f.sessions.promptFromHuman(f.human, id, text)).ok, true);
    const root = f.db.getSession(id)!;
    assert.deepEqual(root.orchestratorPolicy!.issueScope!.issueNumbers, []);
    assert.equal(root.orchestratorPolicy!.issueScope!.revision, 3);
    assert.equal(boundaryOf(f, id).objective, text);
    assert.equal(boundaryOf(f, id).revision, 3);
    assert.equal(campaignBoundaryCurrent(root), true);
    assert.equal((root.orchestratorPolicy!.firstMessageScope as { messageDigest: string }).messageDigest, firstMessageDigest(text));
  } finally { await server.close(); f.db.close(); }
});

test("revoking a campaign that waits for its first message restores Custom: no message can set its scope", async () => {
  const f = fixture();
  const { server } = await app(f);
  try {
    const { id } = await firstMessageLaunch(f, server);
    const revoked = f.sessions.setCampaignControl(id, { mode: "custom" }, f.db.getSession(id)!.parentControlPolicy!.revision, f.human);
    assert.equal(revoked.ok, true, revoked.error ?? "Revoke succeeded");
    // Revoke stops the launch's allowance as it always has; the first-message wait no longer applies.
    for (const sent of [await f.sessions.promptOrSteer(id, "Orchestrate issues 12 and 7"),
      await f.sessions.promptFromHuman(f.human, id, "Orchestrate issues 12 and 7")]) {
      assert.equal(sent.ok, false);
      assert.match(sent.error!, /allowance was revoked/u);
    }
    assert.deepEqual(f.db.getSession(id)!.orchestratorPolicy!.issueScope!.issueNumbers, []);
    assert.equal(f.db.getSession(id)!.orchestratorPolicy!.control!.mode, "custom");
  } finally { await server.close(); f.db.close(); }
});

test("enabling Full Control on a campaign with no issue scope derives it from its repository and recorded request, or waits for a first message", async () => {
  const f = fixture();
  const { server } = await app(f);
  const enable = async (id: string) => {
    const checked = await server.inject({ method: "POST", url: `/api/sessions/${id}/orchestrator-campaign/full-control/preflight`,
      headers: { authorization: "Bearer human" }, payload: {} });
    assert.equal(checked.statusCode, 200, checked.body);
    const { preflight: reviewed, expectedRevision } = checked.json() as { preflight: CampaignLaunchPreflight; expectedRevision: number };
    assert.equal(reviewed.ready, true, JSON.stringify(reviewed.summary.blockers));
    const enabled = await server.inject({ method: "POST", url: `/api/sessions/${id}/orchestrator-campaign/full-control`,
      headers: { authorization: "Bearer human" }, payload: { expectedRevision, preflightDigest: reviewed.digest } });
    assert.equal(enabled.statusCode, 200, enabled.body);
    return reviewed;
  };
  const unscoped = (id: string) => {
    const policy = f.db.getSession(id)!.orchestratorPolicy!;
    delete policy.issueScope; delete policy.issueNumbers;
    f.db.raw().prepare("UPDATE sessions SET orchestrator_policy=? WHERE id=?").run(JSON.stringify(policy), id);
  };
  try {
    const messaged = customCampaign(f, "messaged-root");
    unscoped(messaged);
    // The owner's launch request recorded #12 and #44 (#44 is not an issue). The transcript records
    // no author, so its references (here #7, as an agent could have sent) are never scope.
    const recorded = f.db.getSession(messaged)!.orchestratorPolicy!;
    recorded.issueNumbers = [12, 44];
    recorded.issueNumbersSource = "human_launch_request";
    f.db.raw().prepare("UPDATE sessions SET orchestrator_policy=? WHERE id=?").run(JSON.stringify(recorded), messaged);
    f.db.appendEvent(messaged, { kind: "user_message", text: "Fix #7 in this repository." }, Date.now());
    f.issues.notIssues.add(44);
    const reviewed = await enable(messaged);
    assert.equal(reviewed.capabilities.find((item) => item.id === "repository_scope")!.reason,
      "This campaign's Human-established scope is owner/repo with issues #12.");
    let root = f.db.getSession(messaged)!;
    assert.deepEqual(root.orchestratorPolicy!.issueScope, { repository: "owner/repo", issueNumbers: [12], revision: 1,
      authorizedByUserId: f.human.userId, authorizedAt: root.orchestratorPolicy!.issueScope!.authorizedAt });
    assert.equal(boundaryOf(f, messaged).objective, "Deliver #12");
    assert.equal(root.orchestratorPolicy!.firstMessageScope, undefined);
    assert.equal(campaignBoundaryCurrent(root), true);

    const silent = customCampaign(f, "silent-root");
    unscoped(silent);
    await enable(silent);
    root = f.db.getSession(silent)!;
    assert.deepEqual(root.orchestratorPolicy!.firstMessageScope, PENDING);
    assert.deepEqual(root.orchestratorPolicy!.issueScope!.issueNumbers, []);
    assert.equal(boundaryOf(f, silent).objective, FULL_CONTROL_FIRST_MESSAGE_OBJECTIVE);
    f.db.updateSessionStatus(silent, "idle", Date.now());
    assert.equal((await f.sessions.promptFromHuman(f.human, silent, "Deliver #12 end to end")).ok, true);
    assert.deepEqual(f.db.getSession(silent)!.orchestratorPolicy!.issueScope!.issueNumbers, [12]);
    assert.equal(boundaryOf(f, silent).objective, "Deliver #12 end to end");

    // An unverifiable repository is the one thing that blocks, with the fix in its reason.
    const unverified = customCampaign(f, "unverified-root");
    unscoped(unverified);
    f.issues.repository = null;
    const blocked = (await server.inject({ method: "POST", url: `/api/sessions/${unverified}/orchestrator-campaign/full-control/preflight`,
      headers: { authorization: "Bearer human" }, payload: {} })).json().preflight as CampaignLaunchPreflight;
    assert.equal(blocked.ready, false);
    assert.match(blocked.summary.blockers[0]!.reason, /could not verify this campaign's repository/u);
  } finally { await server.close(); f.db.close(); }
});

test("Full Control never inherits Custom per-decision owners: with every toggle Human, launch and enable both give the Orchestrator all five", async () => {
  const f = fixture();
  const { server } = await app(f);
  const FIVE = ["implementation_question", "pr_merge", "merged_branch_deletion", "follow_up_issue_publication", "ui_evidence_approval"] as const;
  const humanToggles = Object.fromEntries(FIVE.map((category) => [category, "human" as const]));
  const assertOrchestratorOwnsFive = (id: string) => {
    const root = f.db.getSession(id)!;
    for (const category of FIVE) {
      assert.equal(root.parentControlPolicy!.decisions[category], "human", `${category}'s Custom toggle is Human`);
      assert.equal(f.db.campaignProjection(id)!.decisionOwners[category], "orchestrator", `${category} is the boundary's`);
    }
    const asked = f.sessions.createWorkflowDecision(id, { requestId: `q-${id}`, resourceKey: `q-${id}`, resourceSnapshot: {
      category: "implementation_question", question: "Which parser should the campaign use?",
      options: [{ optionId: "a", label: "The existing one" }, { optionId: "b", label: "A new one" }] } });
    assert.equal(asked.ok, true, asked.error ?? "the decision was requested");
    assert.equal(asked.data!.authority, "orchestrator");
  };
  try {
    // Launch: the session's Custom toggles say Human for every gate.
    const body: FullControlLaunchRequest = { runnerId: "r", workspaceId: "w", overrides: { session: { agentId: "claude",
      config: { model: "claude-opus-5-5", permissionMode: "orchestrator" },
      orchestrator: { delegation: { decisions: humanToggles } } } } };
    const { preflight: checked } = await preflight(server, body);
    assert.equal(checked!.ready, true, JSON.stringify(checked!.summary.blockers));
    const admitted = await server.inject({ method: "POST", url: "/api/full-control-campaigns", headers: { authorization: "Bearer human" },
      payload: { ...body, requestId: "human-toggles", preflightDigest: checked!.digest } });
    assert.equal(admitted.statusCode, 201, admitted.body);
    const launched = admitted.json().id as string;
    f.db.updateSessionStatus(launched, "idle", Date.now());
    assert.equal((await f.sessions.promptFromHuman(f.human, launched, "Deliver #12")).ok, true);
    assertOrchestratorOwnsFive(launched);

    // Enable: a Custom campaign whose saved owners are all Human.
    const custom = customCampaign(f, "human-toggle-root");
    const { preflight: reviewed, expectedRevision } = (await server.inject({ method: "POST",
      url: `/api/sessions/${custom}/orchestrator-campaign/full-control/preflight`, headers: { authorization: "Bearer human" }, payload: {} })).json() as
      { preflight: CampaignLaunchPreflight; expectedRevision: number };
    const enabled = await server.inject({ method: "POST", url: `/api/sessions/${custom}/orchestrator-campaign/full-control`,
      headers: { authorization: "Bearer human" }, payload: { expectedRevision, preflightDigest: reviewed.digest } });
    assert.equal(enabled.statusCode, 200, enabled.body);
    assertOrchestratorOwnsFive(custom);
  } finally { await server.close(); f.db.close(); }
});

test("explicit launch ceilings survive the first message: 0 follow-ups and 1 issue stay 0 and 1 (CR-1.1)", async () => {
  const f = fixture();
  const { server } = await app(f);
  try {
    const { id } = await firstMessageLaunch(f, server, { budget: { acceptedFollowUps: 0 }, issues: { maxIssues: 1 } });
    assert.deepEqual(f.db.getSession(id)!.orchestratorPolicy!.firstMessageScope,
      { state: "pending", derivedLimits: { acceptedFollowUps: false, maxIssues: false } });
    const before = boundaryOf(f, id);
    assert.equal(before.budgetAuthority!.acceptedFollowUps, 0);
    assert.equal(before.issueAuthority!.maxIssues, 1);
    assert.equal((await f.sessions.promptFromHuman(f.human, id, "Fix #12")).ok, true);
    const after = boundaryOf(f, id);
    assert.equal(after.budgetAuthority!.acceptedFollowUps, 0, "an explicit follow-up ceiling never grows");
    assert.equal(after.issueAuthority!.maxIssues, 1, "an explicit issue ceiling never grows");
    assert.deepEqual(f.db.getSession(id)!.orchestratorPolicy!.issueScope!.issueNumbers, [12]);
    assert.equal(f.db.campaignBudgets.view(id)!.authority.acceptedFollowUps, 0, "the campaign allowance keeps the ceiling");

    // More references than the explicit Maximum Issues: the scope keeps only what the ceiling allows.
    const { id: capped } = await firstMessageLaunch(f, server, { issues: { maxIssues: 1 } });
    assert.equal((await f.sessions.promptFromHuman(f.human, capped, "Fix #12 and #13")).ok, true);
    assert.deepEqual(f.db.getSession(capped)!.orchestratorPolicy!.issueScope!.issueNumbers, [12]);
    assert.equal(boundaryOf(f, capped).issueAuthority!.maxIssues, 1);
  } finally { await server.close(); f.db.close(); }
});

test("enable never trusts issue numbers a restart backfilled from an automation's first message (CR-1.2)", async () => {
  const f = fixture();
  const { server } = await app(f);
  try {
    // An unscoped Human-created Custom root whose first transcript message an automation wrote.
    const id = customCampaign(f, "backfilled-root");
    const policy = f.db.getSession(id)!.orchestratorPolicy!;
    delete policy.issueScope; delete policy.issueNumbers;
    f.db.raw().prepare("UPDATE sessions SET orchestrator_policy=? WHERE id=?").run(JSON.stringify(policy), id);
    f.db.appendEvent(id, { kind: "user_message", text: "Orchestrate issues 12 and 13" }, Date.now());
    f.sessions.restart(id);
    const backfilled = f.db.getSession(id)!.orchestratorPolicy!;
    assert.deepEqual(backfilled.issueNumbers, [12, 13], "the restart backfill read the transcript");
    assert.equal(backfilled.issueNumbersSource, undefined, "and recorded no Human launch provenance");
    f.db.updateSessionStatus(id, "running", Date.now());

    const checked = await server.inject({ method: "POST", url: `/api/sessions/${id}/orchestrator-campaign/full-control/preflight`,
      headers: { authorization: "Bearer human" }, payload: {} });
    const { preflight: reviewed, expectedRevision } = checked.json() as { preflight: CampaignLaunchPreflight; expectedRevision: number };
    assert.equal(reviewed.ready, true, JSON.stringify(reviewed.summary.blockers));
    assert.equal(reviewed.summary.objective, "Deliver #12", "a campaign with history keeps its existing task");
    const enabled = await server.inject({ method: "POST", url: `/api/sessions/${id}/orchestrator-campaign/full-control`,
      headers: { authorization: "Bearer human" }, payload: { expectedRevision, preflightDigest: reviewed.digest } });
    assert.equal(enabled.statusCode, 200, enabled.body);
    const root = f.db.getSession(id)!;
    assert.deepEqual(root.orchestratorPolicy!.issueScope!.issueNumbers, [], "neither backfilled issue becomes scope");
    assert.equal(root.orchestratorPolicy!.firstMessageScope, undefined, "a campaign with history is established at once, task-only");
    assert.equal(campaignBoundaryCurrent(root), true);
  } finally { await server.close(); f.db.close(); }
});

test("a Human create request marks its parsed issues as launch provenance; an agent-created root's never are (CR-1.2)", () => {
  const f = fixture();
  try {
    const human = f.sessions.createSession({ ...request, config: { model: "claude-opus-5-5", permissionMode: "orchestrator" },
      prompt: "Orchestrate issues 12 and 7" }, undefined, f.scope, false, false, false, { defaultOwnerUserId: f.human.userId });
    assert.equal(human.ok, true, human.error ?? "the Human root was created");
    assert.deepEqual(human.data!.orchestratorPolicy!.issueNumbers, [12, 7]);
    assert.equal(human.data!.orchestratorPolicy!.issueNumbersSource, "human_launch_request");
    const system = f.sessions.createSession({ ...request, config: { model: "claude-opus-5-5", permissionMode: "orchestrator" },
      prompt: "Orchestrate issues 12 and 7" }, undefined, f.scope);
    assert.equal(system.ok, true, system.error ?? "the system root was created");
    assert.equal(system.data!.orchestratorPolicy!.issueNumbersSource, undefined);
  } finally { f.db.close(); }
});

test("provider commands and direct steering wait for the owner's first message, including while it is being delivered (CR-1.3)", async () => {
  const f = fixture();
  const { server } = await app(f);
  try {
    const { id } = await firstMessageLaunch(f, server);
    const command = { submissionId: "cmd-1", providerCommandId: "claude:review", catalogRevision: "rev-1", argumentText: "the repo" };
    const refused = (result: { ok: boolean; status?: number; error?: string }) => {
      assert.equal(result.ok, false);
      assert.equal(result.status, 409);
      assert.match(result.error!, /owner's first message/u);
    };
    const sentBefore = f.sent.length;
    refused(f.sessions.invokeSessionCommand(id, command));
    refused(await f.sessions.steer(id, { submissionId: "steer-1", turnId: "turn-1", text: "Do this instead" }));
    assert.equal(f.sent.length, sentBefore, "nothing reaches the runner");
    assert.equal(f.db.getSessionCommandInvocationBySubmission(id, "cmd-1"), null, "and nothing is staged");

    // While the first message is being delivered (its runner synchronization held), the fence stays.
    let release: () => void = () => undefined;
    f.issues.holdSync = new Promise<void>((resolve) => { release = resolve; });
    const delivering = f.sessions.promptFromHuman(f.human, id, "Ship #12");
    await new Promise((resolve) => setTimeout(resolve, 20));
    assert.equal(f.db.getSession(id)!.orchestratorPolicy!.firstMessageScope!.state, "delivering");
    refused(f.sessions.invokeSessionCommand(id, { ...command, submissionId: "cmd-2" }));
    refused(await f.sessions.promptOrSteer(id, "Orchestrate issues 40 and 41"));
    release();
    assert.equal((await delivering).ok, true);
    assert.equal(f.db.getSession(id)!.orchestratorPolicy!.firstMessageScope!.state, "established");
  } finally { await server.close(); f.db.close(); }
});

test("a control-plane restart mid-delivery keeps the owner-only fence and never resends the first message (CR-1.4)", async () => {
  const f = fixture();
  const { server } = await app(f);
  try {
    const { id } = await firstMessageLaunch(f, server);
    let release: () => void = () => undefined;
    f.issues.holdSync = new Promise<void>((resolve) => { release = resolve; });
    const text = "Ship #12 end to end";
    void f.sessions.promptFromHuman(f.human, id, text);
    await new Promise((resolve) => setTimeout(resolve, 20));
    const delivering = f.db.getSession(id)!.orchestratorPolicy!.firstMessageScope!;
    assert.deepEqual(delivering, { state: "delivering", messageDigest: firstMessageDigest(text),
      after: (delivering as { after: { eventSeq: number; promptRowid: number } }).after,
      derivedLimits: { acceptedFollowUps: true, maxIssues: true } }, "the wait is durably fenced before delivery");

    // The process dies here: nothing it still holds may deliver, and a new one starts on the same database.
    const send = f.hub.sendToRunner;
    f.hub.sendToRunner = (runnerId, message) => message.type === "prompt_session" ? false : send(runnerId, message);
    const restarted = new SessionsService(f.db, f.hub, { info() {}, warn() {}, error() {} });
    const recovered = f.db.getSession(id)!.orchestratorPolicy!;
    assert.deepEqual(recovered.firstMessageScope, PENDING, "an unrecorded message reopens the wait, still fenced");
    f.hub.sendToRunner = send;
    const automation = await restarted.promptOrSteer(id, "Orchestrate issues 40 and 41");
    assert.equal(automation.status, 409, "an automation prompt is still refused after the restart");
    assert.equal(f.sent.filter((message) => message.type === "prompt_session").length, 0, "the first message was never resent");
    f.hub.sendToRunner = (runnerId, message) => message.type === "prompt_session" ? false : send(runnerId, message);
    release();
    await new Promise((resolve) => setTimeout(resolve, 20));
    assert.deepEqual(f.db.getSession(id)!.orchestratorPolicy!.firstMessageScope, PENDING, "the dead process cannot settle it");
    f.hub.sendToRunner = send;
    f.issues.holdSync = null;
    f.db.updateSessionStatus(id, "idle", Date.now());
    assert.equal((await restarted.promptFromHuman(f.human, id, text)).ok, true, "the owner sends it again");
    assert.equal(f.db.getSession(id)!.orchestratorPolicy!.firstMessageScope!.state, "established");
    assert.equal(f.sent.filter((message) => message.type === "prompt_session").length, 1, "delivered exactly once");

    // A message the old process did deliver (recorded before the crash) is recognized, not resent.
    const { id: recorded } = await firstMessageLaunch(f, server);
    f.issues.holdSync = new Promise<void>((resolve) => { release = resolve; });
    void f.sessions.promptFromHuman(f.human, recorded, "Fix #12");
    await new Promise((resolve) => setTimeout(resolve, 20));
    f.db.appendEvent(recorded, { kind: "user_message", text: "Fix #12" }, Date.now());
    f.hub.sendToRunner = (runnerId, message) => message.type === "prompt_session" ? false : send(runnerId, message);
    new SessionsService(f.db, f.hub, { info() {}, warn() {}, error() {} });
    assert.equal(f.db.getSession(recorded)!.orchestratorPolicy!.firstMessageScope!.state, "established");
    release();
    await new Promise((resolve) => setTimeout(resolve, 20));
    f.hub.sendToRunner = send;
  } finally { await server.close(); f.db.close(); }
});

/** Retained durable work, staged exactly as the service queues a prompt. */
const outboxOf = (f: ReturnType<typeof fixture>) => (f.sessions as unknown as { promptOutbox: SessionPromptOutbox }).promptOutbox;
const durableSends = (f: ReturnType<typeof fixture>, sessionId: string) => f.sent.filter((message) =>
  message.type === "durable_session_command" && message.command.type === "prompt_session" && message.command.sessionId === sessionId).length;

test("reauthorizing a waiting campaign stores that request's own ceilings: 0 follow-ups and 1 issue hold for the first message (CR-2.1)", async () => {
  const f = fixture();
  const { server } = await app(f);
  try {
    const { id } = await firstMessageLaunch(f, server);
    assert.deepEqual(f.db.getSession(id)!.orchestratorPolicy!.firstMessageScope, PENDING);
    const overrides = { budget: { acceptedFollowUps: 0 }, issues: { maxIssues: 1 } };
    const checked = await server.inject({ method: "POST", url: `/api/sessions/${id}/orchestrator-campaign/full-control/preflight`,
      headers: { authorization: "Bearer human" }, payload: { overrides } });
    const { preflight: reviewed, expectedRevision } = checked.json() as { preflight: CampaignLaunchPreflight; expectedRevision: number };
    assert.equal(reviewed.ready, true, JSON.stringify(reviewed.summary.blockers));
    const reauthorized = await server.inject({ method: "POST", url: `/api/sessions/${id}/orchestrator-campaign/full-control`,
      headers: { authorization: "Bearer human" }, payload: { overrides, expectedRevision, preflightDigest: reviewed.digest } });
    assert.equal(reauthorized.statusCode, 200, reauthorized.body);
    assert.deepEqual(f.db.getSession(id)!.orchestratorPolicy!.firstMessageScope,
      { state: "pending", derivedLimits: { acceptedFollowUps: false, maxIssues: false } }, "the newer authorization's provenance replaces the launch's");
    f.db.updateSessionStatus(id, "idle", Date.now());
    assert.equal((await f.sessions.promptFromHuman(f.human, id, "Fix #12 and #13")).ok, true);
    assert.deepEqual(f.db.getSession(id)!.orchestratorPolicy!.issueScope!.issueNumbers, [12], "at most the explicit one issue");
    const boundary = boundaryOf(f, id);
    assert.equal(boundary.budgetAuthority!.acceptedFollowUps, 0);
    assert.equal(boundary.issueAuthority!.maxIssues, 1);
    assert.equal(f.db.campaignBudgets.view(id)!.authority.acceptedFollowUps, 0, "and the campaign allowance keeps them");
  } finally { await server.close(); f.db.close(); }
});

test("enabling a campaign with history establishes its scope at once: no wait, retained work runs, automation text is never scope (CR-2.3)", async () => {
  const f = fixture();
  const { server } = await app(f);
  try {
    const id = customCampaign(f, "history-root");
    const policy = f.db.getSession(id)!.orchestratorPolicy!;
    delete policy.issueScope; delete policy.issueNumbers;
    f.db.raw().prepare("UPDATE sessions SET orchestrator_policy=? WHERE id=?").run(JSON.stringify(policy), id);
    f.db.appendEvent(id, { kind: "user_message", text: "Orchestrate issues 12 and 13" }, Date.now());
    // Retained work an automation queued: it waits on the busy root until the queue next flushes.
    f.db.updateSessionStatus(id, "idle", Date.now());
    outboxOf(f).stage(id, "r", { type: "prompt_session", sessionId: id, text: "Automation: also take #14" }, Date.now() + 60_000);
    const checked = await server.inject({ method: "POST", url: `/api/sessions/${id}/orchestrator-campaign/full-control/preflight`,
      headers: { authorization: "Bearer human" }, payload: {} });
    const { preflight: reviewed, expectedRevision } = checked.json() as { preflight: CampaignLaunchPreflight; expectedRevision: number };
    assert.equal(reviewed.ready, true, JSON.stringify(reviewed.summary.blockers));
    assert.equal(reviewed.summary.objective, "Deliver #12", "the campaign's existing task is the objective");
    const enabled = await server.inject({ method: "POST", url: `/api/sessions/${id}/orchestrator-campaign/full-control`,
      headers: { authorization: "Bearer human" }, payload: { expectedRevision, preflightDigest: reviewed.digest } });
    assert.equal(enabled.statusCode, 200, enabled.body);
    const root = f.db.getSession(id)!;
    assert.equal(root.orchestratorPolicy!.firstMessageScope, undefined, "a campaign with history never waits");
    assert.deepEqual(root.orchestratorPolicy!.issueScope!.issueNumbers, [], "task-only: no transcript or queued text is scope");
    assert.equal(boundaryOf(f, id).objective, "Deliver #12");
    assert.equal(campaignBoundaryCurrent(root), true);
    f.sessions.retryDuePrompts(Date.now() + 120_000);
    assert.equal(durableSends(f, id), 1, "the retained work runs under the established boundary");
    assert.equal((await f.sessions.promptOrSteer(id, "Orchestrate issues 12 and 13")).ok, true);
    assert.deepEqual(f.db.getSession(id)!.orchestratorPolicy!.issueScope!.issueNumbers, []);
  } finally { await server.close(); f.db.close(); }
});

test("retained queued work never runs on a fresh root before its first owner message, and runs once it is established (CR-2.3)", async () => {
  const f = fixture();
  const { server } = await app(f);
  try {
    const { id } = await firstMessageLaunch(f, server);
    outboxOf(f).stage(id, "r", { type: "prompt_session", sessionId: id, text: "Retained: take #14" });
    f.sessions.retryDuePrompts(Date.now());
    outboxOf(f).flush(Date.now());
    assert.equal(durableSends(f, id), 0, "the outbox holds it while the root waits");
    const retried = f.sessions.retryPendingPrompt(id, "prompt_missing");
    assert.equal(retried.status, 409);
    assert.match(retried.error!, /owner's first message/u);

    let release: () => void = () => undefined;
    f.issues.holdSync = new Promise<void>((resolve) => { release = resolve; });
    const delivering = f.sessions.promptFromHuman(f.human, id, "Ship #12");
    await new Promise((resolve) => setTimeout(resolve, 20));
    f.sessions.retryDuePrompts(Date.now() + 60_000);
    assert.equal(durableSends(f, id), 0, "and while it delivers");
    release();
    assert.equal((await delivering).ok, true);
    assert.equal(f.db.getSession(id)!.orchestratorPolicy!.firstMessageScope!.state, "established");
    f.sessions.retryDuePrompts(Date.now() + 120_000);
    assert.equal(durableSends(f, id), 1, "after the first message the retained work runs");
    assert.deepEqual(f.db.getSession(id)!.orchestratorPolicy!.issueScope!.issueNumbers, [12], "and never becomes scope");
  } finally { await server.close(); f.db.close(); }
});

test("recovery settles only on this delivery, never on identical earlier text (CR-2.2)", async () => {
  const f = fixture();
  const { server } = await app(f);
  try {
    const { id } = await firstMessageLaunch(f, server);
    const text = "Fix #12";
    // Identical text recorded and queued before the delivery begins is history, not this delivery.
    f.db.appendEvent(id, { kind: "user_message", text }, Date.now());
    outboxOf(f).stage(id, "r", { type: "prompt_session", sessionId: id, text });
    let release: () => void = () => undefined;
    f.issues.holdSync = new Promise<void>((resolve) => { release = resolve; });
    void f.sessions.promptFromHuman(f.human, id, text);
    await new Promise((resolve) => setTimeout(resolve, 20));
    const first = f.db.getSession(id)!.orchestratorPolicy!.firstMessageScope!;
    assert.equal(first.state, "delivering");
    const send = f.hub.sendToRunner;
    f.hub.sendToRunner = (runnerId, message) => message.type === "prompt_session" ? false : send(runnerId, message);
    new SessionsService(f.db, f.hub, { info() {}, warn() {}, error() {} });
    assert.deepEqual(f.db.getSession(id)!.orchestratorPolicy!.firstMessageScope, PENDING, "earlier identical text does not settle it");
    release();
    await new Promise((resolve) => setTimeout(resolve, 20));
    f.hub.sendToRunner = send;
  } finally { await server.close(); f.db.close(); }
});

test("reauthorizing a waiting root never ends its wait, even with retained queued work (security review)", async () => {
  const f = fixture();
  const { server } = await app(f);
  try {
    const { id } = await firstMessageLaunch(f, server);
    // Retained work that is not the owner's, queued for the waiting root.
    outboxOf(f).stage(id, "r", { type: "prompt_session", sessionId: id, text: "Automation: take #14" });
    const checked = await server.inject({ method: "POST", url: `/api/sessions/${id}/orchestrator-campaign/full-control/preflight`,
      headers: { authorization: "Bearer human" }, payload: {} });
    const { preflight: reviewed, expectedRevision } = checked.json() as { preflight: CampaignLaunchPreflight; expectedRevision: number };
    const reauthorized = await server.inject({ method: "POST", url: `/api/sessions/${id}/orchestrator-campaign/full-control`,
      headers: { authorization: "Bearer human" }, payload: { expectedRevision, preflightDigest: reviewed.digest } });
    assert.equal(reauthorized.statusCode, 200, reauthorized.body);
    assert.deepEqual(f.db.getSession(id)!.orchestratorPolicy!.firstMessageScope, PENDING, "the fence stays");
    f.sessions.retryDuePrompts(Date.now() + 60_000);
    assert.equal(durableSends(f, id), 0, "and the retained work stays held");
    assert.equal((await f.sessions.promptOrSteer(id, "Orchestrate issues 14 and 15")).status, 409);
    f.db.updateSessionStatus(id, "idle", Date.now());
    assert.equal((await f.sessions.promptFromHuman(f.human, id, "Fix #12")).ok, true);
    assert.deepEqual(f.db.getSession(id)!.orchestratorPolicy!.issueScope!.issueNumbers, [12], "only the owner's message sets scope");
  } finally { await server.close(); f.db.close(); }
});
