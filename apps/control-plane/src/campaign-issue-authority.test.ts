import assert from "node:assert/strict";
import test from "node:test";
import { DEFAULT_ORCHESTRATOR_DEFAULTS, HUMAN_ONLY_PARENT_CONTROL_POLICY, PROTOCOL_VERSION, RUNNER_CAPABILITY_MIN_PROTOCOL,
  type RunnerMetadata, type WorkflowDecisionView, type CampaignWorkItemDetail } from "@wollipog/protocol";
import { ControlPlaneDb } from "./db.js";
import { Hub } from "./hub.js";
import { SessionsService } from "./sessions.js";
import { resolveOrchestratorCampaignPolicy } from "./orchestrator-settings.js";
import { campaignBoundaryCurrent } from "./campaign-authority.js";
import { closureEvidence, issueEvidenceDigest } from "./campaign-issue-authority.js";
import { CampaignRecoveryService, recoveryCoordinate } from "./campaign-recovery.js";
import type { HumanPrincipal } from "./identity.js";

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
  const state = { publicationOk: true, executes: 0, openPR: false, delivery: [] as Array<{number:number;headSha:string;mergeCommitSha:string}>, publicationTitles: {} as Record<number,string> };
  hub.requestFromRunner = async (_runner, requestId, message) => {
    if (message.type === "campaign_issue_scope") {
      if (message.operation === "publication_inspect") return { type: "campaign_issue_scope_result", requestId, sessionId: message.sessionId,
        ok: state.publicationOk, repository: "team/repo", publicationDigest: issueEvidenceDigest({ sanitizedTitle: message.sanitizedTitle, sanitizedBody: message.sanitizedBody, labels: message.labels }) };
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
    const added=await h.svc.proposeCampaignIssueScope("root",{requestId:"human-other",expectedRevision:1,additions:[{repository:"team/repo",number:999}],removals:[],explanation:"Human adds separate scope"},()=>true,h.principal);
    assert.ok(added.ok); assert.ok(h.approve(added.data!).ok);
    const proposal={mode:"full_control" as const,objective:"Implement epic 100",operations:["campaign_issue_scope","follow_up_issue_publication"] as Array<"campaign_issue_scope"|"follow_up_issue_publication">,delegatablePolicyIds:[],
      issueAuthority:{epics:[100],relatedFollowUps:true,maxIssues:2,closureReasons:[]}};
    assert.equal(h.svc.setCampaignControl("root",proposal,2,h.principal).ok,false,"scope plus the consumed unscoped slot exceeds two");
    assert.ok(h.svc.setCampaignControl("root",{...proposal,issueAuthority:{...proposal.issueAuthority,maxIssues:3}},2,h.principal).ok);
    const direct=await h.svc.proposeCampaignIssueScope("root",{requestId:"human-published",expectedRevision:2,additions:[{repository:"team/repo",number:101}],removals:[],explanation:"Human explicitly adopts the verified publication"},()=>true,h.principal);
    assert.ok(direct.ok,direct.error ?? "human publication scope"); assert.equal(direct.data!.authority,"human"); assert.ok(h.approve(direct.data!).ok);
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
    const direct=await h.svc.proposeCampaignIssueScope("root",{requestId:"human-settlement",expectedRevision:1,additions:[{repository:"team/repo",number:101}],removals:[],explanation:"Human adopts the exact published payload"},()=>true,h.principal);
    assert.ok(direct.ok); assert.equal(direct.data!.authority,"human"); assert.ok(h.approve(direct.data!).ok);
    assert.equal(h.db.admittedCampaignPublicationIssue("root",p.decision.occurrenceId),101);
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
