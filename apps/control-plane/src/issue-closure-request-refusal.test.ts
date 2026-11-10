import assert from "node:assert/strict";
import test from "node:test";
import { DEFAULT_ORCHESTRATOR_DEFAULTS, HUMAN_ONLY_PARENT_CONTROL_POLICY, PROTOCOL_VERSION, RUNNER_CAPABILITY_MIN_PROTOCOL,
  type CampaignControl, type GithubIssueClosureRequest, type RunnerMetadata } from "@wollipog/protocol";
import { ControlPlaneDb } from "./db.js";
import { Hub } from "./hub.js";
import { SessionsService } from "./sessions.js";
import { resolveOrchestratorCampaignPolicy } from "./orchestrator-settings.js";
import type { HumanPrincipal } from "./identity.js";
import { healthyDecisionRuntime } from "./credential-screen-test-fixture.js";
import { issueClosureRequestInvalidFields } from "./issue-closure-request-refusal.js";
import { failureBody } from "./capability-refusal.js";

const PROPOSAL: GithubIssueClosureRequest = { requestId: "scope-diagnostic", issue: 12, reason: "completed",
  explanation: "Every acceptance criterion is delivered", evidence: ["Merged pull request"] };

/** A root campaign Orchestrator whose issue scope the test chooses: `undefined` saves none at all, an
 * array saves that list at revision 1. Every runner command, decision and runner send is counted. */
function harness(options: { scope?: number[]; protocol?: number; full?: boolean; foreignParticipant?: boolean;
  grant?: "failed" | "uncertain" | "selection" } = {}) {
  const db = ControlPlaneDb.open(":memory:");
  const principal: HumanPrincipal = { ...db.localIdentityContext(), kind: "human", actorId: db.localIdentityContext().userId };
  const metadata: RunnerMetadata = { runnerId: "r", hostname: "test", os: "linux", version: "test",
    workspaces: [{ id: "w", name: "Repo", path: "/repos/test" }, { id: "other", name: "Other", path: "/repos/other" }],
    agents: [{ id: "codex", name: "Codex", command: "codex", args: [], env: {}, driver: "codex-app-server", context: { kind: "native" }, available: true }] };
  db.registerRunner(metadata, 1, options.protocol ?? PROTOCOL_VERSION);
  const policy = resolveOrchestratorCampaignPolicy(DEFAULT_ORCHESTRATOR_DEFAULTS, "system_default");
  if (options.scope) {
    policy.issueScope = { repository: "team/repo", issueNumbers: options.scope, revision: 1, authorizedByUserId: principal.userId, authorizedAt: 1 };
    policy.issueNumbers = options.scope;
  }
  if (options.grant) {
    // The first message's scope grant (#4102), as a settled launch records it.
    const ceilings = { repositories: ["team/repo"], maxIssues: 5, maxIssuesSource: "explicit" as const, operations: [] };
    policy.firstMessageScope = { state: "established", messageDigest: "d".repeat(64), establishedAt: 1, grant: options.grant === "selection"
      ? { version: 1, status: "granted", reason: "The owner asked for five issues", namedIssues: [], ceilings,
        selection: { repository: "team/repo", count: 5, defaulted: false, criteria: "Highest impact", constraints: [] } }
      : { version: 1, status: options.grant, failureClass: "timed_out", namedIssues: [], ceilings } };
  }
  db.createSession({ id: "root", runnerId: "r", workspaceId: "w", agentId: "codex", title: "root", useWorktree: false, driver: "codex-app-server",
    now: 1, config: {}, role: "orchestrator", orchestratorPolicy: policy, parentControlPolicy: { decisions: { ...HUMAN_ONLY_PARENT_CONTROL_POLICY } } });
  db.updateSessionStatus("root", "running", 2);
  if (options.foreignParticipant) {
    db.createSession({ id: "nested", runnerId: "r", workspaceId: "other", agentId: "codex", title: "nested", useWorktree: false, driver: "codex-app-server",
      now: 1, config: {}, role: "orchestrator", orchestratorPolicy: policy, parentSessionId: "root" });
    db.updateSessionStatus("nested", "running", 2);
  }
  const hub = new Hub(db);
  const calls = { runner: [] as string[], sends: 0, decisions: 0 };
  hub.isRunnerOnline = () => true; hub.sessionChangedById = () => {};
  hub.sendToRunner = () => { calls.sends++; return true; };
  hub.requestFromRunner = async (_runner, requestId, message) => {
    calls.runner.push(`${message.type}:${"operation" in message ? message.operation : ""}`);
    if (message.type === "campaign_issue_scope") {
      return { type: "campaign_issue_scope_result", requestId, sessionId: message.sessionId, ok: true, repository: "team/repo",
        ...(message.operation === "synchronize" ? { revision: message.scope.revision } : { candidates: [] }) };
    }
    if (message.type === "github_issue_closure" && message.operation === "inspect") {
      return { type: "github_issue_closure_result", requestId, sessionId: message.sessionId, ok: true, inspection: { repository: "team/repo",
        issue: message.issue, title: "Issue", url: `https://github.com/team/repo/issues/${message.issue}`, state: "OPEN",
        forgeDigest: "a".repeat(64), openPullRequests: [] } };
    }
    throw new Error(`Unexpected runner command ${message.type}`);
  };
  const svc = new SessionsService(db, hub, { info() {}, warn() {}, error() {} });
  svc.setDecisionRuntime(healthyDecisionRuntime(db).runtime);
  if (options.full) {
    assert.ok(svc.setCampaignControl("root", { mode: "full_control", objective: "Implement epic 12", operations: ["campaign_issue_scope", "issue_closure"],
      delegatablePolicyIds: [], issueAuthority: { epics: [12], relatedFollowUps: true, maxIssues: 5, closureReasons: ["completed"] } }, 1, principal).ok);
    // The control change's own scope synchronization (#3363) is setup, not the request under test.
    calls.runner.length = 0;
  }
  const create = svc.createWorkflowDecision.bind(svc);
  svc.createWorkflowDecision = ((...args: Parameters<typeof create>) => { calls.decisions++; return create(...args); }) as typeof create;
  const close = (request: unknown) => svc.requestGithubIssueClosure("root", request as GithubIssueClosureRequest);
  /** Nothing ran: no runner command (no synchronization, inspection, comment or closure), no
   * runner send, and no workflow decision created or stored. */
  const assertNothingRan = () => {
    assert.deepEqual(calls.runner, []);
    assert.equal(calls.sends, 0);
    assert.equal(calls.decisions, 0);
    assert.deepEqual(db.workflowDecisionPage("root", undefined, 100), []);
  };
  return { db, svc, calls, close, assertNothingRan };
}

