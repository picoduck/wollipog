import assert from "node:assert/strict";
import {test} from "node:test";
import {spawn} from "node:child_process";
import {once} from "node:events";
import {mkdtempSync,mkdirSync,readFileSync,writeFileSync,rmSync} from "node:fs";
import {tmpdir} from "node:os";
import {join} from "node:path";
import type {CampaignReviewJobCommand,CampaignReviewJobUpdate} from "@wollipog/protocol";
import {SessionStore} from "./session-store.js";
import {SessionManager} from "./session-manager.js";
import {ControlledCampaignReviewer,controlledReviewForgeTarget,controlledReviewUsage} from "./campaign-review-jobs.js";

const init={type:"system",subtype:"init",model:"claude-opus-5-5",session_id:"native",tools:["Read"],permissionMode:"dontAsk"};
const tool=(id:string,name="Read")=>({type:"assistant",message:{content:[{type:"tool_use",id,name}]}});
const result=(cost=2)=>({type:"result",session_id:"native",subtype:"success",total_cost_usd:cost,
  modelUsage:{"claude-opus-5-5":{canonicalModel:"claude-opus-5-5",provider:"firstParty",costBasis:"list",costUSD:cost,
    inputTokens:5,outputTokens:10,cacheReadInputTokens:20,cacheCreationInputTokens:1}}}); // Fixture cost, never live pricing.
const raw=(...events:unknown[])=>events.map((e)=>JSON.stringify(e)).join("\n")+"\n";

test("owned native stream prices unsuccessful paid reviews and deduplicates cumulative results/tools",()=>{
  const paid={...result(3),subtype:"error_during_execution",is_error:true};
  assert.deepEqual(controlledReviewUsage(raw(init,tool("a"),tool("a"),result(2),paid),true),{costUsd:3,toolCalls:1,priced:true});
});
test("missing, foreign, inconsistent and unpriced native usage never becomes zero-cost completion",()=>{
  for(const transcript of [raw(init,tool("a")),raw({...init,model:"other"},result()),
    raw(init,{...result(),session_id:"other"}),raw(init,{...result(),total_cost_usd:5}),
    raw(init,{...result(),modelUsage:{"claude-opus-5-5":{...result().modelUsage["claude-opus-5-5"],costBasis:"unknown"}}}),
    raw(init,tool("a","Bash"),result()),raw(init,result(3),result(2)),raw(init)+"{broken"])
    assert.equal(controlledReviewUsage(transcript,true).priced,false,transcript);
  const crashed={...result(0),is_error:true,subtype:"error_during_execution",modelUsage:{"claude-opus-5-5":{...result(0).modelUsage["claude-opus-5-5"],inputTokens:0,outputTokens:0,cacheReadInputTokens:0,cacheCreationInputTokens:0}}};
  assert.equal(controlledReviewUsage(raw(init,crashed),true).priced,false);
});
test("in-flight partial output retains reservation without invented zero usage",()=>{
  const usage=controlledReviewUsage(raw(init,tool("a"))+"{partial",false);
  assert.equal(usage.priced,true);assert.equal(usage.costUsd,undefined);assert.equal(usage.toolCalls,1);
});

test("native forge binding uses older-gh-compatible scoped REST and rejects stale or foreign identity",async()=>{
  const request={requestId:"test",workItemId:"item",pullRequest:{repository:"picoduck/wollipog",number:3065},baseSha:"a".repeat(40),headSha:"b".repeat(40),costUsd:5,toolCalls:10,brief:"Review."};
  const response={number:3065,html_url:"https://github.com/picoduck/wollipog/pull/3065",state:"open",base:{sha:request.baseSha,repo:{full_name:"picoduck/wollipog"}},head:{sha:request.headSha,repo:{full_name:"picoduck/wollipog"}}};
  const calls:string[][]=[];
  await controlledReviewForgeTarget(request,"git@github.com:picoduck/wollipog.git",async(args)=>{calls.push(args);return JSON.stringify(response);});
  assert.deepEqual(calls,[["api","repos/picoduck/wollipog/pulls/3065"]]);
  await assert.rejects(controlledReviewForgeTarget(request,"git@github.com:foreign/repo.git",async()=>{throw new Error("must not query");}),/repository identity/);
  for(const bad of [{...response,number:1},{...response,base:{...response.base,sha:"c".repeat(40)}},
    {...response,head:{...response.head,repo:{full_name:"foreign/fork"}}},{...response,state:"closed"}])
    await assert.rejects(controlledReviewForgeTarget(request,"https://github.com/picoduck/wollipog.git",async()=>JSON.stringify(bad)),/canonical forge target/);
});

