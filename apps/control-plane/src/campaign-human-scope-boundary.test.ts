/** A Human's issue-scope approval under Full Control re-mints the boundary that names it (#2940).
 * Real service and storage, the actual Campaign Status proposal route and a synthetic runner. */
import assert from "node:assert/strict";
import test from "node:test";
import Fastify from "fastify";
import { DEFAULT_ORCHESTRATOR_DEFAULTS, HUMAN_ONLY_PARENT_CONTROL_POLICY, PROTOCOL_VERSION, validCampaignControl,
  type CampaignAuthorityBoundary, type CampaignControl, type CampaignEvidenceAuthority, type RunnerMetadata, type WorkflowDecisionView } from "@wollipog/protocol";
import { ControlPlaneDb } from "./db.js";
import { Hub } from "./hub.js";
import { SessionsService } from "./sessions.js";
import { resolveOrchestratorCampaignPolicy } from "./orchestrator-settings.js";
import { campaignBoundaryCurrent, remintCampaignBoundary } from "./campaign-authority.js";
import { registerCampaignIssueScopeRoutes } from "./campaign-issue-scope-routes.js";
import type { HumanPrincipal } from "./identity.js";

const REPOSITORY = "team/repo";

/** The live campaign's shape: a Claude Code root with a campaign allowance, whose prompt path
 * refuses a stale boundary as "campaign allowance boundary is stale or revoked". */
function harness(maxIssues = 4) {
  const db = ControlPlaneDb.open(":memory:");
  const identity = db.localIdentityContext();
  const principal: HumanPrincipal = { ...identity, kind: "human", actorId: identity.userId };
  const metadata: RunnerMetadata = { runnerId: "r", hostname: "test", os: "linux", version: "test",
    workspaces: [{ id: "w", name: "Repo", path: "/repos/test" }], agents: [{ id: "claude", name: "Claude", command: "claude", args: [], env: {},
      driver: "claude-code", context: { kind: "native" }, available: true }] };
  db.registerRunner(metadata, 1, PROTOCOL_VERSION);
  const policy = resolveOrchestratorCampaignPolicy(DEFAULT_ORCHESTRATOR_DEFAULTS, "system_default");
  policy.issueScope = { repository: REPOSITORY, issueNumbers: [100], revision: 1, authorizedByUserId: principal.userId, authorizedAt: 1 };
  policy.issueNumbers = [100];
  for (const id of ["root", "child"]) {
    db.createSession({ id, runnerId: "r", workspaceId: "w", agentId: "claude", title: id, useWorktree: false, driver: "claude-code", now: 1, config: {},
      scope: { organizationId: identity.organizationId, owner: { kind: "user", userId: principal.userId } },
      ...(id === "root" ? { role: "orchestrator", orchestratorPolicy: policy, parentControlPolicy: { decisions: { ...HUMAN_ONLY_PARENT_CONTROL_POLICY } } } : { parentSessionId: "root" }) });
    db.updateSessionStatus(id, "idle", 2);
  }
  const hub = new Hub(db);
  hub.isRunnerOnline = () => true; hub.sessionChangedById = () => {};
  const sent: Array<{ type: string; sessionId?: string }> = [];
  hub.sendToRunner = (_runnerId, message) => { sent.push(message as { type: string; sessionId?: string }); return true; };
  hub.requestFromRunner = async (_runner, requestId, message) => {
    if (message.type !== "campaign_issue_scope") throw new Error("Unexpected runner command");
    return { type: "campaign_issue_scope_result", requestId, sessionId: message.sessionId, ok: true, repository: REPOSITORY,
      ...(message.operation === "synchronize" ? { revision: message.scope.revision } : { candidates: (("issues" in message ? message.issues : undefined) ?? [101, 102]).map((number: number) =>
        ({ issue: { repository: REPOSITORY, number }, title: `Issue ${number}`, source: "sub_issue" as const })) }) };
  };
  const svc = new SessionsService(db, hub, { info() {}, warn() {}, error() {} });
  const enabled = svc.setCampaignControl("root", { mode: "full_control", objective: "Implement epic 100",
    operations: ["campaign_issue_scope", "issue_closure", "follow_up_issue_publication", "implementation_question"], delegatablePolicyIds: [],
    issueAuthority: { epics: [100], relatedFollowUps: true, maxIssues, closureReasons: ["completed"] },
    budgetAuthority: { version: 1, concurrency: 3, acceptedFollowUps: 2, accounting: "managed_workers_only", unpriced: "stop" } }, 1, principal);
  assert.ok(enabled.ok, enabled.error ?? "enable");
  const boundary = () => (db.getSession("root")!.orchestratorPolicy!.control as Extract<CampaignControl, { mode: "full_control" }>).boundary;
  const approve = (d: WorkflowDecisionView, by: HumanPrincipal = principal) => svc.resolveWorkflowDecision("root", "root", d.occurrenceId, { outcome: "approve" },
    d.authority, d.authority === "human" ? { kind: "human", id: by.userId } : { kind: "agent", id: "root" }, () => true);
  /** The authenticated owner's proposal through the actual Campaign Status route. */
  const humanProposal = async (requestId: string, expectedRevision: number, additions: number[], removals: number[] = []) => {
    const app = Fastify();
    try {
      registerCampaignIssueScopeRoutes(app, { db, svc, requestPrincipal: () => principal });
      const response = await app.inject({ method: "POST", url: "/api/sessions/root/campaign/issue-scope/proposals", payload: { requestId, expectedRevision,
        additions: additions.map((number) => ({ repository: REPOSITORY, number })), removals: removals.map((number) => ({ repository: REPOSITORY, number })),
        explanation: "The owner adds this work to the campaign" } });
      assert.equal(response.statusCode, 201, response.body);
      return response.json() as WorkflowDecisionView;
    } finally { await app.close(); }
  };
  /** Rewrites the campaign to what a Human approval left before #2940: the new scope, with the
   * boundary and policy revision that preceded it. */
  const leaveAsBeforeFix = (control: CampaignControl, revision: number) => {
    const stored = db.sessionOrchestratorPolicy("root")!;
    stored.control = structuredClone(control);
    db.raw().prepare("UPDATE sessions SET orchestrator_policy=?, parent_control_policy_revision=? WHERE id='root'").run(JSON.stringify(stored), revision);
  };
  return { db, svc, hub, principal, sent, metadata, boundary, approve, humanProposal, leaveAsBeforeFix };
}

