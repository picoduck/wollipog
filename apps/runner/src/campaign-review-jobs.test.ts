import assert from "node:assert/strict";
import {test} from "node:test";
import {controlledReviewForgeTarget,controlledReviewUsage} from "./campaign-review-jobs.js";

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
