import assert from "node:assert/strict";
import test from "node:test";
import { DEFAULT_ORCHESTRATOR_DEFAULTS, HUMAN_ONLY_PARENT_CONTROL_POLICY, PROTOCOL_VERSION,
  type RunnerMetadata, type WorkflowDecisionView, type CampaignWorkItemDetail } from "@wollipog/protocol";
import { ControlPlaneDb } from "./db.js";
import { Hub } from "./hub.js";
import { SessionsService } from "./sessions.js";
import { resolveOrchestratorCampaignPolicy } from "./orchestrator-settings.js";
import { campaignBoundaryCurrent } from "./campaign-authority.js";
import { closureEvidence, issueEvidenceDigest } from "./campaign-issue-authority.js";
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
  const state = { publicationOk: true, executes: 0, openPR: false, delivery: [] as Array<{number:number;headSha:string;mergeCommitSha:string}> };
  hub.requestFromRunner = async (_runner, requestId, message) => {
    if (message.type === "campaign_issue_scope") {
      if (message.operation === "publication_inspect") return { type: "campaign_issue_scope_result", requestId, sessionId: message.sessionId,
        ok: state.publicationOk, repository: "team/repo", publicationDigest: issueEvidenceDigest({ sanitizedTitle: message.sanitizedTitle, sanitizedBody: message.sanitizedBody, labels: message.labels }) };
      return { type: "campaign_issue_scope_result", requestId, sessionId: message.sessionId, ok: true, repository: "team/repo",
        ...(message.operation === "synchronize" ? { revision: message.scope.revision } : { candidates: (message.issues ?? [100, 101]).map((number) =>
          ({ issue: { repository: "team/repo", number }, title: `Issue ${number}`, source: "sub_issue" as const })) }) };
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
  return { db, svc, hub, principal, state, approve, proposal, item };
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
  const older = harness();
  try {
    older.db.raw().prepare("UPDATE runners SET protocol_version=215 WHERE runner_id='r'").run();
    assert.equal((await older.proposal("old")).ok,false);
  } finally { older.db.close(); }
});

const body = "## Problem\nRelated failure\n## Proposed Behavior\nRepair it\n## Acceptance Criteria\n- Verified repair\n## Security and Compatibility\nNone";

test("publication requires an accepted unique related recommendation, exact sanitized payload, fresh duplicates and one-shot capacity", async () => {
  const h = harness();
  try {
    const record = h.svc.recordCampaignFollowUp("root",{originSessionId:"child",repository:"team/repo",title:"Related repair",originWorkItemIds:[h.item.id]});
    assert.ok(record.ok,record.error ?? "record");
    const id = record.data!.id;
    assert.ok(h.svc.adjudicateCampaignRecommendation("root",{recommendationId:id,disposition:"accepted",reason:"Same objective, observed regression",publicationRequired:true}).ok);
    const snapshot = {category:"follow_up_issue_publication" as const,repository:"team/repo",sanitizedTitle:"Related repair",sanitizedBody:body,labels:[],recommendationId:id};
    assert.equal((await h.svc.createWorkflowDecisionWithVideo("root",{requestId:"secret",resourceKey:"secret",resourceSnapshot:{...snapshot,sanitizedBody:body+"\napi_key=secret-value"}})).ok,false);
    h.state.publicationOk=false;
    assert.equal((await h.svc.createWorkflowDecisionWithVideo("root",{requestId:"duplicate",resourceKey:"pub",resourceSnapshot:snapshot})).ok,false);
    h.state.publicationOk=true;
    const p = await h.svc.createWorkflowDecisionWithVideo("root",{requestId:"publication",resourceKey:"pub",resourceSnapshot:snapshot}); assert.ok(p.ok,p.error ?? "publication");
    assert.equal(h.svc.createWorkflowDecision("root",{requestId:"spoof-admission",resourceKey:"spoof",resourceSnapshot:p.data!.resourceSnapshot}).status,403,
      "an echo of server admission cannot be supplied to generic create");
    assert.equal(p.data!.authority,"orchestrator"); assert.ok(h.approve(p.data!).ok);
    h.state.publicationOk=false;
    assert.equal((await h.svc.consumeWorkflowDecision("root",p.data!.occurrenceId,{resourceSnapshot:p.data!.resourceSnapshot})).ok,false);
    h.state.publicationOk=true;
    assert.ok((await h.svc.consumeWorkflowDecision("root",p.data!.occurrenceId,{resourceSnapshot:p.data!.resourceSnapshot})).ok);
    assert.equal((await h.svc.createWorkflowDecisionWithVideo("root",{requestId:"replay-pub",resourceKey:"pub",resourceSnapshot:snapshot})).ok,false);
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
    assert.equal((await make("Second repair")).ok,false);
    assert.equal((await h.proposal("epic-slot")).ok,false);
    assert.ok(h.approve(first.data!).ok);
    assert.ok((await h.svc.consumeWorkflowDecision("root",first.data!.occurrenceId,{resourceSnapshot:first.data!.resourceSnapshot})).ok);
    assert.ok(h.svc.adjudicateCampaignRecommendation("root",{recommendationId:firstRecommendation,disposition:"accepted",reason:"Unverified tracker claim",
      resultingWorkItemKey:`followup:${firstRecommendation}`,resultingIssue:{repository:"team/repo",number:100}}).ok);
    assert.equal((await make("Third repair")).ok,false,"consumption cannot free an unpublished scope reservation");
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