test("a Human scope addition re-mints the Full Control boundary, so the owner's next message is admitted (#2940)", async () => {
  const h = harness();
  try {
    const before = h.boundary();
    const proposal = await h.humanProposal("human-add", 1, [101]);
    assert.equal(proposal.authority, "human");
    const approved = h.approve(proposal);
    assert.ok(approved.ok, approved.error ?? "approval");
    const root = h.db.getSession("root")!;
    const scope = root.orchestratorPolicy!.issueScope!;
    const boundary = h.boundary();
    assert.deepEqual(scope.issueNumbers, [100, 101]);
    assert.equal(scope.revision, 2);
    assert.equal(boundary.revision, before.revision + 1, "a new boundary revision");
    assert.equal(boundary.issueScopeRevision, 2, "naming the scope the Human approved");
    assert.equal(boundary.authorizedByUserId, h.principal.userId);
    assert.equal(boundary.authorizedAt, scope.authorizedAt, "authorized at the approval");
    assert.equal(root.parentControlPolicy!.revision, boundary.revision);
    assert.deepEqual({ ...boundary, revision: 0, issueScopeRevision: 0, authorizedAt: 0 }, { ...before, revision: 0, issueScopeRevision: 0, authorizedAt: 0 },
      "every grant is unchanged");
    assert.equal(campaignBoundaryCurrent(root), true);
    assert.equal(h.db.campaignBudgets.view("root")!.state, "active");

    const prompted = await h.svc.promptFromHuman(h.principal, "root", "Continue with #101");
    assert.ok(prompted.ok, prompted.error ?? "prompt");
    assert.equal(prompted.data!.status, "queued");
    assert.ok(h.sent.some((message) => message.type === "durable_session_command"), "the message reaches the runner");
    const restarted = h.svc.restoreHumanCampaignAuthority(h.principal, "root");
    assert.equal(restarted, null, "a restart is not refused either");

    // The Orchestrator's own bounded dispositions keep working under the re-minted boundary.
    const bounded = await h.svc.proposeCampaignIssueScope("root", { requestId: "orchestrator-add", expectedRevision: 2,
      additions: [{ repository: REPOSITORY, number: 102 }], removals: [], explanation: "Verified epic member", lineage: { kind: "epic", epic: 100 } });
    assert.ok(bounded.ok, bounded.error ?? "bounded proposal");
    assert.equal(bounded.data!.authority, "orchestrator");
    assert.ok(h.approve(bounded.data!).ok);
    assert.equal(h.boundary().revision, boundary.revision);
    assert.equal(h.boundary().issueScopeRevision, 3);
    assert.equal(campaignBoundaryCurrent(h.db.getSession("root")!), true);
  } finally { h.db.close(); }
});

