import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import test from "node:test";
import { CAMPAIGN_FORGE_OBSERVATION, DEFAULT_ORCHESTRATOR_DEFAULTS, HUMAN_ONLY_PARENT_CONTROL_POLICY, PROTOCOL_VERSION, RUNNER_CAPABILITY_MIN_PROTOCOL,
  type CampaignControl, type RunnerMetadata, type WorkflowDecisionView, type CampaignWorkItemDetail } from "@wollipog/protocol";
import { ControlPlaneDb, campaignRequestToken } from "./db.js";
import { Hub } from "./hub.js";
import { SessionsService, canonicalPrMergeEnqueueCommand } from "./sessions.js";
import { resolveOrchestratorCampaignPolicy } from "./orchestrator-settings.js";
import { campaignBoundaryCurrent } from "./campaign-authority.js";
import { closureEvidence, issueEvidenceDigest } from "./campaign-issue-authority.js";
import { CampaignRecoveryService, recoveryCoordinate } from "./campaign-recovery.js";
import { CampaignForgeObserver } from "./campaign-forge-observations.js";
import type { AgentPrincipal, HumanPrincipal } from "./identity.js";

function harness(full = true, maximum = 5) {
  const db = ControlPlaneDb.open(":memory:");
  const principal: HumanPrincipal = { ...db.localIdentityContext(), kind: "human", actorId: db.localIdentityContext().userId };
  const metadata: RunnerMetadata = { runnerId: "r", hostname: "test", os: "linux", version: "test",
    workspaces: [{ id: "w", name: "Repo", path: "/repos/test" }], agents: [{ id: "codex", name: "Codex", command: "codex", args: [], env: {},
      driver: "codex-app-server", context: { kind: "native" }, available: true }] };
  db.registerRunner(metadata, 1, PROTOCOL_VERSION);
  const policy = resolveOrchestratorCampaignPolicy(DEFAULT_ORCHESTRATOR_DEFAULTS, "system_default");
  policy.issueScope = { repository: "team/repo", issueNumbers: [100], revision: 1, authorizedByUserId: principal.userId, authorizedAt: 1 };
  policy.issueNumbers = [100];
  for (const id of ["root", "child"]) {
    db.createSession({ id, runnerId: "r", workspaceId: "w", agentId: "codex", title: id, useWorktree: false, driver: "codex-app-server", now: 1, config: {},
      ...(id === "root" ? { role: "orchestrator", orchestratorPolicy: policy, parentControlPolicy: { decisions: { ...HUMAN_ONLY_PARENT_CONTROL_POLICY } } } : { parentSessionId: "root" }) });
    db.updateSessionStatus(id, "running", 2);
  }
  const hub = new Hub(db);
  hub.isRunnerOnline = () => true; hub.sessionChangedById = () => {}; hub.sendToRunner = () => true;
  const state = { publicationOk: true, subjectSearch: true, executes: 0, openPR: false, delivery: [] as Array<{number:number;headSha:string;mergeCommitSha:string}>, publicationTitles: {} as Record<number,string> };
  hub.requestFromRunner = async (_runner, requestId, message) => {
    if (message.type === "campaign_issue_scope") {
      if (message.operation === "publication_inspect") return { type: "campaign_issue_scope_result", requestId, sessionId: message.sessionId,
        ok: state.publicationOk, repository: "team/repo", publicationDigest: issueEvidenceDigest({ sanitizedTitle: message.sanitizedTitle, sanitizedBody: message.sanitizedBody, labels: message.labels }),
        ...(state.subjectSearch ? { duplicateSearch: "subject" as const } : {}) };
      return { type: "campaign_issue_scope_result", requestId, sessionId: message.sessionId, ok: true, repository: "team/repo",
        ...(message.operation === "synchronize" ? { revision: message.scope.revision } : { candidates: (message.issues ?? [100, 101]).map((number) =>
          ({ issue: { repository: "team/repo", number }, title: message.publication?.sanitizedTitle ?? state.publicationTitles[number] ?? `Issue ${number}`, source: "sub_issue" as const })) }) };
    }
    if (message.type === "github_issue_closure") {
      if (message.operation === "execute") { state.executes++; return { type: "github_issue_closure_result", requestId, sessionId: message.sessionId, ok: true,
        result: { outcome: "uncertain", completedAt: Date.now() } }; }
      return { type: "github_issue_closure_result", requestId, sessionId: message.sessionId, ok: true, inspection: { repository: "team/repo", issue: message.issue,
        title: "Issue", url: `https://github.com/team/repo/issues/${message.issue}`, state: "OPEN", forgeDigest: "a".repeat(64),
        openPullRequests: state.openPR ? [{ number: 10, title: "Work", url: "https://github.com/team/repo/pull/10", headSha: "b".repeat(40) }] : [],
        ...(message.deliveryPullRequests === undefined ? {} : { delivery: state.delivery }) } };
    }
    throw new Error("Unexpected runner command");
  };
  const svc = new SessionsService(db, hub, { info() {}, warn() {}, error() {} });
  if (full) assert.ok(svc.setCampaignControl("root", { mode: "full_control", objective: "Implement epic 100", operations: ["campaign_issue_scope", "issue_closure", "follow_up_issue_publication", "implementation_question"],
    delegatablePolicyIds: [], issueAuthority: { epics: [100], relatedFollowUps: true, maxIssues: maximum, closureReasons: ["completed", "not_planned"] } }, 1, principal).ok);
  const approve = (d: WorkflowDecisionView) => svc.resolveWorkflowDecision("root", "root", d.occurrenceId, { outcome: "approve" }, d.authority,
    d.authority === "human" ? { kind: "human", id: principal.userId } : { kind: "agent", id: "root" }, () => true);
  const proposal = (requestId: string, number = 101) => svc.proposeCampaignIssueScope("root", { requestId, expectedRevision: 1, additions: [{repository:"team/repo",number}],
    removals: [], explanation: "Verified intended member", lineage: { kind: "epic", epic: 100 } });
  assert.ok(svc.recordCampaignPlan("root", {items:[{key:"issue:100",issue:{repository:"team/repo",number:100}}],planComplete:true}).ok);
  const page = db.campaignWorkLedger.page("root", {state:"all",limit:100},Date.now()); assert.ok(page.ok);
  const item = page.data.items[0]!;
  return { db, svc, hub, metadata, principal, state, approve, proposal, item };
}

test("scope reads and proposals explain unsupported runner targets without exposing runner error text", async () => {
  const h = harness(false);
  try {
    h.hub.requestFromRunner = async (_runner, requestId, message) => {
      assert.equal(message.type, "campaign_issue_scope");
      return { type: "campaign_issue_scope_result", requestId, sessionId: message.sessionId, ok: false,
        failure: "unsupported_execution_target", error: "private runner path and credential text" };
    };
    for (const result of [await h.svc.campaignIssueScope("root", 100), await h.proposal("unsupported")]) {
      assert.equal(result.ok, false);
      assert.equal(result.status, 409);
      assert.equal(result.error, "Campaign scope requires a valid local or SSH host execution target belonging to its runner. Container and cloud targets are not supported.");
      assert.equal(JSON.stringify(result).includes("private runner"), false);
      assert.equal(JSON.stringify(result).includes("gh authentication"), false);
    }
  } finally { h.db.close(); }
});

test("scope refusals preserve bounded target reasons and safely ignore unknown reasons", async () => {
  for (const [reason, expected] of [
    ["runner_mismatch", "saved execution target does not match its runner"],
    ["unsupported_adapter", "supports only local or SSH host execution targets"],
    ["workspace_mismatch", "saved workspace strategy does not match"],
    ["filesystem_mismatch", "saved filesystem boundary does not match"],
    ["stale_network_policy", "saved network boundary no longer matches"],
    ["unsupported_host_boundaries", "saved secrets or billing boundary is unsupported"],
    ["future_reason", "Campaign scope requires a valid local or SSH"],
    ["__proto__", "Campaign scope requires a valid local or SSH"],
    [undefined, "Campaign scope requires a valid local or SSH"],
  ] as const) {
    const h = harness(false);
    try {
      h.hub.requestFromRunner = async (_runner, requestId, message) => {
        assert.equal(message.type, "campaign_issue_scope");
        return { type: "campaign_issue_scope_result", requestId, sessionId: message.sessionId, ok: false,
          failure: "unsupported_execution_target",
          targetFailureReason: reason as import("@wollipog/protocol").HostExecutionTargetRefusalReason,
          error: "private runner path and credential text" };
      };
      for (const result of [await h.svc.campaignIssueScope("root", 100), await h.proposal("refused")]) {
        assert.equal(result.status, 409, String(reason));
        assert.equal(result.ok, false);
        assert.ok(result.error?.includes(expected), `${reason}: ${result.error}`);
        assert.equal(JSON.stringify(result).includes("private runner"), false);
        assert.equal(JSON.stringify(result).includes("gh authentication"), false);
      }
      assert.equal(h.db.getSession("root")!.orchestratorPolicy!.issueScope!.revision, 1);
    } finally { h.db.close(); }
  }
});

test("bounded epic scope records lineage, preserves the authorizing human and revokes outstanding grants atomically", async () => {
  const h = harness();
  try {
    const other = h.svc.createWorkflowDecision("child",{requestId:"question",resourceKey:"question",resourceSnapshot:{category:"implementation_question",question:"Which test?",options:[{optionId:"a",label:"A"},{optionId:"b",label:"B"}]}});
    assert.ok(other.ok,other.error ?? "request");
    const proposed = await h.proposal("members"); assert.ok(proposed.ok, proposed.error ?? "proposal");
    assert.equal(proposed.data!.authority,"orchestrator");
    assert.equal(h.svc.resolveWorkflowDecision("root","root",proposed.data!.occurrenceId,{outcome:"approve"},"orchestrator",{kind:"agent",id:"root"},()=>false).ok,false);
    const result = h.approve(proposed.data!); assert.ok(result.ok,result.error ?? "approval");
    const root = h.db.getSession("root")!;
    assert.deepEqual(root.orchestratorPolicy!.issueNumbers,[100,101]);
    assert.equal(root.orchestratorPolicy!.issueScope!.authorizedByUserId,h.principal.userId);
    assert.equal(root.orchestratorPolicy!.issueScope!.authorizedAt,1);
    assert.equal(root.orchestratorPolicy!.issueScope!.disposition!.bySessionId,"root");
    assert.equal(campaignBoundaryCurrent(root),true);
    const inherited = await h.svc.campaignIssueScope("child");
    assert.deepEqual(inherited.data!.issueNumbers,[100,101]);
    assert.equal((await h.svc.proposeCampaignIssueScope("child",{requestId:"nested",expectedRevision:2,additions:[],removals:[{repository:"team/repo",number:101}],explanation:"Nested removal"})).ok,false);
    assert.equal(result.data!.status,"consumed");
    assert.equal(h.db.workflowDecisionByOccurrence(other.data!.occurrenceId)!.status,"revoked");
    assert.equal(h.approve(proposed.data!).ok,false);
    assert.equal((await h.proposal("stale")).ok,false);
  } finally { h.db.close(); }
});

test("consumed scope changes fence a previously queued recovery turn under its original scope", async () => {
  const h = harness();
  try {
    const sent: unknown[] = [];
    h.hub.sendToRunner = (_id, message) => { sent.push(message); return true; };
    h.db.updateSessionStatus("root", "idle", 4);
    h.db.recordCampaignContinuationEvent({ campaignSessionId: "root", eventId: "old-scope-ready", kind: "child_ready", now: 5 });
    h.hub.isRunnerOnline = () => false;
    h.svc.retryDuePrompts(10000);
    const staged = h.db.latestCampaignContinuation("root")!;
    assert.ok(staged);
    const before = h.db.getSessionPromptCommand(staged.commandId)!.payloadJson;
    h.hub.isRunnerOnline = () => true;
    const proposed = await h.proposal("new-members");
    assert.ok(proposed.ok, proposed.error ?? "scope proposal refused");
    assert.ok(h.approve(proposed.data!).ok);
    assert.equal(h.db.workflowDecisionByOccurrence(proposed.data!.occurrenceId)!.status, "consumed");
    assert.equal(campaignBoundaryCurrent(h.db.getSession("root")!), true, "new scope is valid for future exact admissions");
    h.db.updateSessionStatus("root", "idle", 20000);
    h.svc.retryDuePrompts(30000);
    assert.equal(sent.some(m => (m as {commandId?:string}).commandId === staged.commandId), false,
      "scope consumption does not rebind an old staged turn");
    assert.equal(h.db.getSessionPromptCommand(staged.commandId)!.payloadJson, before);
    assert.equal(h.db.campaignProjection("root")!.recovery!.automation!.state, "authority_unavailable");
  } finally { h.db.close(); }
});

test("scope rejects incidental references, unapproved epics, foreign repositories, oversized scope and affected-work races", async () => {
  const h = harness();
  try {
    assert.equal((await h.proposal("dependency",999)).ok,false);
    for (const change of [{lineage:undefined},{lineage:{kind:"epic" as const,epic:999}},{additions:[{repository:"other/repo",number:101}]}]) {
      assert.equal((await h.svc.proposeCampaignIssueScope("root", {requestId:JSON.stringify(change),expectedRevision:1,additions:[{repository:"team/repo",number:101}],removals:[],explanation:"Claim",lineage:{kind:"epic",epic:100},...change})).ok,false);
    }
    const p = await h.proposal("race"); assert.ok(p.ok);
    h.db.createSession({id:"later",runnerId:"r",workspaceId:"w",agentId:"codex",title:"Later",parentSessionId:"root",driver:"codex-app-server",config:{},useWorktree:false,now:Date.now()});
    assert.equal(h.approve(p.data!).ok,false);
    assert.deepEqual(h.db.getSession("root")!.orchestratorPolicy!.issueNumbers,[100]);
  } finally { h.db.close(); }
  const limited = harness(true,1);
  try { assert.equal((await limited.proposal("capacity")).ok,false); } finally { limited.db.close(); }
});

/** Deliver the next campaign continuation the idle root is woken with, if any: its text, and
 * whether a prompt event woke it. The delivery completes, so a later one can follow. */
function nextContinuation(h: ReturnType<typeof harness>): { text: string; prompt: boolean } | null {
  h.db.updateSessionStatus("root", "idle", Date.now());
  const prompt = h.db.campaignContinuationPromptEventAt("root") !== null;
  const sent: Array<{ type: string; requestId?: string; commandId?: string; command?: { type: string; text?: string; campaignContinuation?: unknown } }> = [];
  h.hub.sendToRunner = (_id, message) => { sent.push(message as (typeof sent)[number]); return true; };
  h.svc.retryDuePrompts(Date.now() + 120_000);
  h.hub.sendToRunner = () => true;
  const delivery = sent.find((message) => message.type === "durable_session_command" && message.command?.campaignContinuation);
  if (!delivery) return null;
  assert.ok(h.svc.onDurablePromptReceipt("r", { type: "durable_session_command_result", requestId: delivery.requestId!,
    commandId: delivery.commandId!, sessionId: "root", state: "accepted", revision: 1, duplicate: false }));
  assert.ok(h.svc.onDurablePromptReceipt("r", { type: "durable_session_command_update", commandId: delivery.commandId!,
    sessionId: "root", state: "completed", revision: 2 }));
  return { text: delivery.command!.text!, prompt };
}

function requiredContinuation(h: ReturnType<typeof harness>): { text: string; prompt: boolean } {
  const continuation = nextContinuation(h);
  assert.ok(continuation, "a continuation was delivered");
  return continuation;
}

function revocationAudit(h: ReturnType<typeof harness>, sessionId: string, occurrenceId: string) {
  const entries = h.db.listGovernanceAudit(sessionId).filter((entry) => entry.requestId === occurrenceId && entry.outcome === "revoked");
  assert.equal(entries.length, 1);
  return entries[0]!;
}

test("#3916 a person's scope approval refused as stale is the system's revocation, with its reason and the person as trigger", async () => {
  const h = harness(false);
  try {
    const proposed = await h.proposal("stale-human"); assert.ok(proposed.ok, proposed.error ?? "proposal");
    const occurrenceId = proposed.data!.occurrenceId;
    assert.equal(proposed.data!.authority, "human");
    nextContinuation(h);
    h.db.updateSessionStatus("root", "running", Date.now());
    // Affected child work changes while the request waits for the person.
    h.db.createSession({ id: "later", runnerId: "r", workspaceId: "w", agentId: "codex", title: "Later", parentSessionId: "root",
      driver: "codex-app-server", config: {}, useWorktree: false, now: Date.now() });
    const refused = h.approve(proposed.data!);
    assert.equal(refused.ok, false);
    assert.equal(refused.status, 409);
    assert.equal(h.db.workflowDecisionByOccurrence(occurrenceId)!.status, "revoked");

    const resolution = h.db.campaignRequestResolution("root", campaignRequestToken("typed", "root", occurrenceId));
    assert.deepEqual({ outcome: resolution?.outcome, resolvedBy: resolution?.resolvedBy,
      revocationReason: resolution?.revocationReason, triggeredBy: resolution?.triggeredBy },
    { outcome: "revoked", resolvedBy: "system", revocationReason: "approval_refused_stale", triggeredBy: "human" });
    const audit = revocationAudit(h, "root", occurrenceId);
    assert.deepEqual(audit.actor, { kind: "system", id: "approval_refused_stale" });
    assert.deepEqual(audit.workflowDecision?.revocation,
      { reason: "approval_refused_stale", triggeredBy: { kind: "human", id: h.principal.userId } });

    const { text, prompt } = requiredContinuation(h);
    assert.match(text, new RegExp(`"kind":"request_resolved",.*"occurrenceId":"${occurrenceId}","owner":"human",.*` +
      `"outcome":"revoked","resolvedBy":"system","revocationReason":"approval_refused_stale","triggeredBy":"human"`, "u"));
    assert.doesNotMatch(text, /"resolvedBy":"human"/u, "the person approved; they did not revoke it");
    assert.equal(prompt, true, "a refused human approval wakes the Orchestrator as promptly as the approval would have");
    assert.match(text, /Action needed: yes/u);
  } finally { h.db.close(); }
});

test("#3916 decisions a person's scope approval revokes are reported as the system's, superseded by that change", async () => {
  const h = harness(false);
  try {
    const other = h.svc.createWorkflowDecision("child", { requestId: "question", resourceKey: "question",
      resourceSnapshot: { category: "implementation_question", question: "Which test?", options: [{ optionId: "a", label: "A" }, { optionId: "b", label: "B" }] } });
    assert.ok(other.ok, other.error ?? "question");
    assert.equal(other.data!.authority, "human");
    const proposed = await h.proposal("side-effect"); assert.ok(proposed.ok, proposed.error ?? "proposal");
    nextContinuation(h);
    h.db.updateSessionStatus("root", "running", Date.now());
    assert.ok(h.approve(proposed.data!).ok);
    const occurrenceId = other.data!.occurrenceId;
    assert.equal(h.db.workflowDecisionByOccurrence(occurrenceId)!.status, "revoked");

    const resolution = h.db.campaignRequestResolution("root", campaignRequestToken("typed", "child", occurrenceId));
    assert.deepEqual({ outcome: resolution?.outcome, resolvedBy: resolution?.resolvedBy,
      revocationReason: resolution?.revocationReason, triggeredBy: resolution?.triggeredBy },
    { outcome: "revoked", resolvedBy: "system", revocationReason: "superseded_by_scope_change", triggeredBy: "human" });
    const audit = revocationAudit(h, "child", occurrenceId);
    assert.deepEqual(audit.actor, { kind: "system", id: "superseded_by_scope_change" });
    assert.deepEqual(audit.workflowDecision?.revocation,
      { reason: "superseded_by_scope_change", triggeredBy: { kind: "human", id: h.principal.userId } });

    const { text } = requiredContinuation(h);
    assert.match(text, new RegExp(`"kind":"request_resolved",.*"occurrenceId":"${occurrenceId}","owner":"human",.*` +
      `"outcome":"revoked","resolvedBy":"system","revocationReason":"superseded_by_scope_change","triggeredBy":"human"`, "u"));
    assert.match(text, new RegExp(`"occurrenceId":"${proposed.data!.occurrenceId}","owner":"human",.*"outcome":"allowed","resolvedBy":"human"`, "u"),
      "the person's own approval is still theirs");
  } finally { h.db.close(); }
});

test("#3916 decisions the Orchestrator's own scope approval revokes record it as the trigger and do not wake it", async () => {
  const h = harness();
  try {
    const other = h.svc.createWorkflowDecision("child", { requestId: "question", resourceKey: "question",
      resourceSnapshot: { category: "implementation_question", question: "Which test?", options: [{ optionId: "a", label: "A" }, { optionId: "b", label: "B" }] } });
    assert.ok(other.ok, other.error ?? "question");
    const proposed = await h.proposal("orchestrator-side-effect"); assert.ok(proposed.ok, proposed.error ?? "proposal");
    assert.equal(proposed.data!.authority, "orchestrator");
    const eventsBefore = h.db.campaignContinuationEvents("root").length;
    assert.ok(h.approve(proposed.data!).ok);
    const occurrenceId = other.data!.occurrenceId;
    const token = campaignRequestToken("typed", "child", occurrenceId);
    const resolution = h.db.campaignRequestResolution("root", token);
    assert.deepEqual({ resolvedBy: resolution?.resolvedBy, revocationReason: resolution?.revocationReason, triggeredBy: resolution?.triggeredBy },
      { resolvedBy: "system", revocationReason: "superseded_by_scope_change", triggeredBy: "orchestrator" });
    assert.deepEqual(revocationAudit(h, "child", occurrenceId).workflowDecision?.revocation,
      { reason: "superseded_by_scope_change", triggeredBy: { kind: "agent", id: "root" } });
    assert.equal(h.db.campaignContinuationEvents("root").slice(eventsBefore)
      .some((event) => event.kind === "request_resolved" && event.occurrenceId === token), false,
    "the Orchestrator caused it and already has the result");
  } finally { h.db.close(); }
});

