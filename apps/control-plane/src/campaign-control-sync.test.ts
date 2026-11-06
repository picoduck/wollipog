/** Campaign control metadata stays current across control and scope updates (#3363). Real service
 * and storage, the actual Campaign Status proposal route and a synthetic runner that records each
 * synchronization it is sent. */
import assert from "node:assert/strict";
import test from "node:test";
import Fastify from "fastify";
import { DEFAULT_ORCHESTRATOR_DEFAULTS, HUMAN_ONLY_PARENT_CONTROL_POLICY, PROTOCOL_VERSION, RUNNER_CAPABILITY_MIN_PROTOCOL,
  type CampaignAuthorityOperation, type CampaignControl, type CampaignIssueScopeMessage, type RunnerMetadata, type WorkflowDecisionView } from "@wollipog/protocol";
import { ControlPlaneDb } from "./db.js";
import { Hub } from "./hub.js";
import { SessionsService } from "./sessions.js";
import { resolveOrchestratorCampaignPolicy } from "./orchestrator-settings.js";
import { registerCampaignIssueScopeRoutes } from "./campaign-issue-scope-routes.js";
import type { HumanPrincipal } from "./identity.js";

const REPOSITORY = "team/repo";
type Synchronize = Extract<CampaignIssueScopeMessage, { operation: "synchronize" }>;
const FULL_CONTROL = {
  mode: "full_control" as const, objective: "Implement epic 100", delegatablePolicyIds: [],
  operations: ["campaign_issue_scope", "issue_closure", "follow_up_issue_publication", "implementation_question"] as CampaignAuthorityOperation[],
  issueAuthority: { epics: [100], relatedFollowUps: true, maxIssues: 4, closureReasons: ["completed" as const] },
  budgetAuthority: { version: 1 as const, concurrency: 3, acceptedFollowUps: 2, accounting: "managed_workers_only" as const, unpriced: "stop" as const },
};

/** A Full Control root with a nested Orchestrator and an ordinary worker child. */
function harness(protocolVersion = PROTOCOL_VERSION) {
  const db = ControlPlaneDb.open(":memory:");
  const identity = db.localIdentityContext();
  const principal: HumanPrincipal = { ...identity, kind: "human", actorId: identity.userId };
  const metadata: RunnerMetadata = { runnerId: "r", hostname: "test", os: "linux", version: "test",
    workspaces: [{ id: "w", name: "Repo", path: "/repos/test" }], agents: [{ id: "claude", name: "Claude", command: "claude", args: [], env: {},
      driver: "claude-code", context: { kind: "native" }, available: true }] };
  db.registerRunner(metadata, 1, protocolVersion);
  const policy = resolveOrchestratorCampaignPolicy(DEFAULT_ORCHESTRATOR_DEFAULTS, "system_default");
  policy.issueScope = { repository: REPOSITORY, issueNumbers: [100, 101], revision: 1, authorizedByUserId: principal.userId, authorizedAt: 1 };
  policy.issueNumbers = [100, 101];
  const scope = { organizationId: identity.organizationId, owner: { kind: "user" as const, userId: principal.userId } };
  db.createSession({ id: "root", runnerId: "r", workspaceId: "w", agentId: "claude", title: "root", useWorktree: false, driver: "claude-code", now: 1, config: {},
    scope, role: "orchestrator", orchestratorPolicy: policy, parentControlPolicy: { decisions: { ...HUMAN_ONLY_PARENT_CONTROL_POLICY } } });
  db.updateSessionStatus("root", "idle", 2);
  const hub = new Hub(db);
  hub.isRunnerOnline = () => true;
  const changed: string[] = [];
  hub.sessionChangedById = (id) => { changed.push(id); };
  hub.sendToRunner = () => true;
  const syncs: Synchronize[] = [];
  hub.requestFromRunner = async (_runner, requestId, message) => {
    if (message.type !== "campaign_issue_scope") throw new Error("Unexpected runner command");
    if (message.operation === "synchronize") syncs.push(structuredClone(message));
    return { type: "campaign_issue_scope_result", requestId, sessionId: message.sessionId, ok: true, repository: REPOSITORY,
      ...(message.operation === "synchronize" ? { revision: message.scope.revision } : { candidates: [] }) };
  };
  const svc = new SessionsService(db, hub, { info() {}, warn() {}, error() {} });
  const enabled = svc.setCampaignControl("root", FULL_CONTROL, 1, principal);
  assert.ok(enabled.ok, enabled.error ?? "enable");
  // A nested Orchestrator inherits the campaign's control; the worker is an ordinary child.
  const nested = structuredClone(db.sessionOrchestratorPolicy("root")!);
  for (const id of ["nested", "worker"]) {
    db.createSession({ id, runnerId: "r", workspaceId: "w", agentId: "claude", title: id, useWorktree: false, driver: "claude-code", now: 3, config: {},
      scope, parentSessionId: "root", ...(id === "nested" ? { role: "orchestrator", orchestratorPolicy: nested } : {}) });
    db.updateSessionStatus(id, "idle", 4);
  }
  const revision = () => db.getSession("root")!.parentControlPolicy!.revision;
  const settle = () => new Promise((resolve) => setImmediate(resolve));
  const reset = () => { syncs.length = 0; changed.length = 0; };
  return { db, svc, principal, syncs, changed, revision, settle, reset };
}