test("the Orchestrator's own scope disposition keeps its boundary revision, author and time", async () => {
  const h = harness();
  try {
    const before = h.boundary();
    const policyRevision = h.db.getSession("root")!.parentControlPolicy!.revision;
    const bounded = await h.svc.proposeCampaignIssueScope("root", { requestId: "orchestrator-add", expectedRevision: 1,
      additions: [{ repository: REPOSITORY, number: 101 }], removals: [], explanation: "Verified epic member", lineage: { kind: "epic", epic: 100 } });
    assert.ok(bounded.ok, bounded.error ?? "bounded proposal");
    assert.equal(bounded.data!.authority, "orchestrator");
    assert.ok(h.approve(bounded.data!).ok);
    const root = h.db.getSession("root")!;
    assert.deepEqual({ ...h.boundary(), issueScopeRevision: 0 }, { ...before, issueScopeRevision: 0 });
    assert.equal(h.boundary().issueScopeRevision, 2);
    assert.equal(root.parentControlPolicy!.revision, policyRevision);
    assert.equal(root.orchestratorPolicy!.issueScope!.authorizedAt, 1, "the Human's original authorization time");
    assert.equal(root.orchestratorPolicy!.issueScope!.disposition!.bySessionId, "root");
    assert.equal(campaignBoundaryCurrent(root), true);
    assert.ok((await h.svc.promptFromHuman(h.principal, "root", "Continue")).ok);
  } finally { h.db.close(); }
});

test("an Orchestrator disposition keeps a boundary's evidence authority bound to the new scope revision", async () => {
  const h = harness();
  try {
    const stored = h.db.sessionOrchestratorPolicy("root")!;
    const control = stored.control as Extract<CampaignControl, { mode: "full_control" }>;
    control.boundary.evidenceAuthority = evidence(control.boundary);
    assert.ok(validCampaignControl(control));
    h.db.raw().prepare("UPDATE sessions SET orchestrator_policy=? WHERE id='root'").run(JSON.stringify(stored));
    const bounded = await h.svc.proposeCampaignIssueScope("root", { requestId: "orchestrator-add", expectedRevision: 1,
      additions: [{ repository: REPOSITORY, number: 101 }], removals: [], explanation: "Verified epic member", lineage: { kind: "epic", epic: 100 } });
    assert.ok(bounded.ok, bounded.error ?? "bounded proposal");
    assert.ok(h.approve(bounded.data!).ok);
    const root = h.db.getSession("root")!;
    assert.equal(h.boundary().evidenceAuthority!.issueScopeRevision, 2);
    assert.ok(validCampaignControl(root.orchestratorPolicy!.control));
    assert.equal(campaignBoundaryCurrent(root), true);
  } finally { h.db.close(); }
});