test("#3916 a person's denial of a scope change is still reported as theirs, with no revocation reason", async () => {
  const h = harness(false);
  try {
    const proposed = await h.proposal("human-denial"); assert.ok(proposed.ok, proposed.error ?? "proposal");
    const occurrenceId = proposed.data!.occurrenceId;
    nextContinuation(h);
    h.db.updateSessionStatus("root", "running", Date.now());
    assert.ok(h.svc.resolveWorkflowDecision("root", "root", occurrenceId, { outcome: "deny" }, "human",
      { kind: "human", id: h.principal.userId }, () => true).ok);
    const resolution = h.db.campaignRequestResolution("root", campaignRequestToken("typed", "root", occurrenceId));
    assert.equal(resolution?.resolvedBy, "human");
    assert.equal(resolution?.outcome, "denied");
    assert.equal(resolution?.revocationReason, undefined);
    assert.equal(resolution?.triggeredBy, undefined);
    const { text, prompt } = requiredContinuation(h);
    assert.match(text, new RegExp(`"occurrenceId":"${occurrenceId}","owner":"human",.*"outcome":"denied","resolvedBy":"human"\\}`, "u"));
    assert.equal(prompt, true);
  } finally { h.db.close(); }
});

test("Custom scope and closure stay human-owned, and old peers cannot execute the bounded issue contract", async () => {
  const h = harness(false);
  try {
    const p = await h.proposal("custom"); assert.ok(p.ok,p.error ?? "proposal"); assert.equal(p.data!.authority,"human");
    assert.ok(h.approve(p.data!).ok);
    const c = await h.svc.requestGithubIssueClosure("root",{requestId:"custom-closure",issue:100,reason:"completed",explanation:"Claim",evidence:["Claim"]});
    assert.ok(c.ok,c.error ?? "closure"); assert.equal(c.data!.decision!.authority,"human");
  } finally { h.db.close(); }
  for (const version of [215, 216]) {
    const older = harness();
    try {
      older.db.raw().prepare("UPDATE runners SET protocol_version=? WHERE runner_id='r'").run(version);
      assert.equal((await older.proposal(`old-${version}`)).ok,false);
    } finally { older.db.close(); }
  }
});

const body = "## Problem\nRelated failure\n## Proposed Behavior\nRepair it\n## Acceptance Criteria\n- Verified repair\n## Security and Compatibility\nNone";

async function consumedPublication(h: ReturnType<typeof harness>, title = "Lifecycle repair", issue = 101) {
  const rec=h.svc.recordCampaignFollowUp("root",{originSessionId:"child",repository:"team/repo",title,originWorkItemIds:[h.item.id]}); assert.ok(rec.ok);
  assert.ok(h.svc.adjudicateCampaignRecommendation("root",{recommendationId:rec.data!.id,disposition:"accepted",reason:"Observed related work",publicationRequired:true}).ok);
  const result=await h.svc.createWorkflowDecisionWithVideo("root",{requestId:`publish-${title}`,resourceKey:"publication",resourceSnapshot:{category:"follow_up_issue_publication",repository:"team/repo",
    sanitizedTitle:title,sanitizedBody:body,labels:[],recommendationId:rec.data!.id}}); assert.ok(result.ok);
  const decision=result.data!; assert.equal(decision.authority,"orchestrator"); assert.ok(h.approve(decision).ok);
  assert.ok((await h.svc.consumeWorkflowDecision("root",decision.occurrenceId,{resourceSnapshot:decision.resourceSnapshot})).ok);
  h.state.publicationTitles[issue]=title;
  assert.ok(h.svc.adjudicateCampaignRecommendation("root",{recommendationId:rec.data!.id,disposition:"accepted",reason:"Published payload read back",
    resultingWorkItemKey:`followup:${rec.data!.id}`,resultingIssue:{repository:"team/repo",number:issue}}).ok);
  return {decision,recommendationId:rec.data!.id};
}

test("compatible reauthorization can admit an earlier consumed publication exactly once", async () => {
  const h=harness(true,3);
  try {
    const p=await consumedPublication(h);
    assert.ok(h.svc.setCampaignControl("root",{mode:"full_control",objective:"Implement epic 100",operations:["campaign_issue_scope","follow_up_issue_publication"],delegatablePolicyIds:[],
      issueAuthority:{epics:[100],relatedFollowUps:true,maxIssues:3,closureReasons:[]}},2,h.principal).ok);
    const scope=await h.svc.proposeCampaignIssueScope("root",{requestId:"renewed-publication",expectedRevision:1,additions:[{repository:"team/repo",number:101}],removals:[],explanation:"Compatible original publication authority",
      lineage:{kind:"follow_up",publicationOccurrenceId:p.decision.occurrenceId}}); assert.ok(scope.ok,scope.error ?? "renewed scope"); assert.ok(h.approve(scope.data!).ok);
    assert.equal(h.db.admittedCampaignPublicationIssue("root",p.decision.occurrenceId),101);
    h.state.publicationTitles[102]="Lifecycle repair";
    assert.ok(h.svc.adjudicateCampaignRecommendation("root",{recommendationId:p.recommendationId,disposition:"accepted",reason:"Duplicate payload claim",
      resultingWorkItemKey:`duplicate:${p.recommendationId}`,resultingIssue:{repository:"team/repo",number:102}}).ok);
    const reuse=await h.svc.proposeCampaignIssueScope("root",{requestId:"reuse-lineage",expectedRevision:2,additions:[{repository:"team/repo",number:102}],removals:[],explanation:"Same payload on another issue",
      lineage:{kind:"follow_up",publicationOccurrenceId:p.decision.occurrenceId}});
    assert.equal(reuse.ok,false); assert.match(reuse.error ?? "",/unused|already/);
  } finally {h.db.close();}
});

test("reauthorization counts reservations, while fresh human verified scope settles an earlier publication", async () => {
  const h=harness(true,2);
  try {
    const p=await consumedPublication(h);
    const other=(requestId:string)=>h.svc.proposeCampaignIssueScope("root",{requestId,expectedRevision:1,additions:[{repository:"team/repo",number:999}],removals:[],explanation:"Human adds separate scope"},()=>true,h.principal);
    // A Human approval re-mints the boundary (#2940) only within its issue limit, which counts the
    // consumed publication's slot: one scoped issue, that held slot and #999 would make three.
    const added=await other("human-other"); assert.ok(added.ok);
    const refused=h.approve(added.data!); assert.equal(refused.ok,false);
    assert.match(refused.error!,/give the campaign 3 issues, counting 1 published follow-up not yet in scope, more than the 2/);
    assert.deepEqual(h.db.getSession("root")!.orchestratorPolicy!.issueNumbers,[100]);
    const proposal={mode:"full_control" as const,objective:"Implement epic 100",operations:["campaign_issue_scope","follow_up_issue_publication"] as Array<"campaign_issue_scope"|"follow_up_issue_publication">,delegatablePolicyIds:[],
      issueAuthority:{epics:[100],relatedFollowUps:true,maxIssues:2,closureReasons:[]}};
    assert.ok(h.svc.setCampaignControl("root",{...proposal,issueAuthority:{...proposal.issueAuthority,maxIssues:3}},2,h.principal).ok);
    const readded=await other("human-other-again"); assert.ok(readded.ok,readded.error ?? "proposal"); assert.ok(h.approve(readded.data!).ok);
    // Right after the Human approval, the re-minted boundary holds the scope and every held slot.
    const root=h.db.getSession("root")!;
    const boundary=(root.orchestratorPolicy!.control as Extract<CampaignControl,{mode:"full_control"}>).boundary;
    assert.equal(campaignBoundaryCurrent(root),true); assert.equal(root.parentControlPolicy!.revision,4);
    assert.equal(root.orchestratorPolicy!.issueNumbers!.length+h.db.unsettledPublicationSlots("root"),3);
    assert.ok(root.orchestratorPolicy!.issueNumbers!.length+h.db.unsettledPublicationSlots("root")<=boundary.issueAuthority!.maxIssues);
    assert.equal(h.svc.setCampaignControl("root",proposal,4,h.principal).error,"The issue boundary exceeds its human-set scope limit.","scope plus the consumed unscoped slot exceeds two");
    // Adopting the published issue itself settles its slot, so it fits the same limit.
    const direct=await h.svc.proposeCampaignIssueScope("root",{requestId:"human-published",expectedRevision:2,additions:[{repository:"team/repo",number:101}],removals:[],explanation:"Human explicitly adopts the verified publication"},()=>true,h.principal);
    assert.ok(direct.ok,direct.error ?? "human publication scope"); assert.equal(direct.data!.authority,"human");
    const adopted=h.approve(direct.data!); assert.ok(adopted.ok,adopted.error ?? "adoption");
    assert.equal(h.db.admittedCampaignPublicationIssue("root",p.decision.occurrenceId),101,"independent read-back and human consumption settle the slot");
  } finally {h.db.close();}
});

test("a changed objective cannot inherit old publication authority automatically", async () => {
  const h=harness(true,2);
  try {
    const p=await consumedPublication(h);
    assert.ok(h.svc.setCampaignControl("root",{mode:"full_control",objective:"A different objective",operations:["campaign_issue_scope","follow_up_issue_publication"],delegatablePolicyIds:[],
      issueAuthority:{epics:[100],relatedFollowUps:true,maxIssues:2,closureReasons:[]}},2,h.principal).ok);
    const scope=await h.svc.proposeCampaignIssueScope("root",{requestId:"changed-objective",expectedRevision:1,additions:[{repository:"team/repo",number:101}],removals:[],explanation:"Old authority cannot grant the new objective",
      lineage:{kind:"follow_up",publicationOccurrenceId:p.decision.occurrenceId}});
    assert.equal(scope.ok,false); assert.match(scope.error ?? "",/human\/objective/);
  } finally {h.db.close();}
});

test("reauthorization excludes pending publication slots that it atomically revokes", async () => {
  const h=harness(true,2);
  try {
    const rec=h.svc.recordCampaignFollowUp("root",{originSessionId:"child",repository:"team/repo",title:"Pending repair",originWorkItemIds:[h.item.id]}); assert.ok(rec.ok);
    assert.ok(h.svc.adjudicateCampaignRecommendation("root",{recommendationId:rec.data!.id,disposition:"accepted",reason:"Observed related work",publicationRequired:true}).ok);
    const pending=await h.svc.createWorkflowDecisionWithVideo("root",{requestId:"pending-slot",resourceKey:"publication",resourceSnapshot:{category:"follow_up_issue_publication",repository:"team/repo",
      sanitizedTitle:"Pending repair",sanitizedBody:body,labels:[],recommendationId:rec.data!.id}}); assert.ok(pending.ok); assert.ok(h.approve(pending.data!).ok);
    const changed=h.svc.setCampaignControl("root",{mode:"full_control",objective:"Implement epic 100",operations:["campaign_issue_scope","follow_up_issue_publication"],delegatablePolicyIds:[],
      issueAuthority:{epics:[100],relatedFollowUps:true,maxIssues:1,closureReasons:[]}},2,h.principal);
    assert.ok(changed.ok,changed.error ?? "reauthorization");
    assert.equal(h.db.workflowDecisionByOccurrence(pending.data!.occurrenceId)!.status,"revoked");
  } finally {h.db.close();}
});

test("human verified scope settles a consumed publication without delegated admission", async () => {
  const h=harness(true,2);
  try {
    const p=await consumedPublication(h);
    const held=()=>h.db.getSession("root")!.orchestratorPolicy!.issueNumbers!.length+h.db.unsettledPublicationSlots("root");
    // A follow-up lineage the caller names settles nothing by itself (#2940): unrelated #999 claiming
    // the publication carries no verified payload or issue admission, so its slot still counts.
    const claimed=await h.svc.proposeCampaignIssueScope("root",{requestId:"claimed-lineage",expectedRevision:1,additions:[{repository:"team/repo",number:999}],removals:[],
      explanation:"An unrelated issue claiming the publication",lineage:{kind:"follow_up",publicationOccurrenceId:p.decision.occurrenceId}},()=>true,h.principal);
    assert.ok(claimed.ok,claimed.error ?? "claimed lineage proposal"); assert.equal(claimed.data!.authority,"human");
    const claim=claimed.data!.resourceSnapshot as Extract<WorkflowDecisionView["resourceSnapshot"],{category:"campaign_issue_scope"}>;
    assert.equal(claim.verifiedPublications,undefined); assert.equal(claim.issueAdmission,undefined);
    const refused=h.approve(claimed.data!); assert.equal(refused.ok,false);
    assert.match(refused.error!,/give the campaign 3 issues, counting 1 published follow-up not yet in scope, more than the 2/);
    assert.equal(held(),2); assert.equal(h.db.admittedCampaignPublicationIssue("root",p.decision.occurrenceId),null);
    assert.ok(h.svc.resolveWorkflowDecision("root","root",claimed.data!.occurrenceId,{outcome:"deny"},"human",{kind:"human",id:h.principal.userId},()=>true).ok);
    const direct=await h.svc.proposeCampaignIssueScope("root",{requestId:"human-settlement",expectedRevision:1,additions:[{repository:"team/repo",number:101}],removals:[],explanation:"Human adopts the exact published payload"},()=>true,h.principal);
    assert.ok(direct.ok); assert.equal(direct.data!.authority,"human"); assert.ok(h.approve(direct.data!).ok);
    assert.equal(h.db.admittedCampaignPublicationIssue("root",p.decision.occurrenceId),101);
    assert.ok(held()<=2,"scope and held slots never exceed the limit");
  } finally {h.db.close();}
});

test("one consumed publication cannot admit a second issue with copied payload", async () => {
  const h=harness(true,3);
  try {
    const p=await consumedPublication(h);
    const first=await h.svc.proposeCampaignIssueScope("root",{requestId:"first-lineage",expectedRevision:1,additions:[{repository:"team/repo",number:101}],removals:[],explanation:"Verified publication",
      lineage:{kind:"follow_up",publicationOccurrenceId:p.decision.occurrenceId}}); assert.ok(first.ok); assert.ok(h.approve(first.data!).ok);
    h.state.publicationTitles[102]="Lifecycle repair";
    assert.ok(h.svc.adjudicateCampaignRecommendation("root",{recommendationId:p.recommendationId,disposition:"accepted",reason:"Copied payload claim",
      resultingWorkItemKey:`copy:${p.recommendationId}`,resultingIssue:{repository:"team/repo",number:102}}).ok);
    const second=await h.svc.proposeCampaignIssueScope("root",{requestId:"second-lineage",expectedRevision:2,additions:[{repository:"team/repo",number:102}],removals:[],explanation:"Copied exact payload",
      lineage:{kind:"follow_up",publicationOccurrenceId:p.decision.occurrenceId}});
    assert.equal(second.ok,false); assert.match(second.error ?? "",/unused|already/);
  } finally {h.db.close();}
});

test("non-delegatable recommendation metadata and closure comments retain human review", async () => {
  const h=harness(false);
  try {
    const result=await h.svc.createWorkflowDecisionWithVideo("child",{requestId:"custom-recommendation",resourceKey:"custom-pub",resourceSnapshot:{category:"follow_up_issue_publication",repository:"team/repo",
      sanitizedTitle:"Custom review",sanitizedBody:body,labels:[],recommendationId:"claim-only"}});
    assert.ok(result.ok,result.error ?? "custom request"); assert.equal(result.data!.authority,"human");
  } finally {h.db.close();}
  const full=harness();
  try {
    const result=await full.svc.requestGithubIssueClosure("root",{requestId:"comment-review",issue:100,reason:"completed",explanation:"Owner reviews the exact comment",evidence:["Human review"],comment:"Contact support@example.invalid"});
    assert.ok(result.ok,result.error ?? "human comment"); assert.equal(result.data!.decision!.authority,"human");
  } finally {full.db.close();}
});

test("publication requires an accepted unique related recommendation, exact sanitized payload, fresh duplicates and one-shot capacity", async () => {
  const h = harness();
  try {
    const record = h.svc.recordCampaignFollowUp("root",{originSessionId:"child",repository:"team/repo",title:"Related repair",originWorkItemIds:[h.item.id]});
    assert.ok(record.ok,record.error ?? "record");
    const id = record.data!.id;
    assert.ok(h.svc.adjudicateCampaignRecommendation("root",{recommendationId:id,disposition:"accepted",reason:"Same objective, observed regression",publicationRequired:true}).ok);
    const snapshot = {category:"follow_up_issue_publication" as const,repository:"team/repo",sanitizedTitle:"Related repair",sanitizedBody:body,labels:[],recommendationId:id};
    const privatePayload=await h.svc.createWorkflowDecisionWithVideo("root",{requestId:"secret",resourceKey:"secret",resourceSnapshot:{...snapshot,sanitizedBody:body+"\napi_key=secret-value"}});
    assert.ok(privatePayload.ok); assert.equal(privatePayload.data!.authority,"human","unsafe content never gains standing admission");
    h.state.publicationOk=false;
    const duplicate=await h.svc.createWorkflowDecisionWithVideo("root",{requestId:"duplicate",resourceKey:"pub",resourceSnapshot:snapshot});
    assert.ok(duplicate.ok); assert.equal(duplicate.data!.authority,"human");
    h.state.publicationOk=true;
    const p = await h.svc.createWorkflowDecisionWithVideo("root",{requestId:"publication",resourceKey:"pub",resourceSnapshot:snapshot}); assert.ok(p.ok,p.error ?? "publication");
    assert.equal(h.svc.createWorkflowDecision("root",{requestId:"spoof-admission",resourceKey:"spoof",resourceSnapshot:p.data!.resourceSnapshot}).status,403,
      "an echo of server admission cannot be supplied to generic create");
    assert.equal(p.data!.authority,"orchestrator"); assert.ok(h.approve(p.data!).ok);
    h.state.publicationOk=false;
    assert.equal((await h.svc.consumeWorkflowDecision("root",p.data!.occurrenceId,{resourceSnapshot:p.data!.resourceSnapshot})).ok,false);
    h.state.publicationOk=true;
    assert.ok((await h.svc.consumeWorkflowDecision("root",p.data!.occurrenceId,{resourceSnapshot:p.data!.resourceSnapshot})).ok);
    const replay=await h.svc.createWorkflowDecisionWithVideo("root",{requestId:"replay-pub",resourceKey:"pub",resourceSnapshot:snapshot});
    assert.ok(replay.ok); assert.equal(replay.data!.authority,"human","spent recommendations never mint another standing grant");
  } finally { h.db.close(); }
});

const bugBody = "## Problem\nRelated failure\n## Reproduction Steps\n1. Run it\n## Actual Behavior\nFails\n## Expected Behavior\nPasses\n## Environment\nLinux\n## Acceptance Criteria\n- Verified repair";

function acceptedRecommendation(h: ReturnType<typeof harness>, title = "Related repair") {
  const record = h.svc.recordCampaignFollowUp("root",{originSessionId:"child",repository:"team/repo",title,originWorkItemIds:[h.item.id]});
  assert.ok(record.ok,record.error ?? "record");
  assert.ok(h.svc.adjudicateCampaignRecommendation("root",{recommendationId:record.data!.id,disposition:"accepted",reason:"Observed related work",publicationRequired:true}).ok);
  return record.data!.id;
}

