import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import type { RunnerToControlPlane } from "@wollipog/protocol";
import { ControlPlaneDb, RUNNER_REPORTED_STOP } from "../../control-plane/src/db.js";
import { SessionManager } from "./session-manager.js";
import { SessionStore, type SessionMeta } from "./session-store.js";

function harness() {
  const dir=mkdtempSync(join(tmpdir(),"campaign-checkpoint-"));
  const db=ControlPlaneDb.open(":memory:");
  db.registerRunner({runnerId:"r",hostname:"test",os:"linux",version:"test",workspaces:[],agents:[]},1);
  for(const id of ["root","worker"]) db.createSession({id,runnerId:"r",workspaceId:null,agentId:"claude",title:id,
    useWorktree:false,driver:"claude-code",config:{},now:1,...(id==="worker"?{parentSessionId:"root"}:{})});
  db.campaignBudgets.authorize("root",{version:1,accounting:"managed_workers_only",unpriced:"stop",costUsd:100,toolCalls:100,concurrency:1});
  const dispatch=db.campaignBudgets.dispatch("worker")!;
  const store=new SessionStore(dir);
  const meta:SessionMeta={sessionId:"worker",agentId:"claude",workspaceId:null,repoPath:dir,worktreePath:null,
    driver:"claude-code",command:"claude",args:[],env:{},context:{kind:"native"},agentSessionId:null,status:"queued",
    title:"worker",config:{},tokensIn:0,tokensOut:0,costUsd:0,preview:null,pendingApproval:null,seq:0,createdAt:1,updatedAt:1,
    campaignBudgetDispatch:dispatch};
  store.create(meta);
  const sent:RunnerToControlPlane[]=[];
  const manager=new SessionManager((message)=>sent.push(message),()=>{},store,"r");
  const statuses=()=>sent.filter((m):m is Extract<RunnerToControlPlane,{type:"session_status"}>=>m.type==="session_status");
  const settle=()=>{
    const status=statuses().reverse().find((m)=>m.campaignBudgetCheckpoint)!;
    assert.ok(status?.campaignBudgetCheckpoint,"runner must persist and send final usage evidence");
    const snapshot=manager.snapshotForControlPlane(store.readMeta("worker")!);
    assert.deepEqual(snapshot.campaignBudgetCheckpoint,status.campaignBudgetCheckpoint,"reconnect preserves the final receipt");
    db.updateSessionStatus("worker",status.status,10,RUNNER_REPORTED_STOP);
    db.campaignBudgets.recordCheckpoint("worker",status.campaignBudgetCheckpoint);
    assert.ok(db.campaignBudgets.settleCheckpoint("worker",{historyEpoch:status.campaignBudgetCheckpoint.historyEpoch,hydratedSeq:status.campaignBudgetCheckpoint.throughSeq}));
    assert.equal(db.campaignBudgets.view("root")!.occupied,0);
    return status.campaignBudgetCheckpoint;
  };
  return {db,store,manager,statuses,settle,cleanup:()=>{manager.shutdownAll();db.close();rmSync(dir,{recursive:true,force:true});}};
}

test("nonresident queued and parked stops emit durable final budget checkpoints",()=>{
  for(const prior of ["queued","idle"] as const) {
    const h=harness();
    try {h.store.patchMeta("worker",{status:prior});h.manager.stop("worker");h.settle();}
    finally {h.cleanup();}
  }
});

test("mid-turn stop waits for exact provider retirement and retains late durable usage",async()=>{
  const h=harness();
  try {
    let retired!:()=>void;
    const closing=new Promise<void>((resolve)=>{retired=resolve;});
    const entry:any={sessionId:"worker",client:{close:()=>closing,dispose:()=>{},cancel:()=>{}},repoPath:"/repo",cwd:"/repo",
      worktree:null,context:{kind:"native"},status:"running",running:true,providerInitiatedTurnActive:true,queue:[],
      policyHookToolCallIds:new Set(),policyHookDecisionEvents:new Map()};
    (h.manager as any).active.set("worker",entry);
    h.manager.stop("worker");
    assert.equal(h.statuses().some((m)=>m.campaignBudgetCheckpoint),false,"no release while exact provider is closing");
    assert.equal(h.db.campaignBudgets.view("root")!.occupied,1);
    (h.manager as any).onDriverEvent("worker",{kind:"token_usage",inputTokens:1,costUsd:3});
    retired();
    await new Promise((resolve)=>setImmediate(resolve));
    const checkpoint=h.settle();
    assert.equal(checkpoint.costUsd,3);assert.equal(checkpoint.throughSeq,1);
    assert.equal(h.db.campaignBudgets.view("root")!.actual.costUsd,3);
  } finally {h.cleanup();}
});

test("normal terminal completion settles once; outstanding ownership fences suppress proof",()=>{
  const h=harness();
  try {
    const entry:any={sessionId:"worker",status:"idle",running:false,queue:[],client:{dispose:()=>{}},policyHookToolCallIds:new Set(),policyHookDecisionEvents:new Map()};
    (h.manager as any).active.set("worker",entry);
    (h.manager as any).worktreeRebindings.set("worker",{});
    (h.manager as any).emitStatus("worker","completed");
    assert.equal(h.statuses().some((m)=>m.campaignBudgetCheckpoint),false);
    (h.manager as any).worktreeRebindings.delete("worker");
    (h.manager as any).emitStatus("worker","completed");
    h.settle();
    assert.equal(h.db.campaignBudgets.settleCheckpoint("worker",{historyEpoch:0,hydratedSeq:0}),false,"receipt release is one-shot");
    (h.manager as any).active.delete("worker");
  } finally {h.cleanup();}
});

test("an existing native review lease survives unrelated admission waiters",()=>{
  const h=harness();
  try {
    (h.manager as any).executionIsolation={mode:"provider"};
    assert.equal(h.manager.reserveControlledReviewAdmission("native","claude"),true);
    (h.manager as any).admissionQueue.push({});
    assert.equal(h.manager.reserveControlledReviewAdmission("native","claude"),true);
    assert.equal(h.manager.reserveControlledReviewAdmission("native","other"),false);
    assert.equal(h.manager.reserveControlledReviewAdmission("new-native","claude"),false,"queue fairness still applies to new jobs");
    (h.manager as any).admissionQueue.length=0;
    h.manager.releaseControlledReviewAdmission("native");
  } finally {h.cleanup();}
});

test("late allocation delivery attests a terminal nonresident worker without resuming recovery",()=>{
  const h=harness();
  try {
    const dispatch=h.store.readMeta("worker")!.campaignBudgetDispatch!;
    h.store.patchMeta("worker",{status:"stopped",campaignBudgetDispatch:undefined});
    (h.manager as any).recoveryQueues.set("worker",[{text:"must remain stopped"}]);
    (h.manager as any).recoveryHolds.add("worker");
    h.manager.rearmGovernance("worker",{costBudgetUsd:20,maxToolCalls:20},undefined,dispatch);
    h.settle();
    assert.equal(h.store.readMeta("worker")!.status,"stopped");
    assert.equal((h.manager as any).recoveryHolds.has("worker"),true);
    (h.manager as any).recoveryQueues.clear();
  } finally {h.cleanup();}
});