test("#3382 a valid proposal with no saved issue scope is refused as missing scope, not missing fields", async () => {
  const h = harness();
  try {
    const result = await h.close(PROPOSAL);
    assert.equal(result.ok, false);
    assert.equal(result.status, 403);
    assert.equal(result.errorDetails?.code, "campaign_issue_scope_missing");
    assert.equal(result.errorDetails?.issue, 12);
    assert.equal(result.errorDetails?.scopeRevision, 0);
    assert.equal(result.errorDetails?.recovery, "owner_scope_review_or_proposal");
    assert.match(result.error!, /^This campaign has no authorized issue scope, so it cannot close issue #12 and no closure was requested\./);
    assert.match(result.error!, /A campaign owner can add issue #12 in Campaign Status under Issue Scope/);
    assert.match(result.error!, /request_campaign_issue_scope_change for a person to approve/);
    assert.match(result.error!, /it still needs its own closure decision/);
    assert.doesNotMatch(result.error!, /malformed|requestId|explanation/);
    // The HTTP route returns the code and recovery beside the sentence.
    assert.deepEqual(failureBody(result), { code: "campaign_issue_scope_missing", issue: 12, scopeRevision: 0,
      recovery: "owner_scope_review_or_proposal", error: result.error });
    h.assertNothingRan();
  } finally { h.db.close(); }
});

test("#3382 a valid proposal with an empty saved scope is refused as missing scope", async () => {
  const h = harness({ scope: [] });
  try {
    const result = await h.close(PROPOSAL);
    assert.equal(result.status, 403);
    assert.equal(result.errorDetails?.code, "campaign_issue_scope_missing");
    assert.equal(result.errorDetails?.scopeRevision, 1);
    assert.match(result.error!, /has no authorized issue scope/);
    h.assertNothingRan();
  } finally { h.db.close(); }
});

test("#3382 a valid proposal for an issue outside a non-empty scope names the scope and the issue", async () => {
  const h = harness({ scope: [3, 4] });
  try {
    const result = await h.close(PROPOSAL);
    assert.equal(result.status, 403);
    assert.equal(result.errorDetails?.code, "campaign_issue_outside_scope");
    assert.equal(result.errorDetails?.issue, 12);
    assert.equal(result.errorDetails?.scopeRevision, 1);
    assert.match(result.error!, /^Issue #12 is outside this campaign's authorized issue scope \(revision 1 in team\/repo: #3, #4\), so no closure was requested\./);
    assert.match(result.error!, /Campaign Status under Issue Scope/);
    h.assertNothingRan();
  } finally { h.db.close(); }
});

test("#3382 a large scope is listed in part", async () => {
  const scope = Array.from({ length: 25 }, (_, i) => i + 100);
  const h = harness({ scope });
  try {
    const result = await h.close(PROPOSAL);
    assert.match(result.error!, /#119, and 5 more\)/);
    assert.doesNotMatch(result.error!, /#120/);
    h.assertNothingRan();
  } finally { h.db.close(); }
});

test("#3382 malformed proposals keep a validation error that names each bad field, before any scope check", async () => {
  // Unscoped and out-of-scope campaigns alike: a malformed request is malformed whatever the scope.
  for (const scope of [undefined, [3], [12]]) {
    const h = harness(scope ? { scope } : {});
    try {
      const cases: Array<[unknown, string]> = [
        [{ ...PROPOSAL, evidence: [] }, "evidence"],
        [{ ...PROPOSAL, evidence: ["ok", ""] }, "evidence"],
        [{ ...PROPOSAL, issue: "12" }, "issue"],
        [{ ...PROPOSAL, issue: 0 }, "issue"],
        [{ ...PROPOSAL, issue: 1.5 }, "issue"],
        [{ ...PROPOSAL, requestId: " " }, "requestId"],
        [{ ...PROPOSAL, requestId: "x".repeat(257) }, "requestId"],
        [{ ...PROPOSAL, reason: "duplicate" }, "reason"],
        [{ ...PROPOSAL, explanation: "x".repeat(4001) }, "explanation"],
        [{ ...PROPOSAL, comment: "" }, "comment"],
        [{ ...PROPOSAL, comment: "bad\u0000" }, "comment"],
        [{ issue: 12 }, "requestId,reason,explanation,evidence"],
        [null, "requestId,issue,reason,explanation,evidence"],
        [[], "requestId,issue,reason,explanation,evidence"],
      ];
      for (const [request, fields] of cases) {
        const result = await h.close(request);
        assert.equal(result.status, 400, JSON.stringify(request));
        assert.equal(result.errorDetails?.code, "issue_closure_request_invalid");
        assert.equal(result.errorDetails?.fields, fields, JSON.stringify(request));
        assert.match(result.error!, new RegExp(`^The closure request is malformed: ${fields.split(",").join(", ")} (is|are) missing or invalid\\.`));
        assert.doesNotMatch(result.error!, /issue scope/);
      }
      h.assertNothingRan();
    } finally { h.db.close(); }
  }
  assert.deepEqual(issueClosureRequestInvalidFields(PROPOSAL), []);
  assert.deepEqual(issueClosureRequestInvalidFields({ ...PROPOSAL, comment: "Exact comment" }), []);
});

test("#3382 a scope refusal names why recovery is unavailable on a runner without scope changes", async () => {
  const protocol = RUNNER_CAPABILITY_MIN_PROTOCOL.campaignIssueScopeChanges - 1;
  assert.ok(protocol >= RUNNER_CAPABILITY_MIN_PROTOCOL.orchestratorIssueClosure, "closure itself stays supported");
  const h = harness({ scope: [3], protocol });
  try {
    const result = await h.close(PROPOSAL);
    assert.equal(result.status, 403);
    assert.equal(result.errorDetails?.code, "campaign_issue_outside_scope");
    assert.equal(result.errorDetails?.recovery, "unavailable");
    assert.match(result.error!, /Its issue scope cannot change right now: .*campaign issue scope changes/);
    assert.match(result.error!, /leave issue #12 open and report it for the campaign's owner/);
    assert.doesNotMatch(result.error!, /request_campaign_issue_scope_change|Campaign Status under Issue Scope/);
    h.assertNothingRan();
  } finally { h.db.close(); }
});

test("#3382 a scope refusal names why recovery is unavailable while a participant is in another workspace", async () => {
  const h = harness({ foreignParticipant: true });
  try {
    const result = await h.close(PROPOSAL);
    assert.equal(result.errorDetails?.code, "campaign_issue_scope_missing");
    assert.equal(result.errorDetails?.recovery, "unavailable");
    // The participant is in no Location of a campaign repository (#4118).
    assert.match(result.error!, /Every active Orchestrator participant must run in a Location of one of the campaign's repositories/);
    h.assertNothingRan();
  } finally { h.db.close(); }
});

test("#4118 a participant in another campaign repository's Location leaves the scope recovery route available", async () => {
  const h = harness({ scope: [3], full: true });
  try {
    // A participant whose workspace is a verified Location of a second boundary repository.
    h.db.createSession({ id: "nested", runnerId: "r", workspaceId: "other", agentId: "codex", title: "nested", useWorktree: false, driver: "codex-app-server",
      now: 1, config: {}, role: "orchestrator", orchestratorPolicy: h.db.sessionOrchestratorPolicy("root")!, parentSessionId: "root" });
    h.db.updateSessionStatus("nested", "running", 2);
    const project = h.db.createProject({ name: "Project" });
    const location = h.db.addProjectLocation(project.id, { runnerId: "r", workspaceId: "other" });
    const stored = h.db.sessionOrchestratorPolicy("root")!;
    const control = stored.control as Extract<CampaignControl, { mode: "full_control" }>;
    control.boundary.repositories = [{ repository: "team/repo", locationIds: [] }, { repository: "team/api", locationIds: [location.id] }];
    // A boundary's Locations come from the root's own Project (#4119).
    h.db.raw().prepare("UPDATE sessions SET orchestrator_policy=?, project_id=? WHERE id='root'").run(JSON.stringify(stored), project.id);
    const result = await h.close(PROPOSAL);
    assert.equal(result.errorDetails?.code, "campaign_issue_outside_scope");
    assert.equal(result.errorDetails?.recovery, "owner_scope_review_or_lineage", "a proposal can change the scope with this participant in place");
    h.assertNothingRan();
  } finally { h.db.close(); }
});

test("#3382 under Full Control issue authority the refusal names lineage, never a scope the agent widens itself", async () => {
  const h = harness({ scope: [3], full: true });
  try {
    const result = await h.close(PROPOSAL);
    assert.equal(result.status, 403);
    assert.equal(result.errorDetails?.code, "campaign_issue_outside_scope");
    assert.equal(result.errorDetails?.recovery, "owner_scope_review_or_lineage");
    assert.match(result.error!, /A campaign owner can add issue #12 in Campaign Status under Issue Scope/);
    assert.match(result.error!, /admits an addition only with the lineage this campaign's Full Control issue authority accepts/);
    assert.match(result.error!, /without it, only a campaign owner can add the issue/);
    h.assertNothingRan();
  } finally { h.db.close(); }
});

test("#3382 under a failed or uncertain scope grant the refusal names the owner's approval of a proposal without lineage", async () => {
  for (const grant of ["failed", "uncertain"] as const) {
    const h = harness({ scope: [3], full: true, grant });
    try {
      const result = await h.close(PROPOSAL);
      assert.equal(result.status, 403);
      assert.equal(result.errorDetails?.code, "campaign_issue_outside_scope");
      assert.equal(result.errorDetails?.recovery, "owner_scope_review_or_proposal", grant);
      assert.match(result.error!, /request_campaign_issue_scope_change for a person to approve/);
      assert.doesNotMatch(result.error!, /only with the lineage/);
      h.assertNothingRan();
    } finally { h.db.close(); }
  }
});

test("#3382 under a selection scope grant the refusal names the grant's own route and its checks", async () => {
  const h = harness({ scope: [3], full: true, grant: "selection" });
  try {
    const result = await h.close(PROPOSAL);
    assert.equal(result.status, 403);
    assert.equal(result.errorDetails?.recovery, "owner_scope_review_or_selection");
    assert.match(result.error!, /one of the issues the owner's first message asked this campaign to choose; that scope grant's count and checks and the Decision Model's scope review then admit it, refuse it or leave it to the owner/);
    assert.match(result.error!, /otherwise only a campaign owner can add the issue/);
    h.assertNothingRan();
  } finally { h.db.close(); }
});

test("#3382 a selection grant without Full Control scope admission keeps the person-approved proposal route", async () => {
  const h = harness({ scope: [3], grant: "selection" });
  try {
    const result = await h.close(PROPOSAL);
    assert.equal(result.errorDetails?.recovery, "owner_scope_review_or_proposal");
    h.assertNothingRan();
  } finally { h.db.close(); }
});

test("#3382 an ended root is told so instead of being told its request is malformed", async () => {
  const h = harness({ scope: [12] });
  try {
    h.db.updateSessionStatus("root", "completed", 3);
    const result = await h.close(PROPOSAL);
    assert.equal(result.status, 409);
    assert.equal(result.error, "Issue closure requires a running root campaign Orchestrator; this session has ended.");
    h.assertNothingRan();
  } finally { h.db.close(); }
});

test("#3382 a correctly scoped proposal still reaches inspection and its closure decision", async () => {
  const h = harness({ scope: [12] });
  try {
    const result = await h.close(PROPOSAL);
    assert.ok(result.ok, result.error ?? "closure");
    assert.deepEqual(h.calls.runner.filter((call) => call.startsWith("github_issue_closure")), ["github_issue_closure:inspect"]);
    assert.equal(h.calls.decisions, 1);
    const decision = result.data!.decision!;
    assert.equal(decision.status, "pending");
    assert.equal(decision.authority, "human");
    assert.equal(decision.resourceKey, "issue_closure:team/repo#12");
  } finally { h.db.close(); }
});