// #2940, observed live: Full Control children drafted accepted follow-ups and requested them with
// their recommendationId. The issue-form "[Bug]: " prefix and the child requester each refused
// admission silently, so the person was asked to approve in-boundary publications.
test("a child's accepted, in-scope publication with an issue-form title prefix is Orchestrator-owned and consumable (#2940)", async () => {
  const h = harness();
  try {
    const recommendationId = acceptedRecommendation(h);
    for (const [requestId, title, issueBody, labels] of [["feature-form", "[Feature]: Related repair", body, ["enhancement", "UI"]], ["bug-form", "[Bug]: Related repair", bugBody, ["bug"]]] as const) {
      const snapshot = {category:"follow_up_issue_publication" as const,repository:"team/repo",sanitizedTitle:title,sanitizedBody:issueBody,labels:[...labels],recommendationId};
      const p = await h.svc.createWorkflowDecisionWithVideo("child",{requestId,resourceKey:requestId,resourceSnapshot:snapshot});
      assert.ok(p.ok,p.error ?? requestId);
      const decision = p.data!;
      assert.equal(decision.controllingSessionId,"root");
      assert.equal(decision.authority,"orchestrator",JSON.stringify(decision.authorityEvaluation));
      assert.deepEqual([decision.authorityEvaluation?.basis,decision.authorityEvaluation?.reason],["campaign_delegation","authorized_operation"]);
      assert.equal(decision.authorityEvaluation?.admissionFailure,undefined);
      assert.ok(decision.resourceSnapshot.category === "follow_up_issue_publication" && decision.resourceSnapshot.recommendationId === recommendationId &&
        decision.resourceSnapshot.issueAdmission, "the recommendation lineage and server admission are retained");
      if (requestId === "bug-form") {
        assert.ok(h.svc.resolveWorkflowDecision("root","child",decision.occurrenceId,{outcome:"approve"},"orchestrator",{kind:"agent",id:"root"},()=>true).ok);
        const consumed = await h.svc.consumeWorkflowDecision("child",decision.occurrenceId,{resourceSnapshot:decision.resourceSnapshot});
        assert.ok(consumed.ok,consumed.error ?? "consume");
      }
    }
    const replay = await h.svc.createWorkflowDecisionWithVideo("child",{requestId:"replay",resourceKey:"replay",
      resourceSnapshot:{category:"follow_up_issue_publication",repository:"team/repo",sanitizedTitle:"Related repair",sanitizedBody:body,labels:[],recommendationId}});
    assert.ok(replay.ok); assert.equal(replay.data!.authority,"human","a consumed recommendation never mints a second standing grant");
    assert.equal(replay.data!.authorityEvaluation?.admissionFailure,"recommendation_spent");
  } finally { h.db.close(); }
});

test("every bounded publication needs a runner whose duplicate search and comparison ignore the tag (#2940)", async () => {
  // An older runner keeps the tag on both sides of its duplicate check. A tagged title can hide an
  // older untagged issue from its search; an untagged one misses an existing "[Bug]: Subject"
  // issue in its comparison. Either way its successful inspection proves no deduplication.
  for (const [recommendationTitle, payloadTitle] of [["Related repair", "[Bug]: Related repair"], ["[Bug]: Related repair", "Related repair"]] as const) {
    const h = harness();
    try {
      const recommendationId = acceptedRecommendation(h, recommendationTitle);
      const request = (requestId: string) => h.svc.createWorkflowDecisionWithVideo("child",{requestId,resourceKey:requestId,
        resourceSnapshot:{category:"follow_up_issue_publication",repository:"team/repo",sanitizedTitle:payloadTitle,sanitizedBody:body,labels:[],recommendationId}});
      h.state.subjectSearch = false;
      const older = await request("older-runner");
      assert.ok(older.ok,payloadTitle); assert.equal(older.data!.authority,"human",payloadTitle);
      assert.equal(older.data!.authorityEvaluation?.admissionFailure,"inspection_failed",payloadTitle);
      h.state.subjectSearch = true;
      const current = await request("subject-runner");
      assert.ok(current.ok,payloadTitle); assert.equal(current.data!.authority,"orchestrator",payloadTitle);
      assert.ok(h.svc.resolveWorkflowDecision("root","child",current.data!.occurrenceId,{outcome:"approve"},"orchestrator",{kind:"agent",id:"root"},()=>true).ok);
      h.state.subjectSearch = false;
      assert.equal((await h.svc.consumeWorkflowDecision("child",current.data!.occurrenceId,{resourceSnapshot:current.data!.resourceSnapshot})).ok,false,
        `${payloadTitle}: consumption after a runner downgrade repeats the requirement`);
      h.state.subjectSearch = true;
      assert.ok((await h.svc.consumeWorkflowDecision("child",current.data!.occurrenceId,{resourceSnapshot:current.data!.resourceSnapshot})).ok,payloadTitle);
    } finally { h.db.close(); }
  }
});

test("a child's publication outside the proof routes to the person with a visible admission failure (#2940)", async () => {
  const cases: Array<{ name: string; expected: string; maximum?: number; setup?: (h: ReturnType<typeof harness>) => string;
    change?: (snapshot: { sanitizedTitle: string; sanitizedBody: string; labels: string[]; recommendationId: string }) => void }> = [
    { name: "forged", expected: "recommendation_not_found", setup: () => "followup_forged" },
    { name: "unaccepted", expected: "recommendation_not_accepted", setup: (h) => {
      const record = h.svc.recordCampaignFollowUp("root",{originSessionId:"child",repository:"team/repo",title:"Related repair",originWorkItemIds:[h.item.id]});
      assert.ok(record.ok); return record.data!.id;
    } },
    { name: "other title", expected: "title_mismatch", change: (s) => { s.sanitizedTitle = "[Bug]: A different repair"; } },
    { name: "unsafe", expected: "unsafe_payload", change: (s) => { s.sanitizedBody += "\napi_key=secret-value"; } },
    { name: "duplicate labels", expected: "unsafe_payload", change: (s) => { s.labels = ["bug", "bug"]; } },
    { name: "over cap", expected: "capacity_exhausted", maximum: 1 },
  ];
  for (const c of cases) {
    const h = harness(true, c.maximum ?? 5);
    try {
      const recommendationId = c.setup ? c.setup(h) : acceptedRecommendation(h);
      const snapshot = { sanitizedTitle: "[Feature]: Related repair", sanitizedBody: body, labels: ["enhancement"], recommendationId };
      c.change?.(snapshot);
      const p = await h.svc.createWorkflowDecisionWithVideo("child",{requestId:c.name,resourceKey:c.name,
        resourceSnapshot:{category:"follow_up_issue_publication",repository:"team/repo",...snapshot}});
      assert.ok(p.ok,`${c.name}: ${p.error}`);
      assert.equal(p.data!.authority,"human",c.name);
      assert.equal(p.data!.authorityEvaluation?.admissionFailure,c.expected,c.name);
      assert.ok(p.data!.resourceSnapshot.category === "follow_up_issue_publication" && p.data!.resourceSnapshot.recommendationId === recommendationId &&
        !p.data!.resourceSnapshot.issueAdmission, `${c.name}: an unproven claim is kept as sent (#3918) and carries no admission`);
    } finally { h.db.close(); }
  }
  const failedInspection = harness();
  try {
    const recommendationId = acceptedRecommendation(failedInspection);
    failedInspection.state.publicationOk = false;
    const p = await failedInspection.svc.createWorkflowDecisionWithVideo("child",{requestId:"duplicate",resourceKey:"duplicate",
      resourceSnapshot:{category:"follow_up_issue_publication",repository:"team/repo",sanitizedTitle:"Related repair",sanitizedBody:body,labels:[],recommendationId}});
    assert.ok(p.ok); assert.equal(p.data!.authority,"human");
    assert.equal(p.data!.authorityEvaluation?.admissionFailure,"inspection_failed");
  } finally { failedInspection.db.close(); }
});

test("a follow-up past the approval limit cannot be published until the person admits it, and its slot then holds the issue (#2940)", async () => {
  const h = harness(true, 1);
  try {
    // A Human allowance that admits no follow-up without approval, on a scope already at its Maximum Issues.
    const budgetAuthority = { version: 1 as const, concurrency: 3, acceptedFollowUps: 0, accounting: "managed_workers_only" as const, unpriced: "stop" as const };
    const policy = h.db.getSession("root")!.orchestratorPolicy!;
    assert.equal(policy.control?.mode, "full_control");
    if (policy.control?.mode === "full_control") policy.control.boundary.budgetAuthority = budgetAuthority;
    h.db.raw().prepare("UPDATE sessions SET orchestrator_policy=? WHERE id='root'").run(JSON.stringify(policy));
    h.db.campaignBudgets.authorize("root", budgetAuthority);
    assert.equal(campaignBoundaryCurrent(h.db.getSession("root")!), true);

    const record = h.svc.recordCampaignFollowUp("root", { originSessionId: "child", repository: "team/repo", title: "Related repair", originWorkItemIds: [h.item.id] });
    assert.ok(record.ok, record.error ?? "record");
    const recommendationId = record.data!.id;
    const accept = () => h.svc.adjudicateCampaignRecommendation("root", { recommendationId, disposition: "accepted", reason: "Observed related work", publicationRequired: true });
    const publish = (requestId: string) => h.svc.createWorkflowDecisionWithVideo("child", { requestId, resourceKey: requestId,
      resourceSnapshot: { category: "follow_up_issue_publication", repository: "team/repo", sanitizedTitle: "[Feature]: Related repair", sanitizedBody: body,
        labels: ["enhancement"], recommendationId } });

    const over = accept();
    assert.equal(over.ok, false);
    assert.equal(over.status, 409);
    const occurrenceId = /decision (workflow_[a-f0-9]+)/u.exec(over.error ?? "")?.[1];
    assert.ok(occurrenceId, over.error ?? "refusal");

    // Publication is no way around the follow-up approval: the recommendation is not accepted yet.
    const early = await publish("early");
    assert.ok(early.ok, early.error ?? "publication");
    assert.equal(early.data!.authority, "human");
    assert.equal(early.data!.authorityEvaluation?.admissionFailure, "recommendation_not_accepted");

    const admission = h.db.workflowDecisionByOccurrence(occurrenceId)!;
    assert.equal(admission.category, "campaign_follow_up_admission");
    assert.ok(h.approve(admission).ok, "the person admits the follow-up");
    assert.ok(accept().ok, "accepting it again admits it once");
    assert.equal(h.db.campaignIssueLimit("root", 1), 2, "the admitted follow-up holds one issue slot past Maximum Issues");

    // In the boundary and within the admitted slot, the child's publication is the Orchestrator's.
    const admitted = await publish("admitted");
    assert.ok(admitted.ok, admitted.error ?? "publication");
    assert.equal(admitted.data!.authorityEvaluation?.admissionFailure, undefined);
    assert.equal(admitted.data!.authority, "orchestrator");
  } finally { h.db.close(); }
});

test("bounded not-planned closure needs a recorded supported disposition and keeps uncertain dispatch unreplayable", async () => {
  const h = harness();
  const request = {requestId:"closure",issue:100,reason:"not_planned" as const,explanation:"Supported retirement",evidence:["Recorded cancellation"]};
  try {
    const fallback=await h.svc.requestGithubIssueClosure("root",{...request,requestId:"missing-disposition"});
    assert.ok(fallback.ok); assert.equal(fallback.data!.decision!.authority,"human");
    assert.ok(h.svc.updateCampaignWorkItem("root",{workItemId:h.item.id,commitment:{state:"cancelled",reason:"Replaced by a verified alternative"}}).ok);
    h.state.openPR=true;
    const conflict=await h.svc.requestGithubIssueClosure("root",{...request,requestId:"conflict"});
    assert.ok(conflict.ok); assert.equal(conflict.data!.decision!.authority,"human"); h.state.openPR=false;
    const c = await h.svc.requestGithubIssueClosure("root",request); assert.ok(c.ok,c.error ?? "closure");
    const d = c.data!.decision!; assert.equal(d.authority,"orchestrator"); assert.ok(h.approve(d).ok);
    const executed = await h.svc.executeGithubIssueClosure("root",d.occurrenceId,d.resourceDigest); assert.ok(executed.ok,executed.error ?? "execution");
    assert.equal(executed.data!.issueClosureResult!.outcome,"uncertain");
    assert.equal((await h.svc.executeGithubIssueClosure("root",d.occurrenceId,d.resourceDigest)).ok,false);
    assert.equal(h.state.executes,1);
    const recovery = new CampaignRecoveryService(h.db, () => {}, { info() {} });
    recovery.maintain(Date.now());
    const later = h.svc.createWorkflowDecision("root", { requestId: "later-choice", resourceKey: d.resourceKey,
      resourceSnapshot: { category: "implementation_question", question: "Which separate repair should run?",
        options: [{ optionId: "a", label: "A" }, { optionId: "b", label: "B" }] } });
    assert.ok(later.ok, later.error ?? "later exact question refused");
    assert.ok(h.db.campaignRecoverySettledDecisions("root").some(item => item.occurrenceId === d.occurrenceId),
      "a newer same-key occurrence cannot supersede an uncertain consumed mutation");
    recovery.maintain(Date.now());
    const original = h.db.campaignProjection("root")!.recovery!.records.find(record =>
      record.resource.occurrenceId === recoveryCoordinate(d.occurrenceId))!;
    assert.equal(original.reason, "uncertain_outcome");
    assert.equal(original.effectiveOwner, "human");
    assert.equal(original.requiredInput, "reconcile_original_outcome");
    assert.equal(h.state.executes, 1, "recovery never replays the uncertain closure");
  } finally { h.db.close(); }
});

test("a human-owned recovery exception makes the campaign Waiting for a Person in detail and summary (#2938)", async () => {
  const h = harness();
  try {
    assert.ok(h.svc.updateCampaignWorkItem("root",{workItemId:h.item.id,commitment:{state:"cancelled",reason:"Replaced by a verified alternative"}}).ok);
    const c = await h.svc.requestGithubIssueClosure("root",{requestId:"closure",issue:100,reason:"not_planned",
      explanation:"Supported retirement",evidence:["Recorded cancellation"]});
    assert.ok(c.ok, c.error ?? "closure"); const d = c.data!.decision!; assert.ok(h.approve(d).ok);
    const executed = await h.svc.executeGithubIssueClosure("root",d.occurrenceId,d.resourceDigest);
    assert.equal(executed.data!.issueClosureResult!.outcome,"uncertain");
    // An unverified child at rest with nothing pending would otherwise read as an active campaign.
    for (const id of ["root", "child"]) h.db.updateSessionStatus(id, "idle", Date.now());
    assert.equal(h.db.getSession("child")!.pendingApproval, null);
    new CampaignRecoveryService(h.db, () => {}, { info() {} }).maintain(Date.now());
    const projection = h.db.campaignProjection("root")!;
    const record = projection.recovery!.records.find(item => item.resource.occurrenceId === recoveryCoordinate(d.occurrenceId))!;
    assert.deepEqual([record.effectiveOwner, record.state, record.reason], ["human", "waiting_human", "uncertain_outcome"]);
    assert.equal(projection.pendingRequests?.human ?? 0, 0, "no request is pending; only the recovery exception waits");
    assert.equal(projection.status, "waiting_human");
    assert.equal(h.db.campaignStatusOnly("root"), "waiting_human");
    const summary = h.db.listSessionSummaries().find(session => session.id === "root")!;
    assert.deepEqual([summary.projection, summary.fullControlCampaignStatus], ["summary", "waiting_human"],
      "summary rows, which carry no recovery records, read the same status");
    assert.equal(h.db.getSession("root")!.fullControlCampaignStatus, "waiting_human");
  } finally { h.db.close(); }
});

test("pending and consumed publications reserve capacity against other publications and epic scope changes", async () => {
  const h=harness(true,2);
  try {
    let firstRecommendation="";
    const make=async (title:string)=> {
      const rec=h.svc.recordCampaignFollowUp("root",{originSessionId:"child",repository:"team/repo",title,originWorkItemIds:[h.item.id]}); assert.ok(rec.ok);
      assert.ok(h.svc.adjudicateCampaignRecommendation("root",{recommendationId:rec.data!.id,disposition:"accepted",reason:"Observed related work",publicationRequired:true}).ok);
      if(title==="First repair") firstRecommendation=rec.data!.id;
      return h.svc.createWorkflowDecisionWithVideo("root",{requestId:title,resourceKey:title,resourceSnapshot:{category:"follow_up_issue_publication",repository:"team/repo",sanitizedTitle:title,sanitizedBody:body,labels:[],recommendationId:rec.data!.id}});
    };
    const first=await make("First repair"); assert.ok(first.ok,first.error ?? "first reservation");
    const second=await make("Second repair"); assert.ok(second.ok); assert.equal(second.data!.authority,"human");
    assert.equal((await h.proposal("epic-slot")).ok,false);
    assert.ok(h.approve(first.data!).ok);
    assert.ok((await h.svc.consumeWorkflowDecision("root",first.data!.occurrenceId,{resourceSnapshot:first.data!.resourceSnapshot})).ok);
    assert.ok(h.svc.adjudicateCampaignRecommendation("root",{recommendationId:firstRecommendation,disposition:"accepted",reason:"Unverified tracker claim",
      resultingWorkItemKey:`followup:${firstRecommendation}`,resultingIssue:{repository:"team/repo",number:100}}).ok);
    const third=await make("Third repair"); assert.ok(third.ok); assert.equal(third.data!.authority,"human","ledger claims cannot free a standing slot");
  } finally {h.db.close();}
});

test("authenticated human scope proposals preserve direct human narrowing and expansion under Full Control", async () => {
  const h=harness();
  try {
    const proposed=await h.svc.proposeCampaignIssueScope("root",{requestId:"human-add",expectedRevision:1,additions:[{repository:"team/repo",number:999}],removals:[],explanation:"Fresh human scope expansion"},()=>true,h.principal);
    assert.ok(proposed.ok,proposed.error ?? "human proposal"); assert.equal(proposed.data!.authority,"human");
    assert.ok(h.approve(proposed.data!).ok);
    const narrowed=await h.svc.proposeCampaignIssueScope("root",{requestId:"human-remove",expectedRevision:2,additions:[],removals:[{repository:"team/repo",number:999}],explanation:"Human narrowing"},()=>true,h.principal);
    assert.ok(narrowed.ok,narrowed.error ?? "human narrowing"); assert.equal(narrowed.data!.authority,"human");
    assert.ok(h.approve(narrowed.data!).ok);
    const closure=await h.svc.requestGithubIssueClosure("root",{requestId:"human-exception",issue:100,reason:"completed",explanation:"Owner reviews umbrella completion",evidence:["Human review"]});
    assert.ok(closure.ok,closure.error ?? "human closure"); assert.equal(closure.data!.decision!.authority,"human");
    assert.ok(h.approve(closure.data!.decision!).ok);
  } finally {h.db.close();}
});

test("a reservation settles only after exact inspected publication lineage is consumed into scope", async () => {
  const h=harness(true,2);
  try {
    const rec=h.svc.recordCampaignFollowUp("root",{originSessionId:"child",repository:"team/repo",title:"Verified repair",originWorkItemIds:[h.item.id]}); assert.ok(rec.ok);
    assert.ok(h.svc.adjudicateCampaignRecommendation("root",{recommendationId:rec.data!.id,disposition:"accepted",reason:"Related observed work",publicationRequired:true}).ok);
    const publication=await h.svc.createWorkflowDecisionWithVideo("root",{requestId:"verified-publication",resourceKey:"pub",resourceSnapshot:{category:"follow_up_issue_publication",repository:"team/repo",
      sanitizedTitle:"Verified repair",sanitizedBody:body,labels:[],recommendationId:rec.data!.id}}); assert.ok(publication.ok);
    const d=publication.data!; assert.ok(h.approve(d).ok); assert.ok((await h.svc.consumeWorkflowDecision("root",d.occurrenceId,{resourceSnapshot:d.resourceSnapshot})).ok);
    assert.ok(h.svc.adjudicateCampaignRecommendation("root",{recommendationId:rec.data!.id,disposition:"accepted",reason:"Read-back payload verified",resultingWorkItemKey:`followup:${rec.data!.id}`,
      resultingIssue:{repository:"team/repo",number:101}}).ok);
    assert.equal(h.db.admittedCampaignPublicationIssue("root",d.occurrenceId),null,"ledger read-back alone is still a claim");
    const scope=await h.svc.proposeCampaignIssueScope("root",{requestId:"verified-published-scope",expectedRevision:1,additions:[{repository:"team/repo",number:101}],removals:[],
      explanation:"Exact payload and related origin independently inspected",lineage:{kind:"follow_up",publicationOccurrenceId:d.occurrenceId}}); assert.ok(scope.ok,scope.error ?? "scope");
    assert.ok(h.approve(scope.data!).ok);
    assert.equal(h.db.admittedCampaignPublicationIssue("root",d.occurrenceId),101);
  } finally {h.db.close();}
});

test("the actual Campaign Status HTTP route keeps a bounded Full Control human proposal human-owned", async () => {
  const h=harness();
  const {default:Fastify}=await import("fastify");
  const {registerCampaignIssueScopeRoutes}=await import("./campaign-issue-scope-routes.js");
  const app=Fastify();
  try {
    registerCampaignIssueScopeRoutes(app,{db:h.db,svc:h.svc,requestPrincipal:()=>h.principal});
    const result=await app.inject({method:"POST",url:"/api/sessions/root/campaign/issue-scope/proposals",payload:{requestId:"human-http",expectedRevision:1,
      additions:[{repository:"team/repo",number:999}],removals:[],explanation:"Human owner explicitly broadens scope"}});
    assert.equal(result.statusCode,201,result.body); assert.equal(result.json().authority,"human");
    assert.equal(result.json().resourceSnapshot.issueAdmission,undefined);
  } finally {await app.close();h.db.close();}
});

