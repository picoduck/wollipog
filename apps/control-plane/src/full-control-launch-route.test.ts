import assert from "node:assert/strict";
import { test } from "node:test";
import Fastify from "fastify";
import {
  CAMPAIGN_EVIDENCE_RETENTION_DISCLOSURE, CONTROLLED_REVIEW_PROFILE, PROTOCOL_VERSION, WORKFLOW_DECISION_CATEGORIES,
  campaignWorkflowOwner,
  type CampaignLaunchInspectionResult, type CampaignLaunchPreflight, type CampaignLaunchProposal, type ControlledReviewCapability,
  type ControlPlaneToRunner, type CreateSessionRequest, type FullControlLaunchRequest, type RunnerMetadata, type RunnerRuntimeInfo,
} from "@wollipog/protocol";
import { ControlPlaneDb } from "./db.js";
import { Hub } from "./hub.js";
import { SessionsService } from "./sessions.js";
import { OrchestratorSettings } from "./orchestrator-settings.js";
import { authorizeFullControl } from "./campaign-authority.js";
import { hostingEvidenceAuthorityDisclosures } from "./hosting-evidence-disclosures.js";
import type { AuthPrincipal, HumanPrincipal } from "./identity.js";
import { inspectCampaignWorkspace, registerFullControlLaunchRoutes } from "./full-control-launch-route.js";

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

function fixture(options: { runtime?: RunnerRuntimeInfo; protocolVersion?: number; priced?: boolean; images?: boolean; pacedVideo?: boolean } = {}) {
  const db = ControlPlaneDb.open(":memory:");
  const identity = db.localIdentityContext();
  const human: HumanPrincipal = { ...identity, kind: "human", actorId: identity.userId };
  const meta: RunnerMetadata = { runnerId: "r", hostname: "fixture", os: "linux", version: "test",
    workspaces: [{ id: "w", name: "Fixture Repo", path: "/fixture/repository" }],
    agents: [{ id: "claude", name: "Claude", command: "claude", args: [], env: {}, driver: "claude-code", context: { kind: "native" }, available: true,
      capabilities: { models: [{ id: "claude-opus-5-5", default: true }], effortLevels: [], slashCommands: [],
        permissionModes: ["default", "orchestrator"], supportsImages: true, supportsApprovals: true,
        ...(options.images === false ? {} : { imageToolResults: true }),
        ...(options.pacedVideo ? { pacedVideoReviewContract: pacedVideoContract } : {}) } }],
    runtime: "runtime" in options ? options.runtime : runtime };
  const reconnect = (at: number) => db.registerRunner(meta, at, options.protocolVersion ?? PROTOCOL_VERSION);
  reconnect(Date.now());
  if (options.priced !== false) {
    db.setUsageRateTable(new Map([["claude-opus-5-5", { inputCostPerToken: 0.000001, outputCostPerToken: 0.000001,
      cacheReadCostPerToken: 0.000001, cacheCreationCostPerToken: 0.000001 }]])); // Fixture pricing only.
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
  const sessions = new SessionsService(db, hub, { info() {}, warn() {}, error() {} }, undefined, undefined, undefined, undefined,
    undefined, undefined, false, undefined, undefined, undefined, disclosures);
  const scope = { organizationId: human.organizationId, owner: { kind: "user" as const, userId: human.userId } };
  const settings = new OrchestratorSettings(db);
  return { db, hub, sent, starts, state, sessions, human, scope, settings, disclosures, reconnect };
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
    assert.match(summary.evidence.statement, /Screenshots are reviewed by the Orchestrator; video and external evidence need a Human/);
    assert.equal(summary.evidence.provider!.retentionDisclosure, CAMPAIGN_EVIDENCE_RETENTION_DISCLOSURE);
    assert.equal(summary.evidence.destination.configurationId, `session_artifacts:${f.human.organizationId}`);
    assert.equal(summary.evidence.envelope, false, "no peer declares the private media contract");
    assert.ok(summary.humanRequired.some((item) => item.exception === "Secrets and sign-in"));
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
    { name: "no budget", body: { ...launch, overrides: { ...launch.overrides, budget: undefined } }, id: "accounting_budget", reason: /No campaign cost and tool-call budget/ },
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
    assert.match(checked!.summary.evidence.statement, /Screenshots, video and external evidence need a Human/);
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

test("saved Project child defaults derive the budget, and a task alone launches with an empty issue scope", async () => {
  const f = fixture();
  const project = f.db.createProject({ name: "Fixture", scope: f.scope });
  f.db.addProjectLocation(project.id, { runnerId: "r", workspaceId: "w" });
  f.db.updateProject(project.id, { childSessionDefaults: { costBudgetUsd: 5, maxToolCalls: 50 } });
  const { server } = await app(f);
  try {
    const body: FullControlLaunchRequest = { runnerId: "r", workspaceId: "w", projectId: project.id, task: "Investigate flaky tests",
      overrides: { session: { config: { model: "claude-opus-5-5", permissionMode: "orchestrator" } } } };
    const { response, preflight: checked } = await preflight(server, body);
    assert.equal(response.statusCode, 200, response.body);
    assert.equal(checked!.ready, true, JSON.stringify(checked!.summary.blockers));
    assert.equal(checked!.summary.root.agentId, "claude", "the default root is the reviewer's own Claude Code installation");
    assert.deepEqual(checked!.summary.issueNumbers, []);
    assert.deepEqual(f.sent.filter((message) => message.type === "campaign_launch_inspect").map((message) =>
      (message as { issueNumbers: number[] }).issueNumbers), [[]]);
    assert.deepEqual(checked!.summary.budget, { costUsd: 10, toolCalls: 100, concurrency: 4, acceptedFollowUps: 0, source: "project_defaults", reviewIncluded: true });
    const admitted = await server.inject({ method: "POST", url: "/api/full-control-campaigns", headers: { authorization: "Bearer human" },
      payload: { ...body, requestId: "task-only", preflightDigest: checked!.digest } });
    assert.equal(admitted.statusCode, 201, admitted.body);
    assert.deepEqual(f.db.getSession(admitted.json().id)!.orchestratorPolicy!.issueScope!.issueNumbers, []);
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