test("a human control change synchronizes every participant at its policy revision without a scope edit", async () => {
  const h = harness();
  try {
    await h.settle(); h.reset();
    const snapshot = structuredClone(h.db.sessionOrchestratorPolicy("nested"));
    const reauthorized = h.svc.setCampaignControl("root", { ...FULL_CONTROL, objective: "Implement epic 100 carefully" }, h.revision(), h.principal);
    assert.ok(reauthorized.ok, reauthorized.error ?? "reauthorize");
    await h.settle();
    const rootControl = h.db.getSession("root")!.orchestratorPolicy!.control as Extract<CampaignControl, { mode: "full_control" }>;
    assert.equal(rootControl.boundary.objective, "Implement epic 100 carefully");
    assert.deepEqual(h.syncs.map((sync) => [sync.sessionId, sync.scope.revision, sync.controlRevision]).sort(),
      [["nested", 1, h.revision()], ["root", 1, h.revision()]], "both runners' copies, at the new revision, within the same scope revision");
    assert.ok(h.syncs.every((sync) => JSON.stringify(sync.control) === JSON.stringify(rootControl)),
      "each runner gets the campaign's current control, as the nested projection reads it");
    assert.equal(h.db.campaignProjection("nested")!.control!.mode, "full_control");
    for (const id of ["root", "nested", "worker"]) assert.ok(h.changed.includes(id), `${id}'s view is published`);

    h.reset();
    const revoked = h.svc.setCampaignControl("root", { mode: "custom" }, h.revision(), h.principal);
    assert.ok(revoked.ok, revoked.error ?? "revoke");
    await h.settle();
    assert.deepEqual(h.syncs.map((sync) => [sync.sessionId, sync.control?.mode, sync.controlRevision]).sort(),
      [["nested", "custom", h.revision()], ["root", "custom", h.revision()]], "a revoke reaches the nested runner too");
    assert.equal(h.db.campaignProjection("nested")!.control!.mode, "custom");
    for (const id of ["root", "nested", "worker"]) assert.ok(h.changed.includes(id), `${id}'s view is published`);
    assert.deepEqual(h.db.sessionOrchestratorPolicy("nested"), snapshot, "the nested Orchestrator's stored snapshot is not rewritten");
  } finally { h.db.close(); }
});

test("a runner without control ordering keeps today's synchronization, with no revision", async () => {
  const h = harness(RUNNER_CAPABILITY_MIN_PROTOCOL.campaignControlRevision - 1);
  try {
    await h.settle(); h.reset();
    assert.ok(h.svc.setCampaignControl("root", { mode: "custom" }, h.revision(), h.principal).ok);
    await h.settle();
    assert.equal(h.syncs.length, 2);
    assert.ok(h.syncs.every((sync) => !("controlRevision" in sync)));
    assert.deepEqual(Object.fromEntries(h.syncs.map((sync) => [sync.sessionId, sync.control?.mode])),
      { root: "custom", nested: "full_control" }, "each member's own stored control, as before");
  } finally { h.db.close(); }
});

test("a follow-up limit change synchronizes its re-minted boundary at the new revision", async () => {
  const h = harness();
  try {
    await h.settle(); h.reset();
    const changed = h.svc.setCampaignFollowUpLimit("root", { acceptedFollowUps: 5, expectedRevision: h.revision() }, h.principal);
    assert.ok(changed.ok, changed.error ?? "limit");
    await h.settle();
    const boundary = (h.db.getSession("root")!.orchestratorPolicy!.control as Extract<CampaignControl, { mode: "full_control" }>).boundary;
    assert.equal(boundary.budgetAuthority?.acceptedFollowUps, 5);
    const root = h.syncs.find((sync) => sync.sessionId === "root");
    assert.equal(root?.controlRevision, h.revision());
    assert.equal(root?.control?.mode === "full_control" && root.control.boundary.revision, boundary.revision);
  } finally { h.db.close(); }
});

test("a committed scope revocation publishes every child's view, not only the scope participants'", async () => {
  const h = harness();
  try {
    await h.settle(); h.reset();
    const app = Fastify();
    let proposal: WorkflowDecisionView;
    try {
      registerCampaignIssueScopeRoutes(app, { db: h.db, svc: h.svc, requestPrincipal: () => h.principal });
      const response = await app.inject({ method: "POST", url: "/api/sessions/root/campaign/issue-scope/proposals", payload: {
        requestId: "remove-101", expectedRevision: 1, additions: [], removals: [{ repository: REPOSITORY, number: 101 }],
        explanation: "The owner drops this issue from the campaign" } });
      assert.equal(response.statusCode, 201, response.body);
      proposal = response.json() as WorkflowDecisionView;
    } finally { await app.close(); }
    assert.equal(proposal.authority, "human");
    h.reset();
    const approved = h.svc.resolveWorkflowDecision("root", "root", proposal.occurrenceId, { outcome: "approve" }, "human",
      { kind: "human", id: h.principal.userId }, () => true);
    assert.ok(approved.ok, approved.error ?? "approve");
    await h.settle();
    assert.deepEqual(h.db.getSession("root")!.orchestratorPolicy!.issueScope!.issueNumbers, [100]);
    for (const id of ["root", "nested", "worker"]) assert.ok(h.changed.includes(id), `${id}'s view reflects the revocation`);
    assert.deepEqual(h.syncs.map((sync) => [sync.sessionId, sync.scope.revision, sync.controlRevision]).sort(),
      [["nested", 2, h.revision()], ["root", 2, h.revision()]]);
  } finally { h.db.close(); }
});