for (const [credentialSessionId, method, target] of [
  ["child", "POST", "root"],
  ["child", "POST", "child"],
  ["other-root", "POST", "root"],
  ["other-root", "GET", "root"],
  ["child", "GET", "root"],
  ["root", "POST", "root"],
  ["root", "GET", "root"],
] as const) {
  test(`issue-scope agent route: ${credentialSessionId} ${method} ${target}`, async () => {
    const h = harness();
    const { default: Fastify } = await import("fastify");
    const { registerCampaignIssueScopeRoutes } = await import("./campaign-issue-scope-routes.js");
    const app = Fastify();
    try {
      h.db.createSession({ id: "other-root", runnerId: "r", workspaceId: "w", agentId: "codex", title: "Other campaign",
        useWorktree: false, driver: "codex-app-server", now: 1, config: {}, role: "orchestrator",
        orchestratorPolicy: h.db.getSession("root")!.orchestratorPolicy! });
      const principal: AgentPrincipal = { kind: "agent", actorId: credentialSessionId, credentialSessionId,
        orchestrator: credentialSessionId !== "child", organizationId: h.principal.organizationId,
        delegatedScope: h.db.sessionScope(credentialSessionId)! };
      // Same-owner access must succeed so the route's agent checks, rather than resource isolation, refuse the request.
      assert.equal(h.db.canAccessSession(principal, target), true);
      assert.equal(h.db.canAccessSession(principal, "root"), true);
      assert.equal(h.db.resolvedCampaignSessionId("other-root"), "other-root");
      registerCampaignIssueScopeRoutes(app, { db: h.db, svc: h.svc, requestPrincipal: () => principal });
      const decisions = () => h.db.raw().prepare("SELECT * FROM workflow_decisions ORDER BY occurrence_id").all();
      const before = decisions();
      const result = await app.inject({ method,
        url: `/api/sessions/${target}/campaign/issue-scope${method === "POST" ? "/proposals" : ""}`,
        ...(method === "POST" ? { payload: { requestId: "agent-http", expectedRevision: 1,
          additions: [{ repository: "team/repo", number: 101 }], removals: [], explanation: "Verified intended member",
          lineage: { kind: "epic", epic: 100 } } } : {}) });
      if (credentialSessionId !== "root") {
        assert.equal(result.statusCode, 403, result.body);
        assert.deepEqual(result.json(), { error: method === "POST"
          ? "only the campaign owner or its root Orchestrator may propose a scope change"
          : "campaign scope requires access to its Orchestrator" });
        assert.deepEqual(decisions(), before, "refused requests create no scope proposal");
      } else if (method === "POST") {
        assert.equal(result.statusCode, 201, result.body);
        assert.equal(result.json().resourceSnapshot.category, "campaign_issue_scope");
        assert.equal(result.json().authority, "orchestrator");
        assert.equal(decisions().length, before.length + 1);
        assert.ok(h.db.workflowDecisionByOccurrence(result.json().occurrenceId));
      } else {
        assert.equal(result.statusCode, 200, result.body);
        assert.deepEqual(result.json().issueNumbers, [100]);
        assert.equal(result.json().repository, "team/repo");
        assert.deepEqual(decisions(), before);
      }
    } finally { await app.close(); h.db.close(); }
  });
}

test("non-delegated closure reasons and operations retain human review without demanding delivery inspection", async () => {
  for (const operations of [["campaign_issue_scope"],["campaign_issue_scope","issue_closure"]] as const) {
    const h=harness();
    try {
      assert.ok(h.svc.setCampaignControl("root",{mode:"full_control",objective:"Implement epic 100",operations:[...operations],delegatablePolicyIds:[],
        issueAuthority:{epics:[100],relatedFollowUps:false,maxIssues:5,closureReasons:["not_planned"]}},2,h.principal).ok);
      const result=await h.svc.requestGithubIssueClosure("root",{requestId:"human-reason",issue:100,reason:"completed",explanation:"Human reviews umbrella",evidence:["Current human review"]});
      assert.ok(result.ok,result.error ?? "human exception"); assert.equal(result.data!.decision!.authority,"human");
      assert.equal(result.data!.decision!.resourceSnapshot.category==="issue_closure" && result.data!.decision!.resourceSnapshot.delivery,undefined);
      assert.ok(h.approve(result.data!.decision!).ok);
      assert.ok((await h.svc.executeGithubIssueClosure("root",result.data!.decision!.occurrenceId,result.data!.decision!.resourceDigest)).ok);
    } finally {h.db.close();}
  }
});

test("legacy duplicate-label publication decisions still normalize and consume", async () => {
  const h=harness(false);
  try {
    const snapshot={category:"follow_up_issue_publication" as const,repository:"team/repo",sanitizedTitle:"Legacy exact payload",sanitizedBody:body,labels:["feature","feature"]};
    const p=h.svc.createWorkflowDecision("child",{requestId:"legacy-labels",resourceKey:"legacy-labels",resourceSnapshot:snapshot}); assert.ok(p.ok,p.error ?? "legacy request");
    assert.ok(h.svc.resolveWorkflowDecision("root","child",p.data!.occurrenceId,{outcome:"approve"},"human",{kind:"human",id:h.principal.userId},()=>true).ok);
    assert.ok((await h.svc.consumeWorkflowDecision("child",p.data!.occurrenceId,{resourceSnapshot:snapshot})).ok);
  } finally {h.db.close();}
});

test("completed delegated closure binds verified delivery and refuses delivery changes before execution", async () => {
  for (const changed of [false,true]) {
    const h=harness();
    try {
      const merge={number:10,headSha:"b".repeat(40),mergeCommitSha:"c".repeat(40)}; h.state.delivery=[merge];
      const detail={id:h.item.id,issue:{repository:"team/repo",number:100},primaryState:"delivered",currentAttempt:null,
        verifications:[{outcome:"delivered",report:{digest:"d".repeat(64)}}],observed:{pullRequests:[{ref:{repository:"team/repo",number:10},fact:{availability:"fresh",value:{state:"merged",headSha:merge.headSha,mergeCommitSha:merge.mergeCommitSha}}}]}} as unknown as CampaignWorkItemDetail;
      h.db.campaignWorkLedger.detail=()=>detail;
      const c=await h.svc.requestGithubIssueClosure("root",{requestId:"delivered",issue:100,reason:"completed",explanation:"All criteria verified against the final report",evidence:["Report and actual merged PR"]});
      assert.ok(c.ok,c.error ?? "completed closure"); const d=c.data!.decision!; assert.equal(d.authority,"orchestrator"); assert.ok(h.approve(d).ok);
      if(changed) detail.verifications=[];
      const result=await h.svc.executeGithubIssueClosure("root",d.occurrenceId,d.resourceDigest);
      assert.equal(result.ok,!changed); assert.equal(h.state.executes,changed?0:1);
    } finally {h.db.close();}
  }
});

test("completed closure cannot rely on a reported stage, queue entry, stale forge fact or missing verified report", () => {
  const h = harness();
  try {
    const snapshot = {category:"issue_closure" as const,repository:"team/repo",issue:100,title:"Issue",url:"https://github.com/team/repo/issues/100",forgeDigest:"a".repeat(64),
      reason:"completed" as const,explanation:"Delivered",evidence:["Verified report"],openPullRequests:[],activeChildren:[],delivery:[{number:10,headSha:"b".repeat(40),mergeCommitSha:"c".repeat(40)}]};
    const detail = {id:h.item.id,issue:{repository:"team/repo",number:100},primaryState:"delivered",currentAttempt:null,
      verifications:[{outcome:"delivered",report:{digest:"d".repeat(64)}}],observed:{pullRequests:[{ref:{repository:"team/repo",number:10},fact:{availability:"fresh",value:{state:"merged",headSha:"b".repeat(40),mergeCommitSha:"c".repeat(40)}}}]}} as unknown as CampaignWorkItemDetail;
    const original = h.db.campaignWorkLedger.detail;
    h.db.campaignWorkLedger.detail = () => detail;
    assert.ok(closureEvidence(h.db,h.db.getSession("root")!,snapshot));
    for (const availability of ["stale","unavailable"]) {
      detail.observed.pullRequests![0]!.fact.availability=availability as "fresh";
      assert.equal(closureEvidence(h.db,h.db.getSession("root")!,snapshot),null);
    }
    detail.observed.pullRequests![0]!.fact.availability="fresh";
    detail.verifications=[]; assert.equal(closureEvidence(h.db,h.db.getSession("root")!,snapshot),null);
    h.db.campaignWorkLedger.detail=original;
  } finally { h.db.close(); }
});

test("an issue boundary refuses its scope limit and its runner floor as separate errors", () => {
  const h = harness(false);
  try {
    const proposal = { mode: "full_control" as const, objective: "Implement epic 100", operations: ["campaign_issue_scope"] as Array<"campaign_issue_scope">,
      delegatablePolicyIds: [], issueAuthority: { epics: [100], relatedFollowUps: true, maxIssues: 1, closureReasons: [] } };
    const policy = structuredClone(h.db.getSession("root")!.orchestratorPolicy!);
    policy.issueScope = { ...policy.issueScope!, issueNumbers: [100, 101] };
    policy.issueNumbers = [100, 101];
    h.db.raw().prepare("UPDATE sessions SET orchestrator_policy=? WHERE id=?").run(JSON.stringify(policy), "root");
    const overLimit = h.svc.setCampaignControl("root", proposal, 1, h.principal);
    assert.equal(overLimit.status, 409);
    assert.equal(overLimit.error, "The issue boundary exceeds its human-set scope limit.");
    assert.equal(overLimit.capabilityRequirement, undefined, "a scope limit is not a runner refusal");
    const floor = RUNNER_CAPABILITY_MIN_PROTOCOL.fullControlIssueAuthority;
    h.db.registerRunner(h.metadata, 3, floor - 1);
    const outdated = h.svc.setCampaignControl("root", { ...proposal, issueAuthority: { ...proposal.issueAuthority, maxIssues: 5 } }, 1, h.principal);
    assert.equal(outdated.status, 409);
    assert.equal(outdated.error, "This machine needs a newer runner for campaign issue limits. Update and restart the runner.");
    assert.deepEqual(outdated.capabilityRequirement, { requiredRunnerProtocolVersion: floor, runnerProtocolVersion: floor - 1 });
  } finally { h.db.close(); }
});

test("a scoped Orchestrator refuses an older runner with the shared sentence on child creation and restart", () => {
  const h = harness(false);
  try {
    const floor = RUNNER_CAPABILITY_MIN_PROTOCOL.campaignIssueScopeChanges;
    const refusal = "This machine needs a newer runner for campaign issue scope changes. Update and restart the runner.";
    const versions = { requiredRunnerProtocolVersion: floor, runnerProtocolVersion: floor - 1 };
    h.db.updateSessionConfig("root", { permissionMode: "orchestrator" }, 3);
    h.db.registerRunner({ ...h.metadata, agents: h.metadata.agents.map((agent) => ({ ...agent,
      capabilities: { models: [], effortLevels: [], slashCommands: [], supportsImages: false, supportsApprovals: true, permissionModes: ["default", "orchestrator"] } })) }, 4, floor - 1);
    const child = h.svc.createSession({ runnerId: "r", workspaceId: "w", agentId: "codex", role: "orchestrator", prompt: "Coordinate",
      config: { permissionMode: "orchestrator" } }, undefined, undefined, false, false, false,
    { parentSessionId: "root", defaultOwnerUserId: h.principal.userId });
    assert.equal(child.error, refusal);
    assert.equal(child.status, 409);
    assert.deepEqual(child.capabilityRequirement, versions);
    h.db.updateSessionStatus("root", "completed", 5);
    const restart = h.svc.restart("root");
    assert.equal(restart.error, refusal);
    assert.equal(restart.status, 409);
    assert.deepEqual(restart.capabilityRequirement, versions);
  } finally { h.db.close(); }
});

test("campaign issue scope refuses each runner floor with the shared sentence and returns the versions beside it", async () => {
  const {default:Fastify}=await import("fastify");
  const {registerCampaignIssueScopeRoutes}=await import("./campaign-issue-scope-routes.js");
  for (const [full, capability, label] of [
    [true, "fullControlIssueAuthority", "campaign issue limits"],
    [false, "campaignIssueScopeChanges", "campaign issue scope changes"],
  ] as const) {
    const h = harness(full);
    const app = Fastify();
    try {
      registerCampaignIssueScopeRoutes(app, { db: h.db, svc: h.svc, requestPrincipal: () => h.principal });
      const floor = RUNNER_CAPABILITY_MIN_PROTOCOL[capability];
      const refusal = `This machine needs a newer runner for ${label}. Update and restart the runner.`;
      const versions = { requiredRunnerProtocolVersion: floor, runnerProtocolVersion: floor - 1 };
      assert.doesNotMatch(refusal, /protocol|v\d/u);
      h.db.registerRunner(h.metadata, 3, floor - 1);
      const view = await app.inject({ method: "GET", url: "/api/sessions/root/campaign/issue-scope" });
      assert.equal(view.statusCode, 200, view.body);
      assert.deepEqual(
        (({ supported, compatibilityMessage, requiredRunnerProtocolVersion, runnerProtocolVersion }) =>
          ({ supported, compatibilityMessage, requiredRunnerProtocolVersion, runnerProtocolVersion }))(view.json()),
        { supported: false, compatibilityMessage: refusal, ...versions },
      );
      const proposed = await app.inject({ method: "POST", url: "/api/sessions/root/campaign/issue-scope/proposals",
        payload: { requestId: `old-runner-${capability}`, expectedRevision: 1, additions: [{ repository: "team/repo", number: 101 }],
          removals: [], explanation: "Verified intended member", lineage: { kind: "epic", epic: 100 } } });
      assert.equal(proposed.statusCode, 409);
      assert.deepEqual(proposed.json(), { error: refusal, ...versions }, "the HTTP refusal keeps the versions beside the sentence");
    } finally { await app.close(); h.db.close(); }
  }
});

/** #2940: the live Full Control root delivered an issue through a gated, merged pull request it never
 * named in a reported stage, then waited past the forge fact's freshness. These run the real ledger,
 * verification, `pr_merge` gate and closure route rather than a stubbed work-item detail. */
type GateOption = "consumed" | "revoked" | "other_session" | "reassigned" | null;
function delivery(options: { stage?: Array<{ number: number }>; gate?: GateOption; verify?: boolean; intendedClosures?: string[] } = {}) {
  const h = harness();
  const head = "b".repeat(40), merge = "c".repeat(40);
  const ref = (number: number) => ({ repository: "team/repo", number });
  type State = "open" | "closed" | "merged";
  const observation = (state: State, headSha = head) => ({ state, draft: false, headSha, baseRef: "main",
    reviewDecision: "approved" as const, checks: { state: "passing" as const, passing: 1, failing: 0, pending: 0 },
    requiredChecks: { state: "passing" as const, passing: 1, failing: 0, pending: 0 }, mergeQueue: null,
    mergeCommitSha: state === "merged" ? merge : null });
  /** What GitHub says now; the store only learns it through an observation. */
  const forge = new Map<number, ReturnType<typeof observation>>();
  const setForge = (number: number, state: State, headSha = head) => forge.set(number, observation(state, headSha));
  const observe = (number: number, state: State, at = Date.now(), headSha = head) => {
    setForge(number, state, headSha);
    h.db.campaignForgeObservations.record("root", "r", [{ ref: ref(number), observation: observation(state, headSha) }], at);
  };
  const verified: Array<Array<{ number: number; headSha: string }> | undefined> = [];
  const forgeReads: number[][] = [];
  /** While `hold` is set, each forge read is sent but waits for `release()` before GitHub answers. */
  const reads = { hold: false, waiting: [] as Array<() => void>, release() { for (const resume of this.waiting.splice(0)) resume(); } };
  /** While `hold` is set, each campaign-scope synchronization waits for `release()`. */
  const syncs = { hold: false, waiting: [] as Array<() => void>, release() { for (const resume of this.waiting.splice(0)) resume(); } };
  const runner = h.hub.requestFromRunner;
  h.hub.requestFromRunner = async (runnerId, requestId, message, timeout) => {
    if (message.type === "campaign_issue_scope" && message.operation === "synchronize" && syncs.hold) {
      await new Promise<void>((resume) => syncs.waiting.push(resume));
    }
    if (message.type === "campaign_forge_observe") {
      forgeReads.push(message.pullRequests.map((pr) => pr.number));
      if (reads.hold) await new Promise<void>((resume) => reads.waiting.push(resume));
      // The runner's own per-request limit (campaign-forge-status.ts).
      if (message.pullRequests.length > CAMPAIGN_FORGE_OBSERVATION.refsPerRequest) {
        return { type: "campaign_forge_observe_result", requestId, sessionId: message.sessionId, observedAt: Date.now(), ok: false, failure: "forge_error" as const };
      }
      return { type: "campaign_forge_observe_result", requestId, sessionId: message.sessionId, observedAt: Date.now(), ok: true,
        results: message.pullRequests.map((pr) => forge.has(pr.number)
          ? { ref: pr, ok: true as const, observation: forge.get(pr.number)! }
          : { ref: pr, ok: false as const, failure: "forge_not_found" as const }) };
    }
    if (message.type === "github_issue_closure" && message.operation === "inspect" && message.deliveryPullRequests) {
      verified.push(message.deliveryPullRequests);
      h.state.delivery = message.deliveryPullRequests.map((pr) => ({ ...pr, mergeCommitSha: merge }));
    }
    return runner(runnerId, requestId, message, timeout);
  };
  if (options.gate === "other_session") {
    h.db.createSession({ id: "other", runnerId: "r", workspaceId: "w", agentId: "codex", title: "other", useWorktree: false,
      driver: "codex-app-server", now: 1, config: {}, parentSessionId: "root" });
    h.db.updateSessionStatus("other", "running", 2);
  }
  // A reassigned child first works on another item, whose merge gate must not prove this one.
  let earlier: number | null = null;
  if (options.gate === "reassigned") {
    const plan = h.svc.recordCampaignPlan("root", { items: [{ key: "issue:100", issue: { repository: "team/repo", number: 100 } },
      { key: "other-work", title: "Unrelated work" }], planComplete: true });
    assert.ok(plan.ok, plan.error ?? "plan");
    const other = plan.data!.items.find((item) => item.key === "other-work")!.workItemId;
    assert.ok(h.svc.assignCampaignWorkItem("root", { workItemId: other, childSessionId: "child" }).ok);
  } else {
    assert.ok(h.svc.assignCampaignWorkItem("root", { workItemId: h.item.id, childSessionId: "child" }).ok);
  }
  if (options.gate) {
    const requester = options.gate === "other_session" ? "other" : "child";
    const gate = h.svc.createWorkflowDecision(requester, { requestId: "merge-10", resourceKey: "team/repo#10/merge", resourceSnapshot: {
      category: "pr_merge", repository: "team/repo", pullRequest: 10, headSha: head, reviewResult: "merge",
      requiredChecks: { headSha: head, status: "passed", checkedAt: 1, checks: [{ name: "CI", state: "passed" }] },
      ...(options.intendedClosures ? { intendedClosures: options.intendedClosures } : {}) } });
    assert.ok(gate.ok, gate.error ?? "merge gate");
    assert.ok(h.svc.resolveWorkflowDecision("root", requester, gate.data!.occurrenceId, { outcome: "approve" }, gate.data!.authority,
      { kind: "human", id: h.principal.userId }, () => true).ok);
    if (options.gate === "revoked") assert.ok(h.db.markWorkflowDecisionRevoked(gate.data!.occurrenceId, Date.now()));
    else assert.ok(h.db.consumeWorkflowDecision(gate.data!.occurrenceId, Date.now()));
  }
  if (options.gate === "reassigned") {
    h.svc.onSessionStatus("child", "idle");
    earlier = h.db.appendEvent("child", { kind: "agent_message", text: "Other work delivered.", final: true }, Date.now()).seq;
    const later = Date.now() + 5;
    while (Date.now() < later) { /* the next attempt starts strictly after the earlier report */ }
    assert.ok(h.svc.assignCampaignWorkItem("root", { workItemId: h.item.id, childSessionId: "child" }).ok);
  }
  if (options.stage) assert.ok(h.svc.updateCampaignWorkItem("root", { workItemId: h.item.id,
    stage: { stage: "merged", pullRequests: options.stage.map(({ number }) => ref(number)) } }).ok);
  if (options.verify !== false) {
    h.svc.onSessionStatus("child", "idle");
    const report = earlier ?? h.db.appendEvent("child", { kind: "agent_message", text: "Delivered.", final: true }, Date.now()).seq;
    const result = h.svc.verifyCampaignChild("root", { childSessionId: "child", reportEventSeq: report, followUpsAccounted: true,
      workItem: { id: h.item.id, outcome: "delivered" } });
    assert.ok(result.ok, result.error ?? "verify");
  }
  const close = (requestId: string) => h.svc.requestGithubIssueClosure("root", { requestId, issue: 100, reason: "completed",
    explanation: "Delivered by the merged pull request", evidence: ["Verified report"] });
  /** The real observer behind both service hooks, its clock held inside one minIntervalMs. */
  const useObserver = () => {
    const clock = Date.now();
    let ids = 0;
    const observer = new CampaignForgeObserver({
      observingRunner: (id) => h.db.campaignForgeObservingRunner(id), store: h.db.campaignForgeObservations,
      requestFromRunner: (runnerId, requestId, message, timeoutMs) => h.hub.requestFromRunner(runnerId, requestId, message, timeoutMs),
      backgroundTargets: () => [], changed() {}, warn() {}, newRequestId: () => `forge_${++ids}`, now: () => clock,
    });
    h.svc.campaignForgeRefresh = (campaignId, refs) => observer.refresh(campaignId, refs);
    h.svc.campaignForgeReadNow = (campaignId, refs) => observer.readNow(campaignId, refs);
    return observer;
  };
  const settle = async (until: () => boolean) => { while (!until()) await new Promise((resolve) => setImmediate(resolve)); };
  return { h, head, observe, setForge, forgeReads, reads, syncs, verified, close, useObserver, settle };
}