function jobHarness() {
  const root=mkdtempSync(join(tmpdir(),"native-review-lifecycle-"));
  const command:CampaignReviewJobCommand={type:"campaign_review_job",jobId:"review_11111111-1111-1111-1111-111111111111",nonce:"nonce",rootSessionId:"root",authorityRevision:2,
    worktreeSessionId:"worker",profile:{profile:"native_opus_5_5_high_read_only",controllerSha256:"a".repeat(64),executableSha256:"b".repeat(64),cliVersion:"2.1.287",accounting:"provider_list_estimate",account:"runner_default_claude",agentId:"claude"},
    request:{requestId:"test",workItemId:"item",pullRequest:{repository:"picoduck/wollipog",number:3065},baseSha:"c".repeat(40),headSha:"d".repeat(40),costUsd:5,toolCalls:20,brief:"Review."}};
  const dir=join(root,command.jobId);mkdirSync(dir);
  const updates:CampaignReviewJobUpdate[]=[],released:string[]=[],reserved:string[]=[];
  const store=new SessionStore(join(root,"sessions"));
  const manager=()=>new ControlledCampaignReviewer(root,store,(u)=>updates.push(u),(id)=>{reserved.push(id);return true;},(id)=>released.push(id));
  const persist=(extra:Record<string,unknown>={})=>writeFileSync(join(dir,"state.json"),JSON.stringify({command,repo:root,args:["--expected-diff-sha256","e".repeat(64)],phase:"running",...extra}));
  return {root,dir,command,store,updates,released,reserved,manager,persist,cleanup:()=>rmSync(root,{recursive:true,force:true})};
}

test("restart during durable preparation is known zero and never reacquires a provider slot",async()=>{
  const h=jobHarness();
  try {
    h.persist({phase:"prepared",args:[]});
    const manager=h.manager();await manager.dispatch(h.command);
    assert.equal(h.updates.at(-1)!.state,"not_launched");assert.equal(h.updates.at(-1)!.costUsd,0);
    assert.equal(h.updates.at(-1)!.attemptConsumed,false);assert.deepEqual(h.reserved,[]);
    assert.deepEqual(h.released,[h.command.jobId]);
    await manager.dispatch(h.command);
    assert.equal(h.updates.at(-1)!.state,"not_launched");assert.deepEqual(h.reserved,[]);
  } finally {h.cleanup();}
});

test("replayed live native dispatch survives a queued session and cannot send SIGTERM",async()=>{
  const h=jobHarness();
  const sm=new SessionManager(()=>{},()=>{},h.store,"r");
  (sm as any).executionIsolation={mode:"provider"};
  const child=spawn(process.execPath,["-e","process.on('SIGTERM',()=>console.log('sigterm'));console.log('ready');setTimeout(()=>{},10000)"],{detached:true,stdio:["ignore","pipe","ignore"]});
  const closed=once(child,"close");let signalled=false;
  child.stdout!.on("data",(data)=>{if(String(data).includes("sigterm")) signalled=true;});
  let manager:ControlledCampaignReviewer|undefined;
  try {
    await once(child.stdout!,"data");
    const stat=readFileSync(`/proc/${child.pid}/stat`,"utf8");
    h.persist({pid:child.pid,startIdentity:stat.slice(stat.lastIndexOf(")")+2).split(" ")[19]});
    writeFileSync(join(h.dir,"provider.jsonl"),raw(init,tool("a")));
    manager=new ControlledCampaignReviewer(h.root,h.store,(u)=>h.updates.push(u),
      (id,agent)=>sm.reserveControlledReviewAdmission(id,agent),(id)=>sm.releaseControlledReviewAdmission(id));
    await manager.dispatch(h.command);
    (sm as any).admissionQueue.push({});
    await manager.dispatch(h.command);
    await new Promise((r)=>setTimeout(r,50));
    assert.equal(signalled,false);assert.ok(h.updates.length>=2);
    assert.equal(h.updates.every((u)=>u.state==="running"),true);
    (sm as any).admissionQueue.length=0;
    child.kill("SIGKILL");await closed;
    await manager.dispatch(h.command); // Reconcile the same dead process, never launch a provider.
    assert.equal(h.updates.at(-1)!.state,"accounting_unavailable");
  } finally {
    child.kill("SIGKILL");await closed;(sm as any).admissionQueue.length=0;
    if(manager && h.updates.at(-1)?.state==="running") await manager.dispatch(h.command);
    sm.shutdownAll();h.cleanup();
  }
});