test("a re-minted boundary carries evidence authority only for the Human who authorized it", () => {
  const boundary: CampaignAuthorityBoundary = { version: 1, revision: 2, issueScopeRevision: 2, repository: REPOSITORY, objective: "Objective",
    authorizedByUserId: "owner", authorizedAt: 10, operations: ["campaign_issue_scope"], delegatablePolicyIds: [] };
  boundary.evidenceAuthority = evidence(boundary);
  const same = remintCampaignBoundary(boundary, { revision: 3 }, "owner", 20) as Extract<CampaignControl, { mode: "full_control" }>;
  assert.ok(same);
  assert.deepEqual([same.boundary.revision, same.boundary.issueScopeRevision, same.boundary.authorizedAt], [3, 3, 20]);
  assert.deepEqual([same.boundary.evidenceAuthority!.revision, same.boundary.evidenceAuthority!.issueScopeRevision, same.boundary.evidenceAuthority!.authorizedAt], [3, 3, 20]);
  const other = remintCampaignBoundary(boundary, { revision: 3 }, "co-owner", 20) as Extract<CampaignControl, { mode: "full_control" }>;
  assert.ok(other);
  assert.equal(other.boundary.authorizedByUserId, "co-owner");
  assert.equal(other.boundary.evidenceAuthority, undefined);
});

test("a Human scope approval beyond the boundary's Maximum Issues is refused inline and changes nothing", async () => {
  const h = harness(1);
  try {
    const before = h.boundary();
    const proposal = await h.humanProposal("human-add", 1, [101]);
    const refused = h.approve(proposal);
    assert.equal(refused.ok, false);
    assert.equal(refused.status, 409);
    assert.match(refused.error!, /give the campaign 2 issues, more than the 1 its Full Control boundary allows/);
    assert.match(refused.error!, /Revoke Full Control/);
    const root = h.db.getSession("root")!;
    assert.deepEqual(root.orchestratorPolicy!.issueNumbers, [100]);
    assert.deepEqual(h.boundary(), before);
    assert.equal(h.db.workflowDecisionByOccurrence(proposal.occurrenceId)!.status, "pending", "the owner can still deny it");
    assert.equal(campaignBoundaryCurrent(root), true);
    // Narrowing within the limit is still approved and re-minted.
    const narrowed = await h.humanProposal("human-narrow", 1, [], [100]);
    assert.ok(h.approve(narrowed).ok);
    assert.equal(campaignBoundaryCurrent(h.db.getSession("root")!), true);
  } finally { h.db.close(); }
});

test("a campaign stuck by a pre-fix Human scope approval is restored by that Human's next message, from the approval record", async () => {
  const h = harness();
  try {
    const previous = structuredClone(h.db.getSession("root")!.orchestratorPolicy!.control!);
    const previousRevision = h.db.getSession("root")!.parentControlPolicy!.revision;
    const proposal = await h.humanProposal("human-add", 1, [101]);
    assert.ok(h.approve(proposal).ok);
    h.leaveAsBeforeFix(previous, previousRevision);
    const stuck = h.db.getSession("root")!;
    const scope = stuck.orchestratorPolicy!.issueScope!;
    assert.equal(campaignBoundaryCurrent(stuck), false);
    assert.equal(h.db.campaignContinuationAdmission("root").state, "authority_unavailable");
    // An agent's message still meets the allowance check: only the approving Human can repair.
    const agentPrompt = h.svc.prompt("root", "Continue");
    assert.equal(agentPrompt.ok, false);
    assert.match(agentPrompt.error!, /campaign allowance boundary is stale or revoked/);
    // An outstanding child request is revoked with the boundary change, as any re-authorization does.
    const question = h.svc.createWorkflowDecision("child", { requestId: "question", resourceKey: "question", resourceSnapshot: {
      category: "implementation_question", question: "Which test?", options: [{ optionId: "a", label: "A" }, { optionId: "b", label: "B" }] } });
    assert.ok(question.ok, question.error ?? "question");

    const prompted = await h.svc.promptFromHuman(h.principal, "root", "Continue with #101");
    assert.ok(prompted.ok, prompted.error ?? "prompt");
    const repaired = h.db.getSession("root")!;
    const boundary = h.boundary();
    assert.equal(boundary.revision, (previous as Extract<CampaignControl, { mode: "full_control" }>).boundary.revision + 1);
    assert.equal(boundary.issueScopeRevision, scope.revision);
    assert.equal(boundary.authorizedByUserId, h.principal.userId);
    assert.equal(boundary.authorizedAt, scope.authorizedAt, "the approval's own time, not the message's");
    assert.deepEqual(repaired.orchestratorPolicy!.issueScope, scope, "the scope is exactly what the Human approved");
    assert.equal(repaired.parentControlPolicy!.revision, boundary.revision);
    assert.equal(campaignBoundaryCurrent(repaired), true);
    assert.equal(h.db.workflowDecisionByOccurrence(question.data!.occurrenceId)!.status, "revoked");

    const again = await h.svc.promptFromHuman(h.principal, "root", "And keep going");
    assert.ok(again.ok, again.error ?? "second prompt");
    assert.deepEqual(h.boundary(), boundary, "idempotent: a current boundary is left alone");
    assert.ok(h.svc.prompt("root", "Agent continues").ok);
  } finally { h.db.close(); }
});