test("#2940 a verified issue delivered through a consumed merge gate gets Orchestrator-owned closure after an on-demand refresh", async () => {
  const { h, head, observe, verified, close } = delivery({ gate: "consumed" });
  try {
    // The background pass dropped the pull request once the item was delivered; its fact went stale.
    observe(10, "merged", Date.now() - CAMPAIGN_FORGE_OBSERVATION.staleAfterMs - 60_000);
    const refreshed: number[][] = [];
    h.svc.campaignForgeRefresh = async (campaignId, refs) => {
      assert.equal(campaignId, "root");
      refreshed.push(refs.map((ref) => ref.number));
      observe(10, "merged");
    };
    const c = await close("live-shape");
    assert.ok(c.ok, c.error ?? "closure");
    const d = c.data!.decision!;
    assert.equal(d.authority, "orchestrator", JSON.stringify(d.authorityEvaluation));
    assert.deepEqual(refreshed, [[10]], "the gated pull request is read even though no stage names it");
    assert.deepEqual(verified, [[{ number: 10, headSha: head }]], "the runner re-verifies the exact approved head");
    assert.ok(h.approve(d).ok);
    const executed = await h.svc.executeGithubIssueClosure("root", d.occurrenceId, d.resourceDigest);
    assert.ok(executed.ok, executed.error ?? "execute");
    assert.equal(h.state.executes, 1);
    assert.deepEqual(refreshed, [[10], [10]], "execution refreshes before it re-proves delivery");
  } finally { h.db.close(); }
});

