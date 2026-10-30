import assert from "node:assert/strict";
import test from "node:test";
import { CAMPAIGN_FORGE_OBSERVATION, DEFAULT_ORCHESTRATOR_DEFAULTS, HUMAN_ONLY_PARENT_CONTROL_POLICY, PROTOCOL_VERSION, RUNNER_CAPABILITY_MIN_PROTOCOL,
  type CampaignControl, type RunnerMetadata, type WorkflowDecisionView, type CampaignWorkItemDetail } from "@wollipog/protocol";
import { ControlPlaneDb } from "./db.js";
import { Hub } from "./hub.js";
import { SessionsService } from "./sessions.js";
import { resolveOrchestratorCampaignPolicy } from "./orchestrator-settings.js";
import { campaignBoundaryCurrent } from "./campaign-authority.js";
import { closureEvidence, issueEvidenceDigest } from "./campaign-issue-authority.js";
import { CampaignRecoveryService, recoveryCoordinate } from "./campaign-recovery.js";
import { CampaignForgeObserver } from "./campaign-forge-observations.js";
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
      assert.ok(p.data!.resourceSnapshot.category === "follow_up_issue_publication" && !p.data!.resourceSnapshot.recommendationId &&
        !p.data!.resourceSnapshot.issueAdmission, `${c.name}: an unproven claim carries no lineage or admission`);
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