test("repair never re-mints a boundary whose issue limit the scope and a consumed publication's slot exceed", async () => {
  const h = harness(2);
  try {
    const previous = structuredClone(h.db.getSession("root")!.orchestratorPolicy!.control!);
    const previousRevision = h.db.getSession("root")!.parentControlPolicy!.revision;
    assert.ok(h.approve(await h.humanProposal("human-add", 1, [101])).ok);
    h.leaveAsBeforeFix(previous, previousRevision);
    // A follow-up publication consumed under the earlier boundary still holds an issue slot.
    const snapshot = { category: "follow_up_issue_publication" as const, repository: REPOSITORY, sanitizedTitle: "Published repair",
      sanitizedBody: "Body", labels: [], recommendationId: "recommendation", issueAdmission: { boundaryRevision: previousRevision, evidenceDigest: "a".repeat(64) } };
    assert.ok(h.db.createWorkflowDecision({ requestId: "publication", occurrenceId: "workflow_publication", sessionId: "root", controllingSessionId: "root",
      category: "follow_up_issue_publication", resourceKey: "publication", resourceSnapshot: snapshot, resourceDigest: "b".repeat(64),
      policyRevision: previousRevision, authority: "orchestrator", createdAt: 3 }));
    assert.ok(h.db.resolveWorkflowDecision("workflow_publication", "orchestrator", "approved", 4));
    assert.ok(h.db.consumeWorkflowDecision("workflow_publication", 4));
    assert.equal(h.db.unsettledPublicationSlots("root"), 1);

    const refused = await h.svc.promptFromHuman(h.principal, "root", "Continue");
    assert.equal(refused.ok, false);
    assert.equal(refused.errorDetails?.code, "campaign_authority_stale");
    assert.deepEqual(h.boundary(), (previous as Extract<CampaignControl, { mode: "full_control" }>).boundary, "never re-minted over its limit");
  } finally { h.db.close(); }
});

test("only the Human whose approval wrote the scope can restore it; another owner is told who can, and how to recover", async () => {
  const h = harness();
  try {
    const previous = structuredClone(h.db.getSession("root")!.orchestratorPolicy!.control!);
    const previousRevision = h.db.getSession("root")!.parentControlPolicy!.revision;
    assert.ok(h.approve(await h.humanProposal("human-add", 1, [101])).ok);
    h.leaveAsBeforeFix(previous, previousRevision);
    // The scope was approved by a co-owner, not by the person now sending a message.
    h.db.createIdentityMember({ userId: "co-owner", displayName: "Co-Owner", organizationId: h.principal.organizationId, role: "admin", now: 3 });
    const stored = h.db.sessionOrchestratorPolicy("root")!;
    stored.issueScope!.authorizedByUserId = "co-owner";
    h.db.raw().prepare("UPDATE sessions SET orchestrator_policy=? WHERE id='root'").run(JSON.stringify(stored));
    const refused = await h.svc.promptFromHuman(h.principal, "root", "Continue");
    assert.equal(refused.ok, false);
    assert.equal(refused.status, 409);
    assert.equal(refused.errorDetails?.code, "campaign_authority_stale");
    assert.match(refused.error!, /another person approved/);
    assert.match(refused.error!, /Revoke Full Control in Orchestrator Controls, then Enable Full Control/);
    assert.deepEqual(h.boundary(), (previous as Extract<CampaignControl, { mode: "full_control" }>).boundary, "never enlarged by another person");
  } finally { h.db.close(); }
});