test("durable native final artifacts settle paid invalid reviews and replay without dispatch",async()=>{
  const h=jobHarness();
  try {
    h.persist();writeFileSync(join(h.dir,"provider.jsonl"),raw(init,tool("a"),result(2)));
    writeFileSync(join(h.dir,"summary.json"),JSON.stringify({status:"complete",launched:true,phase:"execution",attempt_valid:false,effective_vote:"INVALID",
      reviewed_base:h.command.request.baseSha,reviewed_head:h.command.request.headSha,models:["claude-opus-5-5"],diff_sha256:"e".repeat(64)}));
    const manager=h.manager();await manager.dispatch(h.command);
    const receipt=h.updates.at(-1)!;
    assert.equal(receipt.state,"completed");assert.equal(receipt.costUsd,2);assert.equal(receipt.attemptValid,false);assert.equal(receipt.attemptConsumed,true);
    assert.deepEqual(h.released,[h.command.jobId]);
    const reservations=h.reserved.length;
    await manager.dispatch(h.command);
    assert.deepEqual(h.updates.at(-1),receipt);assert.equal(h.reserved.length,reservations,"terminal replay does not admit another provider");
  } finally {h.cleanup();}
});

test("native controller preflight refusal releases a known-zero job without spending an attempt",async()=>{
  const h=jobHarness();
  try {
    h.persist();writeFileSync(join(h.dir,"summary.json"),JSON.stringify({status:"complete",launched:false,phase:"preflight"}));
    await h.manager().dispatch(h.command);
    assert.equal(h.updates.at(-1)!.state,"not_launched");assert.equal(h.updates.at(-1)!.costUsd,0);
    assert.equal(h.updates.at(-1)!.attemptConsumed,false);assert.deepEqual(h.released,[h.command.jobId]);
  } finally {h.cleanup();}
});

test("unknown native accounting retains budget outcome but releases host capacity only after owned processes exit",async()=>{
  const h=jobHarness();
  // A bounded local process substitutes for the lifecycle boundary, never a provider invocation.
  const child=spawn(process.execPath,["-e","process.on('SIGTERM',()=>{});console.log('ready');setTimeout(()=>{},10000)"],{detached:true,stdio:["ignore","pipe","ignore"]});
  const closed=once(child,"close");
  try {
    await once(child.stdout!,"data");
    const stat=readFileSync(`/proc/${child.pid}/stat`,"utf8");
    const startIdentity=stat.slice(stat.lastIndexOf(")")+2).split(" ")[19];
    h.persist({pid:child.pid,startIdentity});
    writeFileSync(join(h.dir,"provider.jsonl"),raw(init,tool("a","Bash")));
    const manager=h.manager();await manager.dispatch(h.command);
    assert.equal(h.updates.at(-1)!.state,"accounting_unavailable");
    assert.equal(h.updates.at(-1)!.costUsd,undefined,"unknown usage is not settled as zero");
    assert.deepEqual(h.released,[],"SIGTERM intent is not exit evidence");
    const recovered=h.manager();
    assert.ok(h.reserved.length>=2,"restart reclaims a still-owned unavailable job's host slot");
    child.kill("SIGKILL");await closed;
    const deadline=Date.now()+3000;
    while(!h.released.length && Date.now()<deadline) await new Promise((r)=>setTimeout(r,50));
    assert.ok(h.released.length>0,"proven retirement returns shared host capacity");
    await recovered.dispatch(h.command);
    assert.equal(h.updates.at(-1)!.state,"accounting_unavailable","capacity release cannot fabricate a usage settlement");
  } finally {child.kill("SIGKILL");await closed;h.cleanup();}
});