test("#2940 a Full Control root's pending own closure names the self-approval step; resolve-self then execute closes it once", async () => {
  const { h, observe, close } = delivery({ gate: "consumed" });
  try {
    observe(10, "merged");
    const c = await close("self-owned");
    assert.ok(c.ok, c.error ?? "closure");
    const d = c.data!.decision!;
    assert.equal(d.authority, "orchestrator", JSON.stringify(d.authorityEvaluation));
    assert.equal(d.status, "pending");
    // Executing straight after the request, as the role prompt once described, refuses with the step.
    const early = await h.svc.executeGithubIssueClosure("root", d.occurrenceId, d.resourceDigest);
    assert.equal(early.ok, false);
    assert.equal(early.status, 409);
    assert.match(early.error!, /no person will approve it/u);
    assert.match(early.error!, /resolve_descendant_workflow_decision \(sessionId "root", your own session; occurrenceId "[^"]+"; outcome "approve"\)/u);
    assert.ok(early.error!.includes(d.occurrenceId), "the refusal names the exact occurrence");
    assert.equal(h.state.executes, 0, "nothing reached the forge");
    assert.equal(h.db.workflowDecisionByOccurrence(d.occurrenceId)!.status, "pending", "the refusal does not revoke the request");
    // The named step: the root approves its own occurrence through the descendant-resolution route.
    const resolved = h.svc.resolveDescendantRequest("root", "root", d.occurrenceId,
      { action: "resolve_workflow_decision", outcome: "approve" }, () => true);
    assert.ok(resolved.ok, resolved.error ?? "self-resolve");
    const executed = await h.svc.executeGithubIssueClosure("root", d.occurrenceId, d.resourceDigest);
    assert.ok(executed.ok, executed.error ?? "execute");
    assert.equal(h.state.executes, 1);
    const replay = await h.svc.executeGithubIssueClosure("root", d.occurrenceId, d.resourceDigest);
    assert.equal(replay.ok, false);
    assert.equal(h.state.executes, 1, "the closure executes exactly once");
  } finally { h.db.close(); }
});

test("#2940 a pending human-owned closure tells an agent a person must approve it, and the agent cannot", async () => {
  for (const full of [false, true]) {
    const h = harness(full);
    try {
      // Custom keeps closure human-owned; under Full Control an unverified delivery does too.
      const c = await h.svc.requestGithubIssueClosure("root", { requestId: `human-${full}`, issue: 100, reason: "completed",
        explanation: "Claimed delivery", evidence: ["Claim"] });
      assert.ok(c.ok, c.error ?? "closure");
      const d = c.data!.decision!;
      assert.equal(d.authority, "human");
      const early = await h.svc.executeGithubIssueClosure("root", d.occurrenceId, d.resourceDigest);
      assert.equal(early.ok, false);
      assert.equal(early.status, 409);
      assert.match(early.error!, /a person must approve this human-owned closure in Wollipog first\. Never approve it yourself/u);
      assert.doesNotMatch(early.error!, /resolve_descendant_workflow_decision/u, "an agent is never pointed at self-approval");
      const self = h.svc.resolveDescendantRequest("root", "root", d.occurrenceId, { action: "resolve_workflow_decision", outcome: "approve" }, () => true);
      assert.equal(self.ok, false, "an agent cannot approve a human-owned closure");
      assert.equal(h.db.workflowDecisionByOccurrence(d.occurrenceId)!.status, "pending");
      assert.equal(h.state.executes, 0);
    } finally { h.db.close(); }
  }
});

test("#2940 a stale fact that no refresh renews still retains human closure review", async () => {
  for (const hook of [false, true]) {
    const { h, observe, close } = delivery({ gate: "consumed" });
    try {
      observe(10, "merged", Date.now() - CAMPAIGN_FORGE_OBSERVATION.staleAfterMs - 60_000);
      if (hook) h.svc.campaignForgeRefresh = async () => {};
      const c = await close(`stale-${hook}`);
      assert.ok(c.ok, c.error ?? "closure");
      assert.equal(c.data!.decision!.authority, "human");
    } finally { h.db.close(); }
  }
});

test("#2940 a closed-unmerged pull request does not poison an issue another gated pull request delivered", async () => {
  const { h, head, observe, verified, close } = delivery({ gate: "consumed", stage: [{ number: 9 }] });
  try {
    observe(9, "closed"); observe(10, "merged");
    const c = await close("superseded-pr");
    assert.ok(c.ok, c.error ?? "closure");
    const d = c.data!.decision!;
    assert.equal(d.authority, "orchestrator", JSON.stringify(d.authorityEvaluation));
    assert.deepEqual(verified, [[{ number: 10, headSha: head }]], "only the merged pull request is sent for verification");
    assert.ok(h.approve(d).ok);
    // The excluded pull request reopens before execution: the bound proof no longer holds.
    observe(9, "open");
    const executed = await h.svc.executeGithubIssueClosure("root", d.occurrenceId, d.resourceDigest);
    assert.equal(executed.ok, false);
    assert.equal(executed.status, 409);
    assert.equal(h.state.executes, 0);
  } finally { h.db.close(); }
});

test("#2940 execution re-reads an excluded pull request past the observer's cache and rate limit (CR-1.2)", async () => {
  for (const reopened of [true, false]) {
    const { h, setForge, forgeReads, close, useObserver } = delivery({ gate: "consumed", stage: [{ number: 9 }] });
    try {
      setForge(9, "closed"); setForge(10, "merged");
      // The real observer, its clock held inside one minIntervalMs, so a repeat refresh is suppressed.
      useObserver();
      const c = await close(`excluded-${reopened}`);
      assert.ok(c.ok, c.error ?? "closure");
      const d = c.data!.decision!;
      assert.equal(d.authority, "orchestrator", JSON.stringify(d.authorityEvaluation));
      assert.deepEqual(forgeReads, [[9, 10]], "the observer read both candidates once");
      assert.ok(h.approve(d).ok);
      // GitHub reopens the excluded pull request (no issue reference); the store still says closed.
      if (reopened) setForge(9, "open");
      const executed = await h.svc.executeGithubIssueClosure("root", d.occurrenceId, d.resourceDigest);
      assert.deepEqual(forgeReads, [[9, 10], [9]], "the observer suppressed its repeat; execution read the excluded ref uncached");
      assert.equal(executed.ok, !reopened, executed.error ?? "executed");
      assert.equal(h.state.executes, reopened ? 0 : 1);
      if (reopened) assert.equal(executed.status, 409);
    } finally { h.db.close(); }
  }
});

test("#2940 delivery candidates never stand in for a missing merge, gate, head or verification", async () => {
  const cases: Array<[string, Parameters<typeof delivery>[0], (observe: ReturnType<typeof delivery>["observe"]) => void]> = [
    ["only a closed-unmerged pull request", { stage: [{ number: 9 }] }, (observe) => observe(9, "closed")],
    ["an open stage pull request beside the merge", { gate: "consumed", stage: [{ number: 11 }] }, (observe) => { observe(10, "merged"); observe(11, "open"); }],
    ["a revoked, never consumed gate", { gate: "revoked" }, (observe) => observe(10, "merged")],
    ["a gate another session passed", { gate: "other_session" }, (observe) => observe(10, "merged")],
    // CR-1.1: the child's earlier merge for other work, then its earlier report verified against this item.
    ["a gate from the child's earlier attempt on other work", { gate: "reassigned" }, (observe) => observe(10, "merged")],
    ["a gate meant to close only another issue", { gate: "consumed", intendedClosures: ["team/repo#101"] }, (observe) => observe(10, "merged")],
    ["a merge at a head other than the approved one", { gate: "consumed" }, (observe) => observe(10, "merged", Date.now(), "e".repeat(40))],
    ["an unverified attempt", { gate: "consumed", verify: false }, (observe) => observe(10, "merged")],
  ];
  for (const [label, options, setup] of cases) {
    const { h, observe, close } = delivery(options);
    try {
      setup(observe);
      const c = await close(label.replaceAll(" ", "-"));
      assert.ok(c.ok, c.error ?? label);
      assert.equal(c.data!.decision!.authority, "human", label);
    } finally { h.db.close(); }
  }
});

test("#2940 a gate that names this issue among its intended closures still proves delivery", async () => {
  const { h, observe, close } = delivery({ gate: "consumed", intendedClosures: ["team/repo#100", "team/repo#101"] });
  try {
    observe(10, "merged");
    const c = await close("named-closure");
    assert.ok(c.ok, c.error ?? "closure");
    assert.equal(c.data!.decision!.authority, "orchestrator", JSON.stringify(c.data!.decision!.authorityEvaluation));
  } finally { h.db.close(); }
});

test("#2940 work assigned while the excluded-pull-request read is pending is never closed (CR-2.1)", async () => {
  const { h, setForge, reads, close, useObserver, settle } = delivery({ gate: "consumed", stage: [{ number: 9 }] });
  try {
    setForge(9, "closed"); setForge(10, "merged");
    useObserver();
    const c = await close("assigned-mid-read");
    const d = c.data!.decision!;
    assert.equal(d.authority, "orchestrator", JSON.stringify(d.authorityEvaluation));
    assert.ok(h.approve(d).ok);
    reads.hold = true;
    const pending = h.svc.executeGithubIssueClosure("root", d.occurrenceId, d.resourceDigest);
    await settle(() => reads.waiting.length > 0);
    // The delivered item gets new work while execution waits on GitHub.
    h.db.createSession({ id: "late", runnerId: "r", workspaceId: "w", agentId: "codex", title: "late", useWorktree: false,
      driver: "codex-app-server", now: Date.now(), config: {}, parentSessionId: "root" });
    h.db.updateSessionStatus("late", "running", Date.now());
    const assigned = h.svc.assignCampaignWorkItem("root", { workItemId: h.item.id, childSessionId: "late" });
    assert.ok(assigned.ok, assigned.error ?? "assign");
    reads.release();
    const executed = await pending;
    assert.equal(executed.ok, false);
    assert.equal(executed.status, 409);
    assert.equal(h.state.executes, 0, "no execute dispatch");
    assert.equal(h.db.workflowDecisionByOccurrence(d.occurrenceId)?.status, "approved", "the approval stays unconsumed");
  } finally { h.db.close(); }
});

test("#2940 more excluded pull requests than one runner request admits are read in batches (CR-2.2)", async () => {
  const closed = Array.from({ length: 16 }, (_, index) => ({ number: 20 + index }));
  const { h, setForge, forgeReads, close, useObserver } = delivery({ gate: "consumed", stage: closed });
  try {
    for (const { number } of closed) setForge(number, "closed");
    setForge(10, "merged");
    // A second item for the same issue, delivered by another child, names a 17th closed pull request.
    const plan = h.svc.recordCampaignPlan("root", { items: [{ key: "issue:100", issue: { repository: "team/repo", number: 100 } },
      { key: "issue:100:part-2", issue: { repository: "team/repo", number: 100 } }], planComplete: true });
    assert.ok(plan.ok, plan.error ?? "plan");
    const second = plan.data!.items.find((item) => item.key === "issue:100:part-2")!.workItemId;
    h.db.createSession({ id: "child2", runnerId: "r", workspaceId: "w", agentId: "codex", title: "child2", useWorktree: false,
      driver: "codex-app-server", now: Date.now(), config: {}, parentSessionId: "root" });
    h.db.updateSessionStatus("child2", "running", Date.now());
    assert.ok(h.svc.assignCampaignWorkItem("root", { workItemId: second, childSessionId: "child2" }).ok);
    assert.ok(h.svc.updateCampaignWorkItem("root", { workItemId: second, stage: { stage: "merged",
      pullRequests: [{ repository: "team/repo", number: 36 }, { repository: "team/repo", number: 37 }] } }).ok);
    setForge(36, "closed"); setForge(37, "merged");
    h.svc.onSessionStatus("child2", "idle");
    const report = h.db.appendEvent("child2", { kind: "agent_message", text: "Delivered.", final: true }, Date.now()).seq;
    assert.ok(h.svc.verifyCampaignChild("root", { childSessionId: "child2", reportEventSeq: report, followUpsAccounted: true,
      workItem: { id: second, outcome: "delivered" } }).ok);
    useObserver();
    const c = await close("seventeen-excluded");
    const d = c.data!.decision!;
    assert.equal(d.authority, "orchestrator", JSON.stringify(d.authorityEvaluation));
    assert.ok(h.approve(d).ok);
    const before = forgeReads.length;
    const executed = await h.svc.executeGithubIssueClosure("root", d.occurrenceId, d.resourceDigest);
    assert.ok(executed.ok, executed.error ?? "execute");
    assert.deepEqual(forgeReads.slice(before).map((batch) => batch.length).sort((a, b) => a - b), [1, 16],
      "17 excluded refs go out as one full batch and one more");
    assert.equal(h.state.executes, 1);
  } finally { h.db.close(); }
});

/** #3793: the closure binds each child's prompts by identity and content. A durable outbox retry
 * rewrites only delivery bookkeeping (`attemptCount`, `updatedAt`), which must not revoke it. */
function promptedClosure(requestId: string) {
  const fixture = delivery({ gate: "consumed", stage: [{ number: 9 }] });
  const { h, setForge, close, useObserver } = fixture;
  setForge(9, "closed"); setForge(10, "merged");
  useObserver();
  // Enabling Full Control sent the bound child a policy notice its runner has not acknowledged.
  const prompts = () => h.db.getSession("child")?.pendingPrompts ?? [];
  assert.equal(prompts().length, 1);
  const commandId = prompts()[0]!.commandId;
  assert.equal(prompts()[0]!.state, "sent");
  const pending = () => prompts().find((prompt) => prompt.commandId === commandId);
  return { ...fixture, prompts, pending, approved: async () => {
    const c = await close(requestId);
    const d = c.data!.decision!;
    assert.equal(d.authority, "orchestrator", JSON.stringify(d.authorityEvaluation));
    assert.ok(d.resourceSnapshot.category === "issue_closure" && d.resourceSnapshot.activeChildren.some((child) => child.sessionId === "child"),
      "the prompted child is bound to the closure");
    assert.ok(h.approve(d).ok);
    return d;
  } };
}

test("#3793 a prompt delivery retry between approval and execution keeps the closure", async () => {
  const { h, pending, approved } = promptedClosure("retried-prompt");
  try {
    const d = await approved();
    const before = pending()!;
    // The outbox's backoff has elapsed: it sends the same unacknowledged prompt again.
    h.svc.retryDuePrompts(Date.now() + 60_000);
    const after = pending()!;
    assert.equal(after.commandId, before.commandId);
    assert.ok(after.attemptCount > before.attemptCount, `retried: ${before.attemptCount} -> ${after.attemptCount}`);
    assert.ok(after.updatedAt > before.updatedAt);
    // The runner then admits it to its queue: another delivery transition of the same prompt.
    assert.ok(h.svc.onDurablePromptReceipt("r", { type: "durable_session_command_update", commandId: after.commandId,
      sessionId: "child", state: "queued", revision: after.revision + 1 }));
    assert.equal(pending()!.state, "queued");
    assert.equal(h.db.getSession("child")?.queued?.[0]?.durableDeliveryState, "queued");
    const executed = await h.svc.executeGithubIssueClosure("root", d.occurrenceId, d.resourceDigest);
    assert.ok(executed.ok, executed.error ?? "execute");
    assert.equal(h.state.executes, 1);
  } finally { h.db.close(); }
});

test("#3793 a new prompt for a bound child between approval and execution still revokes the closure", async () => {
  const { h, prompts, approved } = promptedClosure("new-prompt");
  try {
    const d = await approved();
    // Admitted while the child waits for a provider slot, the prompt takes the durable outbox.
    h.db.updateSessionStatus("child", "queued", Date.now());
    const sent = h.svc.prompt("child", "Start on something else");
    assert.ok(sent.ok, sent.error ?? "prompt");
    assert.equal(prompts().length, 2, "a second durable prompt is pending");
    const executed = await h.svc.executeGithubIssueClosure("root", d.occurrenceId, d.resourceDigest);
    assert.equal(executed.ok, false);
    assert.equal(executed.status, 409);
    assert.match(executed.error ?? "", /active child work changed/u);
    assert.equal(h.state.executes, 0, "no execute dispatch");
    assert.equal(h.db.workflowDecisionByOccurrence(d.occurrenceId)?.status, "revoked");
  } finally { h.db.close(); }
});

/** #3835: a prompt to an idle child without a worktree is sent straight to the runner, so it is
 * neither pending nor queued. Its admission must still change the bound child's digest at once,
 * not only when the runner echoes it back as a user message. */
test("#3835 an immediate-lane prompt for a bound idle child between approval and execution revokes the closure", async () => {
  const { h, prompts, approved } = promptedClosure("immediate-prompt");
  try {
    const d = await approved();
    const child = h.db.getSession("child")!;
    assert.equal(child.status, "idle");
    assert.equal(child.worktreePath, null);
    const queued = JSON.stringify(child.queued ?? []);
    const sends: string[] = [];
    h.hub.sendToRunner = (_runner, message) => { sends.push(message.type); return true; };
    // What the session prompt route admits: with no turn in flight, nothing is steered.
    const sent = await h.svc.promptOrSteer("child", "Start on something else");
    assert.ok(sent.ok, sent.error ?? "prompt");
    assert.deepEqual(sends, ["prompt_session"], "the prompt went straight to the runner");
    assert.equal(h.db.getSession("child")?.status, "running");
    assert.equal(prompts().length, 1, "no durable prompt was staged");
    assert.equal(JSON.stringify(h.db.getSession("child")?.queued ?? []), queued, "nor queued");
    const executed = await h.svc.executeGithubIssueClosure("root", d.occurrenceId, d.resourceDigest);
    assert.equal(executed.ok, false);
    assert.equal(executed.status, 409);
    assert.match(executed.error ?? "", /active child work changed/u);
    assert.equal(h.state.executes, 0, "no execute dispatch");
    assert.equal(h.db.workflowDecisionByOccurrence(d.occurrenceId)?.status, "revoked");
  } finally { h.db.close(); }
});

test("#3835 an immediate-lane prompt admitted and echoed before the closure request keeps it", async () => {
  const { h, approved } = promptedClosure("echoed-prompt");
  try {
    const sent = await h.svc.promptOrSteer("child", "One more check");
    assert.ok(sent.ok, sent.error ?? "prompt");
    h.db.appendEvent("child", { kind: "user_message", text: "One more check" }, Date.now());
    h.svc.onSessionStatus("child", "idle");
    const d = await approved();
    const executed = await h.svc.executeGithubIssueClosure("root", d.occurrenceId, d.resourceDigest);
    assert.ok(executed.ok, executed.error ?? "execute");
    assert.equal(h.state.executes, 1);
  } finally { h.db.close(); }
});

/** #3877: a prompt for a child that is mid-turn is steered into that turn, so it is recorded only
 * as a steering attempt. Make the bound child steerable: running with a live turn on a provider
 * that steers. While `hold` is set, the runner's steering reply waits for `release()`. */
function steerable(h: ReturnType<typeof harness>) {
  h.db.registerRunner({ ...h.metadata, agents: h.metadata.agents.map((agent) => ({ ...agent, capabilities: {
    models: [], effortLevels: [], slashCommands: [], supportsImages: false, supportsApprovals: true, supportsSteering: true } })) },
  Date.now(), PROTOCOL_VERSION);
  h.db.updateSessionStatus("child", "running", Date.now());
  h.hub.activeTurnIdForSession = (id) => id === "child" ? "turn-live" : undefined;
  const steering = { hold: false, submissions: [] as string[], waiting: [] as Array<() => void>,
    release() { for (const resume of this.waiting.splice(0)) resume(); } };
  const runner = h.hub.requestFromRunner;
  h.hub.requestFromRunner = async (runnerId, requestId, message, timeout) => {
    if (message.type !== "steer_session") return runner(runnerId, requestId, message, timeout);
    steering.submissions.push(message.submissionId);
    if (steering.hold) await new Promise<void>((resume) => steering.waiting.push(resume));
    return { type: "steer_session_result", requestId: message.requestId, submissionId: message.submissionId,
      sessionId: message.sessionId, turnId: message.turnId, disposition: "accepted", reason: "accepted", providerTurnId: "provider-turn" };
  };
  return steering;
}

test("#3877 a prompt steered into a bound running child between approval and execution revokes the closure", async () => {
  const { h, prompts, approved } = promptedClosure("steered-prompt");
  try {
    const steering = steerable(h);
    const d = await approved();
    const transcript = h.db.issueClosureAssignmentState("child").latest;
    const pending = JSON.stringify(prompts());
    const queued = JSON.stringify(h.db.getSession("child")?.queued ?? []);
    const sends: string[] = [];
    h.hub.sendToRunner = (_runner, message) => { sends.push(message.type); return true; };
    // What the session prompt route admits: with a turn in flight, the message is steered into it.
    const sent = await h.svc.promptOrSteer("child", "Start on something else");
    assert.ok(sent.ok, sent.error ?? "prompt");
    assert.equal(sent.data?.promptDelivery?.lane, "steered");
    assert.equal(steering.submissions.length, 1, "one steer_session went to the runner");
    assert.deepEqual(sends, [], "no prompt_session was sent");
    // Nothing the closure digest read before #3877 records the steered message.
    assert.equal(h.db.getSession("child")?.status, "running");
    assert.deepEqual(h.db.issueClosureAssignmentState("child").latest, transcript, "the runner has not echoed it");
    assert.equal(JSON.stringify(prompts()), pending, "no durable prompt was staged");
    assert.equal(JSON.stringify(h.db.getSession("child")?.queued ?? []), queued, "nor queued");
    const executed = await h.svc.executeGithubIssueClosure("root", d.occurrenceId, d.resourceDigest);
    assert.equal(executed.ok, false);
    assert.equal(executed.status, 409);
    assert.match(executed.error ?? "", /active child work changed/u);
    assert.equal(h.state.executes, 0, "no execute dispatch");
    assert.equal(h.db.workflowDecisionByOccurrence(d.occurrenceId)?.status, "revoked");
  } finally { h.db.close(); }
});

test("#3877 a steering attempt admitted before the closure request keeps it whatever the runner later reports", async () => {
  const { h, settle, approved } = promptedClosure("steered-before");
  const steering = steerable(h);
  try {
    steering.hold = true;
    let returned = false;
    const steered = h.svc.promptOrSteer("child", "One more check").finally(() => { returned = true; });
    await settle(() => steering.waiting.length > 0 || returned);
    assert.equal(steering.waiting.length, 1, "the steer is waiting on the runner");
    const submission = steering.submissions[0]!;
    assert.equal(h.db.findSteeringAttemptBySubmission("child", submission)?.attempt.state, "pending");
    const d = await approved();
    // The runner's reply settles the attempt after approval; no new instruction reached the child.
    steering.release();
    const sent = await steered;
    assert.ok(sent.ok, sent.error ?? "prompt");
    assert.equal(sent.data?.promptDelivery?.lane, "steered");
    assert.equal(h.db.findSteeringAttemptBySubmission("child", submission)?.attempt.state, "accepted");
    const executed = await h.svc.executeGithubIssueClosure("root", d.occurrenceId, d.resourceDigest);
    assert.ok(executed.ok, executed.error ?? "execute");
    assert.equal(h.state.executes, 1);
  } finally { steering.release(); h.db.close(); }
});

test("#3877 the closure state of a never-steered child is unchanged and a steered one binds its latest attempt", async () => {
  const { h } = promptedClosure("steering-state");
  try {
    // Exactly what the digest bound before #3877, so approvals pending across the upgrade survive.
    const unsteered = h.db.issueClosureAssignmentState("child");
    assert.deepEqual(Object.keys(unsteered), ["latest", "command"]);
    const steering = steerable(h);
    for (const text of ["First redirect", "Second redirect"]) {
      const sent = await h.svc.promptOrSteer("child", text);
      assert.ok(sent.ok, sent.error ?? "prompt");
      assert.equal(sent.data?.promptDelivery?.lane, "steered");
    }
    const latest = h.db.findSteeringAttemptBySubmission("child", steering.submissions[1]!)!;
    // Compared as the closure digest serializes it.
    assert.equal(JSON.stringify(h.db.issueClosureAssignmentState("child")),
      JSON.stringify({ ...unsteered, steering: { id: latest.requestId, digest: latest.requestSha256, count: 2 } }));
  } finally { h.db.close(); }
});

test("#3877 a prompt steered after the wall clock steps back between approval and execution still revokes the closure", async () => {
  const { h, prompts, approved } = promptedClosure("steered-clock-step");
  const now = Date.now;
  try {
    const steering = steerable(h);
    const first = await h.svc.promptOrSteer("child", "First redirect");
    assert.ok(first.ok, first.error ?? "prompt");
    const a = h.db.findSteeringAttemptBySubmission("child", steering.submissions[0]!)!;
    const d = await approved();
    const pending = JSON.stringify(prompts());
    // An NTP step or VM restore: the next attempt is stamped before the one the approval bound.
    Date.now = () => a.attempt.createdAt - 60_000;
    const second = await h.svc.promptOrSteer("child", "Start on something else");
    Date.now = now;
    assert.ok(second.ok, second.error ?? "prompt");
    assert.equal(second.data?.promptDelivery?.lane, "steered");
    const b = h.db.findSteeringAttemptBySubmission("child", steering.submissions[1]!)!;
    assert.ok(b.attempt.createdAt < a.attempt.createdAt, "the new attempt is stamped earlier");
    assert.equal(JSON.stringify(prompts()), pending, "and the runner has echoed nothing");
    const executed = await h.svc.executeGithubIssueClosure("root", d.occurrenceId, d.resourceDigest);
    assert.equal(executed.ok, false);
    assert.equal(executed.status, 409);
    assert.match(executed.error ?? "", /active child work changed/u);
    assert.equal(h.state.executes, 0, "no execute dispatch");
    assert.equal(h.db.workflowDecisionByOccurrence(d.occurrenceId)?.status, "revoked");
  } finally { Date.now = now; h.db.close(); }
});

test("#2940 concurrent executes of one closure share one uncached read (CR-2.3)", async () => {
  const { h, setForge, forgeReads, reads, close, useObserver, settle } = delivery({ gate: "consumed", stage: [{ number: 9 }] });
  try {
    setForge(9, "closed"); setForge(10, "merged");
    useObserver();
    const c = await close("concurrent-executes");
    const d = c.data!.decision!;
    assert.equal(d.authority, "orchestrator", JSON.stringify(d.authorityEvaluation));
    assert.ok(h.approve(d).ok);
    const before = forgeReads.length;
    reads.hold = true;
    const executes = Array.from({ length: 4 }, () => h.svc.executeGithubIssueClosure("root", d.occurrenceId, d.resourceDigest));
    await settle(() => reads.waiting.length > 0);
    for (let tick = 0; tick < 20; tick++) await new Promise((resolve) => setImmediate(resolve));
    assert.deepEqual(forgeReads.slice(before), [[9]], "one read in flight for every concurrent execute");
    reads.hold = false;
    reads.release();
    const results = await Promise.all(executes);
    assert.equal(results.filter((result) => result.ok).length, 1, "exactly one execute dispatches");
    assert.equal(h.state.executes, 1);
    // A settled answer is never reused: a later execute of the consumed occurrence reads nothing new and is refused.
    assert.equal((await h.svc.executeGithubIssueClosure("root", d.occurrenceId, d.resourceDigest)).ok, false);
    assert.deepEqual(forgeReads.slice(before), [[9]]);
  } finally { h.db.close(); }
});

test("#2940 an excluded pull request reopened during scope synchronization is never closed over (CR-3.1)", async () => {
  const { h, setForge, forgeReads, syncs, close, useObserver, settle } = delivery({ gate: "consumed", stage: [{ number: 9 }] });
  try {
    setForge(9, "closed"); setForge(10, "merged");
    useObserver();
    const c = await close("reopened-during-sync");
    const d = c.data!.decision!;
    assert.equal(d.authority, "orchestrator", JSON.stringify(d.authorityEvaluation));
    assert.ok(h.approve(d).ok);
    const before = forgeReads.length;
    syncs.hold = true;
    const pending = h.svc.executeGithubIssueClosure("root", d.occurrenceId, d.resourceDigest);
    await settle(() => syncs.waiting.length > 0);
    assert.equal(forgeReads.length, before, "no excluded read before synchronization settles");
    // GitHub reopens the excluded pull request; the store still says closed.
    setForge(9, "open");
    syncs.hold = false;
    syncs.release();
    const executed = await pending;
    assert.equal(executed.ok, false);
    assert.equal(executed.status, 409);
    assert.deepEqual(forgeReads.slice(before), [[9]], "the uncached read follows synchronization");
    assert.equal(h.state.executes, 0, "no execute dispatch");
    assert.equal(h.db.workflowDecisionByOccurrence(d.occurrenceId)?.status, "approved", "the approval stays unconsumed");
  } finally { h.db.close(); }
});

// #2940, observed live: before #3824 a child's in-boundary publication was routed to the person,
// who approved its exact payload. The fallback carries no issueAdmission, so the Orchestrator could
// never admit the published issue: the bounded path needed an admission it never got.
type ScopeHarness = ReturnType<typeof harness>;

function member(h: ScopeHarness, userId: string, role: "owner" | "admin" | "operator" | "viewer") {
  h.db.raw().prepare("INSERT INTO identity_users(user_id,display_name,created_at,updated_at) VALUES (?,?,1,1)").run(userId, userId);
  h.db.raw().prepare("INSERT INTO identity_memberships(organization_id,user_id,role,created_at,updated_at) VALUES (?,?,?,1,1)").run(h.principal.organizationId, userId, role);
}

async function humanApprovedPublication(h: ScopeHarness, options: { approver?: string; title?: string; issue?: number; accept?: boolean;
  resolution?: Record<string, unknown> } = {}) {
  const { approver = h.principal.userId, title = "Human approved repair", issue = 101, accept = true } = options;
  const rec = h.svc.recordCampaignFollowUp("root",{originSessionId:"child",repository:"team/repo",title,originWorkItemIds:[h.item.id]}); assert.ok(rec.ok,rec.error ?? "record");
  if (accept) assert.ok(h.svc.adjudicateCampaignRecommendation("root",{recommendationId:rec.data!.id,disposition:"accepted",reason:"Observed related work",publicationRequired:true}).ok);
  // A failed inspection routes the child's request to the person, as #3814 and #3815 were.
  h.state.publicationOk = false;
  const created = await h.svc.createWorkflowDecisionWithVideo("child",{requestId:`human-${title}`,resourceKey:`human-${title}`,resourceSnapshot:{category:"follow_up_issue_publication",
    repository:"team/repo",sanitizedTitle:`[Feature]: ${title}`,sanitizedBody:body,labels:[],recommendationId:rec.data!.id}});
  h.state.publicationOk = true;
  assert.ok(created.ok,created.error ?? "publication"); const decision = created.data!;
  assert.equal(decision.authority,"human");
  assert.ok(decision.resourceSnapshot.category === "follow_up_issue_publication" && !decision.resourceSnapshot.issueAdmission && decision.resourceSnapshot.recommendationId === rec.data!.id);
  const approved = h.svc.resolveWorkflowDecision("root","child",decision.occurrenceId,
    { outcome: "approve", ...options.resolution } as import("@wollipog/protocol").ResolveWorkflowDecisionRequest,"human",{kind:"human",id:approver},()=>true);
  assert.ok(approved.ok,approved.error ?? "human approval");
  const consumed = await h.svc.consumeWorkflowDecision("child",decision.occurrenceId,{resourceSnapshot:decision.resourceSnapshot}); assert.ok(consumed.ok,consumed.error ?? "consume");
  h.state.publicationTitles[issue] = `[Feature]: ${title}`;
  if (accept) assert.ok(h.svc.adjudicateCampaignRecommendation("root",{recommendationId:rec.data!.id,disposition:"accepted",reason:"Published payload read back",
    resultingWorkItemKey:`followup:${rec.data!.id}`,resultingIssue:{repository:"team/repo",number:issue}}).ok);
  return { decision, recommendationId: rec.data!.id };
}

const followUpScope = (h: ScopeHarness, requestId: string, publicationOccurrenceId: string, issue = 101, expectedRevision = 1) =>
  h.svc.proposeCampaignIssueScope("root",{requestId,expectedRevision,additions:[{repository:"team/repo",number:issue}],removals:[],
    explanation:"Published follow-up of an accepted recommendation",lineage:{kind:"follow_up",publicationOccurrenceId}});

const refusalCode = (result: { ok: boolean; errorDetails?: Record<string, string | number> }) => result.ok ? "admitted" : result.errorDetails?.code;

const approvedAt = (h: ScopeHarness, decision: WorkflowDecisionView) =>
  h.db.workflowDecisionHumanApprover(h.db.workflowDecisionByOccurrence(decision.occurrenceId)!)!.approvedAt;

type ScopeSnapshot = Extract<WorkflowDecisionView["resourceSnapshot"],{category:"campaign_issue_scope"}>;

test("#2940 a person-approved consumed publication of an accepted recommendation admits exactly its issue, once", async () => {
  const h = harness(true, 3);
  try {
    const p = await humanApprovedPublication(h);
    const scope = await followUpScope(h, "human-approved", p.decision.occurrenceId);
    assert.ok(scope.ok, scope.error ?? "scope"); assert.equal(scope.data!.authority, "orchestrator");
    const snapshot = scope.data!.resourceSnapshot as ScopeSnapshot;
    assert.deepEqual(snapshot.verifiedPublications, [{ publicationOccurrenceId: p.decision.occurrenceId, issue: 101 }]);
    // The admission evidence names the person's approval, so it differs from a bounded grant's.
    const bounded = { occurrenceId: p.decision.occurrenceId, payloadDigest: p.decision.resourceDigest, issue: 101 };
    assert.equal(snapshot.issueAdmission!.evidenceDigest, issueEvidenceDigest({ ...bounded, approval: { kind: "human", approvedByUserId: h.principal.userId,
      approvedAt: approvedAt(h, p.decision), basis: "boundary_author", objective: "current_authorization" } }));
    assert.notEqual(snapshot.issueAdmission!.evidenceDigest, issueEvidenceDigest(bounded));
    assert.ok(h.approve(scope.data!).ok);
    assert.deepEqual(h.db.getSession("root")!.orchestratorPolicy!.issueNumbers, [100, 101]);
    assert.equal(h.db.admittedCampaignPublicationIssue("root", p.decision.occurrenceId), 101);
    // The same grant cannot admit a second issue, even after the ledger names another one.
    h.state.publicationTitles[102] = "[Feature]: Human approved repair";
    assert.ok(h.svc.adjudicateCampaignRecommendation("root",{recommendationId:p.recommendationId,disposition:"accepted",reason:"Copied payload claim",
      resultingWorkItemKey:`copy:${p.recommendationId}`,resultingIssue:{repository:"team/repo",number:102}}).ok);
    const reuse = await followUpScope(h, "human-approved-reuse", p.decision.occurrenceId, 102, 2);
    assert.equal(refusalCode(reuse), "publication_already_admitted"); assert.equal(reuse.status, 409);
    assert.deepEqual(h.db.getSession("root")!.orchestratorPolicy!.issueNumbers, [100, 101]);
  } finally { h.db.close(); }
});

test("#2940 a person-approved publication grants scope only when its approver is the boundary author or a campaign owner", async () => {
  const h = harness(true, 3);
  try {
    member(h, "usr_operator", "operator");
    const p = await humanApprovedPublication(h, { approver: "usr_operator" });
    const refused = await followUpScope(h, "other-person", p.decision.occurrenceId);
    assert.equal(refusalCode(refused), "publication_approver_not_owner"); assert.equal(refused.status, 403);
    assert.match(refused.error!, /neither the Full Control boundary's author nor an owner of this campaign/);
    assert.equal(JSON.stringify(refused).includes("usr_operator"), false, "the refusal names no person");
    assert.deepEqual(h.db.getSession("root")!.orchestratorPolicy!.issueNumbers, [100]);
  } finally { h.db.close(); }
  // Every member owns an organization-owned campaign's session, so only an active owner or admin of
  // the organization counts there: not an operator (above), a viewer or a suspended administrator.
  const shared = harness(true, 5);
  try {
    member(shared, "usr_viewer", "viewer"); member(shared, "usr_suspended", "admin"); member(shared, "usr_admin", "admin");
    shared.db.raw().prepare("UPDATE identity_users SET status='suspended' WHERE user_id='usr_suspended'").run();
    const viewer = await humanApprovedPublication(shared, { approver: "usr_viewer", title: "Viewer repair", issue: 101 });
    assert.equal(refusalCode(await followUpScope(shared, "viewer", viewer.decision.occurrenceId, 101)), "publication_approver_not_owner");
    const suspended = await humanApprovedPublication(shared, { approver: "usr_suspended", title: "Suspended repair", issue: 102 });
    assert.equal(refusalCode(await followUpScope(shared, "suspended", suspended.decision.occurrenceId, 102)), "publication_approver_not_owner");
    const owner = await humanApprovedPublication(shared, { approver: "usr_admin", title: "Owner repair", issue: 103 });
    const admitted = await followUpScope(shared, "owner", owner.decision.occurrenceId, 103);
    assert.ok(admitted.ok, admitted.error ?? "owner scope");
    assert.equal((admitted.data!.resourceSnapshot as ScopeSnapshot).issueAdmission!.evidenceDigest, issueEvidenceDigest({ occurrenceId: owner.decision.occurrenceId,
      payloadDigest: owner.decision.resourceDigest, issue: 103, approval: { kind: "human", approvedByUserId: "usr_admin", approvedAt: approvedAt(shared, owner.decision), basis: "campaign_owner", objective: "current_authorization" } }));
  } finally { shared.db.close(); }
  // A user-owned campaign is owned by that user alone; another administrator is not its owner.
  const personal = harness(true, 5);
  try {
    member(personal, "usr_owner", "operator"); member(personal, "usr_admin", "admin");
    personal.db.raw().prepare("UPDATE session_ownership SET owner_kind='user', owner_id='usr_owner' WHERE session_id='root'").run();
    const other = await humanApprovedPublication(personal, { approver: "usr_admin", title: "Administrator repair", issue: 101 });
    assert.equal(refusalCode(await followUpScope(personal, "administrator", other.decision.occurrenceId, 101)), "publication_approver_not_owner");
    const owned = await humanApprovedPublication(personal, { approver: "usr_owner", title: "Owner repair", issue: 102 });
    const admitted = await followUpScope(personal, "user-owner", owned.decision.occurrenceId, 102);
    assert.ok(admitted.ok, admitted.error ?? "user owner scope");
  } finally { personal.db.close(); }
});

test("#2940 a person-approved publication cannot exceed the human-set issue limit", async () => {
  const h = harness(true, 1);
  try {
    const p = await humanApprovedPublication(h);
    const refused = await followUpScope(h, "over-limit", p.decision.occurrenceId);
    assert.equal(refusalCode(refused), "capacity_exhausted"); assert.equal(refused.status, 409);
    assert.equal(h.db.admittedCampaignPublicationIssue("root", p.decision.occurrenceId), null);
    assert.deepEqual(h.db.getSession("root")!.orchestratorPolicy!.issueNumbers, [100]);
    // The limit is the campaign's, not the raw Maximum Issues: once the person admits a follow-up
    // past the approval limit, its slot holds an issue here too (#3826).
    const budgetAuthority = { version: 1 as const, concurrency: 3, acceptedFollowUps: 0, accounting: "managed_workers_only" as const, unpriced: "stop" as const };
    const policy = h.db.getSession("root")!.orchestratorPolicy!;
    if (policy.control?.mode === "full_control") policy.control.boundary.budgetAuthority = budgetAuthority;
    h.db.raw().prepare("UPDATE sessions SET orchestrator_policy=? WHERE id='root'").run(JSON.stringify(policy));
    h.db.campaignBudgets.authorize("root", budgetAuthority);
    const other = h.svc.recordCampaignFollowUp("root", { originSessionId: "child", repository: "team/repo", title: "Other repair", originWorkItemIds: [h.item.id] });
    assert.ok(other.ok, other.error ?? "record");
    const accept = () => h.svc.adjudicateCampaignRecommendation("root", { recommendationId: other.data!.id, disposition: "accepted", reason: "Observed related work" });
    const over = accept(); assert.equal(over.ok, false);
    const admission = h.db.workflowDecisionByOccurrence(/decision (workflow_[a-f0-9]+)/u.exec(over.error ?? "")![1]!)!;
    assert.ok(h.approve(admission).ok); assert.ok(accept().ok);
    assert.equal(h.db.campaignIssueLimit("root", 1), 2);
    const admitted = await followUpScope(h, "within-admitted-slot", p.decision.occurrenceId);
    assert.ok(admitted.ok, admitted.error ?? "admitted slot");
  } finally { h.db.close(); }
});

// CR-1.1: a person's approval proves the current objective only when it followed the current
// authorization, or when the boundary the server recorded with it has the current author and
// objective. A changed objective, or an approval recorded without its boundary, needs fresh review.
test("#2940 a person-approved publication carries its approval only across a same-author, same-objective re-mint", async () => {
  const reauthorize = (h: ScopeHarness, objective: string, expectedRevision = 2) => h.svc.setCampaignControl("root", { mode: "full_control", objective,
    operations: ["campaign_issue_scope", "issue_closure", "follow_up_issue_publication", "implementation_question"], delegatablePolicyIds: [],
    issueAuthority: { epics: [100], relatedFollowUps: true, maxIssues: 3, closureReasons: ["completed", "not_planned"] } }, expectedRevision, h.principal);
  const tick = () => new Promise((resolve) => setTimeout(resolve, 5));
  const changed = harness(true, 3);
  try {
    const p = await humanApprovedPublication(changed);
    await tick();
    assert.ok(reauthorize(changed, "A different objective").ok);
    const refused = await followUpScope(changed, "changed-objective", p.decision.occurrenceId);
    assert.equal(refusalCode(refused), "publication_approved_under_earlier_boundary"); assert.equal(refused.status, 403);
    assert.match(refused.error!, /approved before the current Full Control authorization.*Campaign Status/);
    assert.deepEqual(changed.db.getSession("root")!.orchestratorPolicy!.issueNumbers, [100]);
    assert.equal(changed.db.admittedCampaignPublicationIssue("root", p.decision.occurrenceId), null);
    // A publication the person approves under the new authorization is admitted.
    const fresh = await humanApprovedPublication(changed, { title: "Fresh repair", issue: 102 });
    assert.ok((await followUpScope(changed, "fresh-objective", fresh.decision.occurrenceId, 102)).ok);
  } finally { changed.db.close(); }
  const remint = async (h: ScopeHarness) => {
    await tick();
    const added = await h.svc.proposeCampaignIssueScope("root",{requestId:"human-remint",expectedRevision:1,additions:[{repository:"team/repo",number:150}],removals:[],
      explanation:"Owner adds separate scope"},()=>true,h.principal);
    assert.ok(added.ok, added.error ?? "human scope"); assert.ok(h.approve(added.data!).ok);
  };
  const kept = harness(true, 3);
  try {
    const p = await humanApprovedPublication(kept);
    await remint(kept);
    const admitted = await followUpScope(kept, "same-objective-remint", p.decision.occurrenceId, 101, 2);
    assert.ok(admitted.ok, admitted.error ?? "re-minted scope");
    assert.equal((admitted.data!.resourceSnapshot as ScopeSnapshot).issueAdmission!.evidenceDigest, issueEvidenceDigest({ occurrenceId: p.decision.occurrenceId,
      payloadDigest: p.decision.resourceDigest, issue: 101, approval: { kind: "human", approvedByUserId: kept.principal.userId, approvedAt: approvedAt(kept, p.decision),
        basis: "boundary_author", objective: "recorded_boundary" } }));
  } finally { kept.db.close(); }
  // An approval whose audit carries no recorded boundary, as every one before this change, proves
  // nothing once the boundary is re-minted after it.
  const unrecorded = harness(true, 3);
  try {
    const p = await humanApprovedPublication(unrecorded);
    unrecorded.db.raw().prepare(`UPDATE governance_audit SET workflow_decision=json_remove(workflow_decision, '$.publicationAuthority')
      WHERE request_id=? AND stage='resolution' AND outcome='allowed'`).run(p.decision.occurrenceId);
    await remint(unrecorded);
    assert.equal(refusalCode(await followUpScope(unrecorded, "unrecorded-remint", p.decision.occurrenceId, 101, 2)), "publication_approved_under_earlier_boundary");
    assert.deepEqual(unrecorded.db.getSession("root")!.orchestratorPolicy!.issueNumbers, [100, 150]);
  } finally { unrecorded.db.close(); }
});

test("#2940 only the server records the boundary of a person's publication approval", async () => {
  const h = harness(true, 3);
  try {
    // A resolution that names its own boundary is ignored: the record is the controller's.
    const forged = { authorizedByUserId: "usr_forged", objectiveDigest: "1".repeat(64) };
    const p = await humanApprovedPublication(h, { resolution: { publicationAuthority: forged } });
    const boundary = (h.db.getSession("root")!.orchestratorPolicy!.control as Extract<CampaignControl,{mode:"full_control"}>).boundary;
    assert.deepEqual(h.db.workflowDecisionHumanApprover(h.db.workflowDecisionByOccurrence(p.decision.occurrenceId)!)!.publicationAuthority,
      { authorizedByUserId: boundary.authorizedByUserId, objectiveDigest: issueEvidenceDigest(boundary.objective) });
  } finally { h.db.close(); }
  const custom = harness(false, 3);
  try {
    const rec = custom.svc.recordCampaignFollowUp("root",{originSessionId:"child",repository:"team/repo",title:"Custom repair",originWorkItemIds:[custom.item.id]}); assert.ok(rec.ok);
    const publication = await custom.svc.createWorkflowDecisionWithVideo("child",{requestId:"custom-pub",resourceKey:"custom-pub",resourceSnapshot:{category:"follow_up_issue_publication",
      repository:"team/repo",sanitizedTitle:"Custom repair",sanitizedBody:body,labels:[]}});
    assert.ok(publication.ok);
    assert.ok(custom.svc.resolveWorkflowDecision("root","child",publication.data!.occurrenceId,{outcome:"approve"},"human",{kind:"human",id:custom.principal.userId},()=>true).ok);
    assert.equal(custom.db.workflowDecisionHumanApprover(custom.db.workflowDecisionByOccurrence(publication.data!.occurrenceId)!)!.publicationAuthority, undefined,
      "no Full Control issue boundary, nothing recorded");
  } finally { custom.db.close(); }
});

test("#2940 a person-approved publication names the failed condition: removed origin, unaccepted recommendation, payload mismatch", async () => {
  const removed = harness(true, 3);
  try {
    // The owner's removal re-mints the boundary with the same objective, so only the origin fails.
    const p = await humanApprovedPublication(removed);
    const swap = await removed.svc.proposeCampaignIssueScope("root",{requestId:"swap-origin",expectedRevision:1,additions:[{repository:"team/repo",number:150}],
      removals:[{repository:"team/repo",number:100}],explanation:"Owner replaces the origin"},()=>true,removed.principal);
    assert.ok(swap.ok, swap.error ?? "swap"); assert.ok(removed.approve(swap.data!).ok);
    const refused = await followUpScope(removed, "removed-origin", p.decision.occurrenceId, 101, 2);
    assert.equal(refusalCode(refused), "origin_outside_scope");
    assert.equal(refused.error, "The published follow-up's authorized origins were removed from scope");
  } finally { removed.db.close(); }
  const unaccepted = harness(true, 3);
  try {
    const p = await humanApprovedPublication(unaccepted, { accept: false });
    assert.equal(refusalCode(await followUpScope(unaccepted, "unaccepted", p.decision.occurrenceId)), "recommendation_not_accepted");
  } finally { unaccepted.db.close(); }
  const unrecorded = harness(true, 3);
  try {
    const p = await humanApprovedPublication(unrecorded);
    unrecorded.state.publicationTitles[109] = "[Feature]: Human approved repair";
    assert.equal(refusalCode(await followUpScope(unrecorded, "other-issue", p.decision.occurrenceId, 109)), "resulting_issue_mismatch");
  } finally { unrecorded.db.close(); }
  const mismatch = harness(true, 3);
  try {
    const p = await humanApprovedPublication(mismatch);
    const runner = mismatch.hub.requestFromRunner.bind(mismatch.hub);
    mismatch.hub.requestFromRunner = async (runnerId, requestId, message, timeout) => {
      const result = await runner(runnerId, requestId, message, timeout);
      return message.type === "campaign_issue_scope" && message.operation === "inspect" && message.publication && result.type === "campaign_issue_scope_result"
        ? { ...result, candidates: result.candidates?.map((c) => ({ ...c, title: "[Feature]: An edited title" })) } : result;
    };
    assert.equal(refusalCode(await followUpScope(mismatch, "payload-mismatch", p.decision.occurrenceId)), "payload_mismatch");
    assert.equal(mismatch.db.admittedCampaignPublicationIssue("root", p.decision.occurrenceId), null);
  } finally { mismatch.db.close(); }
});

test("#2940 Orchestrator scope refusals name their condition with a bounded code and no requested content", async () => {
  const h = harness(true, 5);
  try {
    const propose = (requestId: string, change: Partial<import("@wollipog/protocol").CampaignIssueScopeRequest>) => h.svc.proposeCampaignIssueScope("root",
      { requestId, expectedRevision: 1, additions: [{ repository: "team/repo", number: 101 }], removals: [], explanation: "Secret-looking explanation text", ...change });
    const none = await propose("no-lineage", {});
    assert.equal(refusalCode(none), "lineage_missing"); assert.equal(none.status, 403);
    assert.match(none.error!, /incidental references cannot grant scope.*Campaign Status/);
    assert.equal(JSON.stringify(none).includes("Secret-looking"), false);
    assert.equal(refusalCode(await propose("other-epic", { lineage: { kind: "epic", epic: 999 } })), "epic_not_authorized");
    assert.equal(refusalCode(await propose("unknown-publication", { lineage: { kind: "follow_up", publicationOccurrenceId: "missing" } })), "publication_not_found");
    assert.equal(refusalCode(await propose("two-follow-ups", { additions: [{ repository: "team/repo", number: 101 }, { repository: "team/repo", number: 102 }],
      lineage: { kind: "follow_up", publicationOccurrenceId: "missing" } })), "follow_up_not_single");
    const pending = await h.svc.createWorkflowDecisionWithVideo("child",{requestId:"pending-human",resourceKey:"pending-human",resourceSnapshot:{category:"follow_up_issue_publication",
      repository:"team/repo",sanitizedTitle:"Pending repair",sanitizedBody:body,labels:[]}});
    assert.ok(pending.ok, pending.error ?? "pending");
    assert.equal(refusalCode(await propose("pending", { lineage: { kind: "follow_up", publicationOccurrenceId: pending.data!.occurrenceId } })), "publication_not_consumed");
  } finally { h.db.close(); }
  const noFollowUps = harness(true, 5);
  try {
    assert.ok(noFollowUps.svc.setCampaignControl("root",{mode:"full_control",objective:"Implement epic 100",operations:["campaign_issue_scope"],delegatablePolicyIds:[],
      issueAuthority:{epics:[100],relatedFollowUps:false,maxIssues:5,closureReasons:[]}},2,noFollowUps.principal).ok);
    assert.equal(refusalCode(await followUpScope(noFollowUps, "no-follow-ups", "missing")), "follow_ups_not_authorized");
  } finally { noFollowUps.db.close(); }
});

test("#2940 the bounded publication path admits unchanged and refuses with the new codes", async () => {
  const h = harness(true, 3);
  try {
    const p = await consumedPublication(h);
    const scope = await followUpScope(h, "bounded", p.decision.occurrenceId);
    assert.ok(scope.ok, scope.error ?? "bounded scope"); assert.equal(scope.data!.authority, "orchestrator");
    assert.equal((scope.data!.resourceSnapshot as ScopeSnapshot).issueAdmission!.evidenceDigest,
      issueEvidenceDigest({ occurrenceId: p.decision.occurrenceId, payloadDigest: p.decision.resourceDigest, issue: 101 }), "a bounded grant's admission evidence is exactly what it was");
    assert.ok(h.approve(scope.data!).ok);
    assert.equal(h.db.admittedCampaignPublicationIssue("root", p.decision.occurrenceId), 101);
    assert.equal(refusalCode(await followUpScope(h, "bounded-again", p.decision.occurrenceId, 102, 2)), "publication_already_admitted");
  } finally { h.db.close(); }
});

test("#2940 Custom campaigns and the owner's Campaign Status route treat a person-approved publication as before", async () => {
  const custom = harness(false, 3);
  try {
    const rec = custom.svc.recordCampaignFollowUp("root",{originSessionId:"child",repository:"team/repo",title:"Custom repair",originWorkItemIds:[custom.item.id]}); assert.ok(rec.ok);
    const publication = await custom.svc.createWorkflowDecisionWithVideo("child",{requestId:"custom-pub",resourceKey:"custom-pub",resourceSnapshot:{category:"follow_up_issue_publication",
      repository:"team/repo",sanitizedTitle:"Custom repair",sanitizedBody:body,labels:[],recommendationId:rec.data!.id}});
    assert.ok(publication.ok); assert.equal(publication.data!.authority, "human");
    assert.ok(custom.svc.resolveWorkflowDecision("root","child",publication.data!.occurrenceId,{outcome:"approve"},"human",{kind:"human",id:custom.principal.userId},()=>true).ok);
    assert.ok((await custom.svc.consumeWorkflowDecision("child",publication.data!.occurrenceId,{resourceSnapshot:publication.data!.resourceSnapshot})).ok);
    const scope = await followUpScope(custom, "custom-follow-up", publication.data!.occurrenceId);
    assert.ok(scope.ok, scope.error ?? "custom scope"); assert.equal(scope.data!.authority, "human");
    const snapshot = scope.data!.resourceSnapshot as ScopeSnapshot;
    assert.equal(snapshot.issueAdmission, undefined); assert.equal(snapshot.verifiedPublications, undefined);
  } finally { custom.db.close(); }
  const full = harness(true, 3);
  try {
    await humanApprovedPublication(full);
    const direct = await full.svc.proposeCampaignIssueScope("root",{requestId:"owner-direct",expectedRevision:1,additions:[{repository:"team/repo",number:101}],removals:[],
      explanation:"Owner adopts the published follow-up"},()=>true,full.principal);
    assert.ok(direct.ok, direct.error ?? "owner proposal"); assert.equal(direct.data!.authority, "human");
    const snapshot = direct.data!.resourceSnapshot as ScopeSnapshot;
    assert.equal(snapshot.issueAdmission, undefined); assert.equal(snapshot.verifiedPublications, undefined, "the owner's route settles only bounded grants, as before");
    assert.ok(full.approve(direct.data!).ok);
    assert.deepEqual(full.db.getSession("root")!.orchestratorPolicy!.issueNumbers, [100, 101]);
  } finally { full.db.close(); }
});

// #3918, observed live: a Custom campaign's publication dropped the recommendation it named, so
// consuming with the requested snapshot was refused as stale and revoked the approval, and nothing
// linked the published issue back to the accepted recommendation.
const workSummary = (h: ReturnType<typeof harness>) => h.db.campaignWorkLedger.summary("root",
  { campaignCreatedAt: 1, complete: false, childSessionIds: ["child"], cleanupPending: 0 });
const workItemCount = (h: ReturnType<typeof harness>) => {
  const page = h.db.campaignWorkLedger.page("root", { state: "all", limit: 100 }, Date.now());
  assert.ok(page.ok); return page.data.items.length;
};
const humanApprove = (h: ReturnType<typeof harness>, requester: string, d: WorkflowDecisionView) =>
  h.svc.resolveWorkflowDecision("root", requester, d.occurrenceId, { outcome: "approve" }, "human", { kind: "human", id: h.principal.userId }, () => true);

/** The documented step after publishing (#3918): record the issue on the accepted recommendation. */
function linksPublishedIssue(h: ReturnType<typeof harness>, recommendationId: string, issue: number) {
  const before = h.db.campaignWorkLedger.recommendation("root", recommendationId)!;
  assert.equal(before.publication, "awaiting_publication");
  assert.ok(before.resultingWorkItemId, "acceptance created the follow-up work item");
  const items = workItemCount(h);
  assert.equal(workSummary(h).obligations.publication, 1);
  const linked = h.svc.adjudicateCampaignRecommendation("root", { recommendationId, disposition: "accepted", reason: "Published payload read back",
    resultingIssue: { repository: "team/repo", number: issue } });
  assert.ok(linked.ok, linked.error ?? "link");
  assert.equal(linked.data!.workItem?.id, before.resultingWorkItemId, "the existing work item is linked");
  assert.equal(workItemCount(h), items, "no second work item is created");
  assert.deepEqual(linked.data!.workItem?.issue, { repository: "team/repo", number: issue });
  const after = h.db.campaignWorkLedger.recommendation("root", recommendationId)!;
  assert.equal(after.publication, "published");
  assert.deepEqual(after.resultingIssue, { repository: "team/repo", number: issue });
  assert.equal(workSummary(h).obligations.publication, 0);
}

for (const named of [true, false]) {
  test(`#3918 a Custom child's publication ${named ? "naming" : "without"} its recommendation is consumed as requested and links its existing item`, async () => {
    const h = harness(false);
    try {
      const recommendationId = acceptedRecommendation(h);
      const requested = { category: "follow_up_issue_publication" as const, repository: "team/repo", sanitizedTitle: "[Feature]: Related repair",
        sanitizedBody: body, labels: ["enhancement"], ...(named ? { recommendationId } : {}) };
      const created = await h.svc.createWorkflowDecisionWithVideo("child", { requestId: "custom", resourceKey: "custom", resourceSnapshot: requested });
      assert.ok(created.ok, created.error ?? "request");
      const decision = created.data!;
      assert.equal(decision.authority, "human");
      assert.equal(decision.controllingSessionId, "root");
      assert.deepEqual(decision.resourceSnapshot, requested, "the stored snapshot is exactly the requested one");
      assert.deepEqual(h.svc.workflowDecision("child", decision.occurrenceId).data!.resourceSnapshot, requested);
      if (named) assert.equal(decision.authorityEvaluation?.admissionFailure, "no_issue_boundary", "the person sees why it is theirs");
      assert.equal(h.db.campaignPublicationReservations("root").length, 0, "a named recommendation reserves no bounded slot");
      assert.ok(humanApprove(h, "child", decision).ok);
      const consumed = await h.svc.consumeWorkflowDecision("child", decision.occurrenceId, { resourceSnapshot: requested });
      assert.ok(consumed.ok, consumed.error ?? "consume");
      assert.equal(consumed.data!.status, "consumed");
      linksPublishedIssue(h, recommendationId, 101);
    } finally { h.db.close(); }
  });
}

test("#3918 a person-approved publication's named recommendation never replaces the title match or makes it bounded", async () => {
  const h = harness(true, 3);
  try {
    const alpha = acceptedRecommendation(h, "Alpha repair");
    h.state.publicationOk = true;
    // The name claims Alpha for a Beta payload: bounded admission refuses, and the person decides.
    const requested = { category: "follow_up_issue_publication" as const, repository: "team/repo", sanitizedTitle: "[Feature]: Beta repair",
      sanitizedBody: body, labels: [], recommendationId: alpha };
    const created = await h.svc.createWorkflowDecisionWithVideo("child", { requestId: "beta", resourceKey: "beta", resourceSnapshot: requested });
    assert.ok(created.ok, created.error ?? "request");
    assert.equal(created.data!.authority, "human");
    assert.equal(created.data!.authorityEvaluation?.admissionFailure, "title_mismatch");
    assert.deepEqual(created.data!.resourceSnapshot, requested);
    assert.equal(h.db.campaignPublicationReservations("root").length, 0);
    assert.ok(humanApprove(h, "child", created.data!).ok);
    assert.ok((await h.svc.consumeWorkflowDecision("child", created.data!.occurrenceId, { resourceSnapshot: requested })).ok);
    h.state.publicationTitles[101] = requested.sanitizedTitle;
    assert.ok(h.svc.adjudicateCampaignRecommendation("root", { recommendationId: alpha, disposition: "accepted", reason: "Claimed delivery",
      resultingIssue: { repository: "team/repo", number: 101 } }).ok);
    const scope = await followUpScope(h, "named-other-title", created.data!.occurrenceId);
    assert.equal(refusalCode(scope), "recommendation_not_found");
    assert.deepEqual(h.db.getSession("root")!.orchestratorPolicy!.issueNumbers, [100]);
  } finally { h.db.close(); }
});

// #3919, observed live: a Custom root that drafted a follow-up itself was refused with "no
// controlling Orchestrator ancestor" and had to create a child only to publish it.
test("#3919 a Custom root requests its own publication, only the campaign owner decides it, and consume stays exact and one-shot", async () => {
  const h = harness(false);
  try {
    // Even a delegated publication policy never lets the root own its own request.
    assert.ok(h.svc.setParentControlPolicy("root", { ...HUMAN_ONLY_PARENT_CONTROL_POLICY, follow_up_issue_publication: "orchestrator" }).ok);
    const requested = { category: "follow_up_issue_publication" as const, repository: "team/repo", sanitizedTitle: "[Bug]: Root drafted repair",
      sanitizedBody: body, labels: ["bug"] };
    const created = await h.svc.createWorkflowDecisionWithVideo("root", { requestId: "root-draft", resourceKey: "root-draft", resourceSnapshot: requested });
    assert.ok(created.ok, created.error ?? "root request");
    const decision = created.data!;
    assert.equal(decision.status, "pending");
    assert.equal(decision.authority, "human");
    assert.equal(decision.sessionId, "root");
    assert.equal(decision.controllingSessionId, "root");
    assert.deepEqual(decision.resourceSnapshot, requested);
    assert.equal(h.db.getSession("root")!.status, "input_required");
    // The root's agent cannot approve its own occurrence by any route.
    const asOrchestrator = h.svc.resolveWorkflowDecision("root", "root", decision.occurrenceId, { outcome: "approve" }, "orchestrator", { kind: "agent", id: "root" }, () => true);
    assert.equal(asOrchestrator.ok, false); assert.equal(asOrchestrator.status, 403);
    const asAgent = h.svc.resolveWorkflowDecision("root", "root", decision.occurrenceId, { outcome: "approve" }, "human", { kind: "agent", id: "root" }, () => true);
    assert.equal(asAgent.ok, false); assert.equal(asAgent.status, 403);
    const descendant = h.svc.resolveDescendantRequest("root", "root", decision.occurrenceId, { action: "resolve_workflow_decision", outcome: "approve" }, () => true);
    assert.equal(descendant.ok, false);
    const viaCard = h.svc.approve("root", decision.occurrenceId, "approve", { kind: "agent", id: "root" });
    assert.equal(viaCard.ok, false); assert.equal(viaCard.status, 403);
    // A person who is not the campaign's owner cannot decide it either.
    member(h, "usr_operator", "operator");
    const other = h.svc.resolveWorkflowDecision("root", "root", decision.occurrenceId, { outcome: "approve" }, "human", { kind: "human", id: "usr_operator" }, () => true);
    assert.equal(other.ok, false); assert.equal(other.status, 403);
    assert.match(other.error!, /Only the campaign owner/);
    assert.equal(h.db.workflowDecisionByOccurrence(decision.occurrenceId)!.status, "pending");
    // The owner approves it from the root's card.
    const approved = h.svc.approve("root", decision.occurrenceId, "approve", { kind: "human", id: h.principal.userId });
    assert.ok(approved.ok, approved.error ?? "owner approval");
    assert.equal(h.db.workflowDecisionByOccurrence(decision.occurrenceId)!.status, "approved");
    // A changed snapshot is refused and revokes the approval, which can then never be consumed.
    const changed = await h.svc.consumeWorkflowDecision("root", decision.occurrenceId, { resourceSnapshot: { ...requested, sanitizedTitle: "[Bug]: Another repair" } });
    assert.equal(changed.ok, false); assert.equal(changed.status, 409); assert.match(changed.error!, /stale/);
    assert.equal(h.db.workflowDecisionByOccurrence(decision.occurrenceId)!.status, "revoked");
    const revoked = await h.svc.consumeWorkflowDecision("root", decision.occurrenceId, { resourceSnapshot: requested });
    assert.equal(revoked.ok, false); assert.equal(revoked.status, 409);
    // A fresh request naming an accepted recommendation is consumed once, then linked.
    const recommendationId = acceptedRecommendation(h, "Root drafted repair");
    const again = { ...requested, recommendationId };
    const second = await h.svc.createWorkflowDecisionWithVideo("root", { requestId: "root-draft-2", resourceKey: "root-draft", resourceSnapshot: again });
    assert.ok(second.ok, second.error ?? "second request");
    assert.equal(second.data!.authority, "human");
    assert.deepEqual(second.data!.resourceSnapshot, again);
    assert.ok(h.svc.approve("root", second.data!.occurrenceId, "approve", { kind: "human", id: h.principal.userId }).ok);
    const consumed = await h.svc.consumeWorkflowDecision("root", second.data!.occurrenceId, { resourceSnapshot: again });
    assert.ok(consumed.ok, consumed.error ?? "consume"); assert.equal(consumed.data!.status, "consumed");
    const reused = await h.svc.consumeWorkflowDecision("root", second.data!.occurrenceId, { resourceSnapshot: again });
    assert.equal(reused.ok, false); assert.equal(reused.status, 409);
    linksPublishedIssue(h, recommendationId, 101);
  } finally { h.db.close(); }
});

test("#3919 a root's own publication leaves child, nested and non-campaign requesters as before", async () => {
  const h = harness(false);
  try {
    assert.ok(h.svc.setParentControlPolicy("root", { ...HUMAN_ONLY_PARENT_CONTROL_POLICY, follow_up_issue_publication: "orchestrator" }).ok);
    const policy = h.db.getSession("root")!.parentControlPolicy!;
    h.db.createSession({ id: "nested", runnerId: "r", workspaceId: "w", agentId: "codex", title: "nested", useWorktree: false, driver: "codex-app-server", now: 1, config: {},
      role: "orchestrator", parentSessionId: "root", parentControlPolicy: { decisions: { ...HUMAN_ONLY_PARENT_CONTROL_POLICY } } });
    h.db.createSession({ id: "solo", runnerId: "r", workspaceId: "w", agentId: "codex", title: "solo", useWorktree: false, driver: "codex-app-server", now: 1, config: {} });
    for (const id of ["nested", "solo"]) h.db.updateSessionStatus(id, "running", 2);
    const snapshot = (title: string) => ({ category: "follow_up_issue_publication" as const, repository: "team/repo", sanitizedTitle: title, sanitizedBody: body, labels: [] });
    // A child's publication still follows the root's saved policy.
    const child = await h.svc.createWorkflowDecisionWithVideo("child", { requestId: "child", resourceKey: "child", resourceSnapshot: snapshot("Child repair") });
    assert.ok(child.ok, child.error ?? "child");
    assert.equal(child.data!.controllingSessionId, "root"); assert.equal(child.data!.authority, "orchestrator");
    assert.equal(child.data!.policyRevision, policy.revision);
    // A nested Orchestrator's publication belongs to the root, not to itself.
    const nested = await h.svc.createWorkflowDecisionWithVideo("nested", { requestId: "nested", resourceKey: "nested", resourceSnapshot: snapshot("Nested repair") });
    assert.ok(nested.ok, nested.error ?? "nested");
    assert.equal(nested.data!.controllingSessionId, "root"); assert.equal(nested.data!.authority, "orchestrator");
    // A session outside any campaign still has nobody to control its publication.
    const solo = await h.svc.createWorkflowDecisionWithVideo("solo", { requestId: "solo", resourceKey: "solo", resourceSnapshot: snapshot("Solo repair") });
    assert.equal(solo.ok, false); assert.equal(solo.status, 409);
    assert.match(solo.error!, /no controlling Orchestrator ancestor/);
  } finally { h.db.close(); }
});

/* ---------- #3915: a scope change binds and revokes only what depends on the issues it changes ---------- */

/** Ledger-attributed children for scope-impact tests: each gets an open attempt on a plan item
 * and its launch prompt, so the work ledger can prove what it is unrelated to (#3914). */
function scopeImpactFixture(h: ReturnType<typeof harness>) {
  assert.ok(h.svc.recordCampaignPlan("root", { items: [{ key: "other" }, { key: "issue:101", issue: { repository: "team/repo", number: 101 } }],
    planComplete: true }).ok);
  const page = h.db.campaignWorkLedger.page("root", { state: "all", limit: 100 }, Date.now()); assert.ok(page.ok);
  const itemId = (key: string) => page.data.items.find((item) => item.key === key)!.id;
  const policy = h.db.getSession("root")!.parentControlPolicy!;
  assert.ok(h.svc.setParentControlPolicy("root", { ...policy.decisions, pr_merge: "orchestrator" }, policy.revision).ok);
  const runner = h.hub.requestFromRunner;
  h.hub.requestFromRunner = async (runnerId, requestId, message, timeout) => message.type === "github_merge_preflight"
    ? { type: "github_merge_preflight_result", requestId, sessionId: message.sessionId, ok: true, check: { checkedAt: 1, closures: [] } }
    : runner(runnerId, requestId, message, timeout);
  const child = (id: string, key: string, driver: "codex-app-server" | "claude-code" = "codex-app-server") => {
    if (!h.db.getSession(id)) h.db.createSession({ id, runnerId: "r", workspaceId: "w", agentId: "codex", title: id, parentSessionId: "root",
      driver, config: {}, useWorktree: false, now: Date.now() });
    h.db.updateSessionStatus(id, "running", Date.now());
    h.db.appendEvent(id, { kind: "user_message", text: `Deliver ${key}` }, Date.now());
    const assigned = h.svc.assignCampaignWorkItem("root", { workItemId: itemId(key), childSessionId: id });
    assert.ok(assigned.ok, assigned.error ?? "refused");
    return id;
  };
  const question = (sessionId: string, requestId: string) => {
    const created = h.svc.createWorkflowDecision(sessionId, { requestId, resourceKey: requestId, resourceSnapshot: { category: "implementation_question",
      question: "Which test?", options: [{ optionId: "a", label: "A" }, { optionId: "b", label: "B" }] } });
    assert.ok(created.ok && created.data, created.error ?? "refused");
    return created.data.occurrenceId;
  };
  /** An Orchestrator-approved merge its Claude Code child has armed: the enqueue already ran. */
  const armedMerge = async (sessionId: string, pullRequest: number) => {
    const headSha = String(pullRequest).padStart(40, "a");
    const snapshot = { category: "pr_merge" as const, repository: "team/repo", pullRequest, headSha, reviewResult: "merge" as const,
      requiredChecks: { headSha, status: "passed" as const, checkedAt: 10, checks: [{ name: "Typecheck, Test & Sidecar Bundle", state: "passed" as const }] } };
    const created = h.svc.createWorkflowDecision(sessionId, { requestId: `merge-${pullRequest}`, resourceKey: `team/repo#${pullRequest}`, resourceSnapshot: snapshot });
    assert.ok(created.ok && created.data, created.error ?? "refused");
    assert.equal(created.data.authority, "orchestrator");
    const approved = h.svc.resolveDescendantRequest("root", sessionId, created.data.occurrenceId,
      { action: "resolve_workflow_decision", outcome: "approve" }, () => true);
    assert.ok(approved.ok, approved.error ?? "refused");
    const command = canonicalPrMergeEnqueueCommand(snapshot);
    const armed = await h.svc.consumeWorkflowDecision(sessionId, created.data.occurrenceId, { resourceSnapshot: snapshot, action: { kind: "pr_merge_enqueue", command } });
    assert.ok(armed.ok, armed.error ?? "refused");
    assert.equal(armed.data?.status, "approved");
    return { occurrenceId: created.data.occurrenceId, snapshot, command };
  };
  const closure = async (issue: number) => {
    const requested = await h.svc.requestGithubIssueClosure("root", { requestId: `closure-${issue}`, issue, reason: "completed",
      explanation: "The work merged.", evidence: ["Merged in the campaign."] });
    assert.ok(requested.ok && requested.data?.decision, requested.error ?? "refused");
    return requested.data.decision;
  };
  const status = (occurrenceId: string) => h.db.workflowDecisionByOccurrence(occurrenceId)!.status;
  return { itemId, child, question, armedMerge, closure, status };
}

test("#3915 adding an issue leaves unrelated decisions as they were and revokes only work related to it", async () => {
  const h = harness(false);
  try {
    const f = scopeImpactFixture(h);
    const unrelated = f.child("child", "other");
    const merger = f.child("merger", "issue:100", "claude-code");
    const related = f.child("worker101", "issue:101", "claude-code");
    const unrelatedQuestion = f.question(unrelated, "unrelated-question");
    const relatedQuestion = f.question(related, "related-question");
    const unrelatedMerge = await f.armedMerge(merger, 7);
    const relatedMerge = await f.armedMerge(related, 8);
    const closure = await f.closure(100);
    assert.ok(h.approve(closure).ok, "the person approves the closure of an issue the change keeps");
    const published = await h.svc.createWorkflowDecisionWithVideo(unrelated, { requestId: "unrelated-publication", resourceKey: "publication",
      resourceSnapshot: { category: "follow_up_issue_publication", repository: "team/repo", sanitizedTitle: "Unrelated Repair", sanitizedBody: body, labels: [] } });
    assert.ok(published.ok && published.data, published.error ?? "refused");
    const publication = published.data.occurrenceId;

    const proposed = await h.proposal("add-101"); assert.ok(proposed.ok, proposed.error ?? "proposal");
    const snapshot = proposed.data!.resourceSnapshot;
    assert.ok(snapshot.category === "campaign_issue_scope");
    assert.deepEqual(snapshot.activeChildren.map((c) => c.sessionId), [related], "only a child related to the added issue binds the request");
    assert.deepEqual(snapshot.affectedDecisions, [relatedQuestion, publication].sort(), "the request lists exactly what it will revoke");
    assert.ok(h.approve(proposed.data!).ok);

    assert.equal(f.status(publication), "revoked", "a publication counts against the issue capacity every scope change moves");
    assert.equal(f.status(unrelatedQuestion), "pending");
    assert.equal(f.status(unrelatedMerge.occurrenceId), "approved");
    assert.equal(h.db.workflowDecisionByOccurrence(unrelatedMerge.occurrenceId)!.actionAdmission?.command, unrelatedMerge.command);
    assert.equal(f.status(relatedMerge.occurrenceId), "approved", "an armed merge survives a change that only adds issues");
    assert.equal(f.status(closure.occurrenceId), "approved", "a closure of an issue the change keeps stays approved");
    assert.equal(f.status(relatedQuestion), "revoked", "a child related to the added issue cannot keep an approval evaluated before it");
    assert.deepEqual(revocationAudit(h, related, relatedQuestion).workflowDecision?.revocation,
      { reason: "superseded_by_scope_change", triggeredBy: { kind: "human", id: h.principal.userId } });
    assert.deepEqual(revocationAudit(h, related, relatedQuestion).actor, { kind: "system", id: "superseded_by_scope_change" });

    // The kept closure still executes: the only later scope revision left its issue alone.
    assert.equal(h.db.getSession("root")!.orchestratorPolicy!.issueScope!.revision, 2);
    assert.equal(h.db.issueScopeUnchangedFor("root", "team/repo", 100, 1, 2), true);
    assert.equal(h.db.issueScopeUnchangedFor("root", "team/repo", 101, 1, 2), false, "the change added 101");
    assert.equal(h.db.issueScopeUnchangedFor("root", "team/repo", 100, 1, 3), false, "no scope decision wrote revision 3");
    assert.equal(h.db.issueScopeUnchangedFor("root", "other/repo", 100, 1, 2), false, "another repository has separate authority");
    const executed = await h.svc.executeGithubIssueClosure("root", closure.occurrenceId, closure.resourceDigest);
    assert.ok(executed.ok, executed.error ?? "refused");
    assert.equal(h.state.executes, 1);
  } finally { h.db.close(); }
});

test("#3915 a pending scope request stays approvable through unrelated child activity and goes stale on related activity", async () => {
  const h = harness(false);
  try {
    const f = scopeImpactFixture(h);
    const unrelated = f.child("child", "other");
    const related = f.child("worker101", "issue:101");
    const quiet = await h.proposal("add-101"); assert.ok(quiet.ok, quiet.error ?? "proposal");
    // Routine progress by a child unrelated to 101: a new prompt and a new request.
    h.db.stageSessionPromptCommand({ commandId: "prompt-unrelated", sessionId: unrelated, runnerId: "r",
      payloadJson: JSON.stringify({ text: "Continue." }), payloadSha256: "c".repeat(64), expiresAt: Date.now() + 60_000, now: Date.now() });
    const kept = f.question(unrelated, "unrelated-question");
    assert.ok(h.approve(quiet.data!).ok, "unrelated progress does not make the request stale");
    assert.equal(f.status(kept), "pending");

    const busy = await h.svc.proposeCampaignIssueScope("root", { requestId: "add-102", expectedRevision: 2, additions: [{ repository: "team/repo", number: 102 }],
      removals: [{ repository: "team/repo", number: 101 }], explanation: "Swap the member" });
    assert.ok(busy.ok, busy.error ?? "refused");
    h.db.stageSessionPromptCommand({ commandId: "prompt-related", sessionId: related, runnerId: "r",
      payloadJson: JSON.stringify({ text: "Continue." }), payloadSha256: "d".repeat(64), expiresAt: Date.now() + 60_000, now: Date.now() });
    const refused = h.approve(busy.data!);
    assert.equal(refused.status, 409, "a child assigned to the removed issue changed");
    assert.equal(f.status(busy.data!.occurrenceId), "revoked");
    assert.deepEqual(revocationAudit(h, "root", busy.data!.occurrenceId).actor, { kind: "system", id: "approval_refused_stale" });
    assert.equal(h.db.getSession("root")!.orchestratorPolicy!.issueScope!.revision, 2);
  } finally { h.db.close(); }
});

test("#3915 removing an issue revokes its closure and related work, and its armed merge is recorded from forge proof only", async () => {
  const h = harness(false);
  try {
    const f = scopeImpactFixture(h);
    const unrelated = f.child("child", "other");
    const merger = f.child("merger", "issue:100", "claude-code");
    const unrelatedQuestion = f.question(unrelated, "unrelated-question");
    const relatedQuestion = f.question(merger, "related-question");
    const merge = await f.armedMerge(merger, 9);
    const closure = await f.closure(100);

    const removal = await h.svc.proposeCampaignIssueScope("root", { requestId: "remove-100", expectedRevision: 1, additions: [{ repository: "team/repo", number: 101 }],
      removals: [{ repository: "team/repo", number: 100 }], explanation: "Replace the member" });
    assert.ok(removal.ok, removal.error ?? "refused");
    assert.ok(removal.data!.resourceSnapshot.category === "campaign_issue_scope");
    assert.deepEqual(removal.data!.resourceSnapshot.activeChildren.map((c) => c.sessionId), [merger]);
    assert.ok(h.approve(removal.data!).ok);
    for (const occurrenceId of [relatedQuestion, merge.occurrenceId, closure.occurrenceId]) {
      assert.equal(f.status(occurrenceId), "revoked", occurrenceId);
    }
    assert.equal(f.status(unrelatedQuestion), "pending");
    assert.deepEqual(revocationAudit(h, "root", closure.occurrenceId).workflowDecision?.revocation,
      { reason: "superseded_by_scope_change", triggeredBy: { kind: "human", id: h.principal.userId } });

    // Reconciliation only records what the forge proves: first an unmerged head, then the merge.
    let merged = false;
    const runner = h.hub.requestFromRunner;
    h.hub.requestFromRunner = async (runnerId, requestId, message, timeout) => {
      if (message.type !== "reconcile_workflow_action") return runner(runnerId, requestId, message, timeout);
      assert.equal(message.command, merge.command);
      return merged ? { type: "workflow_action_reconciliation_result", requestId, sessionId: merger, occurrenceId: merge.occurrenceId, accepted: true,
        commandDigest: createHash("sha256").update(merge.command, "utf8").digest("hex"), forgeHeadSha: merge.snapshot.headSha }
        : { type: "workflow_action_reconciliation_result", requestId, sessionId: merger, occurrenceId: merge.occurrenceId, accepted: false,
          error: "forge did not prove the exact approved head was merged" };
    };
    const early = await h.svc.reconcileWorkflowDecision(merger, merge.occurrenceId, { resourceSnapshot: merge.snapshot });
    assert.equal(early.status, 409);
    assert.equal(f.status(merge.occurrenceId), "revoked", "nothing is recorded before the forge proves the merge");
    merged = true;
    const recorded = await h.svc.reconcileWorkflowDecision(merger, merge.occurrenceId, { resourceSnapshot: merge.snapshot });
    assert.ok(recorded.ok, recorded.error ?? "refused");
    assert.equal(recorded.data?.status, "consumed");
    assert.equal((await h.svc.reconcileWorkflowDecision(merger, merge.occurrenceId, { resourceSnapshot: merge.snapshot })).status, 409,
      "the merge is recorded once");

    // The removed issue's closure stays revoked and is never executed.
    const executed = await h.svc.executeGithubIssueClosure("root", closure.occurrenceId, closure.resourceDigest);
    assert.equal(executed.ok, false);
    assert.equal(h.state.executes, 0);
  } finally { h.db.close(); }
});

test("#3915 a person's scope approval under Full Control re-authorizes the boundary and still revokes every outstanding decision", async () => {
  const h = harness();
  try {
    const f = scopeImpactFixture(h);
    const unrelated = f.child("child", "other");
    const question = f.question(unrelated, "unrelated-question");
    const proposed = await h.svc.proposeCampaignIssueScope("root", { requestId: "human-add", expectedRevision: 1, additions: [{ repository: "team/repo", number: 101 }],
      removals: [], explanation: "Verified intended member" }, () => true, h.principal);
    assert.ok(proposed.ok, proposed.error ?? "refused");
    assert.equal(proposed.data!.authority, "human");
    assert.ok(proposed.data!.resourceSnapshot.category === "campaign_issue_scope");
    assert.deepEqual(proposed.data!.resourceSnapshot.affectedDecisions, [question],
      "the person sees every decision their approval revokes, although the child is unrelated");
    assert.ok(h.approve(proposed.data!).ok);
    assert.equal(f.status(question), "revoked");
    assert.deepEqual(revocationAudit(h, unrelated, question).workflowDecision?.revocation,
      { reason: "superseded_by_scope_change", triggeredBy: { kind: "human", id: h.principal.userId } });
  } finally { h.db.close(); }
});