test("a stale boundary no Human scope approval explains refuses a person's message with the recovery, and is never enlarged", async () => {
  const h = harness();
  try {
    const previous = structuredClone(h.db.getSession("root")!.orchestratorPolicy!.control!);
    const previousRevision = h.db.getSession("root")!.parentControlPolicy!.revision;
    assert.ok(h.approve(await h.humanProposal("human-add", 1, [101])).ok);
    h.leaveAsBeforeFix(previous, previousRevision);
    // An issue the approval never named makes the stored scope unexplained by its record.
    const stored = h.db.sessionOrchestratorPolicy("root")!;
    stored.issueScope!.issueNumbers = [100, 101, 999];
    stored.issueNumbers = [100, 101, 999];
    h.db.raw().prepare("UPDATE sessions SET orchestrator_policy=? WHERE id='root'").run(JSON.stringify(stored));
    for (const attempt of ["message", "restart"] as const) {
      const refused = attempt === "message" ? await h.svc.promptFromHuman(h.principal, "root", "Continue")
        : h.svc.restoreHumanCampaignAuthority(h.principal, "root")!;
      assert.equal(refused.ok, false, attempt);
      assert.equal(refused.errorDetails?.code, "campaign_authority_stale");
      assert.equal(refused.error, "This Full Control campaign's authority no longer matches its issue scope or policy, so it can't continue. " +
        "Revoke Full Control in Orchestrator Controls, then Enable Full Control to authorize the campaign's current issue scope.");
    }
    assert.deepEqual(h.boundary(), (previous as Extract<CampaignControl, { mode: "full_control" }>).boundary);
    assert.equal(campaignBoundaryCurrent(h.db.getSession("root")!), false);
    // The stated recovery works: revoking and enabling again authorizes the current scope.
    const revoked = h.svc.setCampaignControl("root", { mode: "custom" }, h.db.getSession("root")!.parentControlPolicy!.revision, h.principal);
    assert.ok(revoked.ok, revoked.error ?? "revoke");
  } finally { h.db.close(); }
});

test("evidence authority on an older runner refuses with the shared sentence and versions, never a protocol number (#3803)", async () => {
  const h = harness();
  try {
    const stored = h.db.sessionOrchestratorPolicy("root")!;
    const control = stored.control as Extract<CampaignControl, { mode: "full_control" }>;
    control.boundary.evidenceAuthority = evidence(control.boundary);
    h.db.raw().prepare("UPDATE sessions SET orchestrator_policy=? WHERE id='root'").run(JSON.stringify(stored));
    h.db.registerRunner(h.metadata, 2, 222);
    const older = await h.svc.promptFromHuman(h.principal, "root", "Continue");
    assert.equal(older.status, 409);
    assert.equal(older.error, "This machine needs a newer runner for production evidence authority. Update and restart the runner.");
    assert.deepEqual(older.capabilityRequirement, { requiredRunnerProtocolVersion: 223, runnerProtocolVersion: 222 });
    // A current runner without the private media contract has nothing to update; it gets no versions.
    h.db.registerRunner(h.metadata, 3, PROTOCOL_VERSION);
    const current = await h.svc.promptFromHuman(h.principal, "root", "Continue");
    assert.equal(current.status, 409);
    assert.match(current.error!, /^Production evidence authority requires the exact private media contract;/);
    assert.equal(current.capabilityRequirement, undefined);
  } finally { h.db.close(); }
});

function evidence(boundary: CampaignAuthorityBoundary): CampaignEvidenceAuthority {
  return { version: 1, revision: boundary.revision, authorizedByUserId: boundary.authorizedByUserId, authorizedAt: boundary.authorizedAt,
    campaignRootSessionId: "root", repository: boundary.repository, objective: boundary.objective, issueScopeRevision: boundary.issueScopeRevision,
    scope: "relevant_task_evidence_only", destination: { kind: "session_artifacts", configurationId: "private-artifacts", organizationId: "org",
      privacy: "private", disclosureRevision: 1 },
    providers: [{ providerId: "provider", disclosureRevision: 1, retentionDisclosure: "Thirty days.", reviewers: [{ driver: "claude-code", modelId: "model" }] }] };
}
