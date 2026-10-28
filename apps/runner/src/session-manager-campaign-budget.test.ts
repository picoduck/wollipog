import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { PROTOCOL_VERSION, type RunnerToControlPlane } from "@wollipog/protocol";
import { ControlPlaneDb, RUNNER_REPORTED_STOP } from "../../control-plane/src/db.js";
import { Hub } from "../../control-plane/src/hub.js";
import { SessionsService } from "../../control-plane/src/sessions.js";
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

test("a Stop keeps the campaign slot until the provider retires, then frees it without history (#2940)",async()=>{
  const dir=mkdtempSync(join(tmpdir(),"campaign-slot-retirement-"));
  const db=ControlPlaneDb.open(":memory:");
  db.registerRunner({runnerId:"r",hostname:"test",os:"linux",version:"test",workspaces:[],agents:[]},1,PROTOCOL_VERSION);
  const child=(id:string)=>{
    db.createSession({id,runnerId:"r",workspaceId:null,agentId:"claude",title:id,useWorktree:false,driver:"claude-code",
      config:{},now:1,...(id==="root"?{}:{parentSessionId:"root"})});
    db.updateSessionStatus(id,"running",2);
  };
  child("root");child("worker");
  db.campaignBudgets.authorize("root",{version:1,accounting:"managed_workers_only",unpriced:"stop",concurrency:1});
  const hub=new Hub(db);
  hub.isRunnerOnline=()=>true;hub.sendToRunner=()=>true;hub.sessionChangedById=()=>{};
  const svc=new SessionsService(db,hub,{info(){},warn(){},error(){}});
  const store=new SessionStore(dir);
  store.create({sessionId:"worker",agentId:"claude",workspaceId:null,repoPath:dir,worktreePath:null,driver:"claude-code",
    command:"claude",args:[],env:{},context:{kind:"native"},agentSessionId:null,status:"running",title:"worker",config:{},
    tokensIn:0,tokensOut:0,costUsd:0,preview:null,pendingApproval:null,seq:0,createdAt:1,updatedAt:1,
    campaignBudgetDispatch:db.campaignBudgets.dispatch("worker")});
  // The runner's own status messages, as its socket delivers them to the control plane.
  const manager=new SessionManager((message)=>{
    if(message.type==="session_status") svc.onSessionStatus(message.sessionId,message.status,message.detail,message.worktreePath,
      "r",message.controlPlaneLaunchId,message.capacityWait,message.campaignBudgetCheckpoint);
  },()=>{},store,"r");
  let retire!:()=>void;
  const closing=new Promise<void>((resolve)=>{retire=resolve;});
  (manager as any).active.set("worker",{sessionId:"worker",client:{close:()=>closing,dispose(){},cancel(){}},repoPath:dir,cwd:dir,
    worktree:null,context:{kind:"native"},status:"running",running:true,providerInitiatedTurnActive:true,queue:[],
    policyHookToolCallIds:new Set(),policyHookDecisionEvents:new Map()});
  try {
    assert.equal(db.campaignBudgets.view("root")!.occupied,1);
    assert.ok(svc.stop("worker").ok);
    manager.stop("worker");
    assert.ok((manager as any).closing.has("worker"),"the provider is still closing");
    assert.equal(db.getSession("worker")!.status,"stopped","the runner has already reported the stop");
    assert.equal(db.hasSessionStopIntent("worker"),false,"and the control plane has confirmed it");
    assert.equal(db.campaignBudgets.view("root")!.occupied,1,"a closing provider keeps its slot");
    assert.throws(()=>child("next"),/concurrency allowance reached/u,"so a second child cannot run beside it");
    retire();
    await new Promise((resolve)=>setImmediate(resolve));
    assert.equal((manager as any).closing.has("worker"),false);
    assert.equal(db.campaignBudgets.view("root")!.occupied,0,"retirement frees the slot without a history reload");
    assert.equal(db.campaignBudgets.active("worker"),true,"its final usage stays pending until its history settles");
    child("next");
    assert.equal(db.campaignBudgets.view("root")!.occupied,1);
  } finally {manager.shutdownAll();db.close();rmSync(dir,{recursive:true,force:true});}
});
